// Session contracts: the session read and subscribe shapes, the frame a session's stream sends,
// the verbs called on one session (rename, archive, reactivate, close, pin, mute, restart), the
// two searches, and the payloads of the events those verbs append.
//
// Id format: `brandedUuidIdSchema` accepts any RFC 9562 UUID, case-insensitively. Daemon-assigned
// ids are UUID v7, but control-plane rows take PostgreSQL's `gen_random_uuid()`, which emits v4,
// so contracts must accept both and never pin to `z.uuidv7()`.
import { z } from "zod";

import { brandedUuidIdSchema } from "./internal/branded.js";
import {
  StreamFrameSchema,
  SubscribeAckResponseSchema,
  type StreamFrame,
  type SubscribeAckResponse,
} from "./jsonrpc-streaming.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { countSchema, isoDateTimeSchema } from "./internal/wire-scalars.js";

/** Identifies one session. */
export type SessionId = string & { readonly __brand: "SessionId" };
/** Parses a {@link SessionId}. */
export const SessionIdSchema: z.ZodType<SessionId, SessionId> =
  brandedUuidIdSchema<SessionId>("SessionId");

/** Identifies one person. */
export type UserId = string & { readonly __brand: "UserId" };
/** Parses a {@link UserId}. */
export const UserIdSchema: z.ZodType<UserId, UserId> = brandedUuidIdSchema<UserId>("UserId");

/** The longest event cursor accepted; a guard against pathological lengths. */
export const EVENT_CURSOR_MAX_LEN = 256;
/**
 * An opaque position in a session's event log, passed through unchanged. Its format belongs to
 * the daemon, so any non-empty bounded string is accepted.
 */
export type EventCursor = string & { readonly __brand: "EventCursor" };
/** Parses an {@link EventCursor}; not a UUID, so it brands the string itself. */
export const EventCursorSchema: z.ZodType<EventCursor, EventCursor> = z
  .string()
  .min(1)
  .max(EVENT_CURSOR_MAX_LEN)
  .brand<"EventCursor">() as unknown as z.ZodType<EventCursor, EventCursor>;

/**
 * A free-form wire string with at least one non-whitespace character and no NUL byte, and no
 * length cap of its own: what a person writes to an agent, bounded only by the transport's
 * message limit. `fieldLabel` names the field in the refusal message. The whitespace check is
 * ASCII-only, so zero-width characters pass by design; no identity normalization happens here.
 * NUL is refused because it corrupts log lines and traces and opens log and filesystem injection.
 */
export const wireUncappedFreeFormString = (fieldLabel: string): z.ZodString =>
  z
    .string()
    .min(1)
    .regex(/\S/, {
      message: `${fieldLabel} must contain at least one non-whitespace character.`,
    })
    .refine((value) => !value.includes("\0"), {
      message: `${fieldLabel} MUST NOT contain a NUL byte.`,
    });

/**
 * A {@link wireUncappedFreeFormString} of at most `maxLen` characters, for a name, a reason or an
 * id the app itself bounds; the cap is defense in depth behind the transport's message limit.
 */
export const wireFreeFormString = (maxLen: number, fieldLabel: string): z.ZodString =>
  wireUncappedFreeFormString(fieldLabel).max(maxLen);

/**
 * The longest filesystem path any wire string carries. 4096 is Linux's `PATH_MAX`, above macOS's
 * 1024 and Windows' 260-character default; a longer Windows extended-length path is refused.
 */
export const FILE_PATH_MAX_LEN = 4096;

/** Where a session is in its lifecycle. */
export type SessionState = "provisioning" | "active" | "archived" | "closed" | "purge_requested";
/** Parses a {@link SessionState}. */
export const SessionStateSchema: z.ZodType<SessionState> = z.enum([
  "provisioning",
  "active",
  "archived",
  "closed",
  "purge_requested",
]);

/**
 * One session as `session.read` answers it. `draft` is the unsent composer draft the daemon
 * holds for the session, the whole text, and the empty string when none is held: Send clears
 * it, and a half-typed message reaches the person's other devices through this read.
 */
export interface SessionRecord {
  id: SessionId;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  draft: string;
}
/** Parses a {@link SessionRecord}. */
export const SessionRecordSchema: z.ZodType<SessionRecord> = z
  .object({
    id: SessionIdSchema,
    state: SessionStateSchema,
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    draft: z.string(),
  })
  .strict();

/** The session `session.read` answers with. */
export interface SessionReadRequest {
  sessionId: SessionId;
}
/** Parses a {@link SessionReadRequest}. */
export const SessionReadRequestSchema: z.ZodType<SessionReadRequest, SessionReadRequest> = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();

/** The `session.read` result: the session and its latest and acknowledged timeline cursors. */
export interface SessionReadResponse {
  session: SessionRecord;
  timelineCursors: {
    latest: EventCursor;
    acknowledged?: EventCursor | undefined;
  };
}
/** Parses a {@link SessionReadResponse}. */
export const SessionReadResponseSchema: z.ZodType<SessionReadResponse> = z
  .object({
    session: SessionRecordSchema,
    timelineCursors: z
      .object({
        latest: EventCursorSchema,
        acknowledged: EventCursorSchema.optional(),
      })
      .strict(),
  })
  .strict();

// `session.subscribe` answers with a `subscriptionId`; events then arrive as
// `$/subscription/notify` frames keyed by it, until the client sends `$/subscription/cancel`.

/** The `session.subscribe` input: the session to follow and an `afterCursor` to replay from. */
export interface SessionSubscribeRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor | undefined;
}
/** Parses a {@link SessionSubscribeRequest}. */
export const SessionSubscribeRequestSchema: z.ZodType<
  SessionSubscribeRequest,
  SessionSubscribeRequest
> = z
  .object({
    sessionId: SessionIdSchema,
    afterCursor: EventCursorSchema.optional(),
  })
  .strict();

/** The `session.subscribe` acknowledgment: the generic `{ subscriptionId }` ack. */
export type SessionSubscribeResponse = SubscribeAckResponse;
/** Parses a {@link SessionSubscribeResponse}. */
export const SessionSubscribeResponseSchema: z.ZodType<SessionSubscribeResponse> =
  SubscribeAckResponseSchema;

/** One change on a session's stream: an event of the session's log and the cursor it sits at. */
export interface SessionStreamChange<Event> {
  readonly cursor: EventCursor;
  readonly event: Event;
}

/** The value of each `session.subscribe` notify: a batch of changes, or the caught-up frame. */
export type SessionStreamFrame<Event> = StreamFrame<SessionStreamChange<Event>, EventCursor>;

/**
 * Builds the `session.subscribe` frame schema over the session event union. The union lives in
 * the event contract, which imports this file at load, so it is passed in rather than imported.
 */
export function SessionStreamFrameSchema<Event>(
  eventSchema: z.ZodType<Event>,
): z.ZodType<SessionStreamFrame<Event>> {
  const changeSchema = z
    .object({ cursor: EventCursorSchema, event: eventSchema })
    .strict() as unknown as z.ZodType<SessionStreamChange<Event>>;
  return StreamFrameSchema(changeSchema, EventCursorSchema);
}

/**
 * What a session is bound to, kept as a stored fact rather than a mode flag: a `chat` works in
 * a managed workspace the daemon owns, a `project` in a repository the person attached.
 * Converting a chat changes it in place, so it is read from the session, never fixed at creation.
 */
export type SessionShape = "chat" | "project";
/** Parses a {@link SessionShape}. */
export const SessionShapeSchema: z.ZodType<SessionShape, SessionShape> = z.enum([
  "chat",
  "project",
]);

/** The longest session name the daemon stores. */
export const SESSION_NAME_MAX_LEN = 256;

/**
 * The request of every verb that acts on one session and takes nothing else: archive,
 * reactivate, close, pin, unpin, mute, unmute and restart.
 */
export interface SessionTargetRequest {
  sessionId: SessionId;
}
/** Parses a {@link SessionTargetRequest}. */
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
/** Parses a {@link SessionVerbResponse}. */
export const SessionVerbResponseSchema: z.ZodType<SessionVerbResponse> = z.object({}).strict();

/**
 * The `session.rename` input. `null` clears the name, and the session reads as untitled again,
 * showing its first message. Renaming never renames the session's branch or worktree.
 */
export interface SessionRenameRequest {
  sessionId: SessionId;
  name: string | null;
}
/** Parses a {@link SessionRenameRequest}. */
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
/** Parses a {@link SessionRenameResponse}. */
export const SessionRenameResponseSchema: z.ZodType<SessionRenameResponse> = z
  .object({
    sessionId: SessionIdSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionRenameResponse.name").nullable(),
  })
  .strict();

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
/** Parses a {@link SessionSearchRequest}. */
export const SessionSearchRequestSchema: z.ZodType<SessionSearchRequest, SessionSearchRequest> = z
  .object({ query: wireFreeFormString(SESSION_SEARCH_QUERY_MAX_LEN, "SessionSearchRequest.query") })
  .strict();

/**
 * A matched stretch of a search hit's text, in UTF-16 code units: `start` inclusive, `end`
 * exclusive.
 */
export interface SearchMatchRange {
  start: number;
  end: number;
}
/** Parses a {@link SearchMatchRange}. */
export const SearchMatchRangeSchema: z.ZodType<SearchMatchRange> = z
  .object({ start: countSchema, end: z.number().int().positive() })
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
  matchRanges: SearchMatchRange[];
}
const SessionSearchHitSchema: z.ZodType<SessionSearchHit> = z
  .object({
    cursor: EventCursorSchema,
    line: z.string(),
    matchRanges: z.array(SearchMatchRangeSchema).min(1),
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
/** Parses a {@link SessionSearchResponse}. */
export const SessionSearchResponseSchema: z.ZodType<SessionSearchResponse> = z
  .object({ groups: z.array(SessionSearchGroupSchema) })
  .strict();

/**
 * The `session.fileSearch` input: the text typed after `@` in a session's draft. An empty query
 * lists the working folder's files; the list narrows as the name is typed.
 */
export interface SessionFileSearchRequest {
  sessionId: SessionId;
  query: string;
}
/** Parses a {@link SessionFileSearchRequest}. */
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
/** Parses a {@link SessionFileSearchResponse}; it cannot match more files than it searched. */
export const SessionFileSearchResponseSchema: z.ZodType<SessionFileSearchResponse> = z
  .object({
    paths: z.array(z.string().min(1).max(FILE_PATH_MAX_LEN)),
    searchedFileCount: countSchema,
  })
  .strict()
  .refine((result) => result.paths.length <= result.searchedFileCount, {
    message: "A file search cannot match more files than it searched.",
  });

// The event payloads below sit beside the verb that appends them and are composed into the event
// union by the event contract, which imports this file at load, so none may import that contract.

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
/** Parses a {@link SessionLifecycleChangePayload}. */
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
/** Parses a {@link SessionRenameOrigin}. */
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
/** Parses a {@link SessionRenamedPayload}. */
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
/** Parses a {@link SessionMarkChangePayload}. */
export const SessionMarkChangePayloadSchema: z.ZodType<SessionMarkChangePayload> = z
  .object({ sessionId: SessionIdSchema, at: isoDateTimeSchema })
  .strict();

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

// The descriptor shared by every verb that takes only the session and returns nothing.
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

/** The `session.*` methods stated in this file, each with its schemas. */
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
