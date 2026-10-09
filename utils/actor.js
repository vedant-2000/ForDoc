// Who is making the current request, available anywhere below the route.
//
// authRequired() opens this context for every logged-in request; db/pool.js
// reads it to stamp the user onto the database transaction, so the recycle-bin
// trigger (db/migrations/012_recycle_bin.sql) can record WHO deleted a row
// without every route having to pass the user down by hand - including rows
// removed by a CASCADE the route never mentions.

const { AsyncLocalStorage } = require('async_hooks');

const store = new AsyncLocalStorage();

/// Run [fn] with [actor] ({ id, name, role, source }) as the current user.
function run(actor, fn) {
  return store.run(actor, fn);
}

/// The current request's user, or null outside a request (scripts, jobs).
function current() {
  return store.getStore() || null;
}

module.exports = { run, current };
