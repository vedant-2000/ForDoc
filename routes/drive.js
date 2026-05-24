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

// POST /api/drive/save-report  multipart: file (pdf/jpg) + patient_code + session_date
router.post('/save-report', authRequired(), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  const { patient_code, patient_id, session_id, session_date, file_kind } = req.body || {};
  if (!patient_code) return res.status(400).json({ error: 'patient_code required' });

  try {
    const drive = await D.getDriveForAdmin(req.user.role === 'admin' ? req.user.id : null);
    const rootId = process.env.DRIVE_ROOT_FOLDER_ID || null;
    const patientFolderId = await D.findOrCreateFolder(drive, `Patient_${patient_code}`, rootId);

    const stamp = session_date || new Date().toISOString().slice(0, 10);
    const ext = (file_kind === 'jpg' ? 'jpg' : 'pdf');
    const name = `${patient_code}_${stamp}.${ext}`;

    const uploaded = await D.uploadFile(drive, {
      name,
      mimeType: req.file.mimetype || (ext === 'pdf' ? 'application/pdf' : 'image/jpeg'),
      buffer: req.file.buffer,
      parentId: patientFolderId,
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
