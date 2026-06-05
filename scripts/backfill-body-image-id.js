// One-shot backfill: stamp body_image_id on legacy marks that were saved
// before that column was tracked. Usage:
//
//   node scripts/backfill-body-image-id.js <imageId> [--apply]
//
// Without --apply the script only reports what it WOULD do (dry run).
//
// Safety:
//   - Verifies the target body_image row exists.
//   - Only touches rows where body_image_id IS NULL.
//   - Wraps the UPDATE in a transaction.
//   - Prints before/after counts.

const { pool, tx } = require('../db/pool');

(async () => {
  const targetId = +process.argv[2];
  const apply    = process.argv.includes('--apply');

  if (!Number.isFinite(targetId) || targetId <= 0) {
    console.error('Usage: node scripts/backfill-body-image-id.js <imageId> [--apply]');
    process.exit(1);
  }

  try {
    const img = await pool.query(
      `SELECT id, original_name, filename, is_active
         FROM body_images WHERE id = $1`,
      [targetId]
    );
    if (!img.rows.length) {
      console.error(`body_images id=${targetId} does not exist. Aborting.`);
      process.exit(1);
    }
    console.log('Target image:', img.rows[0]);

    const before = await pool.query(
      `SELECT
         COUNT(*)::int                                       AS total_marks,
         COUNT(*) FILTER (WHERE body_image_id IS NULL)::int  AS null_marks,
         COUNT(DISTINCT session_id) FILTER (WHERE body_image_id IS NULL)::int AS null_sessions
       FROM marks`
    );
    console.log('Before:', before.rows[0]);

    if (before.rows[0].null_marks === 0) {
      console.log('Nothing to backfill. Done.');
      process.exit(0);
    }

    if (!apply) {
      console.log(`Dry run — would set body_image_id=${targetId} on ${before.rows[0].null_marks} marks.`);
      console.log('Re-run with --apply to actually update.');
      process.exit(0);
    }

    const updated = await tx(async (c) => {
      const r = await c.query(
        `UPDATE marks SET body_image_id = $1 WHERE body_image_id IS NULL`,
        [targetId]
      );
      return r.rowCount;
    });
    console.log(`Updated ${updated} mark row(s).`);

    const after = await pool.query(
      `SELECT
         COUNT(*)::int                                       AS total_marks,
         COUNT(*) FILTER (WHERE body_image_id IS NULL)::int  AS null_marks
       FROM marks`
    );
    console.log('After:', after.rows[0]);
  } catch (e) {
    console.error('Backfill failed:', e);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
