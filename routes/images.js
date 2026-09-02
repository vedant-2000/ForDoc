const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { query, tx } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'body-images');
const MASK_DIR   = path.join(__dirname, '..', 'uploads', 'body-masks');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(MASK_DIR))   fs.mkdirSync(MASK_DIR,   { recursive: true });

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

const maskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, MASK_DIR),
  filename: (req, _file, cb) => cb(null, `${Date.now()}_${+req.params.id}.png`),
});
const maskUpload = multer({
  storage: maskStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'image/png') return cb(new Error('Mask must be PNG'));
    cb(null, true);
  }
});

function withUrls(row) {
  row.url = `/uploads/body-images/${row.filename}`;
  row.mask_url = row.blank_mask_filename ? `/uploads/body-masks/${row.blank_mask_filename}` : null;
  return row;
}

// PUBLIC: GET /api/images/active   -> returns active body image meta (no auth, so <img src> can load)
router.get('/active', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, filename, original_name, mime_type, width_px, height_px,
              blank_mask_filename, created_at
       FROM body_images WHERE is_active = TRUE LIMIT 1`
    );
    if (!rows.length) return res.json(null);
    res.json(withUrls(rows[0]));
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// PUBLIC: GET /api/images/:id  -> any (historic) image by id, so old sessions
// render on the body image they were originally drawn on, not on the latest upload.
router.get('/:id(\\d+)', async (req, res) => {
  const id = +req.params.id;
  try {
    const { rows } = await query(
      `SELECT id, filename, original_name, mime_type, width_px, height_px,
              is_active, blank_mask_filename, created_at
       FROM body_images WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(withUrls(rows[0]));
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// GET /api/images   (admin) — list all uploads
router.get('/', authRequired(['admin']), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, filename, original_name, mime_type, width_px, height_px,
              is_active, blank_mask_filename, created_at
       FROM body_images ORDER BY created_at DESC`
    );
    rows.forEach(withUrls);
    res.json(rows);
  } catch (e) {
    console.error('[images/list]', e);
    res.status(500).json({ error: 'Could not load body images' });
  }
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
         RETURNING id, filename, original_name, mime_type, width_px, height_px,
                   is_active, blank_mask_filename, created_at`,
        [req.file.filename, req.file.originalname, req.file.mimetype,
         width_px ? +width_px : null, height_px ? +height_px : null, req.user.id]
      );
      return rows[0];
    });
    res.status(201).json(withUrls(result));
  } catch (e) {
    console.error('[images/upload]', e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// PUT /api/images/:id/mask  (admin) — replace the blank-region mask PNG
router.put('/:id/mask', authRequired(['admin']), maskUpload.single('file'), async (req, res) => {
  const id = +req.params.id;
  if (!req.file) return res.status(400).json({ error: 'file is required' });
  try {
    const old = await query('SELECT blank_mask_filename FROM body_images WHERE id=$1', [id]);
    if (!old.rows.length) {
      try { fs.unlinkSync(path.join(MASK_DIR, req.file.filename)); } catch {}
      return res.status(404).json({ error: 'Not found' });
    }
    await query('UPDATE body_images SET blank_mask_filename=$1 WHERE id=$2',
      [req.file.filename, id]);
    if (old.rows[0].blank_mask_filename) {
      try { fs.unlinkSync(path.join(MASK_DIR, old.rows[0].blank_mask_filename)); } catch {}
    }
    res.json({ ok: true, mask_url: `/uploads/body-masks/${req.file.filename}` });
  } catch (e) {
    console.error('[images/mask]', e);
    res.status(500).json({ error: 'Mask save failed' });
  }
});

// DELETE /api/images/:id/mask  (admin) — clear the mask
router.delete('/:id/mask', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  try {
    const { rows } = await query('SELECT blank_mask_filename FROM body_images WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].blank_mask_filename) {
      try { fs.unlinkSync(path.join(MASK_DIR, rows[0].blank_mask_filename)); } catch {}
    }
    await query('UPDATE body_images SET blank_mask_filename=NULL WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Mask clear failed' });
  }
});

// GET /api/images/:id/usage  (admin) — how many marks / sessions reference this image.
// Used by the admin UI to show a real warning before deletion, since deleting
// the image row nulls each mark's body_image_id (ON DELETE SET NULL) and those
// sessions will then render against whatever image is currently active.
router.get('/:id(\\d+)/usage', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  try {
    const { rows } = await query(
      `SELECT COUNT(*)::int                          AS mark_count,
              COUNT(DISTINCT session_id)::int        AS session_count
         FROM marks WHERE body_image_id = $1`,
      [id]
    );
    res.json(rows[0] || { mark_count: 0, session_count: 0 });
  } catch (e) {
    res.status(500).json({ error: 'Usage lookup failed' });
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
    const { rows } = await query(
      'SELECT filename, is_active, blank_mask_filename FROM body_images WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].is_active) return res.status(400).json({ error: 'Cannot delete the active image' });
    await query('DELETE FROM body_images WHERE id=$1', [id]);
    try { fs.unlinkSync(path.join(UPLOAD_DIR, rows[0].filename)); } catch {}
    if (rows[0].blank_mask_filename) {
      try { fs.unlinkSync(path.join(MASK_DIR, rows[0].blank_mask_filename)); } catch {}
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
