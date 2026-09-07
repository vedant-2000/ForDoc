const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
// Default deliberately long. This is a clinic terminal that one team uses all
// day, not a public web app: an unconfigured server logging everyone out twice
// a day is a support call, not a security win. Shorten it, or set it to
// 'never', with JWT_EXPIRES_IN in .env.
const EXPIRES = process.env.JWT_EXPIRES_IN || '30d';

// Setting JWT_EXPIRES_IN to any of these makes sessions permanent: the token
// is signed WITHOUT an `exp` claim, so it never expires and the user is never
// logged out on their own. Revocation then depends entirely on rotating
// JWT_SECRET, which invalidates every outstanding token at once.
const NEVER_EXPIRES = ['never', 'none', 'infinite', 'infinity', 'off', '0']
  .includes(String(EXPIRES).trim().toLowerCase());

function sign(payload) {
  // Omitting `expiresIn` leaves the `exp` claim off the token entirely.
  return NEVER_EXPIRES
    ? jwt.sign(payload, SECRET)
    : jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
}

function verify(token) {
  return jwt.verify(token, SECRET);
}

/// Gate a route on role, or on ONE screen an admin has granted this doctor.
///
/// [roles]  null = any logged-in user; otherwise e.g. ['admin'].
/// [opts.screen]  the screen this route belongs to ('rooms', 'reports', …,
///                see middleware/screens.js). A doctor granted that screen
///                reaches this route; every other admin route stays shut.
///
/// There is deliberately NO blanket "treat this doctor as an admin" flag.
/// Access is per screen and nothing else, so granting Rooms cannot quietly
/// hand somebody the Doctors tab or the Drive settings. A doctor with every
/// screen ticked can do what an admin can, but only because an admin ticked
/// each one.
///
/// A route with no [screen] and roles ['admin'] stays admin-only, full stop —
/// that is the safe default for anything nobody has classified yet.
///
/// The list rides in the JWT, so revoking a screen takes effect when that
/// doctor's token is next issued. Tokens are long-lived by default
/// (JWT_EXPIRES_IN, 30d) - to cut access off at once, disable the account,
/// which is checked at login, or rotate JWT_SECRET.
function authRequired(roles = null, opts = {}) {
  const screen = opts.screen || null;
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const payload = verify(token);
      if (roles && !roles.includes(payload.role)) {
        const granted = screen !== null
          && Array.isArray(payload.screens)
          && payload.screens.includes(screen);
        if (!granted) return res.status(403).json({ error: 'Forbidden' });
      }
      req.user = payload;   // { id, role, username, screens? }
      next();
    } catch (e) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

module.exports = { sign, verify, authRequired };
