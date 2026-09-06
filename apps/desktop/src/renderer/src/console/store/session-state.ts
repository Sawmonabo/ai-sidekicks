// The state one session store holds, and the base state a read establishes.
//
// Its own module because more than the store reads it: the selectors project it,
// the hooks type their callbacks against it, and the store commits it. A state
// shape declared inside the class that writes it would force every reader to import
// the writer, which is how a family acquires a cycle.

import type { SessionDegradedCause } from "./degradation.js";
import { emptyPartitions } from "./entities.js";
import type { ConsoleEntity, ConsoleSessionEvent } from "./entities.js";
import { mergeUpsert, type SessionPartitions } from "./entity-partitions.js";
import type { SequenceGap } from "./sequence-reconciler.js";

/** The immutable state one session store holds. */
export interface SessionStoreState {
  readonly sessionId: string;
  /** `false` until `initialise()` supplies a read response. */
  readonly initialised: boolean;
  /** Entity maps, one per kind. Only touched partitions change identity. */
  readonly partitions: SessionPartitions;
  /** Append-only ordered event log for the session, the ledger's source. */
  readonly timeline: readonly ConsoleSessionEvent[];
  /** The highest sequence this store has admitted. */
  readonly cursor: number;
  /** Sticky while the projection is known-incomplete; cleared only by a re-pull. */
  readonly degradedCause: SessionDegradedCause | undefined;
  /**
   * Runs of sequences observed as missing, oldest first. Rendered by the degraded
   * banner, not guessed at — and bounded, because the accumulated width they
   * describe is what `MAX_REPAIRABLE_SEQUENCE_GAP` caps.
   */
  readonly gaps: readonly SequenceGap[];
  /** Monotonic transition counter, so a test can assert coalescing by counting. */
  readonly revision: number;
}

/** The base state a read response establishes. */
export interface SessionSnapshot {
  /** The sequence the snapshot is current as of. */
  readonly cursor: number;
  /** Entities the read response carried. */
  readonly entities: readonly ConsoleEntity[];
  /** Participants in join-log order — the order the hue wheel is allocated in. */
  readonly participantJoinLog: readonly string[];
  /** Events the read response carried, ordered by sequence. */
  readonly timeline?: readonly ConsoleSessionEvent[];
  /**
   * The cursor block the read answered with, carried UNREAD.
   *
   * The snapshot is the whole of what one read established, and the resume rule is
   * taken against these three positions rather than against the entity graph beside
   * them — so a snapshot that dropped them would leave the entry holding a base state
   * and no way to learn whether the rows below it still exist. It is deliberately
   * `unknown`: `timeline-resume.ts` owns the shape and the narrowing, and a typed
   * member here would assert away the very absence that module has to detect.
   */
  readonly timelineCursors?: unknown;
}

/**
 * Whether an initialised store takes a read response answering at this cursor.
 *
 * Ahead of the cursor is new state and always admitted. AT the cursor is admitted
 * only while the store is degraded, which is the repair case — and every cause
 * qualifies rather than `sequence-gap` alone, because a failed read and a closed
 * subscription are cleared by exactly the same completed re-pull and each of them
 * can leave the cursor standing still. Behind the cursor is never admitted, which
 * is the idempotence the guard exists for: a racing re-read that has not seen the
 * newest events cannot undo them.
 */
export function admitsSnapshotAt(cursor: number, current: SessionStoreState): boolean {
  if (cursor > current.cursor) {
    return true;
  }
  return cursor === current.cursor && current.degradedCause !== undefined;
}

/**
 * The cursor a store holds before any read has established a base state.
 *
 * Named because three writers spend it — the state a store is constructed with, the
 * state a projection reset returns it to, and the reconciler rebase that reset
 * performs — and a literal in three places is one value with three homes.
 */
export const UNINITIALISED_CURSOR = -1;

/**
 * The state of a store that has projected nothing: newly constructed, or reset.
 *
 * ONE BUILDER FOR BOTH, because they are the same state and differ only in what the
 * reader should be told about it. A construction is quiet — nothing has been asked
 * for yet — and a reset is DEGRADED, because a projection thrown away is
 * known-incomplete until the read that follows it lands, and rendering that window as
 * a settled empty session would be the console reporting a fact it does not have.
 */
export function uninitialisedState(input: {
  readonly sessionId: string;
  readonly revision: number;
  readonly degradedCause?: SessionDegradedCause | undefined;
}): SessionStoreState {
  return {
    sessionId: input.sessionId,
    initialised: false,
    partitions: emptyPartitions(),
    timeline: [],
    cursor: UNINITIALISED_CURSOR,
    degradedCause: input.degradedCause,
    gaps: [],
    revision: input.revision,
  };
}

/**
 * The state one read response establishes.
 *
 * Takes the ordered timeline rather than ordering the snapshot's own, because the
 * caller has already ordered it: the same sequence list the reconciler rebases onto
 * is the list this state carries, and ordering it twice would be two orderings of one
 * log that can disagree.
 *
 * `degradedCause` is cleared here and nowhere else. A completed re-pull is exactly
 * what makes a projection whole again, so the flag every other path only ever merges
 * upward is dropped at the one moment that earns it.
 */
export function establishedState(input: {
  readonly sessionId: string;
  readonly snapshot: SessionSnapshot;
  readonly orderedTimeline: readonly ConsoleSessionEvent[];
  readonly timelineCap: number | undefined;
  readonly revision: number;
}): SessionStoreState {
  let partitions: SessionPartitions = emptyPartitions();
  for (const entity of input.snapshot.entities) {
    partitions = mergeUpsert(partitions, entity);
  }
  return {
    sessionId: input.sessionId,
    initialised: true,
    partitions,
    timeline: capTimeline(input.orderedTimeline, input.timelineCap),
    cursor: input.snapshot.cursor,
    degradedCause: undefined,
    gaps: [],
    revision: input.revision,
  };
}

/**
 * The newest `cap` events of a timeline, or all of them where there is no cap.
 *
 * Here rather than beside the store that applies it because the cap is a property of
 * the STATE — what a `timeline` member is allowed to hold — and both writers of that
 * member, the read that establishes it and the batch that appends to it, take the
 * same answer from this one function.
 */
export function capTimeline(
  timeline: readonly ConsoleSessionEvent[],
  cap: number | undefined,
): readonly ConsoleSessionEvent[] {
  if (cap === undefined || timeline.length <= cap) {
    return timeline;
  }
  return timeline.slice(timeline.length - cap);
}
