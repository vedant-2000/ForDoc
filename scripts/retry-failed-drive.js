#!/usr/bin/env node
// Re-push patient documents that failed to reach Google Drive.
//
// WHEN TO USE THIS
// Drive filled up (or was briefly unreachable) while documents were being
// saved. Each failed upload left the document SAVED locally - its bytes are
// still on this server - but marked sync_status='failed', because the Drive
// half did not go through. The OAuth connection is fine; only these per-file
// uploads are stuck. Once Drive has space again, this re-pushes them.
//
// It reuses the app's own pushToDrive, so a retried file lands in exactly the
// folder, with exactly the name and links, it would have the first time - and
// a document that actually succeeds this time has its local copy removed and
// is marked synced, just like a normal upload.
//
// USAGE
//   node scripts/retry-failed-drive.js                 # dry run: list only
//   node scripts/retry-failed-drive.js --apply         # actually re-push
//   node scripts/retry-failed-drive.js --apply --patient 123
//   node scripts/retry-failed-drive.js --apply --limit 50
//
// SAFETY
//   - Dry run by default. Nothing is sent until you pass --apply.
//   - Read-only SELECT to find the work; the writes are pushToDrive's own.
//   - Sequential, one file at a time, so Drive is not hammered and a failure
//     names the exact document it stopped on.
//   - A document whose LOCAL copy is gone (filename is null) cannot be
//     retried - it is reported, never silently skipped.

require('dotenv').config();
const { query, pool } = require('../db/pool');
const { pushToDrive } = require('../routes/documents');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const apply = process.argv.includes('--apply');
  const patientArg = process.argv.indexOf('--patient');
  const patientId = patientArg >= 0 ? +process.argv[patientArg + 1] : null;
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Math.max(1, +process.argv[limitArg + 1]) : 500;

  try {
    const params = [];
    let where = "d.sync_status = 'failed'";
    if (patientId) {
      params.push(patientId);
      where += ` AND d.patient_id = $${params.length}`;
    }
    params.push(limit);
    const { rows } = await query(
      `SELECT d.id, d.patient_id, d.category, d.original_name, d.filename,
              d.sync_error, p.patient_code, p.full_name
         FROM patient_documents d
         JOIN patients p ON p.id = d.patient_id
        WHERE ${where}
        ORDER BY d.id ASC
        LIMIT $${params.length}`,
      params);

    if (!rows.length) {
      console.log('No documents are in sync_status=failed'
        + (patientId ? ` for patient ${patientId}` : '') + '. Nothing to do.');
      return;
    }

    const retryable = rows.filter((r) => r.filename);
    const lost = rows.filter((r) => !r.filename);

    console.log(`Found ${rows.length} failed document(s)`
      + (patientId ? ` for patient ${patientId}` : '') + ':');
    console.log(`  ${retryable.length} with a local copy — can be re-pushed`);
    if (lost.length) {
      console.log(`  ${lost.length} with NO local copy (filename is null) — `
        + `cannot be retried, listed below`);
    }
    console.log('');
    for (const r of rows) {
      const tag = r.filename ? 'retry' : 'LOST ';
      console.log(`  [${tag}] #${r.id}  ${r.patient_code} ${r.full_name}  `
        + `${r.category}  ${r.original_name || ''}`
        + (r.filename ? '' : `   (was: ${r.sync_error || 'no local file'})`));
    }
    console.log('');

    if (!apply) {
      console.log('Dry run. Re-run with --apply to actually re-push the '
        + `${retryable.length} retryable document(s).`);
      return;
    }

    let ok = 0;
    let failed = 0;
    const stillFailing = [];
    for (let i = 0; i < retryable.length; i++) {
      const r = retryable[i];
      process.stdout.write(`[${i + 1}/${retryable.length}] #${r.id} `
        + `${r.patient_code} ${r.category}... `);
      try {
        // null adminId: pushToDrive uses the connected Drive account, the
        // same as an ordinary upload.
        const res = await pushToDrive(r.id, null);
        if (res && res.ok) {
          ok++;
          console.log('synced');
        } else {
          failed++;
          stillFailing.push({ id: r.id, error: (res && res.error) || 'unknown' });
          console.log(`still failing: ${(res && res.error) || 'unknown'}`);
        }
      } catch (e) {
        failed++;
        stillFailing.push({ id: r.id, error: e.message });
        console.log(`error: ${e.message}`);
      }
      // A small gap so a burst of retries does not trip Drive's rate limit.
      await sleep(400);
    }

    console.log('');
    console.log(`Done. ${ok} synced, ${failed} still failing`
      + (lost.length ? `, ${lost.length} had no local copy` : '') + '.');
    if (stillFailing.length) {
      console.log('Still failing:');
      for (const f of stillFailing) {
        console.log(`  #${f.id}: ${f.error}`);
      }
      console.log('If these say the folder is not linked, link the patient '
        + 'under Admin → Patient folders, then run this again. If they still '
        + 'mention quota, the new space has not propagated yet — wait and retry.');
    }
  } catch (e) {
    console.error('[retry-failed-drive] failed:', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
