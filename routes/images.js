const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { query, tx } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'body-images');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\//.test(file.mimetype)) return cb(new Error('Only images allowed'));
    cb(null, true);
  }
});

// PUBLIC: GET /api/images/active   -> returns active body image meta (no auth, so <img src> can load)
router.get('/active', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, filename, original_name, mime_type, width_px, height_px, created_at
       FROM body_images WHERE is_active = TRUE LIMIT 1`
    );
    if (!rows.length) return res.json(null);
    const img = rows[0];
    img.url = `/uploads/body-images/${img.filename}`;
    res.json(img);
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// GET /api/images   (admin) — list all uploads
router.get('/', authRequired(['admin']), async (_req, res) => {
  const { rows } = await query(
    `SELECT id, filename, original_name, mime_type, width_px, height_px, is_active, created_at
     FROM body_images ORDER BY created_at DESC`
  );
  rows.forEach(r => { r.url = `/uploads/body-images/${r.filename}`; });
  res.json(rows);
});

// POST /api/images  (admin) — upload + auto-activate
//  multipart field 'file'; optional width_px/height_px body fields
router.post('/', authRequired(['admin']), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  const { width_px, height_px } = req.body || {};
  try {
    const result = await tx(async (c) => {
      await c.query('UPDATE body_images SET is_active=FALSE WHERE is_active=TRUE');
      const { rows } = await c.query(
        `INSERT INTO body_images (filename, original_name, mime_type, width_px, height_px, is_active, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,TRUE,$6)
         RETURNING id, filename, original_name, mime_type, width_px, height_px, is_active, created_at`,
        [req.file.filename, req.file.originalname, req.file.mimetype,
         width_px ? +width_px : null, height_px ? +height_px : null, req.user.id]
      );
      return rows[0];
    });
    result.url = `/uploads/body-images/${result.filename}`;
    res.status(201).json(result);
  } catch (e) {
    console.error('[images/upload]', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// POST /api/images/:id/activate
router.post('/:id/activate', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  try {
    await tx(async (c) => {
      await c.query('UPDATE body_images SET is_active=FALSE WHERE is_active=TRUE');
      const r = await c.query('UPDATE body_images SET is_active=TRUE WHERE id=$1', [id]);
      if (!r.rowCount) throw new Error('not_found');
    });
    res.json({ ok: true });
  } catch (e) {
    if (e.message === 'not_found') return res.status(404).json({ error: 'Not found' });
    res.status(500).json({ error: 'Activate failed' });
  }
});

// DELETE /api/images/:id   (admin)
router.delete('/:id', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  try {
    const { rows } = await query('SELECT filename, is_active FROM body_images WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].is_active) return res.status(400).json({ error: 'Cannot delete the active image' });
    await query('DELETE FROM body_images WHERE id=$1', [id]);
    try { fs.unlinkSync(path.join(UPLOAD_DIR, rows[0].filename)); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
