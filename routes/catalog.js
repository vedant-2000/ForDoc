// Treatment-catalog routes
// ────────────────────────
// GET  /api/catalog/treatments          → grouped: { R-1: ['SLT', ...], ... }
// GET  /api/catalog/treatments/flat     → flat:    [{ id, room, treatment, sort_order, is_active }]
// PUT  /api/catalog/treatments/:room    → admin: replace ALL treatments for one room
//        body: { treatments: ['SLT', 'IMS', ...] }
// POST /api/catalog/treatments          → admin: bulk replace
//        body: { catalog: { 'R-1': [...], 'R-2': [...] } }

const express = require('express');
const { query, tx } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Any authenticated user can read the catalog (the marker page needs it).
router.get('/treatments', authRequired(), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT room, treatment
         FROM treatment_catalog
        WHERE is_active = TRUE
        ORDER BY room, sort_order, treatment`
    );
    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.room]) grouped[r.room] = [];
      grouped[r.room].push(r.treatment);
    });
    res.json(grouped);
  } catch (e) {
    console.error('[catalog/treatments]', e);
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/treatments/flat', authRequired(), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, room, treatment, sort_order, is_active
         FROM treatment_catalog
        ORDER BY room, sort_order, treatment`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Failed' });
  }
});

// PUT /api/catalog/treatments/:room   body: { treatments: ['SLT', 'IMS', ...] }
// Replaces ALL treatments for one room (preserving order from the array).
router.put('/treatments/:room', authRequired(['admin']), async (req, res) => {
  const room = String(req.params.room || '').trim();
  if (!room) return res.status(400).json({ error: 'Room required' });
  const list = Array.isArray(req.body?.treatments) ? req.body.treatments : null;
  if (!list) return res.status(400).json({ error: 'treatments must be an array' });

  // De-dupe + trim, drop empties.
  const clean = [];
  const seen = new Set();
  for (const raw of list) {
    const t = String(raw || '').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(t);
  }

  try {
    const rows = await tx(async (c) => {
      await c.query('DELETE FROM treatment_catalog WHERE room = $1', [room]);
      for (let i = 0; i < clean.length; i++) {
        await c.query(
          `INSERT INTO treatment_catalog (room, treatment, sort_order)
           VALUES ($1, $2, $3)`,
          [room, clean[i], i]
        );
      }
      const { rows: r } = await c.query(
        `SELECT id, room, treatment, sort_order
           FROM treatment_catalog
          WHERE room = $1 AND is_active = TRUE
          ORDER BY sort_order`,
        [room]
      );
      return r;
    });
    res.json({ room, treatments: rows.map(r => r.treatment), detail: rows });
  } catch (e) {
    console.error('[catalog/treatments PUT]', e);
    res.status(500).json({ error: 'Save failed' });
  }
});

// POST /api/catalog/treatments  body: { catalog: { 'R-1': [...], ... } }
// Bulk replace — wipes and re-seeds the whole catalog.
router.post('/treatments', authRequired(['admin']), async (req, res) => {
  const cat = req.body?.catalog;
  if (!cat || typeof cat !== 'object') {
    return res.status(400).json({ error: 'catalog object required' });
  }
  try {
    await tx(async (c) => {
      await c.query('DELETE FROM treatment_catalog');
      for (const [room, list] of Object.entries(cat)) {
        if (!Array.isArray(list)) continue;
        const seen = new Set();
        let idx = 0;
        for (const raw of list) {
          const t = String(raw || '').trim();
          if (!t) continue;
          const key = t.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          await c.query(
            `INSERT INTO treatment_catalog (room, treatment, sort_order)
             VALUES ($1, $2, $3)`,
            [String(room).trim(), t, idx++]
          );
        }
      }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[catalog/treatments POST]', e);
    res.status(500).json({ error: 'Save failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Sitting positions (single global list)
// ─────────────────────────────────────────────────────────────

// GET /api/catalog/sitting-positions → ['Sitting','Standing',...]
router.get('/sitting-positions', authRequired(), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT position FROM sitting_positions
        WHERE is_active = TRUE
        ORDER BY sort_order, position`
    );
    res.json(rows.map(r => r.position));
  } catch (e) {
    console.error('[catalog/sitting-positions GET]', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// PUT /api/catalog/sitting-positions   body: { positions: ['Sitting','Standing',...] }
// Admin: replace ALL sitting positions (preserving order from the array).
router.put('/sitting-positions', authRequired(['admin']), async (req, res) => {
  const list = Array.isArray(req.body?.positions) ? req.body.positions : null;
  if (!list) return res.status(400).json({ error: 'positions must be an array' });

  const clean = [];
  const seen = new Set();
  for (const raw of list) {
    const p = String(raw || '').trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(p);
  }

  try {
    const rows = await tx(async (c) => {
      await c.query('DELETE FROM sitting_positions');
      for (let i = 0; i < clean.length; i++) {
        await c.query(
          `INSERT INTO sitting_positions (position, sort_order) VALUES ($1, $2)`,
          [clean[i], i]
        );
      }
      const { rows: r } = await c.query(
        `SELECT position FROM sitting_positions
          WHERE is_active = TRUE
          ORDER BY sort_order`
      );
      return r;
    });
    res.json({ positions: rows.map(r => r.position) });
  } catch (e) {
    console.error('[catalog/sitting-positions PUT]', e);
    res.status(500).json({ error: 'Save failed' });
  }
});

module.exports = router;
