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
// NOTE: registered BEFORE the '/:id' route below. Express matches in
// order, so a literal path placed after a wildcard would never be hit -
// '/drive-folders' would be read as a patient code.
// GET /api/patients/drive-folders?q=&status=&limit=&offset=   (admin)
//
// The migration worklist: every patient with the state of their Drive folder
// and, when they have none, the folder in the base that looks like theirs.
// One Drive listing serves the whole request rather than one call per row.
//
// status = in_place | elsewhere | suggestion | missing   (omit for all)
//
// Status is computed, not stored, so the filter and the counts are applied
// AFTER the comparison and the page is sliced last. Paging in SQL first
// would hand back partial pages and counts that disagree with the rows.
router.get('/drive-folders', authRequired(['admin']), async (req, res) => {
  const limit = Math.min(200, Math.max(1, +req.query.limit || 25));
  const offset = Math.max(0, +req.query.offset || 0);
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '').trim();
  // Paging and filtering ride the cache - that is the whole speed win.
  // An explicit Reload does not: pressing it and seeing no change is
  // indistinguishable from a broken button.
  const fresh = String(req.query.fresh || '') === '1';
  try {
    const params = [];
    let where = 'deleted_at IS NULL';
    if (q) {
      params.push('%' + q + '%');
      where += ` AND (patient_code ILIKE $1 OR full_name ILIKE $1)`;
    }
    // Cap rather than page: the whole set has to be classified to filter and
    // count it. A clinic with more than this has bigger problems than paging.
    const { rows: patients } = await query(
      `SELECT id, patient_code, full_name, drive_folder_id, drive_folder_path
         FROM patients WHERE ${where}
        ORDER BY patient_code ASC
        LIMIT 5000`,
      params);

    // Best effort: without Drive we still return the patients, just with no
    // suggestions, so the screen is usable and says why.
    let folders = [];
    let baseId = null;
    let driveError = null;
    try {
      const settings = await D.getSettings();
      const drive = await D.getDriveForAdmin(req.user.id);
      baseId = await D.baseFolderId(drive, settings);
      folders = await D.listFolders(drive, { parentId: baseId || 'root', fresh });
    } catch (e) {
      driveError = e.message;
    }
    const folderIds = new Set(folders.map((f) => f.id));

    const classified = patients.map((p) => {
      const inBase = !!(p.drive_folder_id && folderIds.has(p.drive_folder_id));
      let suggestion = null;
      if (!inBase && folders.length) {
        const codeRe = D.patientCodeRegExp(p.patient_code);
        const nameNorm = D.normalizeFolderName(p.full_name);
        let best = null;
        if (codeRe) {
          for (const f of folders) {
            const n = D.normalizeFolderName(f.name);
            if (!codeRe.test(n)) continue;
            const score = (nameNorm.length > 1 && n.includes(nameNorm)) ? 80 : 50;
            if (!best || score > best.score) best = { ...f, score };
          }
        }
        if (best) suggestion = { id: best.id, name: best.name };
      }

      // One state per row, in the order that decides what to DO about it.
      let st;
      if (inBase) st = 'in_place';
      else if (suggestion) st = 'suggestion';
      else if (p.drive_folder_id) st = 'elsewhere';
      else st = 'missing';

      return {
        id: p.id,
        patient_code: p.patient_code,
        full_name: p.full_name,
        drive_folder_id: p.drive_folder_id,
        drive_folder_path: p.drive_folder_path,
        in_base: inBase,
        suggestion,
        status: st,
      };
    });

    const counts = { in_place: 0, elsewhere: 0, suggestion: 0, missing: 0 };
    for (const c of classified) counts[c.status]++;

    const filtered = status && counts[status] !== undefined
      ? classified.filter((c) => c.status === status)
      : classified;

    res.json({
      patients: filtered.slice(offset, offset + limit),
      total: filtered.length,
      counts,
      base_folder_id: baseId,
      drive_error: driveError,
    });
  } catch (e) {
    console.error('[patients/drive-folders]', e);
    res.status(500).json({ error: e.message });
  }
});

// NOTE: registered BEFORE the '/:id' route below. Express matches in
// order, so a literal path placed after a wildcard would never be hit -
// '/drive-folders' would be read as a patient code.
// GET /api/patients/:id/drive-files?fresh=1
//
// THE media list for a patient - one list, not two.
//
// Drive's folder is the spine: it holds everything, including files nobody
// uploaded through the app (scans dropped in from a desktop, records filed
// before the app existed). Onto each file we graft what the server knows -
// its category, its clinical date, its document id - because Drive metadata
// alone cannot tell an X-ray from a prescription beyond which subfolder it
// landed in.
//
// Documents the server has but Drive does not YET have are appended rather
// than hidden. A photo uploaded ten seconds ago is still syncing, and having
// it vanish from the gallery until Google catches up looks like data loss.
//
// Depth 2: the patient folder plus its category subfolders (Photos, X-Ray...),
// which is exactly how resolveDocumentFolder files things. Going deeper would
// cost one Drive round-trip per folder for tree shapes nobody creates here.
router.get('/:id(\\d+)/drive-files', async (req, res) => {
  const id = +req.params.id;
  const fresh = String(req.query.fresh || '') === '1';
  try {
    const { rows } = await query(
      'SELECT drive_folder_id, drive_folder_path FROM patients WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Patient not found' });
    const root = rows[0].drive_folder_id;
    if (!root) {
      return res.json({ files: [], folder_path: null, connected: true, no_folder: true });
    }

    const drive = await D.getDriveForAdmin(
      req.user.role === 'admin' ? req.user.id : null);

    const [rootFiles, subs] = await Promise.all([
      D.listFiles(drive, { parentId: root, fresh }),
      D.listFolders(drive, { parentId: root, fresh }),
    ]);

    // What the server knows, keyed by the Drive file it corresponds to.
    const { rows: docs } = await query(
      `SELECT id, drive_file_id, category, doc_date, title, filename,
              mime_type, size_bytes, sync_status
         FROM patient_documents
        WHERE patient_id = $1 AND deleted_at IS NULL`, [id]);
    const byDriveId = new Map();
    for (const d of docs) {
      if (d.drive_file_id) byDriveId.set(d.drive_file_id, d);
    }

    const files = rootFiles.map((f) => ({ ...f, folder: '' }));
    // Sequential, not Promise.all over every subfolder: a patient with eight
    // category folders would otherwise fire eight parallel Drive calls and
    // invite the rate limiting we already classify elsewhere.
    for (const sub of subs) {
      const kids = await D.listFiles(drive, { parentId: sub.id, fresh });
      for (const f of kids) files.push({ ...f, folder: sub.name });
    }

    // Graft the server's knowledge on.
    const seen = new Set();
    for (const f of files) {
      const d = byDriveId.get(f.id);
      if (!d) continue;
      seen.add(d.id);
      f.document_id = d.id;
      f.category = d.category;
      f.doc_date = d.doc_date;
      f.sync_status = d.sync_status;
      if (d.title) f.title = d.title;
      // Our own copy renders faster than Drive's thumbnail and needs no
      // Google round-trip, so prefer it when we have one.
      if (d.filename) f.url = `/uploads/patient-docs/${d.filename}`;
    }

    // Uploaded but not on Drive yet (or the push failed). Shown, and marked.
    for (const d of docs) {
      if (seen.has(d.id)) continue;
      if (d.drive_file_id && byDriveId.has(d.drive_file_id)) continue;
      files.push({
        id: d.drive_file_id || `doc:${d.id}`,
        document_id: d.id,
        name: d.title || d.filename || `Document ${d.id}`,
        mime_type: d.mime_type,
        size_bytes: d.size_bytes == null ? null : Number(d.size_bytes),
        modified_at: null,
        web_view_link: null,
        thumbnail_link: null,
        url: d.filename ? `/uploads/patient-docs/${d.filename}` : null,
        folder: D.categoryFolderName(d.category),
        category: d.category,
        doc_date: d.doc_date,
        sync_status: d.sync_status,
      });
    }

    // Newest first, by the CLINICAL date where we have one - that is the date
    // the doctor thinks in. Drive's modified time is the fallback.
    const when = (f) => String(f.doc_date || f.modified_at || '');
    files.sort((a, b) => when(b).localeCompare(when(a)));

    res.json({
      files,
      folder_path: rows[0].drive_folder_path || null,
      connected: true,
    });
  } catch (e) {
    const err = D.classifyDriveError(e);
    console.error('[patients/drive-files]', err.message);
    // Not fatal for the page: the tab shows the server-side documents and
    // says why the Drive half is missing.
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

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
    // skip_drive_folder: the caller has already picked an existing folder to
    // reuse and will link it next. Without this the automatic create races
    // that link and leaves an empty duplicate behind in Drive.
    const skipFolder = (req.body || {}).skip_drive_folder === true
      || String((req.body || {}).skip_drive_folder || '') === 'true';
    if (!skipFolder) {
      D.getSettings()
        .then((s) => {
          if (s.auto_create_patient_folder === false) return null;
          return D.ensurePatientFolderForId(
            patient.id, req.user.role === 'admin' ? req.user.id : null);
        })
        .catch(() => {});
    }
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
  let folder;
  try {
    // The crash that mattered most: this reaches Google, and when the refresh
    // token had expired the rejection propagated out of an async handler with
    // no try - killing the process for every logged-in user, not just the one
    // who pressed the button.
    folder = await D.ensurePatientFolderForId(
      id, req.user.role === 'admin' ? req.user.id : null, { force });
  } catch (e) {
    const err = D.classifyDriveError(e);
    console.error('[patients/drive-folder]', err.message);
    return res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
  if (!folder) {
    return res.status(502).json({
      error: 'Could not create the Drive folder. Check that Google Drive is '
        + 'connected in Admin -> Google Drive.',
    });
  }
  // `matched` tells the caller whether we adopted a folder the clinic
  // already had ('exact' | 'code+name' | 'code') or made a new one
  // ('created'), so the UI can say which rather than leaving the admin to
  // wonder why no new folder appeared.
  res.json({ ok: true, folder });
});

// POST /api/patients/:id/drive-folder/link   { folder_id }   (admin)
//
// Attach the patient to a folder that already exists - the normal case when
// adopting a Drive the clinic has been filling in by hand for years.
router.post('/:id(\\d+)/drive-folder/link', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  const folderId = String((req.body || {}).folder_id || '').trim();
  if (!folderId) return res.status(400).json({ error: 'folder_id required' });
  try {
    const drive = await D.getDriveForAdmin(req.user.id);
    const { data } = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,mimeType,trashed',
      supportsAllDrives: true,
    });
    if (data.mimeType !== 'application/vnd.google-apps.folder') {
      return res.status(400).json({ error: 'That is a file, not a folder.' });
    }
    if (data.trashed) {
      return res.status(400).json({ error: 'That folder is in the trash.' });
    }
    const path = await D.folderPath(drive, folderId);
    await query(
      'UPDATE patients SET drive_folder_id=$2, drive_folder_path=$3 WHERE id=$1',
      [id, folderId, path]);
    res.json({ ok: true, folder: { id: folderId, name: data.name, path } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/patients/:id/drive-folder/move   (admin)
//
// Move the patient's existing folder into the CURRENT base folder. Used to
// migrate patients one at a time after the base folder is repointed - the
// folder keeps its id and all its contents, so nothing already uploaded is
// disturbed and no link breaks.
router.post('/:id(\\d+)/drive-folder/move', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  try {
    const { rows } = await query(
      'SELECT drive_folder_id FROM patients WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Patient not found' });
    const folderId = rows[0].drive_folder_id;
    if (!folderId) {
      return res.status(400).json({
        error: 'This patient has no Drive folder yet - create or link one first.',
      });
    }
    const settings = await D.getSettings();
    const drive = await D.getDriveForAdmin(req.user.id);
    const base = await D.baseFolderId(drive, settings);
    if (!base) {
      return res.status(400).json({
        error: 'No base folder is configured in Admin -> Google Drive.',
      });
    }
    const moved = await D.moveFolder(drive, folderId, base);
    const path = await D.folderPath(drive, folderId);
    await query('UPDATE patients SET drive_folder_path=$2 WHERE id=$1', [id, path]);
    res.json({ ok: true, moved: moved.moved, folder: { id: folderId, name: moved.name, path } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
