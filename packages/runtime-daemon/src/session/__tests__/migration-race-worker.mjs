// @ts-check
// Worker fixture for the concurrent-boot migration race test.
//
// Why a `.mjs` file (not `.ts`):
//   * The worker must `import()` the production `migration-runner.ts`
//     dynamically so the test exercises the actual code path. That
//     requires a module-resolver hook to rewrite `.js` → `.ts`
//     extensions, which `node:module#register()` installs only in
//     `.mjs`/`.js` ESM hosts and MUST execute before any source-import
//     happens.
//   * Plain `.ts` workers via Node's native TS-stripping cannot install
//     loader hooks before their own static imports run.
//
// What this worker exercises:
//   * IMMEDIATE path (`workerData.useDeferred === false`): dynamically
//     imports `applyMigrations` from the real `migration-runner.ts`, so
//     the test asserts the production code's `db.transaction(...)
//     .immediate()` pattern serializes correctly under contention. A
//     regression that drops `.immediate()` in production code surfaces
//     here.
//   * DEFERRED path (`workerData.useDeferred === true`): runs a replica
//     of the migration that uses the DEFAULT transaction wrapper
//     (`tx()`, which `better-sqlite3` dispatches as `BEGIN` → DEFERRED
//     in SQLite). Negative control: proves the workers are genuinely
//     contending and that `.immediate()` is the load-bearing seam. The
//     replica imports the SAME `INITIAL_MIGRATION_SQL` constant the
//     production runner consumes, so the only legitimate variation
//     between paths is the transaction wrapper — schema drift in the
//     production DDL cannot silently desynchronize the replica.
//
// Snapshot barrier (DEFERRED path only)
// --------------------------------------------------------------------------
// When `workerData.snapshotBarrier` is supplied, the DEFERRED replica parks
// inside its open transaction — after the read that pins its WAL snapshot,
// before the write that upgrades it — until every sibling has done the same.
// That makes the writer-vs-writer collision STRUCTURAL rather than a matter of
// scheduling luck: no worker can commit while the others are parked, so no
// worker can arrive late enough to observe an already-migrated database and
// skip the transaction entirely. On release, one racer wins the write lock and
// the rest hold snapshots that are now stale, which is SQLITE_BUSY_SNAPSHOT by
// construction — the contention the negative control asserts.
//
// The IMMEDIATE path deliberately gets NO barrier, and that asymmetry is the
// point of the pair of tests rather than an omission: `BEGIN IMMEDIATE` takes
// the writer-intent lock at BEGIN, so racers serialize BEFORE reaching any
// in-transaction rendezvous and a barrier there would simply deadlock until its
// deadline.
//
// Blocking with `Atomics.wait` inside the transaction is intentional and safe
// here: this is a worker thread (where `Atomics.wait` is permitted), and
// better-sqlite3 is fully synchronous, so holding the open transaction across
// the wait is exactly what pins the stale snapshot. Parked workers hold READ
// transactions, which in WAL mode block neither each other nor a late sibling's
// reads. The wait carries a hard deadline and proceeds regardless once it
// expires, so a worker that dies before arriving degrades the test to its
// previous probabilistic behavior instead of hanging the suite.

import { register } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

// Install the .js → .ts module-resolver hook BEFORE any subsequent
// `import()` attempts to resolve project source. Without this,
// `import("../migration-runner.js")` would succeed but its transitive
// `import { INITIAL_MIGRATION_SQL } from "../migrations/0001-initial.js"`
// would fail to resolve under vanilla Node.
register("./migration-race-loader.mjs", import.meta.url);

/**
 * @typedef {object} WorkerInput
 * @property {string} dbPath
 * @property {boolean} useDeferred
 * @property {SharedArrayBuffer} [snapshotBarrier] Arrival counter shared with
 *   every sibling worker in the same trial. DEFERRED path only.
 * @property {number} [barrierWorkerCount] How many arrivals release the
 *   barrier — the trial's worker count. Required alongside `snapshotBarrier`.
 */

/**
 * @typedef {object} SnapshotBarrier
 * @property {Int32Array} arrivals Single-element view over the shared counter.
 * @property {number} workerCount Arrivals required to release.
 */

/**
 * @typedef {object} WorkerResult
 * @property {boolean} ok
 * @property {string | null} [code]
 * @property {string} [message]
 */

/**
 * @typedef {{ count: number | bigint }} CountRow
 */

// --------------------------------------------------------------------------
// DEFERRED-replica internals (negative-control path only).
// Mirrors the runner pattern with `tx()` substituted for `tx.immediate()`,
// but consumes the SAME `INITIAL_MIGRATION_SQL` the production runner uses.
// The dynamic import sits inside the function so the loader hook above is
// already registered when resolution runs.
// --------------------------------------------------------------------------

/** @param {import("better-sqlite3").Database} db */
function applyPragmasDeferredReplica(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} version
 * @returns {boolean}
 */
function hasMigrationAppliedReplica(db, version) {
  const tableExists = /** @type {CountRow | undefined} */ (
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_version'",
      )
      .get()
  );
  if (tableExists === undefined || Number(tableExists.count) === 0) {
    return false;
  }
  const row = /** @type {CountRow | undefined} */ (
    db.prepare("SELECT COUNT(*) AS count FROM schema_version WHERE version = ?").get(version)
  );
  if (row === undefined) {
    return false;
  }
  return Number(row.count) > 0;
}

/**
 * Upper bound on the rendezvous. Reached only when a sibling never arrives (it
 * crashed, or was still spawning on a saturated machine); a healthy trial
 * releases as soon as the last worker parks, in milliseconds. On expiry the
 * worker proceeds anyway, so the worst case is the probabilistic contention
 * this barrier replaced — never a hung suite. Five trials × this bound stays
 * far inside the caller's 60 s per-test timeout.
 */
const SNAPSHOT_BARRIER_TIMEOUT_MS = 3000;

/**
 * Blocks until every sibling has pinned its snapshot, or the deadline expires.
 *
 * @param {SnapshotBarrier} barrier
 */
function awaitSnapshotBarrier(barrier) {
  Atomics.add(barrier.arrivals, 0, 1);
  // Wake siblings already parked on this index — the arrival that completes the
  // set is what releases everyone.
  Atomics.notify(barrier.arrivals, 0);
  const deadline = Date.now() + SNAPSHOT_BARRIER_TIMEOUT_MS;
  for (;;) {
    const arrived = Atomics.load(barrier.arrivals, 0);
    if (arrived >= barrier.workerCount) {
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return;
    }
    // Re-checked each pass: `Atomics.wait` returns `"not-equal"` immediately if
    // the counter moved between the load above and the wait, so a missed
    // notification cannot park a worker past the deadline.
    Atomics.wait(barrier.arrivals, 0, arrived, remaining);
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {SnapshotBarrier | null} barrier
 */
async function applyMigrationsDeferredReplica(db, barrier) {
  // The worker file lives at `src/session/__tests__/`, so the migration
  // module sits two directories up (`src/migrations/0001-initial.ts`).
  // The loader hook rewrites `.js` → `.ts` for the actual on-disk file.
  const { INITIAL_MIGRATION_SQL } = await import("../../migrations/0001-initial.js");
  if (!hasMigrationAppliedReplica(db, 1)) {
    const tx = db.transaction(() => {
      if (!hasMigrationAppliedReplica(db, 1)) {
        // The re-check above is the first read of the transaction, so the WAL
        // snapshot is pinned by the time we park here. Waiting between that
        // read and the write below is what makes every sibling's snapshot
        // stale at the same instant.
        if (barrier !== null) {
          awaitSnapshotBarrier(barrier);
        }
        db.exec(INITIAL_MIGRATION_SQL);
      }
    });
    tx(); // DEFAULT wrapper → BEGIN (DEFERRED) — the broken pattern.
  }
}

// --------------------------------------------------------------------------
// Top-level worker entrypoint
// --------------------------------------------------------------------------

if (parentPort === null) {
  throw new Error("migration-race-worker.mjs must be run as a Worker child");
}

const input = /** @type {WorkerInput} */ (workerData);
if (typeof input !== "object" || input === null) {
  throw new Error("migration-race-worker.mjs: workerData must be a WorkerInput object");
}
if (typeof input.dbPath !== "string" || input.dbPath.length === 0) {
  throw new Error("migration-race-worker.mjs: workerData.dbPath must be a non-empty string");
}
if (typeof input.useDeferred !== "boolean") {
  throw new Error("migration-race-worker.mjs: workerData.useDeferred must be a boolean");
}

/** @type {SnapshotBarrier | null} */
let snapshotBarrier = null;
if (input.snapshotBarrier !== undefined) {
  if (!(input.snapshotBarrier instanceof SharedArrayBuffer)) {
    throw new Error(
      "migration-race-worker.mjs: workerData.snapshotBarrier must be a SharedArrayBuffer",
    );
  }
  if (
    typeof input.barrierWorkerCount !== "number" ||
    !Number.isInteger(input.barrierWorkerCount) ||
    input.barrierWorkerCount < 1
  ) {
    throw new Error(
      "migration-race-worker.mjs: workerData.barrierWorkerCount must be a positive integer whenever snapshotBarrier is supplied",
    );
  }
  // Refused rather than ignored: an IMMEDIATE racer serializes at BEGIN and
  // would never reach an in-transaction rendezvous, so accepting the barrier
  // here would silently disable it instead of failing the fixture misuse.
  if (!input.useDeferred) {
    throw new Error(
      "migration-race-worker.mjs: workerData.snapshotBarrier is valid only on the DEFERRED replica path",
    );
  }
  snapshotBarrier = {
    arrivals: new Int32Array(input.snapshotBarrier),
    workerCount: input.barrierWorkerCount,
  };
}

/** @type {import("better-sqlite3").Database | null} */
let db = null;
try {
  db = new Database(input.dbPath);
  if (input.useDeferred) {
    // Negative-control replica — DELIBERATELY uses BEGIN DEFERRED via
    // the default `tx()` wrapper to prove contention exists.
    applyPragmasDeferredReplica(db);
    await applyMigrationsDeferredReplica(db, snapshotBarrier);
  } else {
    // Production path — dynamically imports the real `applyMigrations`
    // and `applyPragmas` from `../migration-runner.ts`. The
    // `register()` call above makes the `.js`-extension transitive
    // imports resolve correctly.
    const mod = await import("../migration-runner.js");
    mod.applyPragmas(db);
    mod.applyMigrations(db);
  }
  parentPort.postMessage(/** @type {WorkerResult} */ ({ ok: true }));
} catch (err) {
  parentPort.postMessage(
    /** @type {WorkerResult} */ ({
      ok: false,
      code:
        err !== null && typeof err === "object" && "code" in err
          ? String(/** @type {{ code: unknown }} */ (err).code)
          : null,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
} finally {
  if (db !== null && db.open) {
    db.close();
  }
}
