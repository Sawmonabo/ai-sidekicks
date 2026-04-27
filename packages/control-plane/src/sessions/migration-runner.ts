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
// fundamentally different concurrency model — DDL is catalog-locked at the
// statement boundary, not at `BEGIN`, so SQLite's `BEGIN IMMEDIATE` shape
// has no direct Postgres analogue. The threat model also differs: shared
// Postgres can be hit by concurrent boots (rolling deploys, multi-replica
// daemons sharing the control-plane database) racing the migration check
// from a fresh database. Two racers that both pass an unguarded outer
// probe both proceed into the transaction; one runner's `CREATE TABLE
// participants` then fails with `42P07 relation already exists`, crashing
// startup. That is bad UX for an "idempotent" entry point.
//
// Defense: the canonical Postgres "lock-and-re-probe" pattern around an
// `pg_advisory_xact_lock`. The outer probe stays as a fast path for the
// (overwhelmingly common) already-migrated case; on a cache miss the
// transaction acquires a stable advisory lock, re-probes inside the lock,
// and only then runs the migration SQL. Concurrent racers BLOCK on the
// lock acquisition, then re-probe to a populated `schema_migrations` and
// short-circuit. See `applyMigrations` for the full trace; the lock id
// is `MIGRATION_LOCK_ID` at the bottom of this file.
//
// Cross-process production migrations are still expected to run via the
// release pipeline (Plan-023 owns release automation), but concurrent
// daemon-boot calls into `applyMigrations` are no longer required to
// avoid the race externally — the runner now closes it at the source.

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
 * Idempotent + concurrency-safe via the canonical Postgres "lock-and-
 * re-probe" pattern:
 *
 *   1. Outer probe — fast path. `hasMigrationApplied` queries
 *      `information_schema.tables` for `schema_migrations`; if the version
 *      row already exists the call short-circuits without taking the
 *      lock. This is the overwhelmingly common case at runtime (booted
 *      daemon hitting an already-migrated database).
 *   2. Transaction + advisory lock — slow path. On a probe miss we open
 *      the transaction, acquire `pg_advisory_xact_lock(MIGRATION_LOCK_ID)`,
 *      and re-probe inside the lock. Concurrent racers that both passed
 *      the outer probe BLOCK on the lock acquisition; the first runner
 *      executes the migration SQL and commits, releasing the lock. The
 *      blocked racer then re-probes to a populated `schema_migrations`
 *      row and short-circuits without re-running the DDL.
 *   3. Migration body — only the runner that wins the lock AND fails the
 *      re-probe runs `INITIAL_MIGRATION_SQL`. The migration SQL itself
 *      contains the INSERT into `schema_migrations` as its tail, so the
 *      version anchor row is committed atomically with the table CREATEs.
 *
 * Without the inside-transaction lock + re-probe, two concurrent calls on
 * a fresh database would both observe "not applied" at the outer probe,
 * both open transactions, and both run `CREATE TABLE participants` — the
 * second `CREATE` would crash with `42P07 relation already exists`,
 * surfacing the concurrent boot as a startup failure rather than the
 * idempotent no-op the API contract promises.
 *
 * Atomicity: the lock + re-probe + migration SQL share one transaction
 * boundary. A torn write (process crash mid-migration) leaves the
 * database fully unmigrated, never half-migrated, AND releases the
 * advisory lock at ROLLBACK so the next runner can retry cleanly.
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
 * transaction AND releasing the advisory lock between statements).
 * `Querier.transaction(fn)` collapses both substrates onto the same
 * atomicity primitive — PGlite's `pg.transaction(fn)` and the `pg.Pool`
 * adapter's `pool.connect()` + `BEGIN`/`COMMIT`/release pattern both
 * implement the contract. Error surfacing is preserved: PGlite returns
 * the FIRST error from a multi-statement `exec()` batch (verified
 * empirically — a `CREATE TABLE x` failure surfaces as `42P07 relation
 * already exists`, not as `25P02 current transaction is aborted`).
 */
export async function applyMigrations(querier: Querier): Promise<void> {
  // Outer probe — fast path. Avoids taking a lock on the (overwhelmingly
  // common) already-migrated case; see method docstring §1.
  if (await hasMigrationApplied(querier, 1)) {
    return;
  }
  await querier.transaction(async (tx) => {
    // Acquire a transactional advisory lock so only ONE migration runner
    // enters the body at a time. Released automatically at COMMIT or
    // ROLLBACK. Concurrent racers that both passed the outer probe BLOCK
    // on this call until the first runner commits, then re-probe and
    // short-circuit. See method docstring §2 for the full failure mode
    // this defends against.
    //
    // BigInt parameter is accepted by both PGlite (verified empirically
    // 2026-04-27 against @electric-sql/pglite 0.4.4) and `pg` (driver's
    // documented bigint binding). If a future substrate rejects BigInt
    // for the bigint-typed parameter, fall back to the string form
    // (`"9000000001"`) — Postgres accepts the textual representation
    // and parses it as bigint server-side.
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);

    // Re-probe inside the lock. A racer that BLOCKED on the lock above
    // reaches this re-probe AFTER the original runner committed; the
    // re-probe sees the just-committed `schema_migrations` row and
    // short-circuits without re-running the DDL.
    if (await hasMigrationApplied(tx, 1)) {
      return;
    }

    // The migration SQL includes the INSERT into schema_migrations as its
    // last statement, so the version anchor row is committed atomically
    // with the table CREATEs. Routed through `exec()` (simple query
    // protocol) because the extended-query path is one-statement-per-call
    // by Postgres protocol contract — see the Querier docstring.
    await tx.exec(INITIAL_MIGRATION_SQL);
  });
}

// Stable advisory-lock ID for ai-sidekicks control-plane migrations.
// `pg_advisory_xact_lock` takes a bigint; the value must be unique
// relative to ALL OTHER advisory-lock callers in the same Postgres
// database. We own the database today (Plan-001), so collision is
// impossible — but a future plan that adds an additional advisory-lock
// caller (e.g. for cross-replica coordination of a recurring job) MUST
// pick a distinct constant. `9_000_000_001` was chosen as a memorable
// value well outside the typical application id-space (most apps key on
// values < 2^32 or on hashed strings); changing this constant requires
// a coordinated rollout because two daemons disagreeing on the lock id
// would silently permit the race the lock is meant to prevent.
const MIGRATION_LOCK_ID = 9_000_000_001n;

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
