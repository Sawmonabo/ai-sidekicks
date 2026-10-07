// The state one session store holds, and the base state a read establishes. Its own module
// because the selectors, the hooks and the store all read it, and a shape declared inside the
// writing class would force every reader to import the writer.

import type { EventCursor } from "@ai-sidekicks/contracts/session/id";

import { worstDegradedCause, type SessionDegradedCause } from "./degradation.js";
import {
  emptyPartitions,
  type StoredEntity,
  type ProjectedSessionEvent,
} from "./entities/vocabulary.js";
import { mergeUpsert, type SessionPartitions } from "./entities/partitions.js";
import { UNPLACED_CURSOR, type SequenceGap } from "./sequence-reconciler.js";

/** The immutable state one session store holds. */
export interface SessionStoreState {
  readonly sessionId: string;
  /** `false` until `initialize()` supplies a read response. */
  readonly initialized: boolean;
  /** Entity maps, one per kind. Only touched partitions change identity. */
  readonly partitions: SessionPartitions;
  /**
   * The session's transcript: its ordered event log. Append-only at the tail, and
   * grown at the head only through `prependEarlierEvents`: the stream catches up from the position
   * this user was last acknowledged at, so the log below it exists but was never sent here.
   */
  readonly transcript: readonly ProjectedSessionEvent[];
  /**
   * The highest sequence this store has admitted, or `UNPLACED_CURSOR` while it has admitted none
   * since its base state: a read names its position by the daemon's cursor, not a sequence.
   */
  readonly cursor: number;
  /**
   * The acknowledged position the read that established this window opened it at, or `undefined`
   * when nothing precedes the window.
   *
   * This is the head of the window and the only cursor the console has for it:
   * `SessionReadResponse` names no oldest row it sent. It is held as the daemon issued it,
   * because a caller may only hand it back. `undefined` means the window opened at the log's
   * floor or its start.
   */
  readonly windowHeadCursor: EventCursor | undefined;
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
  /** Monotonic transition counter, so a test can assert coalescing by counting. */
  readonly revision: number;
}

/**
 * Where a repair can take a window's stream up again. `whole` while every row the window was sent
 * folded in order with none missing, so the stream reopens after its newest row and nothing is
 * replayed. A `checkpoint` at the last such row before the first row fault (a hole, a sequence
 * refused, a projector that threw), holding the partitions as they stood there, since a read
 * carries no projected state: the replay folds only the rows after it. `head` when the fault
 * came before any row the window holds, so only a replay from the window's head can repair it.
 */
export type RepairResumePoint =
  | { readonly kind: "whole" }
  | {
      readonly kind: "checkpoint";
      readonly partitions: SessionPartitions;
      /** The sequence of the last row folded whole. */
      readonly cursor: number;
      /** That row's position in the log, as held, which the stream reopens after. */
      readonly rowCursor: string;
    }
  | { readonly kind: "head" };

/** The base state a read response establishes. */
export interface SessionBaseState {
  /**
   * The sequence the base state is current as of, when the read says it. A daemon read never
   * does: it names its position only by `streamAfterCursor`, and the store learns the sequence
   * from the first event the stream delivers after it.
   */
  readonly cursor?: number;
  /** Entities the read response carried. */
  readonly entities: readonly StoredEntity[];
  /** Events the read response carried, ordered by sequence. */
  readonly transcript?: readonly ProjectedSessionEvent[];
  /**
   * The daemon-issued position the base state stands at, which the session's stream is opened
   * after. Absent when the window opens at the start of the log, where the stream has no position.
   */
  readonly streamAfterCursor?: EventCursor | undefined;
  /**
   * Where this window begins when rows sit before it: the acknowledged position the window was
   * opened at. The store carries it onto {@link SessionStoreState.windowHeadCursor}.
   */
  readonly readFromCursor?: EventCursor | undefined;
}

/** The resume point of a window whose every row folded whole. */
export const WHOLE_RESUME_POINT: RepairResumePoint = { kind: "whole" };

/** The resume point of a window only a replay from its head can repair. */
export const HEAD_RESUME_POINT: RepairResumePoint = { kind: "head" };

/**
 * Which end of an over-cap log survives. `"newest"` is the ordinary rule, since a window is a
 * session's tail. `"oldest"` is for after a backward page: the reader is at the head, so
 * cutting there would discard the page as it landed.
 */
export type TranscriptRetainedEnd = "newest" | "oldest";

/**
 * The held row a repair of `state` reopens the stream after, as held, or `undefined` when only a
 * replay from the window's head can repair it. A whole window names its newest row, which is the
 * row at its cursor unless a cap cut that end.
 */
export function repairResumeRowCursor(state: SessionStoreState): string | undefined {
  const point = state.repairResumePoint;
  if (point.kind === "checkpoint") {
    return point.rowCursor;
  }
  const newest = state.transcript.at(-1);
  return point.kind === "whole" && newest?.sequence === state.cursor ? newest.cursor : undefined;
}

/**
 * Whether a store takes a read's base state. One with no base state takes any. A degraded one
 * takes any too, which starts its repair from where the window can be taken up again. A whole one
 * refuses, since its stream already delivers what a read would, and a read racing it cannot undo
 * newer events.
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
    windowHeadCursor: undefined,
    degradedCause: undefined,
    isReplaying: false,
    lastReadFailed: false,
    readFailureCount: 0,
    raisedAgainCauseCount: 0,
    gaps: [],
    repairResumePoint: WHOLE_RESUME_POINT,
    revision: input.revision,
  };
}

/**
 * The state one read response establishes, from the ordered transcript the caller already
 * produced and the cursor the reconciler re-based onto. `degradedCause` is cleared here and
 * nowhere else: a completed re-pull is what makes a projection whole.
 */
export function establishedState(input: {
  readonly sessionId: string;
  readonly baseState: SessionBaseState;
  readonly cursor: number;
  readonly orderedTranscript: readonly ProjectedSessionEvent[];
  readonly transcriptCap: number | undefined;
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
    transcript: capTranscript(input.orderedTranscript, input.transcriptCap, "newest"),
    cursor: input.cursor,
    windowHeadCursor: input.baseState.readFromCursor,
    degradedCause: undefined,
    isReplaying: false,
    lastReadFailed: false,
    readFailureCount: input.readFailureCount,
    raisedAgainCauseCount: input.raisedAgainCauseCount,
    gaps: [],
    repairResumePoint: WHOLE_RESUME_POINT,
    revision: input.revision,
  };
}

/**
 * The `cap` events of a transcript nearest the retained end, or all of them where there is no cap.
 *
 * Shared because the cap is a property of the state, and the read, the batch and the backward
 * page all take the same answer. The end has no default: a cap silently cutting the end a
 * reader stands at is the failure this parameter makes unrepresentable. The cut is silent
 * because the cap is a retention bound, and rows never sent are reported by the window's
 * own absences.
 */
export function capTranscript(
  transcript: readonly ProjectedSessionEvent[],
  cap: number | undefined,
  retainedEnd: TranscriptRetainedEnd,
): readonly ProjectedSessionEvent[] {
  if (cap === undefined || transcript.length <= cap) {
    return transcript;
  }
  return retainedEnd === "newest"
    ? transcript.slice(transcript.length - cap)
    : transcript.slice(0, cap);
}
