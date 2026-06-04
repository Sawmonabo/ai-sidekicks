// Plan-003 Phase 3 T3.1 — `0003-runtime-nodes.ts` migration shape regression.
//
// Phase 3 acceptance criterion: applying `0003` against a Postgres DB already
// migrated through `0002` (`0001-initial` + `0002-session-invites`) creates
// BOTH Plan-003-owned tables with the exact column set, the `state` CHECK enum,
// the `idx_node_attachments_node` composite uniqueness, the
// `idx_node_attachments_active` PARTIAL-unique index, and the
// `runtime_node_presence` PK; idempotent under the runner.
//
// This file pins the following load-bearing properties of
// `RUNTIME_NODES_MIGRATION_SQL` (the canonical schema block reproduced verbatim
// from `docs/architecture/schemas/shared-postgres-schema.md`
// §"Runtime Node Attachments (Plan-003)"):
//
//   T1 — BOTH tables (`runtime_node_attachments`, `runtime_node_presence`) exist
//        after applying v1 + v2 + v3, and were ABSENT after only v1 + v2.
//   T2 — `schema_migrations` carries (3, 'Runtime node attachments and presence')
//        alongside the existing (1, ...) and (2, ...) anchor rows.
//   T3 — `runtime_node_attachments` has EXACTLY its documented column set
//        (names + canonical information_schema data_type + nullability).
//   T4 — `runtime_node_presence` has EXACTLY its documented column set
//        (names + types + nullability).
//   T5 — `runtime_node_attachments.state` CHECK admits EXACTLY the five
//        documented states {registering, online, degraded, offline, revoked}
//        and rejects an out-of-enum value (Spec-003 attach lifecycle).
//   T6 — `runtime_node_presence.health_state` CHECK admits EXACTLY the three
//        documented states {online, degraded, offline} and rejects others.
//   T7 — `idx_node_attachments_node` composite UNIQUE (node_id, session_id):
//        a duplicate (node_id, session_id) row is rejected, while the SAME
//        node_id in a DIFFERENT session is permitted by THIS index.
//   T8 — `idx_node_attachments_active` PARTIAL UNIQUE (node_id) WHERE state IN
//        ('registering','online','degraded'): a SECOND active row for the same
//        node_id in a DIFFERENT session is rejected (I-003-5, Spec-003 line
//        118 — "one active session at a time"), AND an inactive
//        ('offline'/'revoked') row for the same node escapes the predicate and
//        inserts cleanly. The rejection case is parameterized over ALL THREE
//        active states (each paired, as the second row, against an 'online'
//        first row) so a regression that narrowed the predicate to a SUBSET of
//        the active set — which T5's per-state CHECK and a lone online+online
//        collision would both miss — goes red here.
//        Using a DIFFERENT session_id for the two active rows is deliberate —
//        a same-session pair would fire the composite index (T7), so the 23505
//        could not be attributed to the partial index specifically; with
//        distinct session_ids the composite index passes and the violation is
//        attributable to `idx_node_attachments_active` alone.
//   T9 — FK enforcement: `session_id` and `participant_id` FK violations each
//        surface a Postgres `23503 foreign_key_violation`.
//   T10 — `runtime_node_presence.node_id` PRIMARY KEY rejects a duplicate
//         node_id INSERT (PK uniqueness).
//   T11 — the canonical `applyMigrations` runner applies v1 + v2 + v3 from a
//         fresh DB AND is idempotent on re-call (no throw, stable
//         schema_migrations, both tables still present).
//
// ----------------------------------------------------------------------------
// Why this file uses direct-exec v1+v2 bootstrap + direct-exec v3 application
// ----------------------------------------------------------------------------
//
// This file exercises `RUNTIME_NODES_MIGRATION_SQL` semantics in isolation at
// the SQL layer — column shape, CHECK clauses, both unique indexes, FK
// enforcement, the presence PK. `applyMigrations()` iterates
// `MIGRATIONS = [v1, v2, v3]` and applies ALL THREE in one call, so using
// `applyMigrations()` in `beforeEach` would pre-apply v3 — defeating T1's
// "tables MUST NOT exist before v3 runs" baseline probe.
//
// Instead, `beforeEach` direct-execs `INITIAL_MIGRATION_SQL` (v1) and
// `SESSION_INVITES_MIGRATION_SQL` (v2) so each test starts migrated through
// v2 with the runtime-node tables absent (the AC's stated starting point:
// "a Postgres DB already migrated through 0002"). The local
// `applyRuntimeNodesMigration` helper then applies v3 SQL directly via the same
// `tx.exec()` primitive — wrapping it in a single transaction so the migration
// body and its `INSERT INTO schema_migrations` commit atomically (the same
// shape the canonical `applyMigrations` transaction uses).
//
// The complementary canonical-path runner coverage (T11 below) calls the real
// `applyMigrations` for the apply-all + idempotency assertions, mirroring R1/R2
// in `sessions/__tests__/migration-runner.test.ts`.
//
// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy)
// ----------------------------------------------------------------------------
//
// The `adaptPGlite` helper duplicated below mirrors the shape used in
// `0002-session-invites.test.ts`, `migration-shape.test.ts`, and
// `runtime-node-upstream-anchors.test.ts`. We inline a local copy here rather
// than extracting a shared package-level fixture because (a) the dispatch
// contract forbids exporting a new test fixture from
// `packages/control-plane/`, and (b) the helper is small enough that an
// `internal/` extraction would add more indirection than it removes; if the
// call-site count grows beyond the current set, revisit the extraction
// trade-off.
//
// Refs: Plan-003 Phase 3 T3.1, Spec-003 line 82 (durable runtime-node records
// for reconnect/audit), line 118 (one active session at a time in v1),
// Plan-003 §Invariants I-003-5, docs/architecture/schemas/
// shared-postgres-schema.md §"Runtime Node Attachments (Plan-003)".

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { INITIAL_MIGRATION_SQL } from "../0001-initial.js";
import { SESSION_INVITES_MIGRATION_SQL } from "../0002-session-invites.js";
import { RUNTIME_NODES_MIGRATION_SQL } from "../0003-runtime-nodes.js";
import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUIDs and helpers
// ----------------------------------------------------------------------------
//
// UUID v4 fixtures stand in for daemon-assigned UUID v7 IDs (BL-069 — the
// schema accepts any RFC 9562 UUID). Two distinct session ids are needed so the
// partial-unique probe (T8) can put two ACTIVE rows for the same node in
// DIFFERENT sessions, isolating `idx_node_attachments_active` from the
// composite `idx_node_attachments_node`.

const SESSION_ID = "01970000-0000-7000-8000-00000000a001";
const OTHER_SESSION_ID = "01970000-0000-7000-8000-00000000a002";
const THIRD_SESSION_ID = "01970000-0000-7000-8000-00000000a003";
const PARTICIPANT_ID = "01970000-0000-7000-8000-00000000b001";
const NODE_ID = "node-fixture-001";

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

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
}

let ctx: TestContext;

beforeEach(async () => {
  // Fresh in-memory PGlite per test — no tmpdir cleanup needed. Bootstraps v1
  // AND v2 via direct `tx.exec(...)` so each test starts "migrated through
  // 0002" (the AC's stated starting point) with the runtime-node tables absent.
  // Using `applyMigrations(querier)` here would pre-apply v3 — see the
  // file-level "Why this file uses direct-exec" header for the full rationale.
  // The transaction wrapper mirrors the canonical `applyMigrations` atomicity
  // boundary so a torn write in the bootstrap leaves the DB cleanly at the
  // prior version.
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await querier.transaction(async (tx) => {
    await tx.exec(INITIAL_MIGRATION_SQL);
  });
  await querier.transaction(async (tx) => {
    await tx.exec(SESSION_INVITES_MIGRATION_SQL);
  });
  ctx = { pg, querier };
});

afterEach(async () => {
  // PGlite's `close()` releases the WASM heap. Awaited under vitest's
  // parallel-file isolation so heap state cannot leak across tests.
  await ctx.pg.close();
});

// Local helper — apply v3 SQL directly inside a transaction so the migration
// body and the schema_migrations INSERT commit atomically. Mirrors how the
// canonical `applyMigrations()` wraps each version
// (`querier.transaction(...) -> tx.exec(SQL)`); inlined here so this file's
// tests exercise the v3 SQL semantics in isolation without going through the
// canonical runner-loop (which would apply v3 in `beforeEach`, pre-applying it
// before each test could probe "runtime_node_* not yet present").
async function applyRuntimeNodesMigration(querier: Querier): Promise<void> {
  await querier.transaction(async (tx) => {
    await tx.exec(RUNTIME_NODES_MIGRATION_SQL);
  });
}

// Local helper — seed the FK ancestors required by `runtime_node_attachments`:
// participants(participant_id) and sessions(session_id ...). The happy-path
// inserts need all referenced rows to exist before any positive-path INSERT
// lands. T9 deliberately omits each side to exercise the FK enforcement.
async function seedSessionsAndParticipant(
  querier: Querier,
  options: { withParticipant?: boolean; sessionIds?: ReadonlyArray<string> } = {},
): Promise<void> {
  const { withParticipant = true, sessionIds = [SESSION_ID, OTHER_SESSION_ID, THIRD_SESSION_ID] } =
    options;
  if (withParticipant) {
    await querier.query("INSERT INTO participants (id) VALUES ($1)", [PARTICIPANT_ID]);
  }
  for (const sessionId of sessionIds) {
    await querier.query("INSERT INTO sessions (id) VALUES ($1)", [sessionId]);
  }
}

// Local helper — build a positional INSERT into runtime_node_attachments with
// explicit state so each test controls the lifecycle state under probe.
function insertAttachment(
  querier: Querier,
  values: { sessionId: string; nodeId: string; state: string },
): Promise<{ rows: ReadonlyArray<unknown> }> {
  return querier.query(
    `INSERT INTO runtime_node_attachments
       (session_id, participant_id, node_id, client_version, state)
     VALUES ($1, $2, $3, '1.0', $4)`,
    [values.sessionId, PARTICIPANT_ID, values.nodeId, values.state],
  );
}

// ----------------------------------------------------------------------------
// T1 — both tables exist after applying v1 + v2 + v3 (absent after v1 + v2)
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T1 — both tables exist after v3)", () => {
  it("creates runtime_node_attachments and runtime_node_presence (absent before v3)", async () => {
    // Pre-condition: v1 + v2 applied by beforeEach. Both runtime-node tables
    // MUST NOT exist before v3 runs (this is the Phase-1 guard's assertion 3,
    // re-anchored here as the Phase-3 baseline).
    const before = await ctx.querier.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('runtime_node_attachments', 'runtime_node_presence')`,
    );
    expect(before.rows).toEqual([]);

    await applyRuntimeNodesMigration(ctx.querier);

    const after = await ctx.querier.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('runtime_node_attachments', 'runtime_node_presence')
        ORDER BY table_name ASC`,
    );
    expect(after.rows.map((row) => row.table_name)).toEqual([
      "runtime_node_attachments",
      "runtime_node_presence",
    ]);
  });
});

// ----------------------------------------------------------------------------
// T2 — schema_migrations carries the v3 anchor row alongside v1 + v2
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T2 — schema_migrations anchor row)", () => {
  it("inserts (3, 'Runtime node attachments and presence') alongside v1 + v2", async () => {
    await applyRuntimeNodesMigration(ctx.querier);

    const probe = await ctx.querier.query<{ version: number; description: string }>(
      "SELECT version, description FROM schema_migrations ORDER BY version ASC",
    );
    expect(probe.rows.map((row) => row.version)).toEqual([1, 2, 3]);

    const v3Row = probe.rows[2];
    expect(v3Row).toBeDefined();
    if (v3Row === undefined) return;
    // The description string is pinned defensively — `hasMigrationApplied`
    // keys on `version` alone, but the description is human-readable
    // operational metadata. A regression that quietly changed it would slip
    // past version-only probes yet confuse operators.
    expect(v3Row.description).toBe("Runtime node attachments and presence");
  });
});

// ----------------------------------------------------------------------------
// T3 — runtime_node_attachments column set (names + types + nullability)
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T3 — runtime_node_attachments column set)", () => {
  it("has EXACTLY the documented columns with canonical types and nullability", async () => {
    await applyRuntimeNodesMigration(ctx.querier);

    const columns = await ctx.querier.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'runtime_node_attachments'
        ORDER BY column_name ASC`,
    );

    // Canonical information_schema.data_type values: UUID -> 'uuid', TEXT ->
    // 'text', JSONB -> 'jsonb', TIMESTAMPTZ -> 'timestamp with time zone'.
    // Sorted by column_name so the comparison is order-independent of the DDL
    // declaration order.
    expect(
      columns.rows.map((row) => ({
        name: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable,
      })),
    ).toEqual([
      { name: "attached_at", type: "timestamp with time zone", nullable: "NO" },
      { name: "capabilities", type: "jsonb", nullable: "NO" },
      { name: "client_version", type: "text", nullable: "NO" },
      { name: "id", type: "uuid", nullable: "NO" },
      { name: "node_id", type: "text", nullable: "NO" },
      { name: "participant_id", type: "uuid", nullable: "NO" },
      { name: "session_id", type: "uuid", nullable: "NO" },
      { name: "state", type: "text", nullable: "NO" },
    ]);
  });
});

// ----------------------------------------------------------------------------
// T4 — runtime_node_presence column set (names + types + nullability)
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T4 — runtime_node_presence column set)", () => {
  it("has EXACTLY the documented columns with canonical types and nullability", async () => {
    await applyRuntimeNodesMigration(ctx.querier);

    const columns = await ctx.querier.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'runtime_node_presence'
        ORDER BY column_name ASC`,
    );

    expect(
      columns.rows.map((row) => ({
        name: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable,
      })),
    ).toEqual([
      { name: "health_state", type: "text", nullable: "NO" },
      { name: "last_heartbeat_at", type: "timestamp with time zone", nullable: "NO" },
      { name: "node_id", type: "text", nullable: "NO" },
    ]);
  });
});

// ----------------------------------------------------------------------------
// T5 — runtime_node_attachments.state CHECK pins the five-state lifecycle
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T5 — attachments.state CHECK)", () => {
  // Spec-003 attach lifecycle: a runtime-node attachment is one of EXACTLY
  // {registering, online, degraded, offline, revoked}. The partial-unique
  // active predicate (idx_node_attachments_active) depends on this enum's
  // active subset {registering, online, degraded}; an out-of-enum value must
  // be rejected at INSERT time.
  const EXPECTED_STATES = ["registering", "online", "degraded", "offline", "revoked"] as const;

  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
    await seedSessionsAndParticipant(ctx.querier);
  });

  for (const state of EXPECTED_STATES) {
    it(`accepts state = '${state}' (canonical attach lifecycle)`, async () => {
      // Each positive case uses a UNIQUE node_id so the partial-unique active
      // index cannot mask a CHECK failure as a uniqueness collision (two
      // active states would otherwise collide on idx_node_attachments_active).
      await expect(
        insertAttachment(ctx.querier, {
          sessionId: SESSION_ID,
          nodeId: `${NODE_ID}-${state}`,
          state,
        }),
      ).resolves.toBeDefined();
    });
  }

  it("rejects an out-of-enum state value (CHECK violation)", async () => {
    // Postgres CHECK violations surface with SQLSTATE `23514`. Assert on
    // substring or code for portability across PGlite/pg driver error shapes.
    await expect(
      insertAttachment(ctx.querier, {
        sessionId: SESSION_ID,
        nodeId: `${NODE_ID}-invalid`,
        state: "suspended",
      }),
    ).rejects.toThrow(/check|constraint|23514/i);
  });
});

// ----------------------------------------------------------------------------
// T6 — runtime_node_presence.health_state CHECK pins the three-state set
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T6 — presence.health_state CHECK)", () => {
  const EXPECTED_HEALTH = ["online", "degraded", "offline"] as const;

  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
  });

  for (const healthState of EXPECTED_HEALTH) {
    it(`accepts health_state = '${healthState}'`, async () => {
      await expect(
        ctx.querier.query(
          `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at, health_state)
           VALUES ($1, now(), $2)`,
          [`presence-${healthState}`, healthState],
        ),
      ).resolves.toBeDefined();
    });
  }

  it("rejects an out-of-enum health_state value (CHECK violation)", async () => {
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at, health_state)
         VALUES ($1, now(), $2)`,
        ["presence-invalid", "registering"],
      ),
    ).rejects.toThrow(/check|constraint|23514/i);
  });
});

// ----------------------------------------------------------------------------
// T7 — idx_node_attachments_node composite UNIQUE (node_id, session_id)
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T7 — composite (node_id, session_id) UNIQUE)", () => {
  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
    await seedSessionsAndParticipant(ctx.querier);
  });

  it("rejects a duplicate (node_id, session_id) row (UNIQUE violation)", async () => {
    // First INSERT — must succeed. Use an inactive state so the composite
    // index is the ONLY uniqueness constraint in play (an active state would
    // also engage the partial-unique active index, blurring which index the
    // second-INSERT violation is attributable to).
    await expect(
      insertAttachment(ctx.querier, { sessionId: SESSION_ID, nodeId: NODE_ID, state: "offline" }),
    ).resolves.toBeDefined();

    // Second INSERT — SAME (node_id, session_id), also inactive. Rejected by
    // the composite UNIQUE. SQLSTATE `23505` (unique_violation).
    await expect(
      insertAttachment(ctx.querier, { sessionId: SESSION_ID, nodeId: NODE_ID, state: "offline" }),
    ).rejects.toThrow(/unique|duplicate key|23505/i);
  });

  it("permits the SAME node_id in a DIFFERENT session (composite index does not block)", async () => {
    // Both inactive so only the composite index is in play. Same node, two
    // different sessions → the composite (node_id, session_id) tuples differ,
    // so both rows are admitted. (The partial-unique active index is exercised
    // separately in T8.)
    await expect(
      insertAttachment(ctx.querier, { sessionId: SESSION_ID, nodeId: NODE_ID, state: "offline" }),
    ).resolves.toBeDefined();
    await expect(
      insertAttachment(ctx.querier, {
        sessionId: OTHER_SESSION_ID,
        nodeId: NODE_ID,
        state: "offline",
      }),
    ).resolves.toBeDefined();
  });
});

// ----------------------------------------------------------------------------
// T8 — idx_node_attachments_active PARTIAL UNIQUE (I-003-5)
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T8 — partial-unique one-active-session, I-003-5)", () => {
  // Spec-003 line 118 / Plan-003 I-003-5: a node has at most ONE attachment in
  // an active state {registering, online, degraded} across ALL sessions. The
  // partial UNIQUE on (node_id) WHERE state IN (active states) is the
  // storage-layer enforcement. T3.2 / P9 (single-active-session refusal)
  // depends on this index existing — a 0003 that omitted it would silently
  // break that downstream task, so this test is the load-bearing guard.
  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
    await seedSessionsAndParticipant(ctx.querier);
  });

  it("rejects a SECOND active row for the same node in a DIFFERENT session (23505)", async () => {
    // First active attachment in SESSION_ID — must succeed.
    await expect(
      insertAttachment(ctx.querier, { sessionId: SESSION_ID, nodeId: NODE_ID, state: "online" }),
    ).resolves.toBeDefined();

    // Second active attachment, SAME node, DIFFERENT session. The composite
    // (node_id, session_id) tuple is DISTINCT here, so idx_node_attachments_node
    // (T7) does NOT fire — the only constraint that can reject this is the
    // partial-unique active index. This is what makes the assertion attributable
    // to idx_node_attachments_active specifically: if that index were deleted,
    // this INSERT would SUCCEED and the test would fail, catching the omission.
    await expect(
      insertAttachment(ctx.querier, {
        sessionId: OTHER_SESSION_ID,
        nodeId: NODE_ID,
        state: "online",
      }),
    ).rejects.toThrow(/unique|duplicate key|23505/i);
  });

  // Cross-active-state coverage: the predicate is `state IN ('registering',
  // 'online', 'degraded')`. The online+online case above proves the index
  // fires, but it would STILL pass if a regression narrowed the predicate to a
  // SUBSET (e.g. dropped 'registering') — because two 'online' rows collide
  // regardless, and T5's CHECK admits each state independently. To make a
  // narrowing of ANY active-state MEMBERSHIP go red, we pair each active state
  // (as the SECOND row) against an already-present 'online' row for the same
  // node in a DIFFERENT session, each expecting 23505. If the state under test
  // were dropped from the predicate, its row would escape the partial index and
  // the INSERT would SUCCEED — failing this assertion. This closes the silent
  // regression window on the sole storage-layer guard for I-003-5 (a node could
  // otherwise hold e.g. a 'registering' attachment in one session and an
  // 'online' in another).
  it.each(["registering", "online", "degraded"] as const)(
    "rejects a second active row in state '%s' alongside an 'online' row for the same node (23505)",
    async (secondState) => {
      // First active attachment ('online') in SESSION_ID — must succeed.
      await expect(
        insertAttachment(ctx.querier, { sessionId: SESSION_ID, nodeId: NODE_ID, state: "online" }),
      ).resolves.toBeDefined();

      // Second active attachment in `secondState`, SAME node, DIFFERENT session.
      // Composite (node_id, session_id) is distinct, so only the partial-unique
      // active index can reject — and only if `secondState` is a member of its
      // predicate set. A regression dropping `secondState` from the predicate
      // would let this row through, turning the expected 23505 into a success.
      await expect(
        insertAttachment(ctx.querier, {
          sessionId: OTHER_SESSION_ID,
          nodeId: NODE_ID,
          state: secondState,
        }),
      ).rejects.toThrow(/unique|duplicate key|23505/i);
    },
  );

  it("permits an INACTIVE ('offline') row for the same node — it escapes the predicate", async () => {
    // One active row in SESSION_ID.
    await expect(
      insertAttachment(ctx.querier, { sessionId: SESSION_ID, nodeId: NODE_ID, state: "online" }),
    ).resolves.toBeDefined();

    // An 'offline' row for the SAME node in a DIFFERENT session is NOT covered
    // by the partial predicate (state IN active-states), so it inserts cleanly.
    // This proves the index is genuinely PARTIAL — a full UNIQUE on (node_id)
    // would wrongly reject this and break reattach eligibility (T3.2: an
    // 'offline' row must be reactivatable on reconnect).
    await expect(
      insertAttachment(ctx.querier, {
        sessionId: OTHER_SESSION_ID,
        nodeId: NODE_ID,
        state: "offline",
      }),
    ).resolves.toBeDefined();
  });

  it("permits a 'revoked' row for the same node — it escapes the predicate", async () => {
    // Complement of the 'offline' case: 'revoked' is also outside the active
    // predicate, so a revoked row coexists with an active row at the index
    // level. (Revocation is terminal at the application layer — T3.2 refuses
    // reattach for a 'revoked' row — but that is a SERVICE decision, not an
    // index constraint; the index must still admit the row.)
    await expect(
      insertAttachment(ctx.querier, { sessionId: SESSION_ID, nodeId: NODE_ID, state: "online" }),
    ).resolves.toBeDefined();
    await expect(
      insertAttachment(ctx.querier, {
        sessionId: THIRD_SESSION_ID,
        nodeId: NODE_ID,
        state: "revoked",
      }),
    ).resolves.toBeDefined();
  });
});

// ----------------------------------------------------------------------------
// T9 — FK constraints on session_id + participant_id are enforced
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T9 — FK constraints enforced)", () => {
  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
  });

  it("rejects an INSERT whose session_id has no matching sessions(id) row (23503)", async () => {
    // Seed participant but NOT the session so the failure is unambiguously the
    // session_id FK. Postgres FK violations surface with SQLSTATE `23503`.
    await seedSessionsAndParticipant(ctx.querier, { withParticipant: true, sessionIds: [] });
    await expect(
      insertAttachment(ctx.querier, { sessionId: SESSION_ID, nodeId: NODE_ID, state: "online" }),
    ).rejects.toThrow(/foreign key|23503/i);
  });

  it("rejects an INSERT whose participant_id has no matching participants(id) row (23503)", async () => {
    // Mirror of the previous test, swapping which FK side is missing: seed the
    // session but NOT the participant.
    await seedSessionsAndParticipant(ctx.querier, {
      withParticipant: false,
      sessionIds: [SESSION_ID],
    });
    await expect(
      insertAttachment(ctx.querier, { sessionId: SESSION_ID, nodeId: NODE_ID, state: "online" }),
    ).rejects.toThrow(/foreign key|23503/i);
  });
});

// ----------------------------------------------------------------------------
// T10 — runtime_node_presence PRIMARY KEY (node_id) uniqueness
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T10 — runtime_node_presence PK)", () => {
  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
  });

  it("rejects a duplicate node_id INSERT (PK uniqueness violation)", async () => {
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at)
         VALUES ($1, now())`,
        [NODE_ID],
      ),
    ).resolves.toBeDefined();

    // Second INSERT with the SAME node_id — rejected by the PRIMARY KEY.
    // SQLSTATE `23505` (unique_violation).
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at)
         VALUES ($1, now())`,
        [NODE_ID],
      ),
    ).rejects.toThrow(/unique|duplicate key|23505/i);
  });
});

// ----------------------------------------------------------------------------
// T11 — canonical applyMigrations applies v1+v2+v3 and is idempotent
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (T11 — applyMigrations applies v3 + idempotency)", () => {
  it("applies v1 + v2 + v3 from a fresh DB and is a no-op on re-call", async () => {
    // Fresh DB: a brand-new PGlite instance (NOT the v1+v2 beforeEach handle)
    // so this asserts the full runner path from zero. A regression that dropped
    // v3 from the MIGRATIONS array would surface as a 2-row schema_migrations
    // and an absent runtime_node_attachments.
    const freshPg = new PGlite();
    const freshQuerier = adaptPGlite(freshPg);
    try {
      await applyMigrations(freshQuerier);

      const versions = await freshQuerier.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version ASC",
      );
      expect(versions.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);

      const tablesAfterFirst = await freshQuerier.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('runtime_node_attachments', 'runtime_node_presence')
          ORDER BY table_name ASC`,
      );
      expect(tablesAfterFirst.rows.map((row) => row.table_name)).toEqual([
        "runtime_node_attachments",
        "runtime_node_presence",
      ]);

      // Re-call — MUST be a no-op (per-version outer-probe short-circuit). A
      // regression that lost the short-circuit would surface as either
      // `42P07 relation already exists` (re-running the DDL) or a PK violation
      // on schema_migrations.version (duplicate INSERT).
      await expect(applyMigrations(freshQuerier)).resolves.toBeUndefined();

      const versionsAfterSecond = await freshQuerier.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version ASC",
      );
      expect(versionsAfterSecond.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);

      // Both tables still present and unperturbed after the idempotent re-call.
      const tablesAfterSecond = await freshQuerier.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN ('runtime_node_attachments', 'runtime_node_presence')
          ORDER BY table_name ASC`,
      );
      expect(tablesAfterSecond.rows.map((row) => row.table_name)).toEqual([
        "runtime_node_attachments",
        "runtime_node_presence",
      ]);
    } finally {
      await freshPg.close();
    }
  });
});
