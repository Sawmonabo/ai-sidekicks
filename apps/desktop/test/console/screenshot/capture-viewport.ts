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
// AND ONE SHAPE OF SURFACE NO WINDOW HOLDS. A surface whose own height is derived
// from the window's is exactly one window tall plus a constant, at every window: the
// console's two full-height destinations are `min-height: 100%` around 32 px of their
// own padding, so each measures 64 px past whatever window it is in. Growing moves
// both numbers together and photographs the same picture in a taller frame, so this
// module names that outcome instead of chasing it — the capture is taken at the
// window the tier configures, which is the size every other reference is minted at,
// and the overhang is that surface's own trailing padding rather than anything it
// draws. Stated here because it is a property of THE SURFACE and not of the capture:
// a destination that stops overflowing its scroll container stops taking this arm.
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
 * What one sizing pass decided: the window fits, it should grow, or growing is futile.
 *
 * Three arms rather than a nullable window, because the third is a real outcome and
 * not a failure. A surface whose own height is derived from the window's — the
 * console's two full-height destinations are, each `min-height: 100%` around its own
 * padding — is exactly one window tall plus a constant, at every window. Growing
 * moves both numbers by the same amount and photographs the same picture in a taller
 * frame, so the honest answer is to stop and take it at the window the tier
 * configures, which is the size every other reference is minted at.
 */
export type CaptureWindowStep =
  | { readonly kind: "fits" }
  | { readonly kind: "grow"; readonly viewport: CaptureViewport }
  | { readonly kind: "grows-with-its-window"; readonly overhangPx: number };

/**
 * Decide one sizing pass: fit, grow, or stop because the surface grows with its window.
 *
 * A PURE FUNCTION OVER SIZES, which is what makes the sizing testable without a
 * browser: the DOM read that produces `required` is `settled-capture.ts`'s and the
 * decision is here, so every arm and both refusals can be driven by a node-shaped
 * case instead of by minting a capture that is too large on purpose.
 *
 * `previousOverhangPx` is how far the surface hung past the window on the pass
 * before this one, and `undefined` on the first pass. It is the whole basis of the
 * third arm: a surface that hangs over by no less after a grow than before it is
 * being sized BY the window, and no window will hold it. Comparing overhangs rather
 * than heights is what distinguishes that from a surface that simply needed a bigger
 * window and got one.
 *
 * It throws rather than returning a wider window in the two cases where no window
 * would help. A surface wider than the page cannot be held at all — the page is
 * built at one width and a capture never changes it, because widening the window
 * would relayout the console at a width no reference was minted under. A surface
 * taller than the ceiling is refused for the reason the ceiling records.
 */
export function captureWindowStep(
  applied: CaptureViewport,
  required: CaptureViewport,
  previousOverhangPx: number | undefined,
  referenceName: string,
): CaptureWindowStep {
  if (required.width > applied.width) {
    throw new Error(
      `Refusing to capture ${referenceName}: the surface extends ${String(required.width)}px ` +
        `across a ${String(applied.width)}px window, and a capture never widens one — a ` +
        `console relaid out at another width is not the surface the references pin.`,
    );
  }
  const overhangPx = required.height - applied.height;
  if (overhangPx <= 0) {
    return { kind: "fits" };
  }
  if (previousOverhangPx !== undefined && overhangPx >= previousOverhangPx) {
    return { kind: "grows-with-its-window", overhangPx };
  }
  if (required.height > CAPTURE_WINDOW_HEIGHT_CEILING) {
    throw new Error(
      `Refusing to capture ${referenceName}: the surface is ${String(required.height)}px tall ` +
        `and this tier opens a window of at most ${String(CAPTURE_WINDOW_HEIGHT_CEILING)}px. ` +
        `A capture taller than that is not a surface a review can read; split it, or pin the ` +
        `part a person actually looks at.`,
    );
  }
  return { kind: "grow", viewport: { width: applied.width, height: required.height } };
}
