// The options the virtualizer is constructed with, driven one at a time. Each must reach
// machinery this frame owns rather than the platform (an unnamed `scrollTo`, a second scroll
// listener, a second `ResizeObserver` on the same box).

import { describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { createCountingScrollContainer } from "@renderer/lib/scroll/scroll-container.test-support.js";
import { ViewportController } from "./viewport-controller.js";
import type { TranscriptRowVirtualizer } from "./virtualizer-options.js";
import { attachedController } from "./viewport-controller.test-support.js";

/**
 * The instance argument the two observer options ignore; both read the chokepoint, so it is typed
 * rather than constructed.
 */
const UNUSED_VIRTUALIZER = undefined as unknown as TranscriptRowVirtualizer;

describe("the virtualizer options — what the library is allowed to reach", () => {
  it("routes the library's own scroll write through the chokepoint, named", () => {
    // The default `scrollToFn` calls `scrollElement.scrollTo`, which names neither a caller nor
    // an amount: the write the chokepoint exists to prevent.
    const { controller } = attachedController();
    controller.virtualizerOptions.scrollToFn(120, { adjustments: 30 });
    expect(controller.scroll.writeCount("measurement-compensation")).toBe(1);
  });

  it("feeds the library's offset and rect from ONE scroll listener", () => {
    // The library's own offset and rect observers attach their own listener and observer; two
    // sources for one box let two readers disagree about where the reader is.
    const scrollContainer = createCountingScrollContainer();
    const controller = new ViewportController({ clock: new ManualClock() });
    controller.attach(scrollContainer);
    const offsets: number[] = [];
    const heights: number[] = [];
    controller.virtualizerOptions.observeElementOffset(UNUSED_VIRTUALIZER, (offset) =>
      offsets.push(offset),
    );
    controller.virtualizerOptions.observeElementRect(UNUSED_VIRTUALIZER, (rect) =>
      heights.push(rect.height),
    );
    expect(scrollContainer.scrollListenerCount()).toBe(1);
    // Resent on subscribe, so a pane mounted mid-stream knows where it is.
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
    controller.virtualizerOptions.observeElementRect(UNUSED_VIRTUALIZER, (rect) =>
      heights.push(rect.height),
    );

    scrollContainer.resizeTo(260, 4000);
    controller.scroll.requestOverflowMeasurement();
    clock.runFrame();

    expect(heights).toStrictEqual([300, 260]);
  });

  it("a pass over an unchanged box gives it nothing to re-lay-out", () => {
    // Otherwise the case above passes over a seam that republished on every pass, a full
    // re-layout per measurement frame.
    const scrollContainer = createCountingScrollContainer({ clientHeight: 300 });
    const clock = new ManualClock();
    const controller = new ViewportController({ clock });
    controller.attach(scrollContainer);
    const heights: number[] = [];
    controller.virtualizerOptions.observeElementRect(UNUSED_VIRTUALIZER, (rect) =>
      heights.push(rect.height),
    );

    controller.scroll.requestOverflowMeasurement();
    clock.runFrame();

    expect(heights).toStrictEqual([300]);
  });
});
