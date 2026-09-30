// How this tier narrows the page and reports what would still need a sideways scroll: the
// sibling of `axe-run.ts` for WCAG 2.2 SC 1.4.10 (Reflow), which axe cannot answer because
// reflow is a property of a layout at a width.
//
// The tester iframe is resized rather than the browser viewport: measured at this pin,
// `Emulation.setDeviceMetricsOverride` over `cdp()` leaves `window.innerWidth` inside the
// tester at 1440, because that handle drives the orchestrator page, which sizes the same-origin
// iframe with its own CSS. Resizing the frame element changes the CSS pixel width the tests'
// document lays out in, and `matchMedia` inside the frame answers against it.
//
// The narrowing throws when the frame is out of reach: a silent no-op would measure the console
// at 1440, where nothing overflows and every assertion is true for the wrong reason.

/**
 * How much overflow is read as none, in px. `scrollWidth` and `clientWidth` are rounded from
 * fractional layout, so one reported pixel may be one no person can scroll to.
 */
export const REFLOW_OVERFLOW_TOLERANCE_PX = 1;

/** The three properties the narrowing pins, so the frame cannot be re-sized by its host. */
const TESTER_FRAME_WIDTH_PROPERTIES: readonly string[] = ["width", "min-width", "max-width"];

/**
 * The inline style of the iframe this tier's tests run inside. `window.frameElement` comes
 * from the parent document's realm, so `instanceof HTMLIFrameElement` is false for it; checking
 * that `style` is present survives the realm boundary.
 */
function testerFrameStyle(): CSSStyleDeclaration {
  const frameElement: (Element & Partial<ElementCSSInlineStyle>) | null = window.frameElement;
  if (frameElement?.style === undefined) {
    throw new Error(
      "the reflow tier could not reach its own tester frame, so no narrowing happened",
    );
  }
  return frameElement.style;
}

/**
 * Lay the tester document out at `cssPixels` wide, and throw if it did not take. `!important`
 * beats the host page's own width declaration; the readback keeps the tier from silently
 * measuring at its 1440 default.
 */
export function narrowTesterViewportTo(cssPixels: number): void {
  const style = testerFrameStyle();
  for (const property of TESTER_FRAME_WIDTH_PROPERTIES) {
    style.setProperty(property, `${cssPixels}px`, "important");
  }
  if (window.innerWidth !== cssPixels) {
    throw new Error(
      `the reflow tier asked for a ${cssPixels}px viewport and got ${window.innerWidth}px`,
    );
  }
}

/** Hand the frame back to its host, so the next file in the tier starts at the tier's width. */
export function restoreTesterViewport(): void {
  const style = testerFrameStyle();
  for (const property of TESTER_FRAME_WIDTH_PROPERTIES) {
    style.removeProperty(property);
  }
}

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
    if (overflowPx > REFLOW_OVERFLOW_TOLERANCE_PX) {
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
  const overflowX = window.getComputedStyle(element).overflowX;
  return overflowX === "hidden" || overflowX === "clip";
}

/** An element as a reader would point at it: its tag, its id, and its classes. */
function describeElement(element: Element): string {
  const identifier = element.id === "" ? "" : `#${element.id}`;
  const classes = Array.from(element.classList, (className) => `.${className}`).join("");
  return `${element.localName}${identifier}${classes}`;
}
