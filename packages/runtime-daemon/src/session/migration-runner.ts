// Opens the daemon's SQLite database, applies the connection pragmas and creates the schema.
// `openDatabase` is the one factory production code and tests share.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { DAEMON_SCHEMA_SQL } from "./daemon-schema.js";

/**
 * Applies the connection pragmas; call it on every handle open, because pragmas are
 * connection-local.
 *
 * - WAL journal mode: readers run during writes.
 * - synchronous=FULL: overrides better-sqlite3's NORMAL default so a committed event survives
 *   power loss.
 * - foreign_keys=ON: enforces foreign keys at INSERT and UPDATE.
 * - busy_timeout=5000: a concurrent writer waits up to 5 s before SQLITE_BUSY surfaces.
 * - secure_delete=ON: a deleted row's page is overwritten with zeros, so a purged session's
 *   content does not linger in free pages.
 */
export function applyPragmas(db: DatabaseType): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("secure_delete = ON");
}

/**
 * Creates the schema on a database that has none; does nothing on one that has it.
 *
 * The check and the create run in a `BEGIN IMMEDIATE` transaction, which takes the writer lock
 * up front. Two daemons racing on one file serialize there: the loser waits out `busy_timeout`,
 * re-checks inside the transaction, sees the winner's schema and commits nothing. A DEFERRED
 * transaction would let both read, then both try to write, and WAL answers
 * `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` cannot resolve. The worker-thread race test in
 * `__tests__/service.test.ts` pins this. The whole schema commits at once, so
 * `session_events` exists exactly when every table does.
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
 * Opens a SQLite handle, applies the pragmas and creates the schema if it is absent. Safe to
 * call again on an existing file.
 *
 * If a pragma or the schema step throws, the half-initialized handle is closed and the original
 * error is rethrown; if the close fails too, both are thrown in one `AggregateError`. Without the
 * close the handle would stay open, holding its OS locks and WAL file descriptor until garbage
 * collection and making a retry flaky.
 */
export function openDatabase(dbPath: string): DatabaseType {
  const db: DatabaseType = new Database(dbPath);
  try {
    applyPragmas(db);
    applyMigrations(db);
  } catch (err) {
    try {
      db.close();
    } catch (closeFailure) {
      throw new AggregateError(
        [err, closeFailure],
        "opening the database failed, and closing the half-open handle failed too",
        { cause: closeFailure },
      );
    }
    throw err;
  }
  return db;
}

// Probes `sqlite_master` so the common case, an existing database, throws nothing.
function hasSchema(db: DatabaseType): boolean {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='session_events'",
    )
    .get() as { count: number };
  return row.count > 0;
}
