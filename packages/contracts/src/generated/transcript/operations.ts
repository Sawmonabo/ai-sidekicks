// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The transcript reads: `transcript.read`, the reasoning read and the child-run expansion, each page held to the shared page budget; the run facts a window serves; and the reads of a row's large body and of a tool call's left-out patches.

import type { HydratedContentUnavailableReason } from "../event/envelope.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { ProviderAccountId } from "../provider/account/record.js";
import type { ToolCallId } from "../provider/tool-call.js";
import type { RunId } from "../run/id.js";
import type { RunState } from "../run/state.js";
import type { EventCursor, SessionId } from "../session/id.js";
import type { BlockCutFailure, TranscriptReadRow } from "./row.js";

/**
 * The most entries one reasoning page carries. Durable reasoning is summary-first, so a reply
 * needing more has stopped being a summary.
 */
export const REASONING_SURFACE_ENTRIES_MAX = 256 as const;

/** The longest one reasoning entry's `content`, in code points. */
export const REASONING_ENTRY_CONTENT_MAX_LEN = 16384 as const;

/** Every `agent.run.<state>` event type, in the order the states are declared. */
export const RUN_STATE_EVENT_TYPES = [
  "agent.run.queued",
  "agent.run.starting",
  "agent.run.running",
  "agent.run.waitingForApproval",
  "agent.run.waitingForInput",
  "agent.run.pausing",
  "agent.run.paused",
  "agent.run.completed",
  "agent.run.interrupted",
  "agent.run.stopped",
  "agent.run.failed",
] as const;

/** The type of a person's message, which is never a run's own event even when it steers one. */
export const USER_MESSAGE_EVENT_TYPE = "user.message.sent" as const;

/**
 * An event type that moves a run into a state: `agent.run.<state>`, one per state.
 */
export type RunStateEventType =
  | "agent.run.queued"
  | "agent.run.starting"
  | "agent.run.running"
  | "agent.run.waitingForApproval"
  | "agent.run.waitingForInput"
  | "agent.run.pausing"
  | "agent.run.paused"
  | "agent.run.completed"
  | "agent.run.interrupted"
  | "agent.run.stopped"
  | "agent.run.failed";
/**
 * The row's body, one part at a time, or why it cannot be read. `contentLength` is echoed from the
 * stored event, so each part says how long the whole is. Each part fits one page; a body longer
 * than one page comes back whole in consecutive parts.
 */
export type TranscriptBodyReadResponse =
  | {
      status: "available";
      /**
       * This part of the body.
       */
      body: string;
      /**
       * Where this part starts, as a UTF-8 byte offset into the body.
       */
      offset: number;
      /**
       * Where the next part starts, or `null` on the last part.
       */
      nextOffset: number | null;
      /**
       * The whole body's UTF-8 byte length, echoed from the stored payload.
       */
      contentLength?: number;
      /**
       * The block starts of a prose body that fall in this part, as UTF-16 offsets into the
       * whole drawn body; on a body whose reply is still arriving, only those no later text
       * can move.
       */
      blockStarts?: Uint8Array;
      /**
       * Why a prose body carries no block starts, when its cut failed; never beside them.
       */
      blockCutFailure?: BlockCutFailure;
    }
  | {
      status: "unavailable";
      /**
       * Why.
       */
      reason: HydratedContentUnavailableReason;
    };
/**
 * One file's patch, or why there is none: no patch came, one came that this version cannot read,
 * or the log cannot read the file whole.
 */
export type TranscriptPatchFile =
  | {
      /**
       * The file's path; a file the call moved is named by its new path.
       */
      path: string;
      /**
       * The old path of a file the call moved.
       */
      oldPath?: string;
      /**
       * The patch.
       */
      patch: string;
      /**
       * The lines it adds.
       */
      additions: number;
      /**
       * The lines it removes.
       */
      deletions: number;
      /**
       * Never present: the patch was read.
       */
      unavailable?: never;
      /**
       * Never present: the patch was read.
       */
      rawPatch?: never;
    }
  | {
      /**
       * The file's path; a file the call moved is named by its new path.
       */
      path: string;
      /**
       * The old path of a file the call moved.
       */
      oldPath?: string;
      /**
       * Always `absent`.
       */
      unavailable: "absent";
      /**
       * Never present: no patch came.
       */
      patch?: never;
      /**
       * Never present: no patch came.
       */
      additions?: never;
      /**
       * Never present: no patch came.
       */
      deletions?: never;
      /**
       * Never present: no patch came.
       */
      rawPatch?: never;
    }
  | {
      /**
       * The file's path; a file the call moved is named by its new path.
       */
      path: string;
      /**
       * The old path of a file the call moved.
       */
      oldPath?: string;
      /**
       * Always `unreadable`.
       */
      unavailable: "unreadable";
      /**
       * The patch as the provider sent it.
       */
      rawPatch: string;
      /**
       * Never present: the patch could not be read.
       */
      patch?: never;
      /**
       * Never present: the patch could not be read.
       */
      additions?: never;
      /**
       * Never present: the patch could not be read.
       */
      deletions?: never;
    }
  | {
      /**
       * The file's path; a file the call moved is named by its new path.
       */
      path: string;
      /**
       * The old path of a file the call moved.
       */
      oldPath?: string;
      /**
       * Always `damaged`.
       */
      unavailable: "damaged";
      /**
       * Never present: the patch cannot be read back.
       */
      patch?: never;
      /**
       * Never present: the patch cannot be read back.
       */
      additions?: never;
      /**
       * Never present: the patch cannot be read back.
       */
      deletions?: never;
      /**
       * Never present: the patch cannot be read back.
       */
      rawPatch?: never;
    };
/**
 * One read window, split on `hasMore`.
 */
export type TranscriptReadResponse =
  | {
      /**
       * The rows, oldest first, within the page budget the runs leave.
       *
       * @maxItems 256
       */
      entries: TranscriptReadRow[];
      /**
       * The facts of each run the entries name, folded over the whole log, one per run.
       *
       * @maxItems 256
       */
      runs: TranscriptRunFacts[];
      /**
       * More rows follow.
       */
      hasMore: true;
      /**
       * Where to continue.
       */
      nextCursor: EventCursor;
      /**
       * The newest event the page's rows joined their pieces through. A reader opens its stream at
       * the earliest page's, so a piece stored after it reaches the reader on the stream, placed in
       * its row by its offset.
       */
      joinedThrough: EventCursor;
    }
  | {
      /**
       * The rows, oldest first, within the page budget the runs leave.
       *
       * @maxItems 256
       */
      entries: TranscriptReadRow[];
      /**
       * The facts of each run the entries name, folded over the whole log, one per run.
       *
       * @maxItems 256
       */
      runs: TranscriptRunFacts[];
      /**
       * No rows follow.
       */
      hasMore: false;
      /**
       * Where the window ended.
       */
      nextCursor?: EventCursor;
      /**
       * The newest event the page's rows joined their pieces through; absent on a session with no
       * readable event.
       */
      joinedThrough?: EventCursor;
    };
/**
 * The reasoning reply: an `available` page, continuing or last, or `unavailable`, which carries
 * neither entries nor a cursor.
 */
export type TranscriptReasoningReadResponse =
  | {
      /**
       * The reasoning is readable.
       */
      availability: "available";
      /**
       * The entries, oldest first.
       *
       * @minItems 1
       * @maxItems 256
       */
      reasoningEntries: [ReasoningEntry, ...ReasoningEntry[]];
      /**
       * More entries follow.
       */
      hasMore: true;
      /**
       * Where to continue.
       */
      nextCursor: EventCursor;
    }
  | {
      /**
       * The reasoning is readable.
       */
      availability: "available";
      /**
       * The entries, oldest first.
       *
       * @maxItems 256
       */
      reasoningEntries: ReasoningEntry[];
      /**
       * No entries follow.
       */
      hasMore: false;
      /**
       * Where the page ended.
       */
      nextCursor?: EventCursor;
    }
  | {
      /**
       * The reasoning is not readable.
       */
      availability: "unavailable";
    };
/**
 * The expansion, split on `hasMore` like the read window: a long-running child run can produce
 * more rows than fit one frame.
 */
export type TranscriptChildRunExpandResponse =
  | {
      /**
       * The child run.
       */
      runId: RunId;
      /**
       * The run that started it; never the child itself.
       */
      parentRunId: RunId;
      /**
       * The child's state.
       */
      state: RunState;
      /**
       * The run's rows, oldest first, each with its body.
       *
       * @maxItems 256
       */
      entries: TranscriptReadRow[];
      /**
       * More rows follow.
       */
      hasMore: true;
      /**
       * Where to continue.
       */
      nextCursor: EventCursor;
      /**
       * The newest event the page's rows joined their pieces through.
       */
      joinedThrough: EventCursor;
    }
  | {
      /**
       * The child run.
       */
      runId: RunId;
      /**
       * The run that started it; never the child itself.
       */
      parentRunId: RunId;
      /**
       * The child's state.
       */
      state: RunState;
      /**
       * The run's rows, oldest first, each with its body.
       *
       * @maxItems 256
       */
      entries: TranscriptReadRow[];
      /**
       * No rows follow.
       */
      hasMore: false;
      /**
       * Where the expansion ended.
       */
      nextCursor?: EventCursor;
      /**
       * The newest event the page's rows joined their pieces through; absent on a session with
       * no readable event.
       */
      joinedThrough?: EventCursor;
    };

/**
 * One run's facts as a `transcript.read` window serves them, folded over the log through
 * `foldedThroughSequence`. The header's state word is `stateEventType` unless a rewind came after
 * it; the run has ended when that state is a terminal one and no rewind came after it.
 */
export interface TranscriptRunFacts {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * Who the run's first event naming anyone names, wire-verbatim.
   */
  actor?: string;
  /**
   * The account the run was admitted under, as its creation named it.
   */
  admittedProviderAccountId?: ProviderAccountId;
  /**
   * The newest `agent.run.<state>` type the run entered, kept across a rewind.
   */
  stateEventType?: RunStateEventType;
  /**
   * Whether an `agent.run.rolledBack` came after `stateEventType`.
   */
  isRewound: boolean;
  /**
   * The sequence the facts hold through: an event at or below it is already in them.
   */
  foldedThroughSequence: number;
}
/**
 * The one row whose large body or full output a client opens. `rowId` is the row's `id`, the id
 * of the event the row renders.
 */
export interface TranscriptBodyReadRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The row.
   */
  rowId: string;
  /**
   * Where the part starts: a UTF-8 byte offset into the body, on a character boundary and not
   * past its end; the body's start when absent.
   */
  offset?: number;
}
/**
 * Where a part of a patch read starts: the left-out file's index in the call's `omittedPatches`
 * order, and a UTF-8 byte offset into its patch or raw text, on a character boundary.
 */
export interface TranscriptPatchCursor {
  /**
   * The file's index.
   */
  fileIndex: number;
  /**
   * The byte offset into its patch or raw text.
   */
  offset: number;
}
/**
 * The tool call whose left-out patches a diff needs, from `cursor` on.
 */
export interface TranscriptPatchListRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * The tool call.
   */
  toolCallId: ToolCallId;
  /**
   * Where the part starts; the first file's start when absent.
   */
  cursor?: TranscriptPatchCursor;
}
/**
 * The patches the call left out from the request's `cursor` on, as many as fit one page, so a
 * call with several missing files is drawn from few reads. The first entry's patch or raw text
 * starts at the cursor's offset and the last one's ends where `next` starts; the client joins the
 * pieces of one file in order.
 */
export interface TranscriptPatchListResponse {
  /**
   * The files.
   */
  files: TranscriptPatchFile[];
  /**
   * Where the next part starts, or `null` on the last part.
   */
  next: TranscriptPatchCursor | null;
}
/**
 * A bounded read window over one session's transcript. A cursor is a position in the log, and
 * the cursor an event carries is the position right after it: `afterCursor` answers the events
 * after its position and `beforeCursor` those before it, so a page before a window's head and the
 * stream after it meet with nothing missed or repeated. `aroundCursor` names one row by its cursor
 * and answers the window around it, that row always among the entries, or refuses the read with
 * `transcript.row.notFound` when no row stands there; its page continues as a `beforeCursor`
 * page does, `nextCursor` toward the start, and the rows after it are read from its newest row's
 * cursor.
 */
export interface TranscriptReadRequest {
  /**
   * The session.
   */
  sessionId: SessionId;
  /**
   * Answer the events after this position.
   */
  afterCursor?: EventCursor;
  /**
   * Answer the events before this position.
   */
  beforeCursor?: EventCursor;
  /**
   * Answer the window around the row at this cursor, refused when no row stands there.
   */
  aroundCursor?: EventCursor;
  /**
   * The most rows to answer.
   */
  limit?: number;
}
/**
 * A run's reasoning, from `afterCursor` when continuing. The cursor is an event position, since a
 * reasoning entry is projected from the run's events.
 */
export interface TranscriptReasoningReadRequest {
  /**
   * The run.
   */
  runId: RunId;
  /**
   * Continue after this position.
   */
  afterCursor?: EventCursor;
}
/**
 * One reasoning entry: consecutive pieces of one reasoning row, joined, up to one entry's cap. A
 * text longer than that spans consecutive entries of the same row, which a reader joins.
 */
export interface ReasoningEntry {
  /**
   * The sequence of the last event it holds, so a page continues exactly after it.
   */
  sequence: number;
  /**
   * The row it belongs to: the id of the row's first event.
   */
  rowId: string;
  /**
   * The reasoning text, whitespace kept as the provider sent it.
   */
  content: string;
  /**
   * When it was produced.
   */
  timestamp: WireInstant;
}
/**
 * Expands one summarized child-run row into its own rows, continuing from `afterCursor` when the
 * previous expansion did not reach the end.
 */
export interface TranscriptChildRunExpandRequest {
  /**
   * The child run.
   */
  runId: RunId;
  /**
   * Continue after this position.
   */
  afterCursor?: EventCursor;
}

export {
  validateRunStateEventType,
  validateTranscriptBodyReadRequest,
  validateTranscriptBodyReadResponse,
  validateTranscriptReadRequest,
  validateTranscriptReadResponse,
  validateTranscriptRunFacts,
} from "../checks/transcript/operations.js";
