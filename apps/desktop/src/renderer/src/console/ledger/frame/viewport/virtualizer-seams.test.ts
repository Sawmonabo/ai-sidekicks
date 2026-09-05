// The seams the adopted virtualizer is constructed with, driven one at a time.
//
// Each case is the same claim in a different place: the library reaches machinery
// this frame already owns, rather than the platform. What the library's DEFAULT
// would have done is what makes each one worth asserting — an unnamed `scrollTo`, a
// second scroll listener, a second `ResizeObserver` on the same box.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../../core/index.js";
import { countingSurface } from "../scroll/scroll-surface.test-support.js";
import { LEDGER_SCROLL_CALLERS } from "../scroll/scroll-chokepoint.js";
import { LedgerViewportController } from "./viewport-controller.js";
import type { LedgerRowVirtualizer } from "./virtualizer-seams.js";

/**
 * The instance argument the two observer seams ignore.
 *
 * Both read the chokepoint rather than the virtualizer — which is the property under
 * test — so the parameter is unused and typed rather than constructed.
 */
const UNUSED_VIRTUALIZER = undefined as unknown as LedgerRowVirtualizer;

/** A controller holding a real detached element, the way a mounted pane does. */
function attachedController(): { controller: LedgerViewportController } {
  const controller = new LedgerViewportController({ clock: new ManualClock() });
  controller.attach(document.createElement("div"));
  return { controller };
}

describe("the virtualizer seams — what the library is allowed to reach", () => {
  it("routes the library's own scroll write through the chokepoint, named", () => {
    // `Spec-023 §Console Libraries` adopts this library because its scroller is ours.
    // The default `scrollToFn` calls `scrollElement.scrollTo`, which names neither a
    // caller nor an amount — exactly the write the chokepoint exists to prevent.
    const { controller } = attachedController();
    controller.seams.scrollToFn(120, { adjustments: 30 });
    expect(controller.scroll.writeCount("measurement-compensation")).toBe(1);
  });

  it("negative control: no other caller was charged for that write", () => {
    const { controller } = attachedController();
    controller.seams.scrollToFn(120, {});
    for (const caller of LEDGER_SCROLL_CALLERS) {
      expect(controller.scroll.writeCount(caller)).toBe(
        caller === "measurement-compensation" ? 1 : 0,
      );
    }
  });

  it("feeds the library's offset and rect from ONE scroll listener", () => {
    // The library's own `observeElementOffset` and `observeElementRect` each attach
    // their own listener and observer. Two sources for one box is how two surfaces
    // start disagreeing about where the reader is standing.
    const surface = countingSurface();
    const controller = new LedgerViewportController({ clock: new ManualClock() });
    controller.attach(surface);
    const offsets: number[] = [];
    const heights: number[] = [];
    controller.seams.observeElementOffset(UNUSED_VIRTUALIZER, (offset) => offsets.push(offset));
    controller.seams.observeElementRect(UNUSED_VIRTUALIZER, (rect) => heights.push(rect.height));
    expect(surface.scrollListenerCount).toBe(1);
    // Replayed on subscribe, so a pane mounted mid-stream knows where it is.
    expect(offsets).toStrictEqual([40]);
    expect(heights).toStrictEqual([300]);
  });

  it("gives the library a new viewport rect when the box changes without a scroll", () => {
    // The library's own `observeElementRect` runs a `ResizeObserver`; this frame
    // replaces it, so the height a resize produces reaches the virtualizer through
    // this subscription or through nothing at all.
    const surface = countingSurface({ clientHeight: 300 });
    const clock = new ManualClock();
    const controller = new LedgerViewportController({ clock });
    controller.attach(surface);
    const heights: number[] = [];
    controller.seams.observeElementRect(UNUSED_VIRTUALIZER, (rect) => heights.push(rect.height));

    surface.resizeTo(260, 4000);
    controller.scroll.requestOverflowMeasurement();
    clock.runFrame();

    expect(heights).toStrictEqual([300, 260]);
  });

  it("negative control: a pass over an unchanged box gives it nothing to re-lay-out", () => {
    // Otherwise the case above would pass over a seam that republished on every
    // pass, which is a full re-layout of the window per measurement frame.
    const surface = countingSurface({ clientHeight: 300 });
    const clock = new ManualClock();
    const controller = new LedgerViewportController({ clock });
    controller.attach(surface);
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
