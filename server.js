require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');

// ── Crash nets ────────────────────────────────────────────────────────────
//
// Express 4 does NOT catch a rejected promise from an async handler. Any
// `await` outside a try inside a route becomes an unhandledRejection, which
// Node terminates the process for by default. One expired Google refresh
// token on one endpoint therefore took the entire backend down for every
// logged-in user.
//
// The handlers themselves have been fixed to answer with real status codes;
// this is the last resort for the next one anybody writes.
process.on('unhandledRejection', (reason) => {
  // Log and KEEP SERVING. A rejected promise means one request is broken, not
  // that the process is unsound - killing everyone's session over it is a far
  // worse outcome than the failed request.
  console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});

let shuttingDown = false;
process.on('uncaughtException', (err) => {
  // Different from above on purpose: a genuinely uncaught throw can leave
  // module state inconsistent, so we do NOT continue. Log, stop accepting
  // connections, let PM2 restart us clean (autorestart: true).
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (server) server.close(() => process.exit(1));
  } catch { /* fall through to the timer below */ }
  // Never hang forever waiting for in-flight requests to drain.
  setTimeout(() => process.exit(1), 5_000).unref();
});

const { query } = require('./db/pool');

const app = express();
let server = null;

// Behind nginx/Caddy the client IP arrives in X-Forwarded-For. Without this
// every request looks like 127.0.0.1 and the rate limiter below would treat
// the whole clinic as one caller. Off by default because trusting the header
// when NOT behind a proxy would let anyone forge their IP.
if (String(process.env.TRUST_PROXY || '') === '1') app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(morgan('dev'));

// ── Rate limiting ─────────────────────────────────────────────────────────
//
// Not an anti-hacker measure - this is a small trusted clinic app. It exists
// so one runaway retry loop in a client cannot saturate a box that restarts
// Node at 400MB, especially when a single Drive-backed request can occupy a
// slot for seconds.
//
// Deliberately generous, /api only (the Flutter bundle fires many asset
// requests on load and must never be throttled), and killable via env if it
// ever gets in the way.
const RATE_ENABLED = String(process.env.RATE_LIMIT_DISABLED || '') !== '1';
const RATE_WINDOW_MS = 60_000;
const RATE_MAX       = +(process.env.RATE_LIMIT_MAX || 600);   // per IP per minute
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX       = +(process.env.RATE_LIMIT_LOGIN_MAX || 20);

const hits = new Map();   // ip -> { count, resetAt }

function bump(map, key, windowMs, max) {
  const now = Date.now();
  const rec = map.get(key);
  if (!rec || rec.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  rec.count++;
  if (rec.count > max) {
    return { ok: false, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
  }
  return { ok: true, retryAfter: 0 };
}

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
}, RATE_WINDOW_MS).unref();

if (RATE_ENABLED) {
  app.use('/api', (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    // Login gets its own much tighter budget: it is the one endpoint where
    // repeated guessing is the attack, and 20 tries per quarter hour is far
    // more than any human mistyping a password.
    const isLogin = req.method === 'POST' && /\/auth\/login\/?$/.test(req.path);
    const r = isLogin
      ? bump(hits, 'login:' + ip, LOGIN_WINDOW_MS, LOGIN_MAX)
      : bump(hits, 'api:' + ip, RATE_WINDOW_MS, RATE_MAX);
    if (r.ok) return next();
    res.setHeader('Retry-After', String(r.retryAfter));
    res.status(429).json({
      error: isLogin
        ? `Too many sign-in attempts. Try again in ${r.retryAfter}s.`
        : 'Too many requests. Please slow down.',
      code: 'rate_limited',
    });
  });
}

// ── Request timeout ───────────────────────────────────────────────────────
//
// A Drive call that never returns used to hold a request open forever, and
// the client waited with it. Answer 504 instead so the socket is freed.
//
// Multipart is exempt: a 60MB upload over a slow clinic connection can
// legitimately take longer than this, and cutting it off would corrupt the
// upload rather than protect anything.
const REQ_TIMEOUT_MS = +(process.env.REQUEST_TIMEOUT_MS || 60_000);
app.use('/api', (req, res, next) => {
  if (/^multipart\//i.test(req.headers['content-type'] || '')) return next();
  res.setTimeout(REQ_TIMEOUT_MS, () => {
    if (res.headersSent) return;
    console.error('[timeout]', req.method, req.originalUrl);
    res.status(504).json({
      error: 'The server took too long to answer. Please try again.',
      code: 'timeout',
    });
  });
  next();
});

// ── Static: uploaded body images (public so <img> can load without token) ──
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { maxAge: '7d' }));

// ── API routes ────────────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/doctors',    require('./routes/doctors'));
app.use('/api/patients',   require('./routes/patients'));
app.use('/api/treatments', require('./routes/treatments'));
app.use('/api/images',     require('./routes/images'));
app.use('/api/drive',      require('./routes/drive'));
app.use('/api/catalog',    require('./routes/catalog'));
app.use('/api/store',      require('./routes/store'));
app.use('/api/problems',   require('./routes/problems'));
app.use('/api/documents',  require('./routes/documents'));
app.use('/api/reports',    require('./routes/reports'));

// Health: also reports cache and memory, so "is the cache actually working?"
// and "how close are we to the 400MB PM2 restart ceiling?" can be answered
// from a browser rather than by guessing.
app.get('/api/health', async (_req, res) => {
  const mem = process.memoryUsage();

  // Round-trip to the database, measured.
  //
  // Postgres is on a REMOTE host, so every query pays network latency that a
  // local database would not. That is the one honest argument for moving the
  // data closer - and it is an argument that should be settled with a number,
  // not a guess. Under ~5ms the database is not your bottleneck; 30ms+ and
  // it is worth talking about.
  let dbMs = null;
  let dbError = null;
  try {
    const t0 = process.hrtime.bigint();
    await query('SELECT 1');
    dbMs = Number(process.hrtime.bigint() - t0) / 1e6;
  } catch (e) {
    dbError = e.message;
  }

  res.json({
    ok: true,
    ts: Date.now(),
    uptime_s: Math.round(process.uptime()),
    db_ms: dbMs == null ? null : +dbMs.toFixed(1),
    db_error: dbError,
    memory_mb: {
      rss: +(mem.rss / 1048576).toFixed(1),
      heap: +(mem.heapUsed / 1048576).toFixed(1),
    },
    cache: require('./utils/cache').stats(),
  });
});

// ── Runtime config for the Flutter web bundle ─────────────────────────────
// Served as JS (not JSON) so it can be pulled synchronously with
// <script src="config.js">; sits BEFORE flutter_bootstrap.js in index.html
// so the API base is set on window before Dart code initialises.
//
// Set APP_API_BASE in the backend's .env when the API host differs from the
// origin serving the frontend (rare — typically you serve both from the
// same Node process and leave this empty for same-origin). No frontend
// rebuild is needed to change this.
app.get('/config.js', (_req, res) => {
  const apiBase = (process.env.APP_API_BASE || '').trim();

  // Client ID for the WEBAPP'S OWN Google sign-in - the per-doctor "Photos"
  // panel, which syncs to that doctor's personal Drive from the browser.
  //
  // This is NOT the clinic Drive connection. That one is server-side, uses
  // GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, and needs nothing in the
  // browser. Leave WEB_GOOGLE_CLIENT_ID unset unless you actually want the
  // Photos panel; unset simply keeps it disabled with an explanation.
  const googleClientId = (process.env.WEB_GOOGLE_CLIENT_ID || '').trim();
  const googleServerClientId =
    (process.env.WEB_GOOGLE_SERVER_CLIENT_ID || '').trim();

  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(
    `window.APP_CONFIG = ${JSON.stringify({
      apiBase,
      googleClientId,
      googleServerClientId,
    })};\n`,
  );
});

// ── Serve web frontend ───────────────────────────────────────────────────
// Priority order (first match wins):
//   1. backend/public              — self-contained prod deploy
//   2. ../flutter_app/build/web    — Flutter port (default now)
//   3. ../frontend/dist            — original React build (legacy)
// Override with FRONTEND_DIST=... env var when you want to point at a
// custom location without moving files.
const distDir = process.env.FRONTEND_DIST && fs.existsSync(process.env.FRONTEND_DIST)
  ? process.env.FRONTEND_DIST
  : [
      path.join(__dirname, 'public'),
      path.join(__dirname, '..', 'flutter_app', 'build', 'web'),
      path.join(__dirname, '..', 'frontend', 'dist'),
    ].find(p => fs.existsSync(p));

if (distDir) {
  // Hashed asset files (e.g. /assets/index-XXXX.js) are content-addressed by
  // Vite — safe to cache long-term. index.html, however, must NEVER be cached
  // by the browser because it's how new asset hashes get discovered after a
  // deploy. Without this, users keep loading stale bundles for a full day.
  // Never-cache list = anything that reveals where new asset hashes live
  // (or that PWA installers refetch on every update). Covers both the React
  // build (index.html + sw.js + manifest.webmanifest) AND the Flutter web
  // build (index.html + flutter_service_worker.js + flutter_bootstrap.js +
  // manifest.json + version.json).
  const NEVER_CACHE = new Set([
    'index.html',
    'sw.js',
    'manifest.webmanifest',
    'manifest.json',
    'flutter_service_worker.js',
    'flutter_bootstrap.js',
    'version.json',
  ]);
  app.use(express.static(distDir, {
    maxAge: '1d',
    setHeaders: (res, filePath) => {
      if (NEVER_CACHE.has(path.basename(filePath))) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));
  app.get(/^\/(?!api\/|uploads\/).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(distDir, 'index.html'));
  });
  console.log(`📦 Serving frontend from ${distDir}`);
} else {
  app.get('/', (_req, res) => {
    res.send(`<pre>
Backend is running.
Frontend not built yet. From /frontend run:
  npm install
  npm run build
Then copy frontend/dist into backend/public, or refresh.
</pre>`);
  });
}

// ── Generic error handler ──
//
// Honours `err.status` so a tagged failure (an expired Drive token, say)
// arrives as an actionable 409 the UI can act on, instead of a 500 that reads
// like the server is broken. Anything untagged is still a 500.
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[unhandled]', err);
  else console.warn('[handled]', status, err.message);
  if (res.headersSent) return;
  res.status(status).json({
    error: err.message || 'Server error',
    code: err.code,
  });
});

const PORT = +(process.env.PORT || 4000);
server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Backend listening on http://localhost:${PORT}`);
});

// Headers must finish arriving well before a request may run. Guards against
// a stalled client holding a connection slot open indefinitely.
server.headersTimeout = 65_000;
server.requestTimeout = 0;   // per-route timeout above handles this instead

// PM2 sends SIGINT on restart. Draining first means an in-flight save
// completes rather than being cut off mid-write.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${sig} received — draining…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8_000).unref();
  });
}
