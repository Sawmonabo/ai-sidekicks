// The one call every screenshot capture goes through, the settle it refuses, and the
// window it opens so the whole surface is in the image.
//
// WHY A CAPTURE CAN BE WRONG WITHOUT BEING RED. A loader-backed pane body arrives as
// its own chunk, so between the pane mounting and its module landing the pane is its
// own chrome and nothing else. That frame is correct — it is what keeps the deferred
// body off the initial import graph — and it is a catastrophic thing to photograph: a
// reference minted from it records a pane that had not finished loading, and every
// later run is then compared against a picture of a half-built surface. Nothing about
// that is red. The image is stable, the comparison passes, and the surface the tier
// claims to pin is not the surface anyone sees.
//
// SO THE REFUSAL IS STRUCTURAL RATHER THAN A WAIT. There is no timer to tune and no
// "settled" heuristic to get wrong: `PendingPaneBody` stamps a marker while its module
// is in flight, `pendingPaneKindsIn` reads it back, and a capture whose tree carries one
// fails by name. A surface that needs its body first awaits it in its own mount helper —
// which is where the knowledge of what that surface is waiting for lives.
//
// AND THE SECOND HALF OF THE SAME FAILURE IS THE WINDOW. A settled surface taller than
// the tester window was photographed to the window's bottom edge and then in the page's
// own background colour for every row beneath it, because a Playwright element
// screenshot is a CLIP in page coordinates and nothing paints an iframe's overflow.
// Every committed
// reference over 900 px carried that: real content to row 899, then pure white to the
// bottom, in the dark scheme too. A regression anywhere below the first window was
// green, and a dimension change was the only thing the tier could see there — which is
// the same false green the pending-body refusal exists to forbid, arriving by a
// different route. `capture-viewport.ts` states the mechanism and the rule; this file
// opens the window, re-runs the refusal on the resized tree, and puts it back.
//
// EVERY CAPTURE, AND NOT MOST. The capture files call this instead of
// `toMatchScreenshot`, so a reference cannot be minted around either check by an author
// who did not know they existed.

import { expect } from "vitest";
import { page } from "vitest/browser";

// The LEAF and not the family door: `pendingPaneKindsIn` has no production reader, so
// `console/seats/index.ts` carries no line for it — a door line only a test reaches is
// what `architecture/barrel-census.test.ts` reports.
import { pendingPaneKindsIn } from "../../../src/renderer/src/console/seats/pending-pane-body.js";
import { settle } from "../../../src/renderer/src/console/core/settle.test-support.js";
import { captureViewportFor, type CaptureViewport } from "./capture-viewport.js";

/**
 * How many times a capture may re-measure and re-open its window before it gives up.
 *
 * Opening a window is a layout change, so a surface whose own height is derived from
 * the window's can answer the first pass with a taller box than the one that was
 * measured. One more pass settles that; a surface still growing after three is chasing
 * its own window, and the refusal says so rather than looping until the run times out.
 */
const CAPTURE_SIZING_PASSES = 3;

/**
 * Refuse a capture whose tree still holds an unloaded pane body.
 *
 * TAKES THE KINDS RATHER THAN THE ELEMENT, which is what makes the refusal itself
 * testable without a browser: the DOM read is `pendingPaneKindsIn`'s and has its own
 * suite beside the marker it reads, and this half is a pure function a node tier can
 * plant a failure into. Fused into one function, the only way to prove the refusal
 * fires would be to mint a real half-loaded capture, which is the thing it exists to
 * prevent.
 *
 * The message names the KINDS and the reference, because a failure that says "something
 * was pending" is a second debugging session and one that says `workflow-run` is a fix.
 */
export function assertNoPendingPaneBodies(
  pendingKinds: readonly string[],
  referenceName: string,
): void {
  if (pendingKinds.length === 0) {
    return;
  }
  throw new Error(
    `Refusing to capture ${referenceName}: ${String(pendingKinds.length)} pane body/bodies ` +
      `had not loaded (${pendingKinds.join(", ")}). Await the body in the mount helper ` +
      `before capturing, or the reference records a pane that was still arriving.`,
  );
}

/**
 * How much window this element's box needs, in the tester's own coordinates.
 *
 * The element's DOCUMENT-space bottom-right corner rather than its size, because the
 * clip Playwright sends is anchored in page coordinates: a surface 964 px tall sitting
 * 348 px down needs 1 312 px of window, and one that needs only its own height is the
 * special case where it starts at the origin. Rounded outward for the same reason
 * Playwright rounds its clip outward — a box that ends on a fraction of a pixel still
 * paints that pixel.
 */
function requiredViewportFor(element: Element): CaptureViewport {
  const box = element.getBoundingClientRect();
  return {
    width: Math.ceil(box.right + window.scrollX),
    height: Math.ceil(box.bottom + window.scrollY),
  };
}

/**
 * The tester window for the length of one capture, and the size it goes back to.
 *
 * A class rather than a pair of functions because the restore is only correct against
 * the size this capture actually started from: reading it back off a module constant
 * would put the window at whatever the tier was configured with rather than at what the
 * previous caller left, and a capture that grew the window and did not put it back
 * hands the next spec a console laid out at 2 050 px.
 */
class CaptureWindow {
  readonly #restoreTo: CaptureViewport;
  #applied: CaptureViewport;
  #grown = false;

  public constructor(startedAt: CaptureViewport) {
    this.#restoreTo = startedAt;
    this.#applied = startedAt;
  }

  /**
   * Open the window until it holds the whole element, or refuse.
   *
   * The settle after each resize is the shared act-wrapped one: a resize is a layout
   * change, so a surface that observes its own box writes state React has to flush
   * before the next measurement means anything.
   */
  public async holdWhole(element: Element, referenceName: string): Promise<void> {
    for (let pass = 0; pass <= CAPTURE_SIZING_PASSES; pass += 1) {
      const required = requiredViewportFor(element);
      const grown = captureViewportFor(this.#applied, required, referenceName);
      if (grown === undefined) {
        return;
      }
      if (pass === CAPTURE_SIZING_PASSES) {
        throw new Error(
          `Refusing to capture ${referenceName}: the surface grew with its window ` +
            `${String(CAPTURE_SIZING_PASSES)} times and still needs ` +
            `${String(required.height)}px in a ${String(this.#applied.height)}px one. A ` +
            `surface sized from the window it is captured in cannot be photographed whole.`,
        );
      }
      await page.viewport(grown.width, grown.height);
      await settle();
      this.#applied = grown;
      this.#grown = true;
    }
  }

  /** Put the window back, and only when this capture is what moved it. */
  public async restore(): Promise<void> {
    if (!this.#grown) {
      return;
    }
    await page.viewport(this.#restoreTo.width, this.#restoreTo.height);
    await settle();
  }
}

/**
 * Capture one element against its committed reference, once it is whole.
 *
 * The order is load-bearing three times over. The refusal runs BEFORE anything else, so
 * a tree that is still loading fails without minting or overwriting a reference — in
 * `--update` mode that is the difference between a run that refuses and a run that
 * quietly commits a picture of a fallback. The window opens BEFORE the capture, so the
 * surface is painted whole rather than clipped at the window's edge. And the refusal
 * runs AGAIN on the resized tree, because a taller window is a different layout: it can
 * bring a deferred body into view, and a check that only ever held on the pre-resize
 * tree would be a check of a surface that was not the one photographed.
 *
 * The restore is in `finally` so a refusal, a mismatch, or a failed comparison all leave
 * the window where the next spec expects it.
 */
export async function captureSettled(element: Element, referenceName: string): Promise<void> {
  assertNoPendingPaneBodies(pendingPaneKindsIn(element), referenceName);
  const captureWindow = new CaptureWindow({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  try {
    await captureWindow.holdWhole(element, referenceName);
    assertNoPendingPaneBodies(pendingPaneKindsIn(element), referenceName);
    await expect(element).toMatchScreenshot(referenceName);
  } finally {
    await captureWindow.restore();
  }
}
