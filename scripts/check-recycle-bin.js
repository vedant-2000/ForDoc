#!/usr/bin/env node
// Read-only: did migration 012 (the recycle bin) really apply, and did it leave
// your existing data alone?
//
//   node scripts/check-recycle-bin.js
//
// It only runs SELECTs. Prints PASS / FAIL per check and exits non-zero if any
// check fails.

require('dotenv').config();
const { query, pool } = require('../db/pool');

let failed = 0;
const show = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failed++;
};

(async () => {
  try {
    const cols = (await query(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'treatment_sessions' AND column_name LIKE 'deleted_%'
        ORDER BY column_name`)).rows;
    const names = cols.map((c) => c.column_name);
    show(['deleted_at', 'deleted_by_id', 'deleted_by_name', 'deleted_by_role']
      .every((n) => names.includes(n)),
    `treatment_sessions has the 4 deleted_* columns (found: ${names.join(', ') || 'none'})`);
    show(cols.every((c) => c.is_nullable === 'YES'),
      'those columns are all nullable (no dummy data was needed)');

    const idx = (await query(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'treatment_sessions' AND indexdef ILIKE '%unique%'`)).rows
      .map((r) => r.indexname);
    show(idx.includes('uq_sessions_patient_date_active'),
      'unique rule is now "one LIVE session per patient per date"');
    const oldRule = (await query(
      `SELECT 1 FROM pg_constraint
        WHERE conrelid = 'treatment_sessions'::regclass AND contype = 'u'`)).rowCount;
    show(oldRule === 0, 'the old blanket unique rule is gone');

    const bin = await query(`SELECT to_regclass('deleted_records') AS t`);
    show(!!bin.rows[0].t, 'the deleted_records table exists');

    const trg = (await query(
      `SELECT count(*)::int AS n FROM information_schema.triggers
        WHERE trigger_name = 'trg_archive_deleted'`)).rows[0].n;
    show(trg >= 20, `the delete-archiving trigger is on ${trg} tables (expected 24)`);

    const s = (await query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS hidden
         FROM treatment_sessions`)).rows[0];
    show(s.hidden === 0,
      `your ${s.total} existing sessions are all still live (${s.hidden} hidden)`);

    const n = (await query('SELECT count(*)::int AS n FROM deleted_records')).rows[0].n;
    console.log(`INFO  recycle bin currently holds ${n} entr${n === 1 ? 'y' : 'ies'}`
      + ' (0 is normal right after migrating)');
  } catch (e) {
    console.error('check failed:', e.message);
    failed++;
  } finally {
    await pool.end();
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll good.');
  process.exit(failed ? 1 : 0);
})();
