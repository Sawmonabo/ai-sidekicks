// The scroll container is a recording stand-in, not a DOM element: `happy-dom` answers zero
// for every geometry read, so a test against it would pass whether or not the controller
// touched anything. The stand-in implements `ScrollContainer`; the controller under test is real.

import { beforeEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { createCountingScrollContainer } from "./scroll-container.test-support.js";
import { ScrollController } from "./scroll-chokepoint.js";
import type { ScrollGeometry } from "./geometry-sample.js";
import type { ScrollContainer } from "./scroll-chokepoint.js";

class RecordingScrollContainer implements ScrollContainer {
  readonly #listeners = new Set<() => void>();
  readonly #viewportHeight: number;
  readonly #contentHeight: number;

  public scrollTop = 0;

  public constructor(viewportHeight: number, contentHeight: number) {
    this.#viewportHeight = viewportHeight;
    this.#contentHeight = contentHeight;
  }

  public get clientHeight(): number {
    return this.#viewportHeight;
  }

  public get scrollHeight(): number {
    return this.#contentHeight;
  }

  public addEventListener(_type: string, listener: () => void): void {
    this.#listeners.add(listener);
  }

  public removeEventListener(_type: string, listener: () => void): void {
    this.#listeners.delete(listener);
  }

  public get listenerCount(): number {
    return this.#listeners.size;
  }
}

let clock: ManualClock;
let controller: ScrollController;
let scrollContainer: RecordingScrollContainer;

beforeEach(() => {
  clock = new ManualClock();
  controller = new ScrollController({ clock });
  scrollContainer = new RecordingScrollContainer(500, 5000);
});

describe("the scroll chokepoint — writes", () => {
  it("clamps to the content rather than handing the platform an impossible offset", () => {
    controller.attach(scrollContainer);
    const write = controller.glideTo("jump-to-tail", 999_999);
    expect(write?.appliedScrollTop).toBe(4500);
    expect(controller.glideTo("deep-link", -40)?.appliedScrollTop).toBe(0);
    expect(controller.glideTo("deep-link", Number.NaN)?.appliedScrollTop).toBe(0);
  });
});

describe("the scroll chokepoint — a box that changed size", () => {
  function resizableController(): {
    resizable: ReturnType<typeof createCountingScrollContainer>;
    samples: ScrollGeometry[];
  } {
    const resizable = createCountingScrollContainer({
      initialScrollTop: 0,
      clientHeight: 500,
      scrollHeight: 5000,
    });
    controller.attach(resizable);
    const samples: ScrollGeometry[] = [];
    controller.subscribeToGeometry((geometry) => samples.push(geometry));
    samples.length = 0;
    return { resizable, samples };
  }

  it("publishes the new box on a height change with no scroll at all", () => {
    // The virtualizer's viewport height arrives through this emitter and nowhere else, so a
    // privately measured pass would leave its range on the old height.
    const { resizable, samples } = resizableController();
    resizable.resizeTo(260, 5000);
    controller.requestOverflowMeasurement();
    clock.runFrame();

    expect(samples).toHaveLength(1);
    expect(samples[0]?.viewportHeight).toBe(260);
    expect(samples[0]?.cause).toBe("resize");
    expect(controller.geometry?.viewportHeight).toBe(260);
  });

  it("a scroll with no resize is never reported as one", () => {
    const { resizable, samples } = resizableController();
    resizable.moveTo(900);
    expect(samples.map((geometry) => geometry.cause)).toStrictEqual(["scroll"]);
  });
});

describe("the scroll chokepoint — prune veto, batching, and teardown", () => {
  it("vetoes prune only while a write is in flight", () => {
    controller.attach(scrollContainer);
    const vetoAtEachPublication: boolean[] = [];
    controller.subscribeToGeometry(() => {
      vetoAtEachPublication.push(controller.vetoesPrune());
    });
    // The replayed idle sample is the negative control: an always-vetoing controller would fail.
    expect(vetoAtEachPublication).toStrictEqual([false]);
    controller.glideTo("prune-compensation", 900);
    expect(vetoAtEachPublication).toStrictEqual([false, true]);
    expect(controller.vetoesPrune()).toBe(false);
  });

  it("batches every overflow request in a frame into one pass", () => {
    controller.attach(scrollContainer);
    let passCount = 0;
    controller.observeOverflow(() => {
      passCount += 1;
    });
    controller.requestOverflowMeasurement();
    controller.requestOverflowMeasurement();
    controller.requestOverflowMeasurement();
    expect(passCount).toBe(0);
    clock.runFrame();
    expect(passCount).toBe(1);
    expect(clock.pendingCount).toBe(0);
  });

  it("detaches null-safely, twice, and after a dispose", () => {
    controller.attach(scrollContainer);
    expect(scrollContainer.listenerCount).toBe(1);
    controller.detach();
    controller.detach();
    expect(scrollContainer.listenerCount).toBe(0);
    controller.dispose();
    controller.detach();
    controller.attach(scrollContainer);
    expect(scrollContainer.listenerCount).toBe(0);
  });

  it("cancels an armed overflow frame on detach, so nothing fires into a dead pane", () => {
    controller.attach(scrollContainer);
    controller.requestOverflowMeasurement();
    expect(clock.pendingCount).toBe(1);
    controller.detach();
    expect(clock.pendingCount).toBe(0);
  });

  it("re-arms the pass for the scroll container a re-attach brought, not the one it canceled", () => {
    // `attach` detaches first, which cancels the armed frame. The obligation belongs to the
    // transcript, not the departed container: under a frozen clock every remount armed and
    // canceled a pass, so the box was never re-measured.
    const outgoing = createCountingScrollContainer({ clientHeight: 300, scrollHeight: 4000 });
    const incoming = createCountingScrollContainer({ clientHeight: 640, scrollHeight: 9000 });
    const measuredViewportHeights: number[] = [];
    controller.observeOverflow((geometry) => {
      measuredViewportHeights.push(geometry.viewportHeight);
    });

    controller.attach(outgoing);
    controller.requestOverflowMeasurement();
    controller.attach(incoming);
    clock.runFrame();

    expect(measuredViewportHeights).toStrictEqual([640]);
  });
});
