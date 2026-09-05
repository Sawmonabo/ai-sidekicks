// The blocking choice an incompatible checkout raises, and the two shapes it needs.
//
// Its own module rather than a corner of the gate's state, because it is not an arm:
// `ProposalGate.tsx` takes it as a separate prop and keeps the branch context and the
// proposal on screen underneath while the choice is put, which is what makes the choice
// answerable at all.

/**
 * A blocking choice, never resolved automatically.
 *
 * `Spec-011 §Fallback Behavior` requires an explicit user choice before proceeding on
 * an incompatible checkout, so the gate holds and offers the host's own options rather
 * than picking one. The options are the daemon's strings — the console mints none,
 * which is why this shape carries a list rather than a closed union.
 */
export interface CheckoutConflict {
  /** What is incompatible, in the daemon's own words. Rendered verbatim. */
  readonly reason: string;
  /** The ways forward the daemon offered. At least one, or there is no choice to put. */
  readonly options: readonly CheckoutConflictOption[];
}

/** One way forward out of an incompatible checkout. */
export interface CheckoutConflictOption {
  readonly optionId: string;
  readonly label: string;
}
