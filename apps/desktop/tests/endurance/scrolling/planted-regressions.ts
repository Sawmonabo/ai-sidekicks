// What a scrolling budget's negative control plants in the window before its gesture, so the
// reading is shown to cross the ceiling it exists to catch. Shared by the conversation's and the
// other scrollers' budgets, which plant the same regressions over different scrollers.

import type { Locator } from "playwright";

/**
 * What a negative control adds before its gesture: a wheel handler that holds the main thread on
 * every turn, added as one that may cancel the scroll so the browser waits for it; see-through
 * layers over the scroller, each blurring what is behind it, which the display redraws on every
 * frame the content moves; or the rounded clip a pane once cut its corners with.
 */
export type Plant =
  | { readonly kind: "held-wheel"; readonly holdMs: number }
  | { readonly kind: "blurring-layers"; readonly layerCount: number }
  | { readonly kind: "rounded-pane-clip" };

/** Blurring layers stacked over a scroller: more drawing than one refresh holds. */
export const BLURRING_LAYER_COUNT = 48;

/** Adds what a negative control plants to the scroller, over it, or to its window's sheets. */
export async function plant(scroller: Locator, planted: Plant): Promise<void> {
  if (planted.kind === "held-wheel") {
    await scroller.evaluate((element, holdMs) => {
      element.addEventListener(
        "wheel",
        () => {
          const holdUntil = performance.now() + holdMs;
          while (performance.now() < holdUntil) {
            /* hold the main thread, the way a handler over its budget does */
          }
        },
        { passive: false },
      );
    }, planted.holdMs);
    return;
  }
  if (planted.kind === "rounded-pane-clip") {
    await scroller.evaluate((element) => {
      // The pane keeps its corner radius, so clipping its overflow clips to the rounded corners.
      const sheet = element.ownerDocument.createElement("style");
      sheet.textContent = ".meridian-pane { overflow: hidden !important; }";
      element.ownerDocument.head.append(sheet);
    });
    return;
  }
  await scroller.evaluate((element, layerCount) => {
    const box = element.getBoundingClientRect();
    for (let index = 0; index < layerCount; index += 1) {
      const layer = document.createElement("div");
      Object.assign(layer.style, {
        position: "fixed",
        left: `${String(box.left)}px`,
        top: `${String(box.top)}px`,
        width: `${String(box.width)}px`,
        height: `${String(box.height)}px`,
        zIndex: "2147483647",
        // Through to the scroller, so the gesture still lands on it.
        pointerEvents: "none",
        // A radius of its own, so no layer is drawn as a copy of another.
        backdropFilter: `blur(${String(8 + index)}px)`,
      });
      document.body.append(layer);
    }
  }, planted.layerCount);
}
