-- Allow old body diagrams to be stretched independently left/right and
-- top/bottom. Existing uniform alignment is preserved in both axes.
ALTER TABLE body_image_alignments_global
  ADD COLUMN IF NOT EXISTS scale_x NUMERIC(8,6) NOT NULL DEFAULT 1;
ALTER TABLE body_image_alignments_global
  ADD COLUMN IF NOT EXISTS scale_y NUMERIC(8,6) NOT NULL DEFAULT 1;

UPDATE body_image_alignments_global
   SET scale_x = scale, scale_y = scale
 WHERE scale_x = 1 AND scale_y = 1 AND scale <> 1;
