// Patient documents — X-rays, scans, reports, prescriptions, photos and the
// treatment records exported from the marking page.
//
// STORAGE MODEL — every document lives in two places:
//
//   1. backend/uploads/patient-docs/<filename>
//      Served statically at /uploads/patient-docs/<filename>, exactly like
//      body images and store photos. This is what both clients render: it is
//      fast, needs no Google round-trip, and keeps working when Drive is
//      disconnected or the network to Google is down.
//
//   2. Google Drive, under the folder chain configured in drive_settings.
//      This is the durable, shareable copy the clinic actually keeps.
//
// Only the LINKS live in Postgres. The Drive half is tracked by `sync_status`
// independently of the row: a document whose Drive push failed is still
// completely usable from the local copy and can be retried later. Losing an
// X-ray because Google timed out is not an acceptable outcome.
//
// Uploads are stored VERBATIM — no resize, no re-encode. A clinical image is
// evidence; the client sends full quality and we keep every byte of it.

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const crypto  = require('crypto');
const { query } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const D = require('../utils/drive');

const router = express.Router();

const DOCS_DIR = path.join(__dirname, '..', 'uploads', 'patient-docs');
if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });

const CATEGORIES = [
  'xray', 'scan', 'report', 'prescription', 'photo', 'body', 'treatment',
  'other',
];

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, DOCS_DIR),
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = String(file.originalname || 'file')
      .replace(/[^a-zA-Z0-9.\-_]/g, '_')
      .slice(-80);
    cb(null, `${ts}_${Math.random().toString(36).slice(2, 8)}_${safe}`);
  },
});

// 60 MB: a full-resolution X-ray or a multi-page PDF report comfortably fits,
// and the point of this feature is that the ORIGINAL is kept.
const upload = multer({ storage, limits: { fileSize: 60 * 1024 * 1024 } });

function cat(v) {
  const c = String(v || 'other').toLowerCase().trim();
  return CATEGORIES.includes(c) ? c : 'other';
}

function textOrNull(v, max = 500) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, max);
}

function dateOrToday(v, filename = '') {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = String(filename).match(/(\d{4})[-_.](\d{2})[-_.](\d{2})/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

// Accept tags as a JSON array or a comma/semicolon separated string -
// multipart form fields cannot carry an array, so the clients send text.
// Trimmed, de-duplicated case-insensitively, blanks dropped, capped.
function cleanTags(v) {
  if (v == null || v === '') return null;
  let list;
  if (Array.isArray(v)) {
    list = v;
  } else {
    const raw = String(v).trim();
    if (raw.startsWith('[')) {
      try { list = JSON.parse(raw); } catch { list = raw.split(/[,;]/); }
    } else {
      list = raw.split(/[,;]/);
    }
  }
  const seen = new Set();
  const out = [];
  for (const t of (Array.isArray(list) ? list : [])) {
    const clean = String(t == null ? '' : t).trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 20) break;
  }
  return out.length ? out : null;
}

function withUrls(row) {
  if (!row) return row;
  row.url = row.filename ? `/uploads/patient-docs/${row.filename}` : null;
  return row;
}

const SELECT_COLS = `
  d.id, d.patient_id, d.session_id, d.problem_id, d.category, d.title, d.notes,
  d.doc_date, d.filename, d.original_name, d.mime_type, d.size_bytes,
  d.drive_file_id, d.drive_view_link, d.drive_download_link, d.drive_path,
  d.sync_status, d.sync_error, d.uploaded_by_name, d.created_at,
  COALESCE(d.tags, ARRAY[]::TEXT[]) AS tags`;

// ─────────────────────────────────────────────────────────────
// Push one already-saved row's bytes to Drive.
//
// Never throws: a Drive failure is recorded on the row and reported to the
// caller, but it must not fail the upload — the file is already safe locally.
// ─────────────────────────────────────────────────────────────
async function pushToDrive(docId, adminId) {
  const { rows } = await query(
    `SELECT d.*, p.patient_code, p.full_name, p.drive_folder_id AS patient_folder_id
       FROM patient_documents d
       JOIN patients p ON p.id = d.patient_id
      WHERE d.id = $1`, [docId]);
  if (!rows.length) return { ok: false, error: 'Document not found' };
  const doc = rows[0];

  const abs = path.join(DOCS_DIR, doc.filename || '');
  if (!doc.filename || !fs.existsSync(abs)) {
    await query(
      `UPDATE patient_documents SET sync_status='failed', sync_error=$2 WHERE id=$1`,
      [docId, 'Local file missing']);
    return { ok: false, error: 'Local file missing' };
  }

  try {
    const settings = await D.getSettings();
    const drive = await D.getDriveForAdmin(adminId);
    // Prefer the folder created with the patient; falls back to resolving
    // the whole chain by name when there isn't one yet.
    let patientFolderId = doc.patient_folder_id;
    if (!patientFolderId) {
      const ensured = await D.ensurePatientFolderForId(doc.patient_id, adminId);
      patientFolderId = ensured && ensured.id;
    }
    const folder = await D.resolveDocumentFolder(drive, settings, {
      patientCode: doc.patient_code,
      patientName: doc.full_name,
      category: doc.category,
      docDate: doc.doc_date,
      patientFolderId,
    });

    // Name it so the file is identifiable straight from the Drive UI, even
    // detached from our database.
    const ext = path.extname(doc.original_name || doc.filename || '') || '';
    const stamp = new Date(doc.doc_date).toISOString().slice(0, 10);
    const label = (doc.title || doc.category || 'document')
      .replace(/[\\/:*?"<>|]/g, '-').slice(0, 60);
    const name = `${stamp}_${doc.patient_code}_${label}${ext}`;

    const uploaded = await D.uploadFile(drive, {
      name,
      mimeType: doc.mime_type || 'application/octet-stream',
      buffer: fs.readFileSync(abs),
      parentId: folder.id,
      makePublic: settings.make_links_public !== false,
    });

    // Erase the temporary local file now that it is safely stored on Drive
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch (e) {
      console.warn('[documents/pushToDrive] could not remove temp file:', e.message);
    }

    await query(
      `UPDATE patient_documents
          SET drive_file_id=$2, drive_view_link=$3, drive_download_link=$4,
              drive_folder_id=$5, drive_path=$6,
              filename=NULL,
              sync_status='synced', sync_error=NULL
        WHERE id=$1`,
      [docId, uploaded.id, uploaded.webViewLink || null,
       uploaded.webContentLink || null, folder.id, folder.path]);
    return { ok: true, file: uploaded, folder };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).slice(0, 400);
    await query(
      `UPDATE patient_documents SET sync_status='failed', sync_error=$2 WHERE id=$1`,
      [docId, msg]);
    return { ok: false, error: msg };
  }
}

// ─────────────────────────────────────────────────────────────
// POST /api/documents/intake   (NO Bearer auth — see below)
//
// One-shot filing for machine clients: file + who it belongs to + the
// credential, in a single multipart request.
//
// This exists because of what it replaced. The iOS Shortcut that files
// PostureScreen exports originally did the whole dance itself — refresh the
// token, search patients, loop the results into labels, show a picker, regex
// the id back out, upload — seventeen actions typed by hand into a phone,
// every one of them a chance to mistype a header. All of that except "which
// patient?" is logic, and logic belongs here, where it can be read and fixed
// without a phone in your hand. The shortcut is now four actions.
//
// Deliberately above router.use(authRequired()): the refresh token arrives as
// a form field rather than a header, because one less thing to configure in
// Shortcuts is one less thing to get wrong. It is still the same revocable
// credential from service_refresh_tokens, checked the same way, over HTTPS.
//
// The patient is named rather than picked. An exact patient_code wins
// outright; otherwise a search must land on exactly one row. Anything else
// comes back as a message naming the candidates, so the answer to an
// ambiguous query is the doctor typing a better one — never this endpoint
// guessing which patient a clinical document belongs to.
router.post('/intake', upload.single('file'), async (req, res) => {
  const b = req.body || {};
  const raw = String(b.token || '').trim();
  const q = String(b.q || '').trim();

  // multer has already written the upload to disk, so every failure below has
  // to sweep it up. This route is unauthenticated: without this, anyone who
  // can reach it can fill the disk with rejected uploads.
  const discard = () => {
    if (req.file) fs.unlink(req.file.path, () => {});
  };

  // Everything this route received, in one line, before anything is judged.
  //
  // The client is a form built by hand on a phone, so the usual question when
  // it misbehaves is "what did Shortcuts actually send?" — and the answer used
  // to be unobtainable without reading response byte counts. Field NAMES are
  // the tell: a `file` in this list rather than on req.file means the form
  // field was left on type Text, and a missing key means a typo in the
  // shortcut. The token is reported as present/absent and never printed; it is
  // a live credential and pm2 logs are not the place for it.
  const arrived = [
    `fields=[${Object.keys(b).join(',') || 'none'}]`,
    `token=${raw ? 'present' : 'MISSING'}`,
    `q=${q ? JSON.stringify(q) : 'MISSING'}`,
    req.file
      ? `file="${req.file.originalname}" ${req.file.size}b ${req.file.mimetype || 'no-mime'}`
      : 'file=MISSING',
  ].join(' ');
  console.log('[intake] <-', arrived);

  // Answered 200 with ok:false, NOT 4xx, and that is deliberate.
  //
  // The only client is an iOS Shortcut, and Shortcuts' "Get Contents of URL"
  // treats a non-2xx as a failure of the action itself: it stops the shortcut
  // and shows its own generic error, so the careful message below — the one
  // naming the three patients that matched — never reaches the doctor. A
  // patient not being found is a normal answer to a question, not a broken
  // request, so it comes back as one and the shortcut reads `ok`.
  //
  // 5xx is left alone: a crash has no useful message to show anyway.
  const fail = (message) => {
    console.log('[intake] -> REJECTED:', message);
    discard();
    return res.json({ ok: false, message });
  };

  if (!raw) return fail('Missing token.');
  if (!q) return fail('Say which patient — a code or a name.');
  // Two different mistakes produce "no file", and telling them apart saves a
  // long guessing session on a phone. A `file` that arrived as a TEXT field
  // means the Shortcuts form field was left on type Text — the file's name
  // came through as a string. No `file` at all usually means the shortcut was
  // run from the Play button inside the Shortcuts app, where there is no
  // share-sheet input to pass on.
  if (!req.file) {
    return fail(b.file
      ? 'The "file" field is set to Text. Change its type to File, value Shortcut Input.'
      : 'No file attached. Run this from a share sheet (not the Play button), and set the "file" field to type File with value Shortcut Input.');
  }

  try {
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    const { rows: trows } = await query(
      `SELECT id, subject_id, subject_role, subject_name, revoked_at
         FROM service_refresh_tokens WHERE token_hash = $1`, [tokenHash]);
    if (!trows.length || trows[0].revoked_at) {
      return fail('This token is not valid any more. Ask for a new one.');
    }
    const t = trows[0];

    if (t.subject_role === 'doctor') {
      const { rows: d } = await query(
        'SELECT is_active FROM doctors WHERE id=$1', [t.subject_id]);
      if (!d.length || !d[0].is_active) return fail('That account is disabled.');
    }

    // Exact code first. A doctor who types a full patient code means that
    // patient, even if the digits happen to appear inside somebody's phone
    // number or another code.
    const { rows: exact } = await query(
      `SELECT id, patient_code, full_name FROM patients
        WHERE LOWER(patient_code) = LOWER($1) AND deleted_at IS NULL
        LIMIT 2`, [q]);

    let matches = exact;
    if (!matches.length) {
      ({ rows: matches } = await query(
        `SELECT id, patient_code, full_name FROM patients
          WHERE (patient_code ILIKE $1 OR full_name ILIKE $1)
            AND deleted_at IS NULL
          ORDER BY full_name
          LIMIT 6`, [`%${q}%`]));
    }

    if (!matches.length) return fail(`No patient matches "${q}".`);
    if (matches.length > 1) {
      const names = matches
        .map((p) => `${p.patient_code} ${p.full_name}`)
        .join(', ');
      return fail(`"${q}" matches ${matches.length} patients: ${names}. Try the code.`);
    }
    const p = matches[0];

    const { rows } = await query(
      `INSERT INTO patient_documents
         (patient_id, category, title, doc_date, filename, original_name,
          mime_type, size_bytes, uploaded_by, uploaded_by_name, sync_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       RETURNING id`,
      [
        p.id,
        cat(b.category),
        textOrNull(req.file.originalname, 200),
        dateOrToday(b.doc_date, req.file.originalname),
        req.file.filename,
        textOrNull(req.file.originalname, 200),
        req.file.mimetype || null,
        req.file.size || null,
        t.subject_id,
        textOrNull(t.subject_name, 120),
      ]);

    // adminId is null: these tokens act as a doctor, and Drive pushes for a
    // doctor go through the clinic's own connection, same as any upload made
    // from the app by that doctor.
    const sync = await pushToDrive(rows[0].id, null);

    query(
      `UPDATE service_refresh_tokens
          SET last_used_at = NOW(), use_count = use_count + 1 WHERE id = $1`,
      [t.id],
    ).catch((e) => console.error('[documents/intake] usage update', e.message));

    console.log(
      `[intake] -> SAVED doc=${rows[0].id} patient=${p.patient_code} ` +
      `"${p.full_name}" as=${t.subject_name} token=#${t.id} ` +
      `drive=${sync.ok ? 'ok' : 'FAILED (' + sync.error + ')'}`);

    // A Drive failure is NOT an error here. The document is saved and visible
    // in the app; Drive retries from the document itself. Saying "failed" to
    // someone standing in a clinic would send them uploading it a second time.
    res.status(201).json({
      ok: true,
      message: sync.ok
        ? `Saved to ${p.patient_code} ${p.full_name}.`
        : `Saved to ${p.patient_code} ${p.full_name} — Drive sync pending, retry from the app.`,
      patient: { id: p.id, patient_code: p.patient_code, full_name: p.full_name },
      document_id: rows[0].id,
    });
  } catch (e) {
    console.error('[documents/intake]', e);
    if (/service_refresh_tokens/.test(e.message) && /does not exist/i.test(e.message)) {
      return fail('Server not set up: run node scripts/migrate.js 006');
    }
    return fail('Could not save. Try again.');
  }
});

router.use(authRequired());

// ─────────────────────────────────────────────────────────────
// GET /api/documents?patient_id=&category=&problem_id=&from=&to=&group=
//
// group=date returns the same rows bucketed by doc_date, newest day first —
// the "date wise" view. Anything else returns the flat list — the "all
// documents" view. Both clients offer the two side by side, so the server
// serves both shapes rather than making each client regroup.
// ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const pid = +req.query.patient_id;
  if (!pid) return res.status(400).json({ error: 'patient_id required' });

  const where = ['d.patient_id = $1', 'd.deleted_at IS NULL'];
  const vals = [pid];
  let n = 2;
  if (req.query.category) { where.push(`d.category = $${n++}`); vals.push(cat(req.query.category)); }
  if (req.query.problem_id) { where.push(`d.problem_id = $${n++}`); vals.push(+req.query.problem_id); }
  if (req.query.session_id) { where.push(`d.session_id = $${n++}`); vals.push(+req.query.session_id); }
  if (req.query.from) { where.push(`d.doc_date >= $${n++}`); vals.push(String(req.query.from)); }
  if (req.query.to) { where.push(`d.doc_date <= $${n++}`); vals.push(String(req.query.to)); }
  // ?tag=a&tag=b - every tag must be present (AND), which is what narrowing
  // a search means. Case-insensitive so "Pre-op" finds "pre-op".
  const tagFilter = cleanTags(
    Array.isArray(req.query.tag) ? req.query.tag : req.query.tag ? [req.query.tag] : null);
  if (tagFilter) {
    where.push(`(SELECT ARRAY(SELECT lower(x) FROM unnest(COALESCE(d.tags, ARRAY[]::TEXT[])) x)) @> $${n++}`);
    vals.push(tagFilter.map((t) => t.toLowerCase()));
  }
  // ?q= - substring over title, notes and the original filename.
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push(`(d.title ILIKE $${n} OR d.notes ILIKE $${n} OR d.original_name ILIKE $${n})`);
    vals.push('%' + q + '%');
    n++;
  }

  try {
    const { rows } = await query(
      `SELECT ${SELECT_COLS}
         FROM patient_documents d
        WHERE ${where.join(' AND ')}
        ORDER BY d.doc_date DESC, d.id DESC`,
      vals);
    let docs = rows.map(withUrls);

    // Best-effort: also surface files that exist ONLY in Drive - dropped in
    // directly, or predating document indexing - so this list matches what
    // the folder actually holds, not only what passed through the server.
    // The Documents page used to be the one screen left behind when the
    // Drive-merged view was built for the Photos tab; this is what closes
    // that gap, in one place, for every caller of this route.
    //
    // Wrapped so a Drive hiccup narrows the page rather than breaking it.
    try {
      const { rows: prows } = await query(
        'SELECT drive_folder_id FROM patients WHERE id=$1', [pid]);
      const rootId = prows[0] && prows[0].drive_folder_id;
      if (rootId) {
        const drive = await D.getDriveForAdmin(
          req.user.role === 'admin' ? req.user.id : null);
        const walked = await D.walkPatientFiles(drive, { rootFolderId: rootId });
        const known = new Set(docs.map((d) => d.drive_file_id).filter(Boolean));

        // Orphans have no problem/session/tag of their own to match against,
        // so those filters correctly exclude them rather than showing
        // something that does not actually belong to the filtered group.
        const skip = !!(req.query.problem_id || req.query.session_id || tagFilter);
        let nextId = -1;
        for (const f of walked) {
          if (skip || known.has(f.id)) continue;
          const guess = D.categoryFromFolderName(f.folder);
          if (req.query.category && cat(req.query.category) !== guess) continue;
          if (q && !String(f.name || '').toLowerCase().includes(q.toLowerCase())) continue;
          if (req.query.from && (!f.modified_at || f.modified_at < req.query.from)) continue;
          if (req.query.to && (!f.modified_at || f.modified_at > req.query.to)) continue;
          docs.push({
            // Negative and synthetic: never a real patient_documents row, and
            // the /:id(\d+) route param can never match a leading '-', so a
            // stray PATCH/DELETE against one 404s cleanly instead of ever
            // touching an unrelated real row.
            id: nextId--,
            patient_id: pid,
            session_id: null,
            problem_id: null,
            category: guess,
            title: null,
            notes: null,
            doc_date: f.modified_at || null,
            filename: null,
            original_name: f.name,
            mime_type: f.mime_type,
            size_bytes: f.size_bytes,
            drive_file_id: f.id,
            drive_view_link: f.web_view_link,
            drive_download_link: null,
            drive_path: null,
            sync_status: 'synced',
            sync_error: null,
            uploaded_by_name: null,
            created_at: f.modified_at,
            tags: [],
            url: null,
            drive_only: true,
            drive_thumbnail_link: f.thumbnail_link,
          });
        }

        // ── Documents whose Drive copy has been deleted ──────────────────
        //
        // Deleting a document is done in Drive, not in the app (the delete
        // buttons were removed on purpose — Drive is the archive of record).
        // For that to mean anything, a row pointing at a file that is no
        // longer there has to stop appearing here.
        //
        // Absence from `walked` is NOT sufficient evidence on its own.
        // walkPatientFiles goes exactly two levels — the patient folder and
        // its immediate subfolders — while resolveDocumentFolder files a
        // third level deep when date_subfolders is enabled. On such a setup
        // every document is invisible to the walk, and hiding on absence
        // alone would blank the entire page.
        //
        // So absence only makes a row a SUSPECT; each one is then confirmed
        // against Drive directly. Normally there are no suspects and this
        // costs nothing. A file that was merely moved, or that lives deeper
        // than the walk reaches, answers that it exists and stays.
        try {
          const seen = new Set(walked.map((f) => f.id));
          const suspects = docs.filter((d) =>
            !d.drive_only
            && d.drive_file_id
            && !seen.has(d.drive_file_id)
            // A row with a local copy is still openable, so it is not gone in
            // any sense the doctor cares about.
            && !d.filename
            // Never hide something still on its way TO Drive.
            && d.sync_status === 'synced');

          // A safety valve, not an optimisation. If a great many rows are
          // suddenly unaccounted for, the likely explanation is a changed
          // folder layout or a half-answered Drive call — not that somebody
          // deleted eighty X-rays. Verifying them one by one would also make
          // this request crawl. Hide nothing and say so.
          const MAX_VERIFY = 25;
          if (suspects.length > MAX_VERIFY) {
            console.warn(`[documents/list] ${suspects.length} rows missing from`
              + ` the Drive walk for patient ${pid} - too many to verify,`
              + ' showing all. Check the folder layout / date_subfolders.');
          } else if (suspects.length) {
            const gone = new Set();
            for (const d of suspects) {
              try {
                const { data } = await drive.files.get({
                  fileId: d.drive_file_id,
                  fields: 'id,trashed',
                  supportsAllDrives: true,
                });
                // Deleting in the Drive UI moves to the bin rather than
                // erasing, so `trashed` is the usual signal; a 404 below is
                // the permanent case.
                if (data && data.trashed) gone.add(d.drive_file_id);
              } catch (e) {
                const status = e && e.code;
                if (status === 404) gone.add(d.drive_file_id);
                // Anything else — a rate limit, a network blip — leaves the
                // document visible. Erring towards showing a record is the
                // only acceptable direction here.
              }
            }
            if (gone.size) {
              docs = docs.filter((d) => !gone.has(d.drive_file_id) || d.drive_only);
              console.log(`[documents/list] hid ${gone.size} document(s)`
                + ` deleted from Drive for patient ${pid}`);
            }
          }
        } catch (e) {
          console.warn('[documents/list] deleted-file check skipped:', e.message);
        }

        docs.sort((a, b) =>
          String(b.doc_date || '').localeCompare(String(a.doc_date || '')));
      }
    } catch (e) {
      console.warn('[documents/list] drive merge skipped:', e.message);
    }

    if (String(req.query.group || '') === 'date') {
      const buckets = [];
      const index = new Map();
      for (const doc of docs) {
        // A missing or unparseable date must not throw (new Date(undefined)
        // .toISOString() raises, taking the whole documents list with it) and
        // must not silently claim 1970, which is what new Date(null) returns.
        // Drive files carry whatever modifiedTime Google gave us, which is
        // not guaranteed to be there at all.
        const at = doc.doc_date ? new Date(doc.doc_date) : null;
        const key = at && !Number.isNaN(at.getTime())
          ? at.toISOString().slice(0, 10)
          : 'Undated';
        if (!index.has(key)) {
          index.set(key, { date: key, documents: [] });
          buckets.push(index.get(key));
        }
        index.get(key).documents.push(doc);
      }
      return res.json({ groups: buckets, total: docs.length });
    }
    res.json({ documents: docs, total: docs.length });
  } catch (e) {
    console.error('[documents/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// GET /api/documents/tags?patient_id= - tags already in use, most used
// first. Feeds the filter row and the upload dialog's suggestions, so people
// reuse existing labels instead of inventing a new spelling every time.
router.get('/tags', async (req, res) => {
  const pid = +req.query.patient_id;
  try {
    const { rows } = await query(
      `SELECT t AS tag, COUNT(*)::int AS n
         FROM patient_documents d, unnest(d.tags) t
        WHERE d.deleted_at IS NULL ${pid ? 'AND d.patient_id = $1' : ''}
        GROUP BY t
        ORDER BY n DESC, t ASC
        LIMIT 100`,
      pid ? [pid] : []);
    res.json(rows);
  } catch (e) {
    console.error('[documents/tags]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// GET /api/documents/categories — the vocabulary, so clients don't hardcode it
router.get('/categories', (_req, res) => {
  res.json(CATEGORIES.map((c) => ({ id: c, label: D.categoryFolderName(c) })));
});

// ─────────────────────────────────────────────────────────────
// POST /api/documents  (multipart: file + fields)
//
// The response comes back as soon as the LOCAL copy is written and the row
// exists — the Drive push runs inside the request but its failure only marks
// the row, never rejects the upload. The client shows the row immediately
// with whatever sync_status came back.
// ─────────────────────────────────────────────────────────────
router.post('/', upload.single('file'), async (req, res) => {
  const b = req.body || {};
  const pid = +b.patient_id;
  if (!pid) return res.status(400).json({ error: 'patient_id required' });
  if (!req.file) return res.status(400).json({ error: 'file required' });

  try {
    const { rows: pr } = await query(
      'SELECT id FROM patients WHERE id=$1 AND deleted_at IS NULL', [pid]);
    if (!pr.length) return res.status(404).json({ error: 'Patient not found' });

    const { rows } = await query(
      `INSERT INTO patient_documents
         (patient_id, session_id, problem_id, category, title, notes, doc_date,
          filename, original_name, mime_type, size_bytes,
          uploaded_by, uploaded_by_name, tags, sync_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
       RETURNING id`,
      [
        pid,
        b.session_id ? +b.session_id : null,
        b.problem_id ? +b.problem_id : null,
        cat(b.category),
        textOrNull(b.title, 200),
        textOrNull(b.notes, 2000),
        dateOrToday(b.doc_date, req.file.originalname),
        req.file.filename,
        textOrNull(req.file.originalname, 200),
        req.file.mimetype || null,
        req.file.size || null,
        req.user.id || null,
        textOrNull(req.user.username, 120),
        cleanTags(b.tags),
      ]);

    const id = rows[0].id;
    const sync = await pushToDrive(id, req.user.role === 'admin' ? req.user.id : null);

    const { rows: out } = await query(
      `SELECT ${SELECT_COLS} FROM patient_documents d WHERE d.id=$1`, [id]);
    res.status(201).json({
      document: withUrls(out[0]),
      drive: sync.ok ? { ok: true } : { ok: false, error: sync.error },
    });
  } catch (e) {
    console.error('[documents/create]', e);
    res.status(500).json({ error: e.message || 'Upload failed' });
  }
});

// PATCH /api/documents/:id — edit the metadata (never the bytes)
router.patch('/:id(\\d+)', async (req, res) => {
  const id = +req.params.id;
  const b = req.body || {};
  const sets = [];
  const vals = [id];
  let n = 2;
  if ('category' in b)   { sets.push(`category = $${n++}`);   vals.push(cat(b.category)); }
  if ('title' in b)      { sets.push(`title = $${n++}`);      vals.push(textOrNull(b.title, 200)); }
  if ('notes' in b)      { sets.push(`notes = $${n++}`);      vals.push(textOrNull(b.notes, 2000)); }
  if ('doc_date' in b)   { sets.push(`doc_date = $${n++}`);   vals.push(dateOrToday(b.doc_date)); }
  if ('problem_id' in b) { sets.push(`problem_id = $${n++}`); vals.push(b.problem_id ? +b.problem_id : null); }
  if ('tags' in b)       { sets.push(`tags = $${n++}`);       vals.push(cleanTags(b.tags)); }
  if (!sets.length) return res.json({ ok: true });

  try {
    const { rows } = await query(
      `UPDATE patient_documents SET ${sets.join(', ')}
        WHERE id=$1 AND deleted_at IS NULL RETURNING id`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { rows: out } = await query(
      `SELECT ${SELECT_COLS} FROM patient_documents d WHERE d.id=$1`, [id]);
    res.json(withUrls(out[0]));
  } catch (e) {
    console.error('[documents/patch]', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

// POST /api/documents/:id/drive-retry — re-attempt a failed Drive push
router.post('/:id(\\d+)/drive-retry', async (req, res) => {
  try {
    const r = await pushToDrive(+req.params.id,
      req.user.role === 'admin' ? req.user.id : null);
    const { rows } = await query(
      `SELECT ${SELECT_COLS} FROM patient_documents d WHERE d.id=$1`, [+req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ document: withUrls(rows[0]), drive: r });
  } catch (e) {
    // This endpoint exists precisely because Drive is unreliable, so it is
    // the last place that should fall over when Drive is unreliable.
    const err = D.classifyDriveError(e);
    console.error('[documents/drive-retry]', err.message);
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// GET /api/documents/:id/content   — the file itself
//
// Serves our own copy when there is one. When there is not - treatment records
// saved before the local copy was restored, for instance - it pulls the file
// back down from Drive, KEEPS it, and serves that. So a document only ever
// costs one Drive download no matter how often it is viewed, and after the
// first view it behaves exactly like any other document.
//
// This is what lets the in-app viewer render a PDF that only ever lived in
// Google Drive, instead of showing "only on Google Drive" and sending the
// doctor out to a browser tab.
router.get('/:id(\\d+)/content', async (req, res) => {
  const id = +req.params.id;
  try {
    const { rows } = await query(
      `SELECT id, patient_id, filename, original_name, mime_type, drive_file_id
         FROM patient_documents WHERE id=$1 AND deleted_at IS NULL`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const d = rows[0];

    const sendLocal = (name) => {
      const abs = path.join(DOCS_DIR, name);
      if (!fs.existsSync(abs)) return false;
      if (d.mime_type) res.type(d.mime_type);
      // Immutable: the filename changes whenever the content does.
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.sendFile(abs);
      return true;
    };

    if (d.filename && sendLocal(d.filename)) return;

    if (!d.drive_file_id) {
      return res.status(404).json({
        error: 'This document has no stored file.',
        code: 'no_content',
      });
    }

    // Not on disk: fetch directly from Drive and stream to client
    const drive = await D.getDriveForAdmin(
      req.user && req.user.role === 'admin' ? req.user.id : null);
    const dl = await drive.files.get(
      { fileId: d.drive_file_id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' });
    const buf = Buffer.from(dl.data);

    if (d.mime_type) res.type(d.mime_type);
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (e) {
    const err = D.classifyDriveError(e);
    console.error('[documents/content]', err.message);
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// GET /api/documents/drive/:fileId/content   — bytes of a Drive-only file
//
// The merged list surfaces files that exist ONLY in Drive - no
// patient_documents row, no local copy, nothing /:id/content could stream.
// Without this, the app could show their name and Drive's thumbnail but had
// to hand the doctor off to a browser tab to actually LOOK at one, which is
// exactly the context switch the in-app viewer exists to avoid.
//
// Drive file ids are URL-safe ([A-Za-z0-9_-]), which is what the route
// pattern admits. Auth comes from the router-level authRequired() above -
// same bar as every other document byte in this file.
//
// Deliberately a pure stream, no local backfill: these files have no
// document row to hang a filename on, and inventing one as a side effect of
// LOOKING at a file is how ghost records get made. Adopting a Drive file
// into the index should be its own explicit action, not a byproduct.
router.get('/drive/:fileId([A-Za-z0-9_-]+)/content', async (req, res) => {
  const fileId = req.params.fileId;
  try {
    const drive = await D.getDriveForAdmin(
      req.user.role === 'admin' ? req.user.id : null);

    // STREAMED, not buffered. This used to read the whole file into memory
    // with responseType 'arraybuffer'; a document grid that fell back to
    // full-size originals could then hold seventy multi-megabyte photos in
    // RAM at once and trip pm2's 400MB max_memory_restart, killing every
    // other request in flight. Piping keeps memory flat no matter how many
    // files are being read.
    const dl = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' });

    // The caller already knows the mime from the merged listing; trusting
    // that hint costs nothing and saves a metadata round-trip to Google.
    const mime = String(req.query.mime || '').trim();
    if (/^[a-z]+\/[a-z0-9.+-]+$/i.test(mime)) res.type(mime);

    // A Drive file's content at the same id is stable enough for an hour;
    // re-streaming megabytes from Google on every carousel arrow-press is
    // not a good use of anyone's quota.
    res.setHeader('Cache-Control', 'private, max-age=3600');

    await new Promise((resolve, reject) => {
      dl.data.on('error', reject);
      res.on('close', resolve);
      dl.data.pipe(res).on('finish', resolve);
    });
  } catch (e) {
    const err = D.classifyDriveError(e);
    console.error('[documents/drive-content]', err.message);
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// GET /api/documents/drive/:fileId/thumb   — Drive's own thumbnail, proxied
//
// Drive generates a small preview image for most files (including PDFs) and
// hands out its URL as thumbnailLink - but that URL lives on
// googleusercontent.com, which sends no CORS headers. A desktop app can load
// it; the flutter WEB build cannot (CanvasKit fetches images with fetch(),
// and the browser blocks the cross-origin response). That asymmetry is why
// the grid showed glyphs while clicking through to the carousel - which
// streams full bytes through /content above - worked fine.
//
// So: resolve the link server-side (Node has no CORS), download the small
// image here, and re-serve it from our own origin behind the same auth as
// every other document byte. The thumbnail is ~a few KB versus the full
// file's megabytes, which is the whole point of using it for grid tiles.
router.get('/drive/:fileId([A-Za-z0-9_-]+)/thumb', async (req, res) => {
  const fileId = req.params.fileId;
  try {
    const drive = await D.getDriveForAdmin(
      req.user.role === 'admin' ? req.user.id : null);
    const meta = await drive.files.get({
      fileId,
      fields: 'thumbnailLink,mimeType',
      supportsAllDrives: true,
    });
    const link = meta.data.thumbnailLink;
    if (!link) {
      // Drive hasn't generated a preview (rare: brand-new upload, or an
      // unsupported type). The client falls back to its own renderer.
      return res.status(404).json({ error: 'No thumbnail', code: 'no_thumbnail' });
    }

    // Fetch it WITH the access token. thumbnailLink points at
    // googleusercontent.com, which is not a public CDN: without the bearer
    // token Google returns 403, which is indistinguishable from "this file
    // has no thumbnail" unless you know to look. Getting this wrong is what
    // made every tile fall through to downloading the full original.
    const token = await D.accessTokenFor(drive);
    let r = await fetch(link, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    // A minority of links (older files, some shared drives) are plain public
    // URLs that 401 when handed a token they did not ask for.
    if (!r.ok && token) r = await fetch(link);
    if (!r.ok) {
      console.warn('[documents/drive-thumb]', fileId, 'thumbnail fetch', r.status);
      return res.status(404).json({ error: 'Thumbnail unavailable', code: 'no_thumbnail' });
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.type(r.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buf);
  } catch (e) {
    const err = D.classifyDriveError(e);
    console.error('[documents/drive-thumb]', err.message);
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// DELETE /api/documents/:id — soft delete by default.
//
// The Drive copy is deliberately LEFT ALONE unless ?drive=1 is passed: Drive
// is the clinic's archive of record, and a mis-click in the app should not
// reach into it. `purge=1` (admin) removes the local file and the row too.
router.delete('/:id(\\d+)', async (req, res) => {
  const id = +req.params.id;
  const purge = String(req.query.purge || '') === '1' && req.user.role === 'admin';
  const alsoDrive = String(req.query.drive || '') === '1';

  try {
    const { rows } = await query(
      'SELECT * FROM patient_documents WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const doc = rows[0];

    // ── DRIVE DELETION DISABLED BY OWNER REQUEST (2026-09-03) ────────────
    //
    // This was the ONLY place in the entire system that could delete anything
    // from Google Drive (audited: no bulk path exists; Move re-parents, it
    // never removes). Drive is the clinic's archive of record, and with the
    // folder-migration tooling now linking hundreds of real patient folders,
    // the owner asked for zero deletion capability toward Drive - a Drive
    // copy is now removable only by hand, in Drive itself.
    //
    // Deleting a document in the app still soft-deletes (or purges) the LOCAL
    // record exactly as before; only the reach into Drive is severed.
    //
    // if (alsoDrive && doc.drive_file_id) {
    //   try {
    //     const drive = await D.getDriveForAdmin(
    //       req.user.role === 'admin' ? req.user.id : null);
    //     await drive.files.delete({ fileId: doc.drive_file_id });
    //   } catch (e) {
    //     console.warn('[documents/delete] drive delete failed:', e.message);
    //   }
    // }
    if (alsoDrive) {
      console.warn(
        '[documents/delete] drive=1 requested for doc ' + id
        + ' but Drive deletion is disabled - Drive copy left untouched');
    }

    if (purge) {
      if (doc.filename) {
        try { fs.unlinkSync(path.join(DOCS_DIR, doc.filename)); } catch {}
      }
      await query('DELETE FROM patient_documents WHERE id=$1', [id]);
    } else {
      await query(
        'UPDATE patient_documents SET deleted_at = NOW() WHERE id=$1', [id]);
    }
    res.json({ ok: true, purged: purge });
  } catch (e) {
    console.error('[documents/delete]', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});


// ─────────────────────────────────────────────────────────────
// Bundling a selection of documents into one PDF — as a BACKGROUND JOB.
//
// WHY IT IS A JOB AND NOT A REPLY
// The obvious shape is "POST the ids, get the PDF back". It does not survive
// contact with the real data. Forty documents means forty Drive downloads,
// and every HEIC among them is decoded in pure JavaScript. That is minutes,
// not seconds, against a server that cuts non-multipart requests off at
// REQUEST_TIMEOUT_MS (60s by default). The doctor would watch a spinner and
// then be told the request timed out, while the server carried on building a
// PDF nobody would ever receive.
//
// So the POST starts the work and returns an id immediately. The client polls
// for progress and fetches the file when it is ready. Nothing waits on a
// socket that a proxy, a phone changing networks, or the timeout above can
// close underneath it.
//
// WHY THE RESULT GOES TO DISK
// pm2 restarts this process at 400MB (see ecosystem.config.cjs). Holding
// finished PDFs in memory until someone downloads them is exactly how that
// limit gets hit — and a restart mid-download loses the file anyway. The
// bytes land in a temp directory; the registry below holds only status.
//
// Jobs are in memory, which is correct here specifically because pm2 runs
// this as a single fork process. Under cluster mode the poll could reach a
// worker that never saw the job, and this would need Postgres or Redis.
// ─────────────────────────────────────────────────────────────

// Deliberately modest. Each file is held in memory while it is embedded, and
// a doctor selecting an entire history would otherwise ask the server to hold
// a few hundred megabytes to answer one request.
// Loaded at boot rather than on first use: parsing it costs ~400ms, and
// that is time the first doctor to press Download should not pay.
// heic-convert is deliberately NOT preloaded - 1.3s and a WASM heap for
// something most selections never contain.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const PDF_MAX_DOCS = 40;

const PDF_JOBS_DIR = path.join(__dirname, '..', 'uploads', 'pdf-jobs');
if (!fs.existsSync(PDF_JOBS_DIR)) fs.mkdirSync(PDF_JOBS_DIR, { recursive: true });

/// How long a finished PDF is kept. Long enough for a slow phone on clinic
/// wifi to come back for it, short enough that the disk does not accumulate
/// copies of every selection anyone ever made.
const PDF_JOB_TTL_MS = 30 * 60 * 1000;

/// One at a time. Two doctors each bundling thirty X-rays in parallel is the
/// straightest path to the 400MB restart; queueing costs them a wait and
/// costs everyone else nothing.
let pdfBuilding = false;
const pdfQueue = [];

const pdfJobs = new Map();

const A4 = { w: 595.28, h: 841.89 };
const PAGE_MARGIN = 24;
const CAPTION_H = 16;

/// Sniff the real type from the bytes, not from the stored mime_type.
///
/// mime_type is whatever the uploading client claimed, and uploads that
/// arrived as application/octet-stream are common enough here that trusting
/// it would drop good images out of the PDF for no reason.
function sniffType(buf) {
  if (buf.length < 12) return 'unknown';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.slice(0, 4).toString('latin1') === '%PDF') return 'pdf';
  // ISO-BMFF: 4 bytes of size, then 'ftyp', then a brand. HEIC and the HEVC
  // sequence brands an iPhone writes all live here.
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('latin1');
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return 'unknown';
}

/// The document's bytes: from disk when there is a local copy, from Drive
/// otherwise — the same order of preference /:id/content uses.
async function documentBytes(doc, adminId) {
  if (doc.filename) {
    const abs = path.join(DOCS_DIR, doc.filename);
    if (fs.existsSync(abs)) return fs.readFileSync(abs);
  }
  if (!doc.drive_file_id) return null;
  const drive = await D.getDriveForAdmin(adminId);
  const dl = await drive.files.get(
    { fileId: doc.drive_file_id, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' });
  return Buffer.from(dl.data);
}

function pdfJobCleanup() {
  const now = Date.now();
  for (const [id, job] of pdfJobs) {
    if (now - job.createdAt < PDF_JOB_TTL_MS) continue;
    if (job.path) {
      try { fs.unlinkSync(job.path); } catch (_) { /* already gone */ }
    }
    pdfJobs.delete(id);
  }

  // Then the directory itself, not just what the registry remembers.
  //
  // The registry is in memory and pm2 restarts this process on its own
  // (autorestart, and max_memory_restart at 400M). Every restart empties the
  // map while the files stay on disk — and a sweep that only walks the map
  // would never look at them again. Left alone that is an unbounded pile of
  // patient documents on the server's disk.
  try {
    for (const name of fs.readdirSync(PDF_JOBS_DIR)) {
      if (!name.endsWith('.pdf')) continue;
      const abs = path.join(PDF_JOBS_DIR, name);
      try {
        if (now - fs.statSync(abs).mtimeMs > PDF_JOB_TTL_MS) fs.unlinkSync(abs);
      } catch (_) { /* vanished under us, or in use - next pass */ }
    }
  } catch (e) {
    console.warn('[documents/pdf] could not sweep job dir:', e.message);
  }
}

// Once at boot as well as on the timer: anything already in there belongs to
// a process that is gone, since jobs never survive a restart. Waiting five
// minutes to clear it would keep the previous life's files around for no
// reason.
pdfJobCleanup();
// unref so a quiet server can still exit; this must never be the reason the
// process stays alive.
setInterval(pdfJobCleanup, 5 * 60 * 1000).unref();

/// Build one job to completion. Never throws: the outcome is recorded on the
/// job, because nobody is waiting on this promise.
async function runPdfJob(job) {
  try {
    const { rows } = await query(
      `SELECT id, patient_id, filename, original_name, title, mime_type,
              doc_date, category, drive_file_id
         FROM patient_documents
        WHERE id = ANY($1::int[]) AND deleted_at IS NULL`, [job.ids]);
    if (!rows.length) throw new Error('No documents found');

    // Honour the order the doctor selected them in, not whatever order
    // Postgres returned — a report assembled in a surprising order is one
    // somebody has to redo by hand.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const docs = job.ids.map((id) => byId.get(id)).filter(Boolean);
    job.total = docs.length;

    const out = await PDFDocument.create();
    const font = await out.embedFont(StandardFonts.Helvetica);

    for (const doc of docs) {
      const label = doc.title || doc.original_name || ('Document ' + doc.id);
      let buf;
      try {
        buf = await documentBytes(doc, job.adminId);
      } catch (e) {
        console.warn('[documents/pdf] could not read', doc.id, e.message);
        job.skipped++;
        job.done++;
        continue;
      }
      if (!buf || !buf.length) { job.skipped++; job.done++; continue; }

      let kind = sniffType(buf);

      if (kind === 'heic') {
        try {
          const convert = require('heic-convert');
          buf = Buffer.from(await convert({ buffer: buf, format: 'JPEG', quality: 0.92 }));
          kind = 'jpeg';
        } catch (e) {
          console.warn('[documents/pdf] HEIC convert failed', doc.id, e.message);
          job.skipped++;
          job.done++;
          continue;
        }
      }

      if (kind === 'pdf') {
        // Copy the pages as they are. Rasterising them would throw away the
        // text layer of a report that had one.
        try {
          const src = await PDFDocument.load(buf, { ignoreEncryption: true });
          const pages = await out.copyPages(src, src.getPageIndices());
          pages.forEach((pg) => out.addPage(pg));
        } catch (e) {
          console.warn('[documents/pdf] could not merge PDF', doc.id, e.message);
          job.skipped++;
        }
        job.done++;
        continue;
      }

      if (kind !== 'jpeg' && kind !== 'png') { job.skipped++; job.done++; continue; }

      try {
        const img = kind === 'jpeg' ? await out.embedJpg(buf) : await out.embedPng(buf);
        const page = out.addPage([A4.w, A4.h]);

        // Fit inside the margins, keeping aspect. Never scaled UP: blowing a
        // small photo up to page width makes it look worse, not bigger.
        const maxW = A4.w - PAGE_MARGIN * 2;
        const maxH = A4.h - PAGE_MARGIN * 2 - CAPTION_H;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * scale;
        const h = img.height * scale;

        page.drawImage(img, {
          x: (A4.w - w) / 2,
          y: PAGE_MARGIN + CAPTION_H + (maxH - h) / 2,
          width: w,
          height: h,
        });

        // A page of a clinical PDF with nothing identifying it is a page
        // somebody will later have to guess about.
        const date = doc.doc_date ? String(doc.doc_date).slice(0, 10) : '';
        const caption = [date, label].filter(Boolean).join('  -  ').slice(0, 120);
        page.drawText(caption, {
          x: PAGE_MARGIN,
          y: PAGE_MARGIN,
          size: 8,
          font,
          color: rgb(0.35, 0.35, 0.35),
        });
      } catch (e) {
        console.warn('[documents/pdf] could not embed', doc.id, e.message);
        job.skipped++;
      }
      job.done++;
    }

    if (out.getPageCount() === 0) {
      throw new Error('None of the selected files could be put into a PDF.');
    }

    const bytes = Buffer.from(await out.save());
    const abs = path.join(PDF_JOBS_DIR, job.id + '.pdf');
    fs.writeFileSync(abs, bytes);
    job.path = abs;
    job.pages = out.getPageCount();
    job.bytes = bytes.length;
    job.status = 'ready';
    console.log(`[documents/pdf] job ${job.id} ready: ${job.pages} pages from `
      + `${job.total} docs, skipped ${job.skipped}, ${(bytes.length / 1024).toFixed(0)}KB`);
  } catch (e) {
    job.status = 'failed';
    job.error = e.message || 'Could not build the PDF.';
    console.error('[documents/pdf] job', job.id, 'failed:', e.message);
  }
}

function pumpPdfQueue() {
  if (pdfBuilding) return;
  const job = pdfQueue.shift();
  if (!job) return;
  pdfBuilding = true;
  job.status = 'working';
  runPdfJob(job).finally(() => {
    pdfBuilding = false;
    pumpPdfQueue();
  });
}

/// Only the person who asked for it may see it. These bundles are patient
/// records; a job id guessed or shared must not be a way around that.
function ownsJob(req, job) {
  return job && job.userId === (req.user && req.user.id)
    && job.userRole === (req.user && req.user.role);
}

// POST /api/documents/pdf   { ids: [...] }  ->  202 { job_id }
router.post('/pdf', async (req, res) => {
  const rawIds = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  const ids = [...new Set(rawIds.map(Number).filter(Number.isInteger))];
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  if (ids.length > PDF_MAX_DOCS) {
    return res.status(400).json({
      error: 'Too many documents at once - select ' + PDF_MAX_DOCS + ' or fewer.',
    });
  }

  const job = {
    id: crypto.randomBytes(9).toString('hex'),
    ids,
    userId: req.user && req.user.id,
    userRole: req.user && req.user.role,
    adminId: req.user && req.user.role === 'admin' ? req.user.id : null,
    status: 'queued',
    done: 0,
    total: ids.length,
    skipped: 0,
    pages: 0,
    bytes: 0,
    path: null,
    error: null,
    createdAt: Date.now(),
  };
  pdfJobs.set(job.id, job);
  pdfQueue.push(job);
  // setImmediate, not a direct call: the reply below is written first, and
  // only then does anything start. A direct call would run the new job up to
  // its first await INSIDE this request - which is exactly the waiting this
  // endpoint exists to avoid.
  setImmediate(pumpPdfQueue);

  console.log(`[documents/pdf] job ${job.id} queued: ${ids.length} docs`);
  res.status(202).json({ job_id: job.id, total: job.total });
});

// GET /api/documents/pdf/:jobId  -> progress, or where to fetch it
router.get('/pdf/:jobId([a-f0-9]{18})', async (req, res) => {
  const job = pdfJobs.get(req.params.jobId);
  if (!job) {
    // Expired and deleted, or a restart lost it. Either way the client should
    // start again rather than poll forever.
    return res.status(404).json({ error: 'This bundle has expired. Try again.' });
  }
  if (!ownsJob(req, job)) return res.status(403).json({ error: 'Forbidden' });
  res.json({
    status: job.status,
    done: job.done,
    total: job.total,
    skipped: job.skipped,
    pages: job.pages,
    bytes: job.bytes,
    error: job.error,
  });
});

// GET /api/documents/pdf/:jobId/file  -> the PDF itself
router.get('/pdf/:jobId([a-f0-9]{18})/file', async (req, res) => {
  const job = pdfJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'This bundle has expired. Try again.' });
  if (!ownsJob(req, job)) return res.status(403).json({ error: 'Forbidden' });
  if (job.status !== 'ready' || !job.path || !fs.existsSync(job.path)) {
    return res.status(409).json({ error: 'Not ready yet.', status: job.status });
  }

  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
    .format(new Date());
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    'attachment; filename="documents_' + stamp + '.pdf"');
  res.setHeader('X-Skipped-Count', String(job.skipped));
  res.setHeader('Access-Control-Expose-Headers', 'X-Skipped-Count, Content-Disposition');
  // Kept, not deleted on send: a download that drops halfway on clinic wifi
  // should be retryable. The TTL sweep clears it.
  res.sendFile(job.path);
});

module.exports = router;
module.exports.pushToDrive = pushToDrive;
module.exports.DOCS_DIR = DOCS_DIR;
module.exports.CATEGORIES = CATEGORIES;
