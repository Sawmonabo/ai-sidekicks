// The clock seam's test instrument.
//
// `ManualClock` is the console's timer audit, so a test of it is a test of the
// instrument every budget claim is measured with: if `pendingCount` could miss an
// armed timer, "no timer fires except the refresh scheduler's deadline and the
// presence heartbeat" would be unfalsifiable rather than checked. The two controls
// it separates — advancing time and releasing a paint — are separable here and
// nowhere else, which is why they are driven apart and then together.
//
// `RealClock`, the arm a shipped window runs on, is driven by `clock.test.ts`.

import { describe, expect, it } from "vitest";
import { ManualClock } from "./clock.js";

describe("ManualClock — nothing moves until it is told to", () => {
  it("starts at the given time and does not drift", () => {
    expect(new ManualClock().now()).toBe(0);
    expect(new ManualClock(1_700_000_000_000).now()).toBe(1_700_000_000_000);
  });

  it("holds a timeout armed until time reaches it, then runs it", () => {
    const clock = new ManualClock();
    let ran = false;
    clock.scheduleTimeout(() => {
      ran = true;
    }, 100);

    clock.advance(99);
    expect(ran).toBe(false);
    expect(clock.pendingCount).toBe(1);

    clock.advance(1);
    expect(ran).toBe(true);
    expect(clock.pendingCount).toBe(0);
  });

  it("lands exactly on the requested time, not on the last callback's due time", () => {
    const clock = new ManualClock();
    clock.scheduleTimeout(() => undefined, 10);
    clock.advance(100);
    expect(clock.now()).toBe(100);
  });

  it("runs due work in due order, ties broken by arm order", () => {
    const clock = new ManualClock();
    const order: string[] = [];
    clock.scheduleTimeout(() => order.push("late"), 30);
    clock.scheduleTimeout(() => order.push("early"), 10);
    clock.scheduleTimeout(() => order.push("early-but-armed-second"), 10);

    clock.advance(50);

    expect(order).toStrictEqual(["early", "early-but-armed-second", "late"]);
  });

  it("runs work a callback arms during the advance, when it falls inside the window", () => {
    // The re-arming scheduler is the shape this matters for: a debounce that
    // re-arms itself has to be observable, not invisible until the next advance.
    const clock = new ManualClock();
    const ticks: number[] = [];
    const reArm = (): void => {
      ticks.push(clock.now());
      if (ticks.length < 3) {
        clock.scheduleTimeout(reArm, 10);
      }
    };
    clock.scheduleTimeout(reArm, 10);

    clock.advance(100);

    expect(ticks).toStrictEqual([10, 20, 30]);
    expect(clock.pendingCount).toBe(0);
  });

  it("cancels one piece of work without touching its twin", () => {
    const clock = new ManualClock();
    let cancelledRan = false;
    let twinRan = false;
    const cancelled = clock.scheduleTimeout(() => {
      cancelledRan = true;
    }, 10);
    clock.scheduleTimeout(() => {
      twinRan = true;
    }, 10);

    clock.cancel(cancelled);
    clock.advance(20);

    expect(cancelledRan).toBe(false);
    expect(twinRan).toBe(true);
  });
});

describe("ManualClock — frames are separable from timeouts", () => {
  it("counts frames apart from the rest of the armed work", () => {
    const clock = new ManualClock();
    clock.scheduleFrame(() => undefined);
    clock.scheduleTimeout(() => undefined, 10);

    expect(clock.pendingCount).toBe(2);
    expect(clock.pendingFrameCount).toBe(1);
  });

  it("runs frames without moving time, and leaves timeouts armed", () => {
    const clock = new ManualClock();
    let framePainted = false;
    let timeoutRan = false;
    clock.scheduleFrame(() => {
      framePainted = true;
    });
    clock.scheduleTimeout(() => {
      timeoutRan = true;
    }, 10);

    clock.runFrame();

    expect(framePainted).toBe(true);
    expect(timeoutRan).toBe(false);
    expect(clock.now()).toBe(0);
    expect(clock.pendingFrameCount).toBe(0);
    expect(clock.pendingCount).toBe(1);
  });

  it("leaves a frame armed across an advance, and paints it only when asked", () => {
    // Advancing time is not painting. A frame is armed with `dueAt` equal to NOW,
    // so an `advance` that selected work on due time alone would run every pending
    // frame — and a scenario beat, an endurance step, or a frozen-tick screenshot
    // would then paint an extra frame nobody released, with the two controls the
    // clock separates silently fused back together.
    const clock = new ManualClock();
    let framePainted = false;
    clock.scheduleFrame(() => {
      framePainted = true;
    });

    clock.advance(1_000);

    expect(framePainted).toBe(false);
    expect(clock.pendingFrameCount).toBe(1);
    // Time still lands where it was told to, with the frame still owed.
    expect(clock.now()).toBe(1_000);

    clock.runFrame();

    expect(framePainted).toBe(true);
    expect(clock.pendingFrameCount).toBe(0);
  });

  it("negative control: the same advance still runs a timeout that falls due", () => {
    // Without this, an `advance` that had stopped running anything at all would
    // pass the case above while breaking every debounce and coalescing window in
    // the console.
    const clock = new ManualClock();
    let framePainted = false;
    let timeoutRan = false;
    clock.scheduleFrame(() => {
      framePainted = true;
    });
    clock.scheduleTimeout(() => {
      timeoutRan = true;
    }, 10);

    clock.advance(20);

    expect(timeoutRan).toBe(true);
    expect(framePainted).toBe(false);
    expect(clock.pendingCount).toBe(1);
  });

  it("runs a timeout a frame callback arms, once the frame is released", () => {
    // The two controls compose rather than exclude each other: work a paint arms
    // is ordinary timeout work, and the next advance owns it.
    const clock = new ManualClock();
    let armedByPaint = false;
    clock.scheduleFrame(() => {
      clock.scheduleTimeout(() => {
        armedByPaint = true;
      }, 5);
    });

    clock.advance(100);
    expect(clock.pendingCount).toBe(1);

    clock.runFrame();
    expect(armedByPaint).toBe(false);

    clock.advance(5);
    expect(armedByPaint).toBe(true);
  });

  it("negative control: an idle clock has nothing armed, so the counts are not constant", () => {
    // The idle-CPU budget's precondition is `pendingCount === 0`. If the counter
    // could not reach zero, every budget assertion built on it would be vacuous.
    const clock = new ManualClock();
    expect(clock.pendingCount).toBe(0);
    expect(clock.pendingFrameCount).toBe(0);
  });
});
