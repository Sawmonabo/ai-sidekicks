// Opens the daemon's SQLite database and applies its one schema.
//
// Also owns the pragma list every handle open applies, and `openDatabase`, the
// one factory production code and tests both use so the pragma, schema and
// statement-prepare order cannot drift between them.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { DAEMON_SCHEMA_SQL } from "./daemon-schema.js";

/**
 * Apply pragmas to an open Database handle. MUST be called on every
 * handle open (including reopens) — pragmas are connection-local.
 *
 *   - WAL journal mode: concurrent readers during writes.
 *   - synchronous=FULL: overrides better-sqlite3 default (NORMAL) for
 *     chain-of-custody durability.
 *   - foreign_keys=ON: enforce FK constraints at INSERT/UPDATE time.
 *   - busy_timeout=5000: tolerate concurrent writers up to 5 s before
 *     SQLITE_BUSY surfaces to the application.
 */
export function applyPragmas(db: DatabaseType): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

/**
 * Create the schema on a database that has none; a no-op on one that has it.
 *
 * Concurrency: the check and the create run in `db.transaction(...)` invoked
 * via `.immediate()`, which begins with `BEGIN IMMEDIATE` and takes the writer
 * lock at BEGIN. Two daemons racing on one file serialize there: the loser
 * waits out `busy_timeout` (set in `applyPragmas`), then its inner re-check
 * sees the winner's committed schema and commits as a no-op. The default
 * `db.transaction(...)()` begins DEFERRED: both racers read, both try to
 * upgrade to write, and WAL answers `SQLITE_BUSY_SNAPSHOT`, which
 * `busy_timeout` cannot resolve. The worker-thread race test in
 * `__tests__/session-service.test.ts` pins this with the DEFERRED wrapper as
 * its negative control.
 *
 * The whole schema commits in one transaction, so `session_events` exists
 * exactly when every table does.
 */
export function applyMigrations(db: DatabaseType): void {
  if (hasSchema(db)) {
    return;
  }
  db.transaction(() => {
    if (!hasSchema(db)) {
      db.exec(DAEMON_SCHEMA_SQL);
    }
  }).immediate();
}

/**
 * Open a SQLite handle, apply pragmas, and create the schema if it is absent.
 *
 * The one entry point for daemon code and tests, so the pragma, schema and
 * statement-prepare order is never re-derived at a call site.
 *
 * Idempotent on reopen: pragmas are reapplied (they are connection-local
 * per SQLite semantics), and the schema check finds the tables and returns.
 *
 * Failure-mode cleanup: if either `applyPragmas` or `applyMigrations`
 * throws (SQLITE_BUSY after busy_timeout, disk error, schema-corruption
 * detection, etc.), the half-initialized handle is closed before the
 * error propagates. Without this, the underlying `better-sqlite3` handle
 * would never be returned to the caller — nothing else holds a reference
 * to close it — and OS-level locks plus the WAL file descriptor would
 * stay held until V8 garbage-collected the wrapper, making caller-side
 * retries flaky (next `openDatabase` would race the GC). The throw is
 * re-raised verbatim so callers see the same diagnostic they would
 * without the cleanup wrapper. `db.close()` is itself protected: if it
 * throws (e.g. because the underlying handle is already in an
 * unrecoverable state), the close-error is suppressed in favor of the
 * original initialization error — losing init context to a teardown
 * error would obscure the actual failure.
 */
export function openDatabase(dbPath: string): DatabaseType {
  const db: DatabaseType = new Database(dbPath);
  try {
    applyPragmas(db);
    applyMigrations(db);
  } catch (err) {
    try {
      db.close();
    } catch {
      // Swallow close-time failures so the original init error reaches
      // the caller. A close failure on an already-broken handle is
      // strictly less informative than the underlying init throw.
    }
    throw err;
  }
  return db;
}

// Probes `sqlite_master` rather than catching an exception, so the common path
// (an existing database) stays exception-free.
function hasSchema(db: DatabaseType): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='session_events'",
    )
    .get() as { count: number };
  return row.count > 0;
}
