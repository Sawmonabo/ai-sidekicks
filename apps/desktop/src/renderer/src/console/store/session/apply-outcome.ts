// What one `applyBatch` call did, and the zero it counts up from.
//
// ITS OWN MODULE FOR THE REASON `session-state.ts` GIVES ABOUT THE STATE SHAPE: more
// than the store reads this. `open-session-entry.ts` decides whether a batch opened a
// hole worth an authoritative re-pull, and it decides that by reading these counters —
// so a shape declared inside the class that writes it would force every reader to
// import the writer, which is how a family acquires a cycle.
//
// COUNTS RATHER THAN A VERDICT. Every member is a number or a flag about what
// happened, and none of them is "you should re-pull": what an outcome MEANS is the
// caller's judgment, and this module deliberately does not make it.

/** What one `applyBatch` call did. Returned so callers can count rather than infer. */
export interface ApplyOutcome {
  readonly admitted: number;
  readonly duplicates: number;
  readonly buffered: number;
  readonly refusedForeignSession: number;
  readonly gapDetected: boolean;
  /** Buffered events this batch pushed past `PRE_INITIALISATION_BUFFER_CAP`. */
  readonly droppedBeforeInitialisation: number;
  /**
   * Events refused because their sequence cannot be reconciled with this store's:
   * a jump past `MAX_REPAIRABLE_SEQUENCE_GAP` of accumulated loss, or a value no
   * cursor arithmetic can survive.
   */
  readonly refusedDivergedSequence: number;
  /** Events whose registered projector threw. The event landed; its entities did not. */
  readonly projectionFailures: number;
}

/** Nothing reached the state. `buffered` is the caller's, because only it knows. */
export const NOTHING_APPLIED: Omit<ApplyOutcome, "buffered"> = {
  admitted: 0,
  duplicates: 0,
  refusedForeignSession: 0,
  gapDetected: false,
  droppedBeforeInitialisation: 0,
  refusedDivergedSequence: 0,
  projectionFailures: 0,
};
