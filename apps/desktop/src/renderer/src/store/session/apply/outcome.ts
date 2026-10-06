// What one `applyBatch` call did, and the zero it counts up from. Its own module because
// `store/session/open/entry.ts` reads these counters to decide whether a batch opened a hole worth
// a re-pull, and a shape inside the writing class would force an import cycle. Every member is a
// count or flag; what an outcome means is the caller's judgment.

/** What one `applyBatch` call did. Returned so callers can count rather than infer. */
export interface ApplyOutcome {
  readonly admitted: number;
  readonly duplicates: number;
  readonly buffered: number;
  readonly refusedForeignSession: number;
  readonly gapDetected: boolean;
  /** Buffered events this batch pushed past `PRE_INITIALIZATION_BUFFER_CAP`. */
  readonly droppedBeforeInitialization: number;
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
  droppedBeforeInitialization: 0,
  refusedDivergedSequence: 0,
  projectionFailures: 0,
};
