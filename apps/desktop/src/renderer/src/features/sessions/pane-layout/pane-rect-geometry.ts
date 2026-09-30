// What a pane's visible rectangle is, and what counts as a change. Stateless: it walks the DOM
// on demand. When to measure is `pane-rect-tracker.ts`.
//
// The visible clip is computed synchronously rather than observed with `IntersectionObserver`:
// that delivers asynchronously off a frame the tracker does not own, cannot be driven by the
// injected clock, reports threshold crossings rather than geometry, and has no on-demand read.
//
// Which ancestors clip is `lib/clipping-ancestors.ts`'s question, shared with the preview
// geometry publisher; this module only intersects.

import { clippingAncestorsOf } from "@renderer/lib/clipping-ancestors.js";

/** Why a rect was re-measured. Shown in diagnostics. */
export const RECT_INVALIDATION_SOURCES = [
  "host-resize",
  "window-resize",
  "ancestor-scroll",
  "layout-mover",
  // Not folded into `layout-mover`: an overlay opening changes no layout, and counting it as
  // one would make the per-source counters lie.
  "airspace",
] as const;

/** One invalidation source. */
export type RectInvalidationSource = (typeof RECT_INVALIDATION_SOURCES)[number];

/**
 * One pane's visible clip in CSS pixels, plus whether it is worth compositing.
 *
 * The clip rather than the border box, because a native view has a bounds setter and no clip API.
 */
export interface TrackedRect {
  readonly paneId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * False when either dimension of the visible clip is below one pixel, or while an overlay
   * owns the airspace; a native view hides rather than drawing over a dialog.
   */
  readonly isVisible: boolean;
}

/**
 * The part of `element` a person can see, in viewport coordinates.
 *
 * `getBoundingClientRect` ignores clipping ancestors, and a native view is composited by the
 * host, so a half-scrolled pane's view would draw over its neighbors. The walk is a generator:
 * once the running clip is empty the remaining ancestors are never read.
 */
export function visibleClipOf(element: Element): ViewportBox {
  const box = element.getBoundingClientRect();
  let clip = intersectBoxes(
    { x: box.x, y: box.y, width: box.width, height: box.height },
    { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight },
  );
  if (isEmptyBox(clip)) {
    return clip;
  }
  for (const ancestor of clippingAncestorsOf(element)) {
    const ancestorBox = ancestor.getBoundingClientRect();
    clip = intersectBoxes(clip, {
      x: ancestorBox.x,
      y: ancestorBox.y,
      width: ancestorBox.width,
      height: ancestorBox.height,
    });
    if (isEmptyBox(clip)) {
      break;
    }
  }
  return clip;
}

/**
 * The key a frame's writes are deduped on: every member a host acts on, rounded to whole pixels
 * so sub-pixel jitter is not a change.
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

/** A rectangle in viewport coordinates. */
interface ViewportBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Whether a box has any extent left to show. The walk's stop condition. */
function isEmptyBox(box: ViewportBox): boolean {
  return box.width <= 0 || box.height <= 0;
}

/** The overlap of two boxes, floored at zero so a disjoint pair has no extent. */
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
