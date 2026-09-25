// The document vocabulary: the categories a document can be filed under.
//
// WHY THIS EXISTS
// The list used to be written out three times - the accepted keys in
// routes/documents.js, the Drive subfolder names in utils/drive.js, and the
// labels inside each app. Three copies that had to agree, and adding one
// category meant editing all three and shipping a new build. It lives in the
// database now (document_categories) and everything reads it from here.
//
// CACHED IN MEMORY, AND SYNCHRONOUS ON PURPOSE
// categoryFolderName() is called while building a Drive path, deep inside
// code that is not async and should not become async to look up a label. So
// the table is read into memory at boot, after an edit, and every so often;
// callers get whatever the last successful read holds.
//
// FALLS BACK TO THE OLD HARD-CODED LIST
// An un-migrated server (no table) keeps working exactly as it did, with the
// same eight categories and the same Drive folder names. That also covers the
// window between deploying the code and running the migration.

const { query } = require('../db/pool');

/// Exactly what used to be hard-coded. Do not reorder: a fresh database is
/// seeded from the migration, which carries the same values.
const DEFAULTS = [
  { key: 'xray',         label: 'X-Ray',            folder: 'X-Ray' },
  { key: 'scan',         label: 'Scan',             folder: 'Scans' },
  { key: 'report',       label: 'Report',           folder: 'Reports' },
  { key: 'prescription', label: 'Prescription',     folder: 'Prescriptions' },
  { key: 'photo',        label: 'Photo',            folder: 'Photos' },
  { key: 'body',         label: 'Body photo',       folder: 'Body Photos' },
  { key: 'treatment',    label: 'Treatment record', folder: 'Treatment Records' },
  { key: 'other',        label: 'Other',            folder: 'Other' },
];

/// Categories the app itself depends on: 'treatment' is where a saved
/// treatment record files itself, 'other' is what anything unrecognised
/// falls back to. They are re-added if an edit drops them, because a list
/// without them would break filing rather than just rename it.
const REQUIRED = ['treatment', 'other'];

const REFRESH_MS = 10 * 60 * 1000;

let cache = DEFAULTS.slice();
let loadedFromDb = false;
let refreshing = null;

/// Re-read the table. Never throws: a failure leaves the previous list in
/// place, which is always better than no vocabulary at all.
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const { rows } = await query(
        `SELECT key, label, folder_name
           FROM document_categories
          WHERE is_active = TRUE
          ORDER BY sort_order, key`);
      const list = rows
        .map((r) => ({
          key: String(r.key || '').trim().toLowerCase(),
          label: String(r.label || '').trim(),
          folder: String(r.folder_name || '').trim(),
        }))
        .filter((c) => c.key && c.label && c.folder);
      if (list.length) {
        // Anything the app needs and the table lacks comes from the defaults.
        for (const k of REQUIRED) {
          if (!list.some((c) => c.key === k)) {
            list.push(DEFAULTS.find((d) => d.key === k));
          }
        }
        cache = list;
        loadedFromDb = true;
      }
    } catch (e) {
      // 42P01 = no such table: an un-migrated database, which is expected
      // and handled by the defaults. Anything else is worth a line.
      if (!e || e.code !== '42P01') {
        console.warn('[docCategories] could not read the list:', e.message);
      }
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/// Read once at boot and occasionally after, so an edit made on another
/// screen reaches this process without a restart.
function start() {
  refresh();
  const t = setInterval(refresh, REFRESH_MS);
  if (t.unref) t.unref();
}

/// The whole list, in order: [{ key, label, folder }].
const all = () => cache.slice();

/// Just the keys - what a document's category is allowed to be.
const keys = () => cache.map((c) => c.key);

/// The Drive subfolder for a category. Unknown keys file under Other, as
/// they always have.
function folderName(category) {
  const k = String(category || 'other').toLowerCase();
  const hit = cache.find((c) => c.key === k);
  if (hit) return hit.folder;
  const fallback = cache.find((c) => c.key === 'other');
  return fallback ? fallback.folder : 'Other';
}

/// The reverse: a Drive subfolder name back to a category key, for guessing
/// the category of a file nobody filed through the app. '' (the patient's own
/// root folder, not a subfolder) reads as 'other'.
function keyFromFolderName(folderNameIn) {
  const n = String(folderNameIn || '').trim().toLowerCase();
  if (!n) return 'other';
  const hit = cache.find((c) => c.folder.toLowerCase() === n);
  return hit ? hit.key : 'other';
}

/// Whether the list on screen came from the database or is the built-in one.
const isFromDb = () => loadedFromDb;

module.exports = {
  DEFAULTS,
  REQUIRED,
  refresh,
  start,
  all,
  keys,
  folderName,
  keyFromFolderName,
  isFromDb,
};
