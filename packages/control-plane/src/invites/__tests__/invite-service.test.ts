// InviteService accept/revoke + hash-storage tests — Plan-002 Phase 2 (T2.2).
//
// Coverage (Plan-002 §Test Plan rows, mapped to the dispatched spec_coverage):
//   P1 (AC1, `Spec-002 §Interfaces And Contracts`): a valid accept transitions the invite
//      `pending -> accepted` AND creates an ACTIVE `session_memberships` row in
//      the same transaction.
//   P2 (`Spec-002 §Invite Revocation`): accepting a REVOKED invite throws
//      `invite.revoked` and creates / mutates NO membership row.
//   P3 (`Spec-002 §Token Security Properties`): an EXPIRED token throws `invite.expired`
//      regardless of the DB `state` (asserted against a still-`pending` row).
//   P4 (`Spec-002 §Token Security Properties`): a SECOND accept of the same token (same jti)
//      throws `invite.already_accepted`; the first accept already consumed it.
//   P5 (`Spec-002 §Token Security Properties`): the persisted `token_hash` equals
//      `SHA-256(token)` and the plaintext token appears in NO column. The
//      hash-storage test lands HERE per the audit (NOT in T2.1).
//   P8 (`Spec-002 §Invite Revocation`): a revoked invite can never be accepted, so a
//      revoked participant cannot re-join without a NEW invite — revoke then
//      accept the SAME token throws `invite.revoked`.
//   Owner-authorization (`Spec-002 §Invite Revocation`): a NON-owner revoke throws
//      `invite.permission_denied` and leaves the invite `state` unchanged; an
//      OWNER revoke transitions `state -> 'revoked'` (also exercises the
//      §Invite Revocation immediacy).
//
// Harness: the in-process PGlite pattern from
// `memberships/__tests__/membership-service.test.ts` — a fresh ephemeral
// PGlite per test, `applyMigrations` for schema bootstrap, direct-INSERT
// seeding, then exercising the service. A single in-test `KeyRing` (one random
// 32-byte active entry) is shared between the `InviteService` under test and
// the helper that mints tokens, so the service decrypts under the same active
// key it would in production.

import { randomBytes as nodeRandomBytes, createHash } from "node:crypto";

import { PGlite, type Transaction } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  InviteAccept,
  InviteId,
  InviteRevoke,
  JoinMode,
  ParticipantId,
  SessionId,
} from "@ai-sidekicks/contracts";
import { encryptV4Local, KeyRing, type KeyRingEntry } from "@ai-sidekicks/crypto-paseto";

import { applyMigrations, type Querier } from "../../sessions/migration-runner.js";
import {
  InviteService,
  InviteAlreadyAcceptedException,
  InviteExpiredException,
  InviteNotFoundException,
  InvitePermissionDeniedException,
  InviteRevokedException,
  INVITE_ALREADY_ACCEPTED_CODE,
  INVITE_EXPIRED_CODE,
  INVITE_NOT_FOUND_CODE,
  INVITE_PERMISSION_DENIED_CODE,
  INVITE_REVOKED_CODE,
} from "../invite-service.js";

// ----------------------------------------------------------------------------
// Test fixtures — UUID v7-shaped ids (the brand validators accept any RFC 9562
// UUID; real generation is daemon-side).
// ----------------------------------------------------------------------------

const SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0001" as SessionId;
// A SECOND session, for the cross-session revoke-filter test (the
// `WHERE id = $1 AND session_id = $2` predicate guard).
const OTHER_SESSION_ID: SessionId = "01970000-0000-7000-8000-0000000e0002" as SessionId;
const OWNER_PARTICIPANT_ID: ParticipantId = "01970000-0000-7000-8000-0000000f0001" as ParticipantId;
const INVITEE_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-0000000f0002" as ParticipantId;
const NON_OWNER_PARTICIPANT_ID: ParticipantId =
  "01970000-0000-7000-8000-0000000f0003" as ParticipantId;

const DEFAULT_JOIN_MODE: JoinMode = "collaborator";

// ----------------------------------------------------------------------------
// PGlite -> Querier adapter (mirrors membership-service.test.ts `wrap`)
// ----------------------------------------------------------------------------
//
// PGlite#query expects `params` as a mutable array; the `Querier` interface
// uses `ReadonlyArray<unknown>`. The spread copy decouples the mutability
// claim without copying values. `transaction(fn)` wraps `pg.transaction(fn)`
// and re-wraps the inner `tx` as a `Querier`; nested `tx.transaction(...)`
// throws (Postgres has no native nested transactions without SAVEPOINTs).

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
// Token minting — mirror createInvite's claim shape so the service decrypts
// the token to a valid invite payload.
// ----------------------------------------------------------------------------
//
// The claim payload is byte-for-byte the `{session_id, inviter_id, join_mode,
// expires_at, jti}` shape `InviteService.createInvite` encrypts
// (`Spec-002 §Token Security Properties`). The token is minted with the SAME `KeyRing` active key the
// service holds, then the row is seeded directly via INSERT carrying ONLY
// `SHA-256(token)` — matching the issuance write so the accept path's
// hash-lookup resolves. Seeding the row directly (rather than calling
// createInvite) lets each test pin the row's `state` / `expires_at`
// independently of issuance.

interface MintedInvite {
  token: string;
  tokenHash: string;
  jti: string;
}

function mintInviteToken(
  keyRing: KeyRing,
  args: { sessionId: string; inviterId: string; joinMode: JoinMode; expiresAt: string },
): MintedInvite {
  const jti: string = nodeRandomBytes(32).toString("base64url");
  const claims = {
    session_id: args.sessionId,
    inviter_id: args.inviterId,
    join_mode: args.joinMode,
    expires_at: args.expiresAt,
    jti,
  };
  const claimBytes: Uint8Array = new TextEncoder().encode(JSON.stringify(claims));
  const token: string = encryptV4Local(claimBytes, keyRing.active().key);
  const tokenHash: string = createHash("sha256").update(token).digest("hex");
  return { token, tokenHash, jti };
}

// ----------------------------------------------------------------------------
// Seed helpers
// ----------------------------------------------------------------------------

async function seedParticipant(querier: Querier, participantId: ParticipantId): Promise<void> {
  await querier.query("INSERT INTO participants (id) VALUES ($1)", [participantId]);
}

async function seedSession(querier: Querier, sessionId: string): Promise<void> {
  await querier.query("INSERT INTO sessions (id, state) VALUES ($1, 'active')", [sessionId]);
}

async function seedMembership(
  querier: Querier,
  args: { sessionId: string; participantId: ParticipantId; role: string; state: string },
): Promise<string> {
  const inserted = await querier.query<{ id: string }>(
    `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
     VALUES ($1, $2, $3, $4, now())
     RETURNING id`,
    [args.sessionId, args.participantId, args.role, args.state],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error("seedMembership: INSERT returned no row");
  }
  return row.id;
}

// Seed a `session_invites` row carrying ONLY the token hash (matching the
// issuance write), returning the generated invite id.
async function seedInvite(
  querier: Querier,
  args: {
    sessionId: string;
    inviterId: string;
    tokenHash: string;
    joinMode: JoinMode;
    state: string;
    expiresAt: string;
  },
): Promise<InviteId> {
  const inserted = await querier.query<{ id: string }>(
    `INSERT INTO session_invites (session_id, inviter_id, token_hash, join_mode, state, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [args.sessionId, args.inviterId, args.tokenHash, args.joinMode, args.state, args.expiresAt],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error("seedInvite: INSERT returned no row");
  }
  return row.id as InviteId;
}

// Re-read an invite row's lifecycle columns for state / no-mutation assertions.
async function readInviteRow(
  querier: Querier,
  inviteId: InviteId,
): Promise<{ state: string; token_hash: string } | undefined> {
  const probe = await querier.query<{ state: string; token_hash: string }>(
    "SELECT state, token_hash FROM session_invites WHERE id = $1",
    [inviteId],
  );
  return probe.rows[0];
}

// Re-read the membership for a (session, participant) pair (or undefined).
async function readMembership(
  querier: Querier,
  sessionId: string,
  participantId: ParticipantId,
): Promise<{ role: string; state: string } | undefined> {
  const probe = await querier.query<{ role: string; state: string }>(
    "SELECT role, state FROM session_memberships WHERE session_id = $1 AND participant_id = $2",
    [sessionId, participantId],
  );
  return probe.rows[0];
}

// Future timestamp (24h ahead) for a non-expired invite; past timestamp for
// the expiry test. ISO 8601 with offset, matching the contract wire form.
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
  service: InviteService;
}

let ctx: TestContext;

beforeEach(async () => {
  const pg: PGlite = new PGlite();
  const querier: Querier = adaptPGlite(pg);
  await applyMigrations(querier);

  // One active 32-byte key, shared between the service and the token minter so
  // the accept path decrypts under the key it was issued with.
  const activeEntry: KeyRingEntry = {
    id: "k_test_active",
    key: new Uint8Array(nodeRandomBytes(32)),
    createdAt: new Date(),
    retiredAt: undefined,
  };
  const keyRing: KeyRing = new KeyRing([activeEntry]);

  ctx = {
    pg,
    querier,
    keyRing,
    service: new InviteService(querier, keyRing),
  };
});

afterEach(async () => {
  await ctx.pg.close();
});

// ----------------------------------------------------------------------------
// P1 — valid accept creates an active membership
// ----------------------------------------------------------------------------

describe("InviteService.acceptInvite — P1 (AC1: valid accept -> active membership)", () => {
  it("transitions the invite pending -> accepted and creates an active membership in one transaction", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });
    const inviteId: InviteId = await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: DEFAULT_JOIN_MODE,
      state: "pending",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    // The invitee must already exist as a participant (FK on
    // session_memberships.participant_id); membership activation is the accept
    // path's job.
    const accept: InviteAccept = { token: minted.token };
    const result = await ctx.service.acceptInvite(INVITEE_PARTICIPANT_ID, accept);

    // The invite is now accepted.
    expect(result.inviteId).toBe(inviteId);
    const afterInvite = await readInviteRow(ctx.querier, inviteId);
    expect(afterInvite).toBeDefined();
    expect(afterInvite?.state).toBe("accepted");

    // The membership row is ACTIVE with the invite's join_mode as its role.
    expect(result.state).toBe("active");
    expect(result.role).toBe(DEFAULT_JOIN_MODE);
    expect(result.participantId).toBe(INVITEE_PARTICIPANT_ID);
    const membership = await readMembership(ctx.querier, SESSION_ID, INVITEE_PARTICIPANT_ID);
    expect(membership).toBeDefined();
    expect(membership?.state).toBe("active");
    expect(membership?.role).toBe(DEFAULT_JOIN_MODE);
  });
});

// ----------------------------------------------------------------------------
// P2 — revoked invite cannot be accepted; no membership mutation
// ----------------------------------------------------------------------------

describe("InviteService.acceptInvite — P2 (revoked -> invite.revoked, no membership)", () => {
  it("throws invite.revoked and creates no membership row", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });
    const inviteId: InviteId = await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: DEFAULT_JOIN_MODE,
      state: "revoked",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    const error = await ctx.service
      .acceptInvite(INVITEE_PARTICIPANT_ID, { token: minted.token })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteRevokedException);
    expect(error).toMatchObject({ code: INVITE_REVOKED_CODE });

    // No-mutation: the invite stays revoked AND no membership row was created.
    const afterInvite = await readInviteRow(ctx.querier, inviteId);
    expect(afterInvite?.state).toBe("revoked");
    const membership = await readMembership(ctx.querier, SESSION_ID, INVITEE_PARTICIPANT_ID);
    expect(membership).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// P3 — expired token throws regardless of DB state
// ----------------------------------------------------------------------------

describe("InviteService.acceptInvite — P3 (expired -> invite.expired regardless of DB state)", () => {
  it("throws invite.expired even when the DB row is still pending", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    // Token claim's expires_at is in the PAST; the DB row is still `pending`
    // with a matching past expiry. Per `Spec-002 §Token Security Properties` the CLAIM is
    // authoritative and an expired token is rejected regardless of DB state.
    const pastExpiry: string = isoOffset(-60 * 1000);
    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: pastExpiry,
    });
    const inviteId: InviteId = await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: DEFAULT_JOIN_MODE,
      state: "pending",
      expiresAt: pastExpiry,
    });

    const error = await ctx.service
      .acceptInvite(INVITEE_PARTICIPANT_ID, { token: minted.token })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteExpiredException);
    expect(error).toMatchObject({ code: INVITE_EXPIRED_CODE });

    // The still-pending invite was NOT consumed, and no membership was created.
    const afterInvite = await readInviteRow(ctx.querier, inviteId);
    expect(afterInvite?.state).toBe("pending");
    const membership = await readMembership(ctx.querier, SESSION_ID, INVITEE_PARTICIPANT_ID);
    expect(membership).toBeUndefined();
  });

  // Reclassification completeness — DISTINCT from the claim-authoritative path
  // above. Here the token claim's expires_at is in the FUTURE (so the
  // §Token Security Properties expiry-authoritative check does NOT fire), but
  // the persisted `session_invites.state` is
  // 'expired' (the CHECK admits it — migrations/0002-session-invites.ts). The
  // single-use UPDATE matches zero rows and the zero-row reclassification must
  // surface invite.expired, NOT invite.already_accepted. This path is latent in
  // Phase-2 runtime (no path writes 'expired'); it goes live when a DB-side
  // expiry sweep lands.
  it("reclassifies a PERSISTED expired-state row to invite.expired (not already_accepted) even with a future claim", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    // Future claim expiry -> the claim-authoritative check passes; the seeded
    // row carries state='expired' so the reclassification branch is exercised.
    const futureExpiry: string = isoOffset(24 * 60 * 60 * 1000);
    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: futureExpiry,
    });
    // Seed the row directly with state='expired' (bypassing the service, which
    // never writes 'expired' in Phase 2; the CHECK constraint admits it).
    const inviteId: InviteId = await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: DEFAULT_JOIN_MODE,
      state: "expired",
      expiresAt: futureExpiry,
    });

    const error = await ctx.service
      .acceptInvite(INVITEE_PARTICIPANT_ID, { token: minted.token })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteExpiredException);
    expect(error).toMatchObject({ code: INVITE_EXPIRED_CODE });

    // No-mutation: the row stays 'expired', and no membership row was created.
    const afterInvite = await readInviteRow(ctx.querier, inviteId);
    expect(afterInvite?.state).toBe("expired");
    const membership = await readMembership(ctx.querier, SESSION_ID, INVITEE_PARTICIPANT_ID);
    expect(membership).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// P4 — single-use: second accept on the same jti throws already_accepted
// ----------------------------------------------------------------------------

describe("InviteService.acceptInvite — P4 (single-use: second accept -> invite.already_accepted)", () => {
  it("consumes the invite on first accept and rejects the second accept of the same token", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });
    const inviteId: InviteId = await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: DEFAULT_JOIN_MODE,
      state: "pending",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    // First accept succeeds (consumes the token, jti unchanged).
    const first = await ctx.service.acceptInvite(INVITEE_PARTICIPANT_ID, { token: minted.token });
    expect(first.inviteId).toBe(inviteId);
    const afterFirst = await readInviteRow(ctx.querier, inviteId);
    expect(afterFirst?.state).toBe("accepted");

    // Second accept of the SAME token (same jti) is rejected as already
    // accepted — single-use (`Spec-002 §Token Security Properties`).
    const error = await ctx.service
      .acceptInvite(INVITEE_PARTICIPANT_ID, { token: minted.token })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteAlreadyAcceptedException);
    expect(error).toMatchObject({ code: INVITE_ALREADY_ACCEPTED_CODE });

    // The invite is still `accepted` (the second attempt changed nothing).
    const afterSecond = await readInviteRow(ctx.querier, inviteId);
    expect(afterSecond?.state).toBe("accepted");
  });
});

// ----------------------------------------------------------------------------
// P5 — hash storage: token_hash == SHA-256(token); plaintext never persisted
// ----------------------------------------------------------------------------
//
// This test lands HERE per the audit (NOT in T2.1). It drives the FULL
// issuance path (createInvite) so the assertion covers what the service
// actually writes, then proves (a) the stored hash equals SHA-256(the returned
// plaintext token) and (b) the plaintext token string appears in NO column of
// the row.

describe("InviteService — P5 (hash storage: token_hash == SHA-256(token), plaintext never persisted)", () => {
  it("persists only the SHA-256 hash of the token", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // The issuer must be an active OWNER of the session (security-architecture.md
    // §Permission Matrix, `Spec-002 §Invite Revocation`). Seed that membership so
    // the issuance gate admits the call.
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const created = await ctx.service.createInvite(OWNER_PARTICIPANT_ID, {
      sessionId: SESSION_ID,
      inviter: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    // The stored token_hash equals SHA-256 of the plaintext token the caller
    // received (`Spec-002 §Token Security Properties`).
    const expectedHash: string = createHash("sha256").update(created.token).digest("hex");
    const row = await ctx.querier.query<{
      id: string;
      session_id: string;
      inviter_id: string;
      token_hash: string;
      join_mode: string;
      state: string;
      expires_at: string;
    }>(
      `SELECT id, session_id, inviter_id, token_hash, join_mode, state, expires_at::text AS expires_at
         FROM session_invites WHERE id = $1`,
      [created.inviteId],
    );
    const inviteRow = row.rows[0];
    expect(inviteRow).toBeDefined();
    if (inviteRow === undefined) return;
    expect(inviteRow.token_hash).toBe(expectedHash);

    // The plaintext token appears in NO column of the persisted row. Stringify
    // every column value and assert the opaque token substring is absent —
    // catches a regression that stored the plaintext in a spare/extra column.
    const serializedRow: string = JSON.stringify(inviteRow);
    expect(serializedRow.includes(created.token)).toBe(false);

    // Defense in depth: a repo-wide-shaped scan for the plaintext token across
    // the whole table (cast every row to text) finds nothing.
    const plaintextSearch = await ctx.querier.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM session_invites
        WHERE session_invites::text LIKE $1`,
      [`%${created.token}%`],
    );
    expect(plaintextSearch.rows[0]?.n).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// createInvite owner-authorization (security-architecture.md §Permission Matrix,
// `Spec-002 §Invite Revocation` — "Invite participants" is owner-only)
// ----------------------------------------------------------------------------
//
// Issuance is gated on the AUTHENTICATED actor, not the body. The body
// `inviter` field is informational and attacker-controllable, so a non-owner
// member cannot mint a token by naming their own participant id. Each denial
// asserts BOTH the typed throw (InvitePermissionDeniedException + its stable
// code) AND the no-row side effect (no session_invites row written for the
// session). Each test fails for exactly ONE reason: the non-owner / non-member
// cases hold `inviter === actor` (only the owner gate trips), and the mismatch
// case seeds the actor as a valid active owner (only the equality check trips).

// Count session_invites rows for a session — used to assert a denied issuance
// wrote NO row (the gate throws inside the transaction, before the INSERT, so
// the transaction rolls back to zero rows).
async function countInvitesForSession(querier: Querier, sessionId: string): Promise<number> {
  const probe = await querier.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM session_invites WHERE session_id = $1",
    [sessionId],
  );
  return probe.rows[0]?.n ?? -1;
}

describe("InviteService.createInvite — owner-authorization (`Spec-002 §Invite Revocation`, Permission Matrix)", () => {
  it("a non-owner ACTIVE member issuing for themselves throws invite.permission_denied and writes no invite row", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, NON_OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // An active OWNER exists, but the ACTOR is a different active member with a
    // non-owner role (collaborator). The actor names themselves as inviter, so
    // the equality check passes and ONLY the owner gate trips.
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

    const error = await ctx.service
      .createInvite(NON_OWNER_PARTICIPANT_ID, {
        sessionId: SESSION_ID,
        inviter: NON_OWNER_PARTICIPANT_ID,
        joinMode: DEFAULT_JOIN_MODE,
        expiresAt: isoOffset(24 * 60 * 60 * 1000),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvitePermissionDeniedException);
    expect(error).toMatchObject({ code: INVITE_PERMISSION_DENIED_CODE });

    // No-row: the denied issuance wrote nothing (gate throws before the INSERT).
    expect(await countInvitesForSession(ctx.querier, SESSION_ID)).toBe(0);
  });

  it("a NON-member actor issuing for themselves throws invite.permission_denied and writes no invite row", async () => {
    await seedParticipant(ctx.querier, NON_OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // The actor has NO session_memberships row at all. inviter === actor, so
    // the equality check passes and ONLY the owner gate (no row) trips.

    const error = await ctx.service
      .createInvite(NON_OWNER_PARTICIPANT_ID, {
        sessionId: SESSION_ID,
        inviter: NON_OWNER_PARTICIPANT_ID,
        joinMode: DEFAULT_JOIN_MODE,
        expiresAt: isoOffset(24 * 60 * 60 * 1000),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvitePermissionDeniedException);
    expect(error).toMatchObject({ code: INVITE_PERMISSION_DENIED_CODE });

    expect(await countInvitesForSession(ctx.querier, SESSION_ID)).toBe(0);
  });

  it("an active OWNER actor naming a DIFFERENT inviter throws invite.permission_denied and writes no invite row", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, NON_OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // The ACTOR is a valid active owner, so the owner gate passes. The body
    // names a DIFFERENT participant as inviter, so ONLY the equality check trips
    // (no issuing-on-behalf-of-another in V1). The named inviter is itself a
    // real participant, so nothing but the equality check can fail.
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const error = await ctx.service
      .createInvite(OWNER_PARTICIPANT_ID, {
        sessionId: SESSION_ID,
        inviter: NON_OWNER_PARTICIPANT_ID,
        joinMode: DEFAULT_JOIN_MODE,
        expiresAt: isoOffset(24 * 60 * 60 * 1000),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvitePermissionDeniedException);
    expect(error).toMatchObject({ code: INVITE_PERMISSION_DENIED_CODE });

    expect(await countInvitesForSession(ctx.querier, SESSION_ID)).toBe(0);
  });

  it("an active OWNER naming the body inviter in DIFFERENT UUID casing succeeds (RFC 9562 §4)", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // The ACTOR is a valid active owner (canonical lowercase). The body names
    // the SAME logical owner UUID but UPPERCASED. RFC 9562 §4 admits both cases
    // and the `ParticipantId` brand has no runtime case-validator, so without
    // the `.toLowerCase()` normalization on both sides of the inviter-equality
    // check this call would wrongly throw InvitePermissionDeniedException.
    // Contrast the inviter!=actor denial above (a DIFFERENT participant, which
    // still throws + writes 0 rows).
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const uppercaseInviter: ParticipantId = OWNER_PARTICIPANT_ID.toUpperCase() as ParticipantId;
    await expect(
      ctx.service.createInvite(OWNER_PARTICIPANT_ID, {
        sessionId: SESSION_ID,
        inviter: uppercaseInviter,
        joinMode: DEFAULT_JOIN_MODE,
        expiresAt: isoOffset(24 * 60 * 60 * 1000),
      }),
    ).resolves.toBeDefined();

    // The issuance wrote exactly ONE invite row — the casing-only difference
    // did not trip the owner-binding gate.
    expect(await countInvitesForSession(ctx.querier, SESSION_ID)).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// P8 — revoked invite cannot be accepted (no re-join without a new invite)
// ----------------------------------------------------------------------------
//
// Drives the FULL revoke -> accept sequence through the service: an owner
// revokes a pending invite (state-only transition), then the invitee presents
// the SAME token. Because the invite is revoked, acceptInvite throws
// invite.revoked — the revoked participant cannot re-join with the old invite.

describe("InviteService — P8 (revoked invite cannot be accepted: no re-join without a new invite)", () => {
  it("revoke then accept of the same token throws invite.revoked and creates no membership", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });
    const inviteId: InviteId = await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: DEFAULT_JOIN_MODE,
      state: "pending",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    // Owner revokes the pending invite (STATE-ONLY transition).
    const revoke: InviteRevoke = { sessionId: SESSION_ID, inviteId };
    const revokeResult = await ctx.service.revokeInvite(OWNER_PARTICIPANT_ID, revoke);
    expect(revokeResult).not.toBeNull();
    expect(revokeResult?.state).toBe("revoked");

    // The invitee tries to accept with the same (now-revoked) token.
    const error = await ctx.service
      .acceptInvite(INVITEE_PARTICIPANT_ID, { token: minted.token })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteRevokedException);
    expect(error).toMatchObject({ code: INVITE_REVOKED_CODE });

    // No membership was created — the revoked participant cannot re-join with
    // the old invite.
    const membership = await readMembership(ctx.querier, SESSION_ID, INVITEE_PARTICIPANT_ID);
    expect(membership).toBeUndefined();
    const afterInvite = await readInviteRow(ctx.querier, inviteId);
    expect(afterInvite?.state).toBe("revoked");
  });
});

// ----------------------------------------------------------------------------
// revoke must not overwrite a TERMINAL invite state (`Spec-002 §Token Security Properties` + `Spec-002 §State And Data Implications`)
// ----------------------------------------------------------------------------
//
// Drives the REAL accept -> revoke -> reuse round-trip through the service
// (not a direct DB poke). After a token is consumed (invite `accepted`,
// single-use per `Spec-002 §Token Security Properties`), an owner revoke MUST be a no-op: `accepted` is a
// TERMINAL, durable state (`Spec-002 §State And Data Implications`). The load-bearing assertion is the
// SECOND accept (token reuse) — it must classify as `invite.already_accepted`,
// NOT `invite.revoked`. With the revoke guard missing, the revoke would clobber
// `accepted -> revoked`, the durable single-use record would be lost, and the
// reuse would surface `invite.revoked` — masking that a membership was already
// created.

describe("InviteService.revokeInvite — does not overwrite an accepted (terminal) invite (`Spec-002 §Token Security Properties` + `Spec-002 §State And Data Implications`)", () => {
  it("accept -> revoke (no-op) -> reuse still classifies as invite.already_accepted, not invite.revoked", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });
    const inviteId: InviteId = await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: DEFAULT_JOIN_MODE,
      state: "pending",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    // (1) The invitee accepts: invite `pending -> accepted` and an ACTIVE
    // membership is created in the same transaction (`Spec-002 §Interfaces And Contracts`).
    const accepted = await ctx.service.acceptInvite(INVITEE_PARTICIPANT_ID, {
      token: minted.token,
    });
    expect(accepted.participantId).toBe(INVITEE_PARTICIPANT_ID);
    const membership = await readMembership(ctx.querier, SESSION_ID, INVITEE_PARTICIPANT_ID);
    expect(membership?.state).toBe("active");
    const afterAccept = await readInviteRow(ctx.querier, inviteId);
    expect(afterAccept?.state).toBe("accepted");

    // (2) The owner now revokes the SAME invite. The `state = 'pending'` guard
    // means the now-`accepted` row matches 0 rows, so revoke is a no-op: it
    // returns `null` (the not-found wire mapping) and MUST NOT clobber the
    // durable terminal `accepted` state back to `revoked` (`Spec-002 §State And Data Implications`).
    const revokeResult = await ctx.service.revokeInvite(OWNER_PARTICIPANT_ID, {
      sessionId: SESSION_ID,
      inviteId,
    });
    expect(revokeResult).toBeNull();
    const afterRevoke = await readInviteRow(ctx.querier, inviteId);
    expect(afterRevoke?.state).toBe("accepted");

    // (3) Token reuse: a SECOND accept of the same token. This is the
    // load-bearing assertion — the single-use record survived the revoke
    // attempt, so reuse classifies as `invite.already_accepted` (Spec-002 line
    // 109), NOT `invite.revoked`. A clobbered row would surface the wrong code.
    const error = await ctx.service
      .acceptInvite(INVITEE_PARTICIPANT_ID, { token: minted.token })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteAlreadyAcceptedException);
    expect(error).toMatchObject({ code: INVITE_ALREADY_ACCEPTED_CODE });
  });
});

// ----------------------------------------------------------------------------
// Owner-authorization (`Spec-002 §Invite Revocation`) — owner-only revoke
// ----------------------------------------------------------------------------

describe("InviteService.revokeInvite — owner-authorization (`Spec-002 §Invite Revocation`)", () => {
  it("a NON-owner revoke throws invite.permission_denied and leaves the invite state unchanged", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, NON_OWNER_PARTICIPANT_ID);
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

    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });
    const inviteId: InviteId = await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: DEFAULT_JOIN_MODE,
      state: "pending",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    // A non-owner (collaborator) attempts to revoke. `Spec-002 §Invite Revocation`:
    // owner-only. MUST throw the typed permission error.
    const error = await ctx.service
      .revokeInvite(NON_OWNER_PARTICIPANT_ID, { sessionId: SESSION_ID, inviteId })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvitePermissionDeniedException);
    expect(error).toMatchObject({ code: INVITE_PERMISSION_DENIED_CODE });

    // No-mutation: the invite remains pending (the denied revoke changed
    // nothing).
    const afterInvite = await readInviteRow(ctx.querier, inviteId);
    expect(afterInvite?.state).toBe("pending");
  });

  it("an OWNER revoke transitions the invite state -> 'revoked' (§Invite Revocation immediacy)", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });
    const inviteId: InviteId = await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: DEFAULT_JOIN_MODE,
      state: "pending",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    // The owner revokes; carries a `reason` to confirm it is PARSED (the Zod
    // schema validates it) but NOT persisted (there is no reason column).
    const result = await ctx.service.revokeInvite(OWNER_PARTICIPANT_ID, {
      sessionId: SESSION_ID,
      inviteId,
      reason: "contractor offboarded",
    });
    expect(result).not.toBeNull();
    expect(result?.inviteId).toBe(inviteId);
    expect(result?.state).toBe("revoked");

    // Immediacy (§Invite Revocation): the row is `revoked` immediately after the call.
    const afterInvite = await readInviteRow(ctx.querier, inviteId);
    expect(afterInvite?.state).toBe("revoked");

    // STATE-ONLY: the only columns on the row are the Phase 1 schema columns.
    // There is no `reason` column, so `reason` could not have been persisted —
    // a regression that added one would fail the migration-shape test in T2.5;
    // here we assert the row carries no surprise reason text by scanning the
    // serialized row for the reason string.
    const rowText = await ctx.querier.query<{ row_text: string }>(
      "SELECT session_invites::text AS row_text FROM session_invites WHERE id = $1",
      [inviteId],
    );
    expect(rowText.rows[0]?.row_text.includes("contractor offboarded")).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// Accept must never downgrade an already-active membership (I-002-2 guard)
// ----------------------------------------------------------------------------
//
// Regression for the create-or-activate semantics (`Spec-002 §Required Behavior`): a sole
// active OWNER who accepts a `collaborator` invite for their own session must
// NOT be downgraded to `collaborator`. An unconditional `role = EXCLUDED.role`
// upsert would drop the session to zero active owners — the unrecoverable
// state I-002-2 forbids — and would bypass MembershipService's owner-only
// guard. The `role` CASE in acceptInvite preserves an already-active row's
// role; `state` stays 'active'.

describe("InviteService.acceptInvite — never downgrades an already-active membership (I-002-2)", () => {
  it("the sole active owner accepting a collaborator invite keeps role 'owner' (no downgrade, owner preserved)", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    // The owner is the SOLE active owner — and is also the accepting
    // participant (an owner who clicks a collaborator invite link for their
    // own session).
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    // A collaborator invite for the SAME session, accepted by the owner.
    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: "collaborator",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });
    const inviteId: InviteId = await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: "collaborator",
      state: "pending",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    const result = await ctx.service.acceptInvite(OWNER_PARTICIPANT_ID, { token: minted.token });

    // The membership role is STILL 'owner' (NOT downgraded to 'collaborator'),
    // state still 'active'. The invite is still consumed.
    expect(result.role).toBe("owner");
    expect(result.state).toBe("active");
    expect(result.inviteId).toBe(inviteId);

    const membership = await readMembership(ctx.querier, SESSION_ID, OWNER_PARTICIPANT_ID);
    expect(membership?.role).toBe("owner");
    expect(membership?.state).toBe("active");

    // The session still has an active owner (I-002-2: never zero active owners).
    const ownerCount = await ctx.querier.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM session_memberships
        WHERE session_id = $1 AND role = 'owner' AND state = 'active'`,
      [SESSION_ID],
    );
    expect(ownerCount.rows[0]?.n).toBe(1);
  });

  it("a previously revoked member accepting a NEW valid invite IS reactivated (inactive rows still activate)", async () => {
    // The complement of the no-downgrade case: an INACTIVE row (revoked) MUST
    // be activated by a new valid invite (the legitimate re-join path, P8).
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });
    // A prior revoked membership for the invitee.
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: INVITEE_PARTICIPANT_ID,
      role: "viewer",
      state: "revoked",
    });

    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: "collaborator",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });
    await seedInvite(ctx.querier, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: minted.tokenHash,
      joinMode: "collaborator",
      state: "pending",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    const result = await ctx.service.acceptInvite(INVITEE_PARTICIPANT_ID, { token: minted.token });

    // The inactive (revoked) row is reactivated with the NEW invite's role.
    expect(result.state).toBe("active");
    expect(result.role).toBe("collaborator");
    const membership = await readMembership(ctx.querier, SESSION_ID, INVITEE_PARTICIPANT_ID);
    expect(membership?.state).toBe("active");
    expect(membership?.role).toBe("collaborator");
  });
});

// ----------------------------------------------------------------------------
// InviteNotFoundException — garbage / foreign / unknown-hash tokens
// ----------------------------------------------------------------------------
//
// All three collapse to not-found (no existence oracle): a token that fails
// v4.local decryption, a token that decrypts under the active key but whose
// payload is not the invite claim shape, and a well-formed invite token whose
// SHA-256 matches no seeded row.

describe("InviteService.acceptInvite — InviteNotFoundException (garbage / foreign / unknown-hash)", () => {
  it("a garbage / undecryptable token throws invite.not_found", async () => {
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    // A syntactically v4.local-shaped but undecryptable token (random body).
    const garbageToken = `v4.local.${nodeRandomBytes(64).toString("base64url")}`;

    const error = await ctx.service
      .acceptInvite(INVITEE_PARTICIPANT_ID, { token: garbageToken })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteNotFoundException);
    expect(error).toMatchObject({ code: INVITE_NOT_FOUND_CODE });
  });

  it("a token that decrypts under the active key but carries a foreign payload throws invite.not_found", async () => {
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    // Encrypt a NON-claim JSON payload under the SAME active key the service
    // holds. It decrypts cleanly, but the payload is not InviteTokenClaims.
    const foreignBytes: Uint8Array = new TextEncoder().encode(
      JSON.stringify({ hello: "world", not: "an invite claim" }),
    );
    const foreignToken: string = encryptV4Local(foreignBytes, ctx.keyRing.active().key);

    const error = await ctx.service
      .acceptInvite(INVITEE_PARTICIPANT_ID, { token: foreignToken })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteNotFoundException);
    expect(error).toMatchObject({ code: INVITE_NOT_FOUND_CODE });
  });

  it("a well-formed invite token whose hash matches no row throws invite.not_found", async () => {
    await seedParticipant(ctx.querier, INVITEE_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);

    // A perfectly valid invite token under the active key — but its row is
    // never seeded, so SHA-256(token) matches nothing in session_invites.
    const minted: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    const error = await ctx.service
      .acceptInvite(INVITEE_PARTICIPANT_ID, { token: minted.token })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InviteNotFoundException);
    expect(error).toMatchObject({ code: INVITE_NOT_FOUND_CODE });
  });
});

// ----------------------------------------------------------------------------
// revokeInvite — null on unknown / cross-session inviteId
// ----------------------------------------------------------------------------

describe("InviteService.revokeInvite — null on unknown / cross-session inviteId", () => {
  it("an active owner revoking an unknown inviteId returns null (not a throw)", async () => {
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    // A well-formed but never-seeded invite id, in a session the actor owns.
    const unknownInviteId: InviteId = "01970000-0000-7000-8000-0000000a9999" as InviteId;
    const result = await ctx.service.revokeInvite(OWNER_PARTICIPANT_ID, {
      sessionId: SESSION_ID,
      inviteId: unknownInviteId,
    });
    expect(result).toBeNull();
  });

  it("an owner of session A cannot revoke an invite that belongs to session B (cross-session filter)", async () => {
    // Pins the `WHERE id = $1 AND session_id = $2` predicate: naming an invite
    // id that exists, but under a DIFFERENT session than the one the actor
    // owns, returns null AND leaves session B's invite untouched.
    await seedParticipant(ctx.querier, OWNER_PARTICIPANT_ID);
    await seedSession(ctx.querier, SESSION_ID);
    await seedSession(ctx.querier, OTHER_SESSION_ID);
    // The actor owns session A (SESSION_ID) only.
    await seedMembership(ctx.querier, {
      sessionId: SESSION_ID,
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      state: "active",
    });

    // An invite that lives under session B (OTHER_SESSION_ID).
    const mintedForB: MintedInvite = mintInviteToken(ctx.keyRing, {
      sessionId: OTHER_SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      joinMode: DEFAULT_JOIN_MODE,
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });
    const inviteIdInB: InviteId = await seedInvite(ctx.querier, {
      sessionId: OTHER_SESSION_ID,
      inviterId: OWNER_PARTICIPANT_ID,
      tokenHash: mintedForB.tokenHash,
      joinMode: DEFAULT_JOIN_MODE,
      state: "pending",
      expiresAt: isoOffset(24 * 60 * 60 * 1000),
    });

    // The owner of A names B's invite id but claims sessionId = A. The
    // predicate matches no row (the id is under B), so the result is null and
    // B's invite is left pending.
    const result = await ctx.service.revokeInvite(OWNER_PARTICIPANT_ID, {
      sessionId: SESSION_ID,
      inviteId: inviteIdInB,
    });
    expect(result).toBeNull();

    // B's invite row is untouched (still pending).
    const afterInviteInB = await readInviteRow(ctx.querier, inviteIdInB);
    expect(afterInviteInB?.state).toBe("pending");
  });
});
