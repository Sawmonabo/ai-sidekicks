// The clock seam, both halves.
//
// `ManualClock` is the console's timer audit, so a test of it is a test of the
// instrument every budget claim is measured with: if `pendingCount` could miss an
// armed timer, "no timer fires except the refresh scheduler's deadline and the
// presence heartbeat" would be unfalsifiable rather than checked.
//
// `RealClock` is the arm that runs in a shipped window, and its interesting
// property is the one a reader does not expect: `requestAnimationFrame` and
// `setTimeout` number their handles in two independent spaces, so a clock that
// returned the platform's number could not tell them apart afterwards. The frame
// cases below drive exactly that.
//
// The platform's frame scheduler is stood in for; the clock under test never is.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock, RealClock, type ScheduledHandle } from "./clock.js";

/**
 * A stand-in for `requestAnimationFrame` that hands out ONE platform id and reuses
 * it once the frame has run.
 *
 * Not a contrivance: an id is free for reuse the moment its callback fires, and
 * browsers do reuse them. It is the cheapest way to make the two-id-space hazard
 * deterministic rather than dependent on how many timers a test file happened to
 * arm before this one.
 */
class SingleIdFrameScheduler {
  public static readonly PLATFORM_HANDLE = 7;

  readonly #pendingCallbacks: (() => void)[] = [];
  readonly #cancelledPlatformHandles: number[] = [];
  #originalRequest: typeof globalThis.requestAnimationFrame | undefined;
  #originalCancel: typeof globalThis.cancelAnimationFrame | undefined;

  public install(): void {
    this.#originalRequest = globalThis.requestAnimationFrame;
    this.#originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = (callback): number => {
      this.#pendingCallbacks.push(() => {
        callback(0);
      });
      return SingleIdFrameScheduler.PLATFORM_HANDLE;
    };
    globalThis.cancelAnimationFrame = (platformHandle): void => {
      this.#cancelledPlatformHandles.push(platformHandle);
      this.#pendingCallbacks.length = 0;
    };
  }

  public restore(): void {
    if (this.#originalRequest !== undefined) {
      globalThis.requestAnimationFrame = this.#originalRequest;
    }
    if (this.#originalCancel !== undefined) {
      globalThis.cancelAnimationFrame = this.#originalCancel;
    }
  }

  /** Run every armed frame callback, the way a paint would. */
  public paint(): void {
    const due = [...this.#pendingCallbacks];
    this.#pendingCallbacks.length = 0;
    for (const callback of due) {
      callback();
    }
  }

  public get cancelledPlatformHandles(): readonly number[] {
    return this.#cancelledPlatformHandles;
  }
}

/** Remove both frame functions, as a node-context program has them removed. */
function withoutFrameScheduling(): () => void {
  const scheduling = globalThis as {
    requestAnimationFrame?: typeof globalThis.requestAnimationFrame;
    cancelAnimationFrame?: typeof globalThis.cancelAnimationFrame;
  };
  const originalRequest = scheduling.requestAnimationFrame;
  const originalCancel = scheduling.cancelAnimationFrame;
  delete scheduling.requestAnimationFrame;
  delete scheduling.cancelAnimationFrame;
  return () => {
    // Restored only where there was something to restore: a program that never had
    // the pair is left without it rather than given an `undefined` to call.
    if (originalRequest !== undefined) {
      scheduling.requestAnimationFrame = originalRequest;
    }
    if (originalCancel !== undefined) {
      scheduling.cancelAnimationFrame = originalCancel;
    }
  };
}

describe("RealClock — now", () => {
  it("reads the wall clock rather than a frozen value", () => {
    const clock = new RealClock();
    const before = Date.now();
    const reading = clock.now();
    const after = Date.now();
    expect(reading).toBeGreaterThanOrEqual(before);
    expect(reading).toBeLessThanOrEqual(after);
  });
});

describe("RealClock — frames", () => {
  // A fresh stand-in per case: the recorded cancellations are evidence, and evidence
  // carried over from the previous case is how a passing assertion stops meaning
  // what it says.
  let frameScheduler = new SingleIdFrameScheduler();

  beforeEach(() => {
    frameScheduler = new SingleIdFrameScheduler();
    frameScheduler.install();
  });

  afterEach(() => {
    frameScheduler.restore();
  });

  it("schedules through requestAnimationFrame when the document has one", () => {
    const clock = new RealClock();
    let painted = false;

    clock.scheduleFrame(() => {
      painted = true;
    });
    expect(painted).toBe(false);
    frameScheduler.paint();

    expect(painted).toBe(true);
  });

  it("cancels an armed frame through cancelAnimationFrame", () => {
    const clock = new RealClock();
    let painted = false;

    const handle = clock.scheduleFrame(() => {
      painted = true;
    });
    clock.cancel(handle);
    frameScheduler.paint();

    expect(painted).toBe(false);
    expect(frameScheduler.cancelledPlatformHandles).toStrictEqual([
      SingleIdFrameScheduler.PLATFORM_HANDLE,
    ]);
  });

  it("issues a distinct handle per piece of work even when the platform reuses one", () => {
    // The hazard, made deterministic. Passing the platform's number through would
    // give both frames the same handle here, and the cancellation below — of work
    // that has ALREADY RUN — would silently take the live one with it.
    const clock = new RealClock();
    let secondPainted = false;

    const alreadyRun = clock.scheduleFrame(() => undefined);
    frameScheduler.paint();
    const stillArmed = clock.scheduleFrame(() => {
      secondPainted = true;
    });

    expect(stillArmed).not.toBe(alreadyRun);

    clock.cancel(alreadyRun);
    frameScheduler.paint();

    expect(secondPainted).toBe(true);
    expect(frameScheduler.cancelledPlatformHandles).toStrictEqual([]);
  });

  it("negative control: the same cancel DOES stop the frame it names", () => {
    // Without this, a `cancel` that had become a no-op for every input would pass
    // the case above while breaking cancellation entirely.
    const clock = new RealClock();
    let painted = false;

    const armed = clock.scheduleFrame(() => {
      painted = true;
    });
    clock.cancel(armed);
    frameScheduler.paint();

    expect(painted).toBe(false);
  });

  it("falls back to a timeout where there are no animation frames", async () => {
    const restoreFrameScheduling = withoutFrameScheduling();
    try {
      const clock = new RealClock();
      const ran = await new Promise<boolean>((resolve) => {
        clock.scheduleFrame(() => {
          resolve(true);
        });
      });
      expect(ran).toBe(true);
    } finally {
      restoreFrameScheduling();
    }
  });
});

describe("RealClock — timeouts", () => {
  it("runs a timeout, and a cancelled one does not run beside it", async () => {
    const clock = new RealClock();
    let cancelledRan = false;
    let sentinelRan = false;

    const cancelled = clock.scheduleTimeout(() => {
      cancelledRan = true;
    }, 1);
    clock.scheduleTimeout(() => {
      sentinelRan = true;
    }, 1);
    clock.cancel(cancelled);

    await new Promise<void>((resolve) => {
      clock.scheduleTimeout(resolve, 20);
    });

    // The sentinel is the negative control: it was armed at the same delay, so a
    // clock that never ran anything would fail here rather than passing on the
    // cancelled one's silence.
    expect(sentinelRan).toBe(true);
    expect(cancelledRan).toBe(false);
  });

  it("forgets work once it has run, so a later cancel is a no-op", async () => {
    const clock = new RealClock();
    const handle = await new Promise<ScheduledHandle>((resolve) => {
      const armed: ScheduledHandle = clock.scheduleTimeout(() => {
        resolve(armed);
      }, 1);
    });

    expect(clock.pendingCount).toBe(0);
    expect(() => {
      clock.cancel(handle);
    }).not.toThrow();
  });
});

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

  it("negative control: an idle clock has nothing armed, so the counts are not constant", () => {
    // The idle-CPU budget's precondition is `pendingCount === 0`. If the counter
    // could not reach zero, every budget assertion built on it would be vacuous.
    const clock = new ManualClock();
    expect(clock.pendingCount).toBe(0);
    expect(clock.pendingFrameCount).toBe(0);
  });
});
