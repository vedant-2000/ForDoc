#!/usr/bin/env node
// The recycle bin from the command line: who deleted what, and undo it.
//
// USAGE
//   node scripts/restore-deleted.js                    # last 30 deletions
//   node scripts/restore-deleted.js --table rooms      # only rooms
//   node scripts/restore-deleted.js --limit 100
//   node scripts/restore-deleted.js 57                 # dry run: what #57 brings back
//   node scripts/restore-deleted.js 57 --apply         # restore it (+ rows deleted with it)
//   node scripts/restore-deleted.js 57 --apply --only  # restore just that one row
//
// A purged patient, a deleted room, a catalog save that dropped three
// treatments - everything removed in one action shares a group, and restoring
// any entry brings the whole group back unless --only is given.
//
// SAFETY: listing is read-only; a restore is a dry run until --apply, and is
// all-or-nothing (if one row cannot go back, nothing changes).

require('dotenv').config();
const { pool } = require('../db/pool');
const bin = require('../utils/recycleBin');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
};

(async () => {
  const id = +(process.argv[2] || 0);
  try {
    if (!id) {
      const rows = await bin.list({ table: arg('--table'), limit: arg('--limit') || 30 });
      if (!rows.length) {
        console.log('The recycle bin is empty.');
        return;
      }
      console.log('Newest first. Restore with: node scripts/restore-deleted.js <#> --apply\n');
      for (const r of rows) {
        const when = new Date(r.deleted_at).toLocaleString();
        console.log(`#${r.id}  ${when}  ${r.kind === 'soft' ? 'hidden ' : 'removed'}  `
          + `${bin.describe(r)}`);
        console.log(`        by ${r.deleted_by_name || '?'} (${r.deleted_by_role || '?'})`
          + `${r.source ? `  via ${r.source}` : ''}  [group ${r.tx_id}]`);
      }
      return;
    }

    const apply = process.argv.includes('--apply');
    const out = await bin.restore(id, {
      apply, only: process.argv.includes('--only'), by: 'script',
    });
    if (out.plan) {
      console.log(apply ? 'Restoring:' : 'Would restore:');
      for (const p of out.plan) console.log(`  ${p}`);
    }
    if (!out.ok) {
      console.log(`\nNOT restored: ${out.error}`);
      process.exitCode = 1;
      return;
    }
    for (const n of out.notes || []) console.log(`  ${n}`);
    console.log(apply ? '\nDone - it is back in the app.'
      : '\nDry run. Add --apply to restore.');
  } catch (e) {
    console.error('[restore-deleted] failed:', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
