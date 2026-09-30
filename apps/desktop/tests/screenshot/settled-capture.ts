// The one call every screenshot capture goes through, the settle it refuses, and the window it
// opens so the whole element is in the image. Capture files call `captureSettled` instead of
// `toMatchScreenshot`, so an image cannot be written around either check (`eslint.config.mjs`).
//
// A capture can be wrong without being red: before a loader-backed pane body lands, the pane is
// its own chrome alone, and photographing it records a half-built element. So the refusal is
// structural, not a wait: `PendingPaneBody` stamps a marker while its module is in flight,
// `listPendingBodyNames` reads it back, and a capture whose tree carries one fails by name. An
// element that needs its body awaits it in its own mount helper.
//
// The window is the second half: an element taller than the tester window was photographed to
// the window's edge and then page background, since a Playwright clip paints nothing beyond an
// iframe. `capture-viewport.ts` states the mechanism; this file opens the window, re-runs the
// refusal on the resized tree and puts the window back (`tall-capture.test.ts` drives it).

import { expect } from "vitest";
import { page } from "vitest/browser";

// Imported from the declaring module: `listPendingBodyNames` has no production reader, so no
// other module passes it on.
import { listPendingBodyNames } from "@renderer/components/LazyBody/pending-body-marker.js";
import { settle } from "../helpers/settle.js";
import { captureWindowStep, stabilityWaitMsFor, type CaptureViewport } from "./capture-viewport.js";

/**
 * How many times a capture may re-measure and re-open its window before it refuses. Opening a
 * window is a layout change, so an element can answer the first grow with a taller box (a
 * deferred image lands, a container reflows) and settle on the second. An element sized by its
 * window spends two passes being confirmed (see `CONFIRMING_NON_CLOSING_PASSES`); the rest bounds
 * an element that keeps closing the gap a little each pass, which would otherwise resize the
 * console hundreds of times.
 */
const CAPTURE_SIZING_PASSES = 4;

/**
 * The two acts a sizing pass performs on the tester window. A port so the failure ordering in
 * `CaptureWindow` can be driven: the window must go back even when the settle after a resize
 * rejects, a state no capture produces on demand.
 */
export interface CaptureWindowDriver {
  /** Move the tester window, and resolve once Vitest has applied the size. */
  resize(viewport: CaptureViewport): Promise<void>;
  /** Let the element answer the move, inside `act`. */
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
 * Refuses a capture whose tree still holds an unloaded pane body. It takes the kinds, not the
 * element, so the refusal is a pure function a node tier can plant a failure into; the DOM read
 * is `listPendingBodyNames`'s, with its own suite. The message names the kinds and the capture.
 */
export function assertNoPendingPaneBodies(
  pendingKinds: readonly string[],
  captureName: string,
): void {
  if (pendingKinds.length === 0) {
    return;
  }
  throw new Error(
    `Refusing to capture ${captureName}: ${String(pendingKinds.length)} pane body/bodies ` +
      `had not loaded (${pendingKinds.join(", ")}). Await the body in the mount helper ` +
      `before capturing, or the image records a pane that was still arriving.`,
  );
}

/**
 * How much window this element's box needs, in the tester's coordinates. It uses the
 * document-space bottom-right corner, since the clip Playwright sends is anchored in page
 * coordinates (a 964 px element 348 px down needs 1 312 px). Rounded outward because a box
 * ending on a fraction of a pixel still paints that pixel.
 */
function requiredViewportFor(element: Element): CaptureViewport {
  const box = element.getBoundingClientRect();
  return {
    width: Math.ceil(box.right + window.scrollX),
    height: Math.ceil(box.bottom + window.scrollY),
  };
}

/**
 * The tester window for the length of one capture, and the size it goes back to. The restore
 * targets the size this capture started from, not a module constant, so a capture that grew the
 * window does not hand the next spec a console laid out at 2 050 px.
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
   * Opens the window until it holds the whole element, or stops when no window would. The settle
   * after each resize is the shared act-wrapped one, since a resize is a layout change that an
   * element observing its own box answers with state React must flush. The
   * `grows-with-its-window` arm puts the window back before returning: both windows leave the
   * same overhang unpainted, so the larger one buys nothing and costs an image at a size no other
   * capture uses.
   */
  public async holdWhole(element: Element, captureName: string): Promise<void> {
    const overhangsPx: number[] = [];
    for (let pass = 0; pass <= CAPTURE_SIZING_PASSES; pass += 1) {
      const required = requiredViewportFor(element);
      const step = captureWindowStep(this.#applied, required, overhangsPx, captureName);
      if (step.kind === "fits") {
        return;
      }
      if (step.kind === "grows-with-its-window") {
        await this.restore();
        return;
      }
      if (pass === CAPTURE_SIZING_PASSES) {
        throw new Error(
          `Refusing to capture ${captureName}: the window was opened ` +
            `${String(CAPTURE_SIZING_PASSES)} times and the element still needs ` +
            `${String(required.height)}px in a ${String(this.#applied.height)}px one. It is ` +
            `closing the gap rather than fitting or tracking the window, and a capture ` +
            `cannot decide which size an element like that is meant to be photographed at.`,
        );
      }
      overhangsPx.push(step.overhangPx);
      await this.#moveTo(step.viewport);
    }
  }

  /**
   * How many of the window this capture started in fit in the one it holds now: an area ratio,
   * because capture cost is pixels and a window that grew only in height still pays its full
   * width per row. Exactly `1` for a capture that fitted and for one that took the
   * `grows-with-its-window` arm. The caller reads this instead of re-measuring, and
   * `stabilityWaitMsFor` decides what it costs.
   */
  public get heldViewportRatio(): number {
    return (
      (this.#applied.width * this.#applied.height) /
      (this.#restoreTo.width * this.#restoreTo.height)
    );
  }

  /**
   * Puts the window back, only when this capture moved it. It runs twice on the
   * `grows-with-its-window` path (from `holdWhole` and from `captureSettled`'s `finally`); the
   * second is a no-op only because the first finished, and a restore whose settle rejects leaves
   * the flag standing so the outer call retries.
   */
  public async restore(): Promise<void> {
    if (!this.#movedTheWindow) {
      return;
    }
    await this.#moveTo(this.#restoreTo);
    this.#movedTheWindow = false;
  }

  /**
   * Moves the window, recording the move before anything that can fail. `#movedTheWindow` gates
   * `restore`, so it is raised ahead of the resize: raised after the settle, a rejecting settle
   * would leave the window open with `restore` returning early, and every later capture in the
   * run would lay out in an enlarged console. Raised early costs one redundant resize; a resize
   * that throws part-way has no defined size either.
   */
  async #moveTo(viewport: CaptureViewport): Promise<void> {
    this.#movedTheWindow = true;
    this.#applied = viewport;
    await this.#driver.resize(viewport);
    await this.#driver.settle();
  }
}

/**
 * Writes one element's capture into `__screenshots__` once it is whole. The order matters: the
 * refusal runs first, so a loading tree fails without overwriting a good picture with a
 * fallback; the window opens before the capture, so the element is painted whole; and the
 * refusal runs again on the resized tree, since a taller window is a different layout that can
 * bring a deferred body into view. The restore is in `finally` so a refusal or a failed capture
 * leaves the window where the next spec expects it.
 *
 * The matcher is the writer, not a gate: the tier runs in the `all` snapshot-update mode, where
 * `toMatchScreenshot` writes the image and passes. Its stability retry is what survives, since an
 * image taken while the page is still painting is a bad picture for a person too. The stability
 * wait is sized to what the window ended up holding, so it is passed per call and not configured
 * on the project (see `capture-viewport.ts`).
 */
export async function captureSettled(element: Element, captureName: string): Promise<void> {
  assertNoPendingPaneBodies(listPendingBodyNames(element), captureName);
  const captureWindow = new CaptureWindow({
    width: window.innerWidth,
    height: window.innerHeight,
  });
  try {
    await captureWindow.holdWhole(element, captureName);
    assertNoPendingPaneBodies(listPendingBodyNames(element), captureName);
    await expect(element).toMatchScreenshot(captureName, {
      timeout: stabilityWaitMsFor(captureWindow.heldViewportRatio),
    });
  } finally {
    await captureWindow.restore();
  }
}
