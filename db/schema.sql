-- ============================================================
-- Treatment-Plan schema (PostgreSQL, no ORM)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Admins ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
    id              SERIAL PRIMARY KEY,
    username        TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Doctors ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS doctors (
    id              SERIAL PRIMARY KEY,
    username        TEXT UNIQUE NOT NULL,
    full_name       TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    color           TEXT NOT NULL DEFAULT '#c0392b',     -- assigned by admin
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doctors_username ON doctors(username);

-- ── Patients ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS patients (
    id              SERIAL PRIMARY KEY,
    patient_code    TEXT UNIQUE NOT NULL,                -- short code shown on UI
    full_name       TEXT NOT NULL,
    phone           TEXT,                                -- used for WhatsApp share
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patients_code ON patients(patient_code);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(full_name);

-- ── Body Images (versioned — admin uploads) ────────────────
-- Coordinates of marks are stored as relative percentages (0..1)
-- of the image's natural width/height, so when the admin uploads
-- a new image, the marks still appear at the same anatomical spot.
CREATE TABLE IF NOT EXISTS body_images (
    id              SERIAL PRIMARY KEY,
    filename        TEXT NOT NULL,                       -- stored on disk
    original_name   TEXT,
    mime_type       TEXT,
    width_px        INT,
    height_px       INT,
    is_active       BOOLEAN NOT NULL DEFAULT FALSE,
    uploaded_by     INT REFERENCES admins(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- only one image active at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_body_images_one_active
    ON body_images(is_active) WHERE is_active = TRUE;

-- ── Treatment Sessions (per patient, per date) ─────────────
CREATE TABLE IF NOT EXISTS treatment_sessions (
    id              SERIAL PRIMARY KEY,
    patient_id      INT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    doctor_id       INT REFERENCES doctors(id) ON DELETE SET NULL,
    session_date    DATE NOT NULL,
    label           TEXT,                                -- free text (defaults to date)
    color           TEXT,                                -- chip color (defaults to doctor color)
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (patient_id, session_date)
);

CREATE INDEX IF NOT EXISTS idx_sessions_patient_date
    ON treatment_sessions(patient_id, session_date DESC);

-- ── Marks (each placed point on the body diagram) ──────────
CREATE TABLE IF NOT EXISTS marks (
    id              SERIAL PRIMARY KEY,
    session_id      INT NOT NULL REFERENCES treatment_sessions(id) ON DELETE CASCADE,
    body_image_id   INT REFERENCES body_images(id) ON DELETE SET NULL,
    doctor_id       INT REFERENCES doctors(id) ON DELETE SET NULL,   -- who placed this mark
    order_num       INT NOT NULL,                        -- 1st, 2nd ... within a session
    rel_x           NUMERIC(6,5) NOT NULL,               -- 0..1 of image width
    rel_y           NUMERIC(6,5) NOT NULL,               -- 0..1 of image height
    tool            TEXT NOT NULL DEFAULT 'cross',       -- cross|circle|dot|arrow|star|square
    color           TEXT NOT NULL DEFAULT '#c0392b',
    room            TEXT,                                -- R-1..R-10
    treatment       TEXT,                                -- label (e.g. SLT, IMS)
    effectiveness   TEXT,                                -- 1Q..5Q
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent: add doctor_id to legacy installs that pre-date this column.
ALTER TABLE marks ADD COLUMN IF NOT EXISTS doctor_id INT REFERENCES doctors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_marks_session ON marks(session_id, order_num);
CREATE INDEX IF NOT EXISTS idx_marks_doctor  ON marks(doctor_id);

-- ── Google Drive tokens (per admin, optional) ──────────────
CREATE TABLE IF NOT EXISTS drive_tokens (
    id              SERIAL PRIMARY KEY,
    admin_id        INT UNIQUE REFERENCES admins(id) ON DELETE CASCADE,
    access_token    TEXT,
    refresh_token   TEXT,
    scope           TEXT,
    token_type      TEXT,
    expiry_date     BIGINT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Treatment catalog (room → allowed treatments) ─────────
-- Editable by admin via the dashboard; the marker UI fetches from here.
CREATE TABLE IF NOT EXISTS treatment_catalog (
    id          SERIAL PRIMARY KEY,
    room        TEXT NOT NULL,                       -- 'R-1', 'R-2', ...
    treatment   TEXT NOT NULL,                       -- 'SLT', 'IMS', ...
    sort_order  INT  NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (room, treatment)
);
CREATE INDEX IF NOT EXISTS idx_treatment_catalog_room
    ON treatment_catalog(room, sort_order);

-- ── Treatment reports saved (for audit / re-share) ─────────
CREATE TABLE IF NOT EXISTS treatment_reports (
    id              SERIAL PRIMARY KEY,
    patient_id      INT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    session_id      INT REFERENCES treatment_sessions(id) ON DELETE SET NULL,
    drive_file_id   TEXT,
    drive_view_link TEXT,
    file_kind       TEXT,                                -- 'pdf' | 'jpg'
    created_by      INT REFERENCES doctors(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
