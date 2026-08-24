-- Patient problems + documents (Drive-backed)  —  standalone migration
--
-- These statements are ALSO in db/schema.sql, so `npm run db:init` applies
-- them. This copy exists so the change can be reviewed and run on its own,
-- against a server where you would rather not run the whole schema file.
--
-- Safe to run more than once: every statement is IF NOT EXISTS / ON CONFLICT.
-- Nothing here drops, renames or rewrites an existing column, and no existing
-- row is modified.
--
--   psql "$DATABASE_URL" -f db/migrations/001_patient_documents.sql

BEGIN;

-- ── Where in Drive documents are filed (single row, id = 1) ──
CREATE TABLE IF NOT EXISTS drive_settings (
    id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    root_folder_id      TEXT,
    root_path           TEXT NOT NULL DEFAULT 'Treatment Record',
    patient_folder_tmpl TEXT NOT NULL DEFAULT '{code} - {name}',
    category_subfolders BOOLEAN NOT NULL DEFAULT TRUE,
    date_subfolders     BOOLEAN NOT NULL DEFAULT FALSE,
    make_links_public   BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO drive_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE drive_settings
    ADD COLUMN IF NOT EXISTS auto_create_patient_folder BOOLEAN NOT NULL DEFAULT TRUE;

-- ── The complaints a patient is being treated for ──
CREATE TABLE IF NOT EXISTS patient_problems (
    id              SERIAL PRIMARY KEY,
    patient_id      INT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    description     TEXT,
    severity        TEXT,                                -- mild | moderate | severe
    status          TEXT NOT NULL DEFAULT 'open',        -- open | resolved
    noted_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    resolved_on     DATE,
    created_by_name TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patient_problems_patient
    ON patient_problems (patient_id, noted_on DESC, id DESC);

-- ── Uploaded files. Bytes live in backend/uploads AND Google Drive; only
--    the links are stored here. sync_status tracks the Drive half alone, so
--    a failed push leaves a fully usable document that can be retried. ──
CREATE TABLE IF NOT EXISTS patient_documents (
    id                  SERIAL PRIMARY KEY,
    patient_id          INT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    session_id          INT REFERENCES treatment_sessions(id) ON DELETE SET NULL,
    problem_id          INT REFERENCES patient_problems(id) ON DELETE SET NULL,
    category            TEXT NOT NULL DEFAULT 'other',
    title               TEXT,
    notes               TEXT,
    doc_date            DATE NOT NULL DEFAULT CURRENT_DATE,
    filename            TEXT,
    original_name       TEXT,
    mime_type           TEXT,
    size_bytes          BIGINT,
    drive_file_id       TEXT,
    drive_view_link     TEXT,
    drive_download_link TEXT,
    drive_folder_id     TEXT,
    drive_path          TEXT,
    sync_status         TEXT NOT NULL DEFAULT 'pending', -- pending|synced|failed|skipped
    sync_error          TEXT,
    uploaded_by         INT,
    uploaded_by_name    TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_patient_documents_patient
    ON patient_documents (patient_id, doc_date DESC, id DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_patient_documents_problem
    ON patient_documents (problem_id) WHERE problem_id IS NOT NULL;

-- ── Each patient's own Drive folder, created with the patient ──
ALTER TABLE patients ADD COLUMN IF NOT EXISTS drive_folder_id   TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS drive_folder_path TEXT;

COMMIT;

-- Verify (read-only):
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN ('drive_settings','patient_problems','patient_documents');
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name='patients' AND column_name LIKE 'drive_%';
