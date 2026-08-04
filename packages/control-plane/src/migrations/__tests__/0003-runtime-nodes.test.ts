// Plan-003 Phase 3 T3.1 — `0003-runtime-nodes.ts` migration shape regression.
//
// Phase 3 acceptance criterion: applying `0003` against a Postgres DB already
// migrated through `0002` creates `runtime_node_attachments` +
// `runtime_node_presence` with the exact column set, the `state` CHECK enum,
// the composite `(node_id, session_id)` uniqueness, the partial-active unique
// index, and the presence PK; idempotent under the runner.
//
// This file pins ten load-bearing properties of `RUNTIME_NODES_MIGRATION_SQL`:
//
//   P1 — both tables exist only AFTER applying v3 (probe
//        `information_schema.tables`): absent at the "migrated through 0002"
//        baseline, present after.
//   P2 — `schema_migrations` carries (1, ...), (2, ...), and
//        (3, 'Runtime node attachments and presence').
//   P3 — exact column set (the AC): `runtime_node_attachments` has EXACTLY its
//        8 columns and `runtime_node_presence` EXACTLY its 3
//        (`information_schema.columns`, sorted).
//   P4 — `state` CHECK accepts EXACTLY the five lifecycle states
//        {registering, online, degraded, offline, revoked} and rejects an
//        out-of-set value (`Spec-003 §Interfaces And Contracts`; `state` CHECK in
//        `shared-postgres-schema.md` §Runtime Node Attachments).
//   P5 — `health_state` CHECK on `runtime_node_presence` accepts {online,
//        degraded, offline} and rejects an out-of-set value.
//   P6 — composite UNIQUE `idx_node_attachments_node (node_id, session_id)` is
//        enforced (isolated from the partial-active index via a non-active
//        `offline` state so this test pins ONLY the composite key).
//   P7 — partial-active UNIQUE `idx_node_attachments_active` is enforced AND
//        scoped to active states: two ACTIVE rows with the same `node_id` but
//        DIFFERENT `session_id` collide (the I-003-5 single-active-session
//        substrate fires), while an `offline` + active pair with the same
//        `node_id` / different `session_id` both succeed (proving the
//        `WHERE state IN (...)` clause is present and load-bearing).
//   P8 — `runtime_node_presence` PRIMARY KEY on `node_id` rejects a duplicate.
//   P9 — `session_id` FK and `participant_id` FK on `runtime_node_attachments`
//        are enforced (FK violation surfaces a Postgres `23503`).
//   P10 — `applyMigrations` called on an already-fully-migrated handle (v1 + v2
//        bootstrapped via `beforeEach` direct-exec, v3 applied via
//        `applyRuntimeNodesMigration`) is idempotent — no throw, no duplicate
//        `schema_migrations` rows. The cross-path complement to
//        `sessions/__tests__/migration-runner.test.ts` R2: that test proves
//        `applyMigrations` is idempotent when v3 was applied via the runner
//        loop; THIS test proves the runner short-circuits cleanly even when v3
//        was applied via the SQL-level direct-exec path (catches a regression
//        where the runner's per-version outer probe stopped recognizing
//        pre-applied versions).
//
// ----------------------------------------------------------------------------
// Why this file uses direct-exec v1 + v2 bootstrap + direct-exec v3 application
// ----------------------------------------------------------------------------
//
// This file exercises `RUNTIME_NODES_MIGRATION_SQL` semantics in isolation at
// the SQL layer — column shape, CHECK clauses, FK enforcement, the two unique
// indexes, the presence PK, idempotency on repeated direct exec. Post Plan-003
// PR #145, `applyMigrations()` iterates `MIGRATIONS = [v1, v2, v3]` and applies
// ALL THREE in one call, so using `applyMigrations()` in this file's
// `beforeEach` would pre-apply v3 — defeating the point of every test below
// (P1's "runtime_node tables should not yet exist" probe, P2-P9's "apply v3
// cleanly, then probe" structure, P10's "re-exec v3 SQL stays idempotent at
// the SQL layer" assertion).
//
// Instead, `beforeEach` direct-execs `INITIAL_MIGRATION_SQL` (v1) THEN
// `SESSION_INVITES_MIGRATION_SQL` (v2) so each test starts at exactly the AC's
// precondition — a DB "migrated through 0002" with the runtime-node tables
// absent. (This differs from `0002-session-invites.test.ts`'s `beforeEach`,
// which bootstraps v1 ONLY, because that file's AC precondition is a DB at v1;
// THIS file's AC precondition is a DB through v2.) The local
// `applyRuntimeNodesMigration` helper then applies v3 SQL directly via the
// same `tx.exec()` primitive — wrapping it in a single transaction so the
// migration body and its `INSERT INTO schema_migrations` commit atomically
// (the same shape the canonical `applyMigrations` transaction uses, just
// inlined here so the test substrate matches the production atomicity
// boundary).
//
// Canonical-path runner coverage (R1: applyMigrations applies v1+v2+v3; R2:
// applyMigrations is idempotent at the runner-loop layer) lives in the
// dedicated `sessions/__tests__/migration-runner.test.ts` test file. P10 below
// is the COMPLEMENTARY SQL-level idempotency assertion: after all three
// versions are present, re-calling `applyMigrations` MUST short-circuit without
// re-running the SQL.
//
// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy)
// ----------------------------------------------------------------------------
//
// The `adaptPGlite` helper duplicated below mirrors the shape used in
// `sessions/__tests__/session-directory-service.test.ts`,
// `sessions/__tests__/migration-runner.test.ts`, and
// `__tests__/0002-session-invites.test.ts`. We inline a local copy here rather
// than extracting a shared package-level fixture because (a) the dispatch
// contract forbids exporting a new test fixture from
// `packages/control-plane/`, and (b) the helper is small enough that an
// `internal/` extraction would add more indirection than it removes; if the
// call-site count grows further, revisit the extraction trade-off.
//
// Refs: Plan-003 Phase 3 T3.1, `Spec-003 §State And Data Implications` (durable
// runtime-node records for reconnect/audit),
// docs/architecture/schemas/shared-postgres-schema.md §Runtime Node
// Attachments (Plan-003).

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
// schema accepts any RFC 9562 UUID). Two distinct session ids are seeded
// because the partial-active uniqueness reject (P7) needs a SECOND session so
// the composite `(node_id, session_id)` key does NOT also collide — isolating
// the partial-active index as the constraint under test.

const SESSION_ID = "01970000-0000-7000-8000-00000000a001";
const SESSION_ID_2 = "01970000-0000-7000-8000-00000000a002";
const PARTICIPANT_ID = "01970000-0000-7000-8000-00000000b001";

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter
// ----------------------------------------------------------------------------
//
// Structural wrapper around PGlite's `query` + `exec` + `transaction` surface
// so the `Querier` interface (which `applyMigrations` consumes) is satisfied
// without leaking PGlite-specific types into the production surface. See the
// canonical adapter in `sessions/__tests__/session-directory-service.test.ts`
// for the full rationale (mutability of `params`, no-nested-transactions
// runtime guard, `Transaction#exec` returning per-statement results that we
// discard).

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

interface TestContext {
  pg: PGlite;
  querier: Querier;
}

let ctx: TestContext;

beforeEach(async () => {
  // Fresh in-memory PGlite per test — no tmpdir cleanup needed. Bootstraps
  // v1 THEN v2 via direct `tx.exec(...)` so each test starts at exactly the
  // AC's precondition (a DB "migrated through 0002") with the runtime-node
  // tables absent. Using `applyMigrations(querier)` here would pre-apply v3
  // post Plan-003 PR #145 — see the file-level "Why this file uses direct-exec
  // v1 + v2 bootstrap" header for the full rationale. The transaction wrappers
  // mirror the canonical `applyMigrations` atomicity boundary so a torn write
  // in the bootstrap leaves the DB cleanly at the prior version.
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
  // PGlite's `close()` releases the WASM heap. For in-memory instances this
  // is a freed-heap signal; not awaiting could leak across tests under
  // vitest's parallel-file isolation.
  await ctx.pg.close();
});

// Local helper — apply v3 SQL directly inside a transaction so the migration
// body and the schema_migrations INSERT commit atomically. Mirrors how the
// canonical `applyMigrations()` wraps each version
// (`querier.transaction(...) -> tx.exec(SQL)`); inlined here so this file's
// tests exercise the v3 SQL semantics in isolation without going through the
// canonical runner-loop (which post PR #145 would apply v3 in `beforeEach`
// via the v1+v2+v3 iteration, pre-applying it before each test could probe
// "runtime_node tables not yet present"). Canonical-path runner coverage lives
// in `sessions/__tests__/migration-runner.test.ts`.
async function applyRuntimeNodesMigration(querier: Querier): Promise<void> {
  await querier.transaction(async (tx) => {
    await tx.exec(RUNTIME_NODES_MIGRATION_SQL);
  });
}

// Local helper — seed the FK ancestors required by `runtime_node_attachments`:
// participants(participant_id) and sessions(session_id / session_id_2). The
// happy-path inserts in P4/P6/P7 need these to exist before any positive-path
// INSERT lands. P9 deliberately omits each side to exercise the FK enforcement.
// Two session ids are seeded so the partial-active reject (P7) can use a second
// session id that does NOT collide on the composite `(node_id, session_id)`
// key.
async function seedSessionAndParticipant(
  querier: Querier,
  options: { withSession?: boolean; withParticipant?: boolean } = {},
): Promise<void> {
  const { withSession = true, withParticipant = true } = options;
  if (withParticipant) {
    await querier.query("INSERT INTO participants (id) VALUES ($1)", [PARTICIPANT_ID]);
  }
  if (withSession) {
    await querier.query("INSERT INTO sessions (id) VALUES ($1), ($2)", [SESSION_ID, SESSION_ID_2]);
  }
}

// ----------------------------------------------------------------------------
// P1 — both tables exist after applying v3
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (P1 — both tables exist after v3)", () => {
  it("creates runtime_node_attachments + runtime_node_presence in the public schema", async () => {
    // Pre-condition: v1 + v2 applied by beforeEach. Re-probe just to anchor the
    // baseline — BOTH runtime-node tables MUST NOT exist before v3 runs.
    const before = await ctx.querier.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('runtime_node_attachments', 'runtime_node_presence')
        ORDER BY table_name ASC`,
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
// P2 — schema_migrations carries (1, ...), (2, ...), (3, ...) anchor rows
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (P2 — schema_migrations anchor rows)", () => {
  it("inserts (3, 'Runtime node attachments and presence') alongside (1, ...) and (2, ...)", async () => {
    await applyRuntimeNodesMigration(ctx.querier);

    const probe = await ctx.querier.query<{ version: number; description: string }>(
      "SELECT version, description FROM schema_migrations ORDER BY version ASC",
    );
    expect(probe.rows).toHaveLength(3);

    const v1Row = probe.rows[0];
    const v2Row = probe.rows[1];
    const v3Row = probe.rows[2];
    expect(v1Row).toBeDefined();
    expect(v2Row).toBeDefined();
    expect(v3Row).toBeDefined();
    if (v1Row === undefined || v2Row === undefined || v3Row === undefined) return;
    expect(v1Row.version).toBe(1);
    expect(v2Row.version).toBe(2);
    expect(v3Row.version).toBe(3);
    // The description string is pinned defensively — `hasMigrationApplied`
    // (`sessions/migration-runner.ts`) keys on `version` alone, but the
    // description is human-readable operational metadata (manual migration
    // debugging, audit logs). A regression that quietly changed it would slip
    // past version-only probes yet confuse operators.
    expect(v3Row.description).toBe("Runtime node attachments and presence");
  });
});

// ----------------------------------------------------------------------------
// P3 — exact column set (the AC)
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (P3 — exact column set)", () => {
  // The AC pins the EXACT column set of both tables — a regression that adds,
  // drops, or renames a column surfaces here. Columns are compared sorted so
  // the assertion is order-independent (information_schema.columns ordinal
  // ordering is not load-bearing for this property).
  const EXPECTED_ATTACHMENT_COLUMNS = [
    "attached_at",
    "capabilities",
    "client_version",
    "id",
    "node_id",
    "participant_id",
    "session_id",
    "state",
  ] as const;
  const EXPECTED_PRESENCE_COLUMNS = ["health_state", "last_heartbeat_at", "node_id"] as const;

  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
  });

  it("runtime_node_attachments has EXACTLY its 8 columns", async () => {
    const probe = await ctx.querier.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'runtime_node_attachments'
        ORDER BY column_name ASC`,
    );
    expect(probe.rows.map((row) => row.column_name)).toEqual([...EXPECTED_ATTACHMENT_COLUMNS]);
  });

  it("runtime_node_presence has EXACTLY its 3 columns", async () => {
    const probe = await ctx.querier.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'runtime_node_presence'
        ORDER BY column_name ASC`,
    );
    expect(probe.rows.map((row) => row.column_name)).toEqual([...EXPECTED_PRESENCE_COLUMNS]);
  });
});

// ----------------------------------------------------------------------------
// P4 — state CHECK pins the five-state lifecycle exactly
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (P4 — state CHECK pins {registering, online, degraded, offline, revoked})", () => {
  // `Spec-003 §Interfaces And Contracts` + the `state` CHECK in shared-postgres-schema.md §Runtime
  // Node Attachments: the attachment lifecycle is EXACTLY {registering, online,
  // degraded, offline, revoked}. Each valid state is inserted with a DISTINCT
  // node_id so the partial-active unique index (which constrains the active
  // states registering/online/degraded) does not collide across the positive
  // cases — isolating the `state` CHECK as the property under test.
  const VALID_STATES = ["registering", "online", "degraded", "offline", "revoked"] as const;

  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
    await seedSessionAndParticipant(ctx.querier);
  });

  for (const [index, state] of VALID_STATES.entries()) {
    it(`accepts state = '${state}' (canonical lifecycle per Spec-003 §Interfaces And Contracts)`, async () => {
      await expect(
        ctx.querier.query(
          `INSERT INTO runtime_node_attachments
             (session_id, participant_id, node_id, client_version, state)
           VALUES ($1, $2, $3, $4, $5)`,
          [SESSION_ID, PARTICIPANT_ID, `node-p4-${index}`, "1.0", state],
        ),
      ).resolves.toBeDefined();
    });
  }

  it("rejects an out-of-set state value (CHECK violation)", async () => {
    // Postgres CHECK violations surface with SQLSTATE `23514` (check
    // violation). Assert on substring rather than the code so the test does
    // not depend on driver-specific error-code propagation.
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_attachments
           (session_id, participant_id, node_id, client_version, state)
         VALUES ($1, $2, $3, $4, 'bogus')`,
        [SESSION_ID, PARTICIPANT_ID, "node-p4-bogus", "1.0"],
      ),
    ).rejects.toThrow(/check|constraint|23514/i);
  });
});

// ----------------------------------------------------------------------------
// P5 — health_state CHECK pins the three-state set exactly
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (P5 — health_state CHECK pins {online, degraded, offline})", () => {
  // The `health_state` CHECK in shared-postgres-schema.md §Runtime Node
  // Attachments: presence health is EXACTLY {online, degraded, offline}.
  // runtime_node_presence has no FK, so no ancestor seeding is needed; each
  // valid value uses a distinct node_id (the PK) to avoid a PK collision
  // masking a CHECK failure.
  const VALID_HEALTH_STATES = ["online", "degraded", "offline"] as const;

  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
  });

  for (const [index, healthState] of VALID_HEALTH_STATES.entries()) {
    it(`accepts health_state = '${healthState}'`, async () => {
      await expect(
        ctx.querier.query(
          `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at, health_state)
           VALUES ($1, now(), $2)`,
          [`node-p5-${index}`, healthState],
        ),
      ).resolves.toBeDefined();
    });
  }

  it("rejects an out-of-set health_state value (CHECK violation)", async () => {
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at, health_state)
         VALUES ($1, now(), 'bogus')`,
        ["node-p5-bogus"],
      ),
    ).rejects.toThrow(/check|constraint|23514/i);
  });
});

// ----------------------------------------------------------------------------
// P6 — composite UNIQUE idx_node_attachments_node (node_id, session_id)
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (P6 — composite UNIQUE (node_id, session_id))", () => {
  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
    await seedSessionAndParticipant(ctx.querier);
  });

  it("rejects a second row with the same (node_id, session_id) (UNIQUE violation)", async () => {
    // Isolate the composite index from the partial-active index by using a
    // NON-active state (`offline`), which is EXCLUDED from the partial-active
    // predicate. Both rows share the same (node_id, session_id), so the only
    // constraint that can fire is the composite `idx_node_attachments_node`.
    // Postgres UNIQUE violations surface with SQLSTATE `23505`; assert on
    // substring or code for portability across PGlite/pg driver error shapes.
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_attachments
           (session_id, participant_id, node_id, client_version, state)
         VALUES ($1, $2, $3, $4, 'offline')`,
        [SESSION_ID, PARTICIPANT_ID, "node-p6-composite", "1.0"],
      ),
    ).resolves.toBeDefined();

    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_attachments
           (session_id, participant_id, node_id, client_version, state)
         VALUES ($1, $2, $3, $4, 'offline')`,
        [SESSION_ID, PARTICIPANT_ID, "node-p6-composite", "1.0"],
      ),
    ).rejects.toThrow(/unique|duplicate key|23505/i);
  });
});

// ----------------------------------------------------------------------------
// P7 — partial-active UNIQUE idx_node_attachments_active (I-003-5 substrate)
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (P7 — partial-active UNIQUE enforces single-active-session, I-003-5)", () => {
  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
    await seedSessionAndParticipant(ctx.querier);
  });

  it("rejects two ACTIVE rows for the same node across different sessions (partial-active fires)", async () => {
    // I-003-5 single-active-session: a node has at most one attachment in an
    // active state across ALL sessions. Both rows default to state
    // `registering` (active) with the SAME node_id but DIFFERENT session_id —
    // the composite `(node_id, session_id)` key PASSES (sessions differ), so
    // the ONLY constraint that can reject is the partial-active unique index.
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_attachments
           (session_id, participant_id, node_id, client_version)
         VALUES ($1, $2, $3, $4)`,
        [SESSION_ID, PARTICIPANT_ID, "node-p7-active", "1.0"],
      ),
    ).resolves.toBeDefined();

    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_attachments
           (session_id, participant_id, node_id, client_version)
         VALUES ($1, $2, $3, $4)`,
        [SESSION_ID_2, PARTICIPANT_ID, "node-p7-active", "1.0"],
      ),
    ).rejects.toThrow(/unique|duplicate key|23505/i);
  });

  it("allows an offline row + an active row for the same node across different sessions (WHERE clause is load-bearing)", async () => {
    // Proves the `WHERE state IN ('registering','online','degraded')` predicate
    // is present: the `offline` row is EXCLUDED from the partial-active index,
    // so a later ACTIVE (re)attach of the same node on a DIFFERENT session is
    // NOT blocked at the index level (composite key also passes — sessions
    // differ). Both inserts MUST succeed. A regression that dropped the WHERE
    // clause (making the index an unconditional UNIQUE(node_id)) would reject
    // the second insert and fail this test.
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_attachments
           (session_id, participant_id, node_id, client_version, state)
         VALUES ($1, $2, $3, $4, 'offline')`,
        [SESSION_ID, PARTICIPANT_ID, "node-p7-mixed", "1.0"],
      ),
    ).resolves.toBeDefined();

    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_attachments
           (session_id, participant_id, node_id, client_version, state)
         VALUES ($1, $2, $3, $4, 'online')`,
        [SESSION_ID_2, PARTICIPANT_ID, "node-p7-mixed", "1.0"],
      ),
    ).resolves.toBeDefined();
  });
});

// ----------------------------------------------------------------------------
// P8 — runtime_node_presence PRIMARY KEY on node_id
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (P8 — runtime_node_presence PK on node_id)", () => {
  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
  });

  it("rejects a duplicate node_id INSERT (PK violation)", async () => {
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at)
         VALUES ($1, now())`,
        ["node-p8-pk"],
      ),
    ).resolves.toBeDefined();

    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_presence (node_id, last_heartbeat_at)
         VALUES ($1, now())`,
        ["node-p8-pk"],
      ),
    ).rejects.toThrow(/unique|duplicate key|23505/i);
  });
});

// ----------------------------------------------------------------------------
// P9 — FK constraints on session_id + participant_id are enforced
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (P9 — FK constraints enforced)", () => {
  beforeEach(async () => {
    await applyRuntimeNodesMigration(ctx.querier);
  });

  it("rejects an INSERT whose session_id has no matching sessions(id) row (FK violation)", async () => {
    // Seed participant but NOT session so the failure mode is unambiguously the
    // session_id FK. Postgres FK violations surface with SQLSTATE `23503`;
    // assert on substring or code for portability across PGlite/pg driver
    // error shapes.
    await seedSessionAndParticipant(ctx.querier, { withSession: false, withParticipant: true });
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_attachments
           (session_id, participant_id, node_id, client_version)
         VALUES ($1, $2, $3, $4)`,
        [SESSION_ID, PARTICIPANT_ID, "node-p9-no-session", "1.0"],
      ),
    ).rejects.toThrow(/foreign key|23503/i);
  });

  it("rejects an INSERT whose participant_id has no matching participants(id) row (FK violation)", async () => {
    // Mirror of the previous test, swapping which FK side is missing.
    await seedSessionAndParticipant(ctx.querier, { withSession: true, withParticipant: false });
    await expect(
      ctx.querier.query(
        `INSERT INTO runtime_node_attachments
           (session_id, participant_id, node_id, client_version)
         VALUES ($1, $2, $3, $4)`,
        [SESSION_ID, PARTICIPANT_ID, "node-p9-no-participant", "1.0"],
      ),
    ).rejects.toThrow(/foreign key|23503/i);
  });
});

// ----------------------------------------------------------------------------
// P10 — applyMigrations idempotency after v3 is applied
// ----------------------------------------------------------------------------

describe("0003-runtime-nodes migration (P10 — applyMigrations idempotency post-v3)", () => {
  it("re-calling applyMigrations after v3 is applied is a no-op (no throw, no duplicate rows)", async () => {
    // `applyMigrations` (`sessions/migration-runner.ts`) iterates
    // `MIGRATIONS = [v1, v2, v3]` post Plan-003 PR #145, with a per-version
    // `hasMigrationApplied` outer probe that short-circuits when the version's
    // anchor row exists. This test pre-applies v1 + v2 (via `beforeEach`
    // direct-exec) AND v3 (via the local `applyRuntimeNodesMigration`
    // direct-exec helper), then calls `applyMigrations` and asserts it's a
    // no-op — every per-version outer probe MUST recognize the pre-applied
    // versions, regardless of which codepath ran the original migration SQL.
    // A regression that lost the outer-probe short-circuit would surface here
    // as either a re-run of a prior version's DDL (`42P07 relation already
    // exists`) or a duplicate-row insert into `schema_migrations` (PK
    // violation on `version`).
    //
    // Complementary to `sessions/__tests__/migration-runner.test.ts` R2,
    // which asserts canonical-path idempotency (apply via runner, re-call via
    // runner). This test asserts cross-path idempotency (apply via direct-exec,
    // re-call via runner) — important because production migration paths
    // (CI-driven runner) and operational debugging paths (manual SQL exec)
    // might diverge over time.
    await applyRuntimeNodesMigration(ctx.querier);

    // Second call — must be a no-op.
    await expect(applyMigrations(ctx.querier)).resolves.toBeUndefined();

    // Row counts unchanged: exactly four rows total, exactly one (3, ...) row.
    const counts = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM schema_migrations",
    );
    const countsRow = counts.rows[0];
    expect(countsRow).toBeDefined();
    if (countsRow === undefined) return;
    expect(Number.parseInt(countsRow.count, 10)).toBe(4);

    const v3Probe = await ctx.querier.query<{ description: string }>(
      "SELECT description FROM schema_migrations WHERE version = $1",
      [3],
    );
    expect(v3Probe.rows).toHaveLength(1);
    const v3Row = v3Probe.rows[0];
    expect(v3Row).toBeDefined();
    if (v3Row === undefined) return;
    expect(v3Row.description).toBe("Runtime node attachments and presence");
  });
});
