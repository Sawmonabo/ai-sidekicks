// The state one session store holds, and the base state a read establishes. Its own module
// because the selectors, the hooks and the store all read it, and a shape declared inside the
// writing class would force every reader to import the writer.

import type { EventCursor } from "@ai-sidekicks/contracts/session/event-cursor";

import { worstDegradedCause, type SessionDegradedCause } from "./degradation.js";
import {
  emptyPartitions,
  type StoredEntity,
  type ProjectedSessionEvent,
} from "./entities/vocabulary.js";
import type { SessionPartitions } from "./entities/partitions.js";
import { UNPLACED_CURSOR, type SequenceGap } from "./sequence-reconciler.js";

/** One end of the transcript the store holds. */
export interface TranscriptWindowEdge {
  /**
   * The cursor a read beyond this edge is asked with: `beforeCursor` at the head, `afterCursor`
   * at the tail.
   */
  readonly cursor: EventCursor | undefined;
  /** Whether the daemon holds events beyond this edge that the store does not. */
  readonly hasMore: boolean;
}

/** The newest end of the transcript the store holds, and whether the stream still extends it. */
export interface TranscriptWindowTail extends TranscriptWindowEdge {
  /**
   * `live` while the tail is the log's newest event and stream events append to it; `detached`
   * once rows past it were let go or never read, while stream events still fold into entities
   * but not into the transcript.
   */
  readonly following: "live" | "detached";
}

/** The immutable state one session store holds. */
export interface SessionStoreState {
  readonly sessionId: string;
  /** `false` until `initialize()` supplies a read response. */
  readonly initialized: boolean;
  /** Entity maps, one per kind. Only touched partitions change identity. */
  readonly partitions: SessionPartitions;
  /**
   * The window of the session's log the store holds, oldest to newest, between
   * {@link transcriptHead} and {@link transcriptTail}. A bounded share of the log: the reader's
   * pages grow it at either edge, `releaseOutside` lets go of what lies far from the reading
   * position, and a session no screen shows keeps only its newest rows.
   */
  readonly transcript: readonly ProjectedSessionEvent[];
  /**
   * The highest sequence the stream has admitted, or `UNPLACED_CURSOR` while it has admitted none
   * since a base state that named no sequence. It runs ahead of the transcript's newest row while
   * the tail is detached.
   */
  readonly cursor: number;
  /**
   * The daemon-issued position of the row at {@link cursor}, or of the base state before the stream
   * admits one, which a stream reopened with nothing to replay opens after. Absent at the log's
   * start. Kept apart from the transcript because a detached tail holds no row at the cursor.
   */
  readonly streamAfterCursor: EventCursor | undefined;
  /** The oldest end of the window and how a read before it is asked. */
  readonly transcriptHead: TranscriptWindowEdge;
  /** The newest end of the window, how a read after it is asked, and whether it is live. */
  readonly transcriptTail: TranscriptWindowTail;
  /**
   * The events the newest batch admitted from the stream, in sequence order, whether or not the
   * transcript took them: a detached tail folds rows the window does not hold, and a reader of
   * arrivals must still see them. Empty after a read.
   */
  readonly lastAdmittedEvents: readonly ProjectedSessionEvent[];
  /** Sticky while the projection is known-incomplete; cleared only by a read that repairs it. */
  readonly degradedCause: SessionDegradedCause | undefined;
  /**
   * Whether a repair read landed and its replay is still folding toward the rows this window
   * holds. The window keeps its rows and its cause until the replay passes them.
   */
  readonly isReplaying: boolean;
  /**
   * Whether the newest read of this session failed. Set beside the worst cause because the
   * ladder keeps a worse cause standing over `read-failed`, yet the person must still be told
   * the repair read failed. Cleared by the next read that lands.
   */
  readonly lastReadFailed: boolean;
  /**
   * How many reads of this session have failed in this store's life, so a retry that fails again
   * is a new failure. Never reset: a read landing in between is not a failure.
   */
  readonly readFailureCount: number;
  /**
   * How many times a cause a replay raises again came to stand on this window, newly or at the
   * end of a replay that failed on the same row, so a retry that ends there again is a new
   * failure. Never reset, like {@link readFailureCount}.
   */
  readonly raisedAgainCauseCount: number;
  /**
   * Runs of sequences observed as missing, oldest first. The accumulated width they describe is
   * bounded by `MAX_REPAIRABLE_SEQUENCE_GAP`.
   */
  readonly gaps: readonly SequenceGap[];
  /** Where a repair of this window can take the stream up again; see {@link RepairResumePoint}. */
  readonly repairResumePoint: RepairResumePoint;
  /**
   * How many reads have placed this window: the first, and each snapshot that replaced it whole.
   * A view keyed on it meets each window a read placed, which a page, a release or a repair that
   * keeps the window never moves.
   */
  readonly windowPlacementCount: number;
  /** Monotonic transition counter, so a test can assert coalescing by counting. */
  readonly revision: number;
}

/**
 * Where a repair can take a window's stream up again. `whole` while every row the stream sent
 * folded in order with none missing, so the stream reopens after the newest and nothing is
 * replayed. A `checkpoint` at the last such row before the first row fault (a hole, a sequence
 * refused, a projector that threw), holding the partitions as they stood there, since a read
 * carries no projected state: the replay folds only the rows after it. `head` when the fault came
 * before any row the stream sent, so only a replay from the window's head can repair it.
 */
export type RepairResumePoint =
  | { readonly kind: "whole" }
  | {
      readonly kind: "checkpoint";
      readonly partitions: SessionPartitions;
      /** The sequence of the last row folded whole. */
      readonly cursor: number;
      /** That row's position in the log, which the stream reopens after. */
      readonly rowCursor: EventCursor;
    }
  | { readonly kind: "head" };

/** The base state a read response establishes. */
export interface SessionBaseState {
  /**
   * The sequence the base state is current as of: the newest row it carried. Absent when it
   * carried none, and the store learns the sequence from the first event the stream delivers.
   */
  readonly cursor?: number;
  /** Entities the read response carried. */
  readonly entities: readonly StoredEntity[];
  /** Events the read response carried, ordered by sequence. */
  readonly transcript?: readonly ProjectedSessionEvent[];
  /**
   * The daemon-issued position the base state stands at, which the session's stream is opened
   * after. Absent when the stream opens at the start of the log, where it has no position.
   */
  readonly streamAfterCursor?: EventCursor | undefined;
  /**
   * The oldest end of the window the read carried, and whether rows sit before it. Absent for a
   * read with nothing before it.
   */
  readonly transcriptHead?: TranscriptWindowEdge;
}

/**
 * Where a repair read reopens a degraded window's stream: after the row the window, or its replay,
 * is taken up after, or at the window's head, `undefined` naming the log's floor.
 */
export type RepairReopening =
  | { readonly from: "row"; readonly rowCursor: EventCursor }
  | { readonly from: "head"; readonly headCursor: EventCursor | undefined };

/** The edge of a window with nothing beyond it. */
export const CLOSED_WINDOW_EDGE: TranscriptWindowEdge = { cursor: undefined, hasMore: false };

/** The resume point of a window whose every row folded whole. */
export const WHOLE_RESUME_POINT: RepairResumePoint = { kind: "whole" };

/** The resume point of a window only a replay from its head can repair. */
export const HEAD_RESUME_POINT: RepairResumePoint = { kind: "head" };

/**
 * The cursor a held row was stored at, as the daemon issued it. A row's cursor is the position a
 * read beyond it is asked with, so an edge names the row it ends at.
 */
export function heldRowCursor(row: ProjectedSessionEvent): EventCursor {
  return row.cursor as EventCursor;
}

/**
 * The tail of a window that follows the stream: the newest row it holds is the log's newest, so
 * nothing lies beyond it.
 */
export function liveTailAfter(transcript: readonly ProjectedSessionEvent[]): TranscriptWindowTail {
  const newest = transcript.at(-1);
  return {
    cursor: newest === undefined ? undefined : heldRowCursor(newest),
    hasMore: false,
    following: "live",
  };
}

/**
 * The position a repair of `state` reopens the stream after, or `undefined` when only a replay
 * from the window's head can repair it: the checkpoint's row, else the newest row the stream
 * admitted, which a whole window is taken up after with nothing replayed.
 */
export function repairResumeRowCursor(state: SessionStoreState): EventCursor | undefined {
  const point = state.repairResumePoint;
  if (point.kind === "checkpoint") {
    return point.rowCursor;
  }
  return point.kind === "whole" ? state.streamAfterCursor : undefined;
}

/**
 * Whether a store takes a read's base state. One with no base state takes any. A degraded one
 * takes any too, to replace its window or repair it. A whole one refuses, since its stream
 * already delivers what a read would, and a read racing it cannot undo newer events.
 */
export function admitsBaseState(current: SessionStoreState): boolean {
  return !current.initialized || current.degradedCause !== undefined;
}

/**
 * The state with `cause` merged through the degradation ladder, or the same state when the cause
 * it holds is already as bad. Merged, never assigned: an assignment would downgrade
 * `stream-diverged` to `read-failed` when its repair read rejects.
 */
export function withDegradedCause(
  state: SessionStoreState,
  cause: SessionDegradedCause,
): SessionStoreState {
  const merged = worstDegradedCause(state.degradedCause, cause);
  return merged === state.degradedCause
    ? state
    : { ...state, degradedCause: merged, revision: state.revision + 1 };
}

/** The state of a newly constructed store, which has projected nothing and waits for its read. */
export function uninitializedState(input: {
  readonly sessionId: string;
  readonly revision: number;
}): SessionStoreState {
  return {
    sessionId: input.sessionId,
    initialized: false,
    partitions: emptyPartitions(),
    transcript: [],
    cursor: UNPLACED_CURSOR,
    streamAfterCursor: undefined,
    transcriptHead: CLOSED_WINDOW_EDGE,
    transcriptTail: liveTailAfter([]),
    lastAdmittedEvents: [],
    degradedCause: undefined,
    isReplaying: false,
    lastReadFailed: false,
    readFailureCount: 0,
    raisedAgainCauseCount: 0,
    gaps: [],
    repairResumePoint: WHOLE_RESUME_POINT,
    windowPlacementCount: 0,
    revision: input.revision,
  };
}

/**
 * The state one read response establishes, from the ordered transcript and the partitions its rows
 * and records project, and the cursor the reconciler re-based onto. Its tail follows the stream,
 * which opens after the read's newest row. A read clears `degradedCause` here and nowhere else,
 * since a completed read is what makes a projection whole, unless one of its own rows failed to
 * project; only a replay from the head folds that row again.
 */
export function establishedState(input: {
  readonly sessionId: string;
  readonly baseState: SessionBaseState;
  readonly partitions: SessionPartitions;
  /** Whether a projector threw on one of the read's rows. */
  readonly isProjectionFailed: boolean;
  readonly cursor: number;
  readonly orderedTranscript: readonly ProjectedSessionEvent[];
  readonly revision: number;
  /** The failures counted before this read, carried across it. */
  readonly readFailureCount: number;
  /** The raised-again causes counted before this read, carried across it. */
  readonly raisedAgainCauseCount: number;
  /** The reads that placed a window before this one. */
  readonly windowPlacementCount: number;
}): SessionStoreState {
  return {
    sessionId: input.sessionId,
    initialized: true,
    partitions: input.partitions,
    transcript: input.orderedTranscript,
    cursor: input.cursor,
    streamAfterCursor: input.baseState.streamAfterCursor,
    transcriptHead: input.baseState.transcriptHead ?? CLOSED_WINDOW_EDGE,
    transcriptTail: liveTailAfter(input.orderedTranscript),
    lastAdmittedEvents: [],
    degradedCause: input.isProjectionFailed ? "projection-failed" : undefined,
    isReplaying: false,
    lastReadFailed: false,
    readFailureCount: input.readFailureCount,
    raisedAgainCauseCount: input.raisedAgainCauseCount,
    gaps: [],
    repairResumePoint: input.isProjectionFailed ? HEAD_RESUME_POINT : WHOLE_RESUME_POINT,
    windowPlacementCount: input.windowPlacementCount + 1,
    revision: input.revision,
  };
}
