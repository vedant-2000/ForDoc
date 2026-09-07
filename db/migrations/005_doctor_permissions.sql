-- Per-SCREEN access for doctors.
--
-- One row per doctor, holding the list of screens an admin has opened up for
-- them — 'reports', 'rooms', 'store' and so on, matching the tabs in the app.
-- Granting 'rooms' opens the Rooms tab and the room routes, and nothing else.
--
-- This deliberately is NOT a role. There is no "make this doctor an admin"
-- flag: an admin picks the individual screens, and the server checks the
-- screen a route belongs to. A doctor granted every screen ends up able to do
-- what an admin can, but only by the admin ticking each one.
--
-- Empty by default, so nobody gains anything by applying this.
--
-- One exception, and it is about not breaking people: the Store screen was
-- already reachable by every doctor before these permissions existed (the
-- button had no role check and the store API accepted any signed-in user).
-- Every existing doctor is therefore seeded with 'store' so nobody loses
-- access on upgrade. To make Store opt-in as well, run afterwards:
--
--   UPDATE doctors SET screens = array_remove(screens, 'store');
--
-- Safe to run more than once.

ALTER TABLE doctors ADD COLUMN IF NOT EXISTS screens TEXT[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
  -- An earlier draft of this migration shipped two boolean columns instead.
  -- If it was applied, carry the intent across and drop them, so there is
  -- only ever one place that decides what a doctor may open.
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'doctors' AND column_name = 'can_store') THEN
    UPDATE doctors SET screens = array_append(screens, 'store')
     WHERE can_store IS TRUE AND NOT ('store' = ANY(screens));
    ALTER TABLE doctors DROP COLUMN can_store;
  ELSE
    -- Fresh application: preserve the Store access doctors already had.
    UPDATE doctors SET screens = array_append(screens, 'store')
     WHERE NOT ('store' = ANY(screens));
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'doctors' AND column_name = 'can_admin') THEN
    -- can_admin was a blanket elevation; it has no screen-wise equivalent and
    -- is NOT translated into "every screen". Anyone who held it must be
    -- granted the screens they actually need, from Admin -> Doctors.
    ALTER TABLE doctors DROP COLUMN can_admin;
  END IF;
END $$;
