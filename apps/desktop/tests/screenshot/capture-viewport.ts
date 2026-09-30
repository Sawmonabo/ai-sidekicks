// How large a window a capture needs, and the one it is refused above. Not a test file. It has no
// imports on purpose: `vitest/screenshot-pins.ts` reads the ceiling while Vitest resolves its
// config in Node, where importing `vitest/browser` throws. `settled-capture.ts` applies the rule.
//
// Vitest browser mode runs a spec in a fixed-size tester iframe, so an element taller than it is
// composited only for the visible band: the capture clip returns that band, then page background
// (measured: content to row 899, white below). No capture option paints beyond the iframe, so
// the tester window itself must grow. Vitest scales the iframe by
// `min(1, pageWidth / width, pageHeight / height)`, so the tier's page is built at the ceiling
// height; a taller window would be a fractional downscale, the resampling
// `vitest/screenshot-pins.ts` records as making Skia builds disagree.
//
// An element whose height derives from the window's (the console's two full-height destinations:
// `min-height: 100%` around 32 px of padding, so 64 px past any window) is never held: growing
// moves both numbers together, so it is captured at the tier's own window. One non-closing
// overhang is also what an element that reflowed once looks like, so that arm needs two.
//
// The same window sizes the stability wait (two captures of the held box, linear in pixels).

/** A window size in CSS pixels, as both the tester window and a capture use it. */
export interface CaptureViewport {
  readonly width: number;
  readonly height: number;
}

/**
 * The tallest window this tier will open. It is the height the screenshot project's Playwright
 * page is built at, so a grown window still scales at exactly 1. Four times the 900 px console
 * window (the tallest pinned element is 2 446 px); an element needing more is not one anyone
 * reads whole, and the refusal, not a higher ceiling, is the answer.
 */
export const CAPTURE_WINDOW_HEIGHT_CEILING = 3600;

/**
 * How long a capture of one window is given to prove it is stable: Vitest's own five-second
 * default, restated because the window can grow for an element. `toMatchScreenshot`
 * races a loop of capture, capture, compare (`allowedMismatchedPixels: 0`) against one `timeout`,
 * so the wait budgets a PNG encode and pixel comparison over the held box, twice, both linear in
 * its pixels. A 1 200 × 2 400 element (about 3 Mpx) did not fit five seconds on a loaded
 * `macos-15` runner and read as unstable. So it stays five seconds per window and
 * `stabilityWaitMsFor` multiplies it by the windows held; a genuinely unstable element still
 * fails, with the wait named.
 */
export const STABILITY_WAIT_PER_VIEWPORT_MS = 5000;

/**
 * How long a capture holding `heldViewportRatio` windows is given: N windows tall gets N times
 * the wait. Rounded up, since 2.05 windows pays the third window's work in whichever pass reaches
 * those rows. The rounding is also the floor: a capture smaller than the window rounds to one
 * window, so it never gets a fraction of the wait, and a `Math.max(1, …)` beside it would be
 * unreachable. Pure over the ratio, so the wait is checkable without taking a capture.
 */
export function stabilityWaitMsFor(heldViewportRatio: number): number {
  return STABILITY_WAIT_PER_VIEWPORT_MS * Math.ceil(heldViewportRatio);
}

/**
 * What one sizing pass decided: the window fits, it should grow, or growing is futile. There are
 * three arms because the third is a real outcome, not a failure. `grow` carries the overhang it
 * measured, so the caller does not subtract the same two numbers again.
 */
export type CaptureWindowStep =
  | { readonly kind: "fits" }
  | { readonly kind: "grow"; readonly viewport: CaptureViewport; readonly overhangPx: number }
  | { readonly kind: "grows-with-its-window"; readonly overhangPx: number };

/**
 * How many consecutive non-closing overhangs the third arm needs: two, three measurements at three
 * window heights. One observation cannot tell an element sized by its window from one that
 * reflowed once during the settle; the second is taken at a window the first paid for, where a
 * reflowed element's overhang closes and the pass reports `fits`.
 */
const CONFIRMING_NON_CLOSING_PASSES = 2;

/**
 * How many of the trailing overhangs failed to close on the one before. Read from the end, since
 * only the run reaching the present pass describes the element now.
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
 * Decides one sizing pass: fit, grow, or stop because the element grows with its window. Pure
 * over sizes, so every arm and both refusals are driven without a browser.
 * `previousOverhangsPx` is how far the element hung past the window on each earlier pass, oldest
 * first (empty on the first), and is the whole basis of the third arm.
 *
 * It throws where no window would help: an element wider than the page (a capture never widens
 * the window, which would relayout the console) or taller than the ceiling. A confirmed coupling
 * is answered before the ceiling, since that element is photographed at the tier's own window; a
 * merely suspected one is refused, because assuming it writes an image with an unpainted tail.
 */
export function captureWindowStep(
  applied: CaptureViewport,
  required: CaptureViewport,
  previousOverhangsPx: readonly number[],
  captureName: string,
): CaptureWindowStep {
  if (required.width > applied.width) {
    throw new Error(
      `Refusing to capture ${captureName}: the element extends ${String(required.width)}px ` +
        `across a ${String(applied.width)}px window, and a capture never widens one — a ` +
        `console relaid out at another width is not the element the captures pin.`,
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
      `Refusing to capture ${captureName}: the element is ${String(required.height)}px tall ` +
        `and this tier opens a window of at most ${String(CAPTURE_WINDOW_HEIGHT_CEILING)}px. ` +
        `A capture taller than that is not an element a review can read; split it, or pin the ` +
        `part a person actually looks at.`,
    );
  }
  return {
    kind: "grow",
    viewport: { width: applied.width, height: required.height },
    overhangPx,
  };
}
