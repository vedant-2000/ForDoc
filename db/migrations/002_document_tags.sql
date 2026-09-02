-- Document tags — standalone migration.
--
-- Also present in db/schema.sql, so `npm run db:init` applies it. Safe to run
-- repeatedly; adds one nullable column and one index, changes no existing row.
--
--   psql "$DATABASE_URL" -f db/migrations/002_document_tags.sql

BEGIN;

ALTER TABLE patient_documents ADD COLUMN IF NOT EXISTS tags TEXT[];

CREATE INDEX IF NOT EXISTS idx_patient_documents_tags
    ON patient_documents USING GIN (tags);

COMMIT;

-- Verify (read-only):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'patient_documents' AND column_name = 'tags';
