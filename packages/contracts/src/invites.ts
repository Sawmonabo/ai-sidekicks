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
// JoinMode — local-inline form (NOT canonical):
//   T1.3 (Phase 1 presence task) will ship the canonical `JoinModeSchema`
//   in `presence.ts`. T1.1 cannot import from `presence.ts` (it does not
//   exist on this branch yet), so we declare a LOCAL inline enum here
//   matching the SPACED wire form from Spec-002 line 45 and the canonical
//   `MembershipRole` enum in session.ts:153 (api-payload-contracts.md:117).
//   A later Phase-2 service-layer task will reconcile by having
//   `InviteCreate` reference the canonical `JoinModeSchema` instead.
//
//   Forward-looking reconciliation note (out of scope for this PR):
//   `docs/specs/024-cross-node-dispatch-and-approval.md:96` independently
//   uses a snake_case form for `session_role`. That spec is owned by
//   Plan-027 (cross-node dispatch) and the namespace collision should be
//   reconciled there, not in Plan-002.
//
// Refs: Spec-002 §Interfaces And Contracts (lines 78-89), §Token Security
// Properties (lines 107-113), Plan-002 Phase 1, ADR-018 (versioning),
// ADR-022 (toolchain — Zod 4.x).
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import {
  ParticipantIdSchema,
  SessionIdSchema,
  wireFreeFormString,
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
// InviteJoinMode (local-inline; see file header for T1.3 reconciliation note)
// --------------------------------------------------------------------------
//
// Spaced wire form matches the canonical `MembershipRole` enum in
// session.ts (line 153) and the prose phrase in Spec-002 line 45. The
// spaced literal is preserved verbatim from api-payload-contracts.md
// line 117 — see session.ts header for the contract-break rationale.

export type InviteJoinMode = "viewer" | "collaborator" | "runtime contributor";
// `z.ZodType<T, T>` (double-T) — preserves Standard-Schema-V1 input inference
// when composed inside `InviteCreateSchema` (a tRPC v11 request schema per
// ADR-014). Non-transforming `z.enum(...)` has Input ≡ Output ≡ T at runtime.
const InviteJoinModeSchema: z.ZodType<InviteJoinMode, InviteJoinMode> = z.enum([
  "viewer",
  "collaborator",
  "runtime contributor",
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
//   * joinMode  — proposed join mode (see InviteJoinModeSchema above)
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
  joinMode: InviteJoinMode;
  expiresAt: string;
}
// `z.ZodType<T, T>` — see SessionCreateRequestSchema in session.ts.
export const InviteCreateSchema: z.ZodType<InviteCreate, InviteCreate> = z
  .object({
    sessionId: SessionIdSchema,
    inviter: ParticipantIdSchema,
    joinMode: InviteJoinModeSchema,
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
