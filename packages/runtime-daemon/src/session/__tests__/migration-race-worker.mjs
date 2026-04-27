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

/** @param {import("better-sqlite3").Database} db */
async function applyMigrationsDeferredReplica(db) {
  // The worker file lives at `src/session/__tests__/`, so the migration
  // module sits two directories up (`src/migrations/0001-initial.ts`).
  // The loader hook rewrites `.js` → `.ts` for the actual on-disk file.
  const { INITIAL_MIGRATION_SQL } = await import("../../migrations/0001-initial.js");
  if (!hasMigrationAppliedReplica(db, 1)) {
    const tx = db.transaction(() => {
      if (!hasMigrationAppliedReplica(db, 1)) {
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

/** @type {import("better-sqlite3").Database | null} */
let db = null;
try {
  db = new Database(input.dbPath);
  if (input.useDeferred) {
    // Negative-control replica — DELIBERATELY uses BEGIN DEFERRED via
    // the default `tx()` wrapper to prove contention exists.
    applyPragmasDeferredReplica(db);
    await applyMigrationsDeferredReplica(db);
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
