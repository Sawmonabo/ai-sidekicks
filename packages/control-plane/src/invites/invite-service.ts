// InviteService — Plan-002 Phase 2 (T2.1 issuance + T2.2 accept/revoke).
//
// Responsibilities (T2.1, issuance path):
//   * createInvite — mint a PASETO v4.local invite token whose payload is
//                    `{session_id, inviter_id, join_mode, expires_at, jti}`
//                    (Spec-002 §Token Security Properties line 113), then
//                    INSERT a `session_invites` row carrying ONLY the SHA-256
//                    hash of the token (line 111 — plaintext is never
//                    persisted) with `state = 'pending'`. Returns the
//                    plaintext token to the caller exactly once for out-of-band
//                    link delivery (Spec-002 §Invite Delivery).
//
// Responsibilities (T2.2, accept + revoke paths):
//   * acceptInvite — decrypt the presented PASETO v4.local token under the
//                    key ring's ACTIVE key, recover the claim payload, look up
//                    the `session_invites` row by SHA-256(token), enforce
//                    expiry (Spec-002 line 112, claim is authoritative),
//                    revocation (line 139), and single-use (line 109) under
//                    ONE transaction, then transition `pending -> accepted`
//                    AND create the active `session_memberships` row in that
//                    same commit boundary (AC1).
//   * revokeInvite — owner-authorized (Spec-002 line 142), STATE-ONLY
//                    transition `state -> 'revoked'` (line 138, immediacy).
//                    NO audit event is emitted and NO event log is written:
//                    per ADR-017 the control plane has NO event log, and the
//                    `invite.revoked` audit event is deferred to Plan-006
//                    Tier 4 (daemon-side) per CP-002-6. The Phase 2 deliverable
//                    is the coordination-state transition, full stop.
//   * Expiry validation (Spec-002 line 112) is a shared helper consumed by the
//     accept path; the `expires_at` PASETO claim — not the DB column — is the
//     authoritative source per the spec ("validates the `expires_at` claim in
//     the PASETO payload on every access").
//
// Dependency injection (mirrors SessionDirectoryService):
//   * `Querier` — the minimal SQL surface (declared in
//     `sessions/migration-runner.ts`). The service body NEVER imports `pg`
//     directly; the production concretion is composed by
//     `createInviteServiceFromPool` at the bottom of this file via the same
//     `createPgPoolQuerier` adapter Plan-001 ships. This keeps the test
//     surface (in-process PGlite) and the production surface (`pg.Pool`)
//     interchangeable without a runtime branch.
//   * `KeyRing` — the rotation-aware v4.local key holder from
//     `@ai-sidekicks/crypto-paseto`. The service pulls the active 32-byte
//     key per call via `keyRing.active().key`. The key is INJECTED, never
//     generated or hardcoded inside the service: KeyRing enforces the
//     32-byte invariant + exactly-one-active-entry invariant at construction
//     and is what Plan-018 will wire to its persisted key store.
//
// Cross-plan / cross-task boundaries (DO NOT CROSS):
//   * `session_invites` table DDL — owned by `migrations/0002-session-invites.ts`
//     (Plan-002 Phase 1). This service only INSERT/SELECT/UPDATEs rows; it
//     never ALTERs the schema. There is NO `revoked_by` / `revoked_at` /
//     `reason` column and T2.2 adds none — revocation is STATE-ONLY.
//   * `session_memberships` table DDL — owned by `migrations/0001-initial.ts`
//     (Plan-001). The accept path (T2.2) INSERTs an active membership row
//     against the EXISTING schema; it never ALTERs it.
//   * Audit / lifecycle event emission (`invite.revoked`, participant-join) —
//     NOT this PR. Per ADR-017 the control plane has NO event log and writes
//     no `session_events` row and no `prev_hash` / `row_hash` /
//     `daemon_signature` integrity column (that `Buffer.alloc(32)` placeholder
//     is a runtime-daemon SQLite convention and does not belong here). The
//     `invite.revoked` audit event is deferred to Plan-006 Tier 4 (daemon-side,
//     gated on Plan-008-remainder Tier 5 relay sync) per CP-002-6; Spec-002
//     line 141 is satisfied there, not in Phase 2.
//   * Rate limiting (Spec-002 §Rate Limiting) — not an issuance/accept
//     correctness concern; owned downstream (framework / Plan-005 surface).
//
// Refs: Spec-002 §Token Security Properties (lines 107-113), §Invite Delivery
// (lines 91-99), §Invite Revocation (lines 138-142), Plan-002 Phase 2,
// ADR-010 (PASETO auth stack), ADR-017 (control plane has no event log),
// CP-002-6 (audit emission deferred to Tier 4).

import { createHash, randomBytes } from "node:crypto";

import type {
  InviteAccept,
  InviteId,
  InviteCreate,
  InviteRevoke,
  InviteState,
  JoinMode,
  MembershipId,
  MembershipRole,
  MembershipState,
  ParticipantId,
  SessionId,
} from "@ai-sidekicks/contracts";
import {
  InviteAcceptSchema,
  InviteCreateSchema,
  InviteRevokeSchema,
} from "@ai-sidekicks/contracts";
import {
  decryptV4Local,
  encryptV4Local,
  InvalidTokenError,
  type KeyRing,
} from "@ai-sidekicks/crypto-paseto";
import type { Pool } from "pg";

import { createPgPoolQuerier } from "../sessions/session-directory-service.js";
import type { Querier } from "../sessions/migration-runner.js";

// --------------------------------------------------------------------------
// Typed errors — Plan-002 Phase 2 §Goal line 267.
// --------------------------------------------------------------------------
//
// Defined inline, mirroring the `ResourceLimitExceededException` idiom in
// `sessions/errors.ts` and the `MembershipPermissionDeniedException` idiom in
// `memberships/membership-service.ts`: a class `extends Error` carrying a
// stable `readonly code` literal the transport layer lifts onto the wire
// envelope. The `code` literals are inlined here rather than imported from
// `@ai-sidekicks/contracts` because contracts does not yet export
// `INVITE_*_CODE` constants (verified at T2.2 authoring time) — same posture
// the membership service took for `MEMBERSHIP_*_CODE`. The error namespace is
// `invite.*` so codes stay co-located with their resource (an invite-revoke
// permission failure is `invite.permission_denied`, NOT the membership
// service's `membership.permission_denied`). See RESULT for the follow-up
// recommending the constants land in `packages/contracts/src/invites.ts`.

/** Stable wire code for an invite token that decodes to no live invite row. */
export const INVITE_NOT_FOUND_CODE = "invite.not_found" as const;

/** Stable wire code for the single-use guard (Spec-002 line 109). */
export const INVITE_ALREADY_ACCEPTED_CODE = "invite.already_accepted" as const;

/** Stable wire code for an accept against a revoked invite (Spec-002 line 139). */
export const INVITE_REVOKED_CODE = "invite.revoked" as const;

/** Stable wire code for the expiry guard (Spec-002 line 112). */
export const INVITE_EXPIRED_CODE = "invite.expired" as const;

/** Stable wire code for the owner-only revoke authorization (Spec-002 line 142). */
export const INVITE_PERMISSION_DENIED_CODE = "invite.permission_denied" as const;

/**
 * Thrown by `acceptInvite` when the presented token does not resolve to a live
 * invite. Covers BOTH a token that fails v4.local decryption / MAC
 * verification (tampered or garbage — `decryptV4Local` throws
 * `InvalidTokenError` / `MacMismatchError`) AND a well-formed token whose
 * `SHA-256(token)` matches no `session_invites` row. The two are collapsed to
 * one error on purpose: distinguishing "tampered token" from "unknown token"
 * would leak whether a given token hash exists, so both surface as
 * not-found. The transport layer maps this to a not-found / unauthorized
 * response.
 */
export class InviteNotFoundException extends Error {
  readonly code: typeof INVITE_NOT_FOUND_CODE = INVITE_NOT_FOUND_CODE;

  constructor(message: string) {
    super(message);
    this.name = "InviteNotFoundException";
  }
}

/**
 * Thrown by `acceptInvite` when the invite has already been consumed
 * (`state = 'accepted'`). Single-use is enforced atomically via a conditional
 * `UPDATE ... WHERE state = 'pending'`; a zero-row update is re-classified by
 * re-reading the row's state, and an `accepted` row surfaces here (Spec-002
 * line 109: "Subsequent attempts to use the same token return an 'invite
 * already accepted' error").
 */
export class InviteAlreadyAcceptedException extends Error {
  readonly code: typeof INVITE_ALREADY_ACCEPTED_CODE = INVITE_ALREADY_ACCEPTED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "InviteAlreadyAcceptedException";
  }
}

/**
 * Thrown by `acceptInvite` when the invite has been revoked
 * (`state = 'revoked'`). NO membership mutation occurs (P2). A revoked invite
 * can never be accepted, so a revoked participant cannot re-join without a NEW
 * invite (P8). Spec-002 line 139: "A revoked token that is subsequently
 * clicked returns a clear error."
 */
export class InviteRevokedException extends Error {
  readonly code: typeof INVITE_REVOKED_CODE = INVITE_REVOKED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "InviteRevokedException";
  }
}

/**
 * Thrown by `acceptInvite` when the token's `expires_at` claim is in the past
 * (Spec-002 line 112). The claim — not the DB `state` — is authoritative:
 * "Expired tokens return an 'invite expired' error regardless of database
 * state." Checked before the revoked / single-use branches so an expired token
 * surfaces expiry first.
 */
export class InviteExpiredException extends Error {
  readonly code: typeof INVITE_EXPIRED_CODE = INVITE_EXPIRED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "InviteExpiredException";
  }
}

/**
 * Thrown by `revokeInvite` when the acting participant is not an active owner
 * of the invite's session (Spec-002 line 142, owner-only per the
 * security-architecture.md Permission Matrix). The ownership check mirrors
 * `MembershipService.updateMembership`'s active-owner gate. The transport
 * layer maps this to an authorization failure (HTTP 403 / tRPC `FORBIDDEN`).
 */
export class InvitePermissionDeniedException extends Error {
  readonly code: typeof INVITE_PERMISSION_DENIED_CODE = INVITE_PERMISSION_DENIED_CODE;

  constructor(message: string) {
    super(message);
    this.name = "InvitePermissionDeniedException";
  }
}

// --------------------------------------------------------------------------
// Token entropy — Spec-002 §Token Security Properties line 110
// --------------------------------------------------------------------------
//
// "The PASETO payload includes 256-bit CSPRNG randomness (... `crypto.
// randomBytes(32)`)." 256 bits = 32 bytes. This randomness IS the `jti`
// claim (line 113): the four other payload fields (`session_id`,
// `inviter_id`, `join_mode`, `expires_at`) are all caller-supplied semantic
// values, so `jti` is the ONLY field that can carry the spec's entropy
// floor. A UUID v4 `jti` would supply only 122 bits and fail line 110;
// 32 CSPRNG bytes satisfy line 110 (entropy) and line 113 (unique token
// identifier for single-use / revocation lookup) in one field.
//
// The PASETO v4.local envelope's own per-call nonce (32 bytes, minted inside
// `encryptV4Local`) is a SEPARATE value protecting the ciphertext; it is not
// the `jti` and is never surfaced to the payload.
const TOKEN_ENTROPY_BYTES = 32;

// --------------------------------------------------------------------------
// Token claim payload — Spec-002 §Token Security Properties line 113
// --------------------------------------------------------------------------
//
// `{session_id, inviter_id, join_mode, expires_at, jti}` — encrypted inside
// the PASETO v4.local envelope. Field names are snake_case to match the
// spec's verbatim wire-claim shape (line 113); they are independent of the
// camelCase `InviteCreate` contract field names. T2.2's accept path decodes
// this exact shape, so the claim contract is shared across both tasks.
interface InviteTokenClaims {
  readonly session_id: string;
  readonly inviter_id: string;
  readonly join_mode: JoinMode;
  readonly expires_at: string;
  readonly jti: string;
}

// --------------------------------------------------------------------------
// createInvite response — api-payload-contracts.md §Tier 2 (lines 383-387)
// --------------------------------------------------------------------------
//
// `InviteCreateResponse { inviteId, token, expiresAt }`. The `token` is the
// PLAINTEXT PASETO v4.local string handed to the caller exactly once for
// out-of-band link delivery (Spec-002 §Invite Delivery); only its SHA-256
// hash is persisted. This shape is defined locally because the `contracts`
// package does not yet export an `InviteCreateResponse` type — see the RESULT
// concern recommending it land in `packages/contracts/src/invites.ts` in a
// follow-up (that file is outside T2.1's `target_paths`).
export interface InviteCreateResponse {
  inviteId: InviteId;
  token: string;
  expiresAt: string;
}

// --------------------------------------------------------------------------
// acceptInvite response — the active membership the accept path creates.
// --------------------------------------------------------------------------
//
// Returns the invite that was consumed plus the membership that was activated,
// so the wire layer can confirm BOTH the invite transition (`accepted`) and
// the resulting membership to the caller. Declared locally because
// `@ai-sidekicks/contracts` does not yet export an `InviteAcceptResponse`
// type (verified at T2.2 authoring time) — mirrors the local
// `InviteCreateResponse` and `MembershipUpdateResponse` shapes. See RESULT for
// the follow-up recommending it land in `packages/contracts/src/invites.ts`.
export interface InviteAcceptResponse {
  inviteId: InviteId;
  membershipId: MembershipId;
  sessionId: SessionId;
  participantId: ParticipantId;
  role: MembershipRole;
  state: MembershipState;
}

// --------------------------------------------------------------------------
// revokeInvite response — the post-revoke invite projection.
// --------------------------------------------------------------------------
//
// STATE-ONLY: the response carries the invite id and its new `state`
// (`'revoked'`); there is no `reason` / `revokedBy` / `revokedAt` field
// because no such column exists and no audit event is emitted in Phase 2 (see
// file header / ADR-017 / CP-002-6). Declared locally for the same reason as
// the shapes above.
export interface InviteRevokeResponse {
  inviteId: InviteId;
  state: InviteState;
}

// --------------------------------------------------------------------------
// Internal row shape — the JSON-readable shape returned by `pg.Pool#query`
// and `PGlite#query` for the `session_invites` RETURNING projection. Postgres
// folds column identifiers to lowercase and the schema uses snake_case
// columns, so both drivers map onto the keys below. Mirrors the SessionRow /
// MembershipRow internal shapes in session-directory-service.ts.
// --------------------------------------------------------------------------
interface InviteRow {
  readonly id: string;
  readonly expires_at: Date | string;
}

// Row shape read by the accept path. Only the three columns the accept logic
// actually consumes are projected: `id` (the single-use UPDATE target and the
// returned invite id), `state` (re-classified to the right typed error when
// the single-use UPDATE matches zero rows), and `join_mode` (read from the
// ROW — it becomes the activated membership's role). The session is taken from
// the token claim (`claims.session_id`) and expiry from the claim
// (`claims.expires_at`, authoritative per line 112), so neither is selected
// here. Mirrors the `InviteRow` projection convention above.
interface InviteAcceptRow {
  readonly id: string;
  readonly join_mode: string;
  readonly state: string;
}

// `TIMESTAMPTZ` is hydrated as a JS `Date` by `pg` and as an ISO 8601 string
// by PGlite. The response contract requires ISO 8601 (`expiresAt: string`),
// so normalize both forms. Mirrors `toIsoString` in
// session-directory-service.ts.
function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

// --------------------------------------------------------------------------
// Expiry validation (Spec-002 §Token Security Properties line 112)
// --------------------------------------------------------------------------
//
// "The server validates the `expires_at` claim in the PASETO payload on every
// access. Expired tokens return an 'invite expired' error regardless of
// database state." The CLAIM is authoritative — not the DB column — so this
// helper takes the ISO 8601 string from the decoded payload. An unparseable
// claim is treated as expired (fail-closed: a token whose expiry cannot be
// established is not honored). Comparison is strict `<= now` so a token
// expiring exactly now is rejected.
function isExpiredClaim(expiresAtClaim: string, now: Date): boolean {
  const expiresAtMs: number = Date.parse(expiresAtClaim);
  if (Number.isNaN(expiresAtMs)) {
    return true;
  }
  return expiresAtMs <= now.getTime();
}

// --------------------------------------------------------------------------
// Claim decode — recover `InviteTokenClaims` from a decrypted payload.
// --------------------------------------------------------------------------
//
// The decrypted bytes are the UTF-8 JSON of `InviteTokenClaims` (the exact
// shape `createInvite` encrypted, line 113). A payload that does not parse to
// the expected shape is treated as a not-found invite — a well-formed v4.local
// envelope under our active key but with a foreign payload shape is not an
// invite this service issued. Returns `undefined` on any structural failure;
// the caller maps that to `InviteNotFoundException`.
function decodeClaims(payloadBytes: Uint8Array): InviteTokenClaims | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  // Bracket access — `noPropertyAccessFromIndexSignature` (tsconfig.base)
  // forbids dotted access on an index-signature type.
  const candidate = parsed as Record<string, unknown>;
  const sessionId = candidate["session_id"];
  const inviterId = candidate["inviter_id"];
  const joinMode = candidate["join_mode"];
  const expiresAt = candidate["expires_at"];
  const jti = candidate["jti"];
  if (
    typeof sessionId !== "string" ||
    typeof inviterId !== "string" ||
    typeof joinMode !== "string" ||
    typeof expiresAt !== "string" ||
    typeof jti !== "string"
  ) {
    return undefined;
  }
  return {
    session_id: sessionId,
    inviter_id: inviterId,
    join_mode: joinMode as JoinMode,
    expires_at: expiresAt,
    jti,
  };
}

export class InviteService {
  readonly #querier: Querier;
  readonly #keyRing: KeyRing;

  constructor(querier: Querier, keyRing: KeyRing) {
    this.#querier = querier;
    this.#keyRing = keyRing;
  }

  /**
   * Mint an invite token and persist its `session_invites` row.
   *
   * Flow:
   *   1. Validate the `InviteCreate` input at the trust boundary via
   *      `InviteCreateSchema.parse(...)` (fail-fast; mirrors the boundary-
   *      validation idiom). A malformed `sessionId` / `inviter` / `joinMode`
   *      / `expiresAt` throws a `ZodError` before any token is minted.
   *   2. Generate 256-bit CSPRNG entropy as the `jti` (Spec-002 line 110).
   *   3. Assemble the `{session_id, inviter_id, join_mode, expires_at, jti}`
   *      claim payload (line 113), serialize to UTF-8 bytes, and encrypt
   *      with PASETO v4.local under the key ring's ACTIVE key. The plaintext
   *      claim bytes never leave this method; the returned token is the
   *      opaque encrypted envelope.
   *   4. Compute the SHA-256 hash of the token string (line 111) and INSERT
   *      a `session_invites` row carrying ONLY that hash, `state = 'pending'`.
   *      The plaintext token is NEVER written to the database.
   *   5. Return `{inviteId, token, expiresAt}` — the plaintext token is
   *      surfaced to the caller exactly once for out-of-band link delivery.
   *
   * Why the single INSERT runs inside `transaction(...)`: T2.2 extends this
   * file with accept (count/lock-then-mutate `pending` -> `accepted`) and
   * revoke flows that need a multi-statement commit boundary. Structuring the
   * issuance write transactionally now means T2.2 slots its statements into
   * the same primitive without reshaping the issuance path. The PGlite and
   * `pg.Pool` adapters both implement `transaction(fn)` with auto-rollback on
   * throw, so a torn write (FK violation on a stale `sessionId`/`inviter`,
   * connection drop) leaves no half-written invite row.
   *
   * Hash-storage property (Spec-002 line 111, verified by P5 in T2.2): the
   * `token_hash` column receives `SHA-256(token)` as a hex digest; the
   * plaintext `token` appears only in the return value and the in-memory
   * claim assembly, never in a SQL parameter. The `session_invites.token_hash`
   * UNIQUE constraint (Plan-002 Phase 1 migration) backs single-use semantics
   * that T2.2 enforces on accept.
   */
  async createInvite(input: InviteCreate): Promise<InviteCreateResponse> {
    // (1) Trust-boundary validation. Parse rather than trust the caller —
    // a service-layer fail-fast that surfaces schema drift before any token
    // material is generated or any row is written.
    const validated: InviteCreate = InviteCreateSchema.parse(input);

    // (2) 256-bit CSPRNG `jti` (Spec-002 line 110). base64url keeps the
    // claim payload compact and URL-safe; the value is opaque single-use /
    // revocation-lookup identity, never parsed for structure.
    const jti: string = randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url");

    // (3) Assemble + encrypt the claim payload (Spec-002 line 113). The
    // active key is pulled from the injected ring; KeyRing guarantees it is
    // exactly 32 bytes (its construction-time invariant), which is the
    // `encryptV4Local` v4.local key-length requirement.
    const claims: InviteTokenClaims = {
      session_id: validated.sessionId,
      inviter_id: validated.inviter,
      join_mode: validated.joinMode,
      expires_at: validated.expiresAt,
      jti,
    };
    const claimBytes: Uint8Array = new TextEncoder().encode(JSON.stringify(claims));
    const activeKey: Uint8Array = this.#keyRing.active().key;
    const token: string = encryptV4Local(claimBytes, activeKey);

    // (4) Hash-storage (Spec-002 line 111): persist ONLY SHA-256(token). The
    // plaintext `token` is never passed as a SQL parameter. Hex digest is the
    // canonical Postgres-text form for a hash and matches the repo's existing
    // `createHash(...).digest()` idiom (runtime-daemon session-projector.ts).
    const tokenHash: string = createHash("sha256").update(token).digest("hex");

    const inviteRow: InviteRow = await this.#querier.transaction(async (tx) => {
      const insertResult = await tx.query<InviteRow>(
        `INSERT INTO session_invites (session_id, inviter_id, token_hash, join_mode, state, expires_at)
         VALUES ($1, $2, $3, $4, 'pending', $5)
         RETURNING id, expires_at`,
        [
          validated.sessionId,
          validated.inviter,
          tokenHash,
          validated.joinMode,
          validated.expiresAt,
        ],
      );
      const row: InviteRow | undefined = insertResult.rows[0];
      if (row === undefined) {
        throw new Error(
          `InviteService.createInvite: session_invites INSERT returned no row for session=${String(validated.sessionId)} inviter=${String(validated.inviter)}`,
        );
      }
      return row;
    });

    // (5) Surface the plaintext token to the caller exactly once. The DB
    // holds only its hash; this return value is the sole place the plaintext
    // exists post-issuance (Spec-002 §Invite Delivery composes the shareable
    // link from it).
    return {
      inviteId: inviteRow.id as InviteId,
      token,
      expiresAt: toIsoString(inviteRow.expires_at),
    };
  }

  /**
   * Accept a presented invite token: enforce expiry / revocation / single-use,
   * then transition the invite `pending -> accepted` AND create the active
   * `session_memberships` row, all under ONE transaction (AC1, Spec-002 line
   * 81).
   *
   * Flow:
   *   1. Validate the `InviteAccept` input at the trust boundary
   *      (`InviteAcceptSchema.parse`), mirroring `createInvite`.
   *   2. Decrypt the token under the key ring's ACTIVE key (v4.local has no
   *      key id in the envelope, so only the active key is tried — the
   *      rotation-transition gap is Plan-018's). A decryption / MAC failure
   *      (`InvalidTokenError` / `MacMismatchError`) maps to
   *      `InviteNotFoundException`: a tampered or foreign token is
   *      indistinguishable from an unknown one, by design (no existence
   *      oracle).
   *   3. Recover the `InviteTokenClaims` payload; a structurally-foreign
   *      payload maps to not-found.
   *   4. Compute `SHA-256(token)` and look up the row (line 111: only the hash
   *      is stored, so lookup is by hash). No row -> not-found.
   *   5. Expiry (Spec-002 line 112): the token's `expires_at` CLAIM — not the
   *      DB `state` — is authoritative. An expired claim throws
   *      `InviteExpiredException` regardless of DB state, BEFORE the
   *      revoked / single-use branches.
   *   6. Single-use atomicity (line 109): a conditional
   *      `UPDATE ... SET state = 'accepted' WHERE id = $1 AND state = 'pending'
   *      RETURNING ...` claims the invite. A non-zero row count means THIS call
   *      won the transition (no TOCTOU gap between a read and the write). A
   *      zero-row update re-reads the row's state to pick the right typed
   *      error — `revoked` -> `InviteRevokedException` (P2, no membership
   *      mutation), `accepted` -> `InviteAlreadyAcceptedException` (P4).
   *   7. Membership create-or-activate (Spec-002 line 42): in the SAME
   *      transaction, upsert the `session_memberships` row keyed on the claim's
   *      `session_id` and the accepting participant. `ON CONFLICT
   *      (session_id, participant_id) DO UPDATE` reactivates an INACTIVE
   *      (pending / suspended / revoked) row with the new invite's `join_mode`
   *      as the role, while PRESERVING an ALREADY-ACTIVE row's role + state via
   *      the `role` CASE — so accept never downgrades an active member and can
   *      never drop the session's last active owner (I-002-2). It deliberately
   *      does NOT mirror createSession/joinSession's no-op
   *      `DO UPDATE SET updated_at = ...` preserve: those paths never activate
   *      an inactive row, whereas accept must. This does NOT weaken single-use
   *      — the guard is on the INVITE row, not the membership — and is
   *      consistent with P8 (a revoked participant needs a NEW invite to
   *      re-join, which is exactly this reactivation path).
   *
   * Lock ordering (I-002-4, inherited from Plan-001 I-001-1): the accept
   * transaction acquires the parent `sessions` row lock (`SELECT id FROM
   * sessions WHERE id = $1 FOR UPDATE`) BEFORE touching `session_invites` /
   * `session_memberships`, matching the canonical `sessions` ->
   * `session_memberships` order SessionDirectoryService / MembershipService
   * document. T2.4 (P9) pins this ordering for the invite-accept caller.
   *
   * No audit / lifecycle event is emitted: per ADR-017 the control plane has
   * no event log. The participant-join event is daemon-side (Plan-006 Tier 4).
   *
   * @param acceptingParticipantId the authenticated participant accepting the
   *   invite. `InviteAccept` carries only the token (Spec-002 line 81 — the
   *   wire request is token-only), so the accepting identity is passed
   *   explicitly, mirroring `MembershipService.updateMembership`'s
   *   actor-as-parameter convention. The participant is bound at the
   *   authenticated accept RPC (Spec-002 §Invite Delivery step 3: "Prompts the
   *   recipient to authenticate before acceptance").
   */
  async acceptInvite(
    acceptingParticipantId: ParticipantId,
    input: InviteAccept,
  ): Promise<InviteAcceptResponse> {
    // (1) Trust-boundary validation.
    const validated: InviteAccept = InviteAcceptSchema.parse(input);

    // (2) Decrypt under the ACTIVE key. A v4.local decrypt failure (tampered,
    // wrong key, malformed) collapses to not-found — no existence oracle.
    const activeKey: Uint8Array = this.#keyRing.active().key;
    let payloadBytes: Uint8Array;
    try {
      payloadBytes = decryptV4Local(validated.token, activeKey);
    } catch (error: unknown) {
      if (error instanceof InvalidTokenError) {
        // `MacMismatchError extends InvalidTokenError`, so both the tampered-
        // MAC and malformed-envelope cases land here.
        throw new InviteNotFoundException(
          "InviteService.acceptInvite: token did not decrypt to a valid invite envelope.",
        );
      }
      throw error;
    }

    // (3) Recover the claim payload. A foreign payload shape -> not-found.
    const claims: InviteTokenClaims | undefined = decodeClaims(payloadBytes);
    if (claims === undefined) {
      throw new InviteNotFoundException(
        "InviteService.acceptInvite: token payload did not match the invite claim shape.",
      );
    }

    // (4) Look up the row by SHA-256(token) (line 111 — only the hash is
    // stored). The plaintext token is never passed to SQL.
    const tokenHash: string = createHash("sha256").update(validated.token).digest("hex");

    // (5) Expiry is evaluated against the CLAIM (authoritative per line 112),
    // computed once outside the transaction; `now` is captured here so the
    // expiry decision is stable across the whole accept.
    const now = new Date();

    return this.#querier.transaction(async (transaction) => {
      // Lock the parent session row FIRST (I-002-4 canonical order
      // `sessions` -> `session_invites`/`session_memberships`). The session id
      // comes from the decoded claim; if the claim names a session that does
      // not exist the lock SELECT simply locks nothing and the invite lookup
      // below fails not-found.
      await transaction.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
        claims.session_id,
      ]);

      const inviteProbe = await transaction.query<InviteAcceptRow>(
        `SELECT id, join_mode, state
           FROM session_invites
          WHERE token_hash = $1`,
        [tokenHash],
      );
      const inviteRow: InviteAcceptRow | undefined = inviteProbe.rows[0];
      if (inviteRow === undefined) {
        // A well-formed token under our active key whose hash matches no row:
        // not an invite this service persisted (or already hard-deleted). Same
        // not-found surface as a decrypt failure.
        throw new InviteNotFoundException(
          "InviteService.acceptInvite: no invite matches the presented token.",
        );
      }

      // (5) Expiry FIRST — "regardless of database state" (line 112). An
      // expired token throws expiry even if the row is still `pending`, and
      // even if it were revoked/accepted.
      if (isExpiredClaim(claims.expires_at, now)) {
        throw new InviteExpiredException(
          `InviteService.acceptInvite: invite ${inviteRow.id} expired at ${claims.expires_at} (Spec-002 line 112).`,
        );
      }

      // (6) Single-use atomicity (line 109). The conditional UPDATE claims the
      // invite iff it is still `pending`; RETURNING confirms THIS call won the
      // transition. No read-then-write TOCTOU gap.
      const claimUpdate = await transaction.query<{ id: string }>(
        `UPDATE session_invites
            SET state = 'accepted'
          WHERE id = $1 AND state = 'pending'
        RETURNING id`,
        [inviteRow.id],
      );
      if (claimUpdate.rows[0] === undefined) {
        // Zero rows updated -> the invite was NOT pending. Re-classify by the
        // row state read above (under the session lock, so it cannot have
        // changed since): revoked -> revoked error (P2, no membership mutation
        // because we throw before the INSERT); otherwise already-accepted (P4).
        if (inviteRow.state === "revoked") {
          throw new InviteRevokedException(
            `InviteService.acceptInvite: invite ${inviteRow.id} has been revoked (Spec-002 line 139).`,
          );
        }
        // A persisted `expired` row reclassifies to expiry, not already-accepted
        // (the `session_invites.state` CHECK admits 'expired' — see
        // migrations/0002-session-invites.ts). This branch is LATENT until a
        // DB-side expiry sweep lands: today the claim-authoritative expiry check
        // above (Spec-002 line 112) fires first, so no `expired` row is reachable
        // at runtime. It exists so the reclassification stays complete — an
        // expired row surfaces invite.expired, never invite.already_accepted.
        if (inviteRow.state === "expired") {
          throw new InviteExpiredException(
            `InviteService.acceptInvite: invite ${inviteRow.id} is in a persisted expired state (Spec-002 line 112).`,
          );
        }
        throw new InviteAlreadyAcceptedException(
          `InviteService.acceptInvite: invite ${inviteRow.id} has already been accepted (Spec-002 line 109).`,
        );
      }

      // (7) Create OR ACTIVATE the membership in the SAME transaction (AC1,
      // Spec-002 line 42 "Accepting an invite must create or activate
      // membership"). Three cases, all handled by one upsert:
      //   * No existing row -> INSERT (state='active', role=join_mode).
      //   * Existing row NOT active (pending/suspended/revoked) -> ACTIVATE:
      //     state->'active', role->join_mode. This is the legitimate
      //     re-join-with-a-NEW-invite case (consistent with P8: a revoked
      //     participant needs a new invite, and this is that path).
      //   * Existing row ALREADY active -> PRESERVE role + state. The accept
      //     path must NEVER downgrade an already-active membership: doing so
      //     could demote the sole active owner (e.g. an owner who happens to
      //     accept a `collaborator` invite for their own session) and drop the
      //     session to zero active owners — the unrecoverable state I-002-2
      //     forbids, which the owner-only guard in
      //     MembershipService.updateMembership cannot catch because this path
      //     bypasses it. The `role` CASE preserves the existing role for an
      //     active row and applies `join_mode` ONLY when reactivating an
      //     inactive one; `state = 'active'` is unconditional (a no-op for an
      //     already-active row).
      //
      // This deliberately does NOT mirror createSession/joinSession's
      // `DO UPDATE SET updated_at = session_memberships.updated_at` no-op
      // preserve (session-directory-service.ts:445-446, :676-677): those paths
      // never change role/state on conflict, whereas accept MUST be able to
      // activate an inactive membership. The shared, load-bearing property is
      // "never clobber an active row's role"; accept additionally activates
      // inactive rows. `joined_at` is stamped on activation and preserved when
      // already set.
      const membershipUpsert = await transaction.query<{
        id: string;
        session_id: string;
        participant_id: string;
        role: string;
        state: string;
      }>(
        `INSERT INTO session_memberships (session_id, participant_id, role, state, joined_at)
         VALUES ($1, $2, $3, 'active', now())
         ON CONFLICT (session_id, participant_id) DO UPDATE
            SET role = CASE
                         WHEN session_memberships.state = 'active' THEN session_memberships.role
                         ELSE EXCLUDED.role
                       END,
                state = 'active',
                joined_at = COALESCE(session_memberships.joined_at, now()),
                updated_at = now()
         RETURNING id, session_id, participant_id, role, state`,
        [claims.session_id, acceptingParticipantId, inviteRow.join_mode],
      );
      const membershipRow = membershipUpsert.rows[0];
      if (membershipRow === undefined) {
        throw new Error(
          `InviteService.acceptInvite: session_memberships upsert returned no row for invite ${inviteRow.id} (session=${claims.session_id}, participant=${String(acceptingParticipantId)}).`,
        );
      }

      return {
        inviteId: inviteRow.id as InviteId,
        membershipId: membershipRow.id as MembershipId,
        sessionId: membershipRow.session_id as SessionId,
        participantId: membershipRow.participant_id as ParticipantId,
        role: membershipRow.role as MembershipRole,
        state: membershipRow.state as MembershipState,
      };
    });
  }

  /**
   * Revoke an invite — owner-authorized (Spec-002 line 142), STATE-ONLY.
   *
   * Flow:
   *   1. Validate the full `InviteRevoke` input at the trust boundary
   *      (`InviteRevokeSchema.parse`), mirroring `createInvite`. This PARSES
   *      `reason` (the contract carries it for the deferred Tier-4 audit
   *      event), but `reason` is NOT persisted and NOT emitted — there is no
   *      column for it and no Phase 2 event to carry it.
   *   2. Under one transaction: lock the parent session row, verify the actor
   *      holds active `owner` membership in that session (Spec-002 line 142,
   *      owner-only — same active-owner gate
   *      `MembershipService.updateMembership` uses), then
   *      `UPDATE session_invites SET state = 'revoked' WHERE id = $1 AND
   *      session_id = $2` (line 138, immediacy). The `session_id` predicate
   *      ties the invite to the session whose ownership was just checked, so a
   *      caller cannot revoke an invite from a session they do not own by
   *      naming a mismatched `sessionId`.
   *
   * STATE-ONLY, emit NOTHING: per ADR-017 the control plane has no event log.
   * The `invite.revoked` audit event is deferred to Plan-006 Tier 4 per
   * CP-002-6; this method writes only the `state` column. No `revoked_by` /
   * `revoked_at` / `reason` column exists or is written.
   *
   * P8: because a revoked invite can never be accepted (`acceptInvite` throws
   * `invite.revoked`), a revoked participant cannot re-join without a NEW
   * invite — this state transition is the durable enforcement point.
   *
   * @param actorParticipantId the participant requesting the revocation.
   *   `InviteRevoke` carries no actor field (Spec-002 line 82 shape is
   *   `{sessionId, inviteId, reason?}`), so identity is passed explicitly,
   *   mirroring `MembershipService.updateMembership`.
   * @returns the post-revoke invite projection, or `null` if no invite matches
   *   `(inviteId, sessionId)` (the wire layer surfaces a typed not-found).
   */
  async revokeInvite(
    actorParticipantId: ParticipantId,
    input: InviteRevoke,
  ): Promise<InviteRevokeResponse | null> {
    // (1) Trust-boundary validation. `reason` is parsed (and length/whitespace
    // checked by its Zod schema) but deliberately NOT read past this point:
    // Phase 2 persists/emits nothing for it.
    const validated: InviteRevoke = InviteRevokeSchema.parse(input);

    return this.#querier.transaction(async (transaction) => {
      // Lock the parent session row FIRST (I-002-4 canonical order). Held
      // across the ownership check and the state mutation so a concurrent
      // ownership change cannot race the authorization gate.
      await transaction.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [
        validated.sessionId,
      ]);

      // Owner-authorization (Spec-002 line 142). Same active-owner predicate
      // MembershipService.updateMembership uses: the actor must hold a
      // `session_memberships` row in THIS session with role 'owner' and state
      // 'active'. A non-owner (or a non-member) is denied before any mutation.
      const actorProbe = await transaction.query<{ role: string; state: string }>(
        `SELECT role, state FROM session_memberships
          WHERE session_id = $1 AND participant_id = $2`,
        [validated.sessionId, actorParticipantId],
      );
      const actorRow: { role: string; state: string } | undefined = actorProbe.rows[0];
      const actorIsActiveOwner: boolean =
        actorRow !== undefined && actorRow.role === "owner" && actorRow.state === "active";
      if (!actorIsActiveOwner) {
        throw new InvitePermissionDeniedException(
          `InviteService.revokeInvite: participant ${String(actorParticipantId)} is not an active owner of session ${String(validated.sessionId)}; only the session owner may revoke invites (Spec-002 line 142).`,
        );
      }

      // STATE-ONLY transition (line 138, immediacy). The `session_id` predicate
      // ties the invite to the just-authorized session. No `reason` column is
      // written; no event is emitted (ADR-017).
      const revokeUpdate = await transaction.query<{ id: string; state: string }>(
        `UPDATE session_invites
            SET state = 'revoked'
          WHERE id = $1 AND session_id = $2
        RETURNING id, state`,
        [validated.inviteId, validated.sessionId],
      );
      const revokedRow: { id: string; state: string } | undefined = revokeUpdate.rows[0];
      if (revokedRow === undefined) {
        // No invite with this id in this session. The wire layer maps `null`
        // to a typed not-found; an owner revoking a non-existent / cross-session
        // invite id is not an authorization failure.
        return null;
      }

      return {
        inviteId: revokedRow.id as InviteId,
        state: revokedRow.state as InviteState,
      };
    });
  }
}

// --------------------------------------------------------------------------
// pg.Pool -> InviteService factory (mirrors createSessionDirectoryServiceFromPool)
// --------------------------------------------------------------------------
//
// Convenience one-liner for production wiring: composes a `Querier` from a
// `pg.Pool` via the shared `createPgPoolQuerier` adapter Plan-001 owns and
// constructs the service in one call, mirroring
// `createSessionDirectoryServiceFromPool`. The `keyRing` is supplied by the
// caller (Plan-018 wires the persisted key store); this factory does NOT
// construct or default a key ring — the v4.local key material is always
// injected, never minted here.

/**
 * Compose an `InviteService` from a `pg.Pool` and a `KeyRing`.
 *
 * The pool is wrapped by the same `createPgPoolQuerier` adapter the session
 * directory service uses, so the invite issuance write inherits the held-
 * client transaction semantics (BEGIN/COMMIT/ROLLBACK on one connection)
 * Plan-001 documents on that adapter.
 */
export function createInviteServiceFromPool(pool: Pool, keyRing: KeyRing): InviteService {
  return new InviteService(createPgPoolQuerier(pool), keyRing);
}
