// The screens a doctor can be granted, and the keys the server checks.
//
// One entry per tab in the app, so an admin ticking "Rooms" opens the Rooms
// tab and the room routes and nothing else. Keeping the list here rather than
// scattered through the routers means the app and the server cannot drift
// into disagreeing about what exists.
//
// Keys are stored in doctors.screens and travel in the JWT. Renaming one
// silently revokes it for everyone who had it, so don't — add a new key and
// migrate instead.

const SCREENS = [
  { key: 'reports',         label: 'Reports' },
  { key: 'doctors',         label: 'Doctors' },
  { key: 'images',          label: 'Body Image' },
  { key: 'rooms',           label: 'Rooms' },
  { key: 'treatments',      label: 'Treatments' },
  { key: 'palette',         label: 'Palette' },
  { key: 'order',           label: 'Order' },
  { key: 'sitting',         label: 'Sitting' },
  { key: 'effectiveness',   label: 'Effectiveness' },
  { key: 'drive',           label: 'Drive' },
  { key: 'patient_folders', label: 'Patient folders' },
  { key: 'drive_reconcile', label: 'Patients vs Drive' },
  { key: 'split_folders',   label: 'Split folders' },
  { key: 'store',           label: 'Store' },
];

const SCREEN_KEYS = SCREENS.map((s) => s.key);
const KEY_SET = new Set(SCREEN_KEYS);

/// Keep only keys this build knows about, de-duplicated.
///
/// Anything unrecognised is dropped rather than stored: a typo reaching the
/// column would be a permission nobody can ever revoke from the UI, because
/// no checkbox corresponds to it.
function sanitizeScreens(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const v of input) {
    const k = String(v || '').trim();
    if (KEY_SET.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

module.exports = { SCREENS, SCREEN_KEYS, sanitizeScreens };
