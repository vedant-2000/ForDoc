// Apply one migration file (or list them).
//
//   node scripts/migrate.js                 -> lists db/migrations
//   node scripts/migrate.js 006             -> applies the file starting 006
//   node scripts/migrate.js 006_service_refresh_tokens.sql
//
// Exists because there is no migration runner here and the connection details
// live in .env as PGHOST/PGUSER/... rather than a DATABASE_URL, so the usual
// `psql "$DATABASE_URL" -f ...` does not work on this deployment. This goes
// through db/pool.js, so it connects exactly where the server connects — no
// second place to get the credentials wrong.
//
// Nothing records which migrations have run: every file in db/migrations is
// written to be safe to apply twice (IF NOT EXISTS / ADD COLUMN IF NOT
// EXISTS), and re-running one is the recovery path, not a hazard.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db/pool');

const DIR = path.join(__dirname, '..', 'db', 'migrations');

async function main() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
  const arg = process.argv[2];

  if (!arg) {
    console.log('Migrations in db/migrations:\n');
    for (const f of files) console.log('  ' + f);
    console.log('\nApply one with:  node scripts/migrate.js <number or filename>');
    return;
  }

  const match = files.filter((f) => f === arg || f.startsWith(arg));
  if (match.length === 0) {
    console.error(`No migration matches "${arg}". Run without arguments to list them.`);
    process.exitCode = 1;
    return;
  }
  if (match.length > 1) {
    console.error(`"${arg}" is ambiguous: ${match.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const file = match[0];
  const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
  console.log(`[migrate] applying ${file} to ${process.env.PGDATABASE || 'treatment_db'} on ${process.env.PGHOST || 'localhost'}...`);
  await pool.query(sql);
  console.log('[migrate] done.');
}

main()
  .catch((e) => {
    console.error('[migrate] FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
