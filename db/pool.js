const { Pool, types } = require('pg');
require('dotenv').config();
const actor = require('../utils/actor');

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

// Every client the pool hands out gets its own 'error' listener attached
// here. Without this, a client whose connection is later terminated
// unexpectedly (e.g. Postgres idle-timeout, network hiccup, DB restart)
// would emit an unhandled 'error' event on the Client instance and crash
// the entire Node process — the "Emitted 'error' event on Client instance"
// stack trace. Log + swallow it; the pool will replace the broken client
// on the next `connect()`.
pool.on('connect', (client) => {
  client.on('error', (err) => {
    console.error('[pg client] connection error', err.message);
  });
});

/// Tell Postgres who the current request's user is, for this transaction
/// only (set_config(..., true) ends with it, so the next user of this pooled
/// connection never inherits the name). The recycle-bin trigger reads these
/// to record who deleted each row. A no-op outside a logged-in request.
async function stampActor(client) {
  const a = actor.current();
  if (!a) return;
  await client.query(
    `SELECT set_config('app.actor_id',     $1, true),
            set_config('app.actor_name',   $2, true),
            set_config('app.actor_role',   $3, true),
            set_config('app.actor_source', $4, true)`,
    [a.id == null ? '' : String(a.id), a.name || '', a.role || '',
      String(a.source || '').slice(0, 300)]);
}

// A plain query() runs in its own implicit transaction, where there is no
// chance to set the user first. A statement that deletes is the one case
// where that matters, so it is run inside tx() with the user stamped.
const DELETES = /\bdelete\s+from\b/i;

const query = (text, params) => {
  if (typeof text === 'string' && DELETES.test(text) && actor.current()) {
    return tx((c) => c.query(text, params));
  }
  return pool.query(text, params);
};

const tx = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await stampActor(client);
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
