// InviteService — Plan-002 Phase 2 (T2.1, issuance path).
//
// Responsibilities (this task, T2.1):
//   * createInvite — mint a PASETO v4.local invite token whose payload is
//                    `{session_id, inviter_id, join_mode, expires_at, jti}`
//                    (Spec-002 §Token Security Properties line 113), then
//                    INSERT a `session_invites` row carrying ONLY the SHA-256
//                    hash of the token (line 111 — plaintext is never
//                    persisted) with `state = 'pending'`. Returns the
//                    plaintext token to the caller exactly once for out-of-band
//                    link delivery (Spec-002 §Invite Delivery).
//
// What this service does NOT do yet (deferred to T2.2, SAME file):
//   * acceptInvite — token decode, v4.local MAC verification, expiry
//     enforcement, and single-use atomicity (`pending` -> `accepted`).
//   * revokeInvite — owner-only `pending` -> `revoked` transition + audit.
//   * expiry-validation on access (Spec-002 line 112).
//   These land in T2.2; this module is structured (service class +
//   constructor-injected deps + transactional write) so T2.2 extends it
//   without rewriting the issuance path. The single-statement INSERT is
//   wrapped in `Querier.transaction(...)` now precisely so T2.2's
//   accept/revoke flows — which need a count-then-mutate or lock-then-mutate
//   sequence under one commit boundary — slot in against the same primitive.
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
// Cross-plan / cross-task boundaries (DO NOT CROSS in T2.1):
//   * `session_invites` table DDL — owned by `migrations/0002-session-invites.ts`
//     (Plan-002 Phase 1). This service only INSERT/SELECTs rows; it never
//     ALTERs the schema.
//   * `session_memberships` mutation on accept — Plan-002 owns it, but the
//     accept flow itself is T2.2, not T2.1. Issuance creates an invite row
//     only; no membership row is written here.
//   * Rate limiting (Spec-002 §Rate Limiting) — not an issuance-correctness
//     concern; owned downstream (framework / Plan-005 surface). Not in T2.1.
//
// Refs: Spec-002 §Token Security Properties (lines 107-113), §Invite Delivery
// (lines 91-99), Plan-002 Phase 2, ADR-010 (PASETO auth stack).

import { createHash, randomBytes } from "node:crypto";

import type { InviteCreate, InviteId, JoinMode } from "@ai-sidekicks/contracts";
import { InviteCreateSchema } from "@ai-sidekicks/contracts";
import { encryptV4Local, type KeyRing } from "@ai-sidekicks/crypto-paseto";
import type { Pool } from "pg";

import { createPgPoolQuerier } from "../sessions/session-directory-service.js";
import type { Querier } from "../sessions/migration-runner.js";

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
