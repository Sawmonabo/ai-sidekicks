// Rect tracking: reads in the callback, writes on the next frame.
//
// The first case is a negative control: on a frozen clock nothing may be written when the
// observer fires. A tracker that wrote synchronously would pass every other case here.

import { afterEach, describe, expect, it } from "vitest";

import { AirspaceRegistry } from "@renderer/lib/airspace-registry.js";
import { ManualClock } from "@renderer/lib/clock.js";
import { type Unsubscribe } from "@renderer/lib/emitter.js";
import { NATIVE_VIEW_MINIMUM_VISIBLE_PX } from "./pane-layout-measures.js";
import { PaneRectTracker } from "./pane-rect-tracker.js";
import { type TrackedRect } from "./pane-rect-geometry.js";

/** A rectangle in viewport coordinates, as the DOM would report one. */
interface ViewportBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** An element whose rect is whatever the test says it is. */
function elementMeasuring(box: { width: number; height: number; x?: number; y?: number }): Element {
  return {
    getBoundingClientRect: () => ({
      x: box.x ?? 0,
      y: box.y ?? 0,
      width: box.width,
      height: box.height,
    }),
    parentElement: null,
  } as unknown as Element;
}

/** Gives a real element a box, which jsdom otherwise reports as all zeroes. */
function measuring(element: HTMLElement, box: ViewportBox): void {
  element.getBoundingClientRect = () => ({ ...box, top: box.y, left: box.x }) as DOMRect;
}

interface TrackerHarness {
  readonly clock: ManualClock;
  readonly tracker: PaneRectTracker;
  readonly writes: TrackedRect[][];
}

/** One tracker over its own airspace registry, so a case sees only the overlays it put up. */
function harness(airspace: AirspaceRegistry = new AirspaceRegistry()): TrackerHarness {
  const clock = new ManualClock();
  const writes: TrackedRect[][] = [];
  const tracker = new PaneRectTracker({
    clock,
    onFlush: (rects) => {
      writes.push([...rects]);
    },
    airspace,
  });
  return { clock, tracker, writes };
}

/**
 * An airspace that counts its change listeners. A disposed tracker ignores what it hears, so a
 * listener it kept shows nothing from outside.
 */
class ListenerCountingAirspace extends AirspaceRegistry {
  public liveListeners = 0;

  public override subscribeToChanges(sink: () => void): Unsubscribe {
    const unsubscribe = super.subscribeToChanges(sink);
    this.liveListeners += 1;
    return () => {
      this.liveListeners -= 1;
      unsubscribe();
    };
  }
}

/** Puts an overlay of some size up and returns its removal. A dialog unless said. */
function overlayUp(airspace: AirspaceRegistry): () => void {
  const registration = airspace.register(() => ({ x: 0, y: 0, width: 10, height: 10 }));
  return () => {
    registration.remove();
  };
}

describe("PaneRectTracker — when it writes", () => {
  it("writes nothing at the moment a source fires, and writes on the next frame", () => {
    const { clock, tracker, writes } = harness();
    tracker.track("pane-1", elementMeasuring({ width: 400, height: 300 }));
    tracker.invalidate("window-resize");
    tracker.invalidate("ancestor-scroll");

    // `track` invalidates as a layout mover; nothing may be written yet, and the three
    // sources share one frame rather than each arming its own.
    expect(writes).toStrictEqual([]);
    expect(clock.pendingFrameCount).toBe(1);

    clock.runFrame();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]?.paneId).toBe("pane-1");
  });

  it("writes nothing a second time for a rect that did not change", () => {
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

  it("arms nothing and stops listening once disposed, so nothing outlives the pane layout", () => {
    const airspace = new ListenerCountingAirspace();
    const { clock, tracker, writes } = harness(airspace);
    tracker.track("pane-1", elementMeasuring({ width: 400, height: 300 }));
    expect(airspace.liveListeners).toBe(1);
    tracker.dispose();
    tracker.invalidate("window-resize");

    expect(clock.pendingCount).toBe(0);
    expect(airspace.liveListeners).toBe(0);
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

  it("yields the airspace when an overlay opens, with nothing else asking it to look", () => {
    // No manual invalidate here, on purpose: an overlay opening fires no layout source, so a
    // tracker that only sampled occupancy inside `invalidate` would leave a native view over
    // the dialog.
    const airspace = new AirspaceRegistry();
    const { clock, tracker, writes } = harness(airspace);
    tracker.track("pane-1", elementMeasuring({ width: 400, height: 300 }));
    clock.runFrame();
    expect(writes[0]?.[0]?.isVisible).toBe(true);

    const release = overlayUp(airspace);
    clock.runFrame();
    expect(writes[1]?.[0]?.isVisible).toBe(false);

    release();
    clock.runFrame();
    expect(writes[2]?.[0]?.isVisible).toBe(true);
    expect(tracker.invalidationCount("airspace")).toBe(2);
  });

  it("negative control: two overlays, and the first to close does not free the airspace", () => {
    // Why the tracker reads a count: a boolean would free the airspace when the first of two
    // overlays closes.
    const airspace = new AirspaceRegistry();
    const { clock, tracker, writes } = harness(airspace);
    tracker.track("pane-1", elementMeasuring({ width: 400, height: 300 }));
    clock.runFrame();
    expect(writes[0]?.[0]?.isVisible).toBe(true);

    const releaseFirst = overlayUp(airspace);
    overlayUp(airspace);
    clock.runFrame();
    expect(writes[1]?.[0]?.isVisible).toBe(false);

    releaseFirst();
    clock.runFrame();
    expect(writes).toHaveLength(2);
  });
});

describe("PaneRectTracker — what a clipping ancestor does to the rect", () => {
  /** A real element with a test-chosen box, inside a real clipping ancestor. */
  function paneInsideScroller(options: {
    readonly pane: ViewportBox;
    readonly scroller: ViewportBox;
    readonly overflow: string;
  }): Element {
    const scroller = document.createElement("div");
    scroller.style.overflow = options.overflow;
    measuring(scroller, options.scroller);
    const pane = document.createElement("div");
    measuring(pane, options.pane);
    scroller.append(pane);
    document.body.append(scroller);
    return pane;
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("publishes the intersection with a scrolling ancestor rather than the border box", () => {
    // A native view is not clipped by the DOM ancestor that clips its pane, so the tracker
    // must report the clipped rect.
    const { clock, tracker, writes } = harness();
    tracker.track(
      "pane-1",
      paneInsideScroller({
        pane: { x: 100, y: 40, width: 400, height: 300 },
        scroller: { x: 100, y: 40, width: 400, height: 120 },
        overflow: "auto",
      }),
    );
    clock.runFrame();

    expect(writes[0]?.[0]).toMatchObject({ x: 100, y: 40, width: 400, height: 120 });
    expect(writes[0]?.[0]?.isVisible).toBe(true);
  });

  it("reports hidden when the ancestor's clip collapses the pane to nothing", () => {
    const { clock, tracker, writes } = harness();
    tracker.track(
      "pane-1",
      paneInsideScroller({
        pane: { x: 100, y: 400, width: 400, height: 300 },
        scroller: { x: 100, y: 40, width: 400, height: 120 },
        overflow: "scroll",
      }),
    );
    clock.runFrame();

    expect(writes[0]?.[0]?.height).toBe(0);
    expect(writes[0]?.[0]?.isVisible).toBe(false);
  });

  it("negative control: an ancestor that does not clip leaves the pane's own rect alone", () => {
    // A tracker intersecting with every ancestor would hide any pane that has a parent.
    const { clock, tracker, writes } = harness();
    tracker.track(
      "pane-1",
      paneInsideScroller({
        pane: { x: 100, y: 40, width: 400, height: 300 },
        scroller: { x: 100, y: 40, width: 400, height: 120 },
        overflow: "visible",
      }),
    );
    clock.runFrame();

    expect(writes[0]?.[0]).toMatchObject({ x: 100, y: 40, width: 400, height: 300 });
  });
});
