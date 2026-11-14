// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The session read and subscribe shapes, the frame a session's stream sends, the verbs called on one session, the two searches and the read of a conversion's skipped files.

import type { SchemaCheck } from "../../schema-check.js";
import type { AgentId } from "../agent/definition.js";
import { validateEmptyPayload } from "../checks/method-descriptor.js";
import {
  validateSessionConversionSkippedFileListRequest,
  validateSessionConversionSkippedFileListResponse,
} from "../checks/session/convert.js";
import {
  validateSessionFileSearchRequest,
  validateSessionFileSearchResponse,
  validateSessionReadRequest,
  validateSessionReadResponse,
  validateSessionRenameRequest,
  validateSessionRenameResponse,
  validateSessionSearchRequest,
  validateSessionSearchResponse,
  validateSessionTargetRequest,
} from "../checks/session/methods.js";
import type { EventEnvelope } from "../event/envelope.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { EmptyPayload } from "../method-descriptor.js";
import type { Place } from "../place.js";
import type { ProviderAccountId } from "../provider/account/record.js";
import type { RunId } from "../run/id.js";
import type { RunState } from "../run/state.js";
import type { TagList } from "../tag.js";
import type { ChildRunSummary } from "../transcript/child-run-summary.js";
import type {
  BlockCutFailure,
  TranscriptRowContent,
  TranscriptRunStamp,
} from "../transcript/row.js";
import type { PermissionLevel, SessionMode } from "./controls/methods.js";
import type {
  SessionConversionSkippedFileListRequest,
  SessionConversionSkippedFileListResponse,
} from "./convert.js";
import type { HeldSessionDraft, SessionAttachmentSummary } from "./draft.js";
import type { EventCursor, SessionId } from "./id.js";

/** The words a chat with no name reads by where no first message stands in for one. */
export const UNTITLED_CHAT_NAME = "New chat" as const;

/** The words a project session with no name reads by where no first message stands in for one. */
export const UNTITLED_PROJECT_NAME = "New session" as const;

/**
 * Where a session is in its lifecycle.
 */
export type SessionState = "provisioning" | "active" | "archived" | "closed" | "purgeRequested";
/**
 * What a session is bound to, kept as a stored fact rather than a mode flag: a `chat` works in a
 * managed workspace the daemon owns, a `project` in a repository the person attached. Converting
 * a chat changes it in place, so it is read from the session, never fixed at creation.
 */
export type SessionShape = "chat" | "project";
/**
 * The value of each `session.event.subscribe` notify: the changes since the previous frame,
 * or the mark that the stream was moved to the log's head.
 */
export type SessionStreamFrame =
  | {
      kind: "changes";
      /**
       * The changes, oldest first.
       *
       * @minItems 1
       * @maxItems 50
       */
      changes: [SessionStreamChange, ...SessionStreamChange[]];
    }
  | {
      kind: "behind";
      /**
       * The head the stream carries on from.
       */
      headCursor: EventCursor;
    };
/**
 * Where the next `session.search` page starts. The daemon writes it and owns its format; a
 * client passes it back unchanged with the same query. A cursor of a search the daemon has
 * let go is refused, and the client searches again.
 */
export type SessionSearchCursor = string & { readonly __brand: "SessionSearchCursor" };
/**
 * One `session.search` page: hits grouped by session, each session's hits best first. A
 * session's hits stay on one page unless they alone overflow it; then the next page continues
 * that session under the same `sessionId`.
 */
export type SessionSearchResponse =
  | {
      /**
       * The hits grouped by session, sessions in the order of their best hit.
       *
       * @minItems 1
       */
      groups: [SessionSearchGroup, ...SessionSearchGroup[]];
      /**
       * More hits follow.
       */
      hasMore: true;
      /**
       * Where to continue.
       */
      nextCursor: SessionSearchCursor;
    }
  | {
      /**
       * The hits grouped by session, sessions in the order of their best hit.
       */
      groups: SessionSearchGroup[];
      /**
       * No hits follow.
       */
      hasMore: false;
    };
/**
 * What a `session.file.search` row names.
 */
export type SessionFileSearchEntryKind = "file" | "folder";

/**
 * One inbox the daemon holds for a session, in one place. A computer without a WSL 2
 * distribution holds one, which names no place.
 */
export interface SessionAddress {
  /**
   * The place.
   */
  place?: Place;
  /**
   * The inbox's address, in that place's own form.
   */
  address: string;
}
/**
 * One session as `session.read` answers it. Its tags fit the shared page budget.
 */
export interface SessionRecord {
  /**
   * The session.
   */
  id: SessionId;
  /**
   * Its lifecycle state.
   */
  state: SessionState;
  /**
   * Its shape.
   */
  shape: SessionShape;
  /**
   * Where it runs, written at its creation and never changed; absent on macOS and Linux.
   */
  place?: Place;
  /**
   * Its name; absent while untitled, when a surface shows its first message.
   */
  name?: string;
  /**
   * Whether the person muted its notifications.
   */
  muted: boolean;
  /**
   * The move its next run boundary applies, or `null` when none waits.
   */
  pendingWorkingFolder: {
    /**
     * The folder it moves to.
     */
    path: string;
  } | null;
  /**
   * When it was made.
   */
  createdAt: WireInstant;
  /**
   * When it last changed.
   */
  updatedAt: WireInstant;
  /**
   * The unsent composer draft, whole, with the revision a save carries back; an empty draft at
   * revision 0 before any draft was held.
   */
  heldDraft: HeldSessionDraft;
  /**
   * The whole staged set of files, so every device opens the same half-written message.
   */
  attachments: SessionAttachmentSummary[];
  /**
   * The session's own bound on the steps one turn may take; absent where the person set none,
   * and the machine's Runtime value applies.
   */
  maxStepsPerTurn?: number;
  /**
   * The level it runs at, as the level control reads it.
   */
  permissionLevel: PermissionLevel;
  /**
   * Whether its next turns plan or build, as the mode control reads it.
   */
  sessionMode: SessionMode;
  /**
   * The addresses another session writes to when it messages this one: an inbox the daemon
   * holds for it in each place where a provider that messages other sessions is installed, the
   * session's own place first, each stable for its whole life.
   *
   * @minItems 1
   */
  addresses: [SessionAddress, ...SessionAddress[]];
  /**
   * Its tags as first written, in the order of their case fold.
   */
  tags: TagList;
}
/**
 * The session `session.read` answers with.
 */
export interface SessionReadRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * One run of the session not yet ended, as the daemon's run record holds it now.
 */
export interface SessionLiveRun {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * The run that started it; absent on a lead run.
   */
  parentRunId?: RunId;
  /**
   * Its state now.
   */
  state: RunState;
  /**
   * Its record's version.
   */
  runVersion: number;
  /**
   * The agent the run was created for, as its `agent.run.queued` names it.
   */
  agentId: AgentId;
  /**
   * Who the run's first event naming anyone names, as sent; absent while none has.
   */
  actor?: string;
  /**
   * The account the run was admitted under, as its creation named it.
   */
  admittedProviderAccountId: ProviderAccountId;
  /**
   * When the run's newest `runLifecycle` event occurred.
   */
  touchedAt: WireInstant;
}
/**
 * One event of the session's log a `session.read` carries whole, at the position the stream
 * delivers it at.
 */
export interface SessionStandingEvent {
  /**
   * Its position.
   */
  cursor: EventCursor;
  /**
   * The event.
   */
  event: EventEnvelope;
}
/**
 * The `session.read` result: the session, its transcript cursors, its runs not yet ended and its
 * standing events. A reader opens its window at `latest`; the live runs and the standing events
 * give it what the events above that window settled.
 */
export interface SessionReadResponse {
  /**
   * The session.
   */
  session: SessionRecord;
  /**
   * Its transcript cursors.
   */
  transcriptCursors: {
    /**
     * The position just before the oldest surviving event, so a read after it misses none.
     */
    earliest: EventCursor;
    /**
     * The newest position.
     */
    latest: EventCursor;
  };
  /**
   * Every run not yet ended, with the state it is in now, so a window opened below a run's
   * earlier events still knows whether that run is working or waiting.
   */
  liveRuns: SessionLiveRun[];
  /**
   * The newest event of each kind a reader keeps a standing fact from, in sequence order, so a
   * window opened below them still reads those facts.
   */
  standingEvents: SessionStandingEvent[];
}
/**
 * The `session.event.subscribe` input: the session to follow and an `afterCursor` to catch up
 * from.
 */
export interface SessionEventSubscribeRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Catch up from after this position.
   */
  afterCursor?: EventCursor;
}
/**
 * One piece of a reply or of reasoning on the stream: the row it joins, where its text starts in
 * that row's whole body, its text, and the block starts the row froze with it. A reader places a
 * piece it already read in a row by its offset, so a piece the stream and a read both carry is
 * never drawn twice.
 */
export interface SessionStreamPiece {
  /**
   * The row: the id of its first event, which a read and `transcript.body.read` name it by.
   */
  rowId: string;
  /**
   * Where the piece's text starts in the row's whole body, as a UTF-8 byte offset.
   */
  offset: number;
  /**
   * The piece's text, or its size alone when it is too large to travel inline.
   */
  content: TranscriptRowContent;
  /**
   * The row's block starts this piece froze, as UTF-16 offsets into the row's whole drawn
   * body; a frozen start never moves.
   */
  blockStarts?: Uint8Array;
  /**
   * Why the row's cut failed with this piece, after which its later pieces carry no starts.
   */
  blockCutFailure?: BlockCutFailure;
}
/**
 * A row an event ended, with the block starts its last pieces left unsent.
 */
export interface SessionStreamEndedRow {
  /**
   * The row: the id of its first event.
   */
  rowId: string;
  /**
   * The rest of its block starts, as UTF-16 offsets into its whole drawn body; absent when
   * none.
   */
  blockStarts?: Uint8Array;
  /**
   * Why the cut of its last text failed; never beside starts.
   */
  blockCutFailure?: BlockCutFailure;
}
/**
 * One change on a session's stream: an event of the session's log, the cursor it sits at and,
 * exactly when the event belongs to a run, the daemon's run stamp for it. A piece of a reply or of
 * reasoning also carries its text and its place in its row; a child run's event carries the
 * child's summary; and a change that ends rows carries the rest of their block starts.
 */
export interface SessionStreamChange {
  /**
   * The event's position.
   */
  cursor: EventCursor;
  /**
   * The event, as its envelope, so a type this reader does not know still parses.
   */
  event: EventEnvelope;
  /**
   * The run stamp; absent on a session-level event.
   */
  runStamp?: TranscriptRunStamp;
  /**
   * On a piece of a reply or of reasoning: its text and where it sits in its row. A tool
   * completion is never one: it goes out once, whole, and the parts storing its patches never.
   */
  piece?: SessionStreamPiece;
  /**
   * On an event of a child run: the child's summary as of this event.
   */
  childRunSummary?: ChildRunSummary;
  /**
   * The rows this event ends, each with the block starts it had not yet sent.
   *
   * @minItems 1
   */
  endedRows?: [SessionStreamEndedRow, ...SessionStreamEndedRow[]];
}
/**
 * The request of every verb that acts on one session and takes nothing else.
 */
export interface SessionTargetRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
}
/**
 * The `session.rename` input. `null` clears the name, and the session reads as untitled again.
 * Renaming never renames the session's branch or worktree.
 */
export interface SessionRenameRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The new name, or `null` to clear it.
   */
  name: string | null;
}
/**
 * The `session.rename` result: the name the session now holds, `null` when untitled.
 */
export interface SessionRenameResponse {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The name, or `null`.
   */
  name: string | null;
}
/**
 * The `session.search` input: the text typed in the search box and, past the first page, the
 * previous page's `nextCursor`. The daemon matches it against every session's title, message
 * text, tool calls, group name and tags, archived sessions included.
 */
export interface SessionSearchRequest {
  /**
   * The text to find.
   */
  query: string;
  /**
   * Continue from this cursor.
   */
  afterCursor?: SessionSearchCursor;
  /**
   * The most hits on one page; the default is the most.
   */
  limit?: number;
}
/**
 * A matched stretch of a search hit's text, in UTF-16 code units: `start` inclusive, `end`
 * exclusive, ending after it starts.
 */
export interface SearchMatchRange {
  /**
   * The first unit matched.
   */
  start: number;
  /**
   * The unit after the last matched.
   */
  end: number;
}
/**
 * One hit: the line of the message the match sits in, the matched stretches to mark, and the
 * message's cursor, which lands the transcript on it and loads whatever history that takes.
 */
export interface SessionSearchHit {
  /**
   * The message's position.
   */
  cursor: EventCursor;
  /**
   * The line the match sits in.
   */
  line: string;
  /**
   * The matched stretches.
   *
   * @minItems 1
   */
  matchRanges: [SearchMatchRange, ...SearchMatchRange[]];
}
/**
 * The hits in one session, under that session's name; an untitled session has no `name`.
 */
export interface SessionSearchGroup {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Its name.
   */
  name?: string;
  /**
   * Its hits, best first.
   *
   * @minItems 1
   */
  hits: [SessionSearchHit, ...SessionSearchHit[]];
}
/**
 * The `session.file.search` input: the text typed after `@` in a session's draft. An empty query
 * lists the working folder's files and folders; the list narrows as the name is typed.
 */
export interface SessionFileSearchRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The text typed.
   */
  query: string;
}
/**
 * One `session.file.search` row: a path relative to the working folder, and whether it names a
 * file or a folder.
 */
export interface SessionFileSearchEntry {
  /**
   * The path, relative to the working folder.
   */
  path: string;
  /**
   * What it names.
   */
  kind: SessionFileSearchEntryKind;
}
/**
 * The `session.file.search` result: the matching files and folders, each path relative to the
 * working folder, best first, and how many files the query was matched against, never fewer than
 * the files it matched. A search that failed is an error, never an empty result.
 */
export interface SessionFileSearchResponse {
  /**
   * The files and folders, best first.
   */
  entries: SessionFileSearchEntry[];
  /**
   * How many files the query was matched against.
   */
  searchedFileCount: number;
}

export {
  validateSearchMatchRange,
  validateSessionAddress,
  validateSessionEventSubscribeRequest,
  validateSessionFileSearchEntry,
  validateSessionFileSearchEntryKind,
  validateSessionFileSearchRequest,
  validateSessionFileSearchResponse,
  validateSessionLiveRun,
  validateSessionReadRequest,
  validateSessionReadResponse,
  validateSessionRecord,
  validateSessionRenameRequest,
  validateSessionRenameResponse,
  validateSessionSearchCursor,
  validateSessionSearchGroup,
  validateSessionSearchHit,
  validateSessionSearchRequest,
  validateSessionSearchResponse,
  validateSessionShape,
  validateSessionStandingEvent,
  validateSessionState,
  validateSessionStreamChange,
  validateSessionStreamEndedRow,
  validateSessionStreamFrame,
  validateSessionStreamPiece,
  validateSessionTargetRequest,
} from "../checks/session/methods.js";

/** The methods of {@link SESSION_METHOD_DESCRIPTORS}, each with its checks. */
export interface SessionMethodDescriptors {
  readonly "session.read": {
    readonly method: "session.read";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionReadRequest>;
    readonly responseCheck: SchemaCheck<SessionReadResponse>;
  };
  readonly "session.rename": {
    readonly method: "session.rename";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionRenameRequest>;
    readonly responseCheck: SchemaCheck<SessionRenameResponse>;
  };
  readonly "session.archive": {
    readonly method: "session.archive";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTargetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.reactivate": {
    readonly method: "session.reactivate";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTargetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.close": {
    readonly method: "session.close";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTargetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.pin": {
    readonly method: "session.pin";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTargetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.unpin": {
    readonly method: "session.unpin";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTargetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.mute": {
    readonly method: "session.mute";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTargetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.unmute": {
    readonly method: "session.unmute";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTargetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.restart": {
    readonly method: "session.restart";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTargetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.recovery.continue": {
    readonly method: "session.recovery.continue";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTargetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.recovery.delete": {
    readonly method: "session.recovery.delete";
    readonly procedureType: "mutation";
    readonly mutating: true;
    readonly requestCheck: SchemaCheck<SessionTargetRequest>;
    readonly responseCheck: SchemaCheck<EmptyPayload>;
  };
  readonly "session.search": {
    readonly method: "session.search";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionSearchRequest>;
    readonly responseCheck: SchemaCheck<SessionSearchResponse>;
  };
  readonly "session.file.search": {
    readonly method: "session.file.search";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionFileSearchRequest>;
    readonly responseCheck: SchemaCheck<SessionFileSearchResponse>;
  };
  readonly "session.conversion.skippedFile.list": {
    readonly method: "session.conversion.skippedFile.list";
    readonly procedureType: "query";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<SessionConversionSkippedFileListRequest>;
    readonly responseCheck: SchemaCheck<SessionConversionSkippedFileListResponse>;
  };
}
/** The `session.*` methods on one session, its searches and its conversion's skipped files. */
export const SESSION_METHOD_DESCRIPTORS: SessionMethodDescriptors = /* @__PURE__ */ Object.freeze({
  "session.read": /* @__PURE__ */ Object.freeze({
    method: "session.read",
    procedureType: "query",
    mutating: false,
    requestCheck: validateSessionReadRequest,
    responseCheck: validateSessionReadResponse,
  }),
  "session.rename": /* @__PURE__ */ Object.freeze({
    method: "session.rename",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionRenameRequest,
    responseCheck: validateSessionRenameResponse,
  }),
  "session.archive": /* @__PURE__ */ Object.freeze({
    method: "session.archive",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTargetRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.reactivate": /* @__PURE__ */ Object.freeze({
    method: "session.reactivate",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTargetRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.close": /* @__PURE__ */ Object.freeze({
    method: "session.close",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTargetRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.pin": /* @__PURE__ */ Object.freeze({
    method: "session.pin",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTargetRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.unpin": /* @__PURE__ */ Object.freeze({
    method: "session.unpin",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTargetRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.mute": /* @__PURE__ */ Object.freeze({
    method: "session.mute",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTargetRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.unmute": /* @__PURE__ */ Object.freeze({
    method: "session.unmute",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTargetRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.restart": /* @__PURE__ */ Object.freeze({
    method: "session.restart",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTargetRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.recovery.continue": /* @__PURE__ */ Object.freeze({
    method: "session.recovery.continue",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTargetRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.recovery.delete": /* @__PURE__ */ Object.freeze({
    method: "session.recovery.delete",
    procedureType: "mutation",
    mutating: true,
    requestCheck: validateSessionTargetRequest,
    responseCheck: validateEmptyPayload,
  }),
  "session.search": /* @__PURE__ */ Object.freeze({
    method: "session.search",
    procedureType: "query",
    mutating: false,
    requestCheck: validateSessionSearchRequest,
    responseCheck: validateSessionSearchResponse,
  }),
  "session.file.search": /* @__PURE__ */ Object.freeze({
    method: "session.file.search",
    procedureType: "query",
    mutating: false,
    requestCheck: validateSessionFileSearchRequest,
    responseCheck: validateSessionFileSearchResponse,
  }),
  "session.conversion.skippedFile.list": /* @__PURE__ */ Object.freeze({
    method: "session.conversion.skippedFile.list",
    procedureType: "query",
    mutating: false,
    requestCheck: validateSessionConversionSkippedFileListRequest,
    responseCheck: validateSessionConversionSkippedFileListResponse,
  }),
});
