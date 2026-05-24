// P6/P7 — MembershipService invariant gates (Plan-002 Phase 2, T2.3).
//
// P6 (I-002-1, Spec-002 §Required Behavior line 49, AC3): a NON-OWNER caller
//     issuing `MembershipUpdate{action: "change_role", newRole: "owner"}`
//     throws the typed `membership.permission_denied` error AND leaves
//     `session_memberships` unchanged. Owner elevation must be issued by an
//     existing owner; a non-owner cannot self-elevate.
//
// P7 (I-002-2, Spec-002 §Required Behavior line 50): the SOLE owner attempting
//     a self-leave (self-targeted `revoke` / `suspend`) throws the typed
//     `membership.last_owner` error AND the owner row remains unchanged. A
//     session must never reach zero active owners via a MembershipUpdate.
//
// Scope: this file ships P6 and P7 (the I-002-1 / I-002-2 invariant tests,
// T2.3's `verifies_invariant`), plus ONE owner-only-default denial smoke test
// for the non-self-leave permission branch this task introduces
// (membership-service.ts §4 `else if` — a non-owner attempting `suspend` /
// `revoke` / `reactivate` of ANOTHER member). The full P1-P10 completeness
// sweep — including the happy-path change_role/suspend/revoke/reactivate
// transitions, the reactivate state transitions, and the P10 migration-shape
// regression — remains T2.5; it is NOT pre-empted here.
//
// Harness: the PGlite-in-memory pattern from
// `sessions/__tests__/session-directory-service.test.ts` — a fresh ephemeral
// PGlite instance per test, `applyMigrations` for schema bootstrap, seeding
// via direct INSERTs, then exercising the service. Each invariant test
// asserts BOTH the thrown error code AND the no-mutation property by
// re-SELECTing the affected row(s).

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MembershipId, MembershipUpdate, ParticipantId } from "@ai-sidekicks/contracts";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import {
  MembershipService,
  MembershipLastOwnerException,
  MembershipPermissionDeniedException,
  MEMBERSHIP_LAST_OWNER_CODE,
  MEMBERSHIP_PERMISSION_DENIED_CODE,
} from "../membership-service.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped ids (the brand validators accept any RFC 9562
// UUID; real generation is daemon-side).
// ----------------------------------------------------------------------------

const SESSION_ID = "01970000-0000-7000-8000-0000000c0001";
const OWNER_PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-0000000d0001" as ParticipantId;
const NON_OWNER_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-0000000d0002" as ParticipantId;
const SECOND_NON_OWNER_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-0000000d0003" as ParticipantId;

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (mirrors session-directory-service.test.ts `wrap`)
// ----------------------------------------------------------------------------
//
// PGlite#query expects `params` as `any[]` (mutable); the `Querier` interface
// uses `ReadonlyArray<unknown>`. The spread copy decouples the mutability
// claim without copying values. `transaction(fn)` wraps `pg.transaction(fn)`
// and re-wraps the inner `tx` as a `Querier` so in-transaction code uses the
// same surface; nested `tx.transaction(...)` throws (Postgres has no native
// nested transactions without SAVEPOINTs).

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
// Seed helpers
// ----------------------------------------------------------------------------

// Insert a participant + a session + a membership row, returning the generated
// membership id. The membership `id` is gen_random_uuid()-assigned by the
// schema default, so we read it back from RETURNING — that id is what a
// `MembershipUpdate.membershipId` references (the union carries no sessionId).
async function seedParticipant(querier: Querier, participantId: ParticipantId): Promise<void> {
  await querier.query("INSERT INTO participants (id) VALUES ($1)", [participantId]);
}

async function seedSession(querier: Querier, sessionId: string): Promise<void> {
  await querier.query("INSERT INTO sessions (id, state) VALUES ($1, 'active')", [sessionId]);
}

async function seedMembership(
  querier: Querier,
  args: {
    sessionId: string;
    participantId: ParticipantId;
    role: string;
    state: string;
  },
): Promise<MembershipId> {
  const inserted = await querier.query<{ id: string }>(
    `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
     VALUES ($1, $2, $3, $4, now())
     RETURNING id`,
    [args.sessionId, args.participantId, args.role, args.state],
  );
  const row: { id: string } | undefined = inserted.rows[0];
  if (row === undefined) {
    throw new Error("seedMembership: INSERT returned no row");
  }
  return row.id as MembershipId;
}

// Re-read a membership row's mutable columns for the no-mutation assertions.
async function readMembershipRow(
  querier: Querier,
  membershipId: MembershipId,
): Promise<{ role: string; state: string; updated_at: string } | undefined> {
  const probe = await querier.query<{ role: string; state: string; updated_at: string }>(
    "SELECT role, state, updated_at::text AS updated_at FROM session_memberships WHERE id = $1",
    [membershipId],
  );
  return probe.rows[0];
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
  service: MembershipService;
}

let ctx: TestContext;

beforeEach(async () => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);
  ctx = {
    pg,
    querier,
    service: new MembershipService(querier),
  };
});

afterEach(async () => {
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// P6 — I-002-1: non-owner cannot self-elevate to owner
// ----------------------------------------------------------------------------

describe("MembershipService — P6 (I-002-1: owner elevation requires an existing owner)", () => {
  it("a non-owner change_role->owner throws membership.permission_denied and does not mutate the row", async () => {
    // Seed: a session with one owner + one non-owner (collaborator). The
    // non-owner is BOTH the actor AND the target — i.e. an attempt to
    // self-elevate, which I-002-1 forbids (a non-owner cannot promote
    // anyone, least of all itself, to owner).
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, NON_OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });
    const nonOwnerMembershipId: MembershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: NON_OWNER_PARTICIPANT_ID,
      role: "collaborator",
      state: "active",
    });

    const before = await readMembershipRow(ctx.querier, nonOwnerMembershipId);
    expect(before).toBeDefined();
    if (before === undefined) return;

    // The non-owner attempts to elevate ITSELF to owner. I-002-1: a non-owner
    // cannot self-elevate. MUST throw the typed permission error.
    const selfElevation: MembershipUpdate = {
      membershipId: nonOwnerMembershipId,
      action: "change_role",
      newRole: "owner",
    };

    // Capture the single rejection once, then assert both the class and the
    // typed `code` literal against it (the transport layer lifts `code` onto
    // the wire envelope). One invocation avoids re-running the guard path.
    const error = await ctx.service
      .updateMembership(NON_OWNER_PARTICIPANT_ID, selfElevation)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MembershipPermissionDeniedException);
    expect(error).toMatchObject({ code: MEMBERSHIP_PERMISSION_DENIED_CODE });

    // No-mutation property (I-002-1 verification): the non-owner's row is
    // byte-for-byte unchanged — role still 'collaborator', state still
    // 'active', updated_at untouched. A regression that mutated before the
    // guard fired (or skipped the guard) would surface here.
    const afterTarget = await readMembershipRow(ctx.querier, nonOwnerMembershipId);
    expect(afterTarget).toBeDefined();
    if (afterTarget === undefined) return;
    expect(afterTarget.role).toBe("collaborator");
    expect(afterTarget.state).toBe("active");
    expect(afterTarget.updated_at).toBe(before.updated_at);

    // Defense in depth: exactly one owner exists for the session, and it is
    // the original owner participant — the failed elevation minted no second
    // owner.
    const ownerRows = await ctx.querier.query<{ participant_id: string }>(
      `SELECT participant_id FROM session_memberships
        WHERE session_id = $1 AND role = 'owner'`,
      [SESSION_ID],
    );
    expect(ownerRows.rows).toHaveLength(1);
    const ownerRow = ownerRows.rows[0];
    expect(ownerRow).toBeDefined();
    if (ownerRow === undefined) return;
    expect(ownerRow.participant_id).toBe(OWNER_PARTICIPANT_ID);
  });
});

// ----------------------------------------------------------------------------
// P7 — I-002-2: last owner cannot leave
// ----------------------------------------------------------------------------

describe("MembershipService — P7 (I-002-2: last-owner-cannot-leave)", () => {
  it("the sole owner self-revoke throws membership.last_owner and leaves the owner row unchanged", async () => {
    // Seed: a session with EXACTLY ONE owner (no other owners). The owner
    // attempts to leave via a self-targeted `revoke`. I-002-2: the sole
    // remaining active owner cannot leave — the session would become
    // unrecoverable (zero owners). MUST throw the typed last-owner error.
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    const ownerMembershipId: MembershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const before = await readMembershipRow(ctx.querier, ownerMembershipId);
    expect(before).toBeDefined();
    if (before === undefined) return;
    expect(before.role).toBe("owner");
    expect(before.state).toBe("active");

    const selfRevoke: MembershipUpdate = {
      membershipId: ownerMembershipId,
      action: "revoke",
    };

    const error = await ctx.service
      .updateMembership(OWNER_PARTICIPANT_ID, selfRevoke)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MembershipLastOwnerException);
    expect(error).toMatchObject({ code: MEMBERSHIP_LAST_OWNER_CODE });

    // No-mutation property (I-002-2 verification): the owner row remains in
    // `session_memberships` unchanged — role 'owner', state 'active',
    // updated_at untouched. A regression that revoked before the guard fired
    // would surface here as state = 'revoked'.
    const afterRow = await readMembershipRow(ctx.querier, ownerMembershipId);
    expect(afterRow).toBeDefined();
    if (afterRow === undefined) return;
    expect(afterRow.role).toBe("owner");
    expect(afterRow.state).toBe("active");
    expect(afterRow.updated_at).toBe(before.updated_at);
  });

  it("the sole owner self-suspend also throws membership.last_owner (guard fires on any leave action)", async () => {
    // I-002-2's load-bearing property is "a session never reaches zero active
    // owners via a MembershipUpdate" — so `suspend` of the sole active owner
    // is guarded identically to `revoke` (a suspended owner is no longer an
    // active owner, leaving the session ownerless). This parallel assertion
    // pins that the guard is keyed on "removes the sole owner's active
    // status", not on the `revoke` action alone.
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    const ownerMembershipId: MembershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const before = await readMembershipRow(ctx.querier, ownerMembershipId);
    expect(before).toBeDefined();
    if (before === undefined) return;

    const selfSuspend: MembershipUpdate = {
      membershipId: ownerMembershipId,
      action: "suspend",
    };

    const error = await ctx.service
      .updateMembership(OWNER_PARTICIPANT_ID, selfSuspend)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MembershipLastOwnerException);
    expect(error).toMatchObject({ code: MEMBERSHIP_LAST_OWNER_CODE });

    // Row unchanged (role/state, AND updated_at parity matching the
    // self-revoke twin above).
    const afterRow = await readMembershipRow(ctx.querier, ownerMembershipId);
    expect(afterRow).toBeDefined();
    if (afterRow === undefined) return;
    expect(afterRow.role).toBe("owner");
    expect(afterRow.state).toBe("active");
    expect(afterRow.updated_at).toBe(before.updated_at);
  });
});

// ----------------------------------------------------------------------------
// Owner-only-default denial — smoke test for the §4 non-self-leave branch
// ----------------------------------------------------------------------------
//
// Covers the permission-gate `else if` branch T2.3 introduces
// (membership-service.ts §4): a non-owner attempting to apply a NON-self-leave
// action to ANOTHER member's row is denied. The matrix scopes `Suspend/revoke
// member` to `owner` only (security-architecture.md §Permission Matrix line
// 301), so a `collaborator` issuing `revoke` against a peer is rejected before
// any mutation. This is a single denial smoke test; the full happy-path /
// transition sweep stays in T2.5.

describe("MembershipService — owner-only-default (non-owner cannot revoke another member)", () => {
  it("a non-owner revoke of another member throws membership.permission_denied and does not mutate the target", async () => {
    // Seed: one owner + two non-owners (collaborators). The actor is the first
    // non-owner; the target is the SECOND non-owner — neither party is an
    // owner, so the §4 owner-only gate (not the I-002-1 elevation gate or the
    // I-002-2 last-owner gate) is the one under test.
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, NON_OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, SECOND_NON_OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: NON_OWNER_PARTICIPANT_ID,
      role: "collaborator",
      state: "active",
    });
    const targetMembershipId: MembershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: SECOND_NON_OWNER_PARTICIPANT_ID,
      role: "collaborator",
      state: "active",
    });

    const before = await readMembershipRow(ctx.querier, targetMembershipId);
    expect(before).toBeDefined();
    if (before === undefined) return;

    // A non-owner (NON_OWNER_PARTICIPANT_ID) attempts to revoke a DIFFERENT
    // member — not a self-leave, so the owner-only-default gate must deny it.
    const revokeAnother: MembershipUpdate = {
      membershipId: targetMembershipId,
      action: "revoke",
    };

    const error = await ctx.service
      .updateMembership(NON_OWNER_PARTICIPANT_ID, revokeAnother)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MembershipPermissionDeniedException);
    expect(error).toMatchObject({ code: MEMBERSHIP_PERMISSION_DENIED_CODE });

    // No-mutation property: the target row is unchanged — role still
    // 'collaborator', state still 'active', updated_at untouched.
    const afterRow = await readMembershipRow(ctx.querier, targetMembershipId);
    expect(afterRow).toBeDefined();
    if (afterRow === undefined) return;
    expect(afterRow.role).toBe("collaborator");
    expect(afterRow.state).toBe("active");
    expect(afterRow.updated_at).toBe(before.updated_at);
  });
});
