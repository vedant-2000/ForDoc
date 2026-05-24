const { Pool, types } = require('pg');
require('dotenv').config();

// Return Postgres DATE columns (OID 1082) as plain 'YYYY-MM-DD' strings.
// Without this, pg parses them into JS Date at local midnight, and
// JSON.stringify -> toISOString() shifts them in non-UTC time zones.
types.setTypeParser(1082, (val) => val);

const pool = new Pool({
  host:     process.env.PGHOST     || 'localhost',
  port:     +(process.env.PGPORT  || 5432),
  user:     process.env.PGUSER     || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'treatment_db',
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[pg pool] unexpected error', err);
});

const query = (text, params) => pool.query(text, params);

const tx = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
};

module.exports = { pool, query, tx };
