// How large a window a capture needs, and the one it is refused above.
//
// WHY A CAPTURE NEEDS A WINDOW AT ALL. Vitest browser mode runs a spec inside a
// tester IFRAME, and `@vitest/browser-playwright` takes a capture as Playwright's
// own element screenshot on a locator resolved through that iframe
// (`dist/index.js:523`). Playwright measures the element's bounding box, adds the
// main frame's scroll, and sends the result to Chromium as a CLIP
// (`playwright-core/lib/coreBundle.js:21281-21302`, `:37199`). A clip is a rectangle
// in the page's own coordinates — it is not a promise that anything was painted
// there. The iframe is a fixed-size box in that page, so an element taller than the
// iframe is laid out inside a scroll container and only the visible band is ever
// composited: the clip returns that band, and then the page's background for every
// row below it. Measured on the committed set — every reference taller than the
// 900 px window carried real content to row 899 and pure white to the bottom edge,
// in the dark scheme as well as the light one, which is what makes it a capture
// artefact rather than a surface that happens to end.
//
// SO THE FIX IS A WINDOW AND NOT A CAPTURE OPTION. There is no option on either side
// that paints beyond the iframe: Playwright already asks Chromium for
// `captureBeyondViewport` whenever the box does not fit, and that flag resizes the
// MAIN frame, which leaves the iframe the same fixed-size box it was. What has to
// grow is the tester window itself, so the element is laid out and painted whole
// before anything is clipped out of it.
//
// AND THE PAGE HAS TO BE ABLE TO HOLD IT. Vitest sizes the tester iframe by writing
// a width, a height, and a `transform: scale()` onto the orchestrator's container,
// where the scale is `min(1, pageWidth / width, pageHeight / height)`
// (`@vitest/browser/dist/client/__vitest_browser__/orchestrator-*.js`,
// `setIframeViewport`). Ask for a window taller than the Playwright page and the
// scale drops below 1 — the capture is then a fractional DOWNSCALE of the console,
// which is the resampling `vitest/screenshot-pins.ts` already records as the thing
// that makes two Skia builds disagree. So the page this tier's context is given is
// tall enough for any window a capture may open, and this module holds the number
// both halves read.
//
// Not a test file — no `include` glob reaches it. Deliberately IMPORT-FREE, for
// `baseline-platform.ts`'s reason: `vitest/screenshot-pins.ts` reads the ceiling
// below while Vitest RESOLVES ITS CONFIG, which happens in Node, and `vitest/browser`
// throws outright when it is imported outside browser mode — so a binding folded in
// here would take down every project in the package. The rule lives here; the binding
// that applies it lives in `settled-capture.ts`, in the page.

/** A window size in CSS pixels, as both the tester window and a capture use it. */
export interface CaptureViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * The tallest window this tier will open, and therefore the tallest capture it takes.
 *
 * It is the height the screenshot project's Playwright page is built at, so a window
 * grown to it still scales at exactly 1. Four times the 900 px window the console is
 * measured in: the tallest surface the committed set pins today is 2 446 px, which is
 * 2.7 of them, so this is real headroom rather than a number fitted to the current
 * corpus — and it is a CEILING rather than an arbitrarily large page because a surface
 * that needs more than four windows is not a surface anyone reads whole, and an image
 * of it is not a thing a review can look at. The refusal below is the honest answer
 * there; raising this number to silence one is not.
 */
export const CAPTURE_WINDOW_HEIGHT_CEILING = 3600;

/**
 * The window a capture needs, or `undefined` when the one it already has holds it.
 *
 * A PURE FUNCTION OVER TWO SIZES, which is what makes the sizing testable without a
 * browser: the DOM read that produces `required` is `settled-capture.ts`'s and the
 * decision is here, so both refusals below can be driven by a node-shaped case
 * instead of by minting a capture that is too large on purpose.
 *
 * It throws rather than returning a wider window in the two cases where no window
 * would help. A surface wider than the page cannot be held at all — the page is
 * built at one width and a capture never changes it, because widening the window
 * would relayout the console at a width no reference was minted under. A surface
 * taller than the ceiling is refused for the reason the ceiling records.
 */
export function captureViewportFor(
  applied: CaptureViewport,
  required: CaptureViewport,
  referenceName: string,
): CaptureViewport | undefined {
  if (required.width > applied.width) {
    throw new Error(
      `Refusing to capture ${referenceName}: the surface extends ${String(required.width)}px ` +
        `across a ${String(applied.width)}px window, and a capture never widens one — a ` +
        `console relaid out at another width is not the surface the references pin.`,
    );
  }
  if (required.height <= applied.height) {
    return undefined;
  }
  if (required.height > CAPTURE_WINDOW_HEIGHT_CEILING) {
    throw new Error(
      `Refusing to capture ${referenceName}: the surface is ${String(required.height)}px tall ` +
        `and this tier opens a window of at most ${String(CAPTURE_WINDOW_HEIGHT_CEILING)}px. ` +
        `A capture taller than that is not a surface a review can read; split it, or pin the ` +
        `part a person actually looks at.`,
    );
  }
  return { width: applied.width, height: required.height };
}
