// Session contracts — request/response payloads and shared projection types
// for the session core (SessionCreate / SessionRead / SessionSubscribe).
//
// ID format: the `brandedUuidIdSchema` factory's `RFC_9562_TEXT_FORM`
// predicate accepts any RFC 9562 UUID, case-insensitively on every
// alternative (general form, Nil, Max). Daemon-assigned IDs are
// UUID v7 (sortable timestamp); admin-provisioned control-plane rows fall
// through PostgreSQL's `gen_random_uuid()` which emits v4. Contracts must
// accept both, so we deliberately do NOT pin to `z.uuidv7()`.
//
// Branded types (`SessionId`, `ChannelId`, …) provide compile-time nominal
// typing — they prevent accidentally passing a `UserId` where a
// `SessionId` was expected, even though both are strings at runtime.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "./jsonrpc-streaming.js";

// --------------------------------------------------------------------------
// Branded ID schemas
// --------------------------------------------------------------------------
//
//   `type SessionId = string & { readonly __brand: "SessionId" };`
// This is a TypeScript-only nominal type — runtime is a plain UUID string. We
// keep our own `__brand` field rather than using `z.core.$brand` because the
// spec's documented brand symbol is the structural shape we want cross- package
// consumers to see (`packages/runtime-daemon`, `packages/control-plane` etc.
// read to verify their type imports — making the consuming type structurally
// identical to the doc's declaration eliminates a foot-gun).
//
// All exported schemas are annotated to satisfy `isolatedDeclarations: true`
// from tsconfig.base.json (TS9010 — exported values must have explicit type
// annotations so downstream packages can type-emit without re-running
// whole-program inference).
//
// UUID-based IDs use the `brandedUuidIdSchema` helper from `./internal/branded`
// which encapsulates the `RFC_9562_TEXT_FORM` predicate plus the `.brand().as
// unknown as z.ZodType<T, T>` cast pattern that bridges Zod's single-T
// `$ZodBranded` output to the double-T shape required for Standard-Schema-V1
// input inference in tRPC v11. Non-UUID branded scalars (see EventCursorSchema
// below) keep the inline cast.

export type SessionId = string & { readonly __brand: "SessionId" };
export const SessionIdSchema: z.ZodType<SessionId, SessionId> =
  brandedUuidIdSchema<SessionId>("SessionId");

export type UserId = string & { readonly __brand: "UserId" };
export const UserIdSchema: z.ZodType<UserId, UserId> = brandedUuidIdSchema<UserId>("UserId");

export type ChannelId = string & { readonly __brand: "ChannelId" };
export const ChannelIdSchema: z.ZodType<ChannelId, ChannelId> =
  brandedUuidIdSchema<ChannelId>("ChannelId");

// Only needs to pass it through unchanged on `SessionRead.timelineCursors`
// and `SessionSubscribe.afterCursor`.
//
// We deliberately use `.min(1)` only — owns the cursor's internal format. The
// `.max(EVENT_CURSOR_MAX_LEN)` cap below is defense-in-depth against
// pathological lengths (mirrors the framework body-size cap pattern used
// elsewhere in this package). If later publishes a structural cursor format
// (e.g. `<sequence>_<monotonic_ns>`), tighten this regex; until then, any
// non-empty bounded string is accepted.
export const EVENT_CURSOR_MAX_LEN = 256;
export type EventCursor = string & { readonly __brand: "EventCursor" };
// Non-UUID branded scalar — inline cast (not the `brandedUuidIdSchema` helper) because the
// underlying parser is `z.string().min(1).max(EVENT_CURSOR_MAX_LEN)`, not the factory's RFC
// 9562 predicate. The `as unknown as z.ZodType<T, T>` cast matches the helper's pattern (see
// `./internal/branded.ts` for the load-bearing rationale: bridging single-T `$ZodBranded`
// output to the double-T shape required for Standard-Schema-V1 input inference in tRPC v11).
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
//      005 is the authoritative body-size enforcer).
//   2. Whitespace-only rejection: `.regex(/\S/)` requires at least one
//      non-whitespace character anywhere in the string. ASCII-whitespace
//      only — Unicode zero-width characters (U+200B/200C/200D/2060/FEFF)
//      bypass this regex by design. owns identity canonical form including
//      zero-width-character handling; preempting the grammar choices at
//      the wire layer would be wrong.
//   3. NUL-byte rejection: `\0` corrupts log lines / observability traces
//      (OpenTelemetry sees NUL as a string terminator) and creates
//      filesystem / log-injection vectors. The wire layer is exactly where
//      this trust boundary lives — we accept input from external (cross-
//      node, future RPC) callers and cannot rely on producer trust alone.
//
// Used by every wire-layer free-form string in this package. Not branded —
// the caller composes branding on top of it where applicable.
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

// `z.ZodType<T, T>` — see `./internal/branded.ts` for rationale (preserves
// Input inference when this helper composes into tRPC-consumed request schemas).
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
    // Default `z.iso.datetime()` accepts only Z-suffixed UTC; `{ offset:
    // true }` widens to the full RFC 3339 section 5.6 spec (numeric
    // offsets like "+00:00", "-05:00") which the wire contract permits.
    // The narrower canonical form (Z + ms) for hashing is owned by the
    // normalization step, NOT by the wire schema here.
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// `name` is optional in the canonical interface (`name?: string`). omission is the wire
// signal for a channel without a friendly label (e.g. the implicit `main` channel).
//
// Note on `exactOptionalPropertyTypes: true`: the spec's wire form is
// "key absent" rather than "key present with value undefined" — but Zod's
// `.optional()` produces `T | undefined`. We type the interface as
// `name?: string | undefined` so the schema's inferred output matches
// our exported interface; consumers who care about the absent-vs-undefined
// distinction can still test `"name" in obj`.
//
// `name` length cap (`CHANNEL_NAME_MAX_LEN`, 128 chars) is defense in depth.
// The `wireFreeFormString` helper also rejects whitespace-only and NUL-byte
// values — channel names are user-visible UI labels, so the wire-layer
// trust boundary applies.
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
// fills defaults from session config).

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
  channels: ChannelSummary[];
}
export const SessionCreateResponseSchema: z.ZodType<SessionCreateResponse> = z
  .object({
    sessionId: SessionIdSchema,
    state: SessionStateSchema,
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

// `timelineCursors.acknowledged` is optional per the canonical interface.
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
// SessionSubscribe
// --------------------------------------------------------------------------
//
// `session.subscribe` opens a server-side streaming subscription on
// streaming primitive. The wire request carries the `sessionId` (and
// optional `afterCursor` for replay-from-cursor); the wire response
// carries ONLY the opaque `subscriptionId` returned by
// `StreamingPrimitive.createSubscription<SessionEvent>(...)`. Subsequent
// per-event values flow as `$/subscription/notify` frames keyed by that
// `subscriptionId` (envelope shape owned by `jsonrpc-streaming.ts`); the
// `SessionEvent` value schema is owned by `event.ts`. Client-initiated
// teardown is a `$/subscription/cancel` notification referencing the
// same id.
//
// Why the response is a separate, minimal schema rather than embedding
// `SessionEvent` directly: the handler's wire result MUST be JSON- serializable
// AND Zod-parseable; a `LocalSubscriptionProducer<T>` is an in-process producer
// handle with closure-captured methods that satisfies neither. The shape below
// carries only what the wire client actually needs — the `subscriptionId` it
// uses to route subsequent inbound notifications. This also matches
// `streaming-primitive.ts` line 267 which documents: "The handler typically
// returns the `subscriptionId` to the wire client (e.g. as the `result` of a
// `session.subscribe` request)".

// SessionSubscribeRequest carries TWO replay-cursor fields because the
// schema is shared across two transports with different injection
// conventions:
//
//   * `afterCursor` — IPC/JSON-RPC clients (daemon transport) populate
//     this field in the request body.
//
//   * `lastEventId` — HTTP/SSE clients (control-plane transport) send a
//     `Last-Event-ID` header, which tRPC v11's fetch-adapter substrate
//     injects into the input object PRE-Zod-validation when the procedure
//     type is `subscription`. Without `lastEventId` declared in the
//     schema, `.strict()` would throw on every reconnect that carries the
//     `Last-Event-ID` resumption header — the very transport feature.
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

// `session.subscribe`'s init ack is an ALIAS SEAM over the canonical generic
// `SubscribeAckResponse` (jsonrpc-streaming.ts): today `SessionSubscribeResponse`
// is EXACTLY `{ subscriptionId }`, identical to every other `*.subscribe`
// method's ack. The seam exists so a future divergence stays localized here.
//
// Divergence escape hatch: if `session.subscribe`'s response later gains
// session-specific fields (e.g. an initial cursor echo, a server-replay-state
// marker), this seam becomes a per-method extension —
//   `export interface SessionSubscribeResponse extends SubscribeAckResponse { …new fields }`
// plus its own `z.object({ subscriptionId: SubscriptionIdSchema, …new fields }).strict()`
// schema — rather than widening the shared generic. The change is confined to these two
// declarations: zero consumer import churn (the symbol names are unchanged), and because
// the `subscriptionId` floor is preserved it is a MINOR widening so a response accepted
// today remains accepted under any future evolution.
//
// Canonical source: this file (the SESSION binding). The generic ack itself
// is owned by jsonrpc-streaming.ts. no-mirror disposition does not maintain
// a doc-side mirror of either code-side typed surface.
//
// The explicit `z.ZodType<SessionSubscribeResponse>` annotation (identical to
// `z.ZodType<SubscribeAckResponse>`, since the alias is type-transparent)
// satisfies `isolatedDeclarations: true` and matches this file's
// explicit-annotation convention.
export type SessionSubscribeResponse = SubscribeAckResponse;
export const SessionSubscribeResponseSchema: z.ZodType<SessionSubscribeResponse> =
  SubscribeAckResponseSchema;
