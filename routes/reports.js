// Daily activity report — who was treated, and what was uploaded.
//
// Answers "what happened at the clinic on this day (or across this range)?"
// in one screen, so an admin does not have to open patients one by one to
// reconstruct it.
//
// A NOTE ON WHICH DATE IS USED, because there are two and they disagree:
//
//   sessions  -> session_date   the day the treatment happened
//   documents -> created_at     the day the file was UPLOADED
//
// `patient_documents` also carries `doc_date`, the *clinical* date of the
// document, which is what you want when reading one patient's history. This
// report deliberately matches on `created_at` instead: it reports clinic
// activity, and scanning a two-year-old X-ray today is today's work. Both
// dates are returned per row so the difference is visible rather than
// silently collapsed - a document dated last March but uploaded today shows
// up here with both.
//
// Timezone matters for that: created_at is TIMESTAMPTZ, so on a UTC server an
// evening upload in IST lands on the previous day. Pass ?tz=Asia/Kolkata, or
// set REPORT_TZ once, and the day boundaries follow the clinic's clock.

const express = require('express');
const { query } = require('../db/pool');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate as a real calendar date, so '2026-02-31' is rejected too. */
function isDate(v) {
  if (!DATE_RE.test(v || '')) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

// GET /api/reports/activity?from=&to=&tz=   (admin)
router.get('/activity', authRequired(['admin']), async (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const tz = String(req.query.tz || process.env.REPORT_TZ || '').trim() || null;

  if (!isDate(from) || !isDate(to)) {
    return res.status(400).json({
      error: 'from and to must be dates in YYYY-MM-DD form.',
      code: 'bad_date_range',
    });
  }
  if (from > to) {
    return res.status(400).json({
      error: 'The start date is after the end date.',
      code: 'bad_date_range',
    });
  }

  try {
    // A timezone Postgres does not recognise makes AT TIME ZONE throw, which
    // would take out the whole report over a cosmetic setting. Check it first
    // and fall back to the database's own zone if it is not real.
    let zone = tz;
    if (zone) {
      const { rows } = await query(
        'SELECT 1 FROM pg_timezone_names WHERE name = $1 LIMIT 1', [zone]);
      if (!rows.length) {
        console.warn(`[reports] unknown timezone ${zone} — using the database's`);
        zone = null;
      }
    }

    // Three queries, assembled in JS, rather than one join.
    //
    // Joining sessions to documents in SQL would multiply them out: a patient
    // with 2 sessions and 3 documents would come back as 6 rows, and every
    // count taken from that would be wrong. They are independent lists that
    // happen to share a patient.

    // ── 1. Treatment sessions in range ──
    const { rows: sessions } = await query(
      `SELECT s.id, s.patient_id, s.session_date, s.label, s.notes, s.rooms,
              p.patient_code, p.full_name,
              doc.full_name AS doctor_name, doc.color AS doctor_color,
              (SELECT count(*) FROM marks m WHERE m.session_id = s.id) AS mark_count
         FROM treatment_sessions s
         JOIN patients p   ON p.id = s.patient_id
    LEFT JOIN doctors  doc ON doc.id = s.doctor_id
        WHERE s.session_date BETWEEN $1 AND $2
          AND p.deleted_at IS NULL
        ORDER BY s.session_date DESC, p.patient_code ASC`,
      [from, to]);

    // ── 2. What was actually done in those sessions ──
    // Distinct treatments per session, for the expanded row. Skipped entirely
    // when the range held no sessions, so an empty day costs nothing.
    let treatmentsBySession = new Map();
    if (sessions.length) {
      const { rows: tr } = await query(
        `SELECT session_id, treatment, count(*)::int AS n
           FROM marks
          WHERE session_id = ANY($1::int[])
            AND treatment IS NOT NULL AND treatment <> ''
          GROUP BY session_id, treatment
          ORDER BY n DESC, treatment ASC`,
        [sessions.map((s) => s.id)]);
      for (const r of tr) {
        if (!treatmentsBySession.has(r.session_id)) treatmentsBySession.set(r.session_id, []);
        treatmentsBySession.get(r.session_id).push({ treatment: r.treatment, count: r.n });
      }
    }

    // ── 3. Documents uploaded in range ──
    const { rows: docs } = await query(
      `SELECT d.id, d.patient_id, d.category, d.title, d.original_name,
              d.filename, d.mime_type, d.doc_date, d.created_at, d.size_bytes,
              d.sync_status, d.drive_view_link, d.drive_file_id,
              d.uploaded_by_name,
              p.patient_code, p.full_name
         FROM patient_documents d
         JOIN patients p ON p.id = d.patient_id
        WHERE d.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND (d.created_at AT TIME ZONE COALESCE($3::text, current_setting('TimeZone')))::date
              BETWEEN $1 AND $2
        ORDER BY d.created_at DESC`,
      [from, to, zone]);

    // ── 4. Verification marks for exactly this period ──
    //
    // Deliberately non-fatal: this table arrives in migration 003, and the
    // report is useful without it. If it is not there yet the report still
    // renders, just with nothing ticked, and tells the client why rather than
    // failing with a raw "relation does not exist".
    const verified = new Map();
    let verificationsAvailable = true;
    try {
      const { rows: vs } = await query(
        `SELECT patient_id, verified_by_name, verified_at
           FROM report_verifications
          WHERE period_from = $1 AND period_to = $2`,
        [from, to]);
      for (const v of vs) {
        verified.set(v.patient_id, {
          by: v.verified_by_name,
          at: v.verified_at,
        });
      }
    } catch (e) {
      // 42P01 = undefined_table. Anything else is a real problem worth seeing.
      if (e.code !== '42P01') throw e;
      verificationsAvailable = false;
      console.warn('[reports] report_verifications missing — run '
        + 'db/migrations/003_report_verifications.sql to enable verify marks');
    }

    // ── Assemble one entry per patient ──
    // Keyed by patient id, so a patient who was treated AND had documents
    // uploaded appears once with both, not twice.
    const byPatient = new Map();
    const entry = (r) => {
      let e = byPatient.get(r.patient_id);
      if (!e) {
        e = {
          patient_id: r.patient_id,
          patient_code: r.patient_code,
          full_name: r.full_name,
          sessions: [],
          documents: [],
          mark_count: 0,
        };
        byPatient.set(r.patient_id, e);
      }
      return e;
    };

    for (const s of sessions) {
      const e = entry(s);
      const marks = Number(s.mark_count) || 0;
      e.mark_count += marks;
      e.sessions.push({
        id: s.id,
        session_date: s.session_date,
        label: s.label,
        notes: s.notes,
        rooms: s.rooms || [],
        doctor_name: s.doctor_name,
        doctor_color: s.doctor_color,
        mark_count: marks,
        treatments: treatmentsBySession.get(s.id) || [],
      });
    }

    for (const d of docs) {
      entry(d).documents.push({
        id: d.id,
        category: d.category,
        title: d.title,
        original_name: d.original_name,
        mime_type: d.mime_type,
        url: d.filename ? `/uploads/patient-docs/${d.filename}` : null,
        doc_date: d.doc_date,
        created_at: d.created_at,
        size_bytes: d.size_bytes == null ? null : Number(d.size_bytes),
        sync_status: d.sync_status,
        drive_view_link: d.drive_view_link,
        // Lets the client ask for Drive's own small preview. Without it a
        // synced document has no url (filename is nulled on upload) and no
        // way to render anything but an icon.
        drive_file_id: d.drive_file_id,
        uploaded_by_name: d.uploaded_by_name,
      });
    }

    // Images are counted separately because they are the ones an admin can
    // eyeball to re-verify; a PDF report cannot be checked at a glance.
    for (const e of byPatient.values()) {
      e.image_count = e.documents.filter(
        (d) => (d.mime_type || '').startsWith('image/')).length;
      e.documents_synced = e.documents.filter(
        (d) => d.sync_status === 'synced').length;
      const v = verified.get(e.patient_id);
      e.verified = !!v;
      e.verified_by = v ? v.by : null;
      e.verified_at = v ? v.at : null;
    }

    // Busiest first — that is what an admin scanning the day is looking for.
    const patients = [...byPatient.values()].sort((a, b) => {
      const w = (x) => x.sessions.length * 10 + x.documents.length;
      return w(b) - w(a) || a.patient_code.localeCompare(b.patient_code);
    });

    const synced = docs.filter((d) => d.sync_status === 'synced').length;
    const failed = docs.filter((d) => d.sync_status === 'failed').length;

    res.json({
      from,
      to,
      tz: zone,
      verifications_available: verificationsAvailable,
      summary: {
        patients: patients.length,
        treated: patients.filter((p) => p.sessions.length).length,
        sessions: sessions.length,
        marks: sessions.reduce((n, s) => n + (Number(s.mark_count) || 0), 0),
        documents: docs.length,
        images: docs.filter((d) => (d.mime_type || '').startsWith('image/')).length,
        verified: [...byPatient.values()].filter((e) => e.verified).length,
        documents_synced: synced,
        documents_failed: failed,
        documents_pending: docs.length - synced - failed,
      },
      patients,
    });
  } catch (e) {
    console.error('[reports/activity]', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/reports/verify   { patient_id, from, to, verified }   (admin)
//
// Records (or clears) "I have checked this patient's record for this period".
// Idempotent: pressing it twice leaves the same single row, so a double-click
// cannot produce two conflicting marks.
router.post('/verify', authRequired(['admin']), async (req, res) => {
  const patientId = +(req.body || {}).patient_id;
  const from = String((req.body || {}).from || '').trim();
  const to = String((req.body || {}).to || '').trim();
  const verified = (req.body || {}).verified !== false;

  if (!patientId || !isDate(from) || !isDate(to)) {
    return res.status(400).json({
      error: 'patient_id, from and to are required.',
      code: 'bad_request',
    });
  }

  try {
    if (!verified) {
      await query(
        `DELETE FROM report_verifications
          WHERE patient_id = $1 AND period_from = $2 AND period_to = $3`,
        [patientId, from, to]);
      return res.json({ ok: true, verified: false });
    }

    const { rows } = await query(
      `INSERT INTO report_verifications
         (patient_id, period_from, period_to, verified_by, verified_by_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (patient_id, period_from, period_to) DO UPDATE
          SET verified_by = EXCLUDED.verified_by,
              verified_by_name = EXCLUDED.verified_by_name,
              verified_at = NOW()
       RETURNING verified_by_name, verified_at`,
      // The JWT carries { id, role, username } only - no display name - so
      // username is what gets stamped. Denormalised into the row so the mark
      // still says who made it even if that account is later removed.
      [patientId, from, to, req.user.id || null, req.user.username || null]);

    res.json({
      ok: true,
      verified: true,
      verified_by: rows[0] ? rows[0].verified_by_name : null,
      verified_at: rows[0] ? rows[0].verified_at : null,
    });
  } catch (e) {
    if (e.code === '42P01') {
      // Say exactly what to run, rather than leaking a Postgres error.
      return res.status(503).json({
        error: 'Verification marks need one database migration: '
          + 'db/migrations/003_report_verifications.sql',
        code: 'migration_required',
      });
    }
    console.error('[reports/verify]', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
