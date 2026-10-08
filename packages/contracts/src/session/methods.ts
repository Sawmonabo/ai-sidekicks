// Session contracts: the session read and subscribe shapes, the frame a session's stream sends,
// the verbs called on one session (rename, archive, reactivate, close, pin, mute, restart, and the
// two actions of a session whose history is damaged), the two searches and the read of a
// conversion's skipped files. The events those verbs append are in `./events.ts`.
import { z } from "zod";

import { FILE_PATH_MAX_LEN, wireFreeFormString } from "../free-form-string.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";
import { requireMemberToRideOneFrame } from "../jsonrpc/page.js";
import {
  StreamFrameSchema,
  SubscribeAckResponseSchema,
  type StreamFrame,
  type SubscribeAckResponse,
} from "../jsonrpc/streaming.js";
import { defineMethodDescriptors, type MethodDescriptor } from "../method-descriptor.js";
import { TagListSchema } from "../tag.js";
import {
  SessionConvertSkippedFileListRequestSchema,
  SessionConvertSkippedFileListResponseSchema,
  type SessionConvertSkippedFileListRequest,
  type SessionConvertSkippedFileListResponse,
} from "./convert.js";
import { EventCursorSchema, SessionIdSchema, type EventCursor, type SessionId } from "./id.js";
import { SESSION_NAME_MAX_LEN } from "./name.js";

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

/**
 * A change the session's state does not take: a `provisioning` session is neither archived,
 * closed nor converted, and a `purge_requested` one, being deleted, takes no change.
 * `data.fields`: `sessionId`, `state`.
 */
export const SESSION_CHANGE_REFUSED_CODE = "session.change_refused" as const;

/** A change to a session that has been closed, which takes none. `data.fields`: `sessionId`. */
export const SESSION_ALREADY_CLOSED_CODE = "session.already_closed" as const;

/**
 * One session as `session.read` answers it.
 *
 * - `name` is absent while the session is untitled; a surface then shows its first message.
 * - `muted` is whether the person muted the session's notifications.
 * - `draft` is the unsent composer draft the daemon holds, the whole text, and the empty string
 *   when none is held: Send clears it, and a half-typed message reaches the person's other
 *   devices through this read.
 * - `tags` are the session's tags as first written, in the order of their case fold.
 */
export interface SessionRecord {
  id: SessionId;
  state: SessionState;
  shape: SessionShape;
  name?: string | undefined;
  muted: boolean;
  createdAt: string;
  updatedAt: string;
  draft: string;
  tags: string[];
}
/** Parses a {@link SessionRecord}; its tags fit the shared page budget. */
export const SessionRecordSchema: z.ZodType<SessionRecord> = z
  .object({
    id: SessionIdSchema,
    state: SessionStateSchema,
    shape: SessionShapeSchema,
    name: wireFreeFormString(SESSION_NAME_MAX_LEN, "SessionRecord.name").optional(),
    muted: z.boolean(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
    draft: z.string(),
    tags: TagListSchema,
  })
  .strict()
  .superRefine((record, issueContext) => {
    requireMemberToRideOneFrame(record.tags, "tags", issueContext);
  });

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

/**
 * The `session.read` result: the session and its transcript cursors. A reader with no
 * acknowledged position resumes from `earliest`.
 */
export interface SessionReadResponse {
  session: SessionRecord;
  transcriptCursors: {
    /** The position just before the oldest surviving event, so a read after it misses none. */
    earliest: EventCursor;
    latest: EventCursor;
    acknowledged?: EventCursor | undefined;
  };
}
/** Parses a {@link SessionReadResponse}. */
export const SessionReadResponseSchema: z.ZodType<SessionReadResponse> = z
  .object({
    session: SessionRecordSchema,
    transcriptCursors: z
      .object({
        earliest: EventCursorSchema,
        latest: EventCursorSchema,
        acknowledged: EventCursorSchema.optional(),
      })
      .strict(),
  })
  .strict();

// `session.subscribe` answers with a `subscriptionId`; events then arrive as
// `$/subscription/notify` frames keyed by it, until the client sends `$/subscription/cancel`.

/** The `session.subscribe` input: the session to follow and an `afterCursor` to catch up from. */
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
  const changeSchema = z.object({ cursor: EventCursorSchema, event: eventSchema }).strict();
  return StreamFrameSchema(changeSchema, EventCursorSchema);
}

/**
 * The request of every verb that acts on one session and takes nothing else: archive,
 * reactivate, close, pin, unpin, mute, unmute, restart, and the damaged history's continue and
 * delete.
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
export type SessionVerbResponse = Record<string, never>;
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

/** The most hits one `session.search` page carries, across all its sessions. */
export const SESSION_SEARCH_PAGE_LIMIT_MAX = 256;

/** The longest line a `session.search` hit carries: the stretch of a message around its matches. */
export const SESSION_SEARCH_HIT_LINE_MAX_LEN = 4096;

// The longest `session.search` cursor accepted; a guard against pathological lengths.
const SESSION_SEARCH_CURSOR_MAX_LEN = 256;

/**
 * Where the next `session.search` page starts. The daemon writes it and owns its format; a client
 * passes it back unchanged with the same query. It continues the search its first page read, so a
 * write between pages neither repeats a hit nor drops one, except a hit whose row, group
 * membership or session has since gone or whose title, group name or tag was renamed so the words
 * no longer match it; a cursor of a search the daemon has let go is refused, and the client
 * searches again.
 */
export type SessionSearchCursor = string & { readonly __brand: "SessionSearchCursor" };
/** Parses a {@link SessionSearchCursor}; any bounded non-empty string, which the daemon reads. */
export const SessionSearchCursorSchema: z.ZodType<SessionSearchCursor, SessionSearchCursor> = z
  .string()
  .min(1)
  .max(SESSION_SEARCH_CURSOR_MAX_LEN)
  .brand<"SessionSearchCursor">() as unknown as z.ZodType<SessionSearchCursor, SessionSearchCursor>;

/**
 * A `session.search` cursor the daemon did not write, one written for another kind of query, or
 * one whose search the daemon no longer holds.
 */
export const SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE =
  "session.search_cursor_unresolvable" as const;

/**
 * The `session.search` input: the text typed in the search box and, past the first page, the
 * previous page's `nextCursor`. The daemon matches the text against every session's title,
 * message text, tool calls, group name and tags, archived sessions included, and every hit is
 * reachable page by page. `limit` caps the hits on one page, at most
 * {@link SESSION_SEARCH_PAGE_LIMIT_MAX}, which is also the default.
 */
export interface SessionSearchRequest {
  query: string;
  afterCursor?: SessionSearchCursor | undefined;
  limit?: number | undefined;
}
/** Parses a {@link SessionSearchRequest}. */
export const SessionSearchRequestSchema: z.ZodType<SessionSearchRequest, SessionSearchRequest> = z
  .object({
    query: wireFreeFormString(SESSION_SEARCH_QUERY_MAX_LEN, "SessionSearchRequest.query"),
    afterCursor: SessionSearchCursorSchema.optional(),
    limit: z.number().int().positive().max(SESSION_SEARCH_PAGE_LIMIT_MAX).optional(),
  })
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
    line: z.string().max(SESSION_SEARCH_HIT_LINE_MAX_LEN),
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

/**
 * One `session.search` page: hits grouped by session, the sessions in the order of their best
 * hit and each session's hits best first. A session's hits stay on one page unless they alone
 * overflow a page; then that session fills the page and the next page continues it under the same
 * `sessionId`. A continuing page carries at least one group and the cursor to continue from.
 */
export type SessionSearchResponse =
  | {
      groups: [SessionSearchGroup, ...SessionSearchGroup[]];
      hasMore: true;
      nextCursor: SessionSearchCursor;
    }
  | { groups: SessionSearchGroup[]; hasMore: false };

/**
 * Parses a {@link SessionSearchResponse}: a page carries at most
 * {@link SESSION_SEARCH_PAGE_LIMIT_MAX} hits and fits the shared page budget.
 */
export const SessionSearchResponseSchema: z.ZodType<SessionSearchResponse> = z
  .discriminatedUnion("hasMore", [
    z
      .object({
        groups: z.tuple([SessionSearchGroupSchema], SessionSearchGroupSchema),
        hasMore: z.literal(true),
        nextCursor: SessionSearchCursorSchema,
      })
      .strict(),
    z.object({ groups: z.array(SessionSearchGroupSchema), hasMore: z.literal(false) }).strict(),
  ])
  .superRefine((page, issueContext) => {
    const hitCount = page.groups.reduce((total, group) => total + group.hits.length, 0);
    if (hitCount > SESSION_SEARCH_PAGE_LIMIT_MAX) {
      issueContext.addIssue({
        code: "custom",
        path: ["groups"],
        message: `a page carries at most ${String(SESSION_SEARCH_PAGE_LIMIT_MAX)} hits, not ${String(hitCount)}`,
      });
    }
    requireMemberToRideOneFrame(page.groups, "groups", issueContext);
  });

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
 * A `session.fileSearch` whose session has no working folder in place, yet or any more; nothing is
 * listed. `data.fields`: `sessionId`.
 */
export const SESSION_WORKING_FOLDER_UNAVAILABLE_CODE =
  "session.working_folder_unavailable" as const;

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
  /**
   * `Continue from here`: the session's last good point becomes its end, its damaged events are
   * skipped from then on, and it takes new work again. Refused with `session.recovery_refused`.
   */
  readonly "session.recoveryContinue": MethodDescriptor<
    "session.recoveryContinue",
    SessionTargetRequest,
    SessionVerbResponse
  >;
  /**
   * `Delete session` on a session whose history is damaged: every row of it goes, the copy set
   * aside before the repair stays. Refused with `session.recovery_refused` (`not_damaged`).
   */
  readonly "session.recoveryDelete": MethodDescriptor<
    "session.recoveryDelete",
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
  readonly "session.convertSkippedFileList": MethodDescriptor<
    "session.convertSkippedFileList",
    SessionConvertSkippedFileListRequest,
    SessionConvertSkippedFileListResponse
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
  "session.recoveryContinue": sessionVerb("session.recoveryContinue"),
  "session.recoveryDelete": sessionVerb("session.recoveryDelete"),
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
  "session.convertSkippedFileList": {
    method: "session.convertSkippedFileList",
    procedureType: "query",
    mutating: false,
    requestSchema: SessionConvertSkippedFileListRequestSchema,
    responseSchema: SessionConvertSkippedFileListResponseSchema,
  },
});
