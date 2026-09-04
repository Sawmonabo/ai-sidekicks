// One geometry sample — the value the chokepoint publishes, and the one rule over it.
//
// The seam is the same one `viewport-snapshot.ts` states for the viewport:
// `scroll-chokepoint.ts` owns a surface, a listener, a batch and an emitter, and
// everything here is a value computable from three numbers and holding nothing. The
// reading anchor and the virtualizer seams both speak this vocabulary without ever
// holding the controller, which is why it is declared here rather than beside the
// machinery that happens to produce it.
//
// The comparison is here for the same reason and not as a leftover: whether two
// samples say the same thing is a rule about the value, and it is asserted directly
// rather than by driving a surface through two events.

import { LEDGER_GEOMETRY_EPSILON_PX } from "./frame-bounds.js";

/**
 * What produced a geometry sample. Closed at two, and a rule rather than a label.
 *
 * Not who caused it — a glide and a finger both move the offset and both are
 * `"scroll"` — but which of the three numbers moved: the OFFSET, or the BOX. A
 * shrinking viewport raises the distance from the tail with no reader action, so a
 * consumer folding a resize the way it folds a scroll drops a follower out of
 * following because the window got shorter.
 */
export const LEDGER_GEOMETRY_CAUSES = ["scroll", "resize"] as const;

/** One geometry cause. Derived from the enumeration, never restated. */
export type LedgerGeometryCause = (typeof LEDGER_GEOMETRY_CAUSES)[number];

/**
 * The three numbers a scroll sample reads, and the facts derived from them.
 *
 * `sampledAt` comes from the clock seam rather than `Date.now`, so a frozen
 * fixture clock names one exact frame.
 */
export interface LedgerGeometry {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
  readonly distanceFromTailPx: number;
  readonly isAtTail: boolean;
  readonly sampledAt: number;
  readonly cause: LedgerGeometryCause;
}

/**
 * Whether two samples report the same box at the same offset.
 *
 * Compared within the epsilon this frame already owns, and over the three SAMPLED
 * numbers only: `sampledAt` and the cause are provenance, and the two derived facts
 * are functions of the three. A publisher uses this to decide whether a sample is
 * worth waking its subscribers for, and every one of those subscribers re-renders
 * or re-lays-out when it is woken.
 */
export function sameSampledGeometry(left: LedgerGeometry, right: LedgerGeometry): boolean {
  return (
    Math.abs(left.scrollTop - right.scrollTop) < LEDGER_GEOMETRY_EPSILON_PX &&
    Math.abs(left.viewportHeight - right.viewportHeight) < LEDGER_GEOMETRY_EPSILON_PX &&
    Math.abs(left.contentHeight - right.contentHeight) < LEDGER_GEOMETRY_EPSILON_PX
  );
}
