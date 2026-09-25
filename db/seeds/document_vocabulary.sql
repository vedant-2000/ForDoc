-- The document vocabulary: categories and tags.
--
-- Applied by `npm run db:init` (db/init.js runs this straight after
-- schema.sql), and safe to run on its own against a live database:
--
--   psql "$DATABASE_URL" -f db/seeds/document_vocabulary.sql
--
-- WHAT IT FILLS IN
--   document_categories   what a document is filed AS - the key stored on the
--                         row, the label the apps show, and the Drive
--                         subfolder it goes into. Seeded with exactly the
--                         eight that used to be hard-coded, so nothing moves
--                         in Drive and nothing already filed changes meaning.
--   document_tag_options  the labels the upload screens OFFER as tags. Seeded
--                         with the same words the app showed before this list
--                         existed, plus any tag already on a document, so the
--                         tag pickers are useful from the first run instead
--                         of blank.
--
-- RE-RUNNABLE, AND IT WILL NOT UNDO YOUR EDITS
-- Each list is seeded only while it is EMPTY. Once an admin has edited either
-- one - including removing something - running this again changes nothing.
-- The tables themselves are created only if missing.

BEGIN;

-- ── Tables ────────────────────────────────────────────────────────────
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

CREATE TABLE IF NOT EXISTS document_tag_options (
    id          SERIAL PRIMARY KEY,
    label       TEXT UNIQUE NOT NULL,
    sort_order  INT  NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_document_tag_options_order
    ON document_tag_options(sort_order);

-- ── Categories ────────────────────────────────────────────────────────
-- 'treatment' and 'other' are not decoration: a saved treatment record files
-- itself under the first, and anything unrecognised falls back to the second.
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

-- ── Tags ──────────────────────────────────────────────────────────────
-- The app's own labels first, then anything already used on a document that
-- is not one of them. DISTINCT ON (lower(label)) means a clinic that has been
-- typing 'x-ray' does not end up with that AND 'X-Ray' - the app's spelling
-- wins, because it sorts first.
INSERT INTO document_tag_options (label, sort_order)
SELECT t.label, (ROW_NUMBER() OVER (ORDER BY t.ord, t.label)) - 1
  FROM (
        SELECT DISTINCT ON (lower(s.label)) s.label, s.ord
          FROM (
                SELECT v.label, v.ord
                  FROM (VALUES
                        ('X-Ray',        0),
                        ('Scan',         1),
                        ('Report',       2),
                        ('Prescription', 3),
                        ('Photo',        4),
                        ('Body photo',   5),
                        ('Other',        6)
                       ) AS v(label, ord)
                 UNION ALL
                -- Whatever the clinic has already tagged documents with, so
                -- nothing in use disappears from the offer.
                SELECT btrim(x), 100
                  FROM patient_documents d,
                       unnest(COALESCE(d.tags, ARRAY[]::TEXT[])) AS x
                 WHERE btrim(x) <> ''
               ) s
         ORDER BY lower(s.label), s.ord
       ) t
 WHERE NOT EXISTS (SELECT 1 FROM document_tag_options);

COMMIT;

-- Verify (read-only):
--   SELECT key, label, folder_name FROM document_categories ORDER BY sort_order;
--   SELECT label FROM document_tag_options ORDER BY sort_order;
