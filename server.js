require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');

const app = express();

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(morgan('dev'));

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

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

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
  res.type('application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.send(
    `window.APP_CONFIG = ${JSON.stringify({ apiBase })};\n`,
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
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(500).json({ error: err.message || 'Server error' });
});

const PORT = +(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`✅ Backend listening on http://localhost:${PORT}`);
});
