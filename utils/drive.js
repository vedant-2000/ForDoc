const { google } = require('googleapis');
const { query } = require('../db/pool');
const cache = require('./cache');
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

// How long a folder listing stays good without asking Google again.
//
// Short on purpose: this only covers changes made OUTSIDE the app (someone
// renaming a folder in Drive itself). Anything the app does busts the key
// immediately, so the TTL is never what you are waiting on for your own
// actions.
const FOLDER_TTL_MS = 60_000;

// Which Google account a drive client is authenticated as, for cache keys.
//
// This CANNOT be a property on the client: googleapis hands back a
// non-extensible object, and assigning to it throws
// "Cannot define property __ownerId, object is not extensible", which took
// out every Drive screen. A WeakMap keys off the object's identity without
// touching it, and the entry is collected along with the client - which is
// built fresh per request, so nothing accumulates.
const driveOwners = new WeakMap();

/** Cache-key identity for a drive client; 'shared' when unknown. */
function driveOwner(drive) {
  if (!drive) return 'shared';
  return driveOwners.get(drive) || 'shared';
}
const PATH_TTL_MS   = 300_000;   // ancestry changes far less often than contents

/**
 * A Drive failure with an HTTP status and a message aimed at whoever has to
 * fix it. Routes return `err.status`; the server's error handler falls back
 * to 500 for anything untagged.
 */
class DriveError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.code = code;
    this.expose = true;   // safe to show the user - carries no secrets
  }
}

function notConnected() {
  return new DriveError(
    'Google Drive is not connected. An admin can connect it under '
    + 'Admin -> Google Drive.',
    409, 'drive_not_connected');
}

/**
 * Translate a Google client error into something actionable.
 *
 * `invalid_grant` is the one that actually happens here: the refresh token is
 * dead, either revoked or expired because the OAuth app is still in Testing
 * (Google expires those every 7 days). Retrying never fixes it - a human has
 * to reconnect - so it must not read as a generic 500, and it must never take
 * the process down.
 */
function classifyDriveError(e) {
  if (e instanceof DriveError) return e;

  const data = (e && e.response && e.response.data) || {};
  const status = (e && e.response && e.response.status) || null;
  const kind = String(data.error || (e && e.message) || '');

  if (/invalid_grant|Token has been expired or revoked/i.test(kind)
      || /invalid_grant/i.test(String(data.error_description || ''))) {
    return new DriveError(
      'The Google Drive connection has expired and needs to be reconnected '
      + '(Admin -> Google Drive -> Connect). Google expires the refresh token '
      + 'every 7 days while the OAuth app is still in "Testing" - publishing '
      + 'the app stops this happening.',
      409, 'drive_reauth_required');
  }
  if (status === 401) {
    return new DriveError(
      'Google rejected the stored Drive credentials. Reconnect under '
      + 'Admin -> Google Drive.', 409, 'drive_reauth_required');
  }
  if (status === 403 && /insufficient|scope/i.test(JSON.stringify(data))) {
    return new DriveError(
      'The Drive connection is missing the permissions this needs. '
      + 'Reconnect under Admin -> Google Drive and accept all access.',
      409, 'drive_scope_missing');
  }
  if (status === 403 || status === 429) {
    // Rate limit / quota. Transient - worth saying so, so nobody reconnects
    // Drive trying to fix something that will clear on its own.
    return new DriveError(
      'Google Drive is rate-limiting this account right now. Please retry in '
      + 'a moment.', 503, 'drive_rate_limited');
  }
  if (status === 404) {
    return new DriveError(
      'That Drive folder no longer exists. It may have been moved or deleted '
      + 'in Drive - re-pick the base folder under Admin -> Google Drive.',
      404, 'drive_not_found');
  }
  const err = new DriveError(
    `Google Drive error: ${e && e.message ? e.message : 'unknown'}`,
    502, 'drive_error');
  err.cause = e;
  return err;
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
  // Track WHICH row the credentials actually came from, and persist refreshed
  // tokens back to THAT row.
  //
  // Several routes call this as `getDriveForAdmin(req.user.role === 'admin'
  // ? req.user.id : null)`, so for any doctor the id is null. `WHERE admin_id
  // = NULL` matches nothing, we fell through to the borrow-any-admin branch,
  // and then wrote the refreshed token back under the CALLER's id - null.
  // That row does not exist, the ON CONFLICT target never matched, and the
  // failure was swallowed by `.catch(() => {})`. Net effect: every refresh a
  // doctor triggered was thrown away, so the stored token drifted stale and
  // eventually forced a manual reconnect.
  let ownerId = adminId;
  let creds = adminId == null ? null : await loadCredentialsForAdmin(adminId);
  if (!creds) {
    // Deterministic pick rather than whatever the planner returns first.
    const { rows } = await query(
      'SELECT admin_id FROM drive_tokens ORDER BY updated_at DESC NULLS LAST LIMIT 1');
    if (rows.length) {
      ownerId = rows[0].admin_id;
      creds = await loadCredentialsForAdmin(ownerId);
    }
  }
  if (!creds) throw notConnected();

  const oAuth = getOAuth2Client();
  oAuth.setCredentials(creds);
  oAuth.on('tokens', (newTok) => {
    const merged = Object.assign({}, creds, newTok);
    // Log rather than swallow: silence is what hid the bug above for so long.
    saveCredentialsForAdmin(ownerId, merged).catch((e) =>
      console.error('[drive] could not persist refreshed token:', e.message));
  });

  const drive = google.drive({ version: 'v3', auth: oAuth });
  // Cache keys must be per-account: two admins can see different folders, and
  // one must never be served the other's listing.
  driveOwners.set(drive, ownerId == null ? 'shared' : String(ownerId));
  return drive;
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
  // The parent now has a child it did not have. Bust just that parent, not
  // the whole namespace - uploads create category subfolders routinely, and
  // clearing everything each time would keep the cache permanently cold.
  bustFolders(drive, parentId);
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
async function listFoldersUncached(drive, { parentId = 'root', q = '', pageSize = 200, maxPages = 10 } = {}) {
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

  // Paged, because the caller that matters most - finding a patient's
  // existing folder - runs against a parent that may hold hundreds of them.
  // A single 200-row page would silently miss the folder and we would create
  // a duplicate. Capped so a pathological tree cannot spin forever.
  const out = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const { data } = await drive.files.list({
      q: clauses.join(' and '),
      fields: 'nextPageToken, files(id,name,parents,shortcutDetails)',
      orderBy: 'name',
      pageSize,
      pageToken,
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'allDrives',
    });
    for (const f of data.files || []) {
      if (!f.shortcutDetails) out.push({ id: f.id, name: f.name });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

/// Walk a folder's parents up to the root so the UI can show a real path
/// ("My Drive / Clinic / Patients") rather than an opaque id.
///
/// Bounded at 20 hops: a malformed parent chain must not spin forever.
/**
 * List folders under `parentId`, served from the in-process cache.
 *
 * This is the hot path the whole app was waiting on: up to 10 sequential
 * round-trips to Google, on every request that showed or resolved a folder.
 * Pass `fresh: true` to force a re-read (the reconcile screen does, since its
 * entire job is reporting Drive's current truth).
 */
async function listFolders(drive, opts = {}) {
  const { parentId = 'root', q = '', fresh = false } = opts;
  const owner = driveOwner(drive);
  const key = `folders:${owner}:${parentId}:${q}`;
  if (fresh) cache.bust(key);
  return cache.get(key, FOLDER_TTL_MS, () => listFoldersUncached(drive, opts));
}

/**
 * Files (not folders) directly inside `parentId`.
 *
 * Separate from listFolders because that one filters to folders only. Shares
 * the same cache namespace so a folder creation busts both.
 */
async function listFilesUncached(drive, { parentId, pageSize = 200, maxPages = 5 }) {
  const out = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const { data } = await drive.files.list({
      q: `'${String(parentId).replace(/['\\]/g, '')}' in parents`
        + ` and mimeType != 'application/vnd.google-apps.folder'`
        + ` and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime,'
        + 'webViewLink,thumbnailLink,shortcutDetails)',
      orderBy: 'modifiedTime desc',
      pageSize,
      pageToken,
      spaces: 'drive',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      corpora: 'allDrives',
    });
    for (const f of data.files || []) {
      if (f.shortcutDetails) continue;
      out.push({
        id: f.id,
        name: f.name,
        mime_type: f.mimeType,
        size_bytes: f.size == null ? null : Number(f.size),
        modified_at: f.modifiedTime || null,
        web_view_link: f.webViewLink || null,
        thumbnail_link: f.thumbnailLink || null,
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

async function listFiles(drive, { parentId, fresh = false } = {}) {
  if (!parentId) return [];
  const owner = driveOwner(drive);
  const key = `files:${owner}:${parentId}`;
  if (fresh) cache.bust(key);
  return cache.get(key, FOLDER_TTL_MS, () => listFilesUncached(drive, { parentId }));
}

/** Drop cached listings for one parent (all `q` variants), or all of them. */
function bustFolders(drive, parentId) {
  const owner = driveOwner(drive);
  if (parentId) {
    cache.bust(`folders:${owner}:${parentId}:`);
    cache.bust(`files:${owner}:${parentId}`);
  } else {
    cache.bust('folders:');
    cache.bust('files:');
  }
}

async function folderPathUncached(drive, folderId) {
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
/**
 * Full 'My Drive / A / B' path for a folder, cached.
 *
 * The uncached walk costs one Drive round-trip PER ancestor level, and it is
 * called for display on rows the app renders in bulk. Ancestry changes far
 * less often than folder contents, hence the longer TTL.
 */
async function folderPath(drive, folderId) {
  if (!folderId || folderId === 'root') return 'My Drive';
  const owner = driveOwner(drive);
  return cache.get(`path:${owner}:${folderId}`, PATH_TTL_MS,
    () => folderPathUncached(drive, folderId));
}

/**
 * Drop cached paths.
 *
 * Always ALL of them, never one key: moving or renaming a folder changes the
 * path of every descendant too, and we do not track the tree. These are rare
 * admin actions, unlike folder creation, so clearing the namespace is cheap.
 */
function bustPaths() {
  cache.bust('path:');
}

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
  body: 'Body Photos',
  treatment: 'Treatment Records',
  other: 'Other',
};

function categoryFolderName(category) {
  return CATEGORY_FOLDERS[String(category || 'other').toLowerCase()] || 'Other';
}

/// Re-parent a folder. Drive has no "move" call: you add the new parent and
/// remove the old ones in a single update, which is atomic from the API's
/// point of view.
///
/// Contents travel with the folder - the children are not touched, so a
/// patient's whole history moves in one call and every stored file id stays
/// valid.
async function moveFolder(drive, folderId, newParentId) {
  const { data: cur } = await drive.files.get({
    fileId: folderId,
    fields: 'id,name,parents',
    supportsAllDrives: true,
  });
  const previous = (cur.parents || []).join(',');
  if ((cur.parents || []).includes(newParentId)) {
    return { id: cur.id, name: cur.name, moved: false };
  }
  await drive.files.update({
    fileId: folderId,
    addParents: newParentId,
    removeParents: previous || undefined,
    fields: 'id,name,parents',
    supportsAllDrives: true,
  });
  // Both listings are now wrong - the old parent still shows it, the new one
  // does not - and every descendant path changed with it.
  for (const p of (cur.parents || [])) bustFolders(drive, p);
  bustFolders(drive, newParentId);
  bustPaths();
  return { id: cur.id, name: cur.name, moved: true };
}

/// The folder that patient folders should sit directly inside, given the
/// current settings. Creates the base chain if it does not exist yet.
async function baseFolderId(drive, settings) {
  const rootId = settings.root_folder_id || process.env.DRIVE_ROOT_FOLDER_ID || null;
  if (rootId) return rootId;
  const vars = patientVars({});
  const base = await ensureFolderPath(
    drive, splitPath(renderTemplate(settings.root_path, vars)), null);
  return base.id;
}

// ===========================================================
// Matching an EXISTING patient folder
// ===========================================================

/// Fold a folder name down to a comparable form: lower case, and every run
/// of separator punctuation (space, hyphen, en/em dash, underscore, dot,
/// comma, slash) collapsed to one space. So "Asha Rao - P-042",
/// "P_042  asha rao" and "p 042 / Asha Rao" all normalise to the same
/// alphabet, differing only in word order.
function normalizeFolderName(v) {
  return String(v == null ? '' : v)
    .toLowerCase()
    .replace(/[\s\-\u2010-\u2015_.,/\\|]+/g, ' ')
    .trim();
}

function escapeRegExp(v) {
  return String(v == null ? '' : v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/// Regex that finds a patient code as a WHOLE TOKEN inside a normalised
/// folder name, in any position and either order.
///
/// The token boundaries matter: without them code "P-1" would happily match
/// the folder for "P-10", quietly filing one patient's X-rays into another
/// patient's folder. Boundaries are "not a letter or digit", so a code can
/// still be found whatever punctuation surrounds it.
function patientCodeRegExp(code) {
  const norm = normalizeFolderName(code);
  if (!norm) return null;
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(norm)}([^a-z0-9]|$)`, 'i');
}

/// Find this patient's folder among [parentId]'s children.
///
/// Ranked, best first:
///   exact      - normalised name equals what our template would produce
///   code+name  - carries the patient code as a token AND their name
///   code       - carries the patient code as a token
///
/// Returns `{ id, name, how }`, or null when nothing is convincing enough.
/// Name-only matches are deliberately NOT accepted: two patients share a
/// name far too often for that to be safe.
async function findPatientFolder(drive, parentId, {
  patientCode, patientName, desiredName,
}) {
  let folders;
  try {
    folders = await listFolders(drive, { parentId: parentId || 'root' });
  } catch {
    return null;
  }
  if (!folders.length) return null;

  const wantExact = normalizeFolderName(desiredName);
  const codeRe = patientCodeRegExp(patientCode);
  const nameNorm = normalizeFolderName(patientName);

  let best = null;
  for (const f of folders) {
    const n = normalizeFolderName(f.name);
    let score = 0;
    let how = '';
    if (wantExact && n === wantExact) {
      score = 100; how = 'exact';
    } else if (codeRe && codeRe.test(n)) {
      const alsoName = nameNorm.length > 1 && n.includes(nameNorm);
      score = alsoName ? 80 : 50;
      how = alsoName ? 'code+name' : 'code';
    }
    if (score && (!best || score > best.score)) {
      best = { id: f.id, name: f.name, how, score };
    }
  }
  return best;
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
  const rootId = settings.root_folder_id || process.env.DRIVE_ROOT_FOLDER_ID || null;

  // Ensure the BASE chain first (it is ours, exact names are fine there)...
  let parent = rootId;
  const walked = [];
  if (!rootId) {
    const base = await ensureFolderPath(
      drive, splitPath(renderTemplate(settings.root_path, vars)), null);
    parent = base.id;
    if (base.path) walked.push(...base.path.split('/'));
  }

  const desired = sanitizeSegment(renderTemplate(
    settings.patient_folder_tmpl || DEFAULT_SETTINGS.patient_folder_tmpl, vars))
    || sanitizeSegment(vars.code) || 'Unknown patient';

  // ...then look for the patient's folder rather than assuming our template
  // produced it. The clinic's Drive may already hold "Asha Rao - P-042"
  // while our template says "P-042 - Asha Rao"; creating the second one
  // would split that patient's history across two folders.
  const found = await findPatientFolder(drive, parent, {
    patientCode, patientName, desiredName: desired,
  });
  if (found) {
    return {
      id: found.id,
      path: [...walked, found.name].join('/'),
      matched: found.how,
    };
  }

  const id = await findOrCreateFolder(drive, desired, parent);
  return { id, path: [...walked, desired].join('/'), matched: 'created' };
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
    // Must come BEFORE folderPath() below, or we read back the pre-rename
    // path and write that stale value into the patient row.
    bustFolders(drive, null);
    bustPaths();
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

/// Replace the CONTENT of an existing Drive file, keeping its id, its link
/// and its place in the folder tree.
///
/// This is what makes re-saving a treatment session update one file instead
/// of littering the patient's folder with a new PDF every time somebody
/// presses Save. Any link already shared over WhatsApp keeps working and now
/// shows the current version.
async function updateFileContent(drive, { fileId, mimeType, buffer, name }) {
  await drive.files.update({
    fileId,
    requestBody: name ? { name } : {},
    media: { mimeType, body: bufferToStream(buffer) },
    supportsAllDrives: true,
  });
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, webViewLink, webContentLink',
    supportsAllDrives: true,
  });
  return meta.data;
}

module.exports = {
  SCOPES,
  DriveError,
  classifyDriveError,
  notConnected,
  bustFolders,
  bustPaths,
  updateFileContent,
  FULL_SCOPE,
  hasFullScope,
  listFolders,
  listFiles,
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
  normalizeFolderName,
  patientCodeRegExp,
  findPatientFolder,
  moveFolder,
  baseFolderId,
  ensurePatientFolder,
  ensurePatientFolderForId,
  renamePatientFolder,
};
