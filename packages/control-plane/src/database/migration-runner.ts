// Applies the control plane's one Postgres schema.
//
// Two control-plane boots can race on a fresh database: both would pass an unguarded probe and the
// second `CREATE TABLE` would fail with `42P07 relation already exists`. So the apply runs in one
// transaction under a `pg_advisory_xact_lock` and re-probes inside the lock; a racer blocks on the
// lock, then finds the committed schema and returns.

import { CONTROL_PLANE_SCHEMA_SQL } from "./control-plane-schema.js";

// The advisory-lock key. It must differ from every other advisory-lock caller in
// the same database, and every control-plane replica must use the same value.
const SCHEMA_LOCK_ID = 9_000_000_001n;

/**
 * The SQL surface the control plane needs, so production (`pg.Pool`) and tests
 * (PGlite) share one code path.
 *
 * `query` runs one parameterized statement and returns rows; `exec` runs a
 * multi-statement batch over the simple query protocol and returns none;
 * `transaction` runs `fn` on one connection between BEGIN and COMMIT, rolling
 * back on a throw. Nested transactions throw.
 */
export interface Querier {
  query<T>(sql: string, params?: ReadonlyArray<unknown>): Promise<{ rows: ReadonlyArray<T> }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Querier) => Promise<T>): Promise<T>;
}

/**
 * Create the schema on a database that has none; a no-op on one that has it.
 *
 * The outer probe is the fast path for an existing database. On a miss, one
 * transaction takes the advisory lock, re-probes, and runs the schema through
 * `exec()`, because the extended-query path takes one statement per call. The
 * lock is released at COMMIT or ROLLBACK, so a crash mid-apply leaves no schema
 * and no held lock.
 */
export async function applyMigrations(querier: Querier): Promise<void> {
  if (await hasSchema(querier)) {
    return;
  }
  await querier.transaction(async (tx) => {
    // Both PGlite and `pg` bind a BigInt to the lock's bigint parameter.
    await tx.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_ID]);
    if (await hasSchema(tx)) {
      return;
    }
    await tx.exec(CONTROL_PLANE_SCHEMA_SQL);
  });
}

// Probes `information_schema` rather than catching an exception, so the common
// path (an existing database) stays exception-free. The schema commits in one
// transaction, so one table's presence stands for all of them.
async function hasSchema(querier: Querier): Promise<boolean> {
  const probe = await querier.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'users'
     ) AS exists`,
  );
  return probe.rows[0]?.exists === true;
}
