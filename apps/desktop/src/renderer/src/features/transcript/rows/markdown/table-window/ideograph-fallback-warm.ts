// The platform's fallback face for ideographs, opened in idle time before a long table needs it.
// Every long table's type sample rows draw an ideograph, and the first one a window draws opens
// the fallback face, measured at 7.6 ms; drawn first inside a press, that cost lands in the press.
// Measuring the ideograph on a canvas in the body's font opens the same face, once per window, in
// an idle task of its own.

import { getWindow } from "@floating-ui/utils/dom";

import { TABLE_SAMPLE_IDEOGRAPH } from "#renderer/components/Markdown/table-offer.js";

/**
 * How long the warm-up waits for the window to idle before it runs anyway, in milliseconds: a
 * window drawing frame after frame may grant no idle time at all.
 */
const IDLE_WAIT_MS = 50;

/**
 * Opens the ideograph fallback for `body`'s font in an idle task of its window, the first time a
 * body of that window asks. A window that grants no idle callback warms nothing, and the face
 * opens when first drawn. Throws, in the idle task, where no canvas can measure.
 */
export function warmIdeographFallback(body: Element): void {
  const view = getWindow(body);
  const requestIdleCallback = view.requestIdleCallback as Window["requestIdleCallback"] | undefined;
  if (requestIdleCallback === undefined || !warmedWindows.markWarmed(view)) {
    return;
  }
  requestIdleCallback.call(
    view,
    () => {
      const context = new OffscreenCanvas(1, 1).getContext("2d");
      if (context === null) {
        throw new Error("An offscreen canvas gave no 2D context.");
      }
      const style = view.getComputedStyle(body);
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      context.measureText(TABLE_SAMPLE_IDEOGRAPH);
    },
    { timeout: IDLE_WAIT_MS },
  );
}

/** The windows whose ideograph fallback is opened or about to be, held weakly. */
class WarmedWindows {
  readonly #windows = new WeakSet<Window>();

  /** Marks `view` warmed, answering whether it was not yet. */
  public markWarmed(view: Window): boolean {
    if (this.#windows.has(view)) {
      return false;
    }
    this.#windows.add(view);
    return true;
  }
}

const warmedWindows = new WarmedWindows();
