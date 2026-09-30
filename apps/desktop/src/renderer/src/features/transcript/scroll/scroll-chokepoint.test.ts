// The scroll container is a recording stand-in, not a DOM element: `happy-dom` answers zero
// for every geometry read, so a test against it would pass whether or not the controller
// touched anything. The stand-in implements `ScrollContainer`; the controller under test is real.

import { beforeEach, describe, expect, it } from "vitest";

import { ManualClock } from "@renderer/lib/clock.js";
import { TRANSCRIPT_GEOMETRY_EPSILON_PX } from "../viewport/viewport-constants.js";
import { createCountingScrollContainer } from "./scroll-container.test-support.js";
import { SCROLL_CALLERS } from "./scroll-callers.js";
import { ScrollController } from "./scroll-chokepoint.js";
import type { ScrollGeometry } from "./geometry-sample.js";
import type { ScrollContainer } from "./scroll-chokepoint.js";

class RecordingScrollContainer implements ScrollContainer {
  public readonly readCountByProperty = new Map<string, number>();
  public quantizesWrites = false;

  readonly #listeners = new Set<() => void>();
  readonly #viewportHeight: number;
  readonly #contentHeight: number;
  #scrollTop = 0;

  public constructor(viewportHeight: number, contentHeight: number) {
    this.#viewportHeight = viewportHeight;
    this.#contentHeight = contentHeight;
  }

  public get scrollTop(): number {
    this.#recordRead("scrollTop");
    return this.#scrollTop;
  }

  public set scrollTop(value: number) {
    this.#scrollTop = this.quantizesWrites ? Math.round(value) : value;
  }

  public get clientHeight(): number {
    this.#recordRead("clientHeight");
    return this.#viewportHeight;
  }

  public get scrollHeight(): number {
    this.#recordRead("scrollHeight");
    return this.#contentHeight;
  }

  public addEventListener(_type: string, listener: () => void): void {
    this.#listeners.add(listener);
  }

  public removeEventListener(_type: string, listener: () => void): void {
    this.#listeners.delete(listener);
  }

  public scrollBy(scrollTop: number): void {
    this.#scrollTop = scrollTop;
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }

  public get listenerCount(): number {
    return this.#listeners.size;
  }

  public get totalReadCount(): number {
    let total = 0;
    for (const count of this.readCountByProperty.values()) {
      total += count;
    }
    return total;
  }

  #recordRead(property: string): void {
    this.readCountByProperty.set(property, (this.readCountByProperty.get(property) ?? 0) + 1);
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

describe("the scroll chokepoint — geometry", () => {
  it("replays the last sample to a subscriber that arrives after it", () => {
    controller.attach(scrollContainer);
    const received: ScrollGeometry[] = [];
    controller.subscribeToGeometry((geometry) => received.push(geometry));
    expect(received).toHaveLength(1);
    expect(received[0]?.contentHeight).toBe(5000);
    expect(received[0]?.isAtTail).toBe(false);
  });

  it("negative control: a controller that never attached replays nothing", () => {
    // Without this, the case above would pass over a replayed fabricated zero sample.
    const received: ScrollGeometry[] = [];
    controller.subscribeToGeometry((geometry) => received.push(geometry));
    expect(received).toStrictEqual([]);
  });

  it("reads exactly the three geometry properties per scroll event, and no fourth", () => {
    controller.attach(scrollContainer);
    scrollContainer.readCountByProperty.clear();
    scrollContainer.scrollBy(120);
    scrollContainer.scrollBy(240);
    expect([...scrollContainer.readCountByProperty.keys()].sort()).toStrictEqual([
      "clientHeight",
      "scrollHeight",
      "scrollTop",
    ]);
    expect(scrollContainer.totalReadCount).toBe(6);
  });

  it("negative control: the read counter does count", () => {
    controller.attach(scrollContainer);
    scrollContainer.readCountByProperty.clear();
    void scrollContainer.scrollTop;
    expect(scrollContainer.totalReadCount).toBe(1);
  });
});

describe("the scroll chokepoint — writes", () => {
  it("names the caller on every write and counts them per caller", () => {
    controller.attach(scrollContainer);
    controller.glideTo("find-match", 1000);
    controller.glideTo("find-match", 2000);
    controller.glideTo("deep-link", 300);
    expect(controller.writeCount("find-match")).toBe(2);
    expect(controller.writeCount("deep-link")).toBe(1);
    expect(controller.writeCount("follow-tail")).toBe(0);
  });

  it("declares its caller union closed and complete", () => {
    // Pins the set so widening it is a deliberate edit rather than a typo.
    expect([...SCROLL_CALLERS]).toStrictEqual([
      "follow-tail",
      "jump-to-tail",
      "hold-reading-position",
      "deep-link",
      "find-match",
      "prune-compensation",
      "measurement-compensation",
    ]);
  });

  it("clamps to the content rather than handing the platform an impossible offset", () => {
    controller.attach(scrollContainer);
    const write = controller.glideTo("jump-to-tail", 999_999);
    expect(write?.appliedScrollTop).toBe(4500);
    expect(controller.glideTo("deep-link", -40)?.appliedScrollTop).toBe(0);
    expect(controller.glideTo("deep-link", Number.NaN)?.appliedScrollTop).toBe(0);
  });

  it("glides to the tail instead of asking an element to scroll itself into view", () => {
    controller.attach(scrollContainer);
    expect(controller.glideToTail("follow-tail")?.appliedScrollTop).toBe(4500);
  });

  it("writes nothing when it has no scroll container", () => {
    expect(controller.glideTo("follow-tail", 10)).toBeUndefined();
    expect(controller.glideToTail("follow-tail")).toBeUndefined();
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

  it("negative control: a height change under the epsilon wakes nobody", () => {
    // Sub-pixel wobble is what a fractional row height produces every frame.
    const { resizable, samples } = resizableController();
    resizable.resizeTo(500 + TRANSCRIPT_GEOMETRY_EPSILON_PX / 2, 5000);
    controller.requestOverflowMeasurement();
    clock.runFrame();
    expect(samples).toStrictEqual([]);
  });

  it("negative control: a scroll with no resize is never reported as one", () => {
    const { resizable, samples } = resizableController();
    resizable.moveTo(900);
    expect(samples.map((geometry) => geometry.cause)).toStrictEqual(["scroll"]);
  });

  it("hands the overflow sink the one sample it published, rather than taking a second", () => {
    const { resizable, samples } = resizableController();
    const measuredAt: ScrollGeometry[] = [];
    controller.observeOverflow((geometry) => measuredAt.push(geometry));
    resizable.resizeTo(320, 6000);
    controller.requestOverflowMeasurement();
    clock.runFrame();
    expect(measuredAt).toStrictEqual(samples);
  });
});

describe("the scroll chokepoint — the quantization learner", () => {
  it("skips no-op writes only after two witnesses agree", () => {
    scrollContainer.quantizesWrites = true;
    controller.attach(scrollContainer);
    expect(controller.quantizesToWholePixels).toBeUndefined();

    controller.glideTo("find-match", 100.4);
    expect(controller.quantizesToWholePixels).toBeUndefined();
    controller.glideTo("find-match", 220.4);
    expect(controller.quantizesToWholePixels).toBe(true);

    // 220.4 already landed on 220, so a request rounding to the same pixel is a skippable no-op.
    expect(controller.glideTo("find-match", 220.2)?.wasSkipped).toBe(true);
  });

  it("negative control: a display that does not quantize never skips", () => {
    // The same two fractional writes against a container that keeps them.
    controller.attach(scrollContainer);
    controller.glideTo("find-match", 100.4);
    controller.glideTo("find-match", 220.4);
    expect(controller.quantizesToWholePixels).toBe(false);
    expect(controller.glideTo("find-match", 220.2)?.wasSkipped).toBe(false);
  });

  it("ignores whole-pixel requests as evidence, which land on a whole pixel anywhere", () => {
    scrollContainer.quantizesWrites = true;
    controller.attach(scrollContainer);
    controller.glideTo("find-match", 100);
    controller.glideTo("find-match", 200);
    controller.glideTo("find-match", 300);
    expect(controller.quantizesToWholePixels).toBeUndefined();
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

  it("negative control: a detach with no re-attach still arms nothing", () => {
    // A pane that closed for good must leave no frame behind it.
    controller.attach(scrollContainer);
    controller.requestOverflowMeasurement();
    controller.detach();

    expect(clock.pendingCount).toBe(0);
  });
});
