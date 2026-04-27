// Schema migration runner for Local Runtime Daemon SQLite databases.
//
// Plan-001 owns migration version 1 — see `migrations/0001-initial.ts`. The
// runner is intentionally minimal: check `schema_version`, exec the SQL if
// absent. Subsequent plans (003, 006, 015, 022...) will register additional
// migrations by appending to the migration list below and bumping
// `schema_version`.
//
// SQL is sourced as a TypeScript string constant (not a sibling .sql file)
// because `tsc -b` does not copy non-TS assets into `dist/` and `package.json`
// `"files": ["dist"]` would exclude `src/migrations/` from publish; see the
// header of `migrations/0001-initial.ts` for the full rationale.
//
// This module also owns:
//   * the canonical pragma list applied at every handle open per
//     `docs/architecture/schemas/local-sqlite-schema.md` §Pragmas
//     (`applyPragmas`),
//   * the canonical handle factory (`openDatabase`) — opens the file,
//     applies pragmas, runs migrations in the right order. Use this in
//     production code paths AND in tests so the order can never drift.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { INITIAL_MIGRATION_SQL } from "../migrations/0001-initial.js";

/**
 * Apply pragmas to an open Database handle. MUST be called on every
 * handle open (including reopens) — pragmas are connection-local.
 *
 * Per `docs/architecture/schemas/local-sqlite-schema.md` §Pragmas:
 *   - WAL journal mode: concurrent readers during writes.
 *   - synchronous=FULL: overrides better-sqlite3 default (NORMAL) for
 *     chain-of-custody durability per Spec-006 §Integrity Protocol.
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
 * Apply all pending migrations to an open Database handle.
 *
 * Idempotent: each migration is checked against `schema_version` before
 * exec, so calling this on an already-migrated database is a no-op.
 *
 * Concurrency: each migration is wrapped in `db.transaction(...)`
 * invoked via `.immediate()`, which begins the transaction with `BEGIN
 * IMMEDIATE` (taking the RESERVED writer-intent lock at BEGIN time
 * rather than at first write). Two daemons racing on the same file
 * resolve via SQLite's busy-handler at BEGIN: the loser blocks until
 * `busy_timeout=5000` ms elapses (set in `applyPragmas`); when the loser
 * acquires the lock the inner `hasMigrationApplied` re-check sees the
 * winner's committed `schema_version` row and short-circuits, so the
 * transaction commits as a no-op. Either way: exactly one
 * `INITIAL_MIGRATION_SQL.exec()` ever lands.
 *
 * Why NOT the default (`db.transaction(...)()`): better-sqlite3's
 * default transaction wrapper begins with `BEGIN`, which SQLite
 * dispatches as DEFERRED. Both racers start as readers; the inner
 * `hasMigrationApplied()` SELECT succeeds without a lock upgrade; the
 * subsequent `db.exec(SQL)` requires a write lock; in WAL mode, two
 * DEFERRED transactions both attempting to upgrade hit
 * `SQLITE_BUSY_SNAPSHOT`, which `busy_timeout` cannot resolve (the
 * busy-handler only retries while no transaction is held). The
 * `concurrent applyMigrations across worker_threads` test in
 * `__tests__/session-service.test.ts` reproduces the contention with
 * the default wrapper as a negative control and pins the fix on
 * `.immediate()`.
 */
export function applyMigrations(db: DatabaseType): void {
  if (!hasMigrationApplied(db, 1)) {
    // The migration SQL itself contains the INSERT into schema_version
    // (the version=1 anchor row), so a single .exec() call is the unit
    // of work. Wrapping in db.transaction(...).immediate() ensures the
    // schema_version row commits atomically with the table CREATEs — a
    // torn write (e.g. process crash mid-migration) leaves the database
    // fully unmigrated, never half-migrated — AND that the BEGIN takes
    // the RESERVED writer-intent lock immediately so concurrent racers
    // serialize at BEGIN rather than colliding at write-upgrade time.
    db.transaction(() => {
      // Re-check inside the transaction to close the
      // `hasMigrationApplied → exec` window: when a concurrent writer
      // wins the BEGIN-IMMEDIATE race and commits before we acquire the
      // lock, the inner check returns true and we skip the exec rather
      // than re-applying the CREATE TABLEs.
      if (!hasMigrationApplied(db, 1)) {
        db.exec(INITIAL_MIGRATION_SQL);
      }
    }).immediate();
  }
}

/**
 * Open a SQLite handle, apply pragmas, and run all pending migrations.
 *
 * This is the canonical entry point for daemon code AND tests. Using it
 * everywhere prevents the pragma-vs-migration-vs-statement-prepare ordering
 * from being silently re-derived (and silently drifting) at each call site.
 *
 * Idempotent on reopen: pragmas are reapplied (they are connection-local
 * per SQLite semantics), and the migration check sees `schema_version`
 * already populated and short-circuits.
 */
export function openDatabase(dbPath: string): DatabaseType {
  const db: DatabaseType = new Database(dbPath);
  applyPragmas(db);
  applyMigrations(db);
  return db;
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------
//
// `hasMigrationApplied` tolerates the brand-new-database case where the
// `schema_version` table doesn't yet exist. We probe `sqlite_master`
// (always present) instead of catching exceptions so the happy path
// stays exception-free.

function hasMigrationApplied(db: DatabaseType, version: number): boolean {
  const tableExists: { count: number } = db
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_version'",
    )
    .get() as { count: number };
  if (tableExists.count === 0) {
    return false;
  }
  const row: { count: number } = db
    .prepare("SELECT COUNT(*) AS count FROM schema_version WHERE version = ?")
    .get(version) as { count: number };
  return row.count > 0;
}
