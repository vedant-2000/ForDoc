// Background jobs for work that outlives an HTTP request.
//
// WHY
// Some admin screens have to read the whole Drive: every folder in the base,
// then what is inside each affected one. On a clinic Drive that is thousands
// of folders and many sequential Google round trips — comfortably more than
// the 60 seconds server.js allows a request (REQUEST_TIMEOUT_MS). Run inside
// the request, the screen gets "the server took too long" while the server
// carries on doing the work for nobody.
//
// So the request starts the job and returns at once with an id. The screen
// polls that id for progress and picks up the result when it lands. Nothing
// hangs on a socket a timeout, a proxy or a sleeping laptop can close.
//
// IN-PROCESS, like utils/cache.js, and for the same reason: this app runs as
// ONE Node process (ecosystem.config.cjs: instances 1, fork mode). A poll can
// only ever reach the process that holds the job. If `instances` ever goes
// above 1, this is the file to back with Postgres or Redis — callers only
// touch start()/get()/latest(), never the storage.
//
// SINGLE-FLIGHT
// Starting a job under a key that already has one running returns the
// running one. Two admins opening the same screen, or one admin pressing
// Re-scan twice, share a single walk of the Drive instead of doubling the
// load on Google and on this box.
//
// RESULTS ARE KEPT
// The last successful result per key is remembered, so a screen can show it
// the moment it opens — clearly stamped with when it was taken — while a
// fresh run happens behind it. That is what keeps these screens usable on a
// slow day rather than blank.

const crypto = require('crypto');

const jobs = new Map();      // id  -> job
const running = new Map();   // key -> id of the job currently running
const latestOk = new Map();  // key -> last successful job

/// Finished jobs are kept this long so a screen that polls a little late
/// still finds its answer.
const KEEP_FINISHED_MS = 30 * 60 * 1000;

function publicView(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,          // 'running' | 'done' | 'failed'
    phase: job.phase,            // human-readable step
    done: job.done,
    total: job.total,
    started_at: job.startedAt,
    finished_at: job.finishedAt,
    error: job.error,
  };
}

/**
 * Start `run` in the background under `key`, or join the one already running.
 *
 * `run(progress)` receives a function to report progress:
 *   progress({ phase: 'Listing folders', done: 3, total: 40 })
 * and resolves to the job's result.
 */
function start(kind, key, ownerId, run) {
  const existingId = running.get(key);
  if (existingId) {
    const existing = jobs.get(existingId);
    if (existing && existing.status === 'running') return existing;
  }

  const job = {
    id: crypto.randomBytes(9).toString('hex'),
    kind,
    key,
    ownerId,
    status: 'running',
    phase: 'Starting',
    done: 0,
    total: 0,
    result: null,
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  };
  // Resolves when the job finishes, either way. waitFor() races this against
  // a timer rather than polling, so a deadline means exactly what it says.
  job.settled = new Promise((resolve) => { job.resolveSettled = resolve; });
  jobs.set(job.id, job);
  running.set(key, job.id);

  const progress = (patch) => {
    if (!patch || job.status !== 'running') return;
    if (patch.phase != null) job.phase = String(patch.phase);
    if (patch.done != null) job.done = Number(patch.done) || 0;
    if (patch.total != null) job.total = Number(patch.total) || 0;
  };

  // setImmediate, not a direct call: whoever started this gets their reply
  // written before any of the work begins. A direct call would run the job up
  // to its first await INSIDE the request that asked for it.
  setImmediate(() => {
    Promise.resolve()
      .then(() => run(progress))
      .then((result) => {
        job.status = 'done';
        job.result = result;
        job.phase = 'Done';
        latestOk.set(key, job);
        console.log(`[jobs] ${kind} ${job.id} done in `
          + `${((Date.now() - job.startedAt) / 1000).toFixed(1)}s`);
      })
      .catch((e) => {
        job.status = 'failed';
        job.error = (e && e.message) ? e.message : String(e);
        console.warn(`[jobs] ${kind} ${job.id} failed: ${job.error}`);
      })
      .finally(() => {
        job.finishedAt = Date.now();
        if (running.get(key) === job.id) running.delete(key);
        job.resolveSettled(job);
      });
  });

  return job;
}

function get(id) {
  return jobs.get(id) || null;
}

/// The last SUCCESSFUL job for `key`, or null.
function latest(key) {
  return latestOk.get(key) || null;
}

/// The job running for `key` right now, or null.
function runningFor(key) {
  const id = running.get(key);
  const job = id ? jobs.get(id) : null;
  return job && job.status === 'running' ? job : null;
}

/**
 * Resolve with the job once it finishes, or with null after `ms`.
 *
 * For callers that would like to answer in one round trip when the work is
 * quick, and fall back to "still running, poll this id" when it is not. The
 * job itself is unaffected either way.
 */
function waitFor(job, ms) {
  if (job.status !== 'running') return Promise.resolve(job);
  // Raced, not polled. An earlier version checked on a 250ms tick, so a
  // deadline shorter than the tick could not fire and it returned whatever
  // the job had become instead of giving up on time.
  return Promise.race([
    job.settled,
    new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), ms);
      if (t.unref) t.unref();
    }),
  ]);
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'running') continue;
    if (now - (job.finishedAt || now) < KEEP_FINISHED_MS) continue;
    // Never drop the job a key's "latest" points at — that is the result a
    // screen shows on open.
    if (latestOk.get(job.key) === job) continue;
    jobs.delete(id);
  }
}
// unref: this must never be the thing keeping a quiet process alive.
setInterval(sweep, 5 * 60 * 1000).unref();

module.exports = { start, get, latest, runningFor, waitFor, publicView };
