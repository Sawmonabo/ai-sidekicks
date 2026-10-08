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
import { mergeUpsert, type SessionPartitions } from "./entities/partitions.js";
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
   * pages grow it at either edge and `releaseOutside` lets go of what lies far from the reading
   * position.
   */
  readonly transcript: readonly ProjectedSessionEvent[];
  /**
   * The highest sequence the stream has admitted, or `UNPLACED_CURSOR` while it has admitted none
   * since a base state that named no sequence. It runs ahead of the transcript's newest row while
   * the tail is detached.
   */
  readonly cursor: number;
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
   * How many times a cause the stream raises again (`isRaisedAgainOnReplay`) came to stand on this
   * store, so a retry that ends there again is a new failure. Never reset, like
   * {@link readFailureCount}.
   */
  readonly raisedAgainCauseCount: number;
  /**
   * Runs of sequences observed as missing, oldest first. The accumulated width they describe is
   * bounded by `MAX_REPAIRABLE_SEQUENCE_GAP`.
   */
  readonly gaps: readonly SequenceGap[];
  /** Monotonic transition counter, so a test can assert coalescing by counting. */
  readonly revision: number;
}

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

/** The edge of a window with nothing beyond it. */
export const CLOSED_WINDOW_EDGE: TranscriptWindowEdge = { cursor: undefined, hasMore: false };

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
 * Whether a store takes a read's base state. One with no base state takes any. A degraded one
 * takes any too, which replaces its window with the read's. A whole one refuses, since its stream
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
    transcriptHead: CLOSED_WINDOW_EDGE,
    transcriptTail: liveTailAfter([]),
    lastAdmittedEvents: [],
    degradedCause: undefined,
    lastReadFailed: false,
    readFailureCount: 0,
    raisedAgainCauseCount: 0,
    gaps: [],
    revision: input.revision,
  };
}

/**
 * The state one read response establishes, from the ordered transcript the caller already
 * produced and the cursor the reconciler re-based onto. Its tail follows the stream, which opens
 * after the read's newest row. `degradedCause` is cleared here and nowhere else: a completed read
 * is what makes a projection whole.
 */
export function establishedState(input: {
  readonly sessionId: string;
  readonly baseState: SessionBaseState;
  readonly cursor: number;
  readonly orderedTranscript: readonly ProjectedSessionEvent[];
  readonly revision: number;
  /** The failures counted before this read, carried across it. */
  readonly readFailureCount: number;
  /** The raised-again causes counted before this read, carried across it. */
  readonly raisedAgainCauseCount: number;
}): SessionStoreState {
  let partitions: SessionPartitions = emptyPartitions();
  for (const entity of input.baseState.entities) {
    partitions = mergeUpsert(partitions, entity);
  }
  return {
    sessionId: input.sessionId,
    initialized: true,
    partitions,
    transcript: input.orderedTranscript,
    cursor: input.cursor,
    transcriptHead: input.baseState.transcriptHead ?? CLOSED_WINDOW_EDGE,
    transcriptTail: liveTailAfter(input.orderedTranscript),
    lastAdmittedEvents: [],
    degradedCause: undefined,
    lastReadFailed: false,
    readFailureCount: input.readFailureCount,
    raisedAgainCauseCount: input.raisedAgainCauseCount,
    gaps: [],
    revision: input.revision,
  };
}
