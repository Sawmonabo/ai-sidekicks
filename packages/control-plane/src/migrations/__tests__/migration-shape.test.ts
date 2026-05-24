// Plan-002 Phase 2 T2.5 — P10 migration-SHAPE regression.
//
// Plan-002 §Test Plan P10 names a "migration SHAPE regression": Plan-002's v2
// migration must add EXACTLY the durable surface it claims (`session_invites`)
// and introduce NO presence-state table — I-002-3 (presence is in-memory only;
// Spec-002 §State And Data Implications line 157, Plan-002 §Invariants I-002-3).
//
// ----------------------------------------------------------------------------
// Division of labor with `0002-session-invites.test.ts` T6 — NOT duplication
// ----------------------------------------------------------------------------
//
// `0002-session-invites.test.ts` T6 is the PER-MIGRATION NARROW probe: it
// asserts that after v1 + v2 no `public` table matches `ILIKE '%presence%'` —
// a targeted defense that THIS migration did not introduce presence storage.
//
// THIS file is the BROADER SCHEMA-WIDE regression. Its load-bearing assertion
// is an exhaustive DELTA-SET EQUALITY: snapshot the full `public` table set
// before v2 (S1, after v1) and after v2 (S2), then assert
//
//     S2 \ S1 === { 'session_invites' }
//
// i.e. v2 adds the `session_invites` table and NOTHING ELSE — no presence
// table, no other surprise table. This is strictly stronger than T6's
// `%presence%` probe: T6 only catches a table whose NAME contains "presence",
// whereas the delta catches ANY unexpected table v2 might add (a stray staging
// table, a mis-scoped Plan-006 audit table, a presence table under a
// non-obvious name). It is also robust against future v3+ migrations because
// it diffs ONLY the v1->v2 step (snapshots taken immediately before and after
// the v2 apply), not the absolute table set.
//
// The `%presence%` ILIKE probe is RETAINED here too (on S2) as a one-line
// defensive backstop that names the I-002-3 concern explicitly — but the delta
// equality is the assertion that fails first on a real regression.
//
// ----------------------------------------------------------------------------
// Why direct-exec stepwise (v1 then v2), not `applyMigrations`
// ----------------------------------------------------------------------------
//
// The delta needs S1 (post-v1, pre-v2) and S2 (post-v2) as DISTINCT snapshots.
// `applyMigrations()` iterates `MIGRATIONS = [v1, v2]` and applies BOTH in one
// call (Plan-002 Amendment 2, PR #102), which would collapse the two snapshots
// into one. So — mirroring the stepwise pattern `0002-session-invites.test.ts`
// already uses — `beforeEach` direct-execs `INITIAL_MIGRATION_SQL` (v1 only)
// and each test direct-execs `SESSION_INVITES_MIGRATION_SQL` (v2) between the
// two snapshots. Each exec is wrapped in a transaction so the migration body
// and its `schema_migrations` INSERT commit atomically (the same atomicity
// boundary the canonical `applyMigrations` uses, inlined here).
//
// Refs: Plan-002 §Test Plan P10, Plan-002 §Invariants I-002-3, Spec-002
// §State And Data Implications line 157, `0002-session-invites.test.ts` T6
// (the complementary per-migration `%presence%` probe).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INITIAL_MIGRATION_SQL } from "../0001-initial.js";
import { SESSION_INVITES_MIGRATION_SQL } from "../0002-session-invites.js";
import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy)
// ----------------------------------------------------------------------------
//
// Mirrors the adapter in `0002-session-invites.test.ts` /
// `sessions/__tests__/session-directory-service.test.ts`. Inlined here (rather
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
  // `tx.exec(INITIAL_MIGRATION_SQL)` so the FIRST snapshot below (S1) is the
  // post-v1, pre-v2 table set. Using `applyMigrations(querier)` here would
  // pre-apply v2 (Amendment 2, PR #102) and collapse the delta. The
  // transaction wrapper mirrors the canonical `applyMigrations` atomicity
  // boundary.
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

// Apply v2 SQL directly inside a transaction so the migration body and the
// `schema_migrations` INSERT commit atomically — mirrors
// `0002-session-invites.test.ts`'s `applySessionInvitesMigration` helper.
async function applySessionInvitesMigration(querier: Querier): Promise<void> {
  await querier.transaction(async (tx) => {
    await tx.exec(SESSION_INVITES_MIGRATION_SQL);
  });
}

// ----------------------------------------------------------------------------
// P10 — migration SHAPE regression (I-002-3 ephemeral presence + v2 adds
// EXACTLY session_invites)
// ----------------------------------------------------------------------------

describe("migrations shape regression (P10 — v2 adds EXACTLY session_invites; I-002-3 no presence table)", () => {
  it("S2 \\ S1 === { session_invites } — v2 adds the invites table and NOTHING else", async () => {
    // S1: the full public table set AFTER v1 (bootstrapped by beforeEach),
    // BEFORE v2. Computed from information_schema (not hardcoded) so a future
    // v1 alteration that added a stray table is caught by the same delta.
    const s1: Set<string> = await snapshotPublicTables(ctx.querier);

    // Apply v2.
    await applySessionInvitesMigration(ctx.querier);

    // S2: the full public table set AFTER v2.
    const s2: Set<string> = await snapshotPublicTables(ctx.querier);

    // DELTA: every table present in S2 but absent from S1 — exactly what v2
    // introduced. Load-bearing assertion: the delta is the singleton
    // { session_invites }. A v2 that created a presence table (or any other
    // surprise table) would surface here as an extra delta member; a v2 that
    // failed to create session_invites would surface as an empty/wrong delta.
    const delta: string[] = [...s2].filter((tableName) => !s1.has(tableName)).sort();
    expect(delta).toEqual(["session_invites"]);

    // Sanity anchor: v2 is purely additive — it removes no v1 table (S1 is a
    // subset of S2). A regression that dropped a Plan-001 table inside the v2
    // batch would surface here even though it does not change the delta.
    const removed: string[] = [...s1].filter((tableName) => !s2.has(tableName));
    expect(removed).toEqual([]);
  });

  it("defensive backstop: no public table matches '%presence%' after v2 (I-002-3)", async () => {
    // Complements `0002-session-invites.test.ts` T6 (the per-migration probe).
    // Retained here as a named one-line guard for the I-002-3 concern: presence
    // state is in-memory only and is never written to a durable table. ILIKE
    // (not LIKE) so a case regression (`SESSION_PRESENCE`) cannot slip past.
    // The delta-equality test above is the assertion that fails FIRST on a real
    // regression; this is the explicit presence-named backstop.
    await applySessionInvitesMigration(ctx.querier);
    const probe = await ctx.querier.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name ILIKE '%presence%'`,
    );
    expect(probe.rows).toEqual([]);
  });

  it("the canonical applyMigrations runner reaches the SAME shape as the stepwise apply (no extra tables)", async () => {
    // Cross-path consistency: the stepwise direct-exec path (above) and the
    // canonical `applyMigrations` runner-loop MUST converge on the same public
    // table set. `beforeEach` already applied v1; calling `applyMigrations`
    // here applies the remaining v2 through the production runner. The
    // resulting table set must equal v1's set plus exactly `session_invites`.
    // This pins that the runner does not introduce a table the stepwise SQL
    // omits (or vice versa) — a divergence the narrow %presence% probe alone
    // could not detect.
    const s1: Set<string> = await snapshotPublicTables(ctx.querier);
    await applyMigrations(ctx.querier);
    const s2: Set<string> = await snapshotPublicTables(ctx.querier);

    const delta: string[] = [...s2].filter((tableName) => !s1.has(tableName)).sort();
    expect(delta).toEqual(["session_invites"]);
  });
});
