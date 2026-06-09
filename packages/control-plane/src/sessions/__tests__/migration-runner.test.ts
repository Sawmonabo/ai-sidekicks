// Plan-002 Phase 1 PR #102 — `applyMigrations()` per-version-loop regression.
//
// Phase D code-reviewer surfaced that T1.5 shipped `SESSION_INVITES_MIGRATION_SQL`
// (the v2 migration constant) while `applyMigrations()` was hardcoded to apply
// v1 only — any deployer pulling `develop` would have received an orphan v2
// migration on disk that the runner never executed. Cross-plan Amendment 2
// (`docs/plans/002-invite-membership-and-presence.md` §Cross-Plan Amendments)
// restructured `applyMigrations()` to iterate the `MIGRATIONS` array
// `[{v:1, sql:INITIAL_MIGRATION_SQL}, {v:2, sql:SESSION_INVITES_MIGRATION_SQL}]`
// so a single canonical entry-point applies every committed migration.
//
// This file pins the canonical-path runner properties:
//
//   R1 — `applyMigrations()` against a fresh database applies EVERY registered
//        version (v1, v2, AND Plan-003's v3), leaving exactly three
//        `schema_migrations` rows and every migration's deliverable table
//        materialized: v2's `session_invites` plus v3's
//        `runtime_node_attachments` + `runtime_node_presence`. Catches a
//        regression that either drops a version from the `MIGRATIONS` array or
//        hardcodes the runner back to v1 only.
//   R2 — `applyMigrations()` is idempotent at the canonical-path layer:
//        re-calling on an already-fully-migrated database is a no-op (no throw,
//        no duplicate `schema_migrations` rows, no perturbed anchor data).
//        This is distinct from the SQL-level direct-exec idempotency that
//        T7 in `migrations/__tests__/0002-session-invites.test.ts` exercises
//        — that test pins the SQL itself stays self-idempotent under repeated
//        direct `tx.exec()`; THIS test pins the runner loop's outer-probe
//        short-circuit.
//
// Plan-003 PR #145 cross-plan amendment: registering migration v3 in the runner
// (the runner header already names Plan-003 as the v3 registrant — same
// in-place extension pattern Plan-002 Amendment 2 used for v2) forces this
// Plan-001/002-owned regression file forward. R1/R2 are extended for v3 and the
// two runtime-node tables (`runtime_node_attachments` + `runtime_node_presence`).
//
// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy)
// ----------------------------------------------------------------------------
//
// The `adaptPGlite` helper mirrors the shape used in the sibling
// `session-directory-service.test.ts` and `0002-session-invites.test.ts`
// files. We inline a local copy here rather than extracting a shared
// package-level fixture because (a) the cross-plan amendment scope keeps
// test fixtures local to avoid widening the surface, and (b) the helper is
// small enough that an `internal/` extraction would add more indirection
// than it removes; if the call-site count grows further, revisit the
// extraction trade-off.
//
// Refs: Plan-002 PR #102 Cross-Plan Amendment 2; Plan-001 Phase 4 PR #10
// (original v1-only `applyMigrations()` introduction); Plan-003 PR #145
// extends R1/R2 for migration v3 (runtime_node_attachments + runtime_node_presence).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type Querier } from "../migration-runner.js";

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter
// ----------------------------------------------------------------------------

function adaptPGlite(pg: PGlite): Querier {
  return wrap(pg);
}

function wrap(handle: PGlite | Transaction): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      // PGlite's `query` requires `params` as mutable `any[]`, not
      // `ReadonlyArray<unknown>`. The spread decouples the mutability claim
      // without copying parameter values themselves.
      const mutableParams: unknown[] = params === undefined ? [] : [...params];
      const result = await handle.query<T>(sql, mutableParams);
      return { rows: result.rows };
    },
    exec: async (sql: string): Promise<void> => {
      await handle.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      if (!isPGlite(handle)) {
        // Already inside a `pg.transaction(fn)` callback. PGlite's
        // `Transaction` does not expose `transaction(...)` (no nested
        // transactions). Throwing here matches what production `pg.Pool`
        // adapters will do — Postgres semantics, not a test substrate
        // limitation.
        throw new Error(
          "Querier.transaction(): nested transactions are not supported on this substrate.",
        );
      }
      return handle.transaction(async (tx) => {
        return fn(wrap(tx));
      });
    },
  };
}

function isPGlite(handle: PGlite | Transaction): handle is PGlite {
  return typeof (handle as { transaction?: unknown }).transaction === "function";
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------
//
// Each test gets a fresh in-memory PGlite instance. Unlike the sibling
// `0002-session-invites.test.ts` (which bootstraps v1 directly via
// `tx.exec(INITIAL_MIGRATION_SQL)` so it can test v2 SQL in isolation),
// THIS file's tests exercise `applyMigrations()` itself as the system
// under test. The `beforeEach` here intentionally leaves the database
// EMPTY — every test calls `applyMigrations` explicitly and asserts on
// the post-call state.

interface TestContext {
  pg: PGlite;
  querier: Querier;
}

let ctx: TestContext;

beforeEach(() => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  ctx = { pg, querier };
});

afterEach(async () => {
  // PGlite's `close()` releases the WASM heap. Awaited under vitest's
  // parallel-file isolation so heap state cannot leak across tests.
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// R1 — applyMigrations applies BOTH v1 AND v2 on a fresh database
// ----------------------------------------------------------------------------

describe("applyMigrations — per-version loop applies all registered migrations", () => {
  it("populates schema_migrations with v1 + v2 + v3 rows AND materializes every migration's tables", async () => {
    // Fresh DB pre-condition: no schema_migrations table exists yet (the
    // first migration creates it). Anchored so a regression that pre-seeds
    // the test fixture would surface here.
    const preProbe = await ctx.querier.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'schema_migrations'
       ) AS exists`,
    );
    const preRow = preProbe.rows[0];
    expect(preRow).toBeDefined();
    if (preRow === undefined) return;
    expect(preRow.exists).toBe(false);

    await applyMigrations(ctx.querier);

    // (a) schema_migrations carries ALL THREE version anchor rows. A regression
    // that drops v2 or v3 from the MIGRATIONS array or reverts the runner to a
    // hardcoded v1-only shape would surface here as `toHaveLength(1)` (or 2).
    const versionProbe = await ctx.querier.query<{ version: number; description: string }>(
      "SELECT version, description FROM schema_migrations ORDER BY version ASC",
    );
    expect(versionProbe.rows).toHaveLength(3);
    const v1Row = versionProbe.rows[0];
    const v2Row = versionProbe.rows[1];
    const v3Row = versionProbe.rows[2];
    expect(v1Row).toBeDefined();
    expect(v2Row).toBeDefined();
    expect(v3Row).toBeDefined();
    if (v1Row === undefined || v2Row === undefined || v3Row === undefined) return;
    expect(v1Row.version).toBe(1);
    expect(v2Row.version).toBe(2);
    expect(v3Row.version).toBe(3);
    // Description strings pinned as a secondary anchor — `hasMigrationApplied`
    // keys on `version` alone, so a regression that quietly swapped the
    // description (e.g., a copy-paste error in a future migration) would
    // slip past version-only probes but surface here.
    expect(v1Row.description).toBe("Initial schema");
    expect(v2Row.description).toBe("Session invites table");
    expect(v3Row.description).toBe("Runtime node attachments and presence");

    // (b) every registered migration's deliverable table is materialized
    // through the runner. A regression where a version's INSERT row landed in
    // schema_migrations but its DDL was skipped (impossible under the current
    // per-version-transaction shape but worth pinning) would surface here. v2
    // ships `session_invites`; Plan-003 v3 ships `runtime_node_attachments` +
    // `runtime_node_presence`.
    const inviteTableProbe = await ctx.querier.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'session_invites'
       ) AS exists`,
    );
    const inviteTableRow = inviteTableProbe.rows[0];
    expect(inviteTableRow).toBeDefined();
    if (inviteTableRow === undefined) return;
    expect(inviteTableRow.exists).toBe(true);

    const attachTableProbe = await ctx.querier.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'runtime_node_attachments'
       ) AS exists`,
    );
    const attachTableRow = attachTableProbe.rows[0];
    expect(attachTableRow).toBeDefined();
    if (attachTableRow === undefined) return;
    expect(attachTableRow.exists).toBe(true);

    const presenceTableProbe = await ctx.querier.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'runtime_node_presence'
       ) AS exists`,
    );
    const presenceTableRow = presenceTableProbe.rows[0];
    expect(presenceTableRow).toBeDefined();
    if (presenceTableRow === undefined) return;
    expect(presenceTableRow.exists).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// R2 — applyMigrations is idempotent at the canonical-path layer
// ----------------------------------------------------------------------------

describe("applyMigrations — canonical-path idempotency on re-call", () => {
  it("re-calling applyMigrations on a fully-migrated database is a no-op", async () => {
    // First call bootstraps v1 + v2 + v3 (verified by R1 above; here it's the
    // ARRANGE step, not the SUT).
    await applyMigrations(ctx.querier);

    // Second call MUST NOT throw and MUST NOT mutate schema_migrations.
    // A regression that bypassed the per-version `hasMigrationApplied`
    // outer-probe short-circuit would surface as either a `42P07 relation
    // already exists` (re-running the DDL against an existing table) or
    // a PK violation (duplicate INSERT into schema_migrations).
    await expect(applyMigrations(ctx.querier)).resolves.toBeUndefined();

    // Row counts unchanged: exactly three rows, exactly the three expected
    // versions, no duplicates.
    const probe = await ctx.querier.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    expect(probe.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  });
});
