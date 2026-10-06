// Reconciling a delivered sequence against the run a store has already admitted. The cursor, the
// dedupe set and the recorded holes are one mechanism answering one question (new, seen or
// unreachable), so they live behind one class that the apply chokepoint asks once per event.
//
// - A duplicate is refused silently and countably; re-delivery is ordinary on a resumed
//   subscription. The dedupe set answers only for sequences the cursor cannot (anything at or
//   below it is refused anyway), so entries are released at each batch boundary and the set
//   stays a batch wide.
// - A gap is a bounded range, recorded as `[from, to]` and never enumerated: a delivered
//   sequence is untrusted arithmetic, and walking to it could cost a billion allocations. Past
//   `MAX_REPAIRABLE_SEQUENCE_GAP` of accumulated loss, or for a sequence too large or malformed
//   to increment, the event is refused: admitting it would move the cursor to a position an
//   authoritative read may never answer at, and every later repair would be refused as a rewind.
// - The batch is ordered first (`orderBatchBySequence`); the reconciler assumes ascending
//   delivery.

import { MAX_REPAIRABLE_SEQUENCE_GAP } from "./caps.js";
import type { ProjectedSessionEvent } from "./entities/vocabulary.js";

/**
 * A contiguous run of sequences the store never saw, inclusive at both ends. A range, not one
 * entry per sequence: the width comes from a delivered event, so enumerating it would hand
 * untrusted arithmetic control of allocation.
 */
export interface SequenceGap {
  readonly fromSequence: number;
  readonly toSequence: number;
}

/** What the reconciler did with one delivered sequence. */
export type SequenceAdmission =
  | {
      readonly outcome: "admitted";
      /** The hole this admission opened in front of itself, when it opened one. */
      readonly openedGap: SequenceGap | undefined;
    }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "diverged" };

const DUPLICATE: SequenceAdmission = { outcome: "duplicate" };
const DIVERGED: SequenceAdmission = { outcome: "diverged" };

/** The admitted run of one session's stream: where it stands and what it is missing. */
export class SequenceReconciler {
  #cursor = -1;
  #missingSequenceCount = 0;
  #gaps: SequenceGap[] = [];
  readonly #admittedSequences = new Set<number>();

  /** The highest sequence this reconciler has admitted. */
  public get cursor(): number {
    return this.#cursor;
  }

  /**
   * The runs observed as missing, oldest first. A fresh array per call, since the caller commits
   * it into immutable state and a shared list would let the next admission mutate rendered state.
   */
  public gaps(): readonly SequenceGap[] {
    return [...this.#gaps];
  }

  /**
   * Reconcile one delivered sequence, advancing the run when it is admitted. Callers deliver in
   * ascending order, which makes the cursor test and the dedupe set jointly exhaustive: a
   * sequence at or below the cursor that the set lacks sits inside a recorded hole, and a hole
   * never arrives later in an ascending batch than the event that opened it.
   */
  public reconcile(sequence: number): SequenceAdmission {
    if (this.#admittedSequences.has(sequence) || sequence <= this.#cursor) {
      return DUPLICATE;
    }
    const missingBefore = sequence - (this.#cursor + 1);
    if (this.#missingSequenceCount + missingBefore > MAX_REPAIRABLE_SEQUENCE_GAP) {
      // Admitting it would put the cursor where no authoritative read need answer, and the
      // base-state guard would then refuse every real repair as a rewind.
      return DIVERGED;
    }
    let openedGap: SequenceGap | undefined;
    if (missingBefore > 0) {
      openedGap = { fromSequence: this.#cursor + 1, toSequence: sequence - 1 };
      this.#gaps.push(openedGap);
      this.#missingSequenceCount += missingBefore;
    }
    this.#admittedSequences.add(sequence);
    // Strictly ahead of the cursor (duplicates were refused above), so no `Math.max` is needed.
    this.#cursor = sequence;
    return { outcome: "admitted", openedGap };
  }

  /**
   * Forget dedupe entries the cursor now refuses on its own. Called at the batch boundary, since
   * within a batch the set rejects a second copy of a sequence the batch already carried.
   */
  public releaseSequencesAtOrBelowCursor(): void {
    for (const sequence of this.#admittedSequences) {
      if (sequence <= this.#cursor) {
        this.#admittedSequences.delete(sequence);
      }
    }
  }

  /**
   * Re-base the run onto an authoritative read: a new cursor, no recorded holes,
   * and dedupe memory seeded from the sequences that read carried.
   */
  public rebaseTo(cursor: number, admittedSequences: Iterable<number>): void {
    this.#cursor = cursor;
    this.#missingSequenceCount = 0;
    this.#gaps = [];
    this.#admittedSequences.clear();
    for (const sequence of admittedSequences) {
      this.#admittedSequences.add(sequence);
    }
    this.releaseSequencesAtOrBelowCursor();
  }
}

/**
 * Whether a delivered sequence is one cursor arithmetic can survive. Checked before anything else
 * a store does with an event: `Math.max(cursor, NaN)` is `NaN`, and every comparison against it
 * is false afterwards, which would silently disarm dedupe, gap detection and the rewind guard.
 */
export function isReconcilableSequence(sequence: number): boolean {
  return Number.isSafeInteger(sequence);
}

/**
 * Batch order, by sequence. Total on purpose: `left.sequence - right.sequence` is `NaN` for a
 * malformed sequence and would leave the whole batch's order undefined. Anything the cursor
 * cannot carry sorts last, together, and the caller refuses each.
 */
export function orderBatchBySequence(
  events: readonly ProjectedSessionEvent[],
): ProjectedSessionEvent[] {
  return [...events].sort(compareBySequence);
}

function compareBySequence(left: ProjectedSessionEvent, right: ProjectedSessionEvent): number {
  const leftKey = sortKeyFor(left.sequence);
  const rightKey = sortKeyFor(right.sequence);
  if (leftKey < rightKey) {
    return -1;
  }
  return leftKey > rightKey ? 1 : 0;
}

function sortKeyFor(sequence: number): number {
  return isReconcilableSequence(sequence) ? sequence : Number.MAX_SAFE_INTEGER;
}
