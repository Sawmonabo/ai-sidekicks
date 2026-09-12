// Read-only upstream-schema ANCHOR guard.
//
// (a) What this is
// ----------------------------------------------------------------------------
// This file is the structural guard for that "reads, does not CREATE" obligation. It is
// assertion-only: it CREATEs nothing, it introspects the schema the shipped control-plane
// migrations already produce.
//
// It pins three facts against the ABSOLUTE post-all-migrations control-plane
// schema:
//
//   (1) the identity anchors (`users`, `sessions`) are present
//       The `runtime_node_attachments.user_id REFERENCES
//       users(id)` and `.session_id REFERENCES sessions(id)` resolve at
//       Phase-3 CREATE-time only because ships these first.
//       flow READS the per-session version floor from this forward-declared column (the
//       `sessions` block in `packages/control-plane/src/migrations/0001-initial.ts`).
//   (3) the OWN Postgres tables (`runtime_node_attachments`,
//
// (b) Substrate rationale — why this guard lives in control-plane, NOT daemon
// ----------------------------------------------------------------------------
// Every anchor this guard touches — `users`, `sessions.min_client_version`,
// and the deferred `runtime_node_attachments` / `runtime_node_presence` — is a
// POSTGRES / control-plane surface (the runtime_node tables carry `-- Owner: `).
// None of them is visible to a SQLite-introspecting test. So the honest home for
// this guard is the control-plane PGlite suite, and the plan's "co-locate in a
// Phase-1 migration test" is satisfied by THIS control-plane migrations
// `__tests__/` directory.
//
// We deliberately add NO daemon-side assertion. The daemon's own
// `migration-shape.test.ts` already enforces an exact-set equality over
// `ALL_EXPECTED_TABLES`, which structurally discharges the daemon "no extra
// table" negative for free — a Postgres table can never appear in the daemon's
// SQLite schema, so there is nothing for a daemon test to assert about
// `runtime_node_*`. Duplicating the negative there would be noise.
//
// (c) Division of labor — distinct from the delta guard
// ----------------------------------------------------------------------------
// The sibling `migration-shape.test.ts` is a DELTA guard: it snapshots the
// public table set before and after the runner's apply and asserts the delta is
// exactly the tables the later migrations claim. Its `beforeEach` deliberately
// applies the initial migration ONLY (direct `tx.exec`) so the delta has a
// baseline.
//
// THIS file is the complementary ABSOLUTE-STATE guard: it applies ALL shipped
// migrations via the canonical `applyMigrations` runner and asserts the
// resulting full schema CONTAINS the session-directory anchors and the
// runtime-node tables. It is not a delta; it answers a different question —
// "is the upstream contract the runtime-node flow depends on actually
// shipped?".
//
// (d) Lifecycle TRIPWIRE on assertion (3) — RESOLVED in Phase 3
// ----------------------------------------------------------------------------
// Assertion (3) was PHASE-1-SCOPED: it asserted `runtime_node_attachments` /
// `runtime_node_presence` were ABSENT, with the documented expectation that it
// WOULD — and MUST — fail once shipped the control-plane migration creating those
// two tables (`0002-runtime-nodes.ts`, registered as v2 in
// `migration-runner.ts`). That has now happened: Phase 3 ships v2,
// `applyMigrations` in this file's beforeEach materializes both tables, and
// assertion (3) was flipped ABSENT→PRESENT (it now asserts `.toBe(true)`). The
// full-schema carve-out the tripwire alluded to ("fold the two tables into a
// Phase-3 absolute-shape guard") is realized as the new assertion (4): the ONLY
// durable presence-NAMED table is the sanctioned `runtime_node_presence` liveness
// record (a DIFFERENT domain from the in-memory collaborative Yjs Awareness
// presence governs). Assertions (1) and (2) remain permanent — anchors do not
// move.
//
// (e) Inline-adapter rationale
// ----------------------------------------------------------------------------
// The PGlite→Querier adapter and `snapshotPublicTables` below are inlined, not
// imported from a shared fixture, because the dispatch contract forbids
// exporting a new test fixture from `packages/control-plane/`, and the helper
// is small. Sibling tests do the same — e.g. `migration-shape.test.ts` —
// each carrying its own local copy. Revisit
// the extraction trade-off if the call-site count grows.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy — see header note (e))
// ----------------------------------------------------------------------------
//
// Mirrors the adapter in `migration-shape.test.ts` (see header note (e)).
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
// predicate (the same predicate `hasMigrationApplied` uses). Returns a `Set` so
// the caller can do containment checks directly.
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
  // Fresh in-memory PGlite per test, then apply ALL shipped control-plane
  // migrations through the canonical runner. Unlike `migration-shape.test.ts`
  // (which applies the initial migration ONLY because the delta needs a
  // baseline), this guard wants the ABSOLUTE post-all-migrations schema, so it
  // uses `applyMigrations` — which walks every registered version
  // (migration-runner.ts).
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = { pg, querier };
});

afterEach(async () => {
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------

describe("upstream-anchor guard (reads, does not CREATE)", () => {
  it("(1) identity anchors are present: users + sessions", async () => {
    // The runtime_node_attachments FK-references users(id) and
    // sessions(id); both must already exist for the Phase-3 CREATE to resolve.
    const tables: Set<string> = await snapshotPublicTables(ctx.querier);
    expect(tables.has("users")).toBe(true);
    expect(tables.has("sessions")).toBe(true);
  });

  it("(2) sessions.min_client_version exists and is TEXT (reads the floor)", async () => {
    // Attach-time floor check reads the per-session version floor from this
    // forward-declared column. Assert the column exists exactly once and its canonical
    // information_schema data_type is `text`.
    const columnProbe = await ctx.querier.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'sessions'
          AND column_name = 'min_client_version'`,
    );
    expect(columnProbe.rows).toHaveLength(1);
    const column: { data_type: string } | undefined = columnProbe.rows[0];
    expect(column?.data_type).toBe("text");
  });

  it("(3) Postgres tables are PRESENT after Phase 3 (v2 migration shipped)", async () => {
    // Phase 3 shipped that migration, so `applyMigrations` in this
    // file's beforeEach now materializes both tables; this assertion was
    // flipped from ABSENT→PRESENT then. Assertions (1) and (2) remain
    // permanent -anchor guards.
    const tables: Set<string> = await snapshotPublicTables(ctx.querier);
    expect(tables.has("runtime_node_attachments")).toBe(true);
    expect(tables.has("runtime_node_presence")).toBe(true);
  });

  it("(4) the only durable presence-NAMED public table is the sanctioned runtime-node one (at full-schema scope)", async () => {
    // Carve-out (invariant, re-verified at full-schema scope). keeps COLLABORATIVE
    // presence (Yjs Awareness CRDT — cursors/awareness) in-memory only. This pins
    // that the ONLY durable presence-NAMED table is the sanctioned runtime-node one
    // — a future durable COLLABORATIVE-presence table would surface here as an extra
    // member and re-fail at full-schema scope, which the narrower per-migration
    // guards no longer span.
    const tables: Set<string> = await snapshotPublicTables(ctx.querier);
    const presenceTables: string[] = [...tables]
      .filter((tableName) => tableName.toLowerCase().includes("presence"))
      .sort();
    expect(presenceTables).toEqual(["runtime_node_presence"]);
  });
});
