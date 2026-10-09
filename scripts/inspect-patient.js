#!/usr/bin/env node
// Read-only: show everything the database holds for a patient code, so a
// "the treatment disappeared" report can be traced to a cause.
//
// It changes NOTHING - only SELECTs. Run it to answer:
//   - Is there more than one patient row for this code? (a soft-deleted one
//     plus a new one that reused the code - the sessions stay on the OLD id,
//     so the new patient looks empty.)
//   - Does the session still exist, and how many marks does it have? (a
//     session with 0 marks points at a save that replaced the marks with an
//     empty list; a missing session points at a delete.)
//   - When was each session and mark last touched?
//
// USAGE
//   node scripts/inspect-patient.js 20481
//   node scripts/inspect-patient.js 20481 --marks     # also list each mark
//   node scripts/inspect-patient.js 20481 --logs      # + scan pm2 logs for
//                                                        this patient's sessions
//   node scripts/inspect-patient.js 20481 --logs --log-lines 20000
//
// --logs reads the running pm2 process's own log files (via `pm2 jlist`) and
// prints the request lines that touched any session found above - the
// PUT .../marks saves (an empty one is what wipes a session), the DELETE, and
// any errors around them. It is how you see WHEN and from WHERE the treatment
// changed. Read-only; it never streams or writes.

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { query, pool } = require('../db/pool');

/// The last `maxLines` of a file, reading only the tail bytes so a huge log
/// does not have to be loaded whole.
function tailLines(file, maxLines) {
  const stat = fs.statSync(file);
  const maxBytes = 12 * 1024 * 1024;
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let lines = buf.toString('utf8').split('\n');
    if (start > 0 && lines.length) lines = lines.slice(1); // drop partial line
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

/// The out+err log file paths of every running pm2 process (optionally one by
/// name), from `pm2 jlist`; falls back to ~/.pm2/logs/*.log if that fails.
function pm2LogFiles(appFilter) {
  const files = [];
  try {
    const procs = JSON.parse(
      execSync('pm2 jlist', { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
    for (const p of procs) {
      if (appFilter && p.name !== appFilter) continue;
      const env = p.pm2_env || {};
      for (const f of [env.pm_out_log_path, env.pm_err_log_path]) {
        if (f && fs.existsSync(f) && !files.includes(f)) files.push(f);
      }
    }
  } catch (e) {
    // pm2 not on PATH, or not this user's daemon - fall back to the default
    // log directory.
    const dir = path.join(os.homedir(), '.pm2', 'logs');
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.log') && (!appFilter || name.startsWith(appFilter))) {
          files.push(path.join(dir, name));
        }
      }
    } catch (_) {
      /* no logs reachable */
    }
  }
  return files;
}

function scanLogs(sessionIds, patientIds, code, { lines, appFilter }) {
  const files = pm2LogFiles(appFilter);
  if (!files.length) {
    console.log('Could not find any pm2 log files (is pm2 running as this '
      + 'user? try --app <name>, or run as the user that owns the pm2 daemon).');
    return;
  }
  // A line is relevant if it names one of this patient's sessions, the
  // patient's numeric id (session create/list carry that, not the code), the
  // patient code, or a Drive quota error around the same time.
  const sidAlt = sessionIds.length ? `sessions/(?:${sessionIds.join('|')})\\b` : null;
  const pidAlt = patientIds.length ? `patients/(?:${patientIds.join('|')})(?:/|\\b)` : null;
  const parts = [
    sidAlt,
    pidAlt,
    code ? escapeRe(code) : null,
    'storageQuotaExceeded',
  ].filter(Boolean);
  const re = new RegExp(`(${parts.join('|')})`, 'i');

  console.log(`Scanning pm2 logs: ${files.length} file(s), last ${lines} lines `
    + `each, for sessions [${sessionIds.join(', ') || 'none'}]`);
  console.log('');
  let hits = 0;
  for (const file of files) {
    let matched = [];
    try {
      matched = tailLines(file, lines).filter((l) => re.test(l));
    } catch (e) {
      console.log(`  (could not read ${file}: ${e.message})`);
      continue;
    }
    if (!matched.length) continue;
    console.log(`── ${file}`);
    for (const l of matched) console.log(`   ${l}`);
    console.log('');
    hits += matched.length;
  }
  if (!hits) {
    console.log('No matching log lines in the window scanned. The event may be '
      + 'older than the retained logs - increase --log-lines, or check rotated '
      + 'logs / a database backup.');
  } else {
    console.log('What to look for:');
    console.log('  - POST .../patients/<pid>/sessions  — a session WAS created '
      + 'for this patient (note the time). If there is NO such line in range, '
      + 'the treatment was never saved to the server at all.');
    console.log('  - PUT .../sessions/<id>/marks with a tiny response size — '
      + 'an empty save that wiped the marks.');
    console.log('  - DELETE .../sessions/<id>  — the session was deleted.');
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

(async () => {
  const code = (process.argv[2] || '').trim();
  const showMarks = process.argv.includes('--marks');
  const scanPm2 = process.argv.includes('--logs');
  const llArg = process.argv.indexOf('--log-lines');
  const logLines = llArg >= 0 ? Math.max(100, +process.argv[llArg + 1]) : 50000;
  const appArg = process.argv.indexOf('--app');
  const appFilter = appArg >= 0 ? process.argv[appArg + 1] : null;
  if (!code) {
    console.error('Usage: node scripts/inspect-patient.js <patient_code> [--marks]');
    process.exit(1);
  }

  try {
    const { rows: patients } = await query(
      `SELECT id, patient_code, full_name, deleted_at, created_at, updated_at,
              drive_folder_id
         FROM patients
        WHERE patient_code ILIKE $1
        ORDER BY id ASC`,
      [code]);

    if (!patients.length) {
      console.log(`No patient row at all with code "${code}".`);
      console.log('The code may be spelled differently, or the patient row '
        + 'was HARD-deleted (which would cascade its sessions and marks). '
        + 'Check a database backup from before it went missing.');
      return;
    }

    console.log(`Patient rows for code "${code}": ${patients.length}`);
    if (patients.length > 1) {
      console.log('  (More than one row - the code was reused after a soft '
        + 'delete. Sessions stay on the OLDER id; the newest row can look '
        + 'empty even though the data is safe on the older one.)');
    }
    console.log('');

    const sessionIds = [];
    const patientIds = patients.map((p) => p.id);
    for (const p of patients) {
      const state = p.deleted_at ? `DELETED ${p.deleted_at}` : 'active';
      console.log(`── patient id ${p.id}  "${p.full_name}"  [${state}]`);
      console.log(`   created ${p.created_at}  drive_folder ${p.drive_folder_id || '-'}`);

      const { rows: sessions } = await query(
        `SELECT s.id, s.session_date, s.created_at, s.created_by_name, s.label,
                s.deleted_at, s.deleted_by_name, s.deleted_by_role,
                COUNT(m.id)::int AS mark_count,
                MAX(m.created_at) AS last_mark_at
           FROM treatment_sessions s
           LEFT JOIN marks m ON m.session_id = s.id
          WHERE s.patient_id = $1
          GROUP BY s.id
          ORDER BY s.session_date DESC, s.id DESC`,
        [p.id]);

      if (!sessions.length) {
        console.log('   no treatment sessions on this patient id.');
        console.log('');
        continue;
      }

      console.log(`   ${sessions.length} session(s):`);
      for (const s of sessions) {
        sessionIds.push(s.id);
        const flag = s.mark_count === 0 ? '  <-- 0 MARKS (likely wiped by an empty save)' : '';
        const del = s.deleted_at
          ? `\n       DELETED ${s.deleted_at} by ${s.deleted_by_name || '?'}`
            + ` (${s.deleted_by_role || '?'}) — restore with: `
            + `node scripts/restore-session.js ${s.id} --apply`
          : '';
        console.log(`     session #${s.id}  ${s.session_date}  `
          + `${s.mark_count} marks  by ${s.created_by_name || '-'}  `
          + `created ${s.created_at}`
          + (s.last_mark_at ? `  last mark ${s.last_mark_at}` : '') + flag + del);

        if (showMarks && s.mark_count > 0) {
          const { rows: marks } = await query(
            `SELECT order_num, treatment, effectiveness, sitting_position,
                    created_at
               FROM marks WHERE session_id = $1
              ORDER BY order_num ASC`,
            [s.id]);
          for (const m of marks) {
            console.log(`         #${m.order_num}  ${m.treatment || '-'}  `
              + `${m.effectiveness || '-'} · ${m.sitting_position || '-'}  `
              + `(${m.created_at})`);
          }
        }
      }
      console.log('');
    }

    console.log('How to read this:');
    console.log('  - A session with 0 marks: the marks were deleted, almost '
      + 'certainly by a save that sent an empty mark list. Restore that '
      + "session's marks from a DB backup taken before it happened.");
    console.log('  - Sessions only on an older/DELETED patient id: the data is '
      + 'safe - the newest row just reused the code. Re-point or merge it.');
    console.log('  - No sessions anywhere, but the row exists: the session was '
      + 'deleted (DELETE /sessions/:id) - restore from a backup.');

    if (scanPm2) {
      console.log('');
      console.log('════ pm2 logs ════');
      scanLogs(sessionIds, patientIds, code, { lines: logLines, appFilter });
    } else {
      console.log('');
      console.log('Add --logs to scan the pm2 request logs for these sessions.');
    }
  } catch (e) {
    console.error('[inspect-patient] failed:', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
