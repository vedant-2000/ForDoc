-- Recycle bin: every delete is recoverable and says WHO did it.
--
-- WHY A TRIGGER AND NOT deleted_at ON EVERY TABLE
-- A treatment session vanished and nothing on the server could say who
-- removed it or bring it back. The obvious fix - a deleted_at flag on every
-- table - means adding "AND deleted_at IS NULL" to the ~150 queries that read
-- rooms, catalog entries, doctors, images, store rows..., and a hidden row
-- would still hold its UNIQUE name (a deleted room "R-3" would block making a
-- new "R-3"). Missing one query resurrects data; missing a constraint breaks
-- saves. On a live clinic system that is the riskier change.
--
-- Instead, every row deleted from the tables below - by a route, by a CASCADE
-- (purging a patient takes its sessions, marks, documents...), or by a future
-- endpoint nobody has written yet - is copied whole into deleted_records,
-- inside the same transaction, together with the user who did it and the
-- request that did it. scripts/restore-deleted.js (or the admin API) puts it
-- back. Rows that were already soft-deleted in place (patients, sessions,
-- documents, store items/categories) are logged here too, as kind 'soft'.
--
-- WHO: the app sets app.actor_* with set_config(..., true) at the start of the
-- transaction that deletes (db/pool.js does this from the logged-in user).
-- A delete with no app user (a script, psql by hand) is recorded as 'system'.
--
-- Safe to run twice.
--
--   node scripts/migrate.js 012

-- ── 1. Treatment-session soft delete (who + when) ─────────────────────────
ALTER TABLE treatment_sessions ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;
ALTER TABLE treatment_sessions ADD COLUMN IF NOT EXISTS deleted_by_id   INT;
ALTER TABLE treatment_sessions ADD COLUMN IF NOT EXISTS deleted_by_name TEXT;
ALTER TABLE treatment_sessions ADD COLUMN IF NOT EXISTS deleted_by_role TEXT;

-- The blanket UNIQUE(patient_id, session_date) would stop a new session being
-- made for a date whose old session was soft-deleted. Drop it by its columns
-- (not by a guessed name) and keep uniqueness for LIVE rows only.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
      FROM pg_constraint con
     WHERE con.conrelid = 'treatment_sessions'::regclass
       AND con.contype = 'u'
       AND (SELECT array_agg(att.attname::text ORDER BY att.attname::text)
              FROM unnest(con.conkey) AS k(attnum)
              JOIN pg_attribute att
                ON att.attrelid = con.conrelid AND att.attnum = k.attnum)
           = ARRAY['patient_id', 'session_date']
  LOOP
    EXECUTE format('ALTER TABLE treatment_sessions DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_sessions_patient_date_active
    ON treatment_sessions (patient_id, session_date) WHERE deleted_at IS NULL;

-- ── 2. The bin ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deleted_records (
    id               BIGSERIAL PRIMARY KEY,
    table_name       TEXT        NOT NULL,
    row_pk           TEXT,                       -- the row's id, as text
    kind             TEXT        NOT NULL DEFAULT 'hard',
                                                 -- hard: row removed, data is the only copy
                                                 -- soft: row still in its table, flagged deleted
    data             JSONB       NOT NULL,       -- the whole row as it was
    extra            JSONB,                      -- links to re-make, files moved to trash
    deleted_by_id    INT,
    deleted_by_name  TEXT,
    deleted_by_role  TEXT,
    source           TEXT,                       -- e.g. "DELETE /api/catalog/rooms/4"
    tx_id            BIGINT      NOT NULL DEFAULT txid_current(),
                                                 -- rows removed together share it
    deleted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    restored_at      TIMESTAMPTZ,
    restored_by_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_deleted_records_when
    ON deleted_records (deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_deleted_records_row
    ON deleted_records (table_name, row_pk);
CREATE INDEX IF NOT EXISTS idx_deleted_records_tx
    ON deleted_records (tx_id);

CREATE OR REPLACE FUNCTION archive_deleted_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  actor_id TEXT := current_setting('app.actor_id', true);
BEGIN
  INSERT INTO deleted_records
    (table_name, row_pk, kind, data,
     deleted_by_id, deleted_by_name, deleted_by_role, source)
  VALUES
    (TG_TABLE_NAME, to_jsonb(OLD) ->> 'id', 'hard', to_jsonb(OLD),
     CASE WHEN actor_id ~ '^[0-9]+$' THEN actor_id::int END,
     COALESCE(NULLIF(current_setting('app.actor_name', true), ''), 'system'),
     NULLIF(current_setting('app.actor_role', true), ''),
     NULLIF(current_setting('app.actor_source', true), ''));
  RETURN OLD;
END $$;

-- Every table holding clinical records or clinic settings. Deliberately NOT
-- admins or drive_tokens: copying password hashes' owners and OAuth tokens
-- into a second table is a leak, not a safety net.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'patients', 'treatment_sessions', 'marks', 'treatment_reports',
    'patient_problems', 'patient_documents', 'report_verifications',
    'body_images', 'body_image_alignments', 'body_image_alignments_global',
    'doctors', 'rooms', 'treatment_catalog', 'treatments_palette',
    'color_palette', 'sitting_positions', 'effectiveness_options',
    'document_categories', 'document_tag_options',
    'store_categories', 'store_items', 'store_item_photos',
    'store_inward', 'store_outward'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_archive_deleted ON %I', t);
      EXECUTE format(
        'CREATE TRIGGER trg_archive_deleted AFTER DELETE ON %I '
        'FOR EACH ROW EXECUTE PROCEDURE archive_deleted_row()', t);
    END IF;
  END LOOP;
END $$;
