// The state one session store holds, and the base state a read establishes. Its own module
// because the selectors, the hooks and the store all read it, and a shape declared inside the
// writing class would force every reader to import the writer.

import type { EventCursor } from "@ai-sidekicks/contracts/session/id";

import type { SessionDegradedCause } from "./degradation.js";
import {
  emptyPartitions,
  type StoredEntity,
  type ProjectedSessionEvent,
} from "./entities/vocabulary.js";
import { mergeUpsert, type SessionPartitions } from "./entities/partitions.js";
import type { SequenceGap } from "./sequence-reconciler.js";

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
  /** The highest sequence this store has admitted. */
  readonly cursor: number;
  /**
   * The acknowledged position the read that established this window opened it at, or `undefined`
   * when nothing precedes the window.
   *
   * This is the head of the window and the only cursor the console has for it:
   * `SessionReadResponse` names no oldest row it sent. It is held as the string the daemon
   * issued, because a caller may only hand it back. `undefined` means the window opened at the
   * log's floor or its start.
   */
  readonly windowHeadCursor: string | undefined;
  /** Sticky while the projection is known-incomplete; cleared only by a re-pull. */
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
   * Runs of sequences this store holds no rows for, oldest first: holes the stream left, and the
   * stretch a snapshot read skipped past, so two stretches are never joined as one. The holes a
   * read can still repair are bounded by `MAX_REPAIRABLE_SEQUENCE_GAP`; a skipped stretch is not.
   */
  readonly gaps: readonly SequenceGap[];
  /** Monotonic transition counter, so a test can assert coalescing by counting. */
  readonly revision: number;
}

/**
 * Where a store opens when its base state carries no position: the bottom of the stream. The
 * subscription catches up from there, so a base state ahead of it would drop unseen events.
 */
export const BASE_STATE_CURSOR = 0;

/** The base state a read response establishes. */
export interface SessionBaseState {
  /** The sequence the base state is current as of; the stream resumes after it. */
  readonly cursor: number;
  /** Entities the read response carried. */
  readonly entities: readonly StoredEntity[];
  /** Events the read response carried, ordered by sequence. */
  readonly transcript?: readonly ProjectedSessionEvent[];
  /**
   * The daemon-issued position `cursor` names, which the session's stream is opened after. Absent
   * when the window opens at the start of the log, where the stream is opened with no position.
   */
  readonly streamAfterCursor?: EventCursor | undefined;
  /**
   * Where this window begins when rows sit before it: the acknowledged position the window was
   * opened at. The store carries it onto {@link SessionStoreState.windowHeadCursor}.
   */
  readonly readFromCursor?: string | undefined;
}

/**
 * Whether an initialized store takes a read response answering at this cursor.
 *
 * Ahead of the cursor is new state. At the cursor it is admitted only while degraded, which is
 * the repair case; every cause qualifies, since one completed re-pull clears them all and each
 * can leave the cursor standing still. Behind the cursor is never admitted, so a racing re-read
 * cannot undo newer events.
 */
export function admitsBaseStateAt(cursor: number, current: SessionStoreState): boolean {
  if (cursor > current.cursor) {
    return true;
  }
  return cursor === current.cursor && current.degradedCause !== undefined;
}

/** The cursor a store holds before any read has established a base state. */
export const UNINITIALIZED_CURSOR = -1;

/**
 * Which end of an over-cap log survives. `"newest"` is the ordinary rule, since a window is a
 * session's tail. `"oldest"` is for after a backward page: the reader is at the head, so
 * cutting there would discard the page as it landed.
 */
export type TranscriptRetainedEnd = "newest" | "oldest";

/**
 * The state of a store that has projected nothing: newly constructed, or reset. A construction
 * is quiet; a reset is degraded, because a projection thrown away is incomplete until the next
 * read lands, and showing it as a settled empty session would state a fact the console lacks.
 */
export function uninitializedState(input: {
  readonly sessionId: string;
  readonly revision: number;
  readonly degradedCause?: SessionDegradedCause | undefined;
}): SessionStoreState {
  return {
    sessionId: input.sessionId,
    initialized: false,
    partitions: emptyPartitions(),
    transcript: [],
    cursor: UNINITIALIZED_CURSOR,
    windowHeadCursor: undefined,
    degradedCause: input.degradedCause,
    lastReadFailed: false,
    readFailureCount: 0,
    gaps: [],
    revision: input.revision,
  };
}

/**
 * The state one read response establishes, from the ordered transcript the caller already
 * produced (the reconciler rebases onto the same list). `degradedCause` is cleared here and
 * nowhere else: a completed re-pull is what makes a projection whole.
 */
export function establishedState(input: {
  readonly sessionId: string;
  readonly baseState: SessionBaseState;
  readonly orderedTranscript: readonly ProjectedSessionEvent[];
  readonly transcriptCap: number | undefined;
  readonly revision: number;
  /** The failures counted before this read, carried across it. */
  readonly readFailureCount: number;
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
    cursor: input.baseState.cursor,
    windowHeadCursor: input.baseState.readFromCursor,
    degradedCause: undefined,
    lastReadFailed: false,
    readFailureCount: input.readFailureCount,
    gaps: [],
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
