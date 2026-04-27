// Worker fixture for the concurrent-boot migration race test.
//
// Why a `.mjs` file (not `.ts`):
//   * The test author needs the worker to dynamically `import()` the
//     production `migration-runner.ts` source so the test exercises the
//     actual code path (not a copy of the pattern). That requires a
//     module-resolver hook to rewrite `.js` → `.ts` extensions, which
//     `node:module#register()` installs only in `.mjs`/`.js` ESM hosts
//     (the registration MUST execute before any source-import happens).
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
//   * DEFERRED path (`workerData.useDeferred === true`): runs an inline
//     replica of the migration that uses the DEFAULT transaction wrapper
//     (`tx()`, which `better-sqlite3` dispatches as `BEGIN` → DEFERRED
//     in SQLite). Negative control: proves the workers are genuinely
//     contending and that `.immediate()` is the load-bearing seam.
//
// The inline DEFERRED replica copies only the migration runner's logic
// shape (≈10 lines: `hasMigrationApplied` + `db.transaction(fn)()`), and
// uses a DROP-IN faithful copy of the SQL constant from
// `../migrations/0001-initial.ts`. The IMMEDIATE path uses the actual
// production code, so the load-bearing assertion is on the production
// path; the DEFERRED replica only needs to faithfully reproduce the
// failure mode.

import { register } from "node:module";
import { parentPort, workerData } from "node:worker_threads";

import Database from "better-sqlite3";

// Install the .js → .ts module-resolver hook BEFORE importing any
// project source. Without this, `import("../migration-runner.ts")`
// would succeed but its transitive `import { INITIAL_MIGRATION_SQL }
// from "../migrations/0001-initial.js"` would fail to resolve under
// vanilla Node.
register("./migration-race-loader.mjs", import.meta.url);

// Faithful DDL copy of `INITIAL_MIGRATION_SQL` (table set + index +
// schema_version anchor). The replica uses these to reproduce the
// CREATE-TABLE write-lock contention. Declared at module-top so the
// referencing function `applyMigrationsDeferredReplica` is invoked
// AFTER this `const` is initialized — a function-bottom declaration
// would TDZ-fault when the function is called from the top-level `try`.
const DEFERRED_REPLICA_SQL = `
CREATE TABLE session_events (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  sequence               INTEGER NOT NULL,
  occurred_at            TEXT NOT NULL,
  monotonic_ns           INTEGER NOT NULL,
  category               TEXT NOT NULL,
  type                   TEXT NOT NULL,
  actor                  TEXT,
  payload                TEXT NOT NULL DEFAULT '{}',
  pii_payload            BLOB,
  correlation_id         TEXT,
  causation_id           TEXT,
  version                TEXT NOT NULL DEFAULT '1.0',
  prev_hash              BLOB NOT NULL,
  row_hash               BLOB NOT NULL,
  daemon_signature       BLOB NOT NULL,
  participant_signature  BLOB,
  UNIQUE(session_id, sequence),
  CHECK(length(prev_hash) = 32),
  CHECK(length(row_hash) = 32),
  CHECK(length(daemon_signature) = 64),
  CHECK(participant_signature IS NULL OR length(participant_signature) = 64)
);

CREATE TABLE schema_version (
  version         INTEGER NOT NULL PRIMARY KEY,
  applied_at      TEXT NOT NULL,
  description     TEXT
);

INSERT INTO schema_version (version, applied_at, description)
VALUES (1, datetime('now'), 'Initial schema');
`;

// --------------------------------------------------------------------------
// DEFERRED-replica internals (negative-control path only).
// Faithful copy of the runner pattern with `tx()` substituted for
// `tx.immediate()`. Function declarations are hoisted, so these can sit
// below the top-level `try` block — only the `const` above must be
// in lexical scope before the call site.
// --------------------------------------------------------------------------

function applyPragmasDeferredReplica(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

function hasMigrationAppliedReplica(db, version) {
  const tableExists = db
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get();
  if (tableExists.count === 0) {
    return false;
  }
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM schema_version WHERE version = ?")
    .get(version);
  return row.count > 0;
}

function applyMigrationsDeferredReplica(db) {
  if (!hasMigrationAppliedReplica(db, 1)) {
    const tx = db.transaction(() => {
      if (!hasMigrationAppliedReplica(db, 1)) {
        db.exec(DEFERRED_REPLICA_SQL);
      }
    });
    tx(); // DEFAULT wrapper → BEGIN (DEFERRED) — the R2 broken pattern.
  }
}

// --------------------------------------------------------------------------
// Top-level worker entrypoint
// --------------------------------------------------------------------------

const dbPath = workerData.dbPath;
const useDeferred = workerData.useDeferred === true;

let db = null;
try {
  db = new Database(dbPath);
  if (useDeferred) {
    // Negative-control replica — DELIBERATELY uses BEGIN DEFERRED via
    // the default `tx()` wrapper to prove contention exists.
    applyPragmasDeferredReplica(db);
    applyMigrationsDeferredReplica(db);
  } else {
    // Production path — dynamically imports the real `applyMigrations`
    // and `applyPragmas` from `../migration-runner.ts`. The
    // `register()` call above makes the `.js`-extension transitive
    // imports resolve correctly.
    const mod = await import("../migration-runner.js");
    mod.applyPragmas(db);
    mod.applyMigrations(db);
  }
  parentPort.postMessage({ ok: true });
} catch (err) {
  parentPort.postMessage({
    ok: false,
    code: err && typeof err === "object" && "code" in err ? String(err.code) : null,
    message: err instanceof Error ? err.message : String(err),
  });
} finally {
  if (db !== null && db.open) {
    db.close();
  }
}
