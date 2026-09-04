-- ============================================================
-- Replace the stock catalogue with the orthotics list.
--   Removes the old categories and items, inserts 18 categories
--   and 29 items. Runs top to bottom - nothing to uncomment.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 004_stock_catalogue.sql
--
-- TAKE A BACKUP FIRST:  npm run backup
--
-- Nothing here touches patients, documents or Google Drive.
-- ============================================================

BEGIN;

-- ── What is about to happen ─────────────────────────────────
-- Printed before anything changes, so the output above the
-- result tells you what this run was working from.
SELECT
    (SELECT COUNT(*) FROM store_categories) AS old_categories,
    (SELECT COUNT(*) FROM store_items)      AS old_items,
    (SELECT COUNT(*) FROM store_items i
      WHERE EXISTS (SELECT 1 FROM store_inward  w WHERE w.item_id = i.id)
         OR EXISTS (SELECT 1 FROM store_outward o WHERE o.item_id = i.id))
                                            AS old_items_with_history;


-- ============================================================
-- 1. Remove the old catalogue
-- ============================================================
-- Items nobody has bought or issued are deleted outright. Their
-- photo rows go with them (ON DELETE CASCADE); the FILES on disk
-- under backend/uploads/store-items/ are not touched and can be
-- cleared by hand afterwards.

DELETE FROM store_items i
 WHERE NOT EXISTS (SELECT 1 FROM store_inward  w WHERE w.item_id = i.id)
   AND NOT EXISTS (SELECT 1 FROM store_outward o WHERE o.item_id = i.id);

-- Whatever survived that delete is referenced by a purchase or an
-- issue. Those CANNOT be deleted - store_inward/store_outward hold
-- them with ON DELETE RESTRICT precisely so the money and
-- dispensing record cannot be orphaned by a catalogue edit.
--
-- They are retired instead: is_active = FALSE takes them out of
-- every list the app shows, while the history that mentions them
-- still resolves to a real item. They are parked under an
-- 'archive' category so nothing points at a category path that no
-- longer exists.

INSERT INTO store_categories (path, name, sort_order, is_active)
VALUES ('archive'::ltree, 'Archived (old stock)', 99, FALSE)
ON CONFLICT (path) DO UPDATE SET name = EXCLUDED.name, is_active = FALSE;

UPDATE store_items
   SET category_path = 'archive'::ltree,
       is_active     = FALSE,
       updated_at    = NOW()
 WHERE category_path <> 'archive'::ltree;

-- Now the old categories themselves. store_items.category_path is a
-- plain LTREE with no foreign key, so this cannot fail on the rows
-- just archived.
DELETE FROM store_categories WHERE path <> 'archive'::ltree;


-- ============================================================
-- 2. The new catalogue
-- ============================================================
-- ltree labels allow only letters, digits and underscore, so
-- "Upper Back" becomes upper_back while the display name keeps its
-- space. sort_order follows the sheet's own S.No, not the alphabet.

INSERT INTO store_categories (path, name, sort_order, is_active) VALUES
    ('finger'::ltree,        'Finger',         1,  TRUE),
    ('thumb'::ltree,         'Thumb',          2,  TRUE),
    ('wrist'::ltree,         'Wrist',          3,  TRUE),
    ('elbow'::ltree,         'Elbow',          4,  TRUE),
    ('arm'::ltree,           'Arm',            5,  TRUE),
    ('shoulder'::ltree,      'Shoulder',       6,  TRUE),
    ('neck'::ltree,          'Neck',           7,  TRUE),
    ('head'::ltree,          'Head',           8,  TRUE),
    ('upper_back'::ltree,    'Upper Back',     9,  TRUE),
    ('rib'::ltree,           'Rib',            10, TRUE),
    ('lower_back'::ltree,    'Lower Back',     11, TRUE),
    ('hip'::ltree,           'Hip',            12, TRUE),
    ('thigh'::ltree,         'Thigh',          13, TRUE),
    ('knee'::ltree,          'Knee',           14, TRUE),
    ('calf'::ltree,          'Calf',           15, TRUE),
    ('ankle'::ltree,         'Ankle',          16, TRUE),
    ('foot'::ltree,          'Foot',           17, TRUE),
    ('miscellaneous'::ltree, 'Miscellaneous',  18, TRUE)
ON CONFLICT (path) DO UPDATE
    SET name       = EXCLUDED.name,
        sort_order = EXCLUDED.sort_order,
        is_active  = TRUE;

-- Items. Head, Upper Back, Hip, Thigh and Foot are deliberately
-- empty: the sheet lists those categories with no products yet.
INSERT INTO store_items (category_path, name, is_active) VALUES
    -- Finger: the sheet lists 12 entries, 4 of them repeats (see NOTES)
    ('finger'::ltree,        'Mallot Splint',             TRUE),
    ('finger'::ltree,        'Long Finger Splint',        TRUE),
    ('finger'::ltree,        'Spoon Splint',              TRUE),
    ('finger'::ltree,        'Short Finger Splint',       TRUE),
    ('finger'::ltree,        'Toad Finger Splint',        TRUE),
    ('finger'::ltree,        'Baseboll Splint',           TRUE),
    ('finger'::ltree,        'Finger Splint',             TRUE),
    ('finger'::ltree,        'Finger Net Sleeve',         TRUE),

    ('thumb'::ltree,         'Thumb Spica Splint',        TRUE),

    ('wrist'::ltree,         'Wrist and Forearm Splint',  TRUE),

    ('elbow'::ltree,         'Tennis Elbow Guard',        TRUE),
    ('elbow'::ltree,         'Arm Sling Poiuch',          TRUE),

    ('arm'::ltree,           'Arm Sling Strap',           TRUE),

    ('shoulder'::ltree,      'Shoulder Immoblizer',       TRUE),
    ('shoulder'::ltree,      'Cervical Strap',            TRUE),

    ('neck'::ltree,          'Soft Cervical Collar',      TRUE),

    ('rib'::ltree,           'Rib Belt',                  TRUE),
    ('rib'::ltree,           'Rib Belt (Female)',         TRUE),
    ('rib'::ltree,           'Rib Belt (Male)',           TRUE),

    ('lower_back'::ltree,    'L.S Belt (Sacral)',         TRUE),

    ('knee'::ltree,          'Open Patella Knee Support', TRUE),
    ('knee'::ltree,          'Long Knee Brace',           TRUE),

    ('calf'::ltree,          'Shin and Calf Support',     TRUE),

    ('ankle'::ltree,         'LP Anklet',                 TRUE),
    ('ankle'::ltree,         'Cast Boot',                 TRUE),
    ('ankle'::ltree,         'Ankle Brace',               TRUE),

    ('miscellaneous'::ltree, 'Ice Pack',                  TRUE),
    ('miscellaneous'::ltree, 'Theraband',                 TRUE),
    ('miscellaneous'::ltree, 'Air Cushion',               TRUE);


-- ============================================================
-- 3. Result
-- ============================================================
-- Expect 18 rows and 29 items, plus one 'Archived (old stock)'
-- line if anything had to be kept for its history.
SELECT c.sort_order AS s_no,
       c.name       AS category,
       COUNT(i.id)  AS items,
       STRING_AGG(i.name, ', ' ORDER BY i.id) AS item_list
  FROM store_categories c
  LEFT JOIN store_items i ON i.category_path = c.path
 GROUP BY c.sort_order, c.name
 ORDER BY c.sort_order;

COMMIT;


-- ============================================================
-- NOTES ON THE SOURCE SHEET
-- ============================================================
-- Repeats collapsed - the sheet lists the same product twice:
--   Finger : "Mallot Splint" / "mallot Splint"   -> one item
--   Finger : "Long finger splint" x3             -> one item
--   Finger : "Short Finger Splint" x2            -> one item
--   Rib    : "Rib Belt (Male)" x2                -> one item
--   Knee   : "Long Knee Brace" x2                -> one item
--
-- Split on the assumption they are separate products:
--   Miscellaneous: "Ice Pack Theraband Air Cushion"
--     -> Ice Pack / Theraband / Air Cushion
--
-- Spellings kept EXACTLY as the sheet has them, though these look
-- like typos. To correct them, run:
--   UPDATE store_items SET name='Mallet Splint'        WHERE name='Mallot Splint';
--   UPDATE store_items SET name='Baseball Splint'      WHERE name='Baseboll Splint';
--   UPDATE store_items SET name='Arm Sling Pouch'      WHERE name='Arm Sling Poiuch';
--   UPDATE store_items SET name='Shoulder Immobilizer' WHERE name='Shoulder Immoblizer';
--
-- To clear the archive later, once its purchase/issue history is no
-- longer needed:
--   DELETE FROM store_outward WHERE item_id IN (SELECT id FROM store_items WHERE category_path='archive');
--   DELETE FROM store_inward  WHERE item_id IN (SELECT id FROM store_items WHERE category_path='archive');
--   DELETE FROM store_items   WHERE category_path='archive';
--   DELETE FROM store_categories WHERE path='archive';
