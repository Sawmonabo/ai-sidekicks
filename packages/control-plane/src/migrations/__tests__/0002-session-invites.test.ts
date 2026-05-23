// Plan-002 Phase 1 T1.5 — `0002-session-invites.ts` migration shape regression.
//
// Phase 1 acceptance criterion: "`session_invites` migration applies cleanly".
// This file pins seven load-bearing properties of `SESSION_INVITES_MIGRATION_SQL`:
//
//   T1 — table exists after applying v1 + v2 (probe `information_schema.tables`).
//   T2 — `schema_migrations` carries both (1, ...) and (2, 'session_invites table').
//   T3 — `join_mode` CHECK rejects snake_case `runtime_contributor` and accepts
//        the SPACED canonical wire form `runtime contributor` (Spec-002 line 45,
//        canonical `MembershipRole`/`InviteJoinMode` in
//        `packages/contracts/src/{session,invites}.ts`).
//   T4 — `state` CHECK accepts EXACTLY the four V1 lifecycle states
//        `{pending, accepted, revoked, expired}` and rejects `declined`
//        (Spec-002 line 43; pinned at the contract layer by
//        `InviteStateSchema` test C2).
//   T5 — `session_id` FK and `inviter_id` FK are enforced (FK violation
//        surfaces a Postgres `23503 foreign_key_violation`).
//   T6 — I-002-3 verification-by-omission: no presence-state table is created
//        anywhere in the schema after v1 + v2 apply (defense for THIS
//        migration; T2.5 ships the broader P10 regression).
//   T7 — `applyMigrations` (hardcoded to v1) called on an already-fully-
//        migrated handle is idempotent — no throw, no duplicate
//        `schema_migrations` rows.
//
// ----------------------------------------------------------------------------
// Why the migration runner is NOT used for v2 here
// ----------------------------------------------------------------------------
//
// `applyMigrations` (`sessions/migration-runner.ts`) is hardcoded to probe v1
// only — its docstring at lines 151-158 anticipates per-version-loop
// expansion, but wiring v2 into the runner is deferred to the downstream
// Plan-002 service-layer PR (where the table is actually read/written). See
// the `0002-session-invites.ts` header (`Cross-plan boundary` section) for the
// rationale; this test verifies the v2 SQL applies cleanly via direct
// `tx.exec()` to satisfy Phase 1's acceptance criterion without forcing a
// runner-wiring change on Plan-001-owned code.
//
// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (local copy)
// ----------------------------------------------------------------------------
//
// The `adaptPGlite` helper duplicated below mirrors the shape used in
// `sessions/__tests__/session-directory-service.test.ts` lines 84-135. We
// inline a local copy here rather than extracting a shared package-level
// fixture because (a) the dispatch contract forbids exporting a new test
// fixture from `packages/control-plane/`, and (b) the helper is small enough
// that an `internal/` extraction would add more indirection than it removes
// for a two-call-site footprint.
//
// Refs: Plan-002 Phase 1 T1.5, Spec-002 §Required Behavior line 43, §State
// And Data Implications lines 155-157, Plan-002 §Invariants I-002-3.

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SESSION_INVITES_MIGRATION_SQL } from "../0002-session-invites.js";
import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUIDs and helpers
// ----------------------------------------------------------------------------
//
// UUID v4 fixtures stand in for daemon-assigned UUID v7 IDs (BL-069 — the
// schema accepts any RFC 9562 UUID). Counter-derived token hashes ensure
// every insert in the T4 loop carries a unique `token_hash` value (the UNIQUE
// constraint on `token_hash` would otherwise mask a CHECK-clause failure as a
// uniqueness collision).

const SESSION_ID = "01970000-0000-7000-8000-00000000a001";
const INVITER_ID = "01970000-0000-7000-8000-00000000b001";

function uniqueTokenHash(seed: string): string {
  return `sha256:${seed}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

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
  // Fresh in-memory PGlite per test — no tmpdir cleanup needed. The first
  // `applyMigrations` call serves as both the readiness checkpoint and the
  // v1 schema bootstrap.
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = { pg, querier };
});

afterEach(async () => {
  // PGlite's `close()` releases the WASM heap. For in-memory instances this
  // is a freed-heap signal; not awaiting could leak across tests under
  // vitest's parallel-file isolation.
  await ctx.pg.close();
});

// Local helper — apply v2 inside a transaction so the migration body and the
// schema_migrations INSERT commit atomically. Mirrors how `applyMigrations`
// wraps v1 (`querier.transaction(...) -> tx.exec(INITIAL_MIGRATION_SQL)`);
// the migration runner is hardcoded to v1 (per the file-level comment above),
// so the test applies v2 via the same atomicity primitive directly.
async function applySessionInvitesMigration(querier: Querier): Promise<void> {
  await querier.transaction(async (tx) => {
    await tx.exec(SESSION_INVITES_MIGRATION_SQL);
  });
}

// Local helper — seed the FK ancestors required by `session_invites`:
// participants(inviter_id) and sessions(session_id). T3/T4 happy-path inserts
// need both to exist before any positive-path INSERT lands. T5 deliberately
// omits each side to exercise the FK enforcement.
async function seedSessionAndInviter(
  querier: Querier,
  options: { withSession?: boolean; withInviter?: boolean } = {},
): Promise<void> {
  const { withSession = true, withInviter = true } = options;
  if (withInviter) {
    await querier.query("INSERT INTO participants (id) VALUES ($1)", [INVITER_ID]);
  }
  if (withSession) {
    await querier.query("INSERT INTO sessions (id) VALUES ($1)", [SESSION_ID]);
  }
}

// ----------------------------------------------------------------------------
// T1 — table exists after applying v1 + v2
// ----------------------------------------------------------------------------

describe("0002-session-invites migration (T1 — table exists after v1 + v2)", () => {
  it("creates the session_invites table in the public schema", async () => {
    // Pre-condition: v1 applied by beforeEach. Re-probe just to anchor the
    // baseline — `session_invites` MUST NOT exist before v2 runs.
    const before = await ctx.querier.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'session_invites'
       ) AS exists`,
    );
    const beforeRow = before.rows[0];
    expect(beforeRow).toBeDefined();
    if (beforeRow === undefined) return;
    expect(beforeRow.exists).toBe(false);

    await applySessionInvitesMigration(ctx.querier);

    const after = await ctx.querier.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'session_invites'
       ) AS exists`,
    );
    const afterRow = after.rows[0];
    expect(afterRow).toBeDefined();
    if (afterRow === undefined) return;
    expect(afterRow.exists).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// T2 — schema_migrations carries both (1, ...) and (2, ...) anchor rows
// ----------------------------------------------------------------------------

describe("0002-session-invites migration (T2 — schema_migrations anchor rows)", () => {
  it("inserts (2, 'session_invites table') alongside the existing (1, ...) row", async () => {
    await applySessionInvitesMigration(ctx.querier);

    const probe = await ctx.querier.query<{ version: number; description: string }>(
      "SELECT version, description FROM schema_migrations ORDER BY version ASC",
    );
    expect(probe.rows).toHaveLength(2);

    const v1Row = probe.rows[0];
    const v2Row = probe.rows[1];
    expect(v1Row).toBeDefined();
    expect(v2Row).toBeDefined();
    if (v1Row === undefined || v2Row === undefined) return;
    expect(v1Row.version).toBe(1);
    expect(v2Row.version).toBe(2);
    // The exact description string is load-bearing — `applyMigrations` (or a
    // future per-version-loop variant) keys on this row's existence to decide
    // whether v2 has been applied. A regression that changed the description
    // would not break the inserts but would force a per-version probe rewrite.
    expect(v2Row.description).toBe("session_invites table");
  });
});

// ----------------------------------------------------------------------------
// T3 — join_mode CHECK pins the SPACED `runtime contributor` wire form
// ----------------------------------------------------------------------------

describe("0002-session-invites migration (T3 — join_mode CHECK pins canonical wire form)", () => {
  // The SPACED `runtime contributor` literal is the canonical wire form per
  // Spec-002 line 45, `MembershipRole` in `packages/contracts/src/session.ts`,
  // and `InviteJoinMode` in `packages/contracts/src/invites.ts`. This was a
  // major correction in T1.1's POLISH round (commit 7b5f1d6) — the migration
  // is the second place it has to be right. A regression that swapped the
  // CHECK list to snake_case would be silently accepted at INSERT time and
  // only surface as a wire-shape mismatch much later.
  beforeEach(async () => {
    await applySessionInvitesMigration(ctx.querier);
    await seedSessionAndInviter(ctx.querier);
  });

  it("accepts SPACED 'runtime contributor' (canonical wire form per Spec-002 line 45)", async () => {
    await expect(
      ctx.querier.query(
        `INSERT INTO session_invites
           (session_id, inviter_id, token_hash, join_mode, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
        [SESSION_ID, INVITER_ID, uniqueTokenHash("t3-positive"), "runtime contributor"],
      ),
    ).resolves.toBeDefined();
  });

  it("rejects snake_case 'runtime_contributor' (Spec-002 wire form is SPACED)", async () => {
    // Postgres CHECK violations surface with SQLSTATE `23514` (check
    // violation). Assert on substring rather than the code so the test does
    // not depend on driver-specific error-code propagation.
    await expect(
      ctx.querier.query(
        `INSERT INTO session_invites
           (session_id, inviter_id, token_hash, join_mode, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
        [SESSION_ID, INVITER_ID, uniqueTokenHash("t3-negative"), "runtime_contributor"],
      ),
    ).rejects.toThrow(/check|constraint|23514/i);
  });
});

// ----------------------------------------------------------------------------
// T4 — state CHECK pins the four-state V1 lifecycle exactly
// ----------------------------------------------------------------------------

describe("0002-session-invites migration (T4 — state CHECK pins {pending, accepted, revoked, expired})", () => {
  // Spec-002 line 43: invite lifecycle is EXACTLY {pending, accepted, revoked,
  // expired} — no `declined` state. C2 in `packages/contracts/src/__tests__/
  // invites.test.ts` pins the same set at the contract layer; this test
  // mirrors the assertion at the storage layer.
  const EXPECTED_STATES = ["pending", "accepted", "revoked", "expired"] as const;

  beforeEach(async () => {
    await applySessionInvitesMigration(ctx.querier);
    await seedSessionAndInviter(ctx.querier);
  });

  for (const state of EXPECTED_STATES) {
    it(`accepts state = '${state}' (canonical V1 lifecycle per Spec-002 line 43)`, async () => {
      await expect(
        ctx.querier.query(
          `INSERT INTO session_invites
             (session_id, inviter_id, token_hash, join_mode, state, expires_at)
           VALUES ($1, $2, $3, 'viewer', $4, now() + interval '7 days')`,
          [SESSION_ID, INVITER_ID, uniqueTokenHash(`t4-positive-${state}`), state],
        ),
      ).resolves.toBeDefined();
    });
  }

  it("rejects 'declined' — V1 declining is implicit, not an explicit state (Spec-002 line 43)", async () => {
    await expect(
      ctx.querier.query(
        `INSERT INTO session_invites
           (session_id, inviter_id, token_hash, join_mode, state, expires_at)
         VALUES ($1, $2, $3, 'viewer', 'declined', now() + interval '7 days')`,
        [SESSION_ID, INVITER_ID, uniqueTokenHash("t4-negative-declined")],
      ),
    ).rejects.toThrow(/check|constraint|23514/i);
  });
});

// ----------------------------------------------------------------------------
// T5 — FK constraints on session_id + inviter_id are enforced
// ----------------------------------------------------------------------------

describe("0002-session-invites migration (T5 — FK constraints enforced)", () => {
  beforeEach(async () => {
    await applySessionInvitesMigration(ctx.querier);
  });

  it("rejects an INSERT whose session_id has no matching sessions(id) row (FK violation)", async () => {
    // Seed inviter but NOT session so the failure mode is unambiguously the
    // session_id FK. Postgres FK violations surface with SQLSTATE `23503`
    // (foreign_key_violation); assert on substring or code for portability
    // across PGlite/pg driver error-shape variations.
    await seedSessionAndInviter(ctx.querier, { withSession: false, withInviter: true });
    await expect(
      ctx.querier.query(
        `INSERT INTO session_invites
           (session_id, inviter_id, token_hash, join_mode, expires_at)
         VALUES ($1, $2, $3, 'viewer', now() + interval '7 days')`,
        [SESSION_ID, INVITER_ID, uniqueTokenHash("t5-no-session")],
      ),
    ).rejects.toThrow(/foreign key|23503/i);
  });

  it("rejects an INSERT whose inviter_id has no matching participants(id) row (FK violation)", async () => {
    // Mirror of the previous test, swapping which FK side is missing.
    await seedSessionAndInviter(ctx.querier, { withSession: true, withInviter: false });
    await expect(
      ctx.querier.query(
        `INSERT INTO session_invites
           (session_id, inviter_id, token_hash, join_mode, expires_at)
         VALUES ($1, $2, $3, 'viewer', now() + interval '7 days')`,
        [SESSION_ID, INVITER_ID, uniqueTokenHash("t5-no-inviter")],
      ),
    ).rejects.toThrow(/foreign key|23503/i);
  });
});

// ----------------------------------------------------------------------------
// T6 — I-002-3 verified by omission (no presence-state table)
// ----------------------------------------------------------------------------

describe("0002-session-invites migration (T6 — I-002-3 ephemeral-presence by omission)", () => {
  it("creates no '%presence%' table in the public schema after applying v1 + v2", async () => {
    // Plan-002 §Invariants I-002-3: presence state MUST live in memory only.
    // Spec-002 §State And Data Implications line 157: presence data is never
    // written to SQLite or Postgres. The broader regression (P10 in Plan-002
    // §Test Plan) lives in T2.5's `migration-shape.test.ts` and surveys the
    // entire schema; this local guard defends the boundary that THIS
    // migration didn't accidentally introduce presence storage. A regression
    // that added a `session_presence` / `participant_presence` / `presence_*`
    // table here would surface as a non-empty result row.
    //
    // ILIKE (not LIKE) defends against a case regression
    // (`SESSION_PRESENCE` would slip past LIKE '%presence%').
    await applySessionInvitesMigration(ctx.querier);
    const probe = await ctx.querier.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name ILIKE '%presence%'`,
    );
    expect(probe.rows).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// T7 — applyMigrations idempotency after v2 is applied
// ----------------------------------------------------------------------------

describe("0002-session-invites migration (T7 — applyMigrations idempotency post-v2)", () => {
  it("re-calling applyMigrations after v2 is applied is a no-op (no throw, no duplicate rows)", async () => {
    // `applyMigrations` (`sessions/migration-runner.ts`) is hardcoded to
    // probe v1 only — its outer probe short-circuits as soon as the v1
    // anchor row exists. After v2 is applied via direct tx.exec, a second
    // `applyMigrations` call MUST NOT throw and MUST NOT perturb the v2
    // anchor row. A regression that lost the outer-probe short-circuit
    // would surface here as either a re-run of v1's DDL (`42P07 relation
    // already exists`) or a duplicate-row insert into `schema_migrations`
    // (PK violation on `version`).
    await applySessionInvitesMigration(ctx.querier);

    // Second call — must be a no-op.
    await expect(applyMigrations(ctx.querier)).resolves.toBeUndefined();

    // Row counts unchanged: exactly one (1, ...) row and exactly one (2,
    // 'session_invites table') row.
    const counts = await ctx.querier.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM schema_migrations",
    );
    const countsRow = counts.rows[0];
    expect(countsRow).toBeDefined();
    if (countsRow === undefined) return;
    expect(Number.parseInt(countsRow.count, 10)).toBe(2);

    const v2Probe = await ctx.querier.query<{ description: string }>(
      "SELECT description FROM schema_migrations WHERE version = $1",
      [2],
    );
    expect(v2Probe.rows).toHaveLength(1);
    const v2Row = v2Probe.rows[0];
    expect(v2Row).toBeDefined();
    if (v2Row === undefined) return;
    expect(v2Row.description).toBe("session_invites table");
  });
});
