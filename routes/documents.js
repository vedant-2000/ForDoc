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

function dateOrToday(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10);
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

    await query(
      `UPDATE patient_documents
          SET drive_file_id=$2, drive_view_link=$3, drive_download_link=$4,
              drive_folder_id=$5, drive_path=$6,
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
    const docs = rows.map(withUrls);

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
        const key = new Date(doc.doc_date).toISOString().slice(0, 10);
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
        dateOrToday(b.doc_date),
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

    // Not on disk: fetch from Drive once, then keep it.
    const drive = await D.getDriveForAdmin(
      req.user && req.user.role === 'admin' ? req.user.id : null);
    const dl = await drive.files.get(
      { fileId: d.drive_file_id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' });
    const buf = Buffer.from(dl.data);

    let name = d.filename;
    try {
      if (!name) {
        const safe = String(d.original_name || `document-${id}`)
          .replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-80);
        name = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`;
      }
      fs.writeFileSync(path.join(DOCS_DIR, name), buf);
      await query(
        'UPDATE patient_documents SET filename=$2, size_bytes=COALESCE(size_bytes,$3) WHERE id=$1',
        [id, name, buf.length]);
    } catch (e) {
      // Caching is a bonus; serving the bytes is the job.
      console.warn('[documents/content] could not cache locally:', e.message);
    }

    if (d.mime_type) res.type(d.mime_type);
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

module.exports = router;
module.exports.pushToDrive = pushToDrive;
module.exports.DOCS_DIR = DOCS_DIR;
module.exports.CATEGORIES = CATEGORIES;
