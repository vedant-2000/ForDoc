const { google } = require('googleapis');
const { query } = require('../db/pool');
const { Readable } = require('stream');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

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

async function uploadFile(drive, { name, mimeType, buffer, parentId }) {
  const res = await drive.files.create({
    requestBody: { name, parents: parentId ? [parentId] : undefined },
    media: { mimeType, body: bufferToStream(buffer) },
    fields: 'id, name, webViewLink, webContentLink',
  });
  // Optional: set "anyone with link can view" so WhatsApp shares are openable
  try {
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });
  } catch {}
  // Re-fetch with links after permission change
  const meta = await drive.files.get({
    fileId: res.data.id,
    fields: 'id, name, webViewLink, webContentLink',
  });
  return meta.data;
}

module.exports = {
  SCOPES,
  getOAuth2Client,
  getDriveForAdmin,
  loadCredentialsForAdmin,
  saveCredentialsForAdmin,
  findOrCreateFolder,
  uploadFile,
};
