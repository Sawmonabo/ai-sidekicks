// P9 — lock-ordering regression for the Plan-002 transactional callers (T2.4).
//
// I-002-4 (Plan-002 §Invariants, inheriting Plan-001 I-001-1): any transaction
// that mutates `session_memberships` while validating `sessions` MUST acquire
// row locks in the canonical order `sessions` -> `session_memberships`. The
// load-bearing manifestation is the explicit `SELECT id FROM sessions WHERE
// id = $1 FOR UPDATE` on the parent session row, acquired BEFORE any
// lock-acquiring `session_memberships` statement. Plan-001 Phase 4/5 pinned
// this for `createSession` (the canonical lock-ordering test in
// `sessions/__tests__/session-directory-service.test.ts`, "createSession
// acquires SELECT FOR UPDATE on the sessions row before the owner probe").
// Plan-002 adds two new transactional callers under I-002-4 — this file
// extends the same logging-proxy technique to BOTH:
//   (A) `InviteService.acceptInvite`     — the invite-accept caller.
//   (B) `MembershipService.updateMembership` — the owner-transfer /
//       co-owner-promotion caller (every `MembershipUpdate` action shares the
//       same unconditional step-2 FOR UPDATE).
//
// Technique (replicated from the Plan-001 canonical test, see `wrapWithLog` /
// `CapturedQuery` below): wrap the test `Querier` in a logging proxy that
// captures every SQL statement issued — including statements inside
// `transaction(fn)` callbacks, because the proxy recursively re-wraps the
// in-tx `tx` and tags it with a tx-scoped `querierId`. A `FOR UPDATE` issued
// inside the transaction therefore appears in the capture stream with a
// `querierId` distinct from the outer `"outer"`, letting the assertions pin
// BOTH the ordering (sessions lock < membership mutation) AND that the lock
// ran through the in-tx Querier (so under `pg.Pool` it grips the held client,
// not a side-checked-out connection).
//
// Harness: the in-process PGlite pattern shared by
// `invites/__tests__/invite-service.test.ts` (the crypto-paseto `KeyRing`
// setup for block A) and `memberships/__tests__/membership-service.test.ts`
// (the direct-INSERT seeding for block B) — a fresh ephemeral PGlite per test,
// `applyMigrations` for schema bootstrap (migrations 0001 + 0002).
//
// Refs: Plan-002 §Invariants I-002-4, Plan-001 §Invariants I-001-1, Spec-002
// §Test Plan P9.

import { randomBytes as nodeRandomBytes } from "node:crypto";

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  JoinMode,
  MembershipId,
  MembershipUpdate,
  ParticipantId,
  SessionId,
} from "@ai-sidekicks/contracts";
import { KeyRing, type KeyRingEntry } from "@ai-sidekicks/crypto-paseto";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import { InviteService } from "../../invites/invite-service.js";
import { MembershipService } from "../membership-service.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped ids (the brand validators accept any RFC 9562
// UUID; real generation is daemon-side).
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-00000009a001" as SessionId;
const OWNER_PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-00000009b001" as ParticipantId;
const INVITEE_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-00000009b002" as ParticipantId;
const COLLABORATOR_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-00000009b003" as ParticipantId;

const DEFAULT_JOIN_MODE: JoinMode = "collaborator";

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
// Logging-proxy adapter — replicated from the Plan-001 canonical lock-ordering
// test (`sessions/__tests__/session-directory-service.test.ts`, the
// `wrapWithLog` / `CapturedQuery` helpers, Codex R4 / Plan-001 T5.6). The DAG
// scopes T2.4 to this new file only, so the helper is replicated locally
// rather than extracted to a shared util (extraction would touch the Plan-001
// test, out of scope).
// ----------------------------------------------------------------------------
//
// `wrapWithLog` returns a `Querier` that captures every SQL statement issued —
// including statements inside `transaction(...)` callbacks. The recursive
// composition (the `tx` passed to the user callback is itself a logging proxy)
// is load-bearing: without it the captured array would only see outer-Querier
// statements and miss every in-transaction statement, including the
// `SELECT ... FOR UPDATE` whose position we assert. Each entry is tagged with a
// `querierId` so callers can discriminate WHICH Querier issued each statement
// (outer vs in-tx); the `transaction(fn)` impl re-wraps the inner `tx` with a
// fresh tx-scoped id (`${querierId}.tx-${n}`), guaranteed distinct from the
// outer id. Under `pg.Pool` that distinction is load-bearing: the outer
// Querier checks out a one-shot connection per call, whereas the transaction
// Querier holds ONE client across BEGIN / statements / COMMIT — a `FOR UPDATE`
// routed through the outer Querier would lock a row on the wrong connection.
//
// `exec` is forwarded without capture (no assertion reads the exec stream; the
// migration runner is the only `exec()` caller), mirroring the Plan-001 origin.
interface CapturedQuery {
  readonly querierId: string;
  readonly sql: string;
}

let txCounter = 0;

function wrapWithLog(inner: Querier, captured: CapturedQuery[], querierId: string): Querier {
  return {
    query: async <T>(
      sql: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: ReadonlyArray<T> }> => {
      captured.push({ querierId, sql });
      return inner.query<T>(sql, params);
    },
    exec: async (sql: string): Promise<void> => {
      await inner.exec(sql);
    },
    transaction: async <T>(fn: (tx: Querier) => Promise<T>): Promise<T> => {
      const txId = `${querierId}.tx-${++txCounter}`;
      return inner.transaction((tx) => fn(wrapWithLog(tx, captured, txId)));
    },
  };
}

// ----------------------------------------------------------------------------
// Whitespace-tolerant SQL fragment matchers — the load-bearing statements.
// ----------------------------------------------------------------------------
//
// The sessions row lock is the canonical-order anchor common to BOTH callers.
// The two membership matchers are deliberately NARROW:
//   * `MEMBERSHIP_UPSERT` matches ONLY `INSERT INTO session_memberships` (the
//     accept caller's lock-acquiring write).
//   * `MEMBERSHIP_MUTATE` matches ONLY `UPDATE session_memberships` (the
//     updateMembership caller's lock-acquiring write).
// Neither matches a plain `SELECT ... FROM session_memberships`. This is
// load-bearing for block B: `updateMembership` issues a PRE-lock plain
// `SELECT session_id FROM session_memberships WHERE id = $1` (step 1) that
// acquires NO row lock under READ COMMITTED and is therefore I-002-4-COMPLIANT.
// A broader `/session_memberships/` or `/FROM\s+session_memberships/` matcher
// would substring-match that legitimate step-1 probe and falsely invert the
// ordering assertion. The `\b` after each table name is defensive against a
// hypothetical `session_memberships_history`-style suffix.
const SESSIONS_ROW_LOCK = /FROM\s+sessions\s+WHERE\s+id\s*=\s*\$1\s+FOR\s+UPDATE/i;
const MEMBERSHIP_UPSERT = /INSERT\s+INTO\s+session_memberships\b/i;
const MEMBERSHIP_MUTATE = /UPDATE\s+session_memberships\b/i;
// `createInvite`'s authorization step reads membership rather than writing it:
// its load-bearing `session_memberships` touch is the active-owner PROBE
// `SELECT role, state FROM session_memberships WHERE session_id = $1 AND
// participant_id = $2`. Block C asserts the sessions FOR UPDATE precedes THIS
// probe (session-before-ownership-read, I-002-4), so the matcher is pinned to
// the `role, state` projection — narrow enough NOT to collide with
// `updateMembership`'s pre-lock `SELECT session_id FROM session_memberships`
// step-1 probe (block B's carve-out) or with any INSERT/UPDATE above.
const MEMBERSHIP_OWNER_PROBE = /SELECT\s+role,\s*state\s+FROM\s+session_memberships\b/i;

// ----------------------------------------------------------------------------
// Seed helpers (mirror invite-service.test.ts / membership-service.test.ts).
// ----------------------------------------------------------------------------

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

// Future timestamp for a non-expired invite (the accept path validates the
// `expires_at` CLAIM, so it must be in the future). ISO 8601 with offset,
// matching the contract wire form.
function isoOffset(deltaMs: number): string {
  return new Date(Date.now() + deltaMs).toISOString();
}

// ----------------------------------------------------------------------------
// Per-test database lifecycle
// ----------------------------------------------------------------------------

interface TestContext {
  pg: PGlite;
  querier: Querier;
  keyRing: KeyRing;
}

let ctx: TestContext;

beforeEach(async () => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);

  // One active 32-byte key for the InviteService block (block A) — mirrors
  // invite-service.test.ts so the accept path decrypts under the key the
  // token was minted with.
  const activeEntry: KeyRingEntry = {
    id: "k_test_active",
    key: new Uint8Array(nodeRandomBytes(32)),
    createdAt: new Date(),
    retiredAt: undefined,
  };
  const keyRing: KeyRing = new KeyRing([activeEntry]);

  ctx = { pg, querier, keyRing };
});

afterEach(async () => {
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// (A) InviteService.acceptInvite — invite-accept caller (I-002-4).
// ----------------------------------------------------------------------------

describe("InviteService.acceptInvite — lock-ordering (P9, I-002-4)", () => {
  it("acquires the sessions row lock before the session_memberships upsert, through the in-tx Querier", async () => {
    // Seed the parent session + an owner so the accept upsert lands a real
    // active membership for the invitee.
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    // Single InviteService over the logging proxy. We mint a real invite via
    // `createInvite` FIRST (so `acceptInvite` resolves the row by token hash),
    // then ISOLATE the captured stream to the acceptInvite call by clearing
    // the `captured` array — otherwise createInvite's own transaction (its
    // `INSERT INTO session_invites`) would pollute the assertions. The token
    // is the plaintext value createInvite returns exactly once.
    const OUTER_ID = "outer";
    const captured: CapturedQuery[] = [];
    const loggingQuerier: Querier = wrapWithLog(ctx.querier, captured, OUTER_ID);
    const service = new InviteService(loggingQuerier, ctx.keyRing);

    const created = await service.createInvite(OWNER_PARTICIPANT_ID, {
      sessionId: SESSION_ID,
      inviter: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    // Isolate: discard every statement issued so far (the createInvite
    // transaction). Only acceptInvite's statements are asserted below.
    captured.length = 0;

    await service.acceptInvite(INVITEE_PARTICIPANT_ID, { token: created.token });

    // The two load-bearing statements inside acceptInvite's transaction:
    //   1. sessions row lock — `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`
    //   2. membership upsert — `INSERT INTO session_memberships ... ON CONFLICT`
    const sessionsLockIdx = captured.findIndex((entry) => SESSIONS_ROW_LOCK.test(entry.sql));
    const membershipUpsertIdx = captured.findIndex((entry) => MEMBERSHIP_UPSERT.test(entry.sql));

    // Both MUST be present (presence pins that the lock was actually issued).
    expect(sessionsLockIdx).toBeGreaterThanOrEqual(0);
    expect(membershipUpsertIdx).toBeGreaterThanOrEqual(0);

    // Canonical order (I-002-4): the sessions row lock precedes the
    // lock-acquiring `session_memberships` write.
    expect(sessionsLockIdx).toBeLessThan(membershipUpsertIdx);

    // Exactly one FOR UPDATE — guards against a regression that lifts the lock
    // to the outer Querier (wrong connection under pg.Pool) or issues it twice.
    const forUpdateCount = captured.filter((entry) => SESSIONS_ROW_LOCK.test(entry.sql)).length;
    expect(forUpdateCount).toBe(1);

    // Both statements ran through the in-tx Querier (NOT the outer `"outer"`),
    // so under pg.Pool the lock grips the transaction's held client across the
    // same commit boundary as the membership write — the load-bearing property
    // (Plan-001 T5.6). The tx-scoped id matches `outer.tx-<n>`.
    const sessionsLockEntry = captured[sessionsLockIdx];
    const membershipUpsertEntry = captured[membershipUpsertIdx];
    expect(sessionsLockEntry).toBeDefined();
    expect(membershipUpsertEntry).toBeDefined();
    if (sessionsLockEntry === undefined || membershipUpsertEntry === undefined) {
      return;
    }
    expect(sessionsLockEntry.querierId).not.toBe(OUTER_ID);
    expect(sessionsLockEntry.querierId).toMatch(/^outer\.tx-\d+$/);
    expect(membershipUpsertEntry.querierId).not.toBe(OUTER_ID);
    // Both come from the SAME in-tx Querier — acceptInvite opens one
    // transaction, so emission across two tx-scoped ids would mean a sibling /
    // nested transaction broke the single-COMMIT atomicity asserted elsewhere.
    expect(membershipUpsertEntry.querierId).toBe(sessionsLockEntry.querierId);
  });
});

// ----------------------------------------------------------------------------
// (B) MembershipService.updateMembership — owner-transfer / co-owner-promotion
// caller (I-002-4).
// ----------------------------------------------------------------------------

describe("MembershipService.updateMembership — lock-ordering (P9, I-002-4)", () => {
  it("acquires the sessions row lock before the lock-acquiring session_memberships UPDATE (not the pre-lock plain SELECT)", async () => {
    // Seed: one active owner (the actor) + one active collaborator (the
    // target). A `change_role` on the NON-owner collaborator exercises the
    // owner-transfer / co-owner-promotion caller path WITHOUT tripping the
    // I-002-2 last-owner guard (the target is not the sole owner). The step-2
    // FOR UPDATE is unconditional, so this one call pins the canonical order.
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, COLLABORATOR_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });
    const collaboratorMembershipId: MembershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: COLLABORATOR_PARTICIPANT_ID,
      role: "collaborator",
      state: "active",
    });

    const OUTER_ID = "outer";
    const captured: CapturedQuery[] = [];
    const loggingQuerier: Querier = wrapWithLog(ctx.querier, captured, OUTER_ID);
    const service = new MembershipService(loggingQuerier);

    // Owner actor changes the collaborator's role (owner-only-default permits
    // it; not a last-owner case). The mutation is `UPDATE session_memberships
    // ... SET role = $2`.
    const changeRole: MembershipUpdate = {
      membershipId: collaboratorMembershipId,
      action: "change_role",
      newRole: "viewer",
    };
    await service.updateMembership(OWNER_PARTICIPANT_ID, changeRole);

    // The load-bearing statements inside updateMembership's transaction:
    //   step 2: sessions row lock  — `SELECT id FROM sessions ... FOR UPDATE`
    //   step 6: membership mutate  — `UPDATE session_memberships ... SET role`
    //
    // CRITICAL — I-002-4 governs ROW-LOCK acquisition order. `updateMembership`
    // issues a PRE-lock PLAIN `SELECT session_id FROM session_memberships
    // WHERE id = $1` (step 1) BEFORE the FOR UPDATE; a plain SELECT acquires NO
    // row lock under READ COMMITTED, so that step-1 probe is I-002-4-COMPLIANT
    // and MUST NOT be flagged. We therefore assert the FOR UPDATE precedes the
    // LOCK-ACQUIRING `UPDATE session_memberships` mutation — NOT "any
    // session_memberships statement". `MEMBERSHIP_MUTATE` matches the UPDATE
    // only, so the legitimate step-1 plain SELECT is correctly ignored.
    const sessionsLockIdx = captured.findIndex((entry) => SESSIONS_ROW_LOCK.test(entry.sql));
    const membershipMutateIdx = captured.findIndex((entry) => MEMBERSHIP_MUTATE.test(entry.sql));

    expect(sessionsLockIdx).toBeGreaterThanOrEqual(0);
    expect(membershipMutateIdx).toBeGreaterThanOrEqual(0);

    // Canonical order (I-002-4): sessions row lock precedes the membership
    // mutation. The pre-lock plain SELECT (step 1) is intentionally NOT part
    // of this comparison — it acquires no row lock.
    expect(sessionsLockIdx).toBeLessThan(membershipMutateIdx);

    const forUpdateCount = captured.filter((entry) => SESSIONS_ROW_LOCK.test(entry.sql)).length;
    expect(forUpdateCount).toBe(1);

    const sessionsLockEntry = captured[sessionsLockIdx];
    const membershipMutateEntry = captured[membershipMutateIdx];
    expect(sessionsLockEntry).toBeDefined();
    expect(membershipMutateEntry).toBeDefined();
    if (sessionsLockEntry === undefined || membershipMutateEntry === undefined) {
      return;
    }
    expect(sessionsLockEntry.querierId).not.toBe(OUTER_ID);
    expect(sessionsLockEntry.querierId).toMatch(/^outer\.tx-\d+$/);
    expect(membershipMutateEntry.querierId).not.toBe(OUTER_ID);
    expect(membershipMutateEntry.querierId).toBe(sessionsLockEntry.querierId);
  });

  it("holds the same sessions -> session_memberships order for a suspend action (the FOR UPDATE is unconditional)", async () => {
    // A second action variant pinning that the canonical order does not depend
    // on the action: `suspend` of a non-owner collaborator. The lock sequence
    // (step-2 FOR UPDATE before step-6 UPDATE) is identical because the FOR
    // UPDATE is unconditional. This also documents that the pre-lock plain
    // SELECT remains a plain (unlocked) read regardless of action.
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, COLLABORATOR_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });
    const collaboratorMembershipId: MembershipId = await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: COLLABORATOR_PARTICIPANT_ID,
      role: "collaborator",
      state: "active",
    });

    const OUTER_ID = "outer";
    const captured: CapturedQuery[] = [];
    const loggingQuerier: Querier = wrapWithLog(ctx.querier, captured, OUTER_ID);
    const service = new MembershipService(loggingQuerier);

    const suspend: MembershipUpdate = {
      membershipId: collaboratorMembershipId,
      action: "suspend",
    };
    await service.updateMembership(OWNER_PARTICIPANT_ID, suspend);

    const sessionsLockIdx = captured.findIndex((entry) => SESSIONS_ROW_LOCK.test(entry.sql));
    const membershipMutateIdx = captured.findIndex((entry) => MEMBERSHIP_MUTATE.test(entry.sql));

    expect(sessionsLockIdx).toBeGreaterThanOrEqual(0);
    expect(membershipMutateIdx).toBeGreaterThanOrEqual(0);
    expect(sessionsLockIdx).toBeLessThan(membershipMutateIdx);

    const forUpdateCount = captured.filter((entry) => SESSIONS_ROW_LOCK.test(entry.sql)).length;
    expect(forUpdateCount).toBe(1);

    const sessionsLockEntry = captured[sessionsLockIdx];
    const membershipMutateEntry = captured[membershipMutateIdx];
    expect(sessionsLockEntry).toBeDefined();
    expect(membershipMutateEntry).toBeDefined();
    if (sessionsLockEntry === undefined || membershipMutateEntry === undefined) {
      return;
    }
    expect(sessionsLockEntry.querierId).not.toBe(OUTER_ID);
    expect(sessionsLockEntry.querierId).toMatch(/^outer\.tx-\d+$/);
    expect(membershipMutateEntry.querierId).not.toBe(OUTER_ID);
    expect(membershipMutateEntry.querierId).toBe(sessionsLockEntry.querierId);
  });
});

// ----------------------------------------------------------------------------
// (C) InviteService.createInvite — issuance caller (I-002-4).
// ----------------------------------------------------------------------------
//
// The owner-only issuance gate (security-architecture.md §Permission Matrix,
// `Spec-002 §Invite Revocation`) reads `session_memberships` to authorize the
// actor INSIDE the issuance transaction. That read must run UNDER the parent
// session lock so a concurrent ownership change cannot race the gate (the same
// TOCTOU the accept/revoke paths close). Unlike block A (where createInvite is
// only setup and its statements are discarded), this block exercises
// createInvite as the SUBJECT and asserts the sessions FOR UPDATE precedes the
// active-owner PROBE — pinning createInvite's own session-before-ownership-read
// order. Its own capture buffer + service instance keep it isolated from
// block A's `forUpdateCount` assertion.

describe("InviteService.createInvite — lock-ordering (P9, I-002-4)", () => {
  it("acquires the sessions row lock before the active-owner session_memberships probe, through the in-tx Querier", async () => {
    // Seed the parent session + an active OWNER so the issuance gate admits the
    // call (the actor IS that owner, and names themselves as inviter).
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const OUTER_ID = "outer";
    const captured: CapturedQuery[] = [];
    const loggingQuerier: Querier = wrapWithLog(ctx.querier, captured, OUTER_ID);
    const service = new InviteService(loggingQuerier, ctx.keyRing);

    await service.createInvite(OWNER_PARTICIPANT_ID, {
      sessionId: SESSION_ID,
      inviter: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    // The two load-bearing statements inside createInvite's transaction:
    //   1. sessions row lock      — `SELECT id FROM sessions WHERE id = $1 FOR UPDATE`
    //   2. active-owner probe     — `SELECT role, state FROM session_memberships ...`
    // The probe is a READ (it authorizes the actor); I-002-4 requires it to run
    // under the session lock, so the FOR UPDATE must precede it.
    const sessionsLockIdx = captured.findIndex((entry) => SESSIONS_ROW_LOCK.test(entry.sql));
    const ownerProbeIdx = captured.findIndex((entry) => MEMBERSHIP_OWNER_PROBE.test(entry.sql));

    // Both MUST be present (presence pins that the lock was actually issued
    // before the gate read membership).
    expect(sessionsLockIdx).toBeGreaterThanOrEqual(0);
    expect(ownerProbeIdx).toBeGreaterThanOrEqual(0);

    // Canonical order (I-002-4): the sessions row lock precedes the
    // active-owner probe.
    expect(sessionsLockIdx).toBeLessThan(ownerProbeIdx);

    // Exactly one FOR UPDATE — guards against a regression that lifts the lock
    // to the outer Querier (wrong connection under pg.Pool) or issues it twice.
    // createInvite is the ONLY call here, so the single issuance lock is all
    // that should appear (no setup call to discard, unlike block A).
    const forUpdateCount = captured.filter((entry) => SESSIONS_ROW_LOCK.test(entry.sql)).length;
    expect(forUpdateCount).toBe(1);

    // Both statements ran through the in-tx Querier (NOT the outer `"outer"`),
    // so under pg.Pool the lock grips the transaction's held client across the
    // same commit boundary as the gate read + INSERT — the load-bearing
    // property (Plan-001 T5.6). The tx-scoped id matches `outer.tx-<n>`.
    const sessionsLockEntry = captured[sessionsLockIdx];
    const ownerProbeEntry = captured[ownerProbeIdx];
    expect(sessionsLockEntry).toBeDefined();
    expect(ownerProbeEntry).toBeDefined();
    if (sessionsLockEntry === undefined || ownerProbeEntry === undefined) {
      return;
    }
    expect(sessionsLockEntry.querierId).not.toBe(OUTER_ID);
    expect(sessionsLockEntry.querierId).toMatch(/^outer\.tx-\d+$/);
    expect(ownerProbeEntry.querierId).not.toBe(OUTER_ID);
    // Both come from the SAME in-tx Querier — createInvite opens one
    // transaction, so emission across two tx-scoped ids would mean a sibling /
    // nested transaction broke the single-COMMIT boundary.
    expect(ownerProbeEntry.querierId).toBe(sessionsLockEntry.querierId);
  });
});
