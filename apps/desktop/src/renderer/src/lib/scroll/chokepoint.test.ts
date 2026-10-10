// The scroll container is a real element with its geometry defined onto it: `happy-dom` answers
// zero for every geometry read, so a test against a bare element would pass whether or not the
// controller touched anything. The controller under test is real.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AnimationFrameScheduler } from "#renderer/features/transcript/animation-frame-scheduler.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { MOTION_DURATIONS_MS, settleEasingAt } from "#renderer/styles/motion.js";
import {
  createCountingScrollContainer,
  type CountingScrollContainer,
} from "./container.test-support.js";
import { ScrollController } from "./chokepoint.js";
import type { ScrollGeometry } from "./geometry/sample.js";

let clock: ManualClock;
let controller: ScrollController;
let scrollContainer: CountingScrollContainer;

beforeEach(() => {
  clock = new ManualClock();
  controller = new ScrollController({ clock });
  scrollContainer = createCountingScrollContainer({
    initialScrollTop: 0,
    clientHeight: 500,
    scrollHeight: 5000,
  });
});

describe("the scroll chokepoint — writes", () => {
  it("clamps to the content rather than handing the platform an impossible offset", () => {
    controller.attach(scrollContainer);
    const write = controller.glideTo("jump-to-tail", 999_999);
    expect(write?.appliedScrollTop).toBe(4500);
    expect(controller.glideTo("find-match", -40)?.appliedScrollTop).toBe(0);
    expect(controller.glideTo("find-match", Number.NaN)?.appliedScrollTop).toBe(0);
  });
});

describe("the scroll chokepoint — a supplied content height", () => {
  // The element says 5000 px of content; the supplied height differs, so a sample, clamp or
  // glide computed from `scrollHeight` is told apart.

  it("costs a scroll event one read, the offset, and samples the supplied height", () => {
    const scrollHeightRead = vi.spyOn(scrollContainer, "scrollHeight", "get");
    const clientHeightRead = vi.spyOn(scrollContainer, "clientHeight", "get");
    // Negative control: attached without a supplied height, a scroll reads both boxes.
    controller.attach(scrollContainer);
    scrollContainer.moveTo(100);
    expect(scrollHeightRead).toHaveBeenCalled();
    expect(clientHeightRead).toHaveBeenCalled();

    let suppliedHeightPx = 3000;
    controller.attach(scrollContainer, () => suppliedHeightPx);
    scrollHeightRead.mockClear();
    clientHeightRead.mockClear();
    scrollContainer.moveTo(900);
    expect(scrollHeightRead).not.toHaveBeenCalled();
    expect(clientHeightRead).not.toHaveBeenCalled();
    expect(controller.geometry).toMatchObject({
      scrollTop: 900,
      viewportHeight: 500,
      contentHeight: 3000,
      distanceFromTailPx: 1600,
      cause: "scroll",
    });

    // A log shorter than its box reports the box, as `scrollHeight` would.
    suppliedHeightPx = 200;
    scrollContainer.moveTo(0);
    expect(controller.geometry?.contentHeight).toBe(500);
  });

  it("clamps a glide and finds the tail against the supplied height", () => {
    controller.attach(scrollContainer, () => 8000);
    expect(controller.glideTo("find-match", 999_999)?.requestedScrollTop).toBe(7500);
    controller.glideTo("find-match", 0);
    expect(controller.glideToTail("jump-to-tail")?.requestedScrollTop).toBe(7500);
  });

  it("learns no rounding from a write the platform clamped at its own whole-pixel end", () => {
    // A display that keeps fractional offsets, whose end is 2500 px while the supplied height
    // puts it at 2500.4: a tail glide lands on a whole pixel because it was clamped.
    let offsetPx = 0;
    Object.defineProperty(scrollContainer, "scrollTop", {
      get: () => offsetPx,
      set: (next: number) => {
        offsetPx = Math.min(Math.max(0, next), 2500);
      },
    });
    controller.attach(scrollContainer, () => 3000.4);
    controller.glideToTail("follow-tail");
    controller.glideToTail("follow-tail");
    controller.glideTo("hold-reading-position", 1000);

    const subPixelWrite = controller.glideTo("hold-reading-position", 1000.3);

    expect(subPixelWrite?.wasSkipped).toBe(false);
    expect(subPixelWrite?.appliedScrollTop).toBe(1000.3);
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
    // The resent idle sample is the negative control: an always-vetoing controller would fail.
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
    expect(scrollContainer.scrollListenerCount()).toBe(1);
    controller.detach();
    controller.detach();
    expect(scrollContainer.scrollListenerCount()).toBe(0);
    controller.dispose();
    controller.detach();
    controller.attach(scrollContainer);
    expect(scrollContainer.scrollListenerCount()).toBe(0);
  });

  it("cancels an armed overflow frame on detach, so nothing fires into a dead pane", () => {
    controller.attach(scrollContainer);
    controller.requestOverflowMeasurement();
    expect(clock.pendingCount).toBe(1);
    controller.detach();
    expect(clock.pendingCount).toBe(0);
  });

  it("re-arms the pass for the container a re-attach brought, not the one it canceled", () => {
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

describe("the scroll chokepoint — an eased glide", () => {
  /** One display frame, in milliseconds. */
  const FRAME_MS = 16;
  const SETTLE = { durationMs: MOTION_DURATIONS_MS["motion-settle"], easing: settleEasingAt };

  /** Runs frames until the glide ends, answering the offset each one left the box at. */
  function runGlideFrames(): number[] {
    const offsets: number[] = [];
    for (let frame = 0; frame < 100 && controller.isEasing; frame += 1) {
      clock.advance(FRAME_MS);
      clock.runFrame();
      offsets.push(scrollContainer.scrollTop);
    }
    return offsets;
  }

  it("moves a write a frame toward a moving target, never back, and lands on it", () => {
    controller.attach(scrollContainer);
    controller.adoptFrameScheduler(new AnimationFrameScheduler({ clock }));
    let targetPx = 1000;

    expect(controller.easeTo("follow-arriving-text", () => targetPx, SETTLE)).toBe(true);
    clock.advance(FRAME_MS);
    clock.runFrame();
    const firstStepPx = scrollContainer.scrollTop;
    // Text arrives every frame for a while: the target moves on each one.
    const whileArriving: number[] = [];
    for (let frame = 0; frame < 5; frame += 1) {
      targetPx += 40;
      clock.advance(FRAME_MS);
      clock.runFrame();
      whileArriving.push(scrollContainer.scrollTop);
    }
    const settling = runGlideFrames();
    const offsets = [firstStepPx, ...whileArriving, ...settling];

    // The first frame already moves, part of the way.
    expect(firstStepPx).toBeGreaterThan(0);
    expect(firstStepPx).toBeLessThan(1000);
    // Each frame of arriving text moves the box on, short of the target that frame named.
    expect(whileArriving.every((offset, frame) => offset < 1000 + 40 * (frame + 1))).toBe(true);
    const arrivingSteps = [firstStepPx, ...whileArriving];
    expect(arrivingSteps.every((offset, frame) => offset > (arrivingSteps[frame - 1] ?? 0))).toBe(
      true,
    );
    expect(offsets.slice(1).every((offset, frame) => offset >= (offsets[frame] ?? 0))).toBe(true);
    expect(new Set(offsets).size).toBeGreaterThan(3);
    expect(offsets.at(-1)).toBe(targetPx);
    expect(controller.isEasing).toBe(false);
  });

  it("places a target behind the box at once, and a stopped glide writes nothing more", () => {
    controller.attach(scrollContainer);
    controller.adoptFrameScheduler(new AnimationFrameScheduler({ clock }));
    scrollContainer.moveTo(800);
    controller.easeTo("follow-arriving-text", () => 300, SETTLE);
    clock.advance(FRAME_MS);
    clock.runFrame();
    const behindPx = scrollContainer.scrollTop;

    controller.easeTo("follow-arriving-text", () => 2000, SETTLE);
    controller.stopEasing();
    clock.advance(FRAME_MS);
    clock.runFrame();

    expect(behindPx).toBe(300);
    expect(scrollContainer.scrollTop).toBe(300);
    expect(controller.isEasing).toBe(false);
  });
});
