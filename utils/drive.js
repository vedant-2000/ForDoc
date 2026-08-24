const { google } = require('googleapis');
const { query } = require('../db/pool');
const { Readable } = require('stream');

// Full Drive scope, NOT drive.file.
//
// drive.file only exposes files this app itself created, so with it the
// folder browser would show an empty Drive and writing into a folder the
// clinic already uses would be rejected. Picking an existing folder out of a
// Drive that already follows the clinic's own filing pattern is the whole
// point of the folder picker, and that needs the broad scope.
//
// Consequence worth knowing: an account connected under the older narrow
// scope must reconnect once. `hasFullScope()` detects that so the UI can say
// so instead of failing with a bare 403.
const SCOPES = ['https://www.googleapis.com/auth/drive'];

const FULL_SCOPE = 'https://www.googleapis.com/auth/drive';

/// True when the stored credentials carry the broad Drive scope, i.e. the
/// folder browser will work. False for a connection made before the scope
/// was widened.
async function hasFullScope(adminId) {
  const creds = await loadCredentialsForAdmin(adminId).catch(() => null);
  const scope = (creds && creds.scope) || '';
  if (scope) return scope.split(/\s+/).includes(FULL_SCOPE);
  // No scope recorded (older token rows) - assume narrow, so the UI prompts
  // for a reconnect rather than silently failing later.
  return false;
}

function getOAuth2Client() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('Google OAuth env vars missing (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

async function loadCredentialsForAdmin(adminId) {
  const { rows } = await query('SELECT * FROM drive_tokens WHERE admin_id=$1', [adminId]);
  if (!rows.length) return null;
  const t = rows[0];
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    scope: t.scope,
    token_type: t.token_type,
    expiry_date: t.expiry_date ? Number(t.expiry_date) : null,
  };
}

async function saveCredentialsForAdmin(adminId, creds) {
  await query(
    `INSERT INTO drive_tokens (admin_id, access_token, refresh_token, scope, token_type, expiry_date, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (admin_id) DO UPDATE
        SET access_token = EXCLUDED.access_token,
            refresh_token = COALESCE(EXCLUDED.refresh_token, drive_tokens.refresh_token),
            scope = EXCLUDED.scope,
            token_type = EXCLUDED.token_type,
            expiry_date = EXCLUDED.expiry_date,
            updated_at = NOW()`,
    [adminId, creds.access_token, creds.refresh_token || null, creds.scope || null,
     creds.token_type || null, creds.expiry_date || null]
  );
}

// Get an authorized drive client. Falls back to first admin in DB if no adminId.
async function getDriveForAdmin(adminId) {
  let creds = await loadCredentialsForAdmin(adminId);
  if (!creds) {
    const { rows } = await query('SELECT admin_id FROM drive_tokens LIMIT 1');
    if (rows.length) creds = await loadCredentialsForAdmin(rows[0].admin_id);
  }
  if (!creds) throw new Error('Google Drive not connected. Ask admin to connect.');
  const oAuth = getOAuth2Client();
  oAuth.setCredentials(creds);
  oAuth.on('tokens', (newTok) => {
    // persist refreshed access tokens
    const merged = Object.assign({}, creds, newTok);
    saveCredentialsForAdmin(adminId, merged).catch(() => {});
  });
  return google.drive({ version: 'v3', auth: oAuth });
}

// Find (or create) a folder by name under parentId. Returns folderId.
async function findOrCreateFolder(drive, name, parentId) {
  const safe = name.replace(/['\\]/g, '');
  const parentClause = parentId ? ` and '${parentId}' in parents` : '';
  const q = `mimeType='application/vnd.google-apps.folder' and name='${safe}' and trashed=false${parentClause}`;
  const { data } = await drive.files.list({
    q, fields: 'files(id,name)', spaces: 'drive', pageSize: 1,
  });
  if (data.files && data.files.length) return data.files[0].id;

  const meta = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    parents: parentId ? [parentId] : undefined,
  };
  const created = await drive.files.create({ requestBody: meta, fields: 'id' });
  return created.data.id;
}

function bufferToStream(buf) {
  const r = new Readable();
  r._read = () => {};
  r.push(buf);
  r.push(null);
  return r;
}

async function uploadFile(drive, { name, mimeType, buffer, parentId, makePublic = true }) {
  const res = await drive.files.create({
    requestBody: { name, parents: parentId ? [parentId] : undefined },
    media: { mimeType, body: bufferToStream(buffer) },
    fields: 'id, name, webViewLink, webContentLink',
  });
  // "Anyone with the link can view", so a WhatsApp share or a link pasted
  // into either client opens without a Google sign-in. Admin-controllable
  // via drive_settings.make_links_public for clinics that would rather keep
  // everything private to the connected account.
  if (makePublic) {
    try {
      await drive.permissions.create({
        fileId: res.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
      });
    } catch {}
  }
  // Re-fetch with links after permission change
  const meta = await drive.files.get({
    fileId: res.data.id,
    fields: 'id, name, webViewLink, webContentLink',
  });
  return meta.data;
}

// ═══════════════════════════════════════════════════════════
// Folder-path handling for patient documents
// ═══════════════════════════════════════════════════════════

const DEFAULT_SETTINGS = {
  root_folder_id: null,
  root_path: 'Treatment Record',
  patient_folder_tmpl: '{code} - {name}',
  category_subfolders: true,
  date_subfolders: false,
  make_links_public: true,
  auto_create_patient_folder: true,
};

// Read the single-row drive_settings, falling back to defaults if the table
// has not been migrated yet (so an un-migrated deployment still uploads).
async function getSettings() {
  try {
    const { rows } = await query('SELECT * FROM drive_settings WHERE id = 1');
    if (!rows.length) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...rows[0] };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(patch) {
  const allowed = [
    'root_folder_id', 'root_path', 'patient_folder_tmpl',
    'category_subfolders', 'date_subfolders', 'make_links_public',
    'auto_create_patient_folder',
  ];
  const sets = [];
  const vals = [];
  let n = 1;
  for (const k of allowed) {
    if (k in patch) { sets.push(`${k} = $${n++}`); vals.push(patch[k]); }
  }
  if (!sets.length) return getSettings();
  await query(
    `INSERT INTO drive_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  await query(
    `UPDATE drive_settings SET ${sets.join(', ')}, updated_at = NOW() WHERE id = 1`,
    vals);
  return getSettings();
}

// ===========================================================
// Browsing the user's existing folders
// ===========================================================

/// Child folders of [parentId] ('root' for My Drive), or a name search across
/// the whole Drive when [q] is given. Trashed folders and shortcuts are left
/// out; Shared Drives are included so a clinic filing into one can pick it.
async function listFolders(drive, { parentId = 'root', q = '', pageSize = 200 } = {}) {
  const clauses = [
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
  ];
  const term = String(q || '').trim().replace(/['\\]/g, '');
  if (term) {
    clauses.push(`name contains '${term}'`);
  } else {
    clauses.push(`'${String(parentId || 'root').replace(/['\\]/g, '')}' in parents`);
  }
  const { data } = await drive.files.list({
    q: clauses.join(' and '),
    fields: 'files(id,name,parents,shortcutDetails)',
    orderBy: 'name',
    pageSize,
    spaces: 'drive',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: 'allDrives',
  });
  return (data.files || [])
    .filter((f) => !f.shortcutDetails)
    .map((f) => ({ id: f.id, name: f.name }));
}

/// Walk a folder's parents up to the root so the UI can show a real path
/// ("My Drive / Clinic / Patients") rather than an opaque id.
///
/// Bounded at 20 hops: a malformed parent chain must not spin forever.
async function folderPath(drive, folderId) {
  if (!folderId || folderId === 'root') return 'My Drive';
  const parts = [];
  let id = folderId;
  for (let i = 0; i < 20 && id && id !== 'root'; i++) {
    let meta;
    try {
      const { data } = await drive.files.get({
        fileId: id,
        fields: 'id,name,parents',
        supportsAllDrives: true,
      });
      meta = data;
    } catch {
      break;
    }
    parts.unshift(meta.name);
    id = (meta.parents && meta.parents[0]) || null;
  }
  return ['My Drive', ...parts].join(' / ');
}

// Drive has no real path separator, so every segment becomes its own folder.
// Strip characters that would either split a segment or break the `q=` filter
// used to look folders up.
function sanitizeSegment(s) {
  return String(s == null ? '' : s)
    .replace(/[\/\r\n\t]+/g, ' ')
    .replace(/['"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// Expand {code} {name} {year} {month} {date} {category} in a template.
function renderTemplate(tmpl, vars) {
  return String(tmpl || '').replace(/\{(\w+)\}/g, (m, key) => {
    const v = vars[key];
    return v == null ? '' : String(v);
  });
}

// Split 'A / B/C' into ['A','B','C'], dropping blanks.
function splitPath(p) {
  return String(p || '')
    .split(/[\/]+/)
    .map(sanitizeSegment)
    .filter(Boolean);
}

// Walk (creating as needed) a chain of folder names under [rootId].
// Returns { id, path } — path being the human-readable chain we walked.
async function ensureFolderPath(drive, segments, rootId) {
  let parent = rootId || null;
  const walked = [];
  for (const raw of segments) {
    const seg = sanitizeSegment(raw);
    if (!seg) continue;
    parent = await findOrCreateFolder(drive, seg, parent);
    walked.push(seg);
  }
  return { id: parent, path: walked.join('/') };
}

// Human-friendly label for a document category, used as the subfolder name.
const CATEGORY_FOLDERS = {
  xray: 'X-Ray',
  scan: 'Scans',
  report: 'Reports',
  prescription: 'Prescriptions',
  photo: 'Photos',
  treatment: 'Treatment Records',
  other: 'Other',
};

function categoryFolderName(category) {
  return CATEGORY_FOLDERS[String(category || 'other').toLowerCase()] || 'Other';
}

// ===========================================================
// Per-patient folder
// ===========================================================

/// Folder-name variables for a patient, at a given date.
function patientVars({ patientCode, patientName, category, docDate }) {
  const d = docDate ? new Date(docDate) : new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return {
    code: patientCode || '',
    name: patientName || '',
    year: yyyy,
    month: `${yyyy}-${mm}`,
    date: `${yyyy}-${mm}-${dd}`,
    category: categoryFolderName(category || 'other'),
  };
}

/// Create (or find) the base folder for one patient - root chain plus the
/// patient folder itself, WITHOUT the category / month subfolders. That is
/// the folder a human opens in Drive, and the parent everything else hangs
/// off.
async function ensurePatientFolder(drive, settings, { patientCode, patientName }) {
  const vars = patientVars({ patientCode, patientName });
  const segments = [];
  const rootId = settings.root_folder_id || process.env.DRIVE_ROOT_FOLDER_ID || null;
  if (!rootId) segments.push(...splitPath(renderTemplate(settings.root_path, vars)));
  const patientFolder = renderTemplate(
    settings.patient_folder_tmpl || DEFAULT_SETTINGS.patient_folder_tmpl, vars);
  segments.push(...splitPath(patientFolder || vars.code || 'Unknown patient'));
  return ensureFolderPath(drive, segments, rootId);
}

/// Ensure the Drive folder for patient [patientId] exists and is recorded on
/// the row. Returns { id, path } or null.
///
/// Never throws. Patient creation must not fail because Google is having a
/// bad day - the folder is retried on the next upload or from the Documents
/// page's "Create folder" button.
async function ensurePatientFolderForId(patientId, adminId, { force = false } = {}) {
  try {
    const { rows } = await query(
      'SELECT id, patient_code, full_name, drive_folder_id, drive_folder_path FROM patients WHERE id=$1',
      [patientId]);
    if (!rows.length) return null;
    const p = rows[0];

    // Already recorded - trust it. Re-resolving by name every time would
    // create a duplicate the moment someone renames the folder in Drive.
    if (!force && p.drive_folder_id) {
      return { id: p.drive_folder_id, path: p.drive_folder_path || '' };
    }

    const settings = await getSettings();
    const drive = await getDriveForAdmin(adminId);
    const folder = await ensurePatientFolder(drive, settings, {
      patientCode: p.patient_code,
      patientName: p.full_name,
    });
    await query(
      'UPDATE patients SET drive_folder_id=$2, drive_folder_path=$3 WHERE id=$1',
      [patientId, folder.id, folder.path]);
    return folder;
  } catch (e) {
    console.warn('[drive] patient folder for', patientId, 'failed:', e.message);
    return null;
  }
}

/// Keep the Drive folder's NAME in step when a patient is renamed or
/// re-coded. Best-effort and silent: a folder that cannot be renamed is
/// still the right folder, it just carries the old label.
async function renamePatientFolder(patientId, adminId) {
  try {
    const { rows } = await query(
      'SELECT patient_code, full_name, drive_folder_id FROM patients WHERE id=$1',
      [patientId]);
    if (!rows.length || !rows[0].drive_folder_id) return;
    const p = rows[0];
    const settings = await getSettings();
    const vars = patientVars({ patientCode: p.patient_code, patientName: p.full_name });
    const desired = sanitizeSegment(
      renderTemplate(settings.patient_folder_tmpl, vars)) || p.patient_code;
    const drive = await getDriveForAdmin(adminId);
    const { data } = await drive.files.get({
      fileId: p.drive_folder_id, fields: 'id,name', supportsAllDrives: true,
    });
    if (data.name === desired) return;
    await drive.files.update({
      fileId: p.drive_folder_id,
      requestBody: { name: desired },
      supportsAllDrives: true,
    });
    const path = await folderPath(drive, p.drive_folder_id);
    await query('UPDATE patients SET drive_folder_path=$2 WHERE id=$1',
      [patientId, path]);
  } catch (e) {
    console.warn('[drive] patient folder rename failed:', e.message);
  }
}

// Resolve the destination folder for one document, creating the chain.
//
// Layout, with every part after the root optional per settings:
//   <root_path or root_folder_id>/<patient folder>/<category>/<YYYY-MM>
//
// Returns { id, path }. `path` is stored on the row so both clients can show
// the user exactly where in Drive the file went.
async function resolveDocumentFolder(drive, settings, {
  patientCode, patientName, category, docDate, patientFolderId = null,
}) {
  const vars = patientVars({ patientCode, patientName, category, docDate });

  // When the patient already has a folder recorded (created with the patient
  // itself), hang the subfolders off THAT id rather than re-walking the tree
  // by name. Two payoffs: one fewer round trip per upload, and moving or
  // renaming the folder in Drive does not silently start a second copy.
  if (patientFolderId) {
    const tail = [];
    if (settings.category_subfolders) tail.push(vars.category);
    if (settings.date_subfolders) tail.push(vars.month);
    if (!tail.length) return { id: patientFolderId, path: '' };
    const { id, path } = await ensureFolderPath(drive, tail, patientFolderId);
    return { id, path };
  }

  const segments = [];
  // An explicit folder id replaces the root path entirely.
  const rootId = settings.root_folder_id || process.env.DRIVE_ROOT_FOLDER_ID || null;
  if (!rootId) segments.push(...splitPath(renderTemplate(settings.root_path, vars)));

  const patientFolder = renderTemplate(
    settings.patient_folder_tmpl || DEFAULT_SETTINGS.patient_folder_tmpl, vars);
  segments.push(...splitPath(patientFolder || vars.code || 'Unknown patient'));

  if (settings.category_subfolders) segments.push(vars.category);
  if (settings.date_subfolders) segments.push(vars.month);

  const { id, path } = await ensureFolderPath(drive, segments, rootId);
  return { id, path: (rootId ? '…/' : '') + path };
}

module.exports = {
  SCOPES,
  FULL_SCOPE,
  hasFullScope,
  listFolders,
  folderPath,
  getOAuth2Client,
  getDriveForAdmin,
  loadCredentialsForAdmin,
  saveCredentialsForAdmin,
  findOrCreateFolder,
  uploadFile,
  // Path handling
  DEFAULT_SETTINGS,
  CATEGORY_FOLDERS,
  getSettings,
  saveSettings,
  renderTemplate,
  sanitizeSegment,
  splitPath,
  ensureFolderPath,
  categoryFolderName,
  resolveDocumentFolder,
  patientVars,
  ensurePatientFolder,
  ensurePatientFolderForId,
  renamePatientFolder,
};
