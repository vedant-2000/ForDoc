-- Document categories ("X-Ray", "Prescription", …) — standalone migration.
--
-- The vocabulary used to be hard-coded in three places that had to agree:
-- routes/documents.js (the accepted keys), utils/drive.js (the Drive
-- subfolder each one files into) and the apps' own label maps. Adding a
-- category meant editing all three and shipping a new build. This table is
-- the one copy; the code falls back to the same built-in defaults when the
-- table is missing, so an un-migrated server behaves exactly as before.
--
--   key          what is stored on the document and never changes
--   label        what the apps show
--   folder_name  the subfolder inside the patient's Drive folder
--
-- Seeded with today's eight, identical to the values that were hard-coded,
-- so nothing moves in Drive and nothing already filed changes meaning.
--
--   psql "$DATABASE_URL" -f db/migrations/011_document_categories.sql

-- NOTE: db/seeds/document_vocabulary.sql supersedes this file - it creates the
-- same table with the same eight categories, and `npm run db:init` applies it.
-- Running both is safe.

BEGIN;

CREATE TABLE IF NOT EXISTS document_categories (
    id          SERIAL PRIMARY KEY,
    key         TEXT UNIQUE NOT NULL,
    label       TEXT NOT NULL,
    folder_name TEXT NOT NULL,
    sort_order  INT  NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_categories_order
    ON document_categories(sort_order);

INSERT INTO document_categories (key, label, folder_name, sort_order)
SELECT v.key, v.label, v.folder, v.ord
  FROM (VALUES
        ('xray',         'X-Ray',            'X-Ray',             0),
        ('scan',         'Scan',             'Scans',             1),
        ('report',       'Report',           'Reports',           2),
        ('prescription', 'Prescription',     'Prescriptions',     3),
        ('photo',        'Photo',            'Photos',            4),
        ('body',         'Body photo',       'Body Photos',       5),
        ('treatment',    'Treatment record', 'Treatment Records', 6),
        ('other',        'Other',            'Other',             7)
       ) AS v(key, label, folder, ord)
 WHERE NOT EXISTS (SELECT 1 FROM document_categories);

COMMIT;

-- Verify (read-only):
--   SELECT key, label, folder_name, sort_order
--     FROM document_categories ORDER BY sort_order;
