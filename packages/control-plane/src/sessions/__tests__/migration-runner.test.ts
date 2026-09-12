// `applyMigrations()` per-version-loop regression.
//
// A migration constant that ships on disk without its entry in the runner's
// `MIGRATIONS` array is an orphan: any deployer pulling `develop` receives SQL
// the runner never executes. `applyMigrations()` iterates that array so a
// single canonical entry-point applies every committed migration, and this
// file pins the canonical-path runner properties:
//
//   R1 — `applyMigrations()` against a fresh database applies EVERY registered
//        version, leaving one `schema_migrations` row per version and every
//        migration's deliverable table materialized. Catches a regression that
//        either drops a version from the `MIGRATIONS` array or hardcodes the
//        runner back to a single version.
//   R2 — `applyMigrations()` is idempotent at the canonical-path layer:
//        re-calling on an already-fully-migrated database is a no-op (no throw,
//        no duplicate `schema_migrations` rows, no perturbed anchor data).
//        This pins the runner loop's outer-probe short-circuit, which is
//        distinct from the SQL-level self-idempotency each migration's own
//        suite exercises under repeated direct `tx.exec()`.
//
// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy)
// ----------------------------------------------------------------------------
//
// The `adaptPGlite` helper mirrors the shape used in the sibling
// `session-directory-service.test.ts` file. We inline a local copy here rather
// than extracting a shared package-level fixture because the helper is small
// enough that an `internal/` extraction would add more indirection than it
// removes; if the call-site count grows further, revisit the extraction
// trade-off.

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
// Each test gets a fresh in-memory PGlite instance. Unlike the per-migration
// suites (which bootstrap the earlier versions directly via `tx.exec(...)` so
// they can test one migration's SQL in isolation), THIS file's tests exercise
// `applyMigrations()` itself as the system under test. The `beforeEach` here
// intentionally leaves the database EMPTY — every test calls
// `applyMigrations` explicitly and asserts on the post-call state.

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
// R1 — applyMigrations applies every registered version on a fresh database
// ----------------------------------------------------------------------------

describe("applyMigrations — per-version loop applies all registered migrations", () => {
  it("populates schema_migrations with every registered version AND materializes every migration's tables", async () => {
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

    // (a) schema_migrations carries one anchor row per registered version. A
    // regression that drops a version from the MIGRATIONS array or reverts the
    // runner to a hardcoded single-version shape would surface here.
    const versionProbe = await ctx.querier.query<{ version: number; description: string }>(
      "SELECT version, description FROM schema_migrations ORDER BY version ASC",
    );
    // Description strings are pinned as a secondary anchor —
    // `hasMigrationApplied` keys on `version` alone, so a regression that
    // quietly swapped a description (a copy-paste error in a future migration)
    // would slip past version-only probes but surface here.
    expect(versionProbe.rows).toEqual([
      { version: 1, description: "Initial schema" },
      { version: 2, description: "Runtime node attachments and presence" },
      { version: 3, description: "Event log anchors (integrity witness)" },
    ]);

    // (b) every registered migration's deliverable table is materialized
    // through the runner. A regression where a version's INSERT row landed in
    // schema_migrations but its DDL was skipped (impossible under the current
    // per-version-transaction shape but worth pinning) would surface here. v2
    // ships `runtime_node_attachments` + `runtime_node_presence`; v3 ships
    // `event_log_anchors`.
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

    const anchorTableProbe = await ctx.querier.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'event_log_anchors'
       ) AS exists`,
    );
    const anchorTableRow = anchorTableProbe.rows[0];
    expect(anchorTableRow).toBeDefined();
    if (anchorTableRow === undefined) return;
    expect(anchorTableRow.exists).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// R2 — applyMigrations is idempotent at the canonical-path layer
// ----------------------------------------------------------------------------

describe("applyMigrations — canonical-path idempotency on re-call", () => {
  it("re-calling applyMigrations on a fully-migrated database is a no-op", async () => {
    // First call bootstraps every registered version (verified by R1 above;
    // here it's the ARRANGE step, not the SUT).
    await applyMigrations(ctx.querier);

    // Second call MUST NOT throw and MUST NOT mutate schema_migrations.
    // A regression that bypassed the per-version `hasMigrationApplied`
    // outer-probe short-circuit would surface as either a `42P07 relation
    // already exists` (re-running the DDL against an existing table) or
    // a PK violation (duplicate INSERT into schema_migrations).
    await expect(applyMigrations(ctx.querier)).resolves.toBeUndefined();

    // Row counts unchanged: exactly the registered versions, no duplicates.
    const probe = await ctx.querier.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    expect(probe.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
  });
});
