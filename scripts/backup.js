#!/usr/bin/env node
// Timestamped backup of the clinic database + uploaded files.
//
// Everything else in this codebase protects against DOWNTIME. This is the
// only thing that protects against LOSS. A crashed process restarts in a
// second; a dead disk without a backup ends the practice's records.
//
// Run it manually:            npm run backup
// Or on a schedule (nightly): see OPERATIONS.md
//
// Writes to backups/ by default (override with BACKUP_DIR):
//   backups/db-2026-08-30T2215.sql.gz     - pg_dump, gzipped
//   backups/uploads-2026-08-30T2215.tar.gz - the uploads directory
//
// Exits non-zero on any failure so a scheduler can alert instead of silently
// producing nothing for months - a backup you never verified is not a backup.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

require('dotenv').config();

const OUT_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const KEEP_DAYS = +(process.env.BACKUP_KEEP_DAYS || 14);
const UPLOADS = path.join(__dirname, '..', 'uploads');

// 2026-08-30T2215 — sorts chronologically as a plain filename.
const stamp = new Date().toISOString().slice(0, 16).replace(/[:]/g, '').replace('T', 'T');

function log(...a) { console.log('[backup]', ...a); }
function die(msg, code = 1) { console.error('[backup] FAILED:', msg); process.exit(code); }

/** pg_dump straight into a gzip stream, so the plaintext never hits disk. */
function dumpDatabase() {
  return new Promise((resolve, reject) => {
    const target = path.join(OUT_DIR, `db-${stamp}.sql.gz`);
    const args = [
      '-h', process.env.PGHOST || 'localhost',
      '-p', String(process.env.PGPORT || 5432),
      '-U', process.env.PGUSER || 'postgres',
      '-d', process.env.PGDATABASE || 'treatment_db',
      '--no-owner', '--no-acl',
    ];

    // Password via the environment, never argv - argv is world-readable in
    // the process list on most systems.
    const env = Object.assign({}, process.env);
    if (process.env.PGPASSWORD) env.PGPASSWORD = process.env.PGPASSWORD;

    const proc = spawn('pg_dump', args, { env });
    const gz = zlib.createGzip({ level: 9 });
    const out = fs.createWriteStream(target);

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => reject(
      e.code === 'ENOENT'
        ? new Error('pg_dump not found on PATH. Install the PostgreSQL client tools.')
        : e));

    proc.stdout.pipe(gz).pipe(out);

    out.on('error', reject);
    out.on('close', () => {
      if (proc.exitCode !== 0) {
        // Never leave a truncated file looking like a good backup.
        try { fs.unlinkSync(target); } catch { /* already gone */ }
        return reject(new Error(`pg_dump exited ${proc.exitCode}: ${stderr.trim()}`));
      }
      const mb = (fs.statSync(target).size / 1048576).toFixed(2);
      if (fs.statSync(target).size < 1024) {
        return reject(new Error(`dump is only ${mb}MB — that is almost certainly empty`));
      }
      resolve({ target, mb });
    });
  });
}

/** tar the uploads dir if tar is available; otherwise say so and carry on. */
function dumpUploads() {
  return new Promise((resolve) => {
    if (!fs.existsSync(UPLOADS)) return resolve(null);
    const target = path.join(OUT_DIR, `uploads-${stamp}.tar.gz`);
    const proc = spawn('tar', ['-czf', target, '-C', path.dirname(UPLOADS), 'uploads']);
    proc.on('error', () => {
      console.warn('[backup] tar unavailable — skipping uploads. Copy backend/uploads yourself.');
      resolve(null);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        console.warn('[backup] uploads archive failed (exit ' + code + ')');
        try { fs.unlinkSync(target); } catch { /* nothing to remove */ }
        return resolve(null);
      }
      resolve({ target, mb: (fs.statSync(target).size / 1048576).toFixed(2) });
    });
  });
}

/** Delete backups older than KEEP_DAYS. Never touches anything else. */
function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  let removed = 0;
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (!/^(db|uploads)-.*\.(gz)$/.test(f)) continue;
    const p = path.join(OUT_DIR, f);
    if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
  }
  return removed;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let db;
  try {
    db = await dumpDatabase();
  } catch (e) {
    die(e.message);
  }
  log(`database -> ${path.basename(db.target)} (${db.mb} MB)`);

  const up = await dumpUploads();
  if (up) log(`uploads  -> ${path.basename(up.target)} (${up.mb} MB)`);

  const removed = prune();
  if (removed) log(`pruned ${removed} backup(s) older than ${KEEP_DAYS} days`);

  log(`done — ${OUT_DIR}`);
  console.log(
    '\n  These files are on the SAME DISK as the database. That protects you\n'
    + '  from a bad migration or a mistaken delete, but NOT from disk failure,\n'
    + '  theft or ransomware. Copy them somewhere else — another machine, or\n'
    + '  the clinic Drive folder this app already syncs to.\n');
})();
