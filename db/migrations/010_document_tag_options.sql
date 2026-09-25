-- Document / photo tags the app offers — standalone migration.
--
-- Tags themselves already exist: patient_documents.tags is a TEXT[] and any
-- text could be typed into it. What was missing is the LIST the app offers
-- when a photo is uploaded, so the same X-ray is not filed as 'xray', 'X Ray'
-- and 'x-ray' by three people. This table is that list; the column stays free
-- text, so nothing already filed is affected.
--
-- Also present in db/schema.sql, so `npm run db:init` applies it to a fresh
-- database. Safe to run repeatedly: it creates one table and seeds it only
-- when it is empty.
--
--   psql "$DATABASE_URL" -f db/migrations/010_document_tag_options.sql

-- NOTE: db/seeds/document_vocabulary.sql supersedes this file - it creates
-- the same table and seeds a fuller list (the app's own labels as well as the
-- tags already in use), and `npm run db:init` applies it. Running both is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS document_tag_options (
    id          SERIAL PRIMARY KEY,
    label       TEXT UNIQUE NOT NULL,
    sort_order  INT  NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_tag_options_order
    ON document_tag_options(sort_order);

-- Seed from the tags the clinic is ALREADY using, most used first, so the
-- list starts as what is actually on their documents rather than something
-- invented here. Only when the table is empty, so an admin who edits the
-- list does not get it repopulated by a later run.
INSERT INTO document_tag_options (label, sort_order)
SELECT t.label, (ROW_NUMBER() OVER (ORDER BY t.uses DESC, t.label)) - 1
  FROM (
        SELECT btrim(x) AS label, COUNT(*) AS uses
          FROM patient_documents d, unnest(COALESCE(d.tags, ARRAY[]::TEXT[])) AS x
         WHERE btrim(x) <> ''
         GROUP BY btrim(x)
       ) t
 WHERE NOT EXISTS (SELECT 1 FROM document_tag_options);

COMMIT;

-- Verify (read-only):
--   SELECT label, sort_order FROM document_tag_options ORDER BY sort_order;
