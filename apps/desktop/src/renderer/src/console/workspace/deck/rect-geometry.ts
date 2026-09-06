// The rect ALGEBRA: what a pane's visible rectangle is, and what counts as a change.
//
// Split from `rect-discipline.ts`, which is the WHEN — one write per frame, reads in
// the callback, writes on the next. This module is the WHAT, and it holds no state,
// arms no frame, and reaches no clock: it walks the DOM on demand and answers.
//
// THE VISIBLE CLIP IS COMPUTED SYNCHRONOUSLY, NOT OBSERVED. The obvious answer to "is
// this pane actually on screen" is `IntersectionObserver`, and it is the wrong tool
// four times over: it delivers asynchronously off a frame the tracker does not own, so
// its reading arrives after the write it should have decided; it cannot be driven by
// the injected clock, so the frozen-clock assertions that module rests on stop being
// possible; it reports THRESHOLD CROSSINGS rather than geometry, and a host setting
// bounds needs the rectangle and not the fact that a ratio moved; and it offers no
// on-demand read, while `invalidate` needs a value inside its own read phase. So the
// clip is walked here, one style read per ancestor per pass. This paragraph is why a
// later simplification to an observer is a regression.

/** Why a rect was re-measured. Rendered in diagnostics; never inferred. */
export const RECT_INVALIDATION_SOURCES = [
  "host-resize",
  "window-resize",
  "ancestor-scroll",
  "layout-mover",
  // Its own member rather than a fifth reason folded into `layout-mover`: an overlay
  // opening changes NO layout — the palette does not lock document scroll and the
  // inert carrier is `display: contents` — so counting it as a layout move would make
  // the per-source counter, whose whole job is telling one source firing four times
  // apart from four sources firing once, report something untrue.
  "airspace",
] as const;

/**
 * The computed `overflow` values that clip a descendant.
 *
 * Declared once and matched positively rather than testing `!== "visible"`: a
 * computed value this environment does not serve is not evidence of a clip, and
 * treating every unreadable ancestor as a clipping one would report a pane hidden
 * because its style could not be read.
 */
const CLIPPING_OVERFLOW_VALUES: ReadonlySet<string> = new Set([
  "hidden",
  "scroll",
  "auto",
  "clip",
  "overlay",
]);

/** A rectangle in viewport coordinates. The one shape the clip walk passes around. */
interface ViewportBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The part of `element` a person can actually see, in viewport coordinates.
 *
 * `getBoundingClientRect` reports the border box whether or not an ancestor clips
 * it, and a native view is composited by the host rather than laid out by the DOM —
 * so it is not clipped by the ancestor that clips the pane, and a pane scrolled half
 * out of the frame surface would have its view drawn over whatever is beside it.
 * The intersection is the only rectangle a bounds setter can act on, so it is what
 * this module publishes.
 *
 * One `getComputedStyle` per ancestor per pass, and the walk stops at the document:
 * the cost is the read, and the read is the thing that makes the answer true.
 */
export function visibleClipOf(element: Element): ViewportBox {
  const box = element.getBoundingClientRect();
  let clip = intersectBoxes(
    { x: box.x, y: box.y, width: box.width, height: box.height },
    { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  );
  // `?? null` on both reads rather than a bare `!== null` test: an element standing
  // in for a host in a test carries no `parentElement` at all, and walking into
  // `undefined` would read a style off nothing.
  let ancestor: Element | null = element.parentElement ?? null;
  while (ancestor !== null && clip.width > 0 && clip.height > 0) {
    if (isClippingAncestor(ancestor)) {
      const ancestorBox = ancestor.getBoundingClientRect();
      clip = intersectBoxes(clip, {
        x: ancestorBox.x,
        y: ancestorBox.y,
        width: ancestorBox.width,
        height: ancestorBox.height,
      });
    }
    ancestor = ancestor.parentElement ?? null;
  }
  return clip;
}

/**
 * Whether this ancestor clips what is inside it.
 *
 * Both axes AND the shorthand, because an environment that does not expand
 * `overflow` into its two long-hand properties would report neither axis and the
 * walk would step straight past a real scroller.
 */
function isClippingAncestor(ancestor: Element): boolean {
  const style = window.getComputedStyle(ancestor);
  return (
    CLIPPING_OVERFLOW_VALUES.has(style.overflowX) ||
    CLIPPING_OVERFLOW_VALUES.has(style.overflowY) ||
    CLIPPING_OVERFLOW_VALUES.has(style.overflow)
  );
}

/** Two boxes overlaid, floored at zero so a disjoint pair reports no extent. */
function intersectBoxes(first: ViewportBox, second: ViewportBox): ViewportBox {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** One invalidation source. Derived, so the vocabulary is declared once. */
export type RectInvalidationSource = (typeof RECT_INVALIDATION_SOURCES)[number];

/**
 * One pane's VISIBLE CLIP, in CSS pixels, plus whether it is worth compositing.
 *
 * The clip and not the border box: a host that hands these bounds to a native view
 * has a bounds setter and no clip API, so the intersection with the viewport and
 * every clipping ancestor is the only rectangle it can act on.
 */
export interface TrackedRect {
  readonly paneId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * False when either dimension of the visible clip is below one pixel, or while an
   * overlay owns the airspace. A native view reads this and hides rather than
   * drawing itself over a dialog.
   */
  readonly isVisible: boolean;
}

/**
 * The composed key one frame's writes are deduped on.
 *
 * Every member that decides what a host would DO with the rect, and nothing else:
 * two measurements that differ only in the source that produced them are the same
 * write, and emitting both would be the four-writes-per-edge failure this class
 * exists to remove. Rounded to whole pixels because a sub-pixel jitter no one can
 * see is not a change anyone should be woken for.
 */
export function rectKey(rect: TrackedRect): string {
  return [
    rect.paneId,
    Math.round(rect.x),
    Math.round(rect.y),
    Math.round(rect.width),
    Math.round(rect.height),
    rect.isVisible,
  ].join(":");
}
