// A tiny in-process TTL cache.
//
// Exists for one reason: every Drive-backed endpoint re-listed the clinic's
// whole base folder from Google on every request — up to 10 sequential HTTPS
// round-trips, 1.5–4s, before a single row could render. Uploads paid it too,
// because resolving a patient's folder lists the base first.
//
// In-process rather than Redis on purpose. The app runs a SINGLE Node process
// (ecosystem.config.cjs → instances: 1, exec_mode: 'fork') and authenticates
// with stateless JWTs, so there is no second process to share state with. A
// Map costs nothing; Redis would add a daemon, a network hop and a new
// failure mode to a box that already restarts Node at 400MB.
//
// If `instances` ever goes above 1 this is the file to replace — callers only
// touch get()/bust(), never the storage.

const store = new Map();

// Hard ceiling so a long-lived process can never accumulate keys without
// bound. Far above the number of distinct folders a clinic has; the sweep
// normally keeps the map an order of magnitude under this.
const MAX_ENTRIES = 2000;

/**
 * Drop expired entries, then oldest-first if still over the ceiling.
 *
 * `headroom` reserves space for entries about to be inserted. get() sweeps
 * BEFORE it stores, so without this the map settles one over the ceiling.
 */
function sweep(headroom = 0) {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expires <= now) store.delete(k);
  }
  const limit = MAX_ENTRIES - headroom;
  if (store.size <= limit) return;
  // Map iterates in insertion order, so the head is the oldest.
  let excess = store.size - limit;
  for (const k of store.keys()) {
    if (excess-- <= 0) break;
    store.delete(k);
  }
}

/**
 * Return the cached value for `key`, or run `fetch()` and cache it.
 *
 * Stores the PROMISE, not the resolved value. That gives single-flight for
 * free: if three requests miss the same cold key at once, they all await one
 * Google call instead of firing three. With 1.5–4s calls that de-duplication
 * matters as much as the caching does.
 *
 * Rejections are evicted rather than cached — a transient Drive hiccup must
 * not pin an error in place for the remainder of the TTL.
 */
function get(key, ttlMs, fetch) {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  sweep(1);   // reserve room for the entry we are about to add

  const value = Promise.resolve()
    .then(fetch)
    .catch((e) => {
      store.delete(key);
      throw e;
    });

  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

/**
 * Drop every key beginning with `prefix` (everything, if omitted).
 *
 * Called whenever THIS app changes something in Drive. Waiting for the TTL
 * would mean an admin presses Create, the folder really is created, and the
 * list still doesn't show it for a minute — which reads as a broken button.
 * The TTL is only there to pick up changes made outside the app.
 */
function bust(prefix) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const k of store.keys()) {
    if (k.startsWith(prefix)) store.delete(k);
  }
}

function stats() {
  const now = Date.now();
  let live = 0;
  for (const v of store.values()) if (v.expires > now) live++;
  return { entries: store.size, live, max: MAX_ENTRIES };
}

/**
 * Read a live entry WITHOUT fetching on miss. Returns undefined when absent
 * or expired. Exists for callers that only want to CONSULT accumulated
 * knowledge (per-patient Drive match verdicts) and must never trigger a
 * Google round-trip from inside a tight classification loop.
 */
function peek(key) {
  const hit = store.get(key);
  if (!hit || hit.expires <= Date.now()) return undefined;
  return hit.value;
}

/** Store a known value directly - the write half of peek(). */
function put(key, ttlMs, value) {
  sweep(1);
  store.set(key, { value, expires: Date.now() + ttlMs });
}

module.exports = { get, bust, sweep, stats, peek, put };
