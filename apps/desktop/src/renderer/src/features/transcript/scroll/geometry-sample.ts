// One geometry sample: the value the chokepoint publishes, and the rule for comparing two. It is
// computable from three numbers and holds nothing, so the reading anchor and the virtualizer
// speak this vocabulary without holding the scroll controller.

import { TRANSCRIPT_GEOMETRY_EPSILON_PX } from "../viewport/viewport-constants.js";

/**
 * What produced a geometry sample: which of the three numbers moved, the offset (`"scroll"`) or
 * the box (`"resize"`), not who caused it. A shrinking viewport raises the distance from the
 * tail with no reader action, so a consumer must not fold a resize the way it folds a scroll.
 */
export const GEOMETRY_CHANGE_CAUSES = ["scroll", "resize"] as const;

/** One geometry cause. Derived from the enumeration, never restated. */
export type GeometryChangeCause = (typeof GEOMETRY_CHANGE_CAUSES)[number];

/**
 * The three numbers a scroll sample reads, and the facts derived from them.
 *
 * `sampledAt` comes from the clock seam, not `Date.now`, so a frozen fixture clock names one
 * exact frame.
 */
export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
  readonly distanceFromTailPx: number;
  readonly isAtTail: boolean;
  readonly sampledAt: number;
  readonly cause: GeometryChangeCause;
}

/**
 * Whether two samples report the same box at the same offset.
 *
 * Compared within the geometry epsilon over the three sampled numbers only; `sampledAt` and the
 * cause are provenance, and the derived facts follow from the three. A publisher uses this to
 * skip waking subscribers, each of which re-renders when woken.
 */
export function sameSampledGeometry(left: ScrollGeometry, right: ScrollGeometry): boolean {
  return (
    Math.abs(left.scrollTop - right.scrollTop) < TRANSCRIPT_GEOMETRY_EPSILON_PX &&
    Math.abs(left.viewportHeight - right.viewportHeight) < TRANSCRIPT_GEOMETRY_EPSILON_PX &&
    Math.abs(left.contentHeight - right.contentHeight) < TRANSCRIPT_GEOMETRY_EPSILON_PX
  );
}
