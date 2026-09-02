const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// All routes here are admin-only.
router.use(authRequired(['admin']));

// GET /api/doctors
router.get('/', async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, username, full_name, color, is_active, created_at
       FROM doctors ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (e) {
    console.error('[doctors/list]', e);
    res.status(500).json({ error: 'Could not load doctors' });
  }
});

// POST /api/doctors  { username, full_name, password, color? }
router.post('/', async (req, res) => {
  const { username, full_name, password, color } = req.body || {};
  if (!username || !full_name || !password) {
    return res.status(400).json({ error: 'username, full_name, password required' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query(
      `INSERT INTO doctors (username, full_name, password_hash, color)
       VALUES ($1,$2,$3,COALESCE($4, '#c0392b'))
       RETURNING id, username, full_name, color, is_active, created_at`,
      [username.trim(), full_name.trim(), hash, color || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    console.error('[doctors/create]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

// PATCH /api/doctors/:id  { full_name?, color?, password?, is_active? }
router.patch('/:id', async (req, res) => {
  const id = +req.params.id;
  const { full_name, color, password, is_active } = req.body || {};
  const sets = [];
  const args = [];
  let i = 1;
  if (full_name !== undefined) { sets.push(`full_name = $${i++}`); args.push(full_name); }
  if (color     !== undefined) { sets.push(`color = $${i++}`);     args.push(color); }
  if (is_active !== undefined) { sets.push(`is_active = $${i++}`); args.push(!!is_active); }
  try {
    if (password) {
      // Inside the try: bcrypt rejects on absurd input, and an unguarded
      // rejection here used to kill the process rather than fail the request.
      const hash = await bcrypt.hash(password, 10);
      sets.push(`password_hash = $${i++}`);
      args.push(hash);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    args.push(id);
    const { rows } = await query(
      `UPDATE doctors SET ${sets.join(', ')} WHERE id=$${i}
       RETURNING id, username, full_name, color, is_active, created_at`,
      args
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[doctors/patch]', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /api/doctors/:id
router.delete('/:id', async (req, res) => {
  const id = +req.params.id;
  try {
    const r = await query('DELETE FROM doctors WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[doctors/delete]', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
