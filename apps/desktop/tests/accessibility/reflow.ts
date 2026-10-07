// How this tier narrows the page for WCAG 2.2 SC 1.4.10 (Reflow): the sibling of `axe-run.ts`,
// which axe cannot answer because reflow is a property of a layout at a width. What would still
// need a sideways scroll is read by `tests/helpers/horizontal-overflow.ts`.
//
// The tester iframe is resized rather than the browser viewport: measured at this pin,
// `Emulation.setDeviceMetricsOverride` over `cdp()` leaves `window.innerWidth` inside the
// tester at 1440, because that handle drives the orchestrator page, which sizes the same-origin
// iframe with its own CSS. Resizing the frame element changes the CSS pixel width the tests'
// document lays out in, and `matchMedia` inside the frame answers against it.
//
// The narrowing throws when the frame is out of reach: a silent no-op would measure the app
// at 1440, where nothing overflows and every assertion is true for the wrong reason.

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
