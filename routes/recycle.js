// Recycle bin (admin only): what was deleted, by whom, from where - and
// putting it back. The rows come from utils/recycleBin.js; see
// db/migrations/012_recycle_bin.sql for how they get there.

const express = require('express');
const { authRequired } = require('../middleware/auth');
const bin = require('../utils/recycleBin');

const router = express.Router();
router.use(authRequired(['admin']));

// GET /api/recycle-bin?table=rooms&limit=50&offset=0&include_restored=1
router.get('/', async (req, res) => {
  try {
    const rows = await bin.list({
      table: req.query.table ? String(req.query.table) : null,
      limit: req.query.limit,
      offset: req.query.offset,
      includeRestored: String(req.query.include_restored || '') === '1',
    });
    res.json(rows.map((r) => ({ ...r, summary: bin.describe(r) })));
  } catch (e) {
    console.error('[recycle-bin/list]', e);
    res.status(500).json({ error: 'List failed' });
  }
});

// POST /api/recycle-bin/:id/restore   { only?: true, dry_run?: true }
// Brings back the entry and everything deleted with it (only=true: just it).
router.post('/:id(\\d+)/restore', async (req, res) => {
  try {
    const out = await bin.restore(+req.params.id, {
      apply: !(req.body && req.body.dry_run),
      only: !!(req.body && req.body.only),
      by: req.user.username || 'admin',
    });
    if (!out.ok) return res.status(409).json(out);
    res.json(out);
  } catch (e) {
    console.error('[recycle-bin/restore]', e);
    res.status(500).json({ error: 'Restore failed' });
  }
});

module.exports = router;
