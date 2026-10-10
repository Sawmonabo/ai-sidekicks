// One geometry sample: the value the chokepoint publishes, and the rule for comparing two. It is
// computable from three numbers and holds nothing, so the reading anchor and the virtualizer
// speak this vocabulary without holding the scroll controller.

/**
 * The epsilon every geometry comparison uses, in pixels: below anything a display can show and
 * above the error a device-pixel-ratio division introduces.
 */
export const SCROLL_GEOMETRY_EPSILON_PX = 0.5;

/**
 * What produced a geometry sample: which of the three numbers moved, the offset (`"scroll"`) or
 * the box (`"resize"`), not who caused it. A shrinking viewport raises the distance from the
 * tail with no reader action, so a consumer must not fold a resize the way it folds a scroll.
 */
export const GEOMETRY_CHANGE_CAUSES = ["scroll", "resize"] as const;

/** One geometry cause. Derived from the enumeration, never restated. */
export type GeometryChangeCause = (typeof GEOMETRY_CHANGE_CAUSES)[number];

/**
 * The three numbers a scroll sample holds (the offset, the viewport height and the content
 * height), and the facts derived from them.
 *
 * `inputAt` is the time stamp of the scroll event that published the sample, so a pause between a
 * reader's samples is the pause in their input, whatever clock the app runs on.
 */
export interface ScrollGeometry {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
  readonly distanceFromTailPx: number;
  readonly isAtTail: boolean;
  /**
   * The scroll event's own time stamp, in milliseconds on the page's performance timeline;
   * `undefined` for a sample a write, a resize or an attach published.
   */
  readonly inputAt: number | undefined;
  readonly cause: GeometryChangeCause;
}

/**
 * Whether two samples report the same box at the same offset.
 *
 * Compared within the geometry epsilon over the three sampled numbers only; `inputAt` and the
 * cause are provenance, and the derived facts follow from the three. A publisher uses this to
 * skip waking subscribers, each of which re-renders when woken.
 */
export function sameSampledGeometry(left: ScrollGeometry, right: ScrollGeometry): boolean {
  return (
    Math.abs(left.scrollTop - right.scrollTop) < SCROLL_GEOMETRY_EPSILON_PX &&
    Math.abs(left.viewportHeight - right.viewportHeight) < SCROLL_GEOMETRY_EPSILON_PX &&
    Math.abs(left.contentHeight - right.contentHeight) < SCROLL_GEOMETRY_EPSILON_PX
  );
}
