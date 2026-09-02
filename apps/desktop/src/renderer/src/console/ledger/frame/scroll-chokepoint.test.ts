// The scroll chokepoint's four promises, driven rather than asserted.
//
// The surface is a recording stand-in rather than a DOM element on purpose. Two of
// the claims — "the sample reads exactly three properties" and "a fractional write
// lands on a whole pixel on a quantizing display" — are about what the controller
// TOUCHES, and `happy-dom` answers zero for every geometry read, so a test against
// it would pass whether or not the controller did anything at all.
//
// The stand-in is a real implementation of `LedgerScrollSurface`, not a stub of the
// controller: the module under test is imported and driven.

import { beforeEach, describe, expect, it } from "vitest";

import { ManualClock } from "../../core/index.js";
import { LEDGER_GEOMETRY_EPSILON_PX } from "./frame-bounds.js";
import { countingSurface } from "./scroll-surface-fixture.js";
import { LEDGER_SCROLL_CALLERS, LedgerScrollController } from "./scroll-chokepoint.js";
import type { LedgerGeometry } from "./geometry-sample.js";
import type { LedgerScrollSurface } from "./scroll-chokepoint.js";

/** A surface that counts every property the controller reads. */
class RecordingScrollSurface implements LedgerScrollSurface {
  public readonly readCountByProperty = new Map<string, number>();
  /** When true, the surface rounds a written offset, as a quantizing display does. */
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

  /** A person scrolling. */
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
let controller: LedgerScrollController;
let surface: RecordingScrollSurface;

beforeEach(() => {
  clock = new ManualClock();
  controller = new LedgerScrollController({ clock });
  surface = new RecordingScrollSurface(500, 5000);
});

describe("the scroll chokepoint — geometry", () => {
  it("replays the last sample to a subscriber that arrives after it", () => {
    controller.attach(surface);
    const received: LedgerGeometry[] = [];
    controller.subscribeToGeometry((geometry) => received.push(geometry));
    expect(received).toHaveLength(1);
    expect(received[0]?.contentHeight).toBe(5000);
    expect(received[0]?.isAtTail).toBe(false);
  });

  it("negative control: a controller that never attached replays nothing", () => {
    // Without this, the case above would pass over a subscription that replayed a
    // fabricated zero sample rather than the one the surface produced.
    const received: LedgerGeometry[] = [];
    controller.subscribeToGeometry((geometry) => received.push(geometry));
    expect(received).toStrictEqual([]);
  });

  it("reads exactly the three geometry properties per scroll event, and no fourth", () => {
    controller.attach(surface);
    surface.readCountByProperty.clear();
    surface.scrollBy(120);
    surface.scrollBy(240);
    expect([...surface.readCountByProperty.keys()].sort()).toStrictEqual([
      "clientHeight",
      "scrollHeight",
      "scrollTop",
    ]);
    expect(surface.totalReadCount).toBe(6);
  });

  it("negative control: the read counter does count", () => {
    // The clean result above is only meaningful if an extra read would show up.
    controller.attach(surface);
    surface.readCountByProperty.clear();
    void surface.scrollTop;
    expect(surface.totalReadCount).toBe(1);
  });

  it("calls the viewport at the tail once it is within the tolerance", () => {
    const tailSurface = new RecordingScrollSurface(500, 5000);
    controller.attach(tailSurface);
    tailSurface.scrollBy(4500);
    expect(controller.geometry?.isAtTail).toBe(true);
    expect(controller.geometry?.distanceFromTailPx).toBe(0);
  });
});

describe("the scroll chokepoint — writes", () => {
  it("names the caller on every write and counts them per caller", () => {
    controller.attach(surface);
    controller.glideTo("find-match", 1000);
    controller.glideTo("find-match", 2000);
    controller.glideTo("deep-link", 300);
    expect(controller.writeCount("find-match")).toBe(2);
    expect(controller.writeCount("deep-link")).toBe(1);
    expect(controller.writeCount("replay-seek")).toBe(0);
  });

  it("declares its caller union closed and complete", () => {
    // A caller absent from the union cannot be passed at all, which is the point;
    // this pins the set so widening it is a deliberate edit rather than a typo.
    expect([...LEDGER_SCROLL_CALLERS]).toStrictEqual([
      "follow-tail",
      "jump-to-tail",
      "hold-reading-position",
      "deep-link",
      "find-match",
      "replay-seek",
      "prune-compensation",
      "measurement-compensation",
    ]);
  });

  it("clamps to the content rather than handing the platform an impossible offset", () => {
    controller.attach(surface);
    const write = controller.glideTo("jump-to-tail", 999_999);
    expect(write?.appliedScrollTop).toBe(4500);
    expect(controller.glideTo("deep-link", -40)?.appliedScrollTop).toBe(0);
    expect(controller.glideTo("deep-link", Number.NaN)?.appliedScrollTop).toBe(0);
  });

  it("glides to the tail instead of asking an element to scroll itself into view", () => {
    controller.attach(surface);
    expect(controller.glideToTail("follow-tail")?.appliedScrollTop).toBe(4500);
  });

  it("writes nothing when it has no surface", () => {
    expect(controller.glideTo("follow-tail", 10)).toBeUndefined();
    expect(controller.glideToTail("follow-tail")).toBeUndefined();
  });
});

describe("the scroll chokepoint — a box that changed size", () => {
  /** A surface whose box a case can change, and the pass that notices it. */
  function resizableController(): {
    resizable: ReturnType<typeof countingSurface>;
    samples: LedgerGeometry[];
  } {
    const resizable = countingSurface({
      initialScrollTop: 0,
      clientHeight: 500,
      scrollHeight: 5000,
    });
    controller.attach(resizable);
    const samples: LedgerGeometry[] = [];
    controller.subscribeToGeometry((geometry) => samples.push(geometry));
    samples.length = 0;
    return { resizable, samples };
  }

  it("publishes the new box on a height change with no scroll at all", () => {
    // The virtualizer's viewport height arrives through this emitter and nowhere
    // else, so a pass that measured privately left its rendered range, its
    // offset-for-index and its tail arithmetic on the height the pane used to have.
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
    // Which is what makes the publication above a change rather than a heartbeat:
    // sub-pixel wobble is what a fractional row height produces every frame.
    const { resizable, samples } = resizableController();
    resizable.resizeTo(500 + LEDGER_GEOMETRY_EPSILON_PX / 2, 5000);
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
    const measuredAt: LedgerGeometry[] = [];
    controller.observeOverflow((geometry) => measuredAt.push(geometry));
    resizable.resizeTo(320, 6000);
    controller.requestOverflowMeasurement();
    clock.runFrame();
    expect(measuredAt).toStrictEqual(samples);
  });
});

describe("the scroll chokepoint — the quantization learner", () => {
  it("skips no-op writes only after two witnesses agree", () => {
    surface.quantizesWrites = true;
    controller.attach(surface);
    expect(controller.quantizesToWholePixels).toBeUndefined();

    controller.glideTo("find-match", 100.4);
    expect(controller.quantizesToWholePixels).toBeUndefined();
    controller.glideTo("find-match", 220.4);
    expect(controller.quantizesToWholePixels).toBe(true);

    // 220.4 already landed on 220, so a request that rounds to the same pixel is a
    // no-op the controller may now skip.
    expect(controller.glideTo("find-match", 220.2)?.wasSkipped).toBe(true);
  });

  it("negative control: a display that does not quantize never skips", () => {
    // Same two fractional writes against a surface that keeps them, so the only
    // difference between this case and the one above is the display.
    controller.attach(surface);
    controller.glideTo("find-match", 100.4);
    controller.glideTo("find-match", 220.4);
    expect(controller.quantizesToWholePixels).toBe(false);
    expect(controller.glideTo("find-match", 220.2)?.wasSkipped).toBe(false);
  });

  it("ignores whole-pixel requests as evidence, which land on a whole pixel anywhere", () => {
    surface.quantizesWrites = true;
    controller.attach(surface);
    controller.glideTo("find-match", 100);
    controller.glideTo("find-match", 200);
    controller.glideTo("find-match", 300);
    expect(controller.quantizesToWholePixels).toBeUndefined();
  });
});

describe("the scroll chokepoint — prune veto, batching, and teardown", () => {
  it("vetoes prune only while a write is in flight", () => {
    controller.attach(surface);
    const vetoAtEachPublication: boolean[] = [];
    controller.subscribeToGeometry(() => {
      vetoAtEachPublication.push(controller.vetoesPrune());
    });
    // The subscription replays the idle sample first, which is this case's own
    // negative control: without it a controller that always vetoed would pass.
    expect(vetoAtEachPublication).toStrictEqual([false]);
    controller.glideTo("prune-compensation", 900);
    expect(vetoAtEachPublication).toStrictEqual([false, true]);
    expect(controller.vetoesPrune()).toBe(false);
  });

  it("batches every overflow request in a frame into one pass", () => {
    controller.attach(surface);
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
    controller.attach(surface);
    expect(surface.listenerCount).toBe(1);
    controller.detach();
    controller.detach();
    expect(surface.listenerCount).toBe(0);
    controller.dispose();
    controller.detach();
    controller.attach(surface);
    expect(surface.listenerCount).toBe(0);
  });

  it("cancels an armed overflow frame on detach, so nothing fires into a dead pane", () => {
    controller.attach(surface);
    controller.requestOverflowMeasurement();
    expect(clock.pendingCount).toBe(1);
    controller.detach();
    expect(clock.pendingCount).toBe(0);
  });
});
