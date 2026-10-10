// The one walk over an element's clipping ancestors. The session pane layout intersects their
// boxes into the rectangle a native view may occupy, the preview geometry subtracts them, and the
// flow's diff finds the scroller it is drawn in; features never import each other, so the walk
// lives in shared code.
//
// The `overflow-x` and `overflow-y` longhands decide; the `overflow` shorthand is a fallback
// used only when neither axis is readable. A conformant engine serializes the shorthand from
// the axes, but `happy-dom` (the `renderer` tier's document) reports the empty string
// for both axes of an element styled with the shorthand alone.

import { getComputedStyle, getWindow } from "@floating-ui/utils/dom";

/**
 * The computed `overflow` values that clip a descendant.
 *
 * A closed positive set rather than a `!== "visible"` test: a stylesheet-free document reports
 * the empty string for every box, which the negative form would treat as clipping and hide
 * every pane. A tuple rather than a `Set` because a module-level `Set` is mutable.
 */
export const CLIPPING_OVERFLOW_VALUES = ["hidden", "clip", "scroll", "auto", "overlay"] as const;

/** The computed `overflow` values of a box the person scrolls on that axis. */
export const SCROLLING_OVERFLOW_VALUES = ["auto", "scroll", "overlay"] as const;

/** Whether one computed `overflow` value clips its contents. */
export function clipsItsContents(overflowValue: string): boolean {
  return CLIPPING_OVERFLOW_VALUES.some((clippingValue) => clippingValue === overflowValue);
}

/**
 * A computed style's `overflow` on each axis: the longhands where either is readable, else the
 * `overflow` shorthand's `<x> [<y>]`, whose one value covers both axes.
 */
export function overflowAxesOf(style: CSSStyleDeclaration): {
  readonly horizontal: string;
  readonly vertical: string;
} {
  if (style.overflowX !== "" || style.overflowY !== "") {
    return { horizontal: style.overflowX, vertical: style.overflowY };
  }
  const [horizontal = "", vertical = horizontal] = style.overflow.trim().split(/\s+/u);
  return { horizontal, vertical };
}

/**
 * Every ancestor of `element` that clips what is inside it, innermost first.
 *
 * A generator so a caller that stops once its running clip is empty pays for only the
 * ancestors it reached: each costs one `getComputedStyle`, and a pass runs on every document
 * scroll.
 */
export function* clippingAncestorsOf(element: Element): Generator<HTMLElement> {
  let ancestor = element.parentElement;
  while (ancestor !== null) {
    if (styleClipsItsContents(getComputedStyle(ancestor))) {
      yield ancestor;
    }
    ancestor = ancestor.parentElement;
  }
}

/**
 * The nearest ancestor of `element` whose vertical overflow the person scrolls, or `undefined`
 * where none does and the window scrolls.
 */
export function nearestVerticalScrollerOf(element: Element): HTMLElement | undefined {
  const ownerWindow = getWindow(element);
  for (const ancestor of clippingAncestorsOf(element)) {
    const { vertical } = overflowAxesOf(ownerWindow.getComputedStyle(ancestor));
    if (SCROLLING_OVERFLOW_VALUES.some((value) => value === vertical)) {
      return ancestor;
    }
  }
  return undefined;
}

function styleClipsItsContents(style: CSSStyleDeclaration): boolean {
  const { horizontal, vertical } = overflowAxesOf(style);
  return clipsItsContents(horizontal) || clipsItsContents(vertical);
}
