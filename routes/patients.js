const express = require('express');
const { query } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const D = require('../utils/drive');
const cache = require('../utils/cache');

// Per-patient Drive match verdicts, accumulated as the worklist's per-page
// searches run. 'none' means "searched the whole Drive, nothing carries this
// code"; an object is the folder that does. 15 minutes: long enough that
// paging through the whole Missing list sees one consistent world, short
// enough that a folder created in Drive shows up without a restart. The
// Reload button (fresh=1) ignores and rewrites these.
const VERDICT_TTL_MS = 15 * 60_000;
const verdictKey = (code) => `driveMatch:${String(code || '').toLowerCase()}`;

// Drive's `contains` matches word-prefixes and the inventory indexes whole
// tokens, so both are keyed by the longest alphanumeric run of the code
// ('Toc-12565' -> '12565'); the full-code regex re-validates every candidate
// before anything is suggested.
const searchTermFor = (code) => {
  const runs = String(code || '').match(/[a-zA-Z0-9]+/g) || [];
  runs.sort((a, b) => b.length - a.length);
  return runs[0] || String(code || '').trim();
};

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
    let basePath = null;
    let driveError = null;
    let drive = null;
    try {
      const settings = await D.getSettings();
      drive = await D.getDriveForAdmin(req.user.id);
      baseId = await D.baseFolderId(drive, settings);
      // The base folder's children, which decide in_place vs elsewhere.
      folders = await D.listFolders(drive, { parentId: baseId || 'root', fresh });
      // Logged because a truncated listing is invisible from the outside: it
      // does not error, it just quietly reports folders that ARE in the base
      // as living somewhere else.
      console.log(`[patients/drive-folders] base children: ${folders.length}`);
      // Which folder "in place" actually means. Without it on screen, a row
      // sitting in some other tree looks mislabelled rather than misplaced.
      if (baseId) basePath = await D.folderPath(drive, baseId);
    } catch (e) {
      driveError = e.message;
    }
    // Every folder name in the Drive, indexed by token. Used ONLY if a
    // previous request already finished building it — enumerating a Drive
    // this size takes longer than a request may live, and awaiting it inline
    // is exactly what made this screen answer 'the server took too long'.
    // Otherwise: kick the build off and answer now by the per-code searches
    // below, which is how this worked before the inventory existed. Within a
    // minute the inventory lands and every later request is exact and cheap.
    let inv = null;
    let indexing = false;
    if (drive) {
      inv = fresh ? null : D.folderInventoryReady(drive);
      if (!inv) {
        D.startFolderInventory(drive, { fresh });
        indexing = true;
      }
    }

    const baseChildIds = new Set(folders.map((f) => f.id));

    /**
     * Does this folder sit directly inside the base folder?
     *
     * The inventory answers first when it is ready: it is paged to
     * exhaustion and carries every folder's parents, so it cannot run out
     * of rows the way one parent's child listing could. The child listing
     * stays as the answer while the inventory is still building.
     */
    const sitsInBase = (folderId) => {
      if (!folderId) return false;
      // byId is guarded rather than assumed: a 500 here takes down the whole
      // worklist, and an inventory reaching this code without its id index
      // should degrade to the child listing, not crash the screen.
      if (inv && inv.byId && baseId) {
        const f = inv.byId.get(folderId);
        if (f) return (f.parents || []).includes(baseId);
      }
      return baseChildIds.has(folderId);
    };

    const classified = patients.map((p) => {
      const inBase = !!(p.drive_folder_id && sitsInBase(p.drive_folder_id));
      let suggestion = null;
      // Only patients with NO folder are looking for one. Searching on
      // behalf of a patient who is already linked finds the folder they are
      // linked to and offers it back as a fresh suggestion - which is how a
      // row that had just been linked came back saying 'Link'.
      if (!inBase && !p.drive_folder_id && (folders.length || inv)) {
        const codeRe = D.patientCodeRegExp(p.patient_code);
        const nameNorm = D.normalizeFolderName(p.full_name);
        let best = null;
        if (codeRe) {
          for (const f of folders) {
            const n = D.normalizeFolderName(f.name);
            if (!codeRe.test(n)) continue;
            // The code must match as a whole token; the name only ever adds
            // confidence on top.
            const score = (nameNorm.length > 1 && n.includes(nameNorm)) ? 80 : 50;
            if (!best || score > best.score) best = { ...f, score };
          }
        }
        if (best) {
          // Everything in this pass is a base child by construction.
          suggestion = { id: best.id, name: best.name, in_base: true };
        }

        // Not a base child: look the code up in the whole-Drive inventory.
        // One Map hit replaces the per-code Google search the walk below
        // used to make for this row.
        if (!suggestion && inv && codeRe) {
          const term = searchTermFor(p.patient_code).toLowerCase();
          let invBest = null;
          if (term.length >= 2) {
            for (const f of inv.byToken.get(term) || []) {
              const n = D.normalizeFolderName(f.name);
              if (!codeRe.test(n)) continue;
              let score = (nameNorm.length > 1 && n.includes(nameNorm)) ? 80 : 50;
              if (sitsInBase(f.id)) score += 5;
              if (!invBest || score > invBest.score) invBest = { ...f, score };
            }
          }
          if (invBest) {
            suggestion = {
              id: invBest.id,
              name: invBest.name,
              in_base: sitsInBase(invBest.id),
            };
          }
        }

        // No base-child match: consult what earlier page-searches already
        // learned about this code. This is what makes the Missing badge
        // CONVERGE - without it, every discovery was forgotten between
        // requests and the count stayed wrong no matter how much had
        // actually been found.
        if (!suggestion && !fresh) {
          const v = cache.peek(verdictKey(p.patient_code));
          if (v && v !== 'none') {
            suggestion = {
              id: v.id,
              name: v.name,
              in_base: sitsInBase(v.id),
            };
          }
        }
      }

      // One state per row, in the order that decides what to DO about it.
      // An existing link outranks any suggestion: whatever else we might
      // have found, this patient already has a folder, and the only thing
      // left to decide is whether it sits in the base.
      let st;
      if (inBase) st = 'in_place';
      else if (p.drive_folder_id) st = 'elsewhere';
      else if (suggestion) st = 'suggestion';
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

    // The TRUE length of the candidate list, captured before anything below
    // adjusts the (approximate, best-effort) displayed total. has_more is
    // computed against this, never against a number that can drift as more
    // of the list gets checked.
    const trueFilteredLength = filtered.length;

    let page = filtered.slice(offset, offset + limit);
    let filteredTotal = filtered.length;
    let nextOffset = offset + page.length;

    // ── Reach beyond the base: search each unmatched code AS TEXT ──
    //
    // Only for 'missing': that is the one filter where a row can be found
    // and REMOVED from the page below, which is what makes a page come back
    // short or empty mid-list and is the only case that needs the walk.
    // With a COMPLETE inventory the pass above already matched every row
    // against every folder name in the Drive: nothing is left to search, no
    // row can upgrade mid-page, and the plain slice is exact. The walk
    // survives purely as the fallback for a Drive too large to enumerate
    // (inventory truncated at the cap) or an enumeration that failed.
    if (drive && status === 'missing' && !(inv && inv.complete)) {
      // Walk forward from `offset`, searching each candidate and keeping
      // only the ones still genuinely missing - TOPPING UP past the naive
      // [offset, offset+limit) window whenever some of that window's rows
      // turn out to already have a Drive folder. Without this, a page where
      // every row happened to be findable came back completely empty in the
      // middle of the list: "Nothing is missing" next to an enabled Next
      // button, and a total that said 201 remained.
      //
      // Bounded to a few times `limit` candidates, so one page load cannot
      // trigger an unbounded run of Drive searches against a clinic with
      // hundreds of Missing patients still to check.
      const MAX_CHECKS = limit * 4;
      let cursor = offset;
      let checked = 0;
      let upgraded = 0;
      const kept = [];

      while (kept.length < limit && cursor < filtered.length && checked < MAX_CHECKS) {
        const batch = filtered.slice(cursor, cursor + 5);
        cursor += batch.length;
        checked += batch.length;

        await Promise.all(batch.map(async (r) => {
          try {
            // A cached 'none' verdict means this code was already searched
            // across the whole Drive and found nothing - do not pay Google
            // for the same answer on every page load. (A cached MATCH never
            // reaches here: the bulk pass above already upgraded that row.)
            if (!fresh && cache.peek(verdictKey(r.patient_code)) === 'none') {
              return;
            }
            const term = searchTermFor(r.patient_code);
            if (term.length < 2) return;
            const hits = await D.listFolders(drive, { q: term, fresh });
            const codeRe = D.patientCodeRegExp(r.patient_code);
            if (!codeRe) return;
            const nameNorm = D.normalizeFolderName(r.full_name);
            let best = null;
            for (const f of hits) {
              const n = D.normalizeFolderName(f.name);
              if (!codeRe.test(n)) continue;
              let score = (nameNorm.length > 1 && n.includes(nameNorm)) ? 80 : 50;
              if (sitsInBase(f.id)) score += 5;
              if (!best || score > best.score) best = { ...f, score };
            }
            // Remember the answer either way. The negative verdict is the
            // one that saves money: genuinely-missing patients are the rows
            // that get looked at over and over.
            cache.put(verdictKey(r.patient_code), VERDICT_TTL_MS,
              best ? { id: best.id, name: best.name } : 'none');
            if (best) {
              r.suggestion = {
                id: best.id,
                name: best.name,
                in_base: sitsInBase(best.id),
              };
              r.status = 'suggestion';
            }
          } catch {
            // One failed search must not sink the page; the row simply stays
            // Missing until the next look - and no verdict is recorded, so
            // it will genuinely be retried.
          }
        }));

        for (const r of batch) {
          if (r.status === 'missing') kept.push(r);
          else upgraded++;
        }
      }

      page = kept;
      // Where the NEXT page must resume. Because the walk can consume more
      // than `limit` candidates topping this page up, "next = offset+limit"
      // would skip or duplicate rows - this is the one true cursor position.
      nextOffset = cursor;

      // The counts above come from the cheap pass; move only what THIS walk
      // actually confirmed. Total remains an approximation for whatever is
      // still unchecked further down the list - it can only ever go down as
      // more of the list gets looked at, never invent numbers for rows no
      // request has reached yet.
      if (upgraded > 0) {
        counts.missing = Math.max(0, counts.missing - upgraded);
        counts.suggestion += upgraded;
        filteredTotal = Math.max(0, filteredTotal - upgraded);
      }
    }

    res.json({
      patients: page,
      total: Math.max(0, filteredTotal),
      next_offset: nextOffset,
      has_more: nextOffset < trueFilteredLength,
      counts,
      base_folder_id: baseId,
      base_folder_path: basePath,
      drive_error: driveError,
      // True while the whole-Drive index is still being built. The rows are
      // usable now; the counts are the best this request could check, and
      // will be exact once the index lands.
      drive_indexing: indexing,
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

    const files = await D.walkPatientFiles(drive, { rootFolderId: root, fresh });

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

// POST /api/patients/:id/drive-folder/unlink   (admin)
//
// Detach the patient from its Drive folder. The folder itself is left
// completely alone - this clears the app's record of it, nothing more.
//
// The case this exists for: patients linked to folders that live on a Drive
// account the app no longer has access to. Every Drive call against those
// ids errors, so Move cannot fix them and the row is stuck reading
// 'Elsewhere' forever. Unlinking drops the dead reference so the matcher can
// find the folder that IS reachable and offer to link it.
//
// No Drive round-trip on purpose: asking Google about the folder first is
// exactly what fails for these rows.
router.post('/:id(\\d+)/drive-folder/unlink', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  try {
    const { rowCount } = await query(
      'UPDATE patients SET drive_folder_id=NULL, drive_folder_path=NULL WHERE id=$1',
      [id]);
    if (!rowCount) return res.status(404).json({ error: 'Patient not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[patients/drive-folder/unlink]', e.message);
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
