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

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Serve React build ─────────────────────────────────────────────────────
// Prefer the self-contained backend/public folder (used when this folder is
// shipped to the production server). Fall back to ../frontend/dist for local
// development where you just ran `npm run build` in the frontend.
const distDir = [
  path.join(__dirname, 'public'),
  path.join(__dirname, '..', 'frontend', 'dist'),
].find(p => fs.existsSync(p));

if (distDir) {
  // Hashed asset files (e.g. /assets/index-XXXX.js) are content-addressed by
  // Vite — safe to cache long-term. index.html, however, must NEVER be cached
  // by the browser because it's how new asset hashes get discovered after a
  // deploy. Without this, users keep loading stale bundles for a full day.
  app.use(express.static(distDir, {
    maxAge: '1d',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
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
