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
// ONE SHAPE OF SURFACE STOPS THE GROWING RATHER THAN SATISFYING IT. A destination
// sized from the window is one window tall plus its own padding at every window, so
// the loop below recognises that — on the SECOND pass after the first, having grown
// once more to tell it apart from a surface that reflowed while the first window was
// opening — puts the window back, and photographs it at the tier's own size. The
// reason and its consequence are `capture-viewport.ts`'s to state, and
// `tall-capture.test.ts` drives both.
//
// EVERY CAPTURE, AND NOT MOST. The capture files call this instead of
// `toMatchScreenshot`, so a reference cannot be minted around either check by an author
// who did not know they existed.

import { expect } from "vitest";
import { page } from "vitest/browser";

// The LEAF and not the family door: `pendingPaneKindsIn` has no production reader, so
// `console/seats/index.ts` carries no line for it — a door line only a test reaches is
// what `architecture/barrel-census.test.ts` reports.
import { pendingPaneKindsIn } from "../../../src/renderer/src/console/seats/pane/pending-pane-body.js";
import { settle } from "../../../src/renderer/src/console/core/settle.test-support.js";
import { captureWindowStep, stabilityWaitMsFor, type CaptureViewport } from "./capture-viewport.js";

/**
 * How many times a capture may re-measure and re-open its window before it refuses.
 *
 * Opening a window is a layout change, so a surface can answer the first grow with a
 * taller box than the one that was measured — a deferred image lands, a container
 * reflows — and settle on the second. A surface sized BY its window is recognised on
 * the second pass after the first and spends two of these on being confirmed, for the
 * reason `CONFIRMING_NON_CLOSING_PASSES` states; what the rest of the budget bounds is
 * the surface that keeps closing the gap by a little each pass, which would otherwise
 * resize the console hundreds of times before reaching the ceiling.
 */
const CAPTURE_SIZING_PASSES = 4;

/**
 * The two acts a sizing pass performs on the tester window.
 *
 * A PORT, because the ordering in `CaptureWindow` below is a claim about a FAILURE:
 * the window has to go back even when the settle after a resize rejects, and a settle
 * rejects on a state no capture can produce on demand — an effect throwing while React
 * flushes the layout the resize caused. Injected, that case is a few lines in a suite
 * and the real class is what runs; left implicit, it is a defect nothing can drive,
 * which is how it shipped.
 */
export interface CaptureWindowDriver {
  /** Move the tester window, and resolve once Vitest has applied the size. */
  resize(viewport: CaptureViewport): Promise<void>;
  /** Let the surface answer the move, inside `act`. */
  settle(): Promise<void>;
}

/** The real window: Vitest's own viewport command and the shared act-wrapped settle. */
class TesterWindowDriver implements CaptureWindowDriver {
  public async resize(viewport: CaptureViewport): Promise<void> {
    await page.viewport(viewport.width, viewport.height);
  }

  public async settle(): Promise<void> {
    await settle();
  }
}

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
export class CaptureWindow {
  readonly #restoreTo: CaptureViewport;
  readonly #driver: CaptureWindowDriver;
  #applied: CaptureViewport;
  #movedTheWindow = false;

  public constructor(
    startedAt: CaptureViewport,
    driver: CaptureWindowDriver = new TesterWindowDriver(),
  ) {
    this.#restoreTo = startedAt;
    this.#applied = startedAt;
    this.#driver = driver;
  }

  /**
   * Open the window until it holds the whole element, or stop when no window would.
   *
   * The settle after each resize is the shared act-wrapped one: a resize is a layout
   * change, so a surface that observes its own box writes state React has to flush
   * before the next measurement means anything.
   *
   * The `grows-with-its-window` arm PUTS THE WINDOW BACK before returning rather than
   * capturing at whatever size the loop reached. Both windows leave the same overhang
   * unpainted, so the larger one buys nothing and costs a reference minted at a size
   * no other capture in the tier uses.
   */
  public async holdWhole(element: Element, referenceName: string): Promise<void> {
    const overhangsPx: number[] = [];
    for (let pass = 0; pass <= CAPTURE_SIZING_PASSES; pass += 1) {
      const required = requiredViewportFor(element);
      const step = captureWindowStep(this.#applied, required, overhangsPx, referenceName);
      if (step.kind === "fits") {
        return;
      }
      if (step.kind === "grows-with-its-window") {
        await this.restore();
        return;
      }
      if (pass === CAPTURE_SIZING_PASSES) {
        throw new Error(
          `Refusing to capture ${referenceName}: the window was opened ` +
            `${String(CAPTURE_SIZING_PASSES)} times and the surface still needs ` +
            `${String(required.height)}px in a ${String(this.#applied.height)}px one. It is ` +
            `closing the gap rather than fitting or tracking the window, and a capture ` +
            `cannot decide which size a surface like that is meant to be photographed at.`,
        );
      }
      overhangsPx.push(step.overhangPx);
      await this.#moveTo(step.viewport);
    }
  }

  /**
   * How many of the window this capture started in fit in the one it is holding now.
   *
   * An AREA ratio over the two sizes this class already knows — the one it was
   * constructed with and the one `holdWhole` left applied — because what a capture
   * costs is pixels, and a window that grew only in height still pays its full width
   * for every row it gained. Exactly `1` for a capture that fitted, and exactly `1`
   * for one that took the `grows-with-its-window` arm, which puts the window back
   * before it returns; both are photographed at the size the tier configures.
   *
   * Reported rather than re-measured by the caller. The sizes are this class's, and
   * two derivations of one quantity is the drift `apps/desktop/AGENTS.md` §Shared code
   * forbids on the two sides of a seam — the caller reads what was held and
   * `stabilityWaitMsFor` decides what holding it costs.
   */
  public get heldViewportRatio(): number {
    return (
      (this.#applied.width * this.#applied.height) /
      (this.#restoreTo.width * this.#restoreTo.height)
    );
  }

  /**
   * Put the window back, and only when this capture is what moved it.
   *
   * Called twice on the `grows-with-its-window` path — once by `holdWhole` before it
   * returns and once by `captureSettled`'s `finally` — and the second call is a no-op
   * only because the first one finished. A restore whose settle rejects leaves the
   * flag standing, so the outer call retries the move rather than trusting a window
   * nothing confirmed.
   */
  public async restore(): Promise<void> {
    if (!this.#movedTheWindow) {
      return;
    }
    await this.#moveTo(this.#restoreTo);
    this.#movedTheWindow = false;
  }

  /**
   * Move the window, recorded as moved BEFORE anything that can fail.
   *
   * `#movedTheWindow` is what `restore` is gated on, and it is raised ahead of the
   * resize rather than after the settle that follows it. Written afterwards — which is
   * how this shipped — a settle that rejects leaves the window open, the flag false,
   * and `restore` returning early, so every later capture in the run is taken in a
   * console the previous one enlarged and every reference after it pins a surface laid
   * out at a size no reference was minted under. A flag raised too early costs one
   * redundant resize of a window that may never have moved; a flag raised too late
   * costs the rest of the run, and a resize that throws part-way has no defined size
   * either, so the early write covers that arm as well.
   */
  async #moveTo(viewport: CaptureViewport): Promise<void> {
    this.#movedTheWindow = true;
    this.#applied = viewport;
    await this.#driver.resize(viewport);
    await this.#driver.settle();
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
 *
 * AND THE STABILITY WAIT IS SIZED TO WHAT THE WINDOW ENDED UP HOLDING, which is why it
 * is passed here and not configured on the project: the matcher's per-call options win
 * over the project's under its own merge, and a capture's size is not known until
 * `holdWhole` has run. `capture-viewport.ts` states the rule and owns the number.
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
    await expect(element).toMatchScreenshot(referenceName, {
      timeout: stabilityWaitMsFor(captureWindow.heldViewportRatio),
    });
  } finally {
    await captureWindow.restore();
  }
}
