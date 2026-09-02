// The state one session store holds, and the base state a read establishes.
//
// Its own module because more than the store reads it: the selectors project it,
// the hooks type their callbacks against it, and the store commits it. A state
// shape declared inside the class that writes it would force every reader to import
// the writer, which is how a family acquires a cycle.

import type { SessionDegradedCause } from "./degradation.js";
import type { ConsoleEntity, ConsoleSessionEvent } from "./entities.js";
import type { SessionPartitions } from "./entity-partitions.js";
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
