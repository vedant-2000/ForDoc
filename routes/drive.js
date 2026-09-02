const fs   = require('fs');
const path = require('path');
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
  // Never fails hard: this is the endpoint the UI polls to decide whether to
  // show "Drive connected", so it has to answer even when the DB is unhappy.
  try {
    const { rows } = await query(
      'SELECT admin_id, updated_at FROM drive_tokens LIMIT 1'
    );
    res.json({
      configured: isConfigured(),
      connected: !!rows.length,
      info: rows[0] || null,
    });
  } catch (e) {
    console.error('[drive/status]', e);
    res.status(500).json({ error: 'Could not read Drive status' });
  }
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

// GET /api/drive/find-folder?code=12565            (admin)
//
// Answers "why is this patient not matching?" without guessing.
//
// The worklist and the reconcile report only ever look at the DIRECT children
// of the configured base folder - Drive's `'<id>' in parents` - so a folder
// that is nested deeper, or sitting in a different tree entirely, is invisible
// to them no matter how well its name matches. That is indistinguishable, on
// screen, from "the code does not match", and the two need completely
// different fixes.
//
// This searches the WHOLE Drive by name in one API call and reports the full
// path of every hit, plus whether that hit is inside the current base. So the
// answer is either "your base folder is pointed at the wrong place", "these
// folders are nested too deep", or "nothing in Drive carries this code".
router.get('/find-folder', authRequired(['admin']), async (req, res) => {
  const code = String(req.query.code || '').trim();
  const name = String(req.query.name || '').trim();
  if (!code && !name) {
    return res.status(400).json({
      error: 'code or name is required', code: 'bad_request',
    });
  }
  try {
    const settings = await D.getSettings();
    const drive = await D.getDriveForAdmin(req.user.id);
    const baseId = await D.baseFolderId(drive, settings);

    // Drive's own search: finds the folder at ANY depth, in one call each.
    // Two searches because Drive has no OR across `name contains` terms, and
    // a clinic that files by name has folders the code alone will never find.
    const seenIds = new Set();
    const hits = [];
    for (const term of [code, name].filter(Boolean)) {
      for (const f of await D.listFolders(drive, { q: term, fresh: true })) {
        if (seenIds.add(f.id)) hits.push(f);
      }
    }

    // Then filter properly. Drive's `contains` is loose - searching 256 will
    // happily return 12565 - so the code must match as a whole token, and the
    // name as a normalised substring.
    const re = code ? D.patientCodeRegExp(code) : null;
    const nameNorm = name ? D.normalizeFolderName(name) : '';
    const matched = [];
    for (const f of hits) {
      const norm = D.normalizeFolderName(f.name);
      const byCode = re != null && re.test(norm);
      const byName = nameNorm.length > 2 && norm.includes(nameNorm);
      if (!byCode && !byName) continue;
      matched.push({
        ...f,
        matched_on: byCode && byName ? 'both' : (byCode ? 'code' : 'name'),
      });
    }
    // Strongest evidence first: a code AND name hit is almost certainly the
    // same patient; a bare name hit could be a different person entirely.
    const rank = { both: 0, code: 1, name: 2 };
    matched.sort((a, b) => rank[a.matched_on] - rank[b.matched_on]);

    // Direct children of the base, to say whether each hit is reachable.
    let baseChildren = [];
    try {
      baseChildren = await D.listFolders(drive, { parentId: baseId || 'root' });
    } catch { /* base unreadable - reported as in_base:false below */ }
    const inBase = new Set(baseChildren.map((f) => f.id));

    const out = [];
    for (const f of matched.slice(0, 25)) {
      out.push({
        id: f.id,
        name: f.name,
        path: await D.folderPath(drive, f.id),
        in_base: inBase.has(f.id),
        matched_on: f.matched_on,
      });
    }

    res.json({
      code,
      name,
      base_folder_id: baseId,
      base_folder_path: baseId ? await D.folderPath(drive, baseId) : null,
      base_child_count: baseChildren.length,
      name_hits: hits.length,
      matches: out,
      // The whole point: says which of the three problems this is.
      verdict: out.length === 0
        ? 'no_folder_in_drive'
        : (out.some((m) => m.in_base)
            ? 'ok_in_base'
            : 'found_outside_base'),
    });
  } catch (e) {
    const err = D.classifyDriveError(e);
    console.error('[drive/find-folder]', err.message);
    res.status(err.status || 500).json({ error: err.message, code: err.code });
  }
});

// GET /api/drive/reconcile   (admin)
//
// Cross-check the patient list against the folders actually sitting in the
// base folder, and report the three populations that matter:
//
//   matched            a patient and a folder that belong together
//   unmatched_patients a patient with no folder in the base
//   orphan_folders     a folder with no patient - usually a record the
//                      clinic has on Drive but never entered into the app,
//                      which is exactly the list worth working through
//
// Read-only: nothing is created, moved or linked here. It answers "how far
// apart are these two lists" so the admin can decide what to do about it.
router.get('/reconcile', authRequired(['admin']), async (req, res) => {
  try {
    const settings = await D.getSettings();
    const drive = await D.getDriveForAdmin(req.user.id);
    const baseId = await D.baseFolderId(drive, settings);
    if (!baseId) {
      return res.status(400).json({
        error: 'No base folder is configured in Admin -> Google Drive.',
      });
    }
    const basePath = await D.folderPath(drive, baseId);
    // fresh: this report's whole purpose is Drive's CURRENT truth. A cached
    // listing would have it confidently describe a Drive that stopped
    // existing up to a minute ago.
    const folders = await D.listFolders(drive, { parentId: baseId, fresh: true });

    const { rows: patients } = await query(
      `SELECT id, patient_code, full_name, drive_folder_id
         FROM patients WHERE deleted_at IS NULL
        ORDER BY patient_code ASC`);

    // Index folders by id so a linked patient is O(1), and keep a working
    // copy to strike matches off - whatever survives is an orphan.
    const byId = new Map(folders.map((f) => [f.id, f]));
    const unclaimed = new Map(folders.map((f) => [f.id, f]));

    const matched = [];
    const unmatchedPatients = [];

    for (const p of patients) {
      // 1. Already linked AND the folder really is in the base.
      if (p.drive_folder_id && byId.has(p.drive_folder_id)) {
        const f = byId.get(p.drive_folder_id);
        unclaimed.delete(f.id);
        matched.push({
          id: p.id,
          patient_code: p.patient_code,
          full_name: p.full_name,
          folder_id: f.id,
          folder_name: f.name,
          how: 'linked',
        });
        continue;
      }

      // 2. Not linked (or linked elsewhere): does a folder here carry the
      //    patient's code as a whole token?
      const codeRe = D.patientCodeRegExp(p.patient_code);
      const nameNorm = D.normalizeFolderName(p.full_name);
      let best = null;
      if (codeRe) {
        for (const f of unclaimed.values()) {
          const n = D.normalizeFolderName(f.name);
          if (!codeRe.test(n)) continue;
          const alsoName = nameNorm.length > 1 && n.includes(nameNorm);
          const score = alsoName ? 80 : 50;
          if (!best || score > best.score) {
            best = { f, score, how: alsoName ? 'code+name' : 'code' };
          }
        }
      }
      if (best) {
        unclaimed.delete(best.f.id);
        matched.push({
          id: p.id,
          patient_code: p.patient_code,
          full_name: p.full_name,
          folder_id: best.f.id,
          folder_name: best.f.name,
          how: best.how,
        });
      } else {
        unmatchedPatients.push({
          id: p.id,
          patient_code: p.patient_code,
          full_name: p.full_name,
          linked_elsewhere: !!p.drive_folder_id,
        });
      }
    }

    // Whatever folders are left over. Guess a code and a name out of each so
    // the admin can create the patient without retyping - a guess only, and
    // presented as one.
    const orphans = [...unclaimed.values()].map((f) => {
      const g = guessCodeAndName(f.name);
      return { id: f.id, name: f.name, guess_code: g.code, guess_name: g.name };
    });

    res.json({
      base_folder_id: baseId,
      base_folder_path: basePath,
      summary: {
        patients: patients.length,
        matched: matched.length,
        unmatched_patients: unmatchedPatients.length,
        folders: folders.length,
        orphan_folders: orphans.length,
      },
      matched,
      unmatched_patients: unmatchedPatients,
      orphan_folders: orphans,
    });
  } catch (e) {
    console.error('[drive/reconcile]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Pull a plausible patient code and name out of a folder name.
//
// Purely a convenience for pre-filling the "create patient" form, and shown
// to the admin as a suggestion to correct - clinic folder names are far too
// varied for this to be trusted:
//
//   "A.K Garg 25.06.18 (Toc-7551)"  -> code Toc-7551, name A.K Garg 25.06.18
//   "P-042 - Asha Rao"              -> code P-042,    name Asha Rao
//   "Asha Rao - P-042"              -> code P-042,    name Asha Rao
function guessCodeAndName(raw) {
  const name = String(raw || '').trim();

  // Bracketed text is nearly always the code in practice.
  const bracket = name.match(/[([]([^)\]]+)[)\]]\s*$/);
  if (bracket) {
    return {
      code: bracket[1].trim(),
      name: name.slice(0, bracket.index).trim().replace(/[-_\s]+$/, ''),
    };
  }

  // Otherwise split on a dash and take whichever side looks more like a code:
  // shorter, and containing a digit.
  const parts = name.split(/\s+[-\u2013\u2014_]\s+/);
  if (parts.length === 2) {
    const [a, b] = parts.map((x) => x.trim());
    const codeish = (x) => /\d/.test(x) && x.length <= 20;
    if (codeish(a) && !codeish(b)) return { code: a, name: b };
    if (codeish(b) && !codeish(a)) return { code: b, name: a };
    return { code: a, name: b };
  }
  return { code: '', name };
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

// GET /api/drive/folder-info?id=<folder id OR any Drive URL>   (admin)
//
// Resolves one folder by id, so the admin can paste a link to somewhere the
// browser cannot reach by clicking. Browsing starts at My Drive ('root'),
// but a folder synced from a PC by Drive for Desktop sits in the Computers
// section under a machine root that is not a child of 'root' - unreachable
// from the top, yet perfectly usable once its id is known. Shared-drive
// folders have the same shape.
router.get('/folder-info', authRequired(['admin']), async (req, res) => {
  const raw = String(req.query.id || '').trim();
  if (!raw) return res.status(400).json({ error: 'id required' });

  // Accept a bare id or any of the URL shapes Drive hands out:
  //   https://drive.google.com/drive/folders/<id>?usp=sharing
  //   https://drive.google.com/drive/u/0/folders/<id>
  //   https://drive.google.com/open?id=<id>
  let id = raw;
  const m = raw.match(/\/folders\/([A-Za-z0-9_-]+)/)
    || raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (m) id = m[1];
  else if (/^https?:/i.test(raw)) {
    return res.status(400).json({
      error: 'That link has no folder id in it. Open the folder in Drive and '
        + 'copy the address, or use Share -> Copy link.',
    });
  }

  try {
    const drive = await D.getDriveForAdmin(req.user.id);
    const { data } = await drive.files.get({
      fileId: id,
      fields: 'id,name,mimeType,driveId,trashed',
      supportsAllDrives: true,
    });
    if (data.mimeType !== 'application/vnd.google-apps.folder') {
      return res.status(400).json({ error: 'That link points to a file, not a folder.' });
    }
    if (data.trashed) {
      return res.status(400).json({ error: 'That folder is in the Drive trash.' });
    }
    const path = await D.folderPath(drive, data.id);
    res.json({ id: data.id, name: data.name, path });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    res.status(/not found|404/i.test(msg) ? 404 : 500).json({
      error: /not found|404/i.test(msg)
        ? 'No folder with that id is visible to the connected Google account.'
        : msg,
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
    // png is the default now: the "PDF" was only ever the same PNG wrapped in
    // an A4 page, and an image previews inline everywhere a PDF does not -
    // Drive's own grid, the report thumbnails, the in-app viewer, and a
    // WhatsApp link. pdf and jpg still work for anything that asks for them.
    const KINDS = { png: 'png', jpg: 'jpg', pdf: 'pdf' };
    const ext = KINDS[String(file_kind || '').toLowerCase()] || 'png';

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

    // Derived from ext, NOT from req.file.mimetype.
    //
    // The client uploads through MultipartFile.fromBytes without a content
    // type, so multer reports application/octet-stream - which was being
    // stored verbatim. Every later "is this an image?" / "is this a PDF?"
    // check then failed, which is why treatment records showed no thumbnail
    // and no preview. We rendered this file ourselves, so we know what it is.
    const MIMES = {
      png: 'image/png',
      jpg: 'image/jpeg',
      pdf: 'application/pdf',
    };
    const mimeType = MIMES[ext];

    // One treatment record per session, updated in place.
    //
    // Every press of Save re-exports the same session, so creating a new
    // Drive file each time would bury the patient's folder in near-identical
    // PDFs and leave every previously shared link pointing at a stale one.
    // Replacing the existing file's content keeps a single current record
    // and keeps old links live.
    let existing = null;
    if (session_id) {
      const { rows } = await query(
        `SELECT id, drive_file_id, filename FROM patient_documents
          WHERE session_id = $1 AND category = 'treatment'
            AND drive_file_id IS NOT NULL AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 1`,
        [+session_id]);
      if (rows.length) existing = rows[0];
    }

    let uploaded;
    if (existing) {
      try {
        uploaded = await D.updateFileContent(drive, {
          fileId: existing.drive_file_id,
          mimeType,
          buffer: req.file.buffer,
          name,
        });
      } catch (e) {
        // The file was deleted or moved out of reach in Drive - fall back to
        // creating a fresh one rather than failing the save.
        console.warn('[drive/save-report] update failed, creating new:', e.message);
        existing = null;
      }
    }
    if (!uploaded) {
      uploaded = await D.uploadFile(drive, {
        name,
        mimeType,
        buffer: req.file.buffer,
        parentId: patientFolderId,
        makePublic: settings.make_links_public !== false,
      });
    }

    // Keep a LOCAL copy too, exactly like every other document.
    //
    // This route used to hand the buffer straight to Drive and store only a
    // link, which left patient_documents.filename NULL. Every screen that
    // renders a document from our own server - thumbnails, the in-app viewer -
    // then had nothing to show and fell back to "only on Google Drive". It
    // also meant the clinic's own copy of a treatment record lived solely in
    // someone's Google account.
    const DOCS_DIR = path.join(__dirname, '..', 'uploads', 'patient-docs');
    if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
    let localName = null;
    try {
      // Reuse the row's existing file on a re-save so repeated presses of Save
      // overwrite one file instead of littering the disk, mirroring what the
      // Drive side already does.
      if (existing && existing.filename) {
        localName = existing.filename;
      } else {
        localName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${name}`
          .replace(/[^a-zA-Z0-9._-]/g, '_');
      }
      fs.writeFileSync(path.join(DOCS_DIR, localName), req.file.buffer);
    } catch (e) {
      // A disk problem must not lose the Drive upload that already succeeded.
      console.warn('[drive/save-report] local copy failed:', e.message);
      localName = null;
    }

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

      // Keep the Documents-page row in step with the file.
      try {
        if (existing) {
          await query(
            `UPDATE patient_documents
                SET drive_view_link=$2, drive_download_link=$3, doc_date=$4,
                    original_name=$5, size_bytes=$6, sync_status='synced',
                    sync_error=NULL,
                    filename=COALESCE($7, filename),
                    mime_type=$8
              WHERE id=$1`,
            [existing.id, uploaded.webViewLink || null,
             uploaded.webContentLink || null, stamp, name,
             req.file.size || null, localName, mimeType]);
          throw { __handled: true };
        }
        await query(
          `INSERT INTO patient_documents
             (patient_id, session_id, category, title, doc_date,
              original_name, filename, mime_type, size_bytes,
              drive_file_id, drive_view_link, drive_download_link,
              drive_folder_id, drive_path, sync_status,
              uploaded_by, uploaded_by_name)
           VALUES ($1,$2,'treatment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'synced',$14,$15)`,
          [
            +patient_id,
            session_id ? +session_id : null,
            'Treatment record (' + ext.toUpperCase() + ')',
            stamp,
            name,
            localName,
            mimeType,
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
        if (!e || !e.__handled) {
          console.warn('[drive/save-report] document index failed:',
            e && e.message);
        }
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
