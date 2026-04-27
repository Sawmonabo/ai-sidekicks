// Schema migration runner for the Collaboration Control Plane Postgres
// database.
//
// Plan-001 PR #4 owns migration version 1 — see `migrations/0001-initial.ts`.
// The runner is intentionally minimal: probe `information_schema.tables` for
// `schema_migrations`; if absent, run the migration SQL inside a single
// transaction. Subsequent plans (002, 003, 006, 015, 022...) will register
// additional migrations by appending to the migration list below and bumping
// the version counter.
//
// SQL is sourced as a TypeScript string constant (not a sibling .sql file)
// because `tsc -b` does not copy non-TS assets into `dist/` and `package.json`
// `"files": ["dist"]` would exclude `src/migrations/` from publish; see the
// header of `migrations/0001-initial.ts` for the full rationale.
//
// ----------------------------------------------------------------------------
// Concurrency model differs from runtime-daemon's SQLite migration runner
// ----------------------------------------------------------------------------
//
// `packages/runtime-daemon/src/session/migration-runner.ts` defends against
// concurrent-boot writer-vs-writer SQLITE_BUSY contention via
// `BEGIN IMMEDIATE` and a `worker_threads`-driven race test. Postgres has a
// fundamentally different concurrency model:
//
//   * DDL statements (CREATE TABLE/INDEX) take row-level catalog locks
//     automatically; concurrent racers serialize on those locks at the
//     statement boundary, not at the BEGIN boundary.
//   * The two-phase pattern below (probe -> exec) is therefore not the
//     load-bearing seam that `BEGIN IMMEDIATE` is on SQLite — even if two
//     racers both pass the probe, the second's `CREATE TABLE participants`
//     will fail with `42P07` (relation already exists), surfacing the loss
//     loudly rather than silently corrupting state.
//   * Cross-process production migrations run via the release pipeline
//     (Plan-023 owns release automation), not via concurrent daemon boot;
//     there is no analogue to the SQLite "two daemons race on the same
//     local file at startup" bug class for shared Postgres.
//
// Consequence: this runner does NOT attempt the inside-transaction re-check
// pattern that `runtime-daemon/src/session/migration-runner.ts` uses. The
// outer probe is the idempotency barrier; the transactional batch protects
// against torn writes mid-migration only.

import { INITIAL_MIGRATION_SQL } from "../migrations/0001-initial.js";

/**
 * Minimal SQL surface this module needs from a database client.
 *
 * Two methods, two Postgres wire protocols:
 *
 *   * `query()` issues a single statement over the **extended query
 *     protocol** (Parse + Bind + Execute on a prepared statement). This is
 *     the only path that supports `$1`-style positional parameters and the
 *     only path that returns rows. It is also hard-limited to ONE statement
 *     per call — both `pg`'s parameterized `query()` and PGlite's `query()`
 *     reject multi-statement strings here with `cannot insert multiple
 *     commands into a prepared statement`.
 *
 *   * `exec()` issues a multi-statement batch over the **simple query
 *     protocol** (no Parse step, no parameters, statements separated by
 *     `;`). This is what migration SQL fundamentally needs — a single
 *     `BEGIN; CREATE TABLE ...; INSERT ...; COMMIT;` round trip. Both
 *     `pg.Client#query(sqlString)` (without a params array) and PGlite's
 *     `pg.exec(sql)` map to this protocol. Returns no rows by contract.
 *
 * Typing against this minimal interface (rather than `pg.Pool` or
 * `pg.Client` directly) is what makes the production wiring (Plan-001 PR #5
 * will compose a `Querier` from `pg.Pool`) and the test wiring (an
 * in-process `PGlite` instance) interchangeable without a runtime branch
 * inside the migration runner or the directory service.
 *
 * `params` is `ReadonlyArray<unknown>` to accommodate the heterogeneous shape
 * Postgres parameters take (UUIDs as strings, JSON as objects/strings, etc.)
 * without forcing every call site to `as unknown[]`. The trust boundary for
 * parameter shape lives at the per-method site that constructs the array,
 * not at the Querier boundary.
 */
export interface Querier {
  query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<T> }>;
  exec(sql: string): Promise<void>;
}

/**
 * Apply all pending migrations against a `Querier`.
 *
 * Idempotent: probes `information_schema.tables` for `schema_migrations`
 * before executing the migration SQL. If the row already exists for the
 * target version, the call short-circuits.
 *
 * Atomicity: the migration SQL itself contains the INSERT into
 * `schema_migrations`. Wrapping the entire SQL in an explicit `BEGIN; ...
 * COMMIT;` ensures a torn write (process crash mid-migration) leaves the
 * database fully unmigrated, never half-migrated. On any error inside the
 * batch, an explicit `ROLLBACK` undoes the partial work.
 *
 * Wire-protocol choice: the multi-statement batch goes through `exec()`
 * (simple query protocol). The extended-query path (`query()` with or
 * without parameters) is hard-limited to ONE statement per call — both
 * `pg`'s parameterized `query()` and PGlite's `query()` reject the
 * `BEGIN; ...; COMMIT;` shape with `cannot insert multiple commands into a
 * prepared statement`. The Querier interface exposes both methods so the
 * service surface stays consistent across migration SQL (simple) and
 * runtime CRUD (extended, parameterized).
 *
 * Pool semantics: `pg.Pool#query` (and the `Querier#exec` adapter that
 * wraps it) checks out a connection per call, so a multi-statement
 * `BEGIN ... COMMIT` is guaranteed to land on the same connection.
 */
export async function applyMigrations(querier: Querier): Promise<void> {
  if (await hasMigrationApplied(querier, 1)) {
    return;
  }
  // Wrap in an explicit BEGIN/COMMIT so a torn write leaves the database
  // fully unmigrated. Postgres DDL is transactional, so all CREATE TABLEs
  // + INSERT into schema_migrations land atomically. Routed through
  // `exec()` (simple query protocol) because `query()` is one-statement-
  // per-call by Postgres protocol contract — see the Querier docstring.
  const batched: string = `BEGIN;\n${INITIAL_MIGRATION_SQL}\nCOMMIT;`;
  try {
    await querier.exec(batched);
  } catch (err) {
    // Make a best-effort ROLLBACK so a half-applied transaction does not
    // leak into the next call. If the connection has already aborted (the
    // common case for a CREATE failure) the ROLLBACK is a no-op. Routed
    // through `exec()` for protocol symmetry with the BEGIN/COMMIT batch
    // — both go through the simple query protocol.
    try {
      await querier.exec("ROLLBACK");
    } catch {
      // Suppress rollback-time failures so the original migration error
      // reaches the caller. A rollback failure on an already-broken
      // connection is strictly less informative than the underlying
      // migration throw.
    }
    throw err;
  }
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------
//
// `hasMigrationApplied` tolerates the brand-new-database case where the
// `schema_migrations` table doesn't yet exist. We probe
// `information_schema.tables` (always present in Postgres) instead of
// catching exceptions so the happy path stays exception-free.

async function hasMigrationApplied(querier: Querier, version: number): Promise<boolean> {
  const tableProbe = await querier.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'schema_migrations'
     ) AS exists`,
  );
  const probeRow: { exists: boolean } | undefined = tableProbe.rows[0];
  if (probeRow === undefined || !probeRow.exists) {
    return false;
  }
  const versionProbe = await querier.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM schema_migrations WHERE version = $1",
    [version],
  );
  const versionRow: { count: string } | undefined = versionProbe.rows[0];
  if (versionRow === undefined) {
    return false;
  }
  // COUNT(*) returns BIGINT in Postgres, which `pg` hydrates as a string
  // by default to avoid Number.MAX_SAFE_INTEGER overflow. We cast to text
  // in SQL and parse here so the type is unambiguous regardless of driver
  // numeric-handling configuration.
  return Number.parseInt(versionRow.count, 10) > 0;
}
