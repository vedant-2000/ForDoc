// Treatment-catalog routes
// ────────────────────────
// GET  /api/catalog/rooms               → [{ id, name, sort_order, is_active }, ...]
// POST /api/catalog/rooms               → admin: create a room  body: { name, sort_order? }
// PUT  /api/catalog/rooms/:id           → admin: rename room    body: { name, sort_order? }
//                                          renames cascade to treatment_catalog.room,
//                                          marks.room and marks.room_ids[].
// DELETE /api/catalog/rooms/:id         → admin: remove room + its treatments
// GET  /api/catalog/treatments          → grouped: { '1': ['SLT', ...], ... }
// GET  /api/catalog/treatments/flat     → flat:    [{ id, room, treatment, sort_order, is_active }]
// PUT  /api/catalog/treatments/:room    → admin: replace ALL treatments for one room
//        body: { treatments: ['SLT', 'IMS', ...] }
// POST /api/catalog/treatments          → admin: bulk replace
//        body: { catalog: { '1': [...], '2': [...] } }

const express = require('express');
const { query, tx } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

// Any authenticated user can read the catalog (the marker page needs it).
// Treatments inside each room are returned in the global priority order
// curated in the Treatment Colors admin panel (treatments_palette.sort_order),
// so the LabelSheet's top-5 chips are the most-important treatments.
router.get('/treatments', authRequired(), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT tc.room, tc.treatment
         FROM treatment_catalog tc
         LEFT JOIN treatments_palette tp ON tp.treatment = tc.treatment
        WHERE tc.is_active = TRUE
        ORDER BY tc.room, COALESCE(tp.sort_order, 999), tc.treatment`
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

// GET /api/catalog/effectiveness → ['1Q','2Q',...]
router.get('/effectiveness', authRequired(), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT label FROM effectiveness_options
        WHERE is_active = TRUE
        ORDER BY sort_order, label`
    );
    res.json(rows.map(r => r.label));
  } catch (e) {
    console.error('[catalog/effectiveness GET]', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// PUT /api/catalog/effectiveness   body: { options: ['1Q','2Q',...] }
// Admin: replace the whole list, preserving the array's order.
router.put('/effectiveness', authRequired(['admin']), async (req, res) => {
  const list = Array.isArray(req.body?.options) ? req.body.options : null;
  if (!list) return res.status(400).json({ error: 'options must be an array' });

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
      await c.query('DELETE FROM effectiveness_options');
      for (let i = 0; i < clean.length; i++) {
        await c.query(
          `INSERT INTO effectiveness_options (label, sort_order) VALUES ($1, $2)`,
          [clean[i], i]
        );
      }
      const { rows: r } = await c.query(
        `SELECT label FROM effectiveness_options
          WHERE is_active = TRUE
          ORDER BY sort_order`
      );
      return r;
    });
    res.json({ options: rows.map(r => r.label) });
  } catch (e) {
    console.error('[catalog/effectiveness PUT]', e);
    res.status(500).json({ error: 'Save failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Rooms (editable list of treatment-room names)
// ─────────────────────────────────────────────────────────────

// GET /api/catalog/rooms
router.get('/rooms', authRequired(), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, name, sort_order, is_active
         FROM rooms
        WHERE is_active = TRUE
        ORDER BY sort_order, name`
    );
    res.json(rows);
  } catch (e) {
    console.error('[catalog/rooms GET]', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// POST /api/catalog/rooms   body: { name, sort_order? }
router.post('/rooms', authRequired(['admin']), async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  const sortOrder = Number.isFinite(+req.body?.sort_order) ? +req.body.sort_order : 0;
  try {
    const { rows } = await query(
      `INSERT INTO rooms (name, sort_order) VALUES ($1, $2)
       RETURNING id, name, sort_order, is_active`,
      [name, sortOrder]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: `Room "${name}" already exists.` });
    }
    console.error('[catalog/rooms POST]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

// PUT /api/catalog/rooms/:id   body: { name?, sort_order? }
// Renaming cascades: every treatment_catalog.room, marks.room, and
// marks.room_ids[] entry that referenced the old name is updated atomically.
router.put('/rooms/:id', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });
  const nextName = req.body?.name != null ? String(req.body.name).trim() : null;
  const nextSort = Number.isFinite(+req.body?.sort_order) ? +req.body.sort_order : null;
  if (nextName === '') return res.status(400).json({ error: 'name cannot be empty' });

  try {
    const updated = await tx(async (c) => {
      const { rows: cur } = await c.query(
        `SELECT id, name FROM rooms WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (!cur.length) return null;
      const oldName = cur[0].name;
      const newName = nextName ?? oldName;

      // Cascade renames first so the rooms.name update can't violate UNIQUE
      // while leaving orphan references behind.
      if (nextName != null && nextName !== oldName) {
        await c.query(`UPDATE treatment_catalog SET room = $1 WHERE room = $2`, [newName, oldName]);
        await c.query(`UPDATE marks SET room = $1 WHERE room = $2`, [newName, oldName]);
        await c.query(
          `UPDATE marks
              SET room_ids = ARRAY(
                SELECT CASE WHEN x = $2 THEN $1 ELSE x END
                FROM   unnest(room_ids) AS x
              )
            WHERE $2 = ANY(room_ids)`,
          [newName, oldName]
        );
      }

      const { rows } = await c.query(
        `UPDATE rooms
            SET name       = COALESCE($2, name),
                sort_order = COALESCE($3, sort_order)
          WHERE id = $1
          RETURNING id, name, sort_order, is_active`,
        [id, nextName, nextSort]
      );
      return rows[0];
    });
    if (!updated) return res.status(404).json({ error: 'Room not found' });
    res.json(updated);
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: `Another room with that name already exists.` });
    }
    console.error('[catalog/rooms PUT]', e);
    res.status(500).json({ error: 'Save failed' });
  }
});

// DELETE /api/catalog/rooms/:id
// Removes the room and every treatment registered against it. Marks keep
// their historical room reference as a denormalised string snapshot.
router.delete('/rooms/:id', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id required' });
  try {
    const ok = await tx(async (c) => {
      const { rows } = await c.query(`SELECT name FROM rooms WHERE id = $1`, [id]);
      if (!rows.length) return false;
      const name = rows[0].name;
      await c.query(`DELETE FROM treatment_catalog WHERE room = $1`, [name]);
      await c.query(`DELETE FROM rooms WHERE id = $1`, [id]);
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Room not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[catalog/rooms DELETE]', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Treatment color palette — global priority list that decides which
// 10-color palette slot each treatment renders in. Top 10 get distinct
// colors; anything beyond wraps. Admin reorders to surface the most-used
// treatments to the top.
// ─────────────────────────────────────────────────────────────

// GET /api/catalog/treatment-palette → [{ treatment, sort_order }, ...]
router.get('/treatment-palette', authRequired(), async (_req, res) => {
  try {
    // Auto-sync: any treatments present in the catalog but missing from the
    // palette are appended at the end (alphabetical) so they show up in the
    // admin UI without a manual seeding step.
    await query(
      `WITH missing AS (
         SELECT DISTINCT tc.treatment
           FROM treatment_catalog tc
           LEFT JOIN treatments_palette tp ON tp.treatment = tc.treatment
          WHERE tc.treatment IS NOT NULL AND tp.id IS NULL
       ),
       max_order AS (SELECT COALESCE(MAX(sort_order), 0) AS m FROM treatments_palette),
       numbered  AS (
         SELECT treatment,
                (SELECT m FROM max_order) + ROW_NUMBER() OVER (ORDER BY treatment) AS sort_order
           FROM missing
       )
       INSERT INTO treatments_palette (treatment, sort_order)
       SELECT treatment, sort_order FROM numbered
       ON CONFLICT (treatment) DO NOTHING`
    );

    const { rows } = await query(
      `SELECT treatment, sort_order FROM treatments_palette
        ORDER BY sort_order, treatment`
    );
    res.json(rows);
  } catch (e) {
    console.error('[catalog/treatment-palette GET]', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// PUT /api/catalog/treatment-palette   body: { treatments: ['A','B',...] }
// Atomic replace of treatment ordering only — colors are managed separately
// via the global /color-palette routes.
router.put('/treatment-palette', authRequired(['admin']), async (req, res) => {
  const list = Array.isArray(req.body?.treatments) ? req.body.treatments : null;
  if (!list) return res.status(400).json({ error: 'treatments must be an array' });
  try {
    await tx(async (c) => {
      await c.query(`UPDATE treatments_palette SET sort_order = 999`);
      for (let i = 0; i < list.length; i++) {
        const t = String(list[i] || '').trim();
        if (!t) continue;
        await c.query(
          `INSERT INTO treatments_palette (treatment, sort_order) VALUES ($1, $2)
           ON CONFLICT (treatment) DO UPDATE SET sort_order = EXCLUDED.sort_order`,
          [t, i + 1]
        );
      }
    });
    const { rows } = await query(
      `SELECT treatment, sort_order FROM treatments_palette
        ORDER BY sort_order, treatment`
    );
    res.json(rows);
  } catch (e) {
    console.error('[catalog/treatment-palette PUT]', e);
    res.status(500).json({ error: 'Save failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Global color palette — N colors (default 8) that repeat. The Nth
// treatment (by priority order) renders in colors[N mod size].
// ─────────────────────────────────────────────────────────────

// GET /api/catalog/color-palette → ['#c0392b', '#2980b9', ...]
router.get('/color-palette', authRequired(), async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT color FROM color_palette ORDER BY sort_order, id`
    );
    res.json(rows.map(r => r.color));
  } catch (e) {
    console.error('[catalog/color-palette GET]', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// PUT /api/catalog/color-palette   body: { colors: ['#rrggbb', ...] }
// Atomic replace. Order in the array = priority order.
router.put('/color-palette', authRequired(['admin']), async (req, res) => {
  const list = Array.isArray(req.body?.colors) ? req.body.colors : null;
  if (!list) return res.status(400).json({ error: 'colors must be an array' });

  const normHex = (v) => {
    if (v == null || v === '') return null;
    const s = String(v).trim();
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s.toLowerCase() : null;
  };
  const cleaned = [];
  for (const raw of list) {
    const c = normHex(raw);
    if (c) cleaned.push(c);
  }
  if (!cleaned.length) return res.status(400).json({ error: 'no valid hex colors provided' });

  try {
    await tx(async (c) => {
      await c.query(`DELETE FROM color_palette`);
      for (let i = 0; i < cleaned.length; i++) {
        await c.query(
          `INSERT INTO color_palette (color, sort_order) VALUES ($1, $2)`,
          [cleaned[i], i + 1]
        );
      }
    });
    const { rows } = await query(
      `SELECT color FROM color_palette ORDER BY sort_order, id`
    );
    res.json(rows.map(r => r.color));
  } catch (e) {
    console.error('[catalog/color-palette PUT]', e);
    res.status(500).json({ error: 'Save failed' });
  }
});

module.exports = router;
