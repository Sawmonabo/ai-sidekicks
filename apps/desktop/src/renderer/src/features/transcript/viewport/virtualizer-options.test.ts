// The seams the virtualizer is constructed with, driven one at a time. Each must reach
// machinery this frame owns rather than the platform (an unnamed `scrollTo`, a second scroll
// listener, a second `ResizeObserver` on the same box).

import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { createCountingScrollContainer } from "../scroll/scroll-container.test-support.js";
import { SCROLL_CALLERS } from "../scroll/scroll-callers.js";
import { ViewportController } from "./viewport-controller.js";
import type { TranscriptRowVirtualizer } from "./virtualizer-options.js";

/**
 * The instance argument the two observer seams ignore; both read the chokepoint, so it is typed
 * rather than constructed.
 */
const UNUSED_VIRTUALIZER = undefined as unknown as TranscriptRowVirtualizer;

/** A controller holding a real detached element, the way a mounted pane does. */
function attachedController(): { controller: ViewportController } {
  const controller = new ViewportController({ clock: new ManualClock() });
  controller.attach(document.createElement("div"));
  return { controller };
}

describe("the virtualizer seams — what the library is allowed to reach", () => {
  it("routes the library's own scroll write through the chokepoint, named", () => {
    // The default `scrollToFn` calls `scrollElement.scrollTo`, which names neither a caller nor
    // an amount: the write the chokepoint exists to prevent.
    const { controller } = attachedController();
    controller.seams.scrollToFn(120, { adjustments: 30 });
    expect(controller.scroll.writeCount("measurement-compensation")).toBe(1);
  });

  it("negative control: no other caller was charged for that write", () => {
    const { controller } = attachedController();
    controller.seams.scrollToFn(120, {});
    for (const caller of SCROLL_CALLERS) {
      expect(controller.scroll.writeCount(caller)).toBe(
        caller === "measurement-compensation" ? 1 : 0,
      );
    }
  });

  it("feeds the library's offset and rect from ONE scroll listener", () => {
    // The library's own offset and rect observers attach their own listener and observer; two
    // sources for one box let two readers disagree about where the reader is.
    const scrollContainer = createCountingScrollContainer();
    const controller = new ViewportController({ clock: new ManualClock() });
    controller.attach(scrollContainer);
    const offsets: number[] = [];
    const heights: number[] = [];
    controller.seams.observeElementOffset(UNUSED_VIRTUALIZER, (offset) => offsets.push(offset));
    controller.seams.observeElementRect(UNUSED_VIRTUALIZER, (rect) => heights.push(rect.height));
    expect(scrollContainer.scrollListenerCount).toBe(1);
    // Replayed on subscribe, so a pane mounted mid-stream knows where it is.
    expect(offsets).toStrictEqual([40]);
    expect(heights).toStrictEqual([300]);
  });

  it("gives the library a new viewport rect when the box changes without a scroll", () => {
    // The library's own rect observer runs a `ResizeObserver`; this frame replaces it, so a
    // resize reaches the virtualizer through this subscription or not at all.
    const scrollContainer = createCountingScrollContainer({ clientHeight: 300 });
    const clock = new ManualClock();
    const controller = new ViewportController({ clock });
    controller.attach(scrollContainer);
    const heights: number[] = [];
    controller.seams.observeElementRect(UNUSED_VIRTUALIZER, (rect) => heights.push(rect.height));

    scrollContainer.resizeTo(260, 4000);
    controller.scroll.requestOverflowMeasurement();
    clock.runFrame();

    expect(heights).toStrictEqual([300, 260]);
  });

  it("negative control: a pass over an unchanged box gives it nothing to re-lay-out", () => {
    // Otherwise the case above passes over a seam that republished on every pass, a full
    // re-layout per measurement frame.
    const scrollContainer = createCountingScrollContainer({ clientHeight: 300 });
    const clock = new ManualClock();
    const controller = new ViewportController({ clock });
    controller.attach(scrollContainer);
    const heights: number[] = [];
    controller.seams.observeElementRect(UNUSED_VIRTUALIZER, (rect) => heights.push(rect.height));

    controller.scroll.requestOverflowMeasurement();
    clock.runFrame();

    expect(heights).toStrictEqual([300]);
  });

  it("drops the library's measurements when the display changes under them", () => {
    const { controller } = attachedController();
    controller.measurements.acceptedHeight("row-0", 240);
    controller.observeDisplaySettings(2, 16);
    controller.observeDisplaySettings(2, 18);
    expect(controller.measurements.measuredRowCount).toBe(0);
  });

  it("negative control: an unchanged display leaves them alone", () => {
    const { controller } = attachedController();
    controller.observeDisplaySettings(2, 16);
    controller.measurements.acceptedHeight("row-0", 240);
    controller.observeDisplaySettings(2, 16);
    expect(controller.measurements.measuredRowCount).toBe(1);
  });
});
