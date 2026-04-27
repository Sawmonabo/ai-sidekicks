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
//   * The two-phase pattern below (probe -> transaction(exec)) is therefore
//     not the load-bearing seam that `BEGIN IMMEDIATE` is on SQLite — even
//     if two racers both pass the probe, the second's `CREATE TABLE
//     participants` will fail with `42P07` (relation already exists),
//     surfacing the loss loudly rather than silently corrupting state.
//   * Cross-process production migrations run via the release pipeline
//     (Plan-023 owns release automation), not via concurrent daemon boot;
//     there is no analogue to the SQLite "two daemons race on the same
//     local file at startup" bug class for shared Postgres.
//
// Consequence: this runner does NOT attempt the inside-transaction re-check
// pattern that `runtime-daemon/src/session/migration-runner.ts` uses. The
// outer probe is the idempotency barrier; the transaction wrapper protects
// against torn writes mid-migration only.

import { INITIAL_MIGRATION_SQL } from "../migrations/0001-initial.js";

/**
 * Minimal SQL surface this module needs from a database client.
 *
 * Three methods, three Postgres wire-protocol uses:
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
 *     batch of `CREATE TABLE ...; INSERT ...;` statements in one round
 *     trip. Both `pg.Client#query(sqlString)` (without a params array)
 *     and PGlite's `pg.exec(sql)` map to this protocol. Returns no rows
 *     by contract.
 *
 *   * `transaction(fn)` runs `fn` against a connection-bound `Querier`
 *     wrapped in `BEGIN`/`COMMIT` (auto-`ROLLBACK` on throw). Required
 *     for atomicity across multiple statements when the underlying
 *     driver checks out a different connection per `query()`/`exec()`
 *     call (the `pg.Pool` shape that Plan-001 PR #5 will compose). The
 *     callback receives a `Querier` rather than a narrower transaction
 *     type so that helper code shared between in-transaction and
 *     out-of-transaction paths sees the same surface; nested-transaction
 *     calls inside `fn` will throw at runtime per Postgres semantics, an
 *     acceptable runtime check rather than a type-system constraint.
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
  transaction<T>(fn: (tx: Querier) => Promise<T>): Promise<T>;
}

/**
 * Apply all pending migrations against a `Querier`.
 *
 * Idempotent: probes `information_schema.tables` for `schema_migrations`
 * before executing the migration SQL. If the row already exists for the
 * target version, the call short-circuits.
 *
 * Atomicity: the migration SQL itself contains the INSERT into
 * `schema_migrations`. The whole batch runs inside `Querier.transaction(...)`
 * so a torn write (process crash mid-migration) leaves the database fully
 * unmigrated, never half-migrated. The transaction wrapper auto-`ROLLBACK`s
 * on throw and re-raises the underlying error.
 *
 * Wire-protocol choice: the multi-statement migration body goes through
 * `tx.exec()` (simple query protocol). The extended-query path (`query()`
 * with or without parameters) is hard-limited to ONE statement per call —
 * both `pg`'s parameterized `query()` and PGlite's `query()` reject the
 * multi-statement shape with `cannot insert multiple commands into a
 * prepared statement`. The Querier interface exposes both methods (plus
 * `transaction`) so the service surface stays consistent across migration
 * SQL (simple) and runtime CRUD (extended, parameterized).
 *
 * Why `transaction()` and not three separate `exec("BEGIN")` /
 * `exec(SQL)` / `exec("COMMIT")` calls: the three-call shape works on
 * PGlite (single connection per instance) but BREAKS the future `pg.Pool`
 * wiring (Plan-001 PR #5 composes `Querier` from `pg.Pool`, where each
 * `pool.query()` call checks out a fresh connection — three separate
 * exec calls would land on three different connections, dissolving the
 * transaction). `Querier.transaction(fn)` collapses both substrates onto
 * the same atomicity primitive — PGlite's `pg.transaction(fn)` and the
 * `pg.Pool` adapter's `pool.connect()` + `BEGIN`/`COMMIT`/release pattern
 * both implement the contract. Error surfacing is preserved: PGlite
 * returns the FIRST error from a multi-statement `exec()` batch (verified
 * empirically — a `CREATE TABLE x` failure surfaces as `42P07 relation
 * already exists`, not as `25P02 current transaction is aborted`).
 */
export async function applyMigrations(querier: Querier): Promise<void> {
  if (await hasMigrationApplied(querier, 1)) {
    return;
  }
  await querier.transaction(async (tx) => {
    // The migration SQL includes the INSERT into schema_migrations as its
    // last statement, so the version anchor row is committed atomically
    // with the table CREATEs. Routed through `exec()` (simple query
    // protocol) because the extended-query path is one-statement-per-call
    // by Postgres protocol contract — see the Querier docstring.
    await tx.exec(INITIAL_MIGRATION_SQL);
  });
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
