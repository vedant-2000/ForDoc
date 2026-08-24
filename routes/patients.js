const express = require('express');
const { query } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const D = require('../utils/drive');

const router = express.Router();

// Both admin & doctor can manage patients (adjust if you want admin-only create).
router.use(authRequired());

// GET /api/patients?q=&limit=&offset=
// Soft-deleted patients are INCLUDED in the response (with deleted_at set) so
// the UI can show a deleted indicator. Active rows sort first, then by most
// recent session date DESC (fallback to updated_at). Paginated with
// limit/offset so the client can lazy-load on scroll. Defaults: limit=10.
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  // Clamp so a buggy client can't blow up the DB with a giant limit.
  const rawLimit = parseInt(req.query.limit, 10);
  const rawOffset = parseInt(req.query.offset, 10);
  const limit  = Number.isFinite(rawLimit)  ? Math.max(1, Math.min(100, rawLimit))   : 10;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset)                 : 0;

  try {
    // last_session = most recent treatment_sessions.session_date for the
    // patient; falls back to the patient's own updated_at when no session
    // exists. Used by the patient list UI's "Last updated" column.
    let rows;
    if (q) {
      ({ rows } = await query(
        `SELECT p.id, p.patient_code, p.full_name, p.phone,
                p.created_at, p.updated_at, p.deleted_at,
                MAX(s.session_date) AS last_session,
                COUNT(s.id)::int    AS session_count
         FROM patients p
         LEFT JOIN treatment_sessions s ON s.patient_id = p.id
         WHERE p.patient_code ILIKE $1 OR p.full_name ILIKE $1
         GROUP BY p.id
         ORDER BY (p.deleted_at IS NULL) DESC,
                  COALESCE(MAX(s.session_date)::timestamptz, p.updated_at) DESC
         LIMIT $2 OFFSET $3`,
        [`%${q}%`, limit, offset]
      ));
    } else {
      ({ rows } = await query(
        `SELECT p.id, p.patient_code, p.full_name, p.phone,
                p.created_at, p.updated_at, p.deleted_at,
                MAX(s.session_date) AS last_session,
                COUNT(s.id)::int    AS session_count
         FROM patients p
         LEFT JOIN treatment_sessions s ON s.patient_id = p.id
         GROUP BY p.id
         ORDER BY (p.deleted_at IS NULL) DESC,
                  COALESCE(MAX(s.session_date)::timestamptz, p.updated_at) DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
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
    const patient = rows[0];
    res.status(201).json(patient);

    // Fire-and-forget AFTER responding: a new patient gets their Drive
    // folder immediately, so staff can drop an X-ray straight into Drive
    // before anything has been uploaded through the app. Deliberately not
    // awaited - creating a patient must not hang on, or fail because of,
    // Google. If it fails the folder is made on the first upload instead.
    D.getSettings()
      .then((s) => {
        if (s.auto_create_patient_folder === false) return null;
        return D.ensurePatientFolderForId(
          patient.id, req.user.role === 'admin' ? req.user.id : null);
      })
      .catch(() => {});
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'patient_code already exists' });
    console.error('[patients/create]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

// POST /api/patients/:id/drive-folder - create the folder on demand.
//
// For patients that predate this feature, or whose creation-time attempt
// failed because Drive was down. `force=1` re-resolves even when one is
// already recorded.
router.post('/:id(\\d+)/drive-folder', async (req, res) => {
  const id = +req.params.id;
  const force = String(req.query.force || '') === '1';
  const folder = await D.ensurePatientFolderForId(
    id, req.user.role === 'admin' ? req.user.id : null, { force });
  if (!folder) {
    return res.status(502).json({
      error: 'Could not create the Drive folder. Check that Google Drive is '
        + 'connected in Admin -> Google Drive.',
    });
  }
  res.json({ ok: true, folder });
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

    // A renamed or re-coded patient should not leave a stale label on their
    // Drive folder. Best-effort, after the response, and only when the name
    // actually feeds the template.
    if (full_name !== undefined || patient_code !== undefined) {
      D.renamePatientFolder(id, req.user.role === 'admin' ? req.user.id : null)
        .catch(() => {});
    }
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'patient_code already exists' });
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /api/patients/:id  (admin only) — SOFT delete.
// Sets deleted_at = NOW(). The patient + all their sessions/marks/reports stay
// in the DB; the partial unique index on patient_code allows a new patient to
// be created later with the same code/name. Idempotent: re-deleting a row
// keeps its original deleted_at.
router.delete('/:id', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const id = +req.params.id;
  try {
    const r = await query(
      `UPDATE patients
          SET deleted_at = COALESCE(deleted_at, NOW()),
              updated_at = NOW()
        WHERE id=$1
      RETURNING id, deleted_at`,
      [id]
    );
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted_at: r.rows[0].deleted_at });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed' });
  }
});

// POST /api/patients/:id/restore  (admin only) — undo a soft delete.
// Only succeeds if the patient's code isn't now taken by a live patient,
// since the partial unique index allows the code to be reused after a
// soft delete.
router.post('/:id/restore', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const id = +req.params.id;
  try {
    const { rows } = await query(
      'SELECT patient_code, deleted_at FROM patients WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].deleted_at == null) return res.json({ ok: true });

    const clash = await query(
      `SELECT 1 FROM patients
        WHERE patient_code = $1 AND deleted_at IS NULL AND id <> $2
        LIMIT 1`,
      [rows[0].patient_code, id],
    );
    if (clash.rowCount) {
      return res.status(409).json({
        error: `Code ${rows[0].patient_code} is now used by an active patient. `
             + 'Rename that one first.',
      });
    }
    await query(
      'UPDATE patients SET deleted_at = NULL, updated_at = NOW() WHERE id=$1',
      [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[patients/restore]', e);
    res.status(500).json({ error: 'Restore failed' });
  }
});

// DELETE /api/patients/:id/purge  (admin only) — PERMANENT delete.
//
// Unlike the soft delete above this is irreversible: the row is removed and
// every session, mark and saved report cascades away with it. Only allowed
// on a patient that has ALREADY been soft-deleted, so a permanent wipe can
// never be a single mis-click — the UI has to delete first, then purge.
router.delete('/:id/purge', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const id = +req.params.id;
  try {
    const { rows } = await query(
      'SELECT deleted_at FROM patients WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].deleted_at == null) {
      return res.status(409).json({
        error: 'Patient must be deleted before it can be permanently removed.',
      });
    }
    await query('DELETE FROM patients WHERE id=$1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[patients/purge]', e);
    res.status(500).json({ error: 'Permanent delete failed' });
  }
});

module.exports = router;
