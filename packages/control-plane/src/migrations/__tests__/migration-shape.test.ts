// Migration-SHAPE regression.
//
// A migration must add EXACTLY the durable surface it claims and nothing else.
// The load-bearing assertion is an exhaustive DELTA-SET EQUALITY: snapshot the
// full `public` table set after the initial migration (S1), run the canonical
// `applyMigrations` runner, snapshot again (S2), and assert
//
//     S2 \ S1 === { every table the later registered migrations create }
//
// That is strictly stronger than a per-table existence probe: it catches ANY
// unexpected table a migration might add (a stray staging table, a mis-scoped
// audit table, a table under a non-obvious name) as well as any claimed table
// a migration failed to create.
//
// It is also a CROSS-PATH check, which is the reason this file exists beside
// the per-migration suites: the runner's output MUST equal the union of the
// stepwise migration SQLs. A migration file that ships on disk without its
// entry in the runner's `MIGRATIONS` array, or an entry pointing at the wrong
// constant, produces a delta mismatch here and nowhere else.
//
// The `beforeEach` bootstraps ONLY the initial migration via direct
// `tx.exec(...)` so S1 is the post-v1 table set; using `applyMigrations` there
// would collapse the delta to empty. The transaction wrapper mirrors the
// canonical `applyMigrations` atomicity boundary.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INITIAL_MIGRATION_SQL } from "../0001-initial.js";
import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy)
// ----------------------------------------------------------------------------
//
// Mirrors the adapter in `sessions/__tests__/session-directory-service.test.ts`.
// Inlined here (rather
// than extracted to a shared fixture) because the dispatch contract forbids
// exporting a new test fixture from `packages/control-plane/`, and the helper
// is small; revisit the extraction trade-off if the call-site count grows.

function adaptPGlite(pg: PGlite): Querier {
  return wrap(pg);
}

function wrap(handle: PGlite | Transaction): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      const result = await handle.query<T>(sql, mutableParams);
      return { rows: result.rows };
    },
    exec: async (sql: string): Promise<void> => {
      await handle.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      if (!isPGlite(handle)) {
        throw new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        );
      }
      return handle.transaction(async (tx) => fn(wrap(tx)));
    },
  };
}

function isPGlite(handle: PGlite | Transaction): handle is PGlite {
  return typeof (handle as { transaction?: unknown }).transaction === "function";
}

// Snapshot the full set of `public`-schema table names. Excludes
// `information_schema` / `pg_catalog` noise via the `table_schema = 'public'`
// predicate (the same predicate `hasMigrationApplied` and T6 use). Returns a
// `Set` so the caller can compute set differences directly.
async function snapshotPublicTables(querier: Querier): Promise<Set<string>> {
  const probe = await querier.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'`,
  );
  return new Set(probe.rows.map((row) => row.table_name));
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
}

let ctx: TestContext;

beforeEach(async () => {
  // Fresh in-memory PGlite per test. Bootstraps ONLY v1 via direct
  // `tx.exec(INITIAL_MIGRATION_SQL)` so the snapshot below (S1) is the post-v1
  // table set. Using `applyMigrations(querier)` here would pre-apply every
  // later version and collapse the delta to empty. The transaction wrapper
  // mirrors the canonical `applyMigrations` atomicity boundary.
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await querier.transaction(async (tx) => {
    await tx.exec(INITIAL_MIGRATION_SQL);
  });
  ctx = { pg, querier };
});

afterEach(async () => {
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// The runner's output equals the union of the registered migration SQLs
// ----------------------------------------------------------------------------

describe("migrations shape regression", () => {
  it("applyMigrations materializes exactly the tables the registered migrations create, and drops none", async () => {
    const s1: Set<string> = await snapshotPublicTables(ctx.querier);
    await applyMigrations(ctx.querier);
    const s2: Set<string> = await snapshotPublicTables(ctx.querier);

    const delta: string[] = [...s2].filter((tableName) => !s1.has(tableName)).sort();
    expect(delta).toEqual([
      "event_log_anchors",
      "runtime_node_attachments",
      "runtime_node_presence",
    ]);

    // Every later migration is purely additive — none drops a table the
    // initial migration created. A regression that dropped one inside a later
    // batch would surface here even though it does not change the delta.
    const removed: string[] = [...s1].filter((tableName) => !s2.has(tableName));
    expect(removed).toEqual([]);
  });
});
