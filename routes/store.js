// Store / inventory routes.
//
// Category tree lives in `store_categories.path` (ltree). Items reference a
// category by full path (`category_path`). Inward & outward are separate log
// tables — current stock is derived on read.
//
// Auth model: any logged-in user (admin or doctor) can read + record inward
// and outward. Structural changes (creating/renaming/deleting categories &
// items) are admin-only, mirroring the treatment-catalog admin panels.

const express = require('express');
const { query } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired());

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

// ltree labels can be [A-Za-z0-9_] only, with '.' as separator. Sanitize the
// slug we auto-generate from a display name so admins can enter human names
// without worrying about path validity.
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'x';
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function requireNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}
function clampLimitOffset(req) {
  const rawL = parseInt(req.query.limit, 10);
  const rawO = parseInt(req.query.offset, 10);
  return {
    limit:  Number.isFinite(rawL) ? Math.max(1, Math.min(200, rawL)) : 20,
    offset: Number.isFinite(rawO) ? Math.max(0, rawO)               : 0,
  };
}

// ─────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────

// GET /api/store/categories?under=medicines&depth=2
// - `under` (optional) → only return descendants of that path
// - `depth` (optional) → cap depth relative to `under` (nlevel)
router.get('/categories', async (req, res) => {
  const under = (req.query.under || '').trim();
  const depth = parseInt(req.query.depth, 10);
  try {
    const params = [];
    let where = 'WHERE is_active = TRUE';
    if (under) {
      params.push(under);
      where += ` AND path <@ $${params.length}`;
      if (Number.isFinite(depth)) {
        params.push(depth);
        where += ` AND nlevel(path) - nlevel($1) <= $${params.length}`;
      }
    }
    const { rows } = await query(
      `SELECT id, path::text AS path, name, sort_order, is_active, created_at
         FROM store_categories
         ${where}
        ORDER BY path`,
      params,
    );
    res.json(rows);
  } catch (e) {
    console.error('[store/categories/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// POST /api/store/categories { parent_path?, name, sort_order? }
router.post('/categories', authRequired(['admin']), async (req, res) => {
  const { parent_path, name, sort_order } = req.body || {};
  const trimmed = String(name || '').trim();
  if (!trimmed) return res.status(400).json({ error: 'name required' });
  const slug = slugify(trimmed);
  const path = parent_path && String(parent_path).trim()
    ? `${String(parent_path).trim()}.${slug}`
    : slug;
  try {
    const { rows } = await query(
      `INSERT INTO store_categories (path, name, sort_order)
       VALUES ($1::ltree, $2, $3)
       RETURNING id, path::text AS path, name, sort_order, is_active, created_at`,
      [path, trimmed, Number.isFinite(+sort_order) ? +sort_order : 0],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'Category already exists at that path' });
    }
    console.error('[store/categories/create]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

// PATCH /api/store/categories/:id { name?, sort_order? }
// Renames the LABEL only (display name). Path itself is immutable; if you
// really need to move a subtree, delete & recreate.
router.patch('/categories/:id', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  const { name, sort_order, is_active } = req.body || {};
  const sets = [];
  const params = [];
  if (name != null) {
    sets.push(`name = $${sets.length + 1}`);
    params.push(String(name).trim());
  }
  if (Number.isFinite(+sort_order)) {
    sets.push(`sort_order = $${sets.length + 1}`);
    params.push(+sort_order);
  }
  if (typeof is_active === 'boolean') {
    sets.push(`is_active = $${sets.length + 1}`);
    params.push(is_active);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  params.push(id);
  try {
    const { rows } = await query(
      `UPDATE store_categories SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, path::text AS path, name, sort_order, is_active, created_at`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[store/categories/update]', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

// DELETE /api/store/categories/:id — soft delete (is_active=false).
router.delete('/categories/:id', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  try {
    const r = await query('UPDATE store_categories SET is_active=FALSE WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[store/categories/delete]', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Items
// ─────────────────────────────────────────────────────────────

// GET /api/store/items?category=medicines.antibiotics&q=amoxi&include_descendants=1&limit=&offset=
router.get('/items', async (req, res) => {
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();
  const includeDescendants = req.query.include_descendants === '1'
    || req.query.include_descendants === 'true';
  const { limit, offset } = clampLimitOffset(req);

  const where = ['i.is_active = TRUE'];
  const params = [];
  if (category) {
    params.push(category);
    if (includeDescendants) {
      where.push(`i.category_path <@ $${params.length}::ltree`);
    } else {
      where.push(`i.category_path = $${params.length}::ltree`);
    }
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(LOWER(i.name) LIKE $${params.length} OR LOWER(COALESCE(i.code,'')) LIKE $${params.length})`);
  }
  params.push(limit); params.push(offset);
  try {
    const { rows } = await query(
      `SELECT i.id, i.category_path::text AS category_path, i.name, i.code, i.unit,
              i.notes, i.is_active, i.created_at, i.updated_at,
              COALESCE(inw.total_in,  0)::float AS total_in,
              COALESCE(out.total_out, 0)::float AS total_out,
              COALESCE(inw.total_in, 0)::float - COALESCE(out.total_out, 0)::float AS on_hand,
              inw.last_price::float AS last_price
         FROM store_items i
         LEFT JOIN (
           SELECT item_id,
                  SUM(quantity) AS total_in,
                  (ARRAY_AGG(unit_price ORDER BY inward_date DESC, id DESC))[1] AS last_price
             FROM store_inward
            GROUP BY item_id
         ) inw ON inw.item_id = i.id
         LEFT JOIN (
           SELECT item_id, SUM(quantity) AS total_out
             FROM store_outward
            GROUP BY item_id
         ) out ON out.item_id = i.id
        WHERE ${where.join(' AND ')}
        ORDER BY i.name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(rows);
  } catch (e) {
    console.error('[store/items/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// POST /api/store/items { category_path, name, code?, unit?, notes? }
router.post('/items', authRequired(['admin']), async (req, res) => {
  const { category_path, name, code, unit, notes } = req.body || {};
  if (!name || !category_path) {
    return res.status(400).json({ error: 'name and category_path required' });
  }
  try {
    const { rows } = await query(
      `INSERT INTO store_items (category_path, name, code, unit, notes)
       VALUES ($1::ltree, $2, $3, $4, $5)
       RETURNING id, category_path::text AS category_path, name, code, unit, notes,
                 is_active, created_at, updated_at`,
      [
        String(category_path).trim(),
        String(name).trim(),
        code ? String(code).trim() : null,
        unit ? String(unit).trim() : null,
        notes ? String(notes).trim() : null,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'Item code already in use' });
    }
    console.error('[store/items/create]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

// PATCH /api/store/items/:id
router.patch('/items/:id', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  const { category_path, name, code, unit, notes, is_active } = req.body || {};
  const sets = ['updated_at = NOW()'];
  const params = [];
  const bind = (col, val, cast) => {
    params.push(val);
    sets.push(`${col} = $${params.length}${cast ? '::' + cast : ''}`);
  };
  if (category_path != null) bind('category_path', String(category_path).trim(), 'ltree');
  if (name != null)          bind('name',          String(name).trim());
  if (code != null)          bind('code',          code === '' ? null : String(code).trim());
  if (unit != null)          bind('unit',          unit === '' ? null : String(unit).trim());
  if (notes != null)         bind('notes',         notes === '' ? null : String(notes).trim());
  if (typeof is_active === 'boolean') bind('is_active', is_active);
  if (params.length === 0) return res.status(400).json({ error: 'nothing to update' });
  params.push(id);
  try {
    const { rows } = await query(
      `UPDATE store_items SET ${sets.join(', ')}
        WHERE id = $${params.length}
       RETURNING id, category_path::text AS category_path, name, code, unit, notes,
                 is_active, created_at, updated_at`,
      params,
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    console.error('[store/items/update]', e);
    res.status(500).json({ error: 'Update failed' });
  }
});

router.delete('/items/:id', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  try {
    const r = await query('UPDATE store_items SET is_active=FALSE WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[store/items/delete]', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Inward
// ─────────────────────────────────────────────────────────────

// GET /api/store/inward?item_id=&limit=&offset=
router.get('/inward', async (req, res) => {
  const itemId = parseInt(req.query.item_id, 10);
  const { limit, offset } = clampLimitOffset(req);
  const where = [];
  const params = [];
  if (Number.isFinite(itemId)) {
    params.push(itemId);
    where.push(`w.item_id = $${params.length}`);
  }
  params.push(limit); params.push(offset);
  try {
    const { rows } = await query(
      `SELECT w.id, w.item_id, w.inward_date, w.quantity::float AS quantity,
              w.unit_price::float AS unit_price, w.storage_location,
              w.supplier, w.notes, w.created_by_name, w.created_at,
              i.name AS item_name, i.unit AS item_unit
         FROM store_inward w
         JOIN store_items i ON i.id = w.item_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY w.inward_date DESC, w.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(rows);
  } catch (e) {
    console.error('[store/inward/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// POST /api/store/inward { item_id, inward_date?, quantity, unit_price, storage_location?, supplier?, notes? }
router.post('/inward', async (req, res) => {
  const { item_id, inward_date, quantity, unit_price, storage_location, supplier, notes } = req.body || {};
  const itemId = parseInt(item_id, 10);
  const qty = requireNum(quantity);
  const price = requireNum(unit_price);
  if (!Number.isFinite(itemId) || qty == null || qty <= 0 || price == null || price < 0) {
    return res.status(400).json({ error: 'item_id, positive quantity, unit_price required' });
  }
  const date = inward_date && String(inward_date).trim()
    ? String(inward_date).trim()
    : new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await query(
      `INSERT INTO store_inward
         (item_id, inward_date, quantity, unit_price, storage_location, supplier, notes, created_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, item_id, inward_date, quantity::float AS quantity,
                 unit_price::float AS unit_price, storage_location, supplier, notes,
                 created_by_name, created_at`,
      [
        itemId, date, qty, price,
        storage_location ? String(storage_location).trim() : null,
        supplier         ? String(supplier).trim()         : null,
        notes            ? String(notes).trim()            : null,
        req.user.username || null,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[store/inward/create]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

router.delete('/inward/:id', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  try {
    const r = await query('DELETE FROM store_inward WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === '23503') {
      return res.status(409).json({ error: 'Batch has outward entries linked to it' });
    }
    console.error('[store/inward/delete]', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Outward
// ─────────────────────────────────────────────────────────────

// GET /api/store/outward?item_id=&patient_id=&limit=&offset=
router.get('/outward', async (req, res) => {
  const itemId    = parseInt(req.query.item_id, 10);
  const patientId = parseInt(req.query.patient_id, 10);
  const { limit, offset } = clampLimitOffset(req);
  const where = [];
  const params = [];
  if (Number.isFinite(itemId)) {
    params.push(itemId);
    where.push(`o.item_id = $${params.length}`);
  }
  if (Number.isFinite(patientId)) {
    params.push(patientId);
    where.push(`o.allotted_to_patient_id = $${params.length}`);
  }
  params.push(limit); params.push(offset);
  try {
    const { rows } = await query(
      `SELECT o.id, o.item_id, o.inward_id,
              o.allotted_by_id, o.allotted_by_role, o.allotted_by_name,
              o.allotted_to_name, o.allotted_to_patient_id,
              o.quantity::float AS quantity,
              o.unit_price::float AS unit_price,
              o.outward_date, o.notes, o.created_at,
              i.name AS item_name, i.unit AS item_unit,
              p.full_name    AS patient_name,
              p.patient_code AS patient_code
         FROM store_outward o
         JOIN store_items i        ON i.id = o.item_id
         LEFT JOIN patients p      ON p.id = o.allotted_to_patient_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY o.outward_date DESC, o.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(rows);
  } catch (e) {
    console.error('[store/outward/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// POST /api/store/outward { item_id, quantity, unit_price?, outward_date?, allotted_to_name?, allotted_to_patient_id?, inward_id?, notes? }
router.post('/outward', async (req, res) => {
  const {
    item_id, inward_id, allotted_to_name, allotted_to_patient_id,
    quantity, unit_price, outward_date, notes,
  } = req.body || {};
  const itemId    = parseInt(item_id, 10);
  const qty       = requireNum(quantity);
  if (!Number.isFinite(itemId) || qty == null || qty <= 0) {
    return res.status(400).json({ error: 'item_id and positive quantity required' });
  }
  const price   = numOrNull(unit_price);
  const inwardId  = parseInt(inward_id, 10);
  const patientId = parseInt(allotted_to_patient_id, 10);
  const date = outward_date && String(outward_date).trim()
    ? String(outward_date).trim()
    : new Date().toISOString().slice(0, 10);
  try {
    const { rows } = await query(
      `INSERT INTO store_outward
         (item_id, inward_id, allotted_by_id, allotted_by_role, allotted_by_name,
          allotted_to_name, allotted_to_patient_id,
          quantity, unit_price, outward_date, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, item_id, inward_id, allotted_by_id, allotted_by_role, allotted_by_name,
                 allotted_to_name, allotted_to_patient_id,
                 quantity::float AS quantity, unit_price::float AS unit_price,
                 outward_date, notes, created_at`,
      [
        itemId,
        Number.isFinite(inwardId) ? inwardId : null,
        req.user.id || null,
        req.user.role || null,
        req.user.username || null,
        allotted_to_name ? String(allotted_to_name).trim() : null,
        Number.isFinite(patientId) ? patientId : null,
        qty,
        price,
        date,
        notes ? String(notes).trim() : null,
      ],
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error('[store/outward/create]', e);
    res.status(500).json({ error: 'Create failed' });
  }
});

router.delete('/outward/:id', authRequired(['admin']), async (req, res) => {
  const id = +req.params.id;
  try {
    const r = await query('DELETE FROM store_outward WHERE id=$1', [id]);
    if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[store/outward/delete]', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// ─────────────────────────────────────────────────────────────
// Stock summary (list of items with on-hand quantity + last price)
// ─────────────────────────────────────────────────────────────
router.get('/stock', async (req, res) => {
  const { limit, offset } = clampLimitOffset(req);
  const q = (req.query.q || '').trim();
  const category = (req.query.category || '').trim();
  const where = ['i.is_active = TRUE'];
  const params = [];
  if (category) {
    params.push(category);
    where.push(`i.category_path <@ $${params.length}::ltree`);
  }
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    where.push(`(LOWER(i.name) LIKE $${params.length} OR LOWER(COALESCE(i.code,'')) LIKE $${params.length})`);
  }
  params.push(limit); params.push(offset);
  try {
    const { rows } = await query(
      `SELECT i.id, i.category_path::text AS category_path, i.name, i.code, i.unit,
              COALESCE(inw.total_in,  0)::float AS total_in,
              COALESCE(out.total_out, 0)::float AS total_out,
              COALESCE(inw.total_in, 0)::float - COALESCE(out.total_out, 0)::float AS on_hand,
              inw.last_price::float AS last_price
         FROM store_items i
         LEFT JOIN (
           SELECT item_id,
                  SUM(quantity) AS total_in,
                  (ARRAY_AGG(unit_price ORDER BY inward_date DESC, id DESC))[1] AS last_price
             FROM store_inward
            GROUP BY item_id
         ) inw ON inw.item_id = i.id
         LEFT JOIN (
           SELECT item_id, SUM(quantity) AS total_out
             FROM store_outward
            GROUP BY item_id
         ) out ON out.item_id = i.id
        WHERE ${where.join(' AND ')}
        ORDER BY i.name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(rows);
  } catch (e) {
    console.error('[store/stock/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

module.exports = router;
