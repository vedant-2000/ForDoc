const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../db/pool');
const { sign, authRequired } = require('../middleware/auth');

const router = express.Router();

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
      'SELECT id, username, full_name, password_hash, color, is_active FROM doctors WHERE username=$1',
      [username]
    );
    if (!drows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const doc = drows[0];
    if (!doc.is_active) return res.status(403).json({ error: 'Account disabled' });
    const ok = await bcrypt.compare(password, doc.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = sign({ id: doc.id, role: 'doctor', username: doc.username });
    res.json({
      token,
      user: {
        id: doc.id, role: 'doctor', username: doc.username,
        full_name: doc.full_name, color: doc.color
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

module.exports = router;
