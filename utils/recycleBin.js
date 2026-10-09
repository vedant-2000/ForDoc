// The recycle bin: list what was deleted (and by whom), and put it back.
//
// Rows land in deleted_records two ways:
//   - kind 'hard': the trigger in db/migrations/012_recycle_bin.sql copies
//     every row deleted from a clinical/settings table, cascades included.
//     The bin copy is the only copy; restoring re-inserts it.
//   - kind 'soft': routes that hide a row in place (patients, sessions,
//     documents, store items/categories, a body-image mask) log it here with
//     logSoftDelete(), so one list answers "who deleted what" for both.
//
// Files are never erased by a delete any more: trashFile() moves them under
// uploads/.trash/ (express.static ignores dot-folders, so it is not served)
// and restore moves them back.

const fs = require('fs');
const path = require('path');
const { query, tx } = require('../db/pool');
const actor = require('./actor');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const TRASH_DIR = path.join(UPLOADS_ROOT, '.trash');

// Restore order: a parent must exist again before the rows that point at it.
// Also the whitelist - a table name from the bin is only ever interpolated
// into SQL if it is in this list.
const RESTORE_ORDER = [
  'doctors', 'patients', 'body_images', 'rooms',
  'store_categories', 'store_items',
  'document_categories', 'document_tag_options', 'sitting_positions',
  'effectiveness_options', 'treatments_palette', 'color_palette',
  'treatment_catalog', 'patient_problems', 'treatment_sessions', 'marks',
  'treatment_reports', 'patient_documents', 'report_verifications',
  'body_image_alignments', 'body_image_alignments_global',
  'store_item_photos', 'store_inward', 'store_outward',
];

const posix = (p) => p.split(path.sep).join('/');

/// Record a soft delete (the row stays in its table, flagged). [data] is the
/// row as it was; [db] is a tx client when called inside one.
async function logSoftDelete(table, pk, data, extra = null, db = { query }) {
  const a = actor.current() || {};
  await db.query(
    `INSERT INTO deleted_records
       (table_name, row_pk, kind, data, extra,
        deleted_by_id, deleted_by_name, deleted_by_role, source)
     VALUES ($1, $2, 'soft', $3::jsonb, $4::jsonb, $5, $6, $7, $8)`,
    [table, pk == null ? null : String(pk), JSON.stringify(data || {}),
      extra ? JSON.stringify(extra) : null,
      Number.isInteger(a.id) ? a.id : null, a.name || 'system', a.role || null,
      a.source || null]);
}

/// Merge [extra] into the newest bin entry for this row - used to remember
/// links a delete broke (ON DELETE SET NULL) and files moved to trash, so a
/// restore can put them back too.
async function annotateLatest(table, pk, extra, db = { query }) {
  await db.query(
    `UPDATE deleted_records
        SET extra = COALESCE(extra, '{}'::jsonb) || $3::jsonb
      WHERE id = (SELECT MAX(id) FROM deleted_records
                   WHERE table_name = $1 AND row_pk = $2)`,
    [table, String(pk), JSON.stringify(extra)]);
}

/// For "save the whole list" endpoints that DELETE everything and re-insert:
/// drop this transaction's bin entries for rows that came straight back, so
/// the bin holds only what the save actually removed. [keys] are the columns
/// that identify an entry (constants from our own routes - never user input).
async function pruneReinserted(c, table, keys) {
  if (!RESTORE_ORDER.includes(table)) throw new Error(`unknown table ${table}`);
  const same = keys.map((k) => `t.${k}::text = d.data ->> '${k}'`).join(' AND ');
  await c.query(
    `DELETE FROM deleted_records d
      WHERE d.tx_id = txid_current() AND d.table_name = $1 AND d.kind = 'hard'
        AND EXISTS (SELECT 1 FROM ${table} t WHERE ${same})`,
    [table]);
}

/// Same idea for a session's marks, which are re-saved as a whole on every
/// save: keep only marks that are no longer there. A mark is "the same" by
/// its client_id, or - for old marks saved before client ids - by position
/// and treatment.
async function pruneResavedMarks(c, sessionId) {
  await c.query(
    `DELETE FROM deleted_records d
      WHERE d.tx_id = txid_current() AND d.table_name = 'marks' AND d.kind = 'hard'
        AND EXISTS (
          SELECT 1 FROM marks m
           WHERE m.session_id = $1
             AND (
               (d.data ->> 'client_id' IS NOT NULL
                 AND m.client_id = d.data ->> 'client_id')
               OR
               (d.data ->> 'client_id' IS NULL
                 AND m.rel_x = (d.data ->> 'rel_x')::numeric
                 AND m.rel_y = (d.data ->> 'rel_y')::numeric
                 AND COALESCE(m.treatment, '') = COALESCE(d.data ->> 'treatment', ''))
             ))`,
    [sessionId]);
}

/// Move an uploaded file into uploads/.trash instead of deleting it. Returns
/// { original, trash } (paths relative to uploads/) or null if it was absent.
function trashFile(absPath) {
  try {
    if (!absPath || !fs.existsSync(absPath)) return null;
    const rel = path.relative(UPLOADS_ROOT, absPath);
    if (rel.startsWith('..')) return null; // not ours to move
    const dest = path.join(TRASH_DIR, path.dirname(rel),
      `${Date.now()}-${path.basename(rel)}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    moveFile(absPath, dest);
    return { original: posix(rel), trash: posix(path.relative(UPLOADS_ROOT, dest)) };
  } catch (e) {
    console.warn('[recycle-bin] could not trash', absPath, e.message);
    return null;
  }
}

function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

function untrashFiles(files) {
  const out = [];
  for (const f of files || []) {
    const from = path.join(UPLOADS_ROOT, f.trash);
    const to = path.join(UPLOADS_ROOT, f.original);
    if (!fs.existsSync(from)) { out.push(`missing in trash: ${f.trash}`); continue; }
    if (fs.existsSync(to)) { out.push(`already present: ${f.original}`); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    moveFile(from, to);
    out.push(`restored file ${f.original}`);
  }
  return out;
}

/// Newest first. Filters: table, include restored entries.
async function list({ table = null, limit = 50, offset = 0, includeRestored = false } = {}) {
  const where = [];
  const params = [];
  if (table) { params.push(table); where.push(`table_name = $${params.length}`); }
  if (!includeRestored) where.push('restored_at IS NULL');
  params.push(Math.min(Math.max(+limit || 50, 1), 500));
  params.push(Math.max(+offset || 0, 0));
  const { rows } = await query(
    `SELECT id, table_name, row_pk, kind, data, extra, deleted_by_id,
            deleted_by_name, deleted_by_role, source, tx_id::text AS tx_id,
            deleted_at, restored_at, restored_by_name
       FROM deleted_records
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params);
  return rows;
}

/// One-line human description of a bin entry.
function describe(r) {
  const d = r.data || {};
  const name = d.full_name || d.name || d.treatment || d.label || d.position
    || d.color || d.original_name || d.title || d.patient_code
    || d.session_date || d.filename || '';
  return `${r.table_name}#${r.row_pk || '-'}${name ? ` "${name}"` : ''}`;
}

/// Restore a bin entry. A 'hard' entry brings back every row deleted in the
/// same transaction (a purged patient comes back with its sessions and
/// marks), unless [only] is set. Dry run unless [apply]. Returns
/// { ok, plan: [...], notes: [...], error? }.
async function restore(binId, { apply = false, only = false, by = 'system' } = {}) {
  const { rows } = await query('SELECT * FROM deleted_records WHERE id = $1', [binId]);
  if (!rows.length) return { ok: false, error: `No bin entry #${binId}` };
  const rec = rows[0];
  if (rec.restored_at) {
    return { ok: false, error: `#${binId} was already restored ${rec.restored_at} by ${rec.restored_by_name || '?'}` };
  }
  if (rec.kind === 'soft') return restoreSoft(rec, { apply, by });

  let group = [rec];
  if (!only) {
    const g = await query(
      `SELECT * FROM deleted_records
        WHERE tx_id = $1 AND kind = 'hard' AND restored_at IS NULL
        ORDER BY id`,
      [rec.tx_id]);
    group = g.rows;
  }
  for (const r of group) {
    if (!RESTORE_ORDER.includes(r.table_name)) {
      return { ok: false, error: `Cannot restore table ${r.table_name}` };
    }
  }
  group.sort((a, b) =>
    (RESTORE_ORDER.indexOf(a.table_name) - RESTORE_ORDER.indexOf(b.table_name))
    || (Number(a.id) - Number(b.id)));
  const plan = group.map((r) => describe(r));
  if (!apply) return { ok: true, plan, notes: [] };

  const notes = [];
  try {
    await tx(async (c) => {
      for (const r of group) {
        await c.query(
          `INSERT INTO ${r.table_name}
           SELECT * FROM jsonb_populate_record(NULL::${r.table_name}, $1::jsonb)`,
          [JSON.stringify(r.data)]);
        const x = r.extra || {};
        // Links the delete cut (ON DELETE SET NULL), re-made only where they
        // are still empty - never over something set since.
        if (x.relink_mark_ids?.length && r.table_name === 'body_images') {
          await c.query(`UPDATE marks SET body_image_id = $1
                          WHERE id = ANY($2::int[]) AND body_image_id IS NULL`,
            [r.data.id, x.relink_mark_ids]);
        }
        if (r.table_name === 'doctors') {
          if (x.relink_mark_ids?.length) {
            await c.query(`UPDATE marks SET doctor_id = $1
                            WHERE id = ANY($2::int[]) AND doctor_id IS NULL`,
              [r.data.id, x.relink_mark_ids]);
          }
          if (x.relink_session_ids?.length) {
            await c.query(`UPDATE treatment_sessions SET doctor_id = $1
                            WHERE id = ANY($2::int[]) AND doctor_id IS NULL`,
              [r.data.id, x.relink_session_ids]);
          }
        }
        if (x.relink_document_ids?.length && r.table_name === 'patient_problems') {
          await c.query(`UPDATE patient_documents SET problem_id = $1
                          WHERE id = ANY($2::int[]) AND problem_id IS NULL`,
            [r.data.id, x.relink_document_ids]);
        }
      }
      await c.query(
        `UPDATE deleted_records SET restored_at = NOW(), restored_by_name = $2
          WHERE id = ANY($1::bigint[])`,
        [group.map((r) => r.id), by]);
    });
  } catch (e) {
    // All or nothing: one row that cannot go back (its name is taken again,
    // its parent is gone) leaves everything as it was.
    return { ok: false, plan, error: restoreError(e) };
  }
  for (const r of group) notes.push(...untrashFiles(r.extra?.files));
  return { ok: true, plan, notes };
}

async function restoreSoft(rec, { apply, by }) {
  const d = rec.data || {};
  const plan = [`un-delete ${describe(rec)}`];
  if (!apply) return { ok: true, plan, notes: [] };
  const id = d.id;
  try {
    await tx(async (c) => {
      switch (rec.table_name) {
        case 'patients': {
          const clash = await c.query(
            `SELECT 1 FROM patients WHERE patient_code = $1 AND deleted_at IS NULL AND id <> $2`,
            [d.patient_code, id]);
          if (clash.rowCount) throw new Error(`code ${d.patient_code} is now used by an active patient`);
          await c.query('UPDATE patients SET deleted_at = NULL, updated_at = NOW() WHERE id = $1', [id]);
          break;
        }
        case 'treatment_sessions': {
          const clash = await c.query(
            `SELECT id FROM treatment_sessions
              WHERE patient_id = $1 AND session_date = $2 AND deleted_at IS NULL AND id <> $3`,
            [d.patient_id, d.session_date, id]);
          if (clash.rowCount) throw new Error(`session #${clash.rows[0].id} already exists for that patient and date`);
          await c.query(
            `UPDATE treatment_sessions SET deleted_at = NULL, deleted_by_id = NULL,
                    deleted_by_name = NULL, deleted_by_role = NULL WHERE id = $1`, [id]);
          break;
        }
        case 'patient_documents':
          await c.query('UPDATE patient_documents SET deleted_at = NULL WHERE id = $1', [id]);
          break;
        case 'store_categories':
        case 'store_items':
          await c.query(`UPDATE ${rec.table_name} SET is_active = TRUE WHERE id = $1`, [id]);
          break;
        case 'body_images': // a cleared mask
          await c.query('UPDATE body_images SET blank_mask_filename = $2 WHERE id = $1',
            [id, d.blank_mask_filename]);
          break;
        default:
          throw new Error(`no soft restore for ${rec.table_name}`);
      }
      await c.query(
        'UPDATE deleted_records SET restored_at = NOW(), restored_by_name = $2 WHERE id = $1',
        [rec.id, by]);
    });
  } catch (e) {
    return { ok: false, plan, error: restoreError(e) };
  }
  return { ok: true, plan, notes: untrashFiles(rec.extra?.files) };
}

function restoreError(e) {
  if (e.code === '23505') return `something with the same name/key exists again (${e.detail || e.message}) - rename or remove it, then restore`;
  if (e.code === '23503') return `what it belonged to is gone (${e.detail || e.message}) - restore that first`;
  return e.message;
}

module.exports = {
  logSoftDelete, annotateLatest, pruneReinserted, pruneResavedMarks,
  trashFile, list, restore, describe, RESTORE_ORDER,
};
