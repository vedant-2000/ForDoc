// One-shot DB initializer: applies schema.sql and seeds default admin.
// Usage:  node db/init.js
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('[init] applying schema...');
  await pool.query(sql);

  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'admin123';

  const { rows } = await pool.query('SELECT id FROM admins WHERE username=$1', [adminUser]);
  if (!rows.length) {
    const hash = await bcrypt.hash(adminPass, 10);
    await pool.query(
      'INSERT INTO admins (username, password_hash) VALUES ($1,$2)',
      [adminUser, hash]
    );
    console.log(`[init] seeded admin user="${adminUser}" pass="${adminPass}" (change me!)`);
  } else {
    console.log(`[init] admin "${adminUser}" already exists, skipping seed.`);
  }

  // Seed treatment catalog only if it's empty (so admin edits aren't overwritten).
  const { rows: tc } = await pool.query('SELECT COUNT(*)::int AS n FROM treatment_catalog');
  if (tc[0].n === 0) {
    const DEFAULT_CATALOG = {
      'R-1':  ['ESW/EPG','EPD','SW','R1','IQ','B2'],
      'R-2':  ['PM','DM','CT','L1','IQ','R1','B2','Activator'],
      'R-3':  ['LNT','L4','R1','B2'],
      'R-4':  ['LNT','SLP','SLT','L4','R1','IQ','IMS','L2','L3/VP','AV','B2','SW'],
      'R-5':  ['PMT2'],
      'R-6':  ['PST1'],
      'R-7':  ['DTS'],
      'R-8':  ['3D Scan','Tecar','RRT','B2'],
      'R-9':  ['HM'],
      'R-10': ['IT','HTP','PAM'],
    };
    let total = 0;
    for (const [room, list] of Object.entries(DEFAULT_CATALOG)) {
      for (let i = 0; i < list.length; i++) {
        await pool.query(
          `INSERT INTO treatment_catalog (room, treatment, sort_order)
           VALUES ($1, $2, $3)
           ON CONFLICT (room, treatment) DO NOTHING`,
          [room, list[i], i]
        );
        total++;
      }
    }
    console.log(`[init] seeded ${total} treatment-catalog rows`);
  } else {
    console.log(`[init] treatment_catalog has ${tc[0].n} rows, skipping seed.`);
  }

  console.log('[init] done.');
  await pool.end();
}

main().catch((e) => {
  console.error('[init] failed:', e);
  process.exit(1);
});
