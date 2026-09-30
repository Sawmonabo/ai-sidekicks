// Session contracts — request/response payloads and shared projection types
// for the session core (SessionRead / SessionSubscribe), the
// frame a session's stream sends, the session verbs the console calls on one
// session (rename, archive, reactivate, close, pin, mute, restart), the two
// searches, and the payloads of the events those verbs append.
//
// ID format: the `brandedUuidIdSchema` factory's `RFC_9562_TEXT_FORM`
// predicate accepts any RFC 9562 UUID, case-insensitively on every
// alternative (general form, Nil, Max). Daemon-assigned IDs are
// UUID v7 (sortable timestamp); control-plane rows take PostgreSQL's
// `gen_random_uuid()`, which emits v4. Contracts must accept both, so we
// deliberately do NOT pin to `z.uuidv7()`.
//
// Branded types (`SessionId`, `UserId`, …) provide compile-time nominal
// typing — they prevent accidentally passing a `UserId` where a
// `SessionId` was expected, even though both are strings at runtime.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import {
  StreamFrameSchema,
  SubscribeAckResponseSchema,
  type StreamFrame,
  type SubscribeAckResponse,
} from "./jsonrpc-streaming.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";

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

// The longest filesystem path any wire string carries. 4096 is Linux's
// `PATH_MAX`, above macOS's 1024 and Windows' 260-character default; a Windows
// extended-length path can run longer, and one past this bound is refused.
export const FILE_PATH_MAX_LEN = 4096;

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

// --------------------------------------------------------------------------
// Shared projection types
// --------------------------------------------------------------------------
//
// These are the read-side projections referenced from `SessionReadResponse`.
// Per the canonical spec they are strict shapes
// (the `.strict()` modifier rejects unknown keys at parse time, surfacing
// schema drift early).

// `z.ZodType<T, T>` — see `./internal/branded.ts` for rationale (preserves
// Input inference when this helper composes into tRPC-consumed request schemas).
const RecordOfUnknownSchema: z.ZodType<Record<string, unknown>, Record<string, unknown>> = z.record(
  z.string(),
  z.unknown(),
);

/**
 * One session as `session.read` answers it. `draft` is the unsent composer draft the daemon
 * holds for the session, the whole text, and the empty string when none is held: Send clears
 * it, and a half-typed message reaches the person's other devices through this read.
 */
export interface SessionSnapshot {
  id: SessionId;
  state: SessionState;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  draft: string;
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
    draft: z.string(),
  })
  .strict();

// --------------------------------------------------------------------------
// SessionRead
// --------------------------------------------------------------------------

export interface SessionReadRequest {
  sessionId: SessionId;
}
// `z.ZodType<T, T>` (instead of `z.ZodType<T>`, where the second slot defaults
// to `unknown`) is required so tRPC v11's Standard-Schema-V1 input inference
// resolves to T and not `unknown`. The schema is non-transforming (no
// `.transform()` / `.coerce()` / `.preprocess()` anywhere in this module), so
// pre-validation Input ≡ post-validation Output ≡ T. Explicit double-T
// preserves that equivalence on the type surface.
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

/**
 * The `session.subscribe` input: the session to follow and, in `afterCursor`,
 * the cursor to replay from.
 */
export interface SessionSubscribeRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor | undefined;
}
// `z.ZodType<T, T>` — see SessionReadRequestSchema for rationale (preserves
// Standard-Schema-V1 input inference for tRPC v11 consumers).
export const SessionSubscribeRequestSchema: z.ZodType<
  SessionSubscribeRequest,
  SessionSubscribeRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    afterCursor: EventCursorSchema.optional(),
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

// --------------------------------------------------------------------------
// The session stream's frame
// --------------------------------------------------------------------------

/** One change on a session's stream: an event of the session's log and the cursor it sits at. */
export interface SessionStreamChange<Event> {
  readonly cursor: EventCursor;
  readonly event: Event;
}

/** The value of each `session.subscribe` notify: a batch of changes, or the caught-up drop frame. */
export type SessionStreamFrame<Event> = StreamFrame<SessionStreamChange<Event>, EventCursor>;

/**
 * Builds the `session.subscribe` frame schema over the session event union. The union lives
 * in the event contract, which imports this file at load, so it is passed in rather than
 * imported here.
 */
export function SessionStreamFrameSchema<Event>(
  eventSchema: z.ZodType<Event>,
): z.ZodType<SessionStreamFrame<Event>> {
  const changeSchema = z
    .object({ cursor: EventCursorSchema, event: eventSchema })
    .strict() as unknown as z.ZodType<SessionStreamChange<Event>>;
  return StreamFrameSchema(changeSchema, EventCursorSchema);
}

// --------------------------------------------------------------------------
// Shape
// --------------------------------------------------------------------------

/**
 * What a session is bound to, kept as a stored fact rather than a mode flag: a `chat` works in
 * a managed workspace the daemon owns, a `project` in a repository the person attached.
 * Converting a chat changes it in place, so it is read from the session, never fixed at creation.
 */
export type SessionShape = "chat" | "project";
export const SessionShapeSchema: z.ZodType<SessionShape, SessionShape> = z.enum([
  "chat",
  "project",
]);

// --------------------------------------------------------------------------
// Verbs on one session
// --------------------------------------------------------------------------

/** The longest session name the daemon stores. */
export const SESSION_NAME_MAX_LEN = 256;

/**
 * The request of every verb that acts on one session and takes nothing else: archive,
 * reactivate, close, pin, unpin, mute, unmute and restart.
 */
export interface SessionTargetRequest {
  sessionId: SessionId;
}
export const SessionTargetRequestSchema: z.ZodType<SessionTargetRequest, SessionTargetRequest> = z
  .object({ sessionId: SessionIdSchema })
  .strict();

/**
 * The result of a session verb that returns nothing: the change is read from the event it
 * appends, which every device folds. A verb that finds the session already in the state it
 * asks for appends nothing and answers the same.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SessionVerbResponse {}
export const SessionVerbResponseSchema: z.ZodType<SessionVerbResponse> = z.object({}).strict();

/**
 * The `session.rename` input. `null` clears the name, and the session reads as untitled again,
 * showing its first message. Renaming never renames the session's branch or worktree.
 */
export interface SessionRenameRequest {
  sessionId: SessionId;
  name: string | null;
}
export const SessionRenameRequestSchema: z.ZodType<SessionRenameRequest, SessionRenameRequest> = z
  .object({
    sessionId: SessionIdSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionRenameRequest.name").nullable(),
  })
  .strict();

/** The `session.rename` result: the name the session now holds, `null` when untitled. */
export interface SessionRenameResponse {
  sessionId: SessionId;
  name: string | null;
}
export const SessionRenameResponseSchema: z.ZodType<SessionRenameResponse> = z
  .object({
    sessionId: SessionIdSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionRenameResponse.name").nullable(),
  })
  .strict();

// --------------------------------------------------------------------------
// Search across sessions
// --------------------------------------------------------------------------

/** The longest query `session.search` and `session.fileSearch` accept. */
export const SESSION_SEARCH_QUERY_MAX_LEN = 256;

/**
 * The `session.search` input: the text typed in the search box. The daemon matches it against
 * every session's title and message text, archived sessions included, and returns every hit in
 * the index's own ranked order with no cap, so the request carries no limit.
 */
export interface SessionSearchRequest {
  query: string;
}
export const SessionSearchRequestSchema: z.ZodType<SessionSearchRequest, SessionSearchRequest> = z
  .object({ query: wireFreeFormString(SESSION_SEARCH_QUERY_MAX_LEN, "SessionSearchRequest.query") })
  .strict();

/** A matched stretch of a hit's line, in UTF-16 code units: `start` inclusive, `end` exclusive. */
export interface SessionSearchMatchRange {
  start: number;
  end: number;
}
const SessionSearchMatchRangeSchema: z.ZodType<SessionSearchMatchRange> = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
  .strict()
  .refine((range) => range.end > range.start, {
    message: "A match range ends after it starts.",
  });

/**
 * One hit: the line of the message the match sits in, the matched stretches to mark, and the
 * message's cursor, which lands the transcript on it and loads whatever history that takes.
 */
export interface SessionSearchHit {
  cursor: EventCursor;
  line: string;
  matchRanges: SessionSearchMatchRange[];
}
const SessionSearchHitSchema: z.ZodType<SessionSearchHit> = z
  .object({
    cursor: EventCursorSchema,
    line: z.string(),
    matchRanges: z.array(SessionSearchMatchRangeSchema).min(1),
  })
  .strict();

/** The hits in one session, under that session's name; an untitled session has no `name`. */
export interface SessionSearchGroup {
  sessionId: SessionId;
  name?: string | undefined;
  hits: SessionSearchHit[];
}
const SessionSearchGroupSchema: z.ZodType<SessionSearchGroup> = z
  .object({
    sessionId: SessionIdSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionSearchGroup.name").optional(),
    hits: z.array(SessionSearchHitSchema).min(1),
  })
  .strict();

/** The `session.search` result: hits grouped by session, in the index's ranked order. */
export interface SessionSearchResponse {
  groups: SessionSearchGroup[];
}
export const SessionSearchResponseSchema: z.ZodType<SessionSearchResponse> = z
  .object({ groups: z.array(SessionSearchGroupSchema) })
  .strict();

// --------------------------------------------------------------------------
// File search in the working folder
// --------------------------------------------------------------------------

/**
 * The `session.fileSearch` input: the text typed after `@` in a session's draft. An empty query
 * lists the working folder's files; the list narrows as the name is typed.
 */
export interface SessionFileSearchRequest {
  sessionId: SessionId;
  query: string;
}
export const SessionFileSearchRequestSchema: z.ZodType<
  SessionFileSearchRequest,
  SessionFileSearchRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    query: z
      .string()
      .max(SESSION_SEARCH_QUERY_MAX_LEN)
      .refine((query) => !query.includes("\0"), {
        message: "SessionFileSearchRequest.query MUST NOT contain a NUL byte.",
      }),
  })
  .strict();

/**
 * The `session.fileSearch` result: the matching files' paths relative to the working folder,
 * best first, ranked by the product's one fuzzy scorer with the file's own name scoring before
 * its path. `searchedFileCount` is how many files the query was matched against, so an empty
 * `paths` reads `No matching files` when the folder has files and `No files available` when it
 * has none. A search that failed is an error, never an empty result.
 */
export interface SessionFileSearchResponse {
  paths: string[];
  searchedFileCount: number;
}
export const SessionFileSearchResponseSchema: z.ZodType<SessionFileSearchResponse> = z
  .object({
    paths: z.array(z.string().min(1)),
    searchedFileCount: z.number().int().nonnegative(),
  })
  .strict()
  .refine((result) => result.paths.length <= result.searchedFileCount, {
    message: "A file search cannot match more files than it searched.",
  });

// --------------------------------------------------------------------------
// Payloads of the events the session verbs append
// --------------------------------------------------------------------------
//
// Each is authored here, beside the verb that appends it, and composed into the event union
// by the event contract. None imports that contract: it imports this file at load.

/**
 * The payload of a lifecycle move — `session.archived`, `session.reactivated`,
 * `session.closed` — naming the state the session left and the one it is in. `actor` is the
 * person who acted, absent when the daemon moved it.
 */
export interface SessionLifecycleChangePayload {
  sessionId: SessionId;
  previousState?: SessionState | undefined;
  newState: SessionState;
  actor?: UserId | undefined;
}
export const SessionLifecycleChangePayloadSchema: z.ZodType<SessionLifecycleChangePayload> = z
  .object({
    sessionId: SessionIdSchema,
    previousState: SessionStateSchema.optional(),
    newState: SessionStateSchema,
    actor: UserIdSchema.optional(),
  })
  .strict();

/**
 * Who a rename came from: the person (`user`), the provider renaming its own conversation
 * (`provider`), or the daemon's naming pass after the first exchange (`auto`), which writes only
 * while the session is unnamed, so a name the person typed always wins.
 */
export type SessionRenameOrigin = "user" | "provider" | "auto";
export const SessionRenameOriginSchema: z.ZodType<SessionRenameOrigin> = z.enum([
  "user",
  "provider",
  "auto",
]);

/**
 * The stored `session.renamed` payload: the half the personal-data split leaves in the
 * event. The new name and the previous one are text a person or a provider wrote, so the
 * emitter moves both into the row's personal-data partition, and neither is a member here.
 */
export interface SessionRenamedPayload {
  sessionId: SessionId;
  origin: SessionRenameOrigin;
  actor?: UserId | undefined;
}
export const SessionRenamedPayloadSchema: z.ZodType<SessionRenamedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    origin: SessionRenameOriginSchema,
    actor: UserIdSchema.optional(),
  })
  .strict();

/**
 * The payload of a session mark set or cleared — `session.pinned`, `session.unpinned`,
 * `session.muted`, `session.unmuted` — with the time it happened. Pinned rows sit in the order
 * they were pinned, and a mute stands until it is cleared: both are rebuilt from these events.
 */
export interface SessionMarkChangePayload {
  sessionId: SessionId;
  at: string;
}
export const SessionMarkChangePayloadSchema: z.ZodType<SessionMarkChangePayload> = z
  .object({ sessionId: SessionIdSchema, at: z.iso.datetime({ offset: true }) })
  .strict();

// --------------------------------------------------------------------------
// The session method table
// --------------------------------------------------------------------------

/**
 * The `session.*` methods whose shapes this file states, each bound to its schemas. The
 * `session.subscribe` entry is composed where the session event union is in reach, since its
 * emission is a frame over that union.
 */
export interface SessionMethodDescriptors {
  readonly "session.read": MethodDescriptor<
    "session.read",
    SessionReadRequest,
    SessionReadResponse
  >;
  readonly "session.rename": MethodDescriptor<
    "session.rename",
    SessionRenameRequest,
    SessionRenameResponse
  >;
  readonly "session.archive": MethodDescriptor<
    "session.archive",
    SessionTargetRequest,
    SessionVerbResponse
  >;
  readonly "session.reactivate": MethodDescriptor<
    "session.reactivate",
    SessionTargetRequest,
    SessionVerbResponse
  >;
  readonly "session.close": MethodDescriptor<
    "session.close",
    SessionTargetRequest,
    SessionVerbResponse
  >;
  readonly "session.pin": MethodDescriptor<
    "session.pin",
    SessionTargetRequest,
    SessionVerbResponse
  >;
  readonly "session.unpin": MethodDescriptor<
    "session.unpin",
    SessionTargetRequest,
    SessionVerbResponse
  >;
  readonly "session.mute": MethodDescriptor<
    "session.mute",
    SessionTargetRequest,
    SessionVerbResponse
  >;
  readonly "session.unmute": MethodDescriptor<
    "session.unmute",
    SessionTargetRequest,
    SessionVerbResponse
  >;
  readonly "session.restart": MethodDescriptor<
    "session.restart",
    SessionTargetRequest,
    SessionVerbResponse
  >;
  readonly "session.search": MethodDescriptor<
    "session.search",
    SessionSearchRequest,
    SessionSearchResponse
  >;
  readonly "session.fileSearch": MethodDescriptor<
    "session.fileSearch",
    SessionFileSearchRequest,
    SessionFileSearchResponse
  >;
}

function sessionVerb<MethodName extends string>(
  method: MethodName,
): MethodDescriptor<MethodName, SessionTargetRequest, SessionVerbResponse> {
  return {
    method,
    procedureType: "mutation",
    mutating: true,
    requestSchema: SessionTargetRequestSchema,
    responseSchema: SessionVerbResponseSchema,
  };
}

export const SESSION_METHOD_DESCRIPTORS: SessionMethodDescriptors = defineMethodDescriptors({
  "session.read": {
    method: "session.read",
    procedureType: "query",
    mutating: false,
    requestSchema: SessionReadRequestSchema,
    responseSchema: SessionReadResponseSchema,
  },
  "session.rename": {
    method: "session.rename",
    procedureType: "mutation",
    mutating: true,
    requestSchema: SessionRenameRequestSchema,
    responseSchema: SessionRenameResponseSchema,
  },
  "session.archive": sessionVerb("session.archive"),
  "session.reactivate": sessionVerb("session.reactivate"),
  "session.close": sessionVerb("session.close"),
  "session.pin": sessionVerb("session.pin"),
  "session.unpin": sessionVerb("session.unpin"),
  "session.mute": sessionVerb("session.mute"),
  "session.unmute": sessionVerb("session.unmute"),
  "session.restart": sessionVerb("session.restart"),
  "session.search": {
    method: "session.search",
    procedureType: "query",
    mutating: false,
    requestSchema: SessionSearchRequestSchema,
    responseSchema: SessionSearchResponseSchema,
  },
  "session.fileSearch": {
    method: "session.fileSearch",
    procedureType: "query",
    mutating: false,
    requestSchema: SessionFileSearchRequestSchema,
    responseSchema: SessionFileSearchResponseSchema,
  },
});
