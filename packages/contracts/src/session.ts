// Session contracts — request/response payloads and shared projection types
// for the Plan-001 vertical slice (SessionCreate / SessionRead / SessionJoin /
// SessionSubscribe). Exact field set mirrors the canonical TypeScript shapes in
// docs/architecture/contracts/api-payload-contracts.md § Tier 1 — Plan-001
// (verbatim — adding/removing/renaming a field here is a contract break and
// requires the spec edit first).
//
// ID format: `z.uuid()` accepts any RFC 9562 UUID. Daemon-assigned IDs are
// UUID v7 (sortable timestamp); admin-provisioned control-plane rows fall
// through PostgreSQL's `gen_random_uuid()` which emits v4. Contracts must
// accept both, so we deliberately do NOT pin to `z.uuidv7()`.
//
// Branded types (`SessionId`, `MembershipId`, …) provide compile-time
// nominal typing per api-payload-contracts.md §Branded ID Types — they
// prevent accidentally passing a `ParticipantId` where a `SessionId` was
// expected, even though both are strings at runtime.
//
// Refs: Spec-001 §Interfaces And Contracts, ADR-018 (versioning), ADR-022
// (toolchain — Zod 4.x).
import { z } from "zod";

import { SubscriptionIdSchema, type SubscriptionId } from "./jsonrpc-streaming.js";

// --------------------------------------------------------------------------
// Branded ID schemas
// --------------------------------------------------------------------------
//
// Brand declarations match docs/architecture/contracts/api-payload-contracts.md
// § Branded ID Types verbatim:
//   `type SessionId = string & { readonly __brand: "SessionId" };`
// This is a TypeScript-only nominal type — runtime is a plain UUID string.
// Two reasons we keep our own brand symbol rather than using `z.core.$brand`:
//
//   1. The spec's documented brand symbol is the structural shape we want
//      cross-package consumers to see (`packages/runtime-daemon`, `packages/
//      control-plane`, etc. read api-payload-contracts.md to verify their
//      type imports — making the consuming type structurally identical to
//      the doc's declaration eliminates a foot-gun).
//   2. Zod's `.brand<>()` produces a `$ZodBranded<>` schema whose `_output`
//      is the bare base type plus an internal symbol marker. That marker is
//      not structurally compatible with our `__brand` field, so we cast the
//      constructed schema to the public `z.ZodType<OurBrand>` shape — the
//      runtime parser remains correct, the public type stays nominal.
//
// All exported schemas are annotated to satisfy `isolatedDeclarations: true`
// from tsconfig.base.json (TS9010 — exported values must have explicit type
// annotations so downstream packages can type-emit without re-running
// whole-program inference).

export type SessionId = string & { readonly __brand: "SessionId" };
// `z.ZodType<T, T>` (vs. `z.ZodType<T>` whose Input slot defaults to `unknown`)
// preserves Standard-Schema-V1 input inference when this schema appears inside
// request schemas consumed by tRPC v11. The cast already discards Zod's
// internal branding details — extending the destination to carry both Output
// and Input is the same nominal-shape coercion.
export const SessionIdSchema: z.ZodType<SessionId, SessionId> = z
  .uuid()
  .brand<"SessionId">() as unknown as z.ZodType<SessionId, SessionId>;

export type ParticipantId = string & { readonly __brand: "ParticipantId" };
export const ParticipantIdSchema: z.ZodType<ParticipantId> = z
  .uuid()
  .brand<"ParticipantId">() as unknown as z.ZodType<ParticipantId>;

export type MembershipId = string & { readonly __brand: "MembershipId" };
export const MembershipIdSchema: z.ZodType<MembershipId> = z
  .uuid()
  .brand<"MembershipId">() as unknown as z.ZodType<MembershipId>;

export type ChannelId = string & { readonly __brand: "ChannelId" };
export const ChannelIdSchema: z.ZodType<ChannelId> = z
  .uuid()
  .brand<"ChannelId">() as unknown as z.ZodType<ChannelId>;

// EventCursor is opaque — wire form is a string but its internal structure
// (sequence + monotonic_ns) is owned by Plan-006. Plan-001 only needs to
// pass it through unchanged on `SessionRead.timelineCursors` and
// `SessionSubscribe.afterCursor`.
//
// We deliberately use `.min(1)` only — Plan-006 owns the cursor's internal
// format. The `.max(EVENT_CURSOR_MAX_LEN)` cap below is defense-in-depth
// against pathological lengths (mirrors the framework body-size cap pattern
// used elsewhere in this package). If Plan-006 later publishes a structural
// cursor format (e.g. `<sequence>_<monotonic_ns>`), tighten this regex; until
// then, any non-empty bounded string is accepted.
export const EVENT_CURSOR_MAX_LEN = 256;
export type EventCursor = string & { readonly __brand: "EventCursor" };
// `z.ZodType<T, T>` — see SessionIdSchema for rationale.
export const EventCursorSchema: z.ZodType<EventCursor, EventCursor> = z
  .string()
  .min(1)
  .max(EVENT_CURSOR_MAX_LEN)
  .brand<"EventCursor">() as unknown as z.ZodType<EventCursor, EventCursor>;

// --------------------------------------------------------------------------
// wireFreeFormString — defense-in-depth helper for free-form string fields.
// --------------------------------------------------------------------------
//
// Centralizes the trust-boundary checks applied to user/producer-supplied
// free-form strings on the wire. Three guards in one helper:
//
//   1. Length bounds: `.min(1)` rejects empty, `.max(maxLen)` caps the
//      pathological case (defense in depth — the HTTP/tRPC framework layer
//      owned by Plan-004/005 is the authoritative body-size enforcer).
//   2. Whitespace-only rejection: `.regex(/\S/)` requires at least one
//      non-whitespace character anywhere in the string. ASCII-whitespace
//      only — Unicode zero-width characters (U+200B/200C/200D/2060/FEFF)
//      bypass this regex by design. Plan-018 owns identity canonical form
//      including zero-width-character handling (see `R2-4 deferral` note in
//      PR #2 review thread); preempting Plan-018's grammar choices at the
//      wire layer would be wrong.
//   3. NUL-byte rejection: `\0` corrupts log lines / observability traces
//      (OpenTelemetry sees NUL as a string terminator) and creates
//      filesystem / log-injection vectors. The wire layer is exactly where
//      this trust boundary lives — we accept input from external (cross-
//      node, future RPC) callers and cannot rely on producer trust alone.
//
// Used by every wire-layer free-form string in this package. Not branded
// because the caller composes branding (e.g. `IdentityHandleSchema`) on
// top of it where applicable.
export const wireFreeFormString = (maxLen: number, fieldLabel: string): z.ZodString =>
  z
    .string()
    .min(1)
    .max(maxLen)
    .regex(/\S/, {
      message: `${fieldLabel} must contain at least one non-whitespace character.`,
    })
    .refine((s) => !s.includes("\0"), {
      message: `${fieldLabel} MUST NOT contain a NUL byte.`,
    });

// --------------------------------------------------------------------------
// Shared enums (api-payload-contracts.md § Shared Enums)
// --------------------------------------------------------------------------

export type SessionState =
  | "provisioning"
  | "active"
  | "archived"
  | "closed"
  | "purge_requested"
  | "purged";
export const SessionStateSchema: z.ZodType<SessionState> = z.enum([
  "provisioning",
  "active",
  "archived",
  "closed",
  "purge_requested",
  "purged",
]);

// "runtime contributor" includes the space — preserved verbatim from the
// canonical enum (api-payload-contracts.md line 99). This is the wire form;
// editing to "runtime_contributor" or similar is a contract break.
export type MembershipRole = "owner" | "viewer" | "collaborator" | "runtime contributor";
export const MembershipRoleSchema: z.ZodType<MembershipRole> = z.enum([
  "owner",
  "viewer",
  "collaborator",
  "runtime contributor",
]);

// `NonOwnerMembershipRole` is `MembershipRole` with `"owner"` excluded. Used
// at internal service boundaries (e.g. `JoinSessionInput.role` in
// `@ai-sidekicks/control-plane`) where a caller-supplied `owner` would
// represent a privilege-escalation path: BL-069 §4 binds owner identity at
// `createSession` time via TOFU, so any subsequent `joinSession` that admits
// `owner` would let any caller mint a second owner-membership row without
// going through Plan-002's promotion / elevation flow (UNIQUE(session_id,
// participant_id) keys on the (session, participant) PAIR, not on the role,
// so two distinct participants can both hold `owner` rows).
//
// No accompanying Zod schema: the wire surface (`SessionJoinRequest`) carries
// only `identityHandle: string` — there is no `role` field on the wire today,
// so there is no consumer for a `NonOwnerMembershipRoleSchema`. The type
// alias narrows the internal TypeScript surface (compile-time first defense);
// the service body's runtime guard (second defense) catches dynamic callers
// that bypass the type system. If a future wire contract gains a role field
// (e.g. invite-driven join in Plan-002), add the schema then alongside the
// new wire shape.
export type NonOwnerMembershipRole = Exclude<MembershipRole, "owner">;

export type MembershipState = "pending" | "active" | "suspended" | "revoked";
export const MembershipStateSchema: z.ZodType<MembershipState> = z.enum([
  "pending",
  "active",
  "suspended",
  "revoked",
]);

export type ChannelState = "active" | "muted" | "archived";
export const ChannelStateSchema: z.ZodType<ChannelState> = z.enum(["active", "muted", "archived"]);

// --------------------------------------------------------------------------
// Shared projection types
// --------------------------------------------------------------------------
//
// These are the read-side projections referenced from `SessionCreateResponse`
// and `SessionReadResponse`. Per the canonical spec they are strict shapes
// (the `.strict()` modifier rejects unknown keys at parse time, surfacing
// schema drift early).

// `z.ZodType<T, T>` — see SessionIdSchema for rationale (preserves Input
// inference when this helper composes into tRPC-consumed request schemas).
const RecordOfUnknownSchema: z.ZodType<Record<string, unknown>, Record<string, unknown>> = z.record(
  z.string(),
  z.unknown(),
);

export interface SessionSnapshot {
  id: SessionId;
  state: SessionState;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
export const SessionSnapshotSchema: z.ZodType<SessionSnapshot> = z
  .object({
    id: SessionIdSchema,
    state: SessionStateSchema,
    config: RecordOfUnknownSchema,
    metadata: RecordOfUnknownSchema,
    // ISO 8601 per api-payload-contracts.md §SessionSnapshot. Default
    // `z.iso.datetime()` accepts only Z-suffixed UTC; `{ offset: true }`
    // widens to the full RFC 3339 §5.6 spec (numeric offsets like
    // "+00:00", "-05:00") which the wire contract permits. The narrower
    // canonical form (Z + ms) for hashing is owned by Plan-006's
    // normalization step, NOT by the wire schema here.
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export interface MembershipSummary {
  id: MembershipId;
  participantId: ParticipantId;
  role: MembershipRole;
  state: MembershipState;
}
export const MembershipSummarySchema: z.ZodType<MembershipSummary> = z
  .object({
    id: MembershipIdSchema,
    participantId: ParticipantIdSchema,
    role: MembershipRoleSchema,
    state: MembershipStateSchema,
  })
  .strict();

// `name` is optional in the canonical interface (`name?: string`). Per
// api-payload-contracts.md line 224, omission is the wire signal for a
// channel without a friendly label (e.g. the implicit `main` channel).
//
// Note on `exactOptionalPropertyTypes: true`: the spec's wire form is
// "key absent" rather than "key present with value undefined" — but Zod's
// `.optional()` produces `T | undefined`. We type the interface as
// `name?: string | undefined` so the schema's inferred output matches
// our exported interface; consumers who care about the absent-vs-undefined
// distinction can still test `"name" in obj`.
//
// `name` length cap (`CHANNEL_NAME_MAX_LEN`, 128 chars) is defense in depth
// (mirrors `IDENTITY_HANDLE_MAX_LEN` co-location with its schema). The
// `wireFreeFormString` helper also rejects whitespace-only and NUL-byte
// values, matching the trust-boundary stance applied to `identityHandle`
// (channel names are user-visible UI labels — same reasoning).
export const CHANNEL_NAME_MAX_LEN = 128;
export interface ChannelSummary {
  id: ChannelId;
  name?: string | undefined;
  state: ChannelState;
}
export const ChannelSummarySchema: z.ZodType<ChannelSummary> = z
  .object({
    id: ChannelIdSchema,
    name: wireFreeFormString(CHANNEL_NAME_MAX_LEN, "ChannelSummary.name").optional(),
    state: ChannelStateSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// SessionCreate
// --------------------------------------------------------------------------
//
// Both request fields are optional; an empty `{}` body is valid (the daemon
// fills defaults from session config, see Spec-001 §Resource Limits).

export interface SessionCreateRequest {
  config?: Record<string, unknown> | undefined;
  metadata?: Record<string, unknown> | undefined;
}
// `z.ZodType<T, T>` (instead of `z.ZodType<T>`, where the second slot defaults
// to `unknown`) is required so tRPC v11's Standard-Schema-V1 input inference
// resolves to T and not `unknown`. The schema is non-transforming (no
// `.transform()` / `.coerce()` / `.preprocess()` anywhere in this module), so
// pre-validation Input ≡ post-validation Output ≡ T. Explicit double-T
// preserves that equivalence on the type surface.
export const SessionCreateRequestSchema: z.ZodType<SessionCreateRequest, SessionCreateRequest> = z
  .object({
    config: RecordOfUnknownSchema.optional(),
    metadata: RecordOfUnknownSchema.optional(),
  })
  .strict();

export interface SessionCreateResponse {
  sessionId: SessionId;
  state: SessionState;
  memberships: MembershipSummary[];
  channels: ChannelSummary[];
}
export const SessionCreateResponseSchema: z.ZodType<SessionCreateResponse> = z
  .object({
    sessionId: SessionIdSchema,
    state: SessionStateSchema,
    memberships: z.array(MembershipSummarySchema),
    channels: z.array(ChannelSummarySchema),
  })
  .strict();

// --------------------------------------------------------------------------
// SessionRead
// --------------------------------------------------------------------------

export interface SessionReadRequest {
  sessionId: SessionId;
}
// `z.ZodType<T, T>` — see SessionCreateRequestSchema for rationale (preserves
// Standard-Schema-V1 input inference for tRPC v11 consumers).
export const SessionReadRequestSchema: z.ZodType<SessionReadRequest, SessionReadRequest> = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();

// `timelineCursors.acknowledged` is optional per the canonical interface
// (api-payload-contracts.md line 182).
export interface SessionReadResponse {
  session: SessionSnapshot;
  timelineCursors: {
    latest: EventCursor;
    acknowledged?: EventCursor | undefined;
  };
}
export const SessionReadResponseSchema: z.ZodType<SessionReadResponse> = z
  .object({
    session: SessionSnapshotSchema,
    timelineCursors: z
      .object({
        latest: EventCursorSchema,
        acknowledged: EventCursorSchema.optional(),
      })
      .strict(),
  })
  .strict();

// --------------------------------------------------------------------------
// SessionJoin
// --------------------------------------------------------------------------

export interface SessionJoinRequest {
  sessionId: SessionId;
  identityHandle: string;
}
// `identityHandle` wire-layer guards (length bounds + whitespace-only +
// NUL-byte rejection) are centralized in the `wireFreeFormString` helper
// above; `IdentityHandleSchema` wraps the helper at `IDENTITY_HANDLE_MAX_LEN`.
// The canonical handle grammar is owned by Plan-018 (identity-and-participant-
// state); these wire-layer guards exist to catch obvious garbage before it
// reaches Plan-018's validator.
//
// Plan-018 also owns Unicode normalization including zero-width-character
// handling (U+200B/200C/200D/2060/FEFF). Wire-layer rejection is intentionally
// limited to ASCII whitespace + NUL byte — preempting Plan-018's grammar
// choices at the wire layer would be wrong (see `wireFreeFormString` rationale).
//
// Re-used by `event.ts`'s `membership.joined` payload schema, so future
// tightening at this single site applies consistently to both surfaces.
export const IDENTITY_HANDLE_MAX_LEN = 64;
export const IdentityHandleSchema: z.ZodString = wireFreeFormString(
  IDENTITY_HANDLE_MAX_LEN,
  "identityHandle",
);
// `z.ZodType<T, T>` — see SessionCreateRequestSchema for rationale (preserves
// Standard-Schema-V1 input inference for tRPC v11 consumers).
export const SessionJoinRequestSchema: z.ZodType<SessionJoinRequest, SessionJoinRequest> = z
  .object({
    sessionId: SessionIdSchema,
    identityHandle: IdentityHandleSchema,
  })
  .strict();

export interface SessionJoinResponse {
  sessionId: SessionId;
  participantId: ParticipantId;
  membershipId: MembershipId;
  sharedMetadata: Record<string, unknown>;
}
export const SessionJoinResponseSchema: z.ZodType<SessionJoinResponse> = z
  .object({
    sessionId: SessionIdSchema,
    participantId: ParticipantIdSchema,
    membershipId: MembershipIdSchema,
    sharedMetadata: RecordOfUnknownSchema,
  })
  .strict();

// --------------------------------------------------------------------------
// SessionSubscribe
// --------------------------------------------------------------------------
//
// `session.subscribe` opens a server-side streaming subscription on the
// Plan-007 Phase 2 streaming primitive. The wire request carries the
// `sessionId` (and optional `afterCursor` for replay-from-cursor); the
// wire response carries ONLY the opaque `subscriptionId` returned by
// `StreamingPrimitive.createSubscription<SessionEvent>(...)`. Subsequent
// per-event values flow as `$/subscription/notify` frames keyed by that
// `subscriptionId` (envelope shape owned by `jsonrpc-streaming.ts`); the
// `SessionEvent` value schema is owned by `event.ts`. Client-initiated
// teardown is a `$/subscription/cancel` notification referencing the
// same id.
//
// Why the response is a separate, minimal schema rather than embedding
// `SessionEvent` directly: the handler's wire result MUST be JSON-
// serializable AND Zod-parseable (per I-007-7); a `LocalSubscription<T>`
// is an in-process producer handle with closure-captured methods that
// satisfies neither. The shape below carries only what the wire client
// actually needs — the `subscriptionId` it uses to route subsequent
// inbound notifications. This also matches `streaming-primitive.ts`
// line 267 which documents: "The handler typically returns the
// `subscriptionId` to the wire client (e.g. as the `result` of a
// `session.subscribe` request)".

// SessionSubscribeRequest carries TWO replay-cursor fields because the
// schema is shared across two transports with different injection
// conventions:
//
//   * `afterCursor` — IPC/JSON-RPC clients (Plan-007 daemon transport)
//     populate this field in the request body. See
//     `runtime-daemon/src/ipc/handlers/session-subscribe.ts`.
//
//   * `lastEventId` — HTTP/SSE clients (Plan-008 control-plane transport)
//     send a `Last-Event-ID` header, which tRPC v11's fetch-adapter
//     substrate injects into the input object PRE-Zod-validation when the
//     procedure type is `subscription`. See
//     `@trpc/server` v11 `unstable-core-do-not-import/http/contentType.ts`
//     lines 151-168. Without `lastEventId` declared in the schema,
//     `.strict()` would throw on every reconnect that carries the
//     `Last-Event-ID` resumption header — the very transport feature
//     §T-008b-1-T8 verifies.
//
// Consumer precedence: `input.lastEventId ?? input.afterCursor`. Header
// beats body so a reconnect's `Last-Event-ID` overrides any stale
// `afterCursor` the client cached locally — matches the SSE EventSource
// semantics the browser/runtime owns.
export interface SessionSubscribeRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor | undefined;
  lastEventId?: EventCursor | undefined;
}
// `z.ZodType<T, T>` — see SessionCreateRequestSchema for rationale (preserves
// Standard-Schema-V1 input inference for tRPC v11 consumers).
export const SessionSubscribeRequestSchema: z.ZodType<
  SessionSubscribeRequest,
  SessionSubscribeRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    afterCursor: EventCursorSchema.optional(),
    lastEventId: EventCursorSchema.optional(),
  })
  .strict();

// BLOCKED-ON-C6 — the canonical `session.subscribe` response payload
// shape will land in api-payload-contracts.md §Plan-007 alongside the
// canonical method-name table. Today's conservative inline schema
// carries only the `subscriptionId`; if the canonical shape adds
// fields (e.g. an initial cursor echo, a server-replay-state marker)
// it widens additively per ADR-018 §Decision #1 (MINOR widening), so
// a response accepted today remains accepted under the canonical
// taxonomy.
export interface SessionSubscribeResponse {
  subscriptionId: SubscriptionId;
}
export const SessionSubscribeResponseSchema: z.ZodType<SessionSubscribeResponse> = z
  .object({
    subscriptionId: SubscriptionIdSchema,
  })
  .strict();
