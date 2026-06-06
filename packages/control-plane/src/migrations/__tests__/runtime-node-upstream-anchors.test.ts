// Plan-003 Phase 1 T1.7 — read-only upstream-schema ANCHOR guard.
//
// (a) What this is
// ----------------------------------------------------------------------------
// Plan-003 (Runtime Node Attach) READS and FK-references two Plan-001-owned
// Postgres surfaces but must NEVER duplicate-CREATE them, and it must NOT
// prematurely create its OWN Phase-3 Postgres tables during Phase 1. This file
// is the structural guard for that "reads, does not CREATE" obligation
// (docs/plans/003-runtime-node-attach.md §Phase 1 T1.7, lines 290-296). It is
// assertion-only: it CREATEs nothing, it introspects the schema the shipped
// control-plane migrations already produce.
//
// It pins three facts against the ABSOLUTE post-all-migrations control-plane
// schema:
//
//   (1) Plan-001's identity anchors (`participants`, `sessions`) are present —
//       Plan-003's `runtime_node_attachments.participant_id REFERENCES
//       participants(id)` and `.session_id REFERENCES sessions(id)` resolve at
//       Phase-3 CREATE-time only because Plan-001 ships these first
//       (docs/architecture/cross-plan-dependencies.md §1 Table Ownership Map;
//       docs/architecture/schemas/shared-postgres-schema.md §Migration-order
//       invariant).
//   (2) `sessions.min_client_version` exists and is TEXT — Plan-003's attach
//       flow READS the per-session version floor from this Plan-001
//       forward-declared column (ADR-018 §Decision #4; Spec-003 line 53;
//       packages/control-plane/src/migrations/0001-initial.ts line 104).
//   (3) Plan-003's OWN Postgres tables (`runtime_node_attachments`,
//       `runtime_node_presence`) are ABSENT after Phase 1 — they are
//       Plan-003-owned but created by the FORWARD-DECLARED Phase-3 control-plane
//       migration (`0003-runtime-nodes.ts`), NOT here. See assertion-(3) tripwire
//       note in (d) below.
//
// (b) Substrate rationale — why this guard lives in control-plane, NOT daemon
// ----------------------------------------------------------------------------
// Every anchor this guard touches — `participants`, `sessions.min_client_version`,
// and the deferred `runtime_node_attachments` / `runtime_node_presence` — is a
// POSTGRES / control-plane surface (cross-plan-dependencies.md §1; the
// runtime_node tables carry `-- Owner: Plan-003` under
// shared-postgres-schema.md §"Runtime Node Attachments (Plan-003)"). None of
// them is visible to a SQLite-introspecting test. So the honest home for this
// guard is the control-plane PGlite suite, and the plan's "co-locate in a
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
// (c) Division of labor — distinct from the Plan-002 P10 delta guard
// ----------------------------------------------------------------------------
// The sibling `migration-shape.test.ts` (Plan-002 §Test Plan P10) is a STEPWISE
// DELTA guard: it snapshots the public table set immediately before and after
// the v2 apply and asserts the v1→v2 delta is exactly `{ session_invites }`.
// Its `beforeEach` deliberately applies v1 ONLY (direct `tx.exec`) so the delta
// has a pre-v2 baseline.
//
// THIS file is the complementary ABSOLUTE-STATE guard: it applies ALL shipped
// migrations (v1 + v2 + v3 via the canonical `applyMigrations` runner) and
// asserts the resulting full schema CONTAINS the Plan-001 anchors and — post
// Phase 3 PR #145 — now CONTAINS the Plan-003 runtime-node tables (assertion
// (3) flipped to PRESENT; see tripwire (d)). It is not a delta and it does not re-assert the
// `session_invites` delta (that is P10's charter); it answers a different
// question — "is the upstream contract Plan-003 depends on actually shipped, and
// has Plan-003 stayed within its Phase-1 lane?".
//
// (d) Lifecycle TRIPWIRE on assertion (3) — RESOLVED in Phase 3 PR #145
// ----------------------------------------------------------------------------
// Assertion (3) was PHASE-1-SCOPED: it asserted `runtime_node_attachments` /
// `runtime_node_presence` were ABSENT, with the documented expectation that it
// WOULD — and MUST — fail once Plan-003 Phase 3 shipped the control-plane
// migration creating those two tables (`0003-runtime-nodes.ts`, registered as
// v3 in `migration-runner.ts`). That has now happened: Phase 3 PR #145 ships v3,
// `applyMigrations` in this file's beforeEach materializes both tables, and
// assertion (3) was flipped ABSENT→PRESENT (it now asserts `.toBe(true)`). The
// full-schema I-002-3 carve-out the tripwire alluded to ("fold the two tables
// into a Phase-3 absolute-shape guard") is realized as the new assertion (4):
// the ONLY durable presence-NAMED table is the sanctioned `runtime_node_presence`
// liveness record (a DIFFERENT domain from the in-memory collaborative Yjs
// Awareness presence I-002-3 governs). Assertions (1) and (2) remain permanent —
// the Plan-001 anchors do not move.
//
// (e) Inline-adapter rationale
// ----------------------------------------------------------------------------
// The PGlite→Querier adapter and `snapshotPublicTables` below are inlined, not
// imported from a shared fixture, because the dispatch contract forbids
// exporting a new test fixture from `packages/control-plane/`, and the helper
// is small. Sibling tests do the same — e.g. `migration-shape.test.ts` and
// `0002-session-invites.test.ts` — each carrying its own local copy. Revisit
// the extraction trade-off if the call-site count grows.
//
// Refs: docs/plans/003-runtime-node-attach.md §Phase 1 T1.7 (lines 290-296);
// docs/architecture/cross-plan-dependencies.md §1 Table Ownership Map (the
// `participants` + `sessions.min_client_version` forward-declared-split rows,
// and the Plan-003 SQLite/Postgres ownership row); docs/architecture/schemas/
// shared-postgres-schema.md §"Runtime Node Attachments (Plan-003)" (the two
// `-- Owner: Plan-003` Postgres tables); `migrations/0001-initial.ts`
// (`participants` line 92, `sessions.min_client_version TEXT` line 104);
// `migration-shape.test.ts` (the complementary Plan-002 P10 delta guard).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy — see header note (e))
// ----------------------------------------------------------------------------
//
// Mirrors the adapter in `migration-shape.test.ts` /
// `0002-session-invites.test.ts` (see header note (e)). Inlined here (rather
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
  // (which applies v1 ONLY because P10 needs a pre-v2 delta baseline), this
  // guard wants the ABSOLUTE post-all-migrations schema, so it uses
  // `applyMigrations` — which walks `MIGRATIONS = [v1, v2, v3]` and applies
  // every pending version (migration-runner.ts). Post Phase 3 PR #145 this call
  // also produces the runtime_node_* tables — see header tripwire (d).
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = { pg, querier };
});

afterEach(async () => {
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// T1.7 — upstream-anchor structural guard
// ----------------------------------------------------------------------------

describe("Plan-003 T1.7 upstream-anchor guard (reads, does not CREATE — cross-plan-dependencies.md §1)", () => {
  it("(1) Plan-001 identity anchors are present: participants + sessions", async () => {
    // Plan-003's runtime_node_attachments FK-references participants(id) and
    // sessions(id); both must already exist for the Phase-3 CREATE to resolve.
    const tables: Set<string> = await snapshotPublicTables(ctx.querier);
    expect(tables.has("participants")).toBe(true);
    expect(tables.has("sessions")).toBe(true);
  });

  it("(2) sessions.min_client_version exists and is TEXT (Plan-003 reads the floor)", async () => {
    // Plan-003 attach-time floor check reads the per-session version floor from
    // this Plan-001 forward-declared column (ADR-018 §Decision #4; Spec-003
    // line 53). Assert the column exists exactly once and its canonical
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

  it("(3) Plan-003 Postgres tables are PRESENT after Phase 3 (v3 migration shipped)", async () => {
    // TRIPWIRE RESOLVED (header note (d)): runtime_node_attachments /
    // runtime_node_presence are Plan-003-OWNED and are now CREATEd by the v3
    // control-plane migration (`0003-runtime-nodes.ts`, registered as v3 in
    // `migration-runner.ts`). Phase 3 PR #145 shipped that migration, so
    // `applyMigrations` in this file's beforeEach now materializes both tables;
    // this assertion was flipped from ABSENT→PRESENT in PR #145. Assertions (1)
    // and (2) remain permanent Plan-001-anchor guards.
    const tables: Set<string> = await snapshotPublicTables(ctx.querier);
    expect(tables.has("runtime_node_attachments")).toBe(true);
    expect(tables.has("runtime_node_presence")).toBe(true);
  });

  it("(4) the only durable presence-NAMED public table is the sanctioned runtime-node one (I-002-3 at full-schema scope)", async () => {
    // I-002-3 carve-out (Plan-002 invariant, re-verified at full-schema scope).
    // I-002-3 keeps COLLABORATIVE presence (Yjs Awareness CRDT — cursors/awareness)
    // in-memory only. runtime_node_presence is a DIFFERENT domain: runtime-node
    // liveness (heartbeat + health_state), a durable coordination record sanctioned
    // by Spec-003 §Default Behavior, ADR-017 §Server-Derived Runtime-Node Lifecycle
    // Events, and shared-postgres-schema.md §Runtime Node Attachments (`-- Owner:
    // Plan-003`). This pins that the ONLY durable presence-NAMED table is the
    // sanctioned runtime-node one — a future durable COLLABORATIVE-presence table
    // would surface here as an extra member and re-fail I-002-3 at full-schema scope
    // (the coverage the Plan-002 v1→v2 guards intentionally no longer span post-v3).
    const tables: Set<string> = await snapshotPublicTables(ctx.querier);
    const presenceTables: string[] = [...tables]
      .filter((tableName) => tableName.toLowerCase().includes("presence"))
      .sort();
    expect(presenceTables).toEqual(["runtime_node_presence"]);
  });
});
