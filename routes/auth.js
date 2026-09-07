const express = require('express');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { query } = require('../db/pool');
const {
  sign, signAccess, authRequired, SERVICE_ACCESS_EXPIRES,
} = require('../middleware/auth');
const { sanitizeScreens } = require('../middleware/screens');

const router = express.Router();

// ── Service tokens ─────────────────────────────────────────────────────────
// Credentials of the account that machine clients act as — currently the iOS
// Shortcut that files PostureScreen PDFs. Kept in .env rather than typed into
// the app so nobody has to know the password to hand out a token, and so the
// account can be changed without touching code.
//
// This must be an account that already exists (make it through Admin →
// Doctors); nothing here creates one. Give it its own login rather than
// reusing a real person's, because every document it uploads is stamped with
// its name in uploaded_by_name.
const SERVICE_USERNAME = process.env.SHORTCUT_USERNAME || '';
const SERVICE_PASSWORD = process.env.SHORTCUT_PASSWORD || '';

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

// POST /api/auth/login   { username, password, role?: 'admin'|'doctor' }
// If role is omitted, tries admin then doctor.
router.post('/login', async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username & password required' });

  try {
    if (!role || role === 'admin') {
      const { rows } = await query('SELECT id, username, password_hash FROM admins WHERE username=$1', [username]);
      if (rows.length) {
        const ok = await bcrypt.compare(password, rows[0].password_hash);
        if (ok) {
          const token = sign({ id: rows[0].id, role: 'admin', username: rows[0].username });
          return res.json({ token, user: { id: rows[0].id, role: 'admin', username: rows[0].username } });
        }
        if (role === 'admin') return res.status(401).json({ error: 'Invalid credentials' });
      } else if (role === 'admin') {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }

    // doctor login
    const { rows: drows } = await query(
      `SELECT id, username, full_name, password_hash, color, is_active,
              screens
         FROM doctors WHERE username=$1`,
      [username]
    );
    if (!drows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const doc = drows[0];
    if (!doc.is_active) return res.status(403).json({ error: 'Account disabled' });
    const ok = await bcrypt.compare(password, doc.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // In the token as well as the response: authRequired reads this straight
    // off the payload, so no route has to hit the database to check access.
    // Sanitised on the way out so a key retired in a later build cannot keep
    // opening a screen from an old row.
    const screens = sanitizeScreens(doc.screens);
    const token = sign({
      id: doc.id,
      role: 'doctor',
      username: doc.username,
      screens,
    });
    res.json({
      token,
      user: {
        id: doc.id, role: 'doctor', username: doc.username,
        full_name: doc.full_name, color: doc.color,
        screens,
      }
    });
  } catch (e) {
    console.error('[auth/login]', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me — current profile
router.get('/me', authRequired(), async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      const { rows } = await query('SELECT id, username FROM admins WHERE id=$1', [req.user.id]);
      return res.json({ role: 'admin', user: rows[0] || null });
    }
    const { rows } = await query(
      'SELECT id, username, full_name, color, is_active FROM doctors WHERE id=$1',
      [req.user.id]
    );
    res.json({ role: 'doctor', user: rows[0] || null });
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// ── Service refresh tokens ─────────────────────────────────────────────────
// See db/migrations/006_service_refresh_tokens.sql for why these exist rather
// than just handing a phone a login JWT.

/// Resolve the .env service account against the database.
///
/// Both halves have to hold: the credentials must be configured AND they must
/// still be a valid, active login. That way disabling the account in Admin →
/// Doctors stops NEW tokens being issued, and clearing the env vars stops it
/// too, without either one depending on the other.
async function resolveServiceAccount() {
  if (!SERVICE_USERNAME || !SERVICE_PASSWORD) {
    return { error: 'SHORTCUT_USERNAME / SHORTCUT_PASSWORD are not set in .env' };
  }

  const { rows: arows } = await query(
    'SELECT id, username, password_hash FROM admins WHERE username=$1',
    [SERVICE_USERNAME]);
  if (arows.length) {
    const ok = await bcrypt.compare(SERVICE_PASSWORD, arows[0].password_hash);
    if (!ok) return { error: 'SHORTCUT_PASSWORD does not match that account' };
    return {
      subject: { id: arows[0].id, role: 'admin', username: arows[0].username },
    };
  }

  const { rows: drows } = await query(
    `SELECT id, username, full_name, password_hash, is_active, screens
       FROM doctors WHERE username=$1`,
    [SERVICE_USERNAME]);
  if (!drows.length) {
    return { error: `No account named "${SERVICE_USERNAME}" — create it in Admin → Doctors first` };
  }
  const d = drows[0];
  if (!d.is_active) return { error: `Account "${SERVICE_USERNAME}" is disabled` };
  const ok = await bcrypt.compare(SERVICE_PASSWORD, d.password_hash);
  if (!ok) return { error: 'SHORTCUT_PASSWORD does not match that account' };

  return {
    subject: {
      id: d.id,
      role: 'doctor',
      username: d.username,
      full_name: d.full_name,
      screens: sanitizeScreens(d.screens),
    },
  };
}

// POST /api/auth/refresh   { refresh_token }
//
// The only unauthenticated route here besides login, and deliberately so: the
// refresh token IS the credential. Returns a short-lived access token to put
// in an Authorization header.
router.post('/refresh', async (req, res) => {
  const raw = String((req.body || {}).refresh_token || '').trim();
  if (!raw) return res.status(400).json({ error: 'refresh_token required' });

  try {
    const { rows } = await query(
      `SELECT id, subject_id, subject_role, subject_name, revoked_at
         FROM service_refresh_tokens
        WHERE token_hash = $1`,
      [hashToken(raw)]);

    // One message for "no such token" and "revoked" alike: telling a caller
    // which one it was tells them whether they guessed a real token.
    if (!rows.length || rows[0].revoked_at) {
      return res.status(401).json({ error: 'Invalid or revoked refresh token' });
    }
    const t = rows[0];

    // Screens are re-read rather than taken from the row, so a permission an
    // admin removes today applies at the next refresh instead of living on in
    // a token issued months ago.
    let screens = [];
    if (t.subject_role === 'doctor') {
      const { rows: drows } = await query(
        'SELECT is_active, screens FROM doctors WHERE id=$1', [t.subject_id]);
      if (!drows.length || !drows[0].is_active) {
        return res.status(403).json({ error: 'Account disabled' });
      }
      screens = sanitizeScreens(drows[0].screens);
    }

    const token = signAccess({
      id: t.subject_id,
      role: t.subject_role,
      username: t.subject_name,
      ...(t.subject_role === 'doctor' ? { screens } : {}),
    });

    // Best-effort: a failed bookkeeping update must not cost the caller their
    // upload.
    query(
      `UPDATE service_refresh_tokens
          SET last_used_at = NOW(), use_count = use_count + 1
        WHERE id = $1`, [t.id],
    ).catch((e) => console.error('[auth/refresh] usage update', e.message));

    res.json({ token, expires_in: SERVICE_ACCESS_EXPIRES });
  } catch (e) {
    console.error('[auth/refresh]', e.message);
    res.status(500).json({ error: 'Refresh failed' });
  }
});

// GET /api/auth/service-tokens   (admin)
router.get('/service-tokens', authRequired(['admin']), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, label, subject_name, subject_role, created_at,
              last_used_at, use_count, revoked_at
         FROM service_refresh_tokens
        ORDER BY revoked_at IS NOT NULL, created_at DESC`);
    const account = await resolveServiceAccount();
    res.json({
      tokens: rows,
      // So the panel can say "set SHORTCUT_USERNAME in .env" instead of
      // failing only when somebody presses Issue.
      service_account: account.error ? null : account.subject.username,
      service_error: account.error || null,
    });
  } catch (e) {
    console.error('[auth/service-tokens list]', e.message);
    res.status(500).json({ error: 'Failed to list tokens' });
  }
});

// POST /api/auth/service-tokens   (admin)   { label }
//
// Returns the plaintext token ONCE. It is stored hashed, so there is no
// endpoint that can show it again — a lost token is reissued, not recovered.
router.post('/service-tokens', authRequired(['admin']), async (req, res) => {
  const label = String((req.body || {}).label || '').trim().slice(0, 120) || null;
  try {
    const account = await resolveServiceAccount();
    if (account.error) return res.status(400).json({ error: account.error });

    // 32 bytes of CSPRNG, base64url. Long enough that guessing is not a
    // threat model, short enough to paste into a Shortcut.
    const raw = crypto.randomBytes(32).toString('base64url');

    const { rows } = await query(
      `INSERT INTO service_refresh_tokens
         (token_hash, label, subject_id, subject_role, subject_name, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, label, created_at`,
      [
        hashToken(raw),
        label,
        account.subject.id,
        account.subject.role,
        account.subject.username,
        req.user.id || null,
      ]);

    res.status(201).json({ token: raw, ...rows[0] });
  } catch (e) {
    console.error('[auth/service-tokens create]', e.message);
    // The one failure worth naming: the migration has not been run.
    if (/service_refresh_tokens/.test(e.message) && /does not exist/i.test(e.message)) {
      return res.status(500).json({
        error: 'Table missing — run db/migrations/006_service_refresh_tokens.sql',
      });
    }
    res.status(500).json({ error: 'Failed to issue token' });
  }
});

// POST /api/auth/service-tokens/:id/revoke   (admin)
//
// Takes effect on the next refresh, so at most one access-token lifetime
// (SERVICE_ACCESS_EXPIRES, 15m) after the click — not instantly. That is the
// price of stateless access tokens, and it is a great deal better than the
// alternative, which was rotating JWT_SECRET and logging out the clinic.
router.post('/service-tokens/:id(\\d+)/revoke', authRequired(['admin']), async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE service_refresh_tokens
          SET revoked_at = NOW()
        WHERE id = $1 AND revoked_at IS NULL
        RETURNING id`, [+req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found or already revoked' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[auth/service-tokens revoke]', e.message);
    res.status(500).json({ error: 'Failed to revoke' });
  }
});

module.exports = router;
