// Invite contracts — request/response payloads for Plan-002 Phase 1 (invite
// issuance, acceptance, and revocation). These shapes implement the wire
// surface described in Spec-002 §Interfaces And Contracts (lines 78-89).
//
// Branded ID pattern mirrors session.ts (`SessionId`, `ParticipantId`, …):
// runtime is a plain UUID string, the brand is a TypeScript-only nominal type
// per docs/architecture/contracts/api-payload-contracts.md § Branded ID Types.
//
// `isolatedDeclarations: true` (from tsconfig.base.json via packages/contracts
// /tsconfig.json) forbids inferred types on exported declarations — every
// exported schema is explicitly annotated. The branded-UUID cast pattern that
// bridges Zod's single-T `$ZodBranded` output to the double-T `z.ZodType<T, T>`
// shape required for Standard-Schema-V1 input inference in tRPC v11 (ADR-014)
// is encapsulated in `./internal/branded.ts` (`brandedUuidIdSchema<T>`).
//
// JoinMode — canonical enum imported from presence.ts:
//   `JoinMode` / `JoinModeSchema` is the canonical enum consumed by
//   `InviteCreate.joinMode` (this file). It is declared in presence.ts
//   because the canonical wire-doc authority for `JoinMode` lives in
//   `api-payload-contracts.md` §Presence (line 120) adjacent to the
//   `JoinMode` definition; the spec reference is Spec-002 line 45. The
//   SPACED wire form `"runtime contributor"` is preserved verbatim from
//   api-payload-contracts.md line 117, mirroring the `MembershipRole`
//   enum in session.ts:153. Editing to `runtime_contributor` /
//   `runtimeContributor` is a contract break and requires the spec edit
//   FIRST per AGENTS.md "doc-first ordering".
//
//   `docs/specs/024-cross-node-dispatch-and-approval.md:96` independently
//   uses a snake_case form for `session_role`; that spec is owned by Plan-027
//   (cross-node dispatch) and the namespace collision is reconciled there.
//
// Refs: Spec-002 §Interfaces And Contracts (lines 78-89), §Token Security
// Properties (lines 107-113), Plan-002 Phase 1, ADR-018 (versioning),
// ADR-022 (toolchain — Zod 4.x).
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { JoinModeSchema, type JoinMode } from "./presence.js";
import {
  MembershipIdSchema,
  MembershipRoleSchema,
  MembershipStateSchema,
  ParticipantIdSchema,
  SessionIdSchema,
  wireFreeFormString,
  type MembershipId,
  type MembershipRole,
  type MembershipState,
  type ParticipantId,
  type SessionId,
} from "./session.js";

// --------------------------------------------------------------------------
// Branded ID schemas
// --------------------------------------------------------------------------
//
// `InviteId` mirrors the `SessionId` shape from session.ts:
//   type InviteId = string & { readonly __brand: "InviteId" };
// Runtime is an RFC 9562 UUID (any version — daemon-emitted v7 sortable
// IDs and admin-provisioned v4 IDs are both valid, see session.ts header).

export type InviteId = string & { readonly __brand: "InviteId" };
export const InviteIdSchema: z.ZodType<InviteId, InviteId> =
  brandedUuidIdSchema<InviteId>("InviteId");

// --------------------------------------------------------------------------
// InviteState — invite lifecycle enum (Spec-002 line 43)
// --------------------------------------------------------------------------
//
// Lifecycle states are EXACTLY `{pending, accepted, revoked, expired}`.
// Declining is implicit in V1 (the invitee simply does not click the
// shareable link); there is no explicit `declined` state in V1.
// Adding `declined` here is a contract break and requires a spec edit
// (Spec-002 line 43) FIRST per AGENTS.md "doc-first ordering".

export type InviteState = "pending" | "accepted" | "revoked" | "expired";
export const InviteStateSchema: z.ZodType<InviteState> = z.enum([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

// --------------------------------------------------------------------------
// Defense-in-depth length caps
// --------------------------------------------------------------------------
//
// `INVITE_REVOKE_REASON_MAX_LEN` — user-supplied free-form string. 512 chars
// matches the order of magnitude of other free-form fields (channel names cap
// at 128, identity handles at 64); reasons can be longer because they may
// include short audit prose ("revoked: contractor offboarded 2026-05-21").
//
// `INVITE_TOKEN_MAX_LEN` — opaque PASETO v4.local token cap. A real PASETO
// v4.local with the Spec-002 payload (`{session_id, inviter_id, join_mode,
// expires_at, jti}`) runs ~300-500 chars; 4096 is generous slack to absorb
// future payload growth without ratcheting the cap downstream. The framework
// body-size cap (owned by Plan-004/Plan-005) is the authoritative limit.
export const INVITE_REVOKE_REASON_MAX_LEN = 512;
export const INVITE_TOKEN_MAX_LEN = 4096;

// --------------------------------------------------------------------------
// InviteCreate — Spec-002 line 80
// --------------------------------------------------------------------------
//
// "`InviteCreate` must include session id, inviter, proposed join mode, and
// expiry." — Spec-002 line 80. The four required fields are:
//   * sessionId — the session being invited into
//   * inviter   — the participant issuing the invite
//   * joinMode  — proposed join mode (see JoinModeSchema, imported from presence.ts)
//   * expiresAt — invite expiry timestamp (default `7d`, per Spec-002 line 56)
//
// `expiresAt` matches the ISO 8601 convention from session.ts
// (`z.iso.datetime({ offset: true })`) — wire form is a string, not a
// `Date`. RFC 3339 §5.6 offsets (`"+00:00"`, `"-05:00"`) are accepted
// alongside the Z-suffixed UTC form. Canonical normalization for hashing
// remains the responsibility of Plan-006.

export interface InviteCreate {
  sessionId: SessionId;
  inviter: ParticipantId;
  joinMode: JoinMode;
  expiresAt: string;
}
// `z.ZodType<T, T>` — see SessionCreateRequestSchema in session.ts.
export const InviteCreateSchema: z.ZodType<InviteCreate, InviteCreate> = z
  .object({
    sessionId: SessionIdSchema,
    inviter: ParticipantIdSchema,
    joinMode: JoinModeSchema,
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// --------------------------------------------------------------------------
// InviteAccept — Spec-002 lines 81, 107-113
// --------------------------------------------------------------------------
//
// "`InviteAccept` must create active membership and emit participant join
// events." — Spec-002 line 81. The wire request carries ONLY the opaque
// PASETO v4.local token (per Spec-002 §Token Security Properties lines
// 107-113); the service layer is responsible for token decoding, signature
// verification, expiry enforcement, and single-use atomicity. No token-
// handling logic belongs at the contract layer.
//
// The token field uses a plain `z.string()` rather than `wireFreeFormString`
// because the PASETO token is a producer-supplied base64url-encoded blob, NOT
// a user-typed string. The `wireFreeFormString` whitespace + NUL guards exist
// to catch obvious garbage from human-entered fields; they do not apply to
// machine-generated tokens. The length cap (`INVITE_TOKEN_MAX_LEN = 4096`) is
// defense in depth — the framework body-size cap is the authoritative limit.

export interface InviteAccept {
  token: string;
}
// `z.ZodType<T, T>` — see SessionCreateRequestSchema in session.ts.
export const InviteAcceptSchema: z.ZodType<InviteAccept, InviteAccept> = z
  .object({
    token: z.string().min(1).max(INVITE_TOKEN_MAX_LEN),
  })
  .strict();

// --------------------------------------------------------------------------
// InviteRevoke — Spec-002 line 82
// --------------------------------------------------------------------------
//
// Exact wire shape (verbatim from Spec-002 line 82):
//   `{sessionId: SessionId, inviteId: InviteId, reason?: string}`
//
// The optional `reason` field is a user-supplied free-form string captured
// for the audit log (Spec-002 §Invite Revocation, line 141: "Revocation
// events are recorded in session history for audit"). `wireFreeFormString`
// applies the standard trust-boundary checks (length cap, whitespace-only
// rejection, NUL-byte rejection) — same stance applied to `identityHandle`
// and `ChannelSummary.name` in session.ts.
//
// `.strict()` rejects unknown keys at parse time, surfacing schema drift
// early — matches the convention used by every other request schema in
// session.ts (SessionCreateRequest, SessionReadRequest, SessionJoinRequest,
// SessionSubscribeRequest).

export interface InviteRevoke {
  sessionId: SessionId;
  inviteId: InviteId;
  reason?: string | undefined;
}
// `z.ZodType<T, T>` — see SessionCreateRequestSchema in session.ts.
export const InviteRevokeSchema: z.ZodType<InviteRevoke, InviteRevoke> = z
  .object({
    sessionId: SessionIdSchema,
    inviteId: InviteIdSchema,
    reason: wireFreeFormString(INVITE_REVOKE_REASON_MAX_LEN, "InviteRevoke.reason").optional(),
  })
  .strict();

// --------------------------------------------------------------------------
// Response payloads — canonical home for the invite-mutation responses
// --------------------------------------------------------------------------
//
// These are the wire RESPONSES the control-plane invite service returns. They
// land here (the contracts package) so the producer (`@ai-sidekicks/control-
// plane` InviteService) and the SDK consumer (Plan-002 Phase 5 client SDK)
// share ONE source of truth instead of duplicating local interfaces. The
// as-built Phase 2 shapes (invite-service.ts:267-305, shipped in PR #105) are
// the canonical field sets; `api-payload-contracts.md §Tier 2` is amended up
// to match in the same change.
//
// Annotation posture (matches channels.ts, the Plan-002 Phase 1 sibling, NOT
// the single-T session.ts responses): every response schema is the double-T
// `z.ZodType<T, T>` shape so tRPC v11's Standard-Schema-V1 INPUT inference
// resolves to T and not `unknown` at consumer sites (per ADR-014). These
// schemas are non-transforming (no `.transform()` / `.coerce()` /
// `.preprocess()`), so pre-validation Input ≡ post-validation Output ≡ T;
// the explicit double-T preserves that equivalence on the type surface. The
// `.strict()` modifier rejects unknown keys at parse time, surfacing schema
// drift early — universal across every response schema in this package
// (SessionCreateResponse, ChannelListResponse, …).

// --------------------------------------------------------------------------
// InviteCreateResponse — api-payload-contracts.md §Tier 2 (createInvite)
// --------------------------------------------------------------------------
//
// `{inviteId, token, expiresAt}`. The `token` is the PLAINTEXT PASETO v4.local
// string handed to the caller exactly once for out-of-band link delivery
// (Spec-002 §Invite Delivery); only its SHA-256 hash is persisted (Spec-002
// line 111). The token is a producer-supplied base64url blob, so it uses a
// plain `z.string()` (NOT `wireFreeFormString`) — same stance as the
// `InviteAccept.token` request field above. `expiresAt` matches the ISO 8601
// convention used by `InviteCreate.expiresAt` (`z.iso.datetime({ offset:
// true })`, RFC 3339 §5.6 offsets accepted alongside the Z-suffixed UTC form).

export interface InviteCreateResponse {
  inviteId: InviteId;
  token: string;
  expiresAt: string;
}
// `z.ZodType<T, T>` — see the response-payloads header above (double-T per
// channels.ts / ADR-014).
export const InviteCreateResponseSchema: z.ZodType<InviteCreateResponse, InviteCreateResponse> = z
  .object({
    inviteId: InviteIdSchema,
    token: z.string().min(1).max(INVITE_TOKEN_MAX_LEN),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// --------------------------------------------------------------------------
// InviteAcceptResponse — api-payload-contracts.md §Tier 2 (acceptInvite)
// --------------------------------------------------------------------------
//
// SIX fields: `{inviteId, membershipId, sessionId, participantId, role,
// state}`. The accept path returns BOTH the invite that was consumed and the
// membership that was activated, so the wire layer can confirm the invite
// transition AND the resulting membership to the caller (invite-service.ts:
// 284-291).
//
// `state` IS THE MEMBERSHIP'S STATE (`MembershipState`) — the lifecycle state
// of the newly-created `session_memberships` row (invite-service.ts:290),
// which the accept path activates to `active`. This is DELIBERATELY a
// different enum from `InviteRevokeResponse.state` below (which is the
// INVITE's `InviteState`). `role` is the membership's `MembershipRole`.

export interface InviteAcceptResponse {
  inviteId: InviteId;
  membershipId: MembershipId;
  sessionId: SessionId;
  participantId: ParticipantId;
  role: MembershipRole;
  state: MembershipState;
}
// `z.ZodType<T, T>` — see the response-payloads header above (double-T per
// channels.ts / ADR-014). The `as unknown as z.ZodType<T, T>` cast bridges the
// underlying `z.ZodObject<...>` (whose `_input.role` / `_input.state` resolve
// to `unknown` because `MembershipRoleSchema` / `MembershipStateSchema` from
// session.ts are the single-T `z.ZodType<T>` form) to the double-T target
// required for Standard-Schema-V1 input inference at tRPC v11 consumer sites.
// Same bridge pattern as `ChannelListResponseChannelSchema` (channels.ts:237);
// re-wrapping the shared enum schemas locally would diverge from session.ts.
export const InviteAcceptResponseSchema: z.ZodType<InviteAcceptResponse, InviteAcceptResponse> = z
  .object({
    inviteId: InviteIdSchema,
    membershipId: MembershipIdSchema,
    sessionId: SessionIdSchema,
    participantId: ParticipantIdSchema,
    role: MembershipRoleSchema,
    // `MembershipState` — the activated membership's state, NOT `InviteState`.
    // See the interface comment above for why these two response `state`
    // fields bind different enums.
    state: MembershipStateSchema,
  })
  .strict() as unknown as z.ZodType<InviteAcceptResponse, InviteAcceptResponse>;

// --------------------------------------------------------------------------
// InviteRevokeResponse — api-payload-contracts.md §Tier 2 (revokeInvite)
// --------------------------------------------------------------------------
//
// STATE-ONLY: `{inviteId, state}`. The response carries the invite id and its
// new lifecycle state (`'revoked'`); there is no `reason` / `revokedBy` /
// `revokedAt` field because no such column exists and no audit event is
// emitted in Phase 2 (invite-service.ts:296-305 — the `invite.revoked` audit
// event is deferred to Plan-006 Tier 4 per CP-002-6).
//
// `state` IS THE INVITE'S STATE (`InviteState`, the `InviteStateSchema`
// declared earlier in this file) — the invite's lifecycle state, NOT a
// `MembershipState`. Contrast `InviteAcceptResponse.state` above, which binds
// `MembershipState`. The two enums share the literal `"revoked"` but are
// otherwise distinct ({pending, accepted, revoked, expired} vs {pending,
// active, suspended, revoked}); conflating them at the schema layer would
// admit invalid wire values on either response.
//
// NOT-FOUND IS A TYPED WIRE ERROR, NOT A NULLABLE RESULT. This schema models
// the SUCCESS projection only; the non-nullable shape is deliberate. When no
// invite matches `(inviteId, sessionId)`, the control-plane `revokeInvite`
// returns an internal `null` sentinel (its own documented contract: see the
// `@returns ... null ...` docstring at invite-service.ts:828-829 and the
// "The wire layer maps `null` to a typed not-found" comment at invite-
// service.ts:884-885) that the wire/daemon layer translates to a typed
// `invite.not_found` error (error-contracts.md §Invite) — delivered as a
// JSON-RPC error envelope, never as a `result: null`. A daemon-bridge author
// must therefore never emit `result: null` against this schema.

export interface InviteRevokeResponse {
  inviteId: InviteId;
  state: InviteState;
}
// `z.ZodType<T, T>` — see the response-payloads header above (double-T per
// channels.ts / ADR-014). The `as unknown as z.ZodType<T, T>` cast bridges the
// underlying `z.ZodObject<...>` (whose `_input.state` resolves to `unknown`
// because this file's `InviteStateSchema` declared earlier is the single-T
// `z.ZodType<InviteState>` form) to the double-T target required for
// Standard-Schema-V1 input inference at tRPC v11 consumer sites. Same bridge
// pattern as `ChannelListResponseChannelSchema` (channels.ts:237).
export const InviteRevokeResponseSchema: z.ZodType<InviteRevokeResponse, InviteRevokeResponse> = z
  .object({
    inviteId: InviteIdSchema,
    // `InviteState` (this file's `InviteStateSchema`), NOT `MembershipState`.
    state: InviteStateSchema,
  })
  .strict() as unknown as z.ZodType<InviteRevokeResponse, InviteRevokeResponse>;
