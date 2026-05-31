const express = require('express');
const { query } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Both admin & doctor can manage patients (adjust if you want admin-only create).
router.use(authRequired());

// GET /api/patients?q=
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  try {
    // last_session = most recent treatment_sessions.session_date for the
    // patient; falls back to the patient's own updated_at when no session
    // exists. Used by the patient list UI's "Last updated" column.
    let rows;
    if (q) {
      ({ rows } = await query(
        `SELECT p.id, p.patient_code, p.full_name, p.phone,
                p.created_at, p.updated_at,
                MAX(s.session_date) AS last_session
         FROM patients p
         LEFT JOIN treatment_sessions s ON s.patient_id = p.id
         WHERE p.patient_code ILIKE $1 OR p.full_name ILIKE $1
         GROUP BY p.id
         ORDER BY COALESCE(MAX(s.session_date)::timestamptz, p.updated_at) DESC
         LIMIT 200`,
        [`%${q}%`]
      ));
    } else {
      ({ rows } = await query(
        `SELECT p.id, p.patient_code, p.full_name, p.phone,
                p.created_at, p.updated_at,
                MAX(s.session_date) AS last_session
         FROM patients p
         LEFT JOIN treatment_sessions s ON s.patient_id = p.id
         GROUP BY p.id
         ORDER BY COALESCE(MAX(s.session_date)::timestamptz, p.updated_at) DESC
         LIMIT 200`
      ));
    }
    res.json(rows);
  } catch (e) {
    console.error('[patients/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// GET /api/patients/:id   (id OR patient_code)
router.get('/:id', async (req, res) => {
  const id = req.params.id;
  const isNumeric = /^\d+$/.test(id);
  try {
    const { rows } = await query(
      isNumeric
        ? `SELECT * FROM patients WHERE id=$1`
        : `SELECT * FROM patients WHERE patient_code=$1`,
      [isNumeric ? +id : id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// POST /api/patients  { patient_code, full_name, phone?, notes? }
router.post('/', async (req, res) => {
  const { patient_code, full_name, phone, notes } = req.body || {};
  if (!patient_code || !full_name) {
    return res.status(400).json({ error: 'patient_code and full_name required' });
  }
  try {
    const { rows } = await query(
      `INSERT INTO patients (patient_code, full_name, phone, notes)
       VALUES ($1,$2,$3,$4)
       RETURNING *`,
      [patient_code.trim(), full_name.trim(), phone || null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'patient_code already exists' });
    console.error('[patients/create]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

// PATCH /api/patients/:id
router.patch('/:id', async (req, res) => {
  const id = +req.params.id;
  const { full_name, phone, notes, patient_code } = req.body || {};
  const sets = []; const args = []; let i = 1;
  if (full_name    !== undefined) { sets.push(`full_name=$${i++}`);    args.push(full_name); }
  if (phone        !== undefined) { sets.push(`phone=$${i++}`);        args.push(phone); }
  if (notes        !== undefined) { sets.push(`notes=$${i++}`);        args.push(notes); }
  if (patient_code !== undefined) { sets.push(`patient_code=$${i++}`); args.push(patient_code); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push(`updated_at=NOW()`);
  args.push(id);
  try {
    const { rows } = await query(
      `UPDATE patients SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`,
      args
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'patient_code already exists' });
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /api/patients/:id  (admin only)
router.delete('/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const id = +req.params.id;
  try {
    const r = await query('DELETE FROM patients WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
