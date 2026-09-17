-- Per-patient projection of marks from an older body diagram onto the latest
-- diagram. Used only by All Treatments; original mark coordinates are intact.
CREATE TABLE IF NOT EXISTS body_image_alignments (
    patient_id       INT NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
    source_image_id  INT NOT NULL REFERENCES body_images(id) ON DELETE CASCADE,
    target_image_id  INT NOT NULL REFERENCES body_images(id) ON DELETE CASCADE,
    offset_x         NUMERIC(8,6) NOT NULL DEFAULT 0,
    offset_y         NUMERIC(8,6) NOT NULL DEFAULT 0,
    scale            NUMERIC(8,6) NOT NULL DEFAULT 1,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (patient_id, source_image_id, target_image_id)
);
