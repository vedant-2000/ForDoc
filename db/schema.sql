-- ============================================================
-- Treatment-Plan schema (PostgreSQL, no ORM)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- ltree: label-tree type used for hierarchical category paths in the store
-- module (e.g. 'medicines.antibiotics.penicillin'). Supports fast subtree
-- lookups with GiST.
CREATE EXTENSION IF NOT EXISTS ltree;

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

-- Soft-delete support: deleted_at marks the row as removed but preserves all
-- history (sessions, marks, etc. cascade off patients.id). The UNIQUE
-- constraint on patient_code is replaced with a partial index so the same
-- code/name can be re-used for a new patient after a soft-delete.
ALTER TABLE patients ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_patient_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_patients_code_active
    ON patients (patient_code) WHERE deleted_at IS NULL;

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

-- A binary mask PNG (white = blank-region, transparent = body) painted by the
-- admin with the wand + lasso editor. Used to relocate edge-mark callouts
-- so they sit in the empty space around the silhouette instead of on top of it.
ALTER TABLE body_images ADD COLUMN IF NOT EXISTS blank_mask_filename TEXT;

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

-- Cumulative clinical measurements collected once per session (per patient,
-- per date) — NOT per mark. Captured in the marker page's session bar.
--   pct_bt → % Before Treatment
--   pct_at → % After Treatment
--   ss     → SS (severity score)
ALTER TABLE treatment_sessions ADD COLUMN IF NOT EXISTS pct_bt NUMERIC(6,2);
ALTER TABLE treatment_sessions ADD COLUMN IF NOT EXISTS pct_at NUMERIC(6,2);
ALTER TABLE treatment_sessions ADD COLUMN IF NOT EXISTS ss     NUMERIC(6,2);

-- Session-creator label. Populated at insert-time so an admin-created
-- session (which has doctor_id = NULL, since admins aren't in `doctors`)
-- still has a name to display in the session list instead of an em-dash.
ALTER TABLE treatment_sessions ADD COLUMN IF NOT EXISTS created_by_name TEXT;

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
    size            NUMERIC(4,2) NOT NULL DEFAULT 1.0,   -- visual scale multiplier (0.5..2.0)
    room            TEXT,                                -- R-1..R-10
    treatment       TEXT,                                -- label (e.g. SLT, IMS)
    effectiveness   TEXT,                                -- 1Q..5Q
    sitting_position TEXT,                               -- e.g. Sitting / Standing / Prone
    note            TEXT,
    client_id       TEXT,                                -- stable client-generated id (survives save/reorder)
    connected_to_cid TEXT,                               -- client_id of the previous mark in a same-treatment chain
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent: add doctor_id to legacy installs that pre-date this column.
ALTER TABLE marks ADD COLUMN IF NOT EXISTS doctor_id INT REFERENCES doctors(id) ON DELETE SET NULL;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS size NUMERIC(4,2) NOT NULL DEFAULT 1.0;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS client_id TEXT;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS connected_to_cid TEXT;
ALTER TABLE marks ADD COLUMN IF NOT EXISTS sitting_position TEXT;
-- Multi-room support: new marks store the set of rooms selected once at the
-- top of the marker page in this array. Legacy marks keep their single `room`
-- TEXT value populated; `room_ids` stays NULL for them.
ALTER TABLE marks ADD COLUMN IF NOT EXISTS room_ids TEXT[];
-- Clinical measurements collected per treatment.
--   pct_bt → % Before Treatment
--   pct_at → % After Treatment
--   ss     → SS (severity score)
ALTER TABLE marks ADD COLUMN IF NOT EXISTS pct_bt NUMERIC(6,2);
ALTER TABLE marks ADD COLUMN IF NOT EXISTS pct_at NUMERIC(6,2);
ALTER TABLE marks ADD COLUMN IF NOT EXISTS ss     NUMERIC(6,2);

-- Freehand strokes: chain-of-glyphs marks (double-tap-drag with circle/dot/
-- square/star tools) and smooth-curve marks (double-tap-drag with the curve
-- tool) store the polyline path as a JSONB array of [rel_x, rel_y] pairs.
-- Empty / NULL for single-point marks.
ALTER TABLE marks ADD COLUMN IF NOT EXISTS path JSONB;

-- Patient/date uniqueness is enforced at the session level
-- (treatment_sessions has UNIQUE (patient_id, session_date)). The same
-- treatment may legitimately be applied to multiple body regions within one
-- visit, so we do NOT constrain (session_id, treatment) here.
DROP INDEX IF EXISTS uq_marks_session_treatment;

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

-- ── Rooms (editable list of treatment rooms) ──────────────
-- Treatments and marks reference a room by its NAME. Renames cascade through
-- the rooms PUT route so historical denormalised references stay in sync.
CREATE TABLE IF NOT EXISTS rooms (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    sort_order  INT  NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rooms_order ON rooms(sort_order, name);

-- Seed rooms 1..10 on a fresh install (idempotent — won't duplicate if rerun).
INSERT INTO rooms (name, sort_order)
SELECT n::TEXT, n
FROM   generate_series(1, 10) n
ON CONFLICT (name) DO NOTHING;

-- ── Treatment catalog (room → allowed treatments) ─────────
-- Editable by admin via the dashboard; the marker UI fetches from here.
CREATE TABLE IF NOT EXISTS treatment_catalog (
    id          SERIAL PRIMARY KEY,
    room        TEXT NOT NULL,                       -- references rooms.name (no FK; cascaded by app)
    treatment   TEXT NOT NULL,                       -- 'SLT', 'IMS', ...
    sort_order  INT  NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (room, treatment)
);
CREATE INDEX IF NOT EXISTS idx_treatment_catalog_room
    ON treatment_catalog(room, sort_order);

-- Register legacy treatment_catalog room values (e.g. 'R-1', 'R-2') in the
-- rooms table so they appear in the new admin Rooms panel for review/rename.
INSERT INTO rooms (name, sort_order)
SELECT DISTINCT room, 999
FROM   treatment_catalog
ON CONFLICT (name) DO NOTHING;

-- ── Treatment color palette ───────────────────────────────────────
-- Global, room-agnostic ordering of treatments → drives which palette
-- color each treatment renders in. The top N (= color_palette size) get
-- distinct colors; anything beyond wraps. Admin reorders to put the
-- most-used treatments into the top N from the Treatment Order panel.
CREATE TABLE IF NOT EXISTS treatments_palette (
    id          SERIAL PRIMARY KEY,
    treatment   TEXT NOT NULL UNIQUE,
    sort_order  INT  NOT NULL DEFAULT 999,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_treatments_palette_order
    ON treatments_palette(sort_order, treatment);

-- Seed from any treatment that exists in the catalog but isn't yet in the
-- palette. New treatments get an alphabetical fallback position so the
-- output stays deterministic until the admin reorders.
WITH ordered AS (
  SELECT treatment,
         ROW_NUMBER() OVER (ORDER BY treatment) AS rn
  FROM   (SELECT DISTINCT treatment FROM treatment_catalog WHERE treatment IS NOT NULL) t
)
INSERT INTO treatments_palette (treatment, sort_order)
SELECT treatment, rn FROM ordered
ON CONFLICT (treatment) DO NOTHING;

-- ── Global color palette (8 colors, repeats) ─────────────────────
-- The Nth treatment (by priority order) renders in color[N mod size].
-- Admin can edit / reorder these from the Color Palette panel.
CREATE TABLE IF NOT EXISTS color_palette (
    id          SERIAL PRIMARY KEY,
    color       TEXT NOT NULL,                         -- hex (#rrggbb)
    sort_order  INT  NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_color_palette_order ON color_palette(sort_order);

-- Seed 8 default colors on a fresh install (only when the table is empty).
INSERT INTO color_palette (color, sort_order)
SELECT * FROM (VALUES
    ('#c0392b', 1),  -- red
    ('#2980b9', 2),  -- blue
    ('#27ae60', 3),  -- green
    ('#8e44ad', 4),  -- purple
    ('#e67e22', 5),  -- orange
    ('#16a085', 6),  -- teal
    ('#2c3e50', 7),  -- slate
    ('#b59e25', 8)   -- olive
) AS seed(color, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM color_palette);

-- ── Sitting-position catalog (single global list) ─────────
CREATE TABLE IF NOT EXISTS sitting_positions (
    id          SERIAL PRIMARY KEY,
    position    TEXT UNIQUE NOT NULL,
    sort_order  INT  NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sitting_positions_order
    ON sitting_positions(sort_order);

-- ============================================================
-- Store / Inventory module
-- ============================================================
-- Independent from the treatment-plan tables. `store_categories.path` uses
-- the ltree extension so arbitrary depths are supported natively — no
-- adjacency-list recursion needed for "give me every item under
-- medicines.antibiotics".
CREATE TABLE IF NOT EXISTS store_categories (
    id          SERIAL PRIMARY KEY,
    path        LTREE UNIQUE NOT NULL,               -- e.g. 'medicines.antibiotics.penicillin'
    name        TEXT NOT NULL,                       -- display name of THIS node
    sort_order  INT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_store_categories_path_gist
    ON store_categories USING GIST (path);
CREATE INDEX IF NOT EXISTS idx_store_categories_path_btree
    ON store_categories USING BTREE (path);
CREATE INDEX IF NOT EXISTS idx_store_categories_sort
    ON store_categories (sort_order, name);

-- A registered material lives under exactly one category node (the deepest
-- one that applies). We store `category_path` as a plain LTREE so the client
-- can filter items with `WHERE category_path <@ 'medicines.antibiotics'`.
CREATE TABLE IF NOT EXISTS store_items (
    id             SERIAL PRIMARY KEY,
    category_path  LTREE NOT NULL,
    name           TEXT NOT NULL,
    code           TEXT UNIQUE,                     -- SKU / short code (optional)
    unit           TEXT,                            -- e.g. 'tablet', 'bottle'
    notes          TEXT,
    is_active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_store_items_cat
    ON store_items USING GIST (category_path);
CREATE INDEX IF NOT EXISTS idx_store_items_name
    ON store_items (LOWER(name));
CREATE INDEX IF NOT EXISTS idx_store_items_code
    ON store_items (code) WHERE code IS NOT NULL;

-- Inward = a physical arrival of stock at a specific price/date/location.
-- Each row is one batch. Total on-hand for an item is derived on read:
-- SUM(inward.quantity) − SUM(outward.quantity).
CREATE TABLE IF NOT EXISTS store_inward (
    id                SERIAL PRIMARY KEY,
    item_id           INT NOT NULL REFERENCES store_items(id) ON DELETE RESTRICT,
    inward_date       DATE NOT NULL,
    quantity          NUMERIC(12,3) NOT NULL,        -- fractional units allowed (bottles, ml, etc.)
    unit_price        NUMERIC(12,2) NOT NULL,        -- cost per unit at inward
    storage_location  TEXT,                          -- optional shelf / cupboard label
    supplier          TEXT,
    notes             TEXT,
    created_by_name   TEXT,                          -- snapshot of user who logged the arrival
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_store_inward_item
    ON store_inward (item_id, inward_date DESC);

-- Outward = an issue / allotment.  `allotted_by_id` + `_role` disambiguates
-- doctor vs admin (they're separate tables — no shared user id space).
-- `allotted_to_name` is a free-text recipient (patient's caretaker,
-- department, external doctor…); `allotted_to_patient_id` is set when the
-- issue is directly tied to a patient in this system.
CREATE TABLE IF NOT EXISTS store_outward (
    id                       SERIAL PRIMARY KEY,
    item_id                  INT NOT NULL REFERENCES store_items(id) ON DELETE RESTRICT,
    inward_id                INT REFERENCES store_inward(id) ON DELETE SET NULL,
    allotted_by_id           INT,
    allotted_by_role         TEXT,                   -- 'doctor' | 'admin'
    allotted_by_name         TEXT,                   -- snapshot
    allotted_to_name         TEXT,                   -- freeform recipient
    allotted_to_patient_id   INT REFERENCES patients(id) ON DELETE SET NULL,
    quantity                 NUMERIC(12,3) NOT NULL,
    unit_price               NUMERIC(12,2),          -- actual price at issue (nullable → falls back to inward price on display)
    outward_date             DATE NOT NULL,
    notes                    TEXT,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_store_outward_item
    ON store_outward (item_id, outward_date DESC);
CREATE INDEX IF NOT EXISTS idx_store_outward_patient
    ON store_outward (allotted_to_patient_id) WHERE allotted_to_patient_id IS NOT NULL;

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
