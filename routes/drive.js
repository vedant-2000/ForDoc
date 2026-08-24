const express = require('express');
const multer  = require('multer');
const { query } = require('../db/pool');
const { authRequired } = require('../middleware/auth');
const D = require('../utils/drive');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// GET /api/drive/status  — is Drive connected, and is OAuth env configured?
router.get('/status', authRequired(), async (_req, res) => {
  const { rows } = await query(
    'SELECT admin_id, updated_at FROM drive_tokens LIMIT 1'
  );
  res.json({
    configured: isConfigured(),
    connected: !!rows.length,
    info: rows[0] || null,
  });
});

// GET /api/drive/info — connected Google account info (email, name)
router.get('/info', authRequired(), async (req, res) => {
  try {
    if (!isConfigured()) return res.json({ configured: false, connected: false });
    const { rows } = await query('SELECT admin_id FROM drive_tokens LIMIT 1');
    if (!rows.length) return res.json({ configured: true, connected: false });

    const drive = await D.getDriveForAdmin(rows[0].admin_id);
    const about = await drive.about.get({ fields: 'user(displayName,emailAddress,photoLink), storageQuota' });
    res.json({
      configured: true,
      connected: true,
      account: about.data.user || null,
      quota:   about.data.storageQuota || null,
    });
  } catch (e) {
    console.error('[drive/info]', e.message);
    res.json({ configured: isConfigured(), connected: false, error: e.message });
  }
});

// POST /api/drive/disconnect (admin) — revoke + remove tokens
router.post('/disconnect', authRequired(['admin']), async (_req, res) => {
  try {
    const { rows } = await query('SELECT * FROM drive_tokens LIMIT 1');
    if (rows.length) {
      const o = D.getOAuth2Client();
      o.setCredentials({
        access_token: rows[0].access_token,
        refresh_token: rows[0].refresh_token,
      });
      try { await o.revokeCredentials(); } catch {}
      await query('DELETE FROM drive_tokens');
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[drive/disconnect]', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/drive/auth-url  (admin) — returns Google consent URL
router.get('/auth-url', authRequired(['admin']), (req, res) => {
  if (!isConfigured()) {
    return res.status(400).json({
      error: 'Google OAuth credentials are not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env, then restart the server.',
    });
  }
  try {
    const o = D.getOAuth2Client();
    const url = o.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',                 // force refresh_token
      scope: D.SCOPES,
      state: String(req.user.id),
      include_granted_scopes: true,
    });
    res.json({ url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/drive/callback?code=...&state=adminId  (browser redirect target)
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.send(renderPopupPage({
      ok: false, title: 'Google sign-in cancelled', detail: String(error),
    }));
  }
  if (!code) return res.status(400).send('Missing code');
  try {
    const o = D.getOAuth2Client();
    const { tokens } = await o.getToken(code);
    const adminId = Number(state) || null;
    if (adminId) await D.saveCredentialsForAdmin(adminId, tokens);

    // Best-effort: fetch the Google account email so we can show it on success.
    let email = '';
    try {
      o.setCredentials(tokens);
      const { google } = require('googleapis');
      const drive = google.drive({ version: 'v3', auth: o });
      const about = await drive.about.get({ fields: 'user(emailAddress)' });
      email = about.data.user?.emailAddress || '';
    } catch {}

    res.send(renderPopupPage({
      ok: true,
      title: 'Google Drive connected',
      detail: email ? `Signed in as ${email}` : 'You can close this window.',
    }));
  } catch (e) {
    console.error('[drive/callback]', e);
    res.status(500).send(renderPopupPage({
      ok: false, title: 'Sign-in failed', detail: e.message,
    }));
  }
});

// POST /api/drive/exchange  (admin)   { url } or { code }
//
// Completes the consent flow by hand. After approving access the browser is
// sent to GOOGLE_REDIRECT_URI with ?code=... appended; when that URI is a
// localhost address the page fails to load, but the URL in the address bar
// still carries the code. Paste that whole URL here and we finish the swap.
//
// Why this exists: Google only accepts https:// or http://localhost redirect
// URIs. A server reached over plain HTTP at an IP address can never receive
// the callback itself, and this is the one-time admin action that connects
// the clinic's Drive - it should not require a domain and a certificate
// first.
router.post('/exchange', authRequired(['admin']), async (req, res) => {
  const body = req.body || {};
  let code = String(body.code || '').trim();

  // Accept a full pasted URL and dig the code out of it.
  if (!code && body.url) {
    const raw = String(body.url).trim();
    try {
      code = new URL(raw).searchParams.get('code') || '';
    } catch {
      // Not a parseable URL - fall back to a plain query-string scrape so a
      // half-copied address still works.
      const m = raw.match(/[?&]code=([^&\s]+)/);
      if (m) code = decodeURIComponent(m[1]);
    }
    if (!code) {
      const err = /[?&]error=([^&\s]+)/.exec(raw);
      return res.status(400).json({
        error: err
          ? `Google reported: ${decodeURIComponent(err[1])}`
          : 'No ?code= found in that URL. Copy the FULL address bar contents '
            + 'from the page you landed on after approving access.',
      });
    }
  }
  if (!code) return res.status(400).json({ error: 'code or url required' });

  try {
    const o = D.getOAuth2Client();
    const { tokens } = await o.getToken(code);
    if (!tokens.refresh_token) {
      // Without a refresh token the connection dies at the first expiry.
      // Google only issues one on the first consent, hence prompt=consent on
      // the auth URL - if it is missing, the code was probably reused.
      console.warn('[drive/exchange] no refresh_token in response');
    }
    await D.saveCredentialsForAdmin(req.user.id, tokens);

    let email = '';
    try {
      o.setCredentials(tokens);
      const { google } = require('googleapis');
      const drive = google.drive({ version: 'v3', auth: o });
      const about = await drive.about.get({ fields: 'user(emailAddress)' });
      email = about.data.user?.emailAddress || '';
    } catch { /* connection still saved */ }

    res.json({ ok: true, email, has_refresh_token: !!tokens.refresh_token });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    res.status(400).json({
      error: /invalid_grant/i.test(msg)
        ? 'That code was already used or has expired. Start the sign-in again '
          + 'and paste the new URL within a minute or two.'
        : msg,
    });
  }
});

// Tiny self-closing HTML page that notifies the opener window.
function renderPopupPage({ ok, title, detail }) {
  const safe = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' }[c]));
  return `<!doctype html><html><body style="font-family:system-ui,Segoe UI,sans-serif;padding:32px;text-align:center;background:#f5f0e8;color:#1a1a1a;">
    <div style="font-size:48px;line-height:1;margin-bottom:8px;">${ok ? '✅' : '⚠️'}</div>
    <h2 style="margin:0 0 6px;">${safe(title)}</h2>
    <p style="margin:0 0 18px;color:#555;">${safe(detail)}</p>
    <p style="color:#888;font-size:12px;">This window will close automatically.</p>
    <script>
      try { window.opener && window.opener.postMessage({ type: 'drive-auth', ok: ${ok ? 'true':'false'} }, '*'); } catch (e) {}
      setTimeout(() => { try { window.close(); } catch(e){} }, 1200);
    </script>
  </body></html>`;
}

// ===========================================================
// Folder browser - pick a real folder out of the user's Drive
// ===========================================================

// GET /api/drive/folders?parent=<id|root>&q=<search>   (admin)
//
// Lists child folders so the admin can navigate to whatever structure their
// Drive already uses, instead of typing a path and hoping it matches.
router.get('/folders', authRequired(['admin']), async (req, res) => {
  try {
    const { rows } = await query('SELECT admin_id FROM drive_tokens LIMIT 1');
    if (!rows.length) {
      return res.status(400).json({ error: 'Google Drive is not connected.' });
    }
    const adminId = rows[0].admin_id;
    if (!(await D.hasFullScope(adminId))) {
      return res.status(403).json({
        error: 'Reconnect Google Drive to allow browsing your folders.',
        needs_reconnect: true,
      });
    }
    const drive = await D.getDriveForAdmin(adminId);
    const parent = String(req.query.parent || 'root');
    const q = String(req.query.q || '');
    const folders = await D.listFolders(drive, { parentId: parent, q });
    const path = q ? '' : await D.folderPath(drive, parent);
    res.json({ parent, path, folders });
  } catch (e) {
    console.error('[drive/folders]', e.message);
    const needsReconnect = /insufficient|permission|scope|403/i.test(e.message || '');
    res.status(needsReconnect ? 403 : 500).json({
      error: needsReconnect
        ? 'Reconnect Google Drive to allow browsing your folders.'
        : e.message,
      needs_reconnect: needsReconnect,
    });
  }
});

// POST /api/drive/folders  { parent, name }  (admin) - create a subfolder
// from inside the picker, so a new tree can be started without leaving here.
router.post('/folders', authRequired(['admin']), async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const parent = String((req.body || {}).parent || 'root');
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const drive = await D.getDriveForAdmin(req.user.id);
    const id = await D.findOrCreateFolder(drive, name, parent === 'root' ? null : parent);
    res.status(201).json({ id, name });
  } catch (e) {
    console.error('[drive/folders/create]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ===========================================================
// Folder settings - where in Drive patient documents are filed
// ===========================================================

// GET /api/drive/settings - readable by any signed-in user, because both
// clients show "this file went to <path>" next to a document.
router.get('/settings', authRequired(), async (_req, res) => {
  try {
    const s = await D.getSettings();
    // Resolve the picked folder id to something a human can read, so the UI
    // shows "My Drive / Clinic / Patients" rather than an opaque id.
    let rootFolderPath = '';
    let needsReconnect = false;
    if (s.root_folder_id) {
      try {
        const { rows } = await query('SELECT admin_id FROM drive_tokens LIMIT 1');
        if (rows.length) {
          const drive = await D.getDriveForAdmin(rows[0].admin_id);
          rootFolderPath = await D.folderPath(drive, s.root_folder_id);
        }
      } catch { /* leave blank - the id still works for uploads */ }
    }
    try {
      const { rows } = await query('SELECT admin_id FROM drive_tokens LIMIT 1');
      if (rows.length) needsReconnect = !(await D.hasFullScope(rows[0].admin_id));
    } catch { /* not connected at all */ }
    res.json({
      ...s,
      root_folder_path: rootFolderPath,
      needs_reconnect: needsReconnect,
      placeholders: ['{code}', '{name}', '{year}', '{month}', '{date}', '{category}'],
      categories: Object.entries(D.CATEGORY_FOLDERS)
        .map(([id, label]) => ({ id, label })),
    });
  } catch (e) {
    console.error('[drive/settings/get]', e);
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/drive/settings (admin)
router.put('/settings', authRequired(['admin']), async (req, res) => {
  const b = req.body || {};
  const patch = {};
  if ('root_folder_id' in b) {
    const v = String(b.root_folder_id || '').trim();
    patch.root_folder_id = v === '' ? null : v;
  }
  if ('root_path' in b) patch.root_path = String(b.root_path || '').trim() || 'Treatment Record';
  if ('patient_folder_tmpl' in b) {
    patch.patient_folder_tmpl =
      String(b.patient_folder_tmpl || '').trim() || '{code} - {name}';
  }
  if ('category_subfolders' in b) patch.category_subfolders = !!b.category_subfolders;
  if ('date_subfolders' in b)     patch.date_subfolders = !!b.date_subfolders;
  if ('make_links_public' in b)   patch.make_links_public = !!b.make_links_public;
  try {
    const s = await D.saveSettings(patch);
    res.json(s);
  } catch (e) {
    console.error('[drive/settings/put]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/drive/settings/preview (admin) - resolve the folder chain for a
// sample patient WITHOUT creating anything, so the admin can see the layout
// their template produces before committing to it.
router.post('/settings/preview', authRequired(['admin']), async (req, res) => {
  const b = req.body || {};
  try {
    const stored = await D.getSettings();
    const s = { ...stored, ...b };
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const vars = {
      code: b.sample_code || 'P-001',
      name: b.sample_name || 'Sample Patient',
      year: yyyy,
      month: yyyy + '-' + mm,
      date: yyyy + '-' + mm + '-' + dd,
      category: D.categoryFolderName(b.sample_category || 'xray'),
    };
    const segs = [];
    const rootId = s.root_folder_id || process.env.DRIVE_ROOT_FOLDER_ID || null;
    if (rootId) {
      // Show the folder the admin actually picked, not a placeholder.
      let label = 'Selected folder';
      try {
        const { rows } = await query('SELECT admin_id FROM drive_tokens LIMIT 1');
        if (rows.length) {
          const drive = await D.getDriveForAdmin(rows[0].admin_id);
          label = await D.folderPath(drive, rootId);
        }
      } catch { /* keep the placeholder */ }
      segs.push(label);
    } else {
      segs.push(...D.splitPath(D.renderTemplate(s.root_path, vars)));
    }
    segs.push(...D.splitPath(D.renderTemplate(s.patient_folder_tmpl, vars)));
    if (s.category_subfolders) segs.push(vars.category);
    if (s.date_subfolders) segs.push(vars.month);
    res.json({ path: segs.join(' / '), segments: segs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/drive/save-report  multipart: file (pdf/jpg) + patient_code + session_date
router.post('/save-report', authRequired(), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const { patient_code, patient_id, session_id, session_date, file_kind } = req.body || {};
  if (!patient_code) return res.status(400).json({ error: 'patient_code required' });

  try {
    const settings = await D.getSettings();
    const drive = await D.getDriveForAdmin(req.user.role === 'admin' ? req.user.id : null);

    const stamp = session_date || new Date().toISOString().slice(0, 10);
    const ext = (file_kind === 'jpg' ? 'jpg' : 'pdf');

    // Patient name is only needed for the {name} placeholder; look it up when
    // we have an id, otherwise the template renders it empty.
    let patientName = '';
    if (patient_id) {
      const { rows } = await query(
        'SELECT full_name FROM patients WHERE id=$1', [+patient_id]);
      patientName = (rows[0] && rows[0].full_name) || '';
    }

    // Same folder resolver every other document uses, so an exported
    // treatment record lands beside the patient's X-rays and reports rather
    // than in a parallel Patient_<code> tree of its own.
    const folder = await D.resolveDocumentFolder(drive, settings, {
      patientCode: patient_code,
      patientName,
      category: 'treatment',
      docDate: stamp,
    });
    const patientFolderId = folder.id;
    const name = `${stamp}_${patient_code}_treatment.${ext}`;

    const uploaded = await D.uploadFile(drive, {
      name,
      mimeType: req.file.mimetype || (ext === 'pdf' ? 'application/pdf' : 'image/jpeg'),
      buffer: req.file.buffer,
      parentId: patientFolderId,
      makePublic: settings.make_links_public !== false,
    });

    if (patient_id) {
      await query(
        `INSERT INTO treatment_reports
           (patient_id, session_id, drive_file_id, drive_view_link, file_kind, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          +patient_id,
          session_id ? +session_id : null,
          uploaded.id,
          uploaded.webViewLink || null,
          ext,
          req.user.role === 'doctor' ? req.user.id : null,
        ]
      );

      // Also register it in the unified document list, so a treatment record
      // shows up on the patient's Documents page next to everything else.
      // Drive-only (no local copy): the bytes were generated by the client,
      // which already files its own copy under the reports folder.
      try {
        await query(
          `INSERT INTO patient_documents
             (patient_id, session_id, category, title, doc_date,
              original_name, mime_type, size_bytes,
              drive_file_id, drive_view_link, drive_download_link,
              drive_folder_id, drive_path, sync_status,
              uploaded_by, uploaded_by_name)
           VALUES ($1,$2,'treatment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'synced',$13,$14)`,
          [
            +patient_id,
            session_id ? +session_id : null,
            'Treatment record (' + ext.toUpperCase() + ')',
            stamp,
            name,
            req.file.mimetype || (ext === 'pdf' ? 'application/pdf' : 'image/jpeg'),
            req.file.size || null,
            uploaded.id,
            uploaded.webViewLink || null,
            uploaded.webContentLink || null,
            patientFolderId,
            folder.path,
            req.user.id || null,
            req.user.username || null,
          ]
        );
      } catch (e) {
        // Never fail the share because the index write failed.
        console.warn('[drive/save-report] document index failed:', e.message);
      }
    }

    res.json({
      ok: true,
      file: uploaded,
      folder_id: patientFolderId,
      wa_link: buildWhatsAppLink({
        phone: req.body.phone,
        text: `Treatment report for ${patient_code} (${stamp}): ${uploaded.webViewLink || ''}`,
      }),
    });
  } catch (e) {
    console.error('[drive/save-report]', e);
    res.status(500).json({ error: e.message || 'Drive upload failed' });
  }
});

// GET /api/drive/wa-link?phone=...&text=...
router.get('/wa-link', authRequired(), (req, res) => {
  res.json({ url: buildWhatsAppLink({ phone: req.query.phone, text: req.query.text || '' }) });
});

function buildWhatsAppLink({ phone, text }) {
  const t = encodeURIComponent(text || '');
  const cleanPhone = (phone || '').replace(/[^\d]/g, '');
  return cleanPhone
    ? `https://wa.me/${cleanPhone}?text=${t}`
    : `https://wa.me/?text=${t}`;
}

module.exports = router;
