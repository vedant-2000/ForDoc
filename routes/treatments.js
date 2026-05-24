const express = require('express');
const { query, tx } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired());

// ─────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────

// GET /api/treatments/patients/:patientId/sessions
router.get('/patients/:patientId/sessions', async (req, res) => {
  const pid = +req.params.patientId;
  try {
    const { rows } = await query(
      `SELECT s.id, s.patient_id, s.doctor_id, s.session_date, s.label, s.color, s.notes,
              s.created_at,
              d.full_name AS doctor_name, d.color AS doctor_color,
              (SELECT COUNT(*) FROM marks m WHERE m.session_id = s.id)::int AS mark_count
         FROM treatment_sessions s
         LEFT JOIN doctors d ON d.id = s.doctor_id
        WHERE s.patient_id = $1
        ORDER BY s.session_date DESC, s.id DESC`,
      [pid]
    );
    res.json(rows);
  } catch (e) {
    console.error('[sessions/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// POST /api/treatments/patients/:patientId/sessions
// { session_date: 'YYYY-MM-DD', label?, color?, notes?, doctor_id? }
// Doctors auto-set doctor_id to themselves.
router.post('/patients/:patientId/sessions', async (req, res) => {
  const pid = +req.params.patientId;
  let { session_date, label, color, notes, doctor_id } = req.body || {};
  if (!session_date) {
    const t = new Date();
    session_date = t.toISOString().slice(0, 10);
  }
  if (req.user.role === 'doctor') doctor_id = req.user.id;

  try {
    // pick doctor color as default chip color
    let chipColor = color;
    if (!chipColor && doctor_id) {
      const { rows } = await query('SELECT color FROM doctors WHERE id=$1', [doctor_id]);
      if (rows.length) chipColor = rows[0].color;
    }
    const { rows } = await query(
      `INSERT INTO treatment_sessions (patient_id, doctor_id, session_date, label, color, notes)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (patient_id, session_date) DO UPDATE
         SET label = COALESCE(EXCLUDED.label, treatment_sessions.label),
             color = COALESCE(EXCLUDED.color, treatment_sessions.color),
             notes = COALESCE(EXCLUDED.notes, treatment_sessions.notes),
             doctor_id = COALESCE(EXCLUDED.doctor_id, treatment_sessions.doctor_id)
       RETURNING *`,
      [pid, doctor_id || null, session_date, label || null, chipColor || null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[sessions/create]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

// DELETE /api/treatments/sessions/:id
router.delete('/sessions/:id', async (req, res) => {
  const id = +req.params.id;
  try {
    const r = await query('DELETE FROM treatment_sessions WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Marks
// ─────────────────────────────────────────────────────────────

// GET /api/treatments/sessions/:id/marks
router.get('/sessions/:id/marks', async (req, res) => {
  const id = +req.params.id;
  try {
    const { rows } = await query(
      `SELECT m.id, m.session_id, m.body_image_id, m.doctor_id, m.order_num,
              m.rel_x::float AS rel_x, m.rel_y::float AS rel_y,
              m.tool, m.color, m.room, m.treatment, m.effectiveness, m.note, m.created_at,
              d.full_name AS doctor_name, d.color AS doctor_color
         FROM marks m
         LEFT JOIN doctors d ON d.id = m.doctor_id
        WHERE m.session_id = $1
        ORDER BY m.order_num ASC, m.id ASC`,
      [id]
    );
    res.json(rows);
  } catch (e) {
    console.error('[marks/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// PUT /api/treatments/sessions/:id/marks
// Body: { body_image_id?, marks: [ { rel_x, rel_y, tool, color, room, treatment, effectiveness, note, doctor_id? } ] }
//
// Ownership rules:
//   - doctor user: replaces ONLY their own marks in this session; other doctors' marks are kept.
//   - admin user : replaces the entire mark set (legacy behaviour).
// Order is recomputed across the full final set, ascending.
router.put('/sessions/:id/marks', async (req, res) => {
  const id = +req.params.id;
  const { body_image_id, marks } = req.body || {};
  if (!Array.isArray(marks)) return res.status(400).json({ error: 'marks must be an array' });

  const isDoctor = req.user.role === 'doctor';
  const me = req.user.id;

  // DEFENSE-IN-DEPTH: a doctor's payload must not contain marks owned by
  // someone else. Drop any rows whose doctor_id is set to a different doctor —
  // this stops a buggy client from "stealing" other doctors' marks on save
  // (which would duplicate them in the DB, since their original rows
  // are intentionally NOT deleted by the per-doctor DELETE below).
  const incoming = isDoctor
    ? marks.filter(m => m && (m.doctor_id == null || m.doctor_id === me))
    : marks;

  try {
    const result = await tx(async (c) => {
      if (isDoctor) {
        await c.query('DELETE FROM marks WHERE session_id=$1 AND doctor_id=$2', [id, me]);
      } else {
        await c.query('DELETE FROM marks WHERE session_id=$1', [id]);
      }

      for (let i = 0; i < incoming.length; i++) {
        const m = incoming[i] || {};
        // Doctors can only insert marks owned by themselves.
        const ownerId = isDoctor ? me : (m.doctor_id || null);
        await c.query(
          `INSERT INTO marks
             (session_id, body_image_id, doctor_id, order_num, rel_x, rel_y,
              tool, color, room, treatment, effectiveness, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id,
            body_image_id || null,
            ownerId,
            i + 1,                              // tentative order — re-numbered below
            clamp01(m.rel_x), clamp01(m.rel_y),
            m.tool || 'cross',
            m.color || '#c0392b',
            m.room || null,
            m.treatment || m.label || null,
            m.effectiveness || m.eff || null,
            m.note || null,
          ]
        );
      }

      // Re-number order_num sequentially across the entire session.
      await c.query(
        `WITH ordered AS (
           SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, id) AS n
             FROM marks WHERE session_id = $1
         )
         UPDATE marks SET order_num = ordered.n
           FROM ordered WHERE marks.id = ordered.id`,
        [id]
      );

      const { rows } = await c.query(
        `SELECT m.id, m.session_id, m.body_image_id, m.doctor_id, m.order_num,
                m.rel_x::float AS rel_x, m.rel_y::float AS rel_y,
                m.tool, m.color, m.room, m.treatment, m.effectiveness, m.note, m.created_at,
                d.full_name AS doctor_name, d.color AS doctor_color
           FROM marks m
           LEFT JOIN doctors d ON d.id = m.doctor_id
          WHERE m.session_id = $1
          ORDER BY m.order_num ASC, m.id ASC`,
        [id]
      );
      return rows;
    });
    res.json(result);
  } catch (e) {
    console.error('[marks/put]', e);
    res.status(500).json({ error: 'Save failed' });
  }
});

// GET /api/treatments/patients/:patientId/all
// Returns every session (with marks) for a patient, for the "all treatments" view.
router.get('/patients/:patientId/all', async (req, res) => {
  const pid = +req.params.patientId;
  try {
    const { rows: sessions } = await query(
      `SELECT s.id, s.patient_id, s.doctor_id, s.session_date, s.label, s.color, s.notes,
              s.created_at,
              d.full_name AS doctor_name, d.color AS doctor_color
         FROM treatment_sessions s
         LEFT JOIN doctors d ON d.id = s.doctor_id
        WHERE s.patient_id = $1
        ORDER BY s.session_date ASC, s.id ASC`,
      [pid]
    );
    if (!sessions.length) return res.json({ sessions: [] });

    const ids = sessions.map(s => s.id);
    const { rows: marks } = await query(
      `SELECT m.id, m.session_id, m.body_image_id, m.doctor_id, m.order_num,
              m.rel_x::float AS rel_x, m.rel_y::float AS rel_y,
              m.tool, m.color, m.room, m.treatment, m.effectiveness, m.note, m.created_at,
              d.full_name AS doctor_name, d.color AS doctor_color
         FROM marks m
         LEFT JOIN doctors d ON d.id = m.doctor_id
        WHERE m.session_id = ANY($1::int[])
        ORDER BY m.session_id, m.order_num ASC`,
      [ids]
    );
    const byId = Object.fromEntries(sessions.map(s => [s.id, { ...s, marks: [] }]));
    marks.forEach(m => { if (byId[m.session_id]) byId[m.session_id].marks.push(m); });
    res.json({ sessions: sessions.map(s => byId[s.id]) });
  } catch (e) {
    console.error('[treatments/all]', e);
    res.status(500).json({ error: 'Failed' });
  }
});

function clamp01(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

module.exports = router;
