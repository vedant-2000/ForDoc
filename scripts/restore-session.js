#!/usr/bin/env node
// Bring a soft-deleted treatment session (and its marks) back.
//
// Since the DELETE route now only FLAGS a session (deleted_at + who removed
// it) instead of erasing it, a session deleted by mistake is still in the
// database with every mark intact. This clears that flag so the session
// reappears in the app exactly as it was.
//
// USAGE
//   node scripts/restore-session.js 1324            # dry run: show what it is
//   node scripts/restore-session.js 1324 --apply    # actually restore it
//
// SAFETY
//   - Dry run by default. Nothing changes until you pass --apply.
//   - Refuses if a LIVE session already exists for the same patient+date
//     (the active-row unique index) — it tells you, so you decide whether to
//     move/merge rather than silently colliding.
//   - Touches only this one row's deleted_* flags; marks are untouched (they
//     never left — only the session was hidden).

require('dotenv').config();
const { query, pool } = require('../db/pool');

(async () => {
  const id = +(process.argv[2] || 0);
  const apply = process.argv.includes('--apply');
  if (!id) {
    console.error('Usage: node scripts/restore-session.js <session_id> [--apply]');
    process.exit(1);
  }

  try {
    const { rows } = await query(
      `SELECT s.id, s.patient_id, s.session_date, s.label, s.deleted_at,
              s.deleted_by_name, s.deleted_by_role,
              p.patient_code, p.full_name,
              (SELECT COUNT(*) FROM marks m WHERE m.session_id = s.id)::int AS mark_count
         FROM treatment_sessions s
         JOIN patients p ON p.id = s.patient_id
        WHERE s.id = $1`,
      [id]);

    if (!rows.length) {
      console.log(`No session #${id} exists at all. It may have been from `
        + 'before soft-delete (hard-deleted), in which case restore it from a '
        + 'database backup instead.');
      return;
    }
    const s = rows[0];
    console.log(`Session #${s.id} — patient ${s.patient_code} ${s.full_name}`);
    console.log(`  date ${s.session_date}  ${s.mark_count} marks  ${s.label || ''}`);

    if (!s.deleted_at) {
      console.log('  This session is NOT deleted — it is already live. Nothing to do.');
      return;
    }
    console.log(`  deleted ${s.deleted_at} by ${s.deleted_by_name || '?'} `
      + `(${s.deleted_by_role || '?'})`);

    // Would restoring collide with a live session on the same patient+date?
    const { rows: clash } = await query(
      `SELECT id FROM treatment_sessions
        WHERE patient_id = $1 AND session_date = $2
          AND deleted_at IS NULL AND id <> $3`,
      [s.patient_id, s.session_date, s.id]);
    if (clash.length) {
      console.log('');
      console.log(`CANNOT restore: a live session (#${clash[0].id}) already `
        + `exists for ${s.patient_code} on ${s.session_date}. Decide first — `
        + 'move this one to another date, or merge the marks into the live '
        + 'session, then try again.');
      process.exitCode = 1;
      return;
    }

    if (!apply) {
      console.log('');
      console.log('Dry run. Re-run with --apply to restore this session and its '
        + `${s.mark_count} marks.`);
      return;
    }

    const r = await query(
      `UPDATE treatment_sessions
          SET deleted_at = NULL, deleted_by_id = NULL,
              deleted_by_name = NULL, deleted_by_role = NULL
        WHERE id = $1 AND deleted_at IS NOT NULL`,
      [s.id]);
    if (r.rowCount) {
      console.log('');
      console.log(`Restored. Session #${s.id} (${s.mark_count} marks) is live `
        + 'again and will show in the app immediately.');
    } else {
      console.log('Nothing changed (it was restored by someone else just now).');
    }
  } catch (e) {
    console.error('[restore-session] failed:', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
