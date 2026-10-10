// Rows, calm reconcile conditions, an attached controller and the layout stub shared by the
// viewport's suites, so their claims stay about the same reconcile and the same box.

import { vi } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import {
  createCountingScrollContainer,
  type CountingScrollContainer,
} from "#renderer/lib/scroll/container.test-support.js";
import type { ViewportRow } from "./snapshot.js";
import { ViewportController } from "./controller.js";

/** `count` rows, optionally all under one run group. */
export function syntheticRows(count: number, runGroupKey?: string): readonly ViewportRow[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `${runGroupKey ?? "row"}-${String(index)}`,
    parentKey: runGroupKey,
    rootCursor: `cursor-${String(index)}`,
  }));
}

/** Reconcile conditions with no row still changing. */
export const CALM: { isChangingRow: (rowKey: string) => boolean } = {
  isChangingRow: () => false,
};

/**
 * A box at its tail attached to `controller`, which the reader then scrolls up to `offsetPx`: a
 * transcript opens following, and only the reader's own scroll toward the head reads instead.
 */
export function attachReaderAt(
  controller: ViewportController,
  box: { readonly offsetPx: number; readonly clientHeight: number; readonly scrollHeight: number },
): CountingScrollContainer {
  const scrollContainer = createCountingScrollContainer({
    initialScrollTop: box.scrollHeight - box.clientHeight,
    clientHeight: box.clientHeight,
    scrollHeight: box.scrollHeight,
  });
  controller.attach(scrollContainer);
  scrollContainer.moveTo(box.offsetPx);
  return scrollContainer;
}

/** A controller attached to a detached element, with the clock its cases advance. */
export function attachedController(): {
  controller: ViewportController;
  clock: ManualClock;
} {
  const clock = new ManualClock();
  const controller = new ViewportController({ clock });
  controller.attach(document.createElement("div"));
  return { controller, clock };
}

/** The box height the laid-out viewport reports. */
const LAID_OUT_VIEWPORT_HEIGHT_PX = 400;

/** The content height the laid-out viewport reports, taller than the box. */
const LAID_OUT_CONTENT_HEIGHT_PX = 10_000;

/**
 * Give every element a laid-out box for one case: `happy-dom` reports zero, and the virtualizer
 * treats a zero outer size as no range at all. `content` says how tall the scroll content reads:
 * `"tall"` (the default) taller than the box from the first read, because the chokepoint clamps
 * every write to `scrollHeight - clientHeight`; `"laid-out"` the sizer's height as the library
 * writes it, so a transcript opens at its tail as it does in the app; `"none"` no taller than the
 * box.
 */
export function withLaidOutViewport(
  options: { readonly content?: "tall" | "laid-out" | "none" } = {},
): void {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(
    LAID_OUT_VIEWPORT_HEIGHT_PX,
  );
  const content = options.content ?? "tall";
  if (content === "tall") {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      LAID_OUT_CONTENT_HEIGHT_PX,
    );
  }
  if (content === "laid-out") {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      // The sizer, beside the history line the box also holds, which lays out at no height here.
      const sizer = this.querySelector(":scope > .meridian-transcript-viewport__sizer");
      const sizedHeightPx =
        sizer instanceof HTMLElement ? Number.parseFloat(sizer.style.height) : 0;
      return Math.max(LAID_OUT_VIEWPORT_HEIGHT_PX, Number.isNaN(sizedHeightPx) ? 0 : sizedHeightPx);
    });
  }
}
