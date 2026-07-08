// InviteService — Plan-002 Phase 2 (T2.1 issuance + T2.2 accept/revoke).
//
// Responsibilities (T2.1, issuance path):
//   * createInvite — mint a PASETO v4.local invite token whose payload is
//                    `{session_id, inviter_id, join_mode, expires_at, jti}`
//                    (`Spec-002 §Token Security Properties`), then
//                    INSERT a `session_invites` row carrying ONLY the SHA-256
//                    hash of the token (hash storage — plaintext is never
//                    persisted) with `state = 'pending'`. Returns the
//                    plaintext token to the caller exactly once for out-of-band
//                    link delivery (Spec-002 §Invite Delivery).
//
// Responsibilities (T2.2, accept + revoke paths):
//   * acceptInvite — decrypt the presented PASETO v4.local token under the
//                    key ring's ACTIVE key, recover the claim payload, look up
//                    the `session_invites` row by SHA-256(token), enforce
//                    expiry (`Spec-002 §Token Security Properties`, claim is authoritative),
//                    revocation (`Spec-002 §Invite Revocation`), and single-use (`Spec-002 §Token Security Properties`) under
//                    ONE transaction, then transition `pending -> accepted`
//                    AND create the active `session_memberships` row in that
//                    same commit boundary (AC1).
//   * revokeInvite — owner-authorized (`Spec-002 §Invite Revocation`), STATE-ONLY
//                    transition `state -> 'revoked'` (immediacy).
//                    NO audit event is emitted and NO event log is written:
//                    per ADR-017 the control plane has NO event log, and the
//                    `invite.revoked` audit event is deferred to Plan-006
//                    Tier 4 (daemon-side) per CP-002-6. The Phase 2 deliverable
//                    is the coordination-state transition, full stop.
//   * Expiry validation (`Spec-002 §Token Security Properties`) is a shared helper consumed by the
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
//     gated on Plan-008-remainder Tier 5 relay sync) per CP-002-6;
//     `Spec-002 §Invite Revocation` is satisfied there, not in Phase 2.
//   * Rate limiting (Spec-002 §Rate Limiting) — not an issuance/accept
//     correctness concern; owned downstream (framework / Plan-005 surface).
//
// Refs: `Spec-002 §Token Security Properties`, `Spec-002 §Invite Delivery`,
// `Spec-002 §Invite Revocation`, Plan-002 Phase 2,
// ADR-010 (PASETO auth stack), ADR-017 (control plane has no event log),
// CP-002-6 (audit emission deferred to Tier 4).

import { createHash, randomBytes } from "node:crypto";

import type {
  InviteAccept,
  InviteAcceptResponse,
  InviteCreate,
  InviteCreateResponse,
  InviteId,
  InviteRevoke,
  InviteRevokeResponse,
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
// Typed errors — `Plan-002 §Phase 2 — Control-Plane Invite And Membership Services`.
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

/** Stable wire code for the single-use guard (`Spec-002 §Token Security Properties`). */
export const INVITE_ALREADY_ACCEPTED_CODE = "invite.already_accepted" as const;

/** Stable wire code for an accept against a revoked invite (`Spec-002 §Invite Revocation`). */
export const INVITE_REVOKED_CODE = "invite.revoked" as const;

/** Stable wire code for the expiry guard (`Spec-002 §Token Security Properties`). */
export const INVITE_EXPIRED_CODE = "invite.expired" as const;

/** Stable wire code for the owner-only revoke authorization (`Spec-002 §Invite Revocation`). */
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
 * `Spec-002 §Token Security Properties`: "Subsequent attempts to use the same token return an 'invite
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
 * invite (P8). `Spec-002 §Invite Revocation`: "A revoked token that is subsequently
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
 * (`Spec-002 §Token Security Properties`). The claim — not the DB `state` — is authoritative:
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
 * of the invite's session (`Spec-002 §Invite Revocation`, owner-only per
 * `docs/architecture/security-architecture.md §Permission Matrix (Task 5.4)`). The ownership check mirrors
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
// Token entropy — `Spec-002 §Token Security Properties`
// --------------------------------------------------------------------------
//
// "The PASETO payload includes 256-bit CSPRNG randomness (... `crypto.
// randomBytes(32)`)." 256 bits = 32 bytes. This randomness IS the `jti`
// claim (the §Token Security Properties unique-token bullet): the four other payload fields (`session_id`,
// `inviter_id`, `join_mode`, `expires_at`) are all caller-supplied semantic
// values, so `jti` is the ONLY field that can carry the spec's entropy
// floor. A UUID v4 `jti` would supply only 122 bits and fail the entropy
// floor; 32 CSPRNG bytes satisfy both §Token Security Properties bullets (entropy + unique token
// identifier for single-use / revocation lookup) in one field.
//
// The PASETO v4.local envelope's own per-call nonce (32 bytes, minted inside
// `encryptV4Local`) is a SEPARATE value protecting the ciphertext; it is not
// the `jti` and is never surfaced to the payload.
const TOKEN_ENTROPY_BYTES = 32;

// --------------------------------------------------------------------------
// Token claim payload — `Spec-002 §Token Security Properties`
// --------------------------------------------------------------------------
//
// `{session_id, inviter_id, join_mode, expires_at, jti}` — encrypted inside
// the PASETO v4.local envelope. Field names are snake_case to match the
// spec's verbatim wire-claim shape (§Token Security Properties); they are independent of the
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
// (`claims.expires_at`, authoritative per §Token Security Properties), so neither is selected
// here. Mirrors the `InviteRow` projection convention above.
interface InviteAcceptRow {
  readonly id: string;
  readonly join_mode: string;
  readonly state: string;
}

// `TIMESTAMPTZ` is hydrated as a JS `Date` by BOTH drivers' default parsers —
// `pg` (pg-types OID 1184) and PGlite (`types.ts` date parser). The contract
// requires ISO 8601 (`expiresAt: string`); the string arm keeps normalization
// total under custom parsers (mirrors `toIsoString` in session-directory-service.ts).
function toIsoString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return value;
}

// --------------------------------------------------------------------------
// Expiry validation (`Spec-002 §Token Security Properties`)
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
// shape `createInvite` encrypted, §Token Security Properties). A payload that does not parse to
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
   *   2. Generate 256-bit CSPRNG entropy as the `jti` (`Spec-002 §Token Security Properties`).
   *   3. Assemble the `{session_id, inviter_id, join_mode, expires_at, jti}`
   *      claim payload (`Spec-002 §Token Security Properties`), serialize to UTF-8 bytes, and encrypt
   *      with PASETO v4.local under the key ring's ACTIVE key. The plaintext
   *      claim bytes never leave this method; the returned token is the
   *      opaque encrypted envelope.
   *   4. Compute the SHA-256 hash of the token string (§Token Security
   *      Properties: only the hash is persisted) and INSERT
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
   * Hash-storage property (`Spec-002 §Token Security Properties`, verified by P5 in T2.2): the
   * `token_hash` column receives `SHA-256(token)` as a hex digest; the
   * plaintext `token` appears only in the return value and the in-memory
   * claim assembly, never in a SQL parameter. The `session_invites.token_hash`
   * UNIQUE constraint (Plan-002 Phase 1 migration) backs single-use semantics
   * that T2.2 enforces on accept.
   *
   * Owner-authorization (`docs/architecture/security-architecture.md §Permission Matrix (Task 5.4)`,
   * `Spec-002 §Invite Revocation` — "Invite participants" is owner-only): issuance is
   * gated on the AUTHENTICATED actor, NOT the body. The actor must hold an
   * active `owner` membership in the target session — the same active-owner
   * predicate `revokeInvite` / `MembershipService.updateMembership` use — so a
   * non-owner member (or non-member) cannot mint a token by supplying their
   * own participant id. The check runs inside the issuance transaction under
   * the parent session lock, BEFORE the INSERT, so a denied caller writes no
   * row. The body `inviter` field is informational (`Spec-002 §Interfaces And Contracts`) and must
   * EQUAL the authenticated actor: Spec-002 §Interfaces And Contracts defines
   * no delegated-issuance contract, so V1 binds the body `inviter` to the
   * authenticated actor and a mismatch is denied (this is distinct from the
   * owner-only authority above — it is an absence-of-delegation rule, not the
   * Permission Matrix). Once equality holds the existing claim / INSERT binding
   * already records the authenticated active owner, so both are left unchanged.
   *
   * @param actorParticipantId the AUTHENTICATED participant issuing the invite.
   *   `InviteCreate` carries an `inviter` field (`Spec-002 §Interfaces And Contracts`), but that
   *   field is attacker-controllable, so the issuing identity is passed
   *   explicitly and gated here, mirroring `revokeInvite` /
   *   `MembershipService.updateMembership`'s actor-as-parameter convention.
   */
  async createInvite(
    actorParticipantId: ParticipantId,
    input: InviteCreate,
  ): Promise<InviteCreateResponse> {
    // (1) Trust-boundary validation. Parse rather than trust the caller —
    // a service-layer fail-fast that surfaces schema drift before any token
    // material is generated or any row is written.
    const validated: InviteCreate = InviteCreateSchema.parse(input);

    // (2) 256-bit CSPRNG `jti` (`Spec-002 §Token Security Properties`). base64url keeps the
    // claim payload compact and URL-safe; the value is opaque single-use /
    // revocation-lookup identity, never parsed for structure.
    const jti: string = randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url");

    // (3) Assemble + encrypt the claim payload (`Spec-002 §Token Security Properties`). The
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

    // (4) Hash-storage (`Spec-002 §Token Security Properties`): persist ONLY SHA-256(token). The
    // plaintext `token` is never passed as a SQL parameter. Hex digest is the
    // canonical Postgres-text form for a hash and matches the repo's existing
    // `createHash(...).digest()` idiom (runtime-daemon session-projector.ts).
    const tokenHash: string = createHash("sha256").update(token).digest("hex");

    const inviteRow: InviteRow = await this.#querier.transaction(async (tx) => {
      // Lock the parent session row FIRST (I-002-4 canonical order
      // `sessions` -> `session_invites`/`session_memberships`). Held across the
      // ownership check and the INSERT so a concurrent ownership change cannot
      // race the authorization gate (same TOCTOU the revoke/accept paths
      // close). This MUST be the first statement in the transaction body; the
      // createInvite lock-ordering regression in
      // memberships/__tests__/lock-ordering.test.ts ("InviteService.createInvite
      // — lock-ordering") pins this session-before-ownership-probe order and
      // must not be inverted.
      await tx.query("SELECT id FROM sessions WHERE id = $1 FOR UPDATE", [validated.sessionId]);

      // Owner-authorization (`docs/architecture/security-architecture.md §Permission Matrix (Task 5.4)`,
      // `Spec-002 §Invite Revocation` — "Invite participants" is owner-only). Same
      // active-owner predicate revokeInvite / MembershipService.updateMembership
      // use: the actor must hold a `session_memberships` row in THIS session
      // with role 'owner' and state 'active'. The body `inviter` is
      // informational and attacker-controllable, so it is NOT trusted for
      // authorization; the AUTHENTICATED actor is. A non-owner (or non-member)
      // is denied before any row is written.
      const actorProbe = await tx.query<{ role: string; state: string }>(
        `SELECT role, state FROM session_memberships
          WHERE session_id = $1 AND participant_id = $2`,
        [validated.sessionId, actorParticipantId],
      );
      const actorRow: { role: string; state: string } | undefined = actorProbe.rows[0];
      const actorIsActiveOwner: boolean =
        actorRow !== undefined && actorRow.role === "owner" && actorRow.state === "active";
      if (!actorIsActiveOwner) {
        throw new InvitePermissionDeniedException(
          `InviteService.createInvite: participant ${String(actorParticipantId)} is not an active owner of session ${String(validated.sessionId)}; only the session owner may invite participants (security-architecture.md §Permission Matrix; Spec-002 §Invite Revocation).`,
        );
      }

      // Bind the claimed inviter to the AUTHENTICATED actor. The body `inviter`
      // is informational; V1 has no issuing-on-behalf-of-another, so it must
      // equal the actor. Once this holds, the claim assembly + INSERT binding
      // already record the authenticated active owner (left unchanged below).
      //
      // UUID casing is normalized on BOTH sides of this JS comparison because
      // the `ParticipantId` brand has no runtime case-validator and admits
      // either case (RFC 9562 §4) — the same normalization MembershipService
      // and SessionDirectoryService apply to their owner-mismatch guards.
      // (The owner-probe SELECT above is ALREADY case-insensitive: its
      // `participant_id = $2` predicate hits a Postgres `uuid` column, which
      // canonicalizes to lowercase at the type level — only this string
      // compare needs the explicit `.toLowerCase()`.)
      if (validated.inviter.toLowerCase() !== actorParticipantId.toLowerCase()) {
        throw new InvitePermissionDeniedException(
          `InviteService.createInvite: body inviter ${String(validated.inviter)} must equal the authenticated actor ${String(actorParticipantId)}; issuing an invite on behalf of another participant is not permitted in V1 (no delegated-issuance contract in Spec-002 §Interfaces And Contracts; V1 binds the body inviter to the authenticated actor).`,
        );
      }

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
   *   4. Compute `SHA-256(token)` and look up the row (§Token Security Properties: only the hash
   *      is stored, so lookup is by hash). No row -> not-found.
   *   5. Expiry (`Spec-002 §Token Security Properties`): the token's `expires_at` CLAIM — not the
   *      DB `state` — is authoritative. An expired claim throws
   *      `InviteExpiredException` regardless of DB state, BEFORE the
   *      revoked / single-use branches.
   *   6. Single-use atomicity (§Token Security Properties): a conditional
   *      `UPDATE ... SET state = 'accepted' WHERE id = $1 AND state = 'pending'
   *      RETURNING ...` claims the invite. A non-zero row count means THIS call
   *      won the transition (no TOCTOU gap between a read and the write). A
   *      zero-row update re-reads the row's state to pick the right typed
   *      error — `revoked` -> `InviteRevokedException` (P2, no membership
   *      mutation), `accepted` -> `InviteAlreadyAcceptedException` (P4).
   *   7. Membership create-or-activate (`Spec-002 §Required Behavior`): in the SAME
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
   *   invite. `InviteAccept` carries only the token (`Spec-002 §Interfaces And Contracts` — the
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

    // (4) Look up the row by SHA-256(token) (§Token Security Properties — only the hash is
    // stored). The plaintext token is never passed to SQL.
    const tokenHash: string = createHash("sha256").update(validated.token).digest("hex");

    // (5) Expiry is evaluated against the CLAIM (authoritative per §Token
    // Security Properties),
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

      // (5) Expiry FIRST — "regardless of database state" (§Token Security
      // Properties). An
      // expired token throws expiry even if the row is still `pending`, and
      // even if it were revoked/accepted.
      if (isExpiredClaim(claims.expires_at, now)) {
        throw new InviteExpiredException(
          `InviteService.acceptInvite: invite ${inviteRow.id} expired at ${claims.expires_at} (Spec-002 §Token Security Properties).`,
        );
      }

      // (6) Single-use atomicity (§Token Security Properties). The conditional UPDATE claims the
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
            `InviteService.acceptInvite: invite ${inviteRow.id} has been revoked (Spec-002 §Invite Revocation).`,
          );
        }
        // A persisted `expired` row reclassifies to expiry, not already-accepted
        // (the `session_invites.state` CHECK admits 'expired' — see
        // migrations/0002-session-invites.ts). This branch is LATENT until a
        // DB-side expiry sweep lands: today the claim-authoritative expiry check
        // above (`Spec-002 §Token Security Properties`) fires first, so no `expired` row is reachable
        // at runtime. It exists so the reclassification stays complete — an
        // expired row surfaces invite.expired, never invite.already_accepted.
        if (inviteRow.state === "expired") {
          throw new InviteExpiredException(
            `InviteService.acceptInvite: invite ${inviteRow.id} is in a persisted expired state (Spec-002 §Token Security Properties).`,
          );
        }
        throw new InviteAlreadyAcceptedException(
          `InviteService.acceptInvite: invite ${inviteRow.id} has already been accepted (Spec-002 §Token Security Properties).`,
        );
      }

      // (7) Create OR ACTIVATE the membership in the SAME transaction (AC1,
      // `Spec-002 §Required Behavior` "Accepting an invite must create or activate
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
   * Revoke an invite — owner-authorized (`Spec-002 §Invite Revocation`), STATE-ONLY.
   *
   * Flow:
   *   1. Validate the full `InviteRevoke` input at the trust boundary
   *      (`InviteRevokeSchema.parse`), mirroring `createInvite`. This PARSES
   *      `reason` (the contract carries it for the deferred Tier-4 audit
   *      event), but `reason` is NOT persisted and NOT emitted — there is no
   *      column for it and no Phase 2 event to carry it.
   *   2. Under one transaction: lock the parent session row, verify the actor
   *      holds active `owner` membership in that session (`Spec-002 §Invite Revocation`,
   *      owner-only — same active-owner gate
   *      `MembershipService.updateMembership` uses), then
   *      `UPDATE session_invites SET state = 'revoked' WHERE id = $1 AND
   *      session_id = $2 AND state = 'pending'` (`Spec-002 §Invite Revocation`, immediacy). The
   *      `session_id` predicate ties the invite to the session whose ownership
   *      was just checked, so a caller cannot revoke an invite from a session
   *      they do not own by naming a mismatched `sessionId`. The
   *      `state = 'pending'` predicate makes revoke a no-op on a row already in
   *      a TERMINAL state (accepted/revoked/expired, `Spec-002 §State And Data Implications`) — a
   *      revoke can never overwrite a durable terminal state (e.g. clobber an
   *      `accepted` row back to `revoked`, which would mask a created
   *      membership and mis-classify a token reuse as `invite.revoked`).
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
   *   `InviteRevoke` carries no actor field (`Spec-002 §Interfaces And Contracts` shape is
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

      // Owner-authorization (`Spec-002 §Invite Revocation`). Same active-owner predicate
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
          `InviteService.revokeInvite: participant ${String(actorParticipantId)} is not an active owner of session ${String(validated.sessionId)}; only the session owner may revoke invites (Spec-002 §Invite Revocation).`,
        );
      }

      // STATE-ONLY transition (§Invite Revocation immediacy). The `session_id` predicate
      // ties the invite to the just-authorized session. The `state = 'pending'`
      // predicate (mirroring acceptInvite's single-use guard) makes revoke a
      // no-op on a TERMINAL row, so it can never overwrite a durable
      // accepted/revoked/expired state (`Spec-002 §State And Data Implications`). No `reason` column
      // is written; no event is emitted (ADR-017).
      const revokeUpdate = await transaction.query<{ id: string; state: string }>(
        `UPDATE session_invites
            SET state = 'revoked'
          WHERE id = $1 AND session_id = $2 AND state = 'pending'
        RETURNING id, state`,
        [validated.inviteId, validated.sessionId],
      );
      const revokedRow: { id: string; state: string } | undefined = revokeUpdate.rows[0];
      if (revokedRow === undefined) {
        // Zero rows matched: either no invite with this id in this session, or
        // an invite no longer in the revocable `pending` state (already
        // accepted/revoked/expired — those are TERMINAL and durable per
        // `Spec-002 §State And Data Implications`, so revoke leaves them untouched). The wire layer
        // maps `null` to a typed not-found; an owner revoking a non-existent /
        // cross-session / already-terminal invite id is not an authorization
        // failure.
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
