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
// row below it. Measured on the committed set — every capture taller than the
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
// window the tier configures, which is the size every other capture is taken at,
// and the overhang is that surface's own trailing padding rather than anything it
// draws. Stated here because it is a property of THE SURFACE and not of the capture:
// a destination that stops overflowing its scroll container stops taking this arm.
//
// AND THAT SHAPE IS CONFIRMED RATHER THAN GUESSED. One non-closing overhang is also
// what a surface that reflowed ONCE looks like: the grow is itself a layout change,
// so a deferred image landing or a container re-measuring can add back as much as the
// window just gained, during the very settle that made room for it. Reading that as
// coupling puts the window back and photographs the surface with an unpainted tail
// below it — the defect this module exists to refuse, arriving through the fix for
// it. So the third arm is taken on TWO consecutive non-closing overhangs, measured at
// three window heights: it costs the genuinely coupled destinations one more resize,
// and it is what makes the one-time reflow report `fits` on the pass after.
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
// AND THE SAME WINDOW DECIDES HOW LONG THE CAPTURE OF IT IS GIVEN. A stability check
// is two captures of the held box compared against each other, and both halves of that
// are linear in the box's pixels, so the window a capture opened is also the size of
// the work the matcher has to finish inside one wait. This module owns both readings of
// that one number — how tall a window may be opened, and what opening it buys — because
// splitting them would leave the ceiling here and the budget it implies somewhere that
// cannot see it. `STABILITY_WAIT_PER_VIEWPORT_MS` and `stabilityWaitMsFor` below.
//
// Not a test file — no `include` glob reaches it. Deliberately IMPORT-FREE:
// `vitest/screenshot-pins.ts` reads the ceiling
// below while Vitest RESOLVES ITS CONFIG, which happens in Node, and `vitest/browser`
// throws outright when it is imported outside browser mode — so a binding folded in
// here would take down every project in the package. That property is what makes this
// the only home the wait can have: the pin is read from the page, and the pins file is
// read from Node, and this module is the one both of them may import. The rule lives
// here; the binding that applies it lives in `settled-capture.ts`, in the page.

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
 * How long a capture of ONE window is given to prove it is stable.
 *
 * WHAT THE WAIT IS ACTUALLY BUYING. `toMatchScreenshot` does not sleep and then
 * photograph: it takes a capture, takes another, and asks the tier's comparator whether
 * the two are equal under `allowedMismatchedPixels: 0`, repeating until they are — and
 * it races that whole loop against a single `timeout`
 * (`@vitest/browser@4.1.5` `dist/index.js`, `waitForStableScreenshot` wrapping
 * `getStableScreenshot`). So the wait is a budget for capture WORK, and the work is a
 * PNG encode plus a pixel comparison over the held box, twice — both linear in that
 * box's pixels.
 *
 * FIVE SECONDS, which is Vitest's own default, restated here because it stopped being
 * an inherited default the moment the tier began opening the window for a surface. The
 * default is sized for a capture the size of the window; a tier that holds a box
 * several windows tall is asking for several times the encode and several times the
 * comparison under the same budget. Measured: `tall-capture.test.ts` holds a
 * 1 200 × 2 400 surface whole, which is a ~3 Mpx encode and a ~3 Mpx comparison twice
 * over, and on a loaded runner (GitHub Actions run 34267040299, the `macos-15`
 * screenshot job) that did not fit — the probe failed with "Could not capture a stable
 * screenshot within 5000ms" on a branch whose diff touched no renderer file, while the
 * same job was green on the base commit and on two sibling branches the same hour. A
 * perfectly static surface reported unstable, which is a budget failure wearing a
 * stability failure's name.
 *
 * IT STAYS FIVE SECONDS PER WINDOW rather than becoming a larger flat number.
 * `stabilityWaitMsFor` multiplies it by the windows a capture actually held, so a
 * viewport-sized capture keeps exactly the wait it has always had and only a capture
 * that asked for more work is given longer to finish it. A surface that is genuinely
 * unstable still fails — later, and with the wait it was given named in the failure,
 * because the matcher prints the number it raced against.
 */
export const STABILITY_WAIT_PER_VIEWPORT_MS = 5000;

/**
 * How long a capture holding `heldViewportRatio` windows is given to prove it is stable.
 *
 * Per-capture cost times two captures, and capture cost scales with pixels, so a
 * capture N viewports tall is given N times the wait. Rounded UP, because a capture
 * 2.05 windows tall pays the third window's encode and comparison in whichever pass
 * reaches those rows — a fractional budget would be a budget for work no pass does in
 * fractions.
 *
 * AND THE ROUNDING IS ALSO THE FLOOR, which is why no second guard is written beside
 * it: a capture smaller than the window is a ratio between 0 and 1, and rounding that
 * up lands on one window, so such a capture is handed exactly the wait the tier has
 * always given it and never a fraction of it. A `Math.max(1, …)` here would be
 * unreachable rather than defensive — both sides of the ratio are window areas, so
 * neither is ever zero or negative — and an unreachable guard is one the suite beside
 * this module cannot plant a failure into, which is the bar the test rules in
 * `apps/desktop/AGENTS.md` set and not a matter of taste.
 *
 * A PURE FUNCTION OVER THE RATIO, which is what makes the wait checkable without
 * taking a capture: `CaptureWindow` measures the two windows and reports what it held,
 * and the arithmetic that turns that into a budget is here, beside the sizing rule that
 * produced the window in the first place.
 */
export function stabilityWaitMsFor(heldViewportRatio: number): number {
  return STABILITY_WAIT_PER_VIEWPORT_MS * Math.ceil(heldViewportRatio);
}

/**
 * What one sizing pass decided: the window fits, it should grow, or growing is futile.
 *
 * Three arms rather than a nullable window, because the third is a real outcome and
 * not a failure. A surface whose own height is derived from the window's — the
 * console's two full-height destinations are, each `min-height: 100%` around its own
 * padding — is exactly one window tall plus a constant, at every window. Growing
 * moves both numbers by the same amount and photographs the same picture in a taller
 * frame, so the honest answer is to stop and take it at the window the tier
 * configures, which is the size every other capture is taken at.
 *
 * `grow` CARRIES THE OVERHANG IT MEASURED rather than leaving the caller to subtract
 * the same two numbers over again. That figure is the input the next pass is judged
 * against, and two subtractions of one quantity is the drift the shared-code rule
 * in `apps/desktop/AGENTS.md` forbids on the two sides of a seam.
 */
export type CaptureWindowStep =
  | { readonly kind: "fits" }
  | { readonly kind: "grow"; readonly viewport: CaptureViewport; readonly overhangPx: number }
  | { readonly kind: "grows-with-its-window"; readonly overhangPx: number };

/**
 * How many consecutive non-closing overhangs the third arm is taken on.
 *
 * TWO, which is three measurements at three window heights, and the distance between
 * a surface sized BY its window and a surface that reflowed once while the first
 * window was being opened. Opening a window is a layout change, so a deferred image
 * or a re-measuring container can add back as much as the window just gained during
 * the settle that follows it. One observation cannot tell those apart — both leave an
 * overhang no smaller than the one before — and reading the reflow as coupling
 * restores the tier's window and photographs the surface with an unpainted tail,
 * which is the false green this module exists to refuse.
 *
 * A SECOND OBSERVATION SEPARATES THEM because it is taken at a window the first one
 * paid for. A surface sized by its window hangs over by the same constant at every
 * height, so its overhang survives the grow. A surface that reflowed once has since
 * been given the height it grew to, so its overhang closes and the pass reports
 * `fits` — which is the capture the defect was replacing with a restored window.
 */
const CONFIRMING_NON_CLOSING_PASSES = 2;

/**
 * How many of the trailing overhangs failed to close on the one before them.
 *
 * Read from the END, because only the run reaching the present pass says anything
 * about the surface now: a surface that reflowed, was grown for, and then settled
 * carries a closing pass in its history, and that pass is what ends the run.
 */
function nonClosingRunLength(overhangsPx: readonly number[]): number {
  let run = 0;
  for (let index = overhangsPx.length - 1; index > 0; index -= 1) {
    const overhangPx = overhangsPx[index];
    const overhangBeforePx = overhangsPx[index - 1];
    if (
      overhangPx === undefined ||
      overhangBeforePx === undefined ||
      overhangPx < overhangBeforePx
    ) {
      break;
    }
    run += 1;
  }
  return run;
}

/**
 * Decide one sizing pass: fit, grow, or stop because the surface grows with its window.
 *
 * A PURE FUNCTION OVER SIZES, which is what makes the sizing testable without a
 * browser: the DOM read that produces `required` is `settled-capture.ts`'s and the
 * decision is here, so every arm and both refusals can be driven by a node-shaped
 * case instead of by minting a capture that is too large on purpose.
 *
 * `previousOverhangsPx` is how far the surface hung past the window on each earlier
 * pass, oldest first, and empty on the first. It is the whole basis of the third arm:
 * an overhang no smaller after a grow than before it is a surface being sized BY the
 * window rather than one that simply needed a bigger one — and the arm waits for that
 * to hold twice, for `CONFIRMING_NON_CLOSING_PASSES`' reason. The history is passed
 * rather than a verdict the caller reached, so the whole judgement is owned here and
 * the loop that drives it owns none of it.
 *
 * It throws rather than returning a wider window in the two cases where no window
 * would help. A surface wider than the page cannot be held at all — the page is
 * built at one width and a capture never changes it, because widening the window
 * would relayout the console at a width no capture is taken at. A surface
 * taller than the ceiling is refused for the reason the ceiling records, and the
 * ORDER against the third arm is the one choice here worth naming: a CONFIRMED
 * coupling is answered before the ceiling is consulted, because that surface is
 * photographed at the tier's own window and never needs a tall one, while a merely
 * SUSPECTED one is refused rather than assumed — assuming it is what writes an image
 * with an unpainted tail, and the ceiling's message is the honest thing to fail with.
 */
export function captureWindowStep(
  applied: CaptureViewport,
  required: CaptureViewport,
  previousOverhangsPx: readonly number[],
  captureName: string,
): CaptureWindowStep {
  if (required.width > applied.width) {
    throw new Error(
      `Refusing to capture ${captureName}: the surface extends ${String(required.width)}px ` +
        `across a ${String(applied.width)}px window, and a capture never widens one — a ` +
        `console relaid out at another width is not the surface the captures pin.`,
    );
  }
  const overhangPx = required.height - applied.height;
  if (overhangPx <= 0) {
    return { kind: "fits" };
  }
  if (nonClosingRunLength([...previousOverhangsPx, overhangPx]) >= CONFIRMING_NON_CLOSING_PASSES) {
    return { kind: "grows-with-its-window", overhangPx };
  }
  if (required.height > CAPTURE_WINDOW_HEIGHT_CEILING) {
    throw new Error(
      `Refusing to capture ${captureName}: the surface is ${String(required.height)}px tall ` +
        `and this tier opens a window of at most ${String(CAPTURE_WINDOW_HEIGHT_CEILING)}px. ` +
        `A capture taller than that is not a surface a review can read; split it, or pin the ` +
        `part a person actually looks at.`,
    );
  }
  return {
    kind: "grow",
    viewport: { width: applied.width, height: required.height },
    overhangPx,
  };
}
