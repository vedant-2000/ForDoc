// Patient problems — the clinical complaints a patient is being treated for.
//
// This is the "patient problem page" both clients render: a per-patient list
// that grows over time, each entry carrying its own documents (X-rays, scans,
// reports) via patient_documents.problem_id. Sessions stay where they are;
// a problem is the longer-lived thing a course of sessions is aimed at.
//
// Deliberately free-form (title + description + severity) rather than a fixed
// vocabulary: what gets recorded differs per clinic, and forcing a taxonomy
// here would make the field unusable for half of them.

const express = require('express');
const { query } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired());

const SEVERITIES = ['mild', 'moderate', 'severe'];
const STATUSES = ['open', 'resolved'];

function textOrNull(v, max = 2000) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
}

function oneOf(v, list, fallback) {
  const s = String(v || '').toLowerCase().trim();
  return list.includes(s) ? s : fallback;
}

function dateOrToday(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10);
}

function dateOrNull(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Each row carries its document count so the list can show "3 files" without
// the client firing a request per problem.
const SELECT_SQL = `
  SELECT pr.id, pr.patient_id, pr.title, pr.description, pr.severity, pr.status,
         pr.noted_on, pr.resolved_on, pr.created_by_name, pr.created_at,
         pr.updated_at,
         COALESCE(dc.n, 0)::int AS document_count
    FROM patient_problems pr
    LEFT JOIN (
      SELECT problem_id, COUNT(*) AS n
        FROM patient_documents
       WHERE deleted_at IS NULL AND problem_id IS NOT NULL
       GROUP BY problem_id
    ) dc ON dc.problem_id = pr.id`;

// GET /api/problems?patient_id=&status=
router.get('/', async (req, res) => {
  const pid = +req.query.patient_id;
  if (!pid) return res.status(400).json({ error: 'patient_id required' });
  const where = ['pr.patient_id = $1'];
  const vals = [pid];
  if (req.query.status) {
    where.push('pr.status = $2');
    vals.push(oneOf(req.query.status, STATUSES, 'open'));
  }
  try {
    const { rows } = await query(
      `${SELECT_SQL} WHERE ${where.join(' AND ')}
        ORDER BY (pr.status = 'open') DESC, pr.noted_on DESC, pr.id DESC`,
      vals);
    res.json(rows);
  } catch (e) {
    console.error('[problems/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// POST /api/problems  { patient_id, title, description?, severity?, noted_on? }
router.post('/', async (req, res) => {
  const b = req.body || {};
  const pid = +b.patient_id;
  const title = textOrNull(b.title, 200);
  if (!pid) return res.status(400).json({ error: 'patient_id required' });
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const { rows } = await query(
      `INSERT INTO patient_problems
         (patient_id, title, description, severity, status, noted_on, created_by_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        pid, title,
        textOrNull(b.description),
        b.severity ? oneOf(b.severity, SEVERITIES, null) : null,
        oneOf(b.status, STATUSES, 'open'),
        dateOrToday(b.noted_on),
        textOrNull(req.user.username, 120),
      ]);
    const { rows: out } = await query(`${SELECT_SQL} WHERE pr.id = $1`, [rows[0].id]);
    res.status(201).json(out[0]);
  } catch (e) {
    console.error('[problems/create]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

// PATCH /api/problems/:id
router.patch('/:id(\\d+)', async (req, res) => {
  const id = +req.params.id;
  const b = req.body || {};
  const sets = [];
  const vals = [id];
  let n = 2;
  if ('title' in b) {
    const t = textOrNull(b.title, 200);
    if (!t) return res.status(400).json({ error: 'title cannot be empty' });
    sets.push(`title = $${n++}`); vals.push(t);
  }
  if ('description' in b) { sets.push(`description = $${n++}`); vals.push(textOrNull(b.description)); }
  if ('severity' in b)    { sets.push(`severity = $${n++}`);    vals.push(b.severity ? oneOf(b.severity, SEVERITIES, null) : null); }
  if ('noted_on' in b)    { sets.push(`noted_on = $${n++}`);    vals.push(dateOrToday(b.noted_on)); }
  if ('status' in b) {
    const st = oneOf(b.status, STATUSES, 'open');
    sets.push(`status = $${n++}`); vals.push(st);
    // Stamp/clear the resolution date alongside the status so the two can
    // never disagree.
    sets.push(`resolved_on = $${n++}`);
    vals.push(st === 'resolved' ? dateOrNull(b.resolved_on) || new Date().toISOString().slice(0, 10) : null);
  } else if ('resolved_on' in b) {
    sets.push(`resolved_on = $${n++}`); vals.push(dateOrNull(b.resolved_on));
  }
  if (!sets.length) return res.json({ ok: true });

  try {
    const { rows } = await query(
      `UPDATE patient_problems SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 RETURNING id`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { rows: out } = await query(`${SELECT_SQL} WHERE pr.id = $1`, [id]);
    res.json(out[0]);
  } catch (e) {
    console.error('[problems/patch]', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /api/problems/:id
//
// Documents filed against the problem are NOT deleted — the FK is ON DELETE
// SET NULL, so they fall back to the patient's general document list. Files
// outlive the label someone put on them.
router.delete('/:id(\\d+)', async (req, res) => {
  try {
    const r = await query('DELETE FROM patient_problems WHERE id=$1', [+req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[problems/delete]', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
