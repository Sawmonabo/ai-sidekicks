// Schema migration runner for Local Runtime Daemon SQLite databases.
//
// Plan-001 owns migration version 1 (`0001-initial.sql`). The runner is
// intentionally minimal: check `schema_version`, exec the SQL if absent.
// Subsequent plans (003, 006, 015, 022...) will register additional
// migrations by extending the `MIGRATIONS` table below.
//
// This module also owns the canonical pragma list applied at every handle
// open per local-sqlite-schema.md §Pragmas. Pragmas must be applied
// per-connection (they are connection-local in SQLite), not in the
// migration SQL — exec'ing pragmas at migration time would only affect
// the connection that ran the migration, not subsequent reopens.

import { readFileSync } from "node:fs";

import type { Database } from "better-sqlite3";

// `import.meta.url` resolves against the source tree at test time and
// against the built tree at runtime. The `.sql` file lives next to this
// module's source-tree home so both modes resolve the same relative path.
// (At runtime — once a build pipeline copies migrations into dist/ — see
// the Plan-001 PR #3 scope note in 0001-initial.sql header.)
const MIGRATION_0001_PATH: URL = new URL("../migrations/0001-initial.sql", import.meta.url);

/**
 * Apply pragmas to an open Database handle. MUST be called on every
 * handle open (including reopens) — pragmas are connection-local.
 *
 * Per local-sqlite-schema.md §Pragmas:
 *   - WAL journal mode: concurrent readers during writes.
 *   - synchronous=FULL: overrides better-sqlite3 default (NORMAL) for
 *     chain-of-custody durability per Spec-006 §Integrity Protocol.
 *   - foreign_keys=ON: enforce FK constraints at INSERT/UPDATE time.
 *   - busy_timeout=5000: tolerate concurrent writers up to 5 s before
 *     SQLITE_BUSY surfaces to the application.
 */
export function applyPragmas(db: Database): void {
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
 */
export function applyMigrations(db: Database): void {
  if (!hasMigrationApplied(db, 1)) {
    const sql: string = readFileSync(MIGRATION_0001_PATH, "utf-8");
    // The migration SQL itself contains the INSERT into schema_version
    // (the version=1 anchor row), so a single .exec() call is the unit
    // of work. better-sqlite3's .exec() runs each statement in the
    // script sequentially; a syntax error or constraint violation
    // throws and leaves the database in whatever partial state it had
    // reached. For Plan-001's single-migration boot path this is
    // acceptable — fresh databases either complete the migration or
    // surface the failure on the next attempt with a clean reapply.
    // (Multi-migration runners in later plans should wrap each
    // migration in db.transaction(...).)
    db.exec(sql);
  }
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------
//
// `hasMigrationApplied` tolerates the brand-new-database case where the
// `schema_version` table doesn't yet exist. We probe `sqlite_master`
// (always present) instead of catching exceptions so the happy path
// stays exception-free.

function hasMigrationApplied(db: Database, version: number): boolean {
  const tableExists: { count: number } = db
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_version'")
    .get() as { count: number };
  if (tableExists.count === 0) {
    return false;
  }
  const row: { count: number } = db
    .prepare("SELECT COUNT(*) AS count FROM schema_version WHERE version = ?")
    .get(version) as { count: number };
  return row.count > 0;
}
