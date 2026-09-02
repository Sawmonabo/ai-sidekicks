// Rect discipline: reads in the callback, writes on the next frame.
//
// The first case is the one that matters and it is written as a NEGATIVE CONTROL
// in the strict sense: it drives the real tracker on a frozen clock and asserts
// that nothing was written at the moment the observer fired. A tracker that wrote
// synchronously would satisfy every other assertion in this file and would still
// be the `ResizeObserver` loop `Spec-023 §Console Design (Meridian)` §4.2 forbids.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import {
  AirspaceRegistry,
  NATIVE_VIEW_MINIMUM_VISIBLE_PX,
  PaneRectTracker,
  rectKey,
  type TrackedRect,
} from "./rect-discipline.js";

/** An element whose rect is whatever the test says it is. */
function elementMeasuring(box: { width: number; height: number; x?: number; y?: number }): Element {
  return {
    getBoundingClientRect: () => ({
      x: box.x ?? 0,
      y: box.y ?? 0,
      width: box.width,
      height: box.height,
    }),
  } as unknown as Element;
}

interface TrackerHarness {
  readonly clock: ManualClock;
  readonly tracker: PaneRectTracker;
  readonly writes: TrackedRect[][];
}

function harness(airspace?: AirspaceRegistry): TrackerHarness {
  const clock = new ManualClock();
  const writes: TrackedRect[][] = [];
  const tracker = new PaneRectTracker({
    clock,
    onFlush: (rects) => {
      writes.push([...rects]);
    },
    ...(airspace === undefined ? {} : { airspace }),
  });
  return { clock, tracker, writes };
}

describe("PaneRectTracker — when it writes", () => {
  it("writes nothing at the moment a source fires, and writes on the next frame", () => {
    const { clock, tracker, writes } = harness();
    tracker.track("pane-1", elementMeasuring({ width: 400, height: 300 }));

    // `track` invalidates, which is the layout-mover source. Nothing may have been
    // written yet: mutating layout from inside a measurement re-enters the observer.
    expect(writes).toStrictEqual([]);
    expect(clock.pendingFrameCount).toBe(1);

    clock.runFrame();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]?.paneId).toBe("pane-1");
  });

  it("collapses four sources firing for one moved edge into one write", () => {
    const { clock, tracker, writes } = harness();
    tracker.track("pane-1", elementMeasuring({ width: 400, height: 300 }));
    tracker.invalidate("host-resize");
    tracker.invalidate("window-resize");
    tracker.invalidate("ancestor-scroll");
    tracker.invalidate("layout-mover");

    clock.runFrame();

    expect(writes).toHaveLength(1);
    expect(tracker.flushCount).toBe(1);
    expect(tracker.invalidationCount("window-resize")).toBe(1);
    expect(tracker.invalidationCount("ancestor-scroll")).toBe(1);
  });

  it("negative control: a rect that did not change produces no second write", () => {
    // Without the dedupe the case above would still pass — four invalidations that
    // each armed the same frame collapse by arming alone. This is the assertion
    // that the composed key is doing work.
    const { clock, tracker, writes } = harness();
    tracker.track("pane-1", elementMeasuring({ width: 400, height: 300 }));
    clock.runFrame();
    tracker.invalidate("window-resize");
    clock.runFrame();

    expect(writes).toHaveLength(1);
  });

  it("negative control: a rect that DID change produces a second write", () => {
    const { clock, tracker, writes } = harness();
    tracker.track("pane-1", elementMeasuring({ width: 400, height: 300 }));
    clock.runFrame();
    tracker.track("pane-1", elementMeasuring({ width: 401, height: 300 }));
    clock.runFrame();

    expect(writes).toHaveLength(2);
  });

  it("arms nothing once disposed, so no timer outlives the surface", () => {
    const { clock, tracker, writes } = harness();
    tracker.track("pane-1", elementMeasuring({ width: 400, height: 300 }));
    tracker.dispose();
    tracker.invalidate("window-resize");

    expect(clock.pendingCount).toBe(0);
    clock.runFrame();
    expect(writes).toStrictEqual([]);
  });
});

describe("PaneRectTracker — what it reports as visible", () => {
  it("hides a native view whose visible clip is below one pixel in either dimension", () => {
    const { clock, tracker, writes } = harness();
    tracker.track(
      "pane-1",
      elementMeasuring({ width: 400, height: NATIVE_VIEW_MINIMUM_VISIBLE_PX - 0.5 }),
    );
    clock.runFrame();
    expect(writes[0]?.[0]?.isVisible).toBe(false);
  });

  it("negative control: a pane at the floor in both dimensions is visible", () => {
    const { clock, tracker, writes } = harness();
    tracker.track(
      "pane-1",
      elementMeasuring({
        width: NATIVE_VIEW_MINIMUM_VISIBLE_PX,
        height: NATIVE_VIEW_MINIMUM_VISIBLE_PX,
      }),
    );
    clock.runFrame();
    expect(writes[0]?.[0]?.isVisible).toBe(true);
  });

  it("yields the airspace while an overlay is up, and takes it back when it closes", () => {
    const airspace = new AirspaceRegistry();
    const { clock, tracker, writes } = harness(airspace);
    const release = airspace.claim("dialog-1");
    tracker.track("pane-1", elementMeasuring({ width: 400, height: 300 }));
    clock.runFrame();
    expect(writes[0]?.[0]?.isVisible).toBe(false);

    release();
    tracker.invalidate("layout-mover");
    clock.runFrame();
    expect(writes[1]?.[0]?.isVisible).toBe(true);
  });

  it("negative control: two overlays, and the first to close does not free the airspace", () => {
    const airspace = new AirspaceRegistry();
    const releaseFirst = airspace.claim("dialog-1");
    airspace.claim("toast-1");
    releaseFirst();
    expect(airspace.isOccupied).toBe(true);
  });
});

describe("rectKey", () => {
  it("ignores a sub-pixel difference no one can see", () => {
    const base: TrackedRect = {
      paneId: "pane-1",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      isVisible: true,
    };
    expect(rectKey({ ...base, width: 400.2 })).toBe(rectKey(base));
  });

  it("negative control: visibility is part of the key", () => {
    const base: TrackedRect = {
      paneId: "pane-1",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      isVisible: true,
    };
    expect(rectKey({ ...base, isVisible: false })).not.toBe(rectKey(base));
  });
});
