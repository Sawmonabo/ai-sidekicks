// Reconciling a delivered sequence against the run a store has already admitted.
//
// The cursor, the dedupe set, and the recorded holes are one mechanism, not three:
// every one of them answers the same question — is this sequence new, seen, or
// unreachable — and splitting them across the caller would let the three disagree.
// So they live behind one class, and the apply chokepoint asks it once per event.
//
// The rules it enforces, each of them a failure the store is required to survive:
//
//   • **A duplicate sequence is refused, silently and countably.** Re-delivery is
//     ordinary on a resumed subscription. The dedupe set answers only for sequences
//     the CURSOR cannot — anything at or below it is refused without help — so
//     entries are released at each batch boundary and the set stays a batch wide
//     rather than growing one number per event for the session's life, behind a
//     timeline the store's cap has already trimmed.
//   • **A gap is a bounded RANGE, and past a bound it is a different stream.** A
//     hole is recorded as `[from, to]` and never enumerated: a delivered sequence
//     is untrusted arithmetic, and walking from the cursor to it would let one
//     event cost the renderer a billion allocations before the store could say
//     anything at all. Past `MAX_REPAIRABLE_SEQUENCE_GAP` of ACCUMULATED loss — and
//     for any sequence too large or too malformed to increment reliably — the event
//     is refused rather than admitted, because admitting it would move the cursor
//     to a position an authoritative read may never answer at and every later
//     repair would then be refused as a rewind.
//   • **The batch is ordered before it is reconciled.** The reconciler assumes
//     ascending delivery, which `orderBatchBySequence` is what supplies.

import { MAX_REPAIRABLE_SEQUENCE_GAP } from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";

/**
 * A contiguous run of sequences the store never saw, inclusive at both ends.
 *
 * A RANGE rather than one entry per sequence, and that is the whole point: the
 * width comes from a delivered event, so enumerating it hands untrusted arithmetic
 * control of how much the renderer allocates.
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

/**
 * Whether a delivered sequence is one cursor arithmetic can survive.
 *
 * Checked BEFORE anything else a store does with an event, because no base state
 * makes such a sequence applicable: `Math.max(cursor, NaN)` is `NaN` and every
 * comparison against that cursor is false afterwards, so one of these admitted
 * would silently disarm dedupe, gap detection, and the rewind guard together — for
 * the rest of the session, with nothing to see.
 */
export function isReconcilableSequence(sequence: number): boolean {
  return Number.isSafeInteger(sequence);
}

/**
 * Batch order, by sequence.
 *
 * Total on purpose. The obvious `left.sequence - right.sequence` returns `NaN` for
 * a malformed sequence, and a comparator that answers `NaN` leaves the sort order
 * of the whole batch undefined — so one hostile event would decide the order of
 * every well-formed one beside it. Anything the cursor cannot carry sorts last,
 * together, and the caller refuses each of them.
 */
export function orderBatchBySequence(
  events: readonly ConsoleSessionEvent[],
): ConsoleSessionEvent[] {
  return [...events].sort(compareBySequence);
}

function compareBySequence(left: ConsoleSessionEvent, right: ConsoleSessionEvent): number {
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
   * Sequences still retained for duplicate detection.
   *
   * Bounded by construction: everything at or below the cursor is released at the
   * batch boundary, because the cursor test already refuses it. Exposed so the
   * steady-heap claim is COUNTED rather than asserted — a set that grew with the
   * session would be invisible behind a capped timeline.
   */
  public get retainedSequenceCount(): number {
    return this.#admittedSequences.size;
  }

  /**
   * The runs observed as missing, oldest first.
   *
   * A fresh array per call: the caller commits it into immutable state, and handing
   * out the reconciler's own list would let the next admission mutate a value React
   * has already rendered.
   */
  public gaps(): readonly SequenceGap[] {
    return [...this.#gaps];
  }

  /**
   * Reconcile one delivered sequence, advancing the run when it is admitted.
   *
   * Callers deliver in ascending order (`orderBatchBySequence`), which is what
   * makes the cursor test and the dedupe set jointly exhaustive: a sequence at or
   * below the cursor that the set does not hold sits inside a recorded hole, and a
   * hole never arrives later in an ascending batch than the event that opened it.
   */
  public reconcile(sequence: number): SequenceAdmission {
    if (this.#admittedSequences.has(sequence) || sequence <= this.#cursor) {
      return DUPLICATE;
    }
    const missingBefore = sequence - (this.#cursor + 1);
    if (this.#missingSequenceCount + missingBefore > MAX_REPAIRABLE_SEQUENCE_GAP) {
      // Refused rather than admitted with a wider hole recorded. Admitting it would
      // put the cursor somewhere no authoritative read need ever answer at, and the
      // store's snapshot guard would then refuse every real repair as a rewind — a
      // store degraded with no way back.
      return DIVERGED;
    }
    let openedGap: SequenceGap | undefined;
    if (missingBefore > 0) {
      openedGap = { fromSequence: this.#cursor + 1, toSequence: sequence - 1 };
      this.#gaps.push(openedGap);
      this.#missingSequenceCount += missingBefore;
    }
    this.#admittedSequences.add(sequence);
    // A plain assignment rather than a `Math.max`: the duplicate test above already
    // refused everything at or below the cursor, so this sequence is strictly ahead
    // of it and the cursor cannot rewind here.
    this.#cursor = sequence;
    return { outcome: "admitted", openedGap };
  }

  /**
   * Forget dedupe entries the cursor now refuses on its own.
   *
   * Called at the batch boundary rather than per event: within a batch the set is
   * what rejects a second copy of a sequence the same batch already carried, and a
   * release between the two would admit it.
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
