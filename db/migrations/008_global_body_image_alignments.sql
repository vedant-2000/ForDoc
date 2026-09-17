-- Body-image alignment is image geometry, not patient data. Configure it once
-- in Admin > Body Images and reuse it for every All Treatments view.
CREATE TABLE IF NOT EXISTS body_image_alignments_global (
    source_image_id  INT NOT NULL REFERENCES body_images(id) ON DELETE CASCADE,
    target_image_id  INT NOT NULL REFERENCES body_images(id) ON DELETE CASCADE,
    offset_x         NUMERIC(8,6) NOT NULL DEFAULT 0,
    offset_y         NUMERIC(8,6) NOT NULL DEFAULT 0,
    scale            NUMERIC(8,6) NOT NULL DEFAULT 1,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_image_id, target_image_id)
);

-- Preserve any alignment already saved through the earlier patient-scoped
-- screen. If several patients saved the same pair, the newest one wins.
INSERT INTO body_image_alignments_global
  (source_image_id, target_image_id, offset_x, offset_y, scale, updated_at)
SELECT DISTINCT ON (source_image_id, target_image_id)
       source_image_id, target_image_id, offset_x, offset_y, scale, updated_at
  FROM body_image_alignments
 ORDER BY source_image_id, target_image_id, updated_at DESC
ON CONFLICT (source_image_id, target_image_id) DO NOTHING;
