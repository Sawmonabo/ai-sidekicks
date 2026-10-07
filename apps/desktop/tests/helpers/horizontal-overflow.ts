// What in a laid-out tree would need a horizontal scroll, read in the engine that laid it out:
// the reflow tier reads a whole window with it, the browser tier one view at the window's floor.

/**
 * One line per element at or under `root` that would need a horizontal scroll, so a failure
 * names the box to fix. Ancestors of an overflowing element report it too, because a box with
 * `overflow: visible` measures its scrolling area over its children, so a failure reads as a
 * path from the frame down to the culprit.
 *
 * Elements with no width are skipped: an inline box and a `display: contents` wrapper report zero
 * `clientWidth`, and an inline box reports its content for `scrollWidth`, so every prose `<span>`
 * would otherwise overflow its own zero-width box. Clipped boxes are skipped too, as a reading of
 * 1.4.10 (content a person must scroll sideways to reach): a box with `overflow-x` `hidden` or
 * `clip` offers no scroll gesture, and `.meridian-visually-hidden` is exactly that shape on every
 * view. The skip gives up the criterion's other half, content clipped away, which this walk
 * cannot tell from deliberate screen-reader text; that half is the axe runs' and a reader's.
 */
export function describeHorizontalOverflow(root: Element): string[] {
  const overflowing: string[] = [];
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (element.clientWidth === 0 || isHorizontallyClipped(element)) {
      continue;
    }
    const overflowPx = element.scrollWidth - element.clientWidth;
    if (overflowPx > HORIZONTAL_OVERFLOW_TOLERANCE_PX) {
      overflowing.push(
        `${describeElement(element)} overflows by ${overflowPx}px ` +
          `(client ${element.clientWidth}, scroll ${element.scrollWidth})`,
      );
    }
  }
  return overflowing;
}

/** Whether the author has clipped this box's inline axis, so nothing in it scrolls. */
function isHorizontallyClipped(element: Element): boolean {
  // Read in the element's own window: an app window is a document of its own.
  const overflowX = (element.ownerDocument.defaultView ?? window).getComputedStyle(
    element,
  ).overflowX;
  return overflowX === "hidden" || overflowX === "clip";
}

/** An element as a reader would point at it: its tag, its id, and its classes. */
function describeElement(element: Element): string {
  const identifier = element.id === "" ? "" : `#${element.id}`;
  const classes = Array.from(element.classList, (className) => `.${className}`).join("");
  return `${element.localName}${identifier}${classes}`;
}

/**
 * How much overflow is read as none, in px. `scrollWidth` and `clientWidth` are rounded from
 * fractional layout, so one reported pixel may be one no person can scroll to.
 */
const HORIZONTAL_OVERFLOW_TOLERANCE_PX = 1;
