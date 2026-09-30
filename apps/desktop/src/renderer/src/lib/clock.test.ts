// `RealClock` mints its own handles because `requestAnimationFrame` and `setTimeout` number
// theirs in two independent spaces; the frame cases drive that. The platform's frame scheduler
// is stubbed, the clock under test is not. `ManualClock` is covered by
// `clock.manual-clock.test.ts`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RealClock, type ScheduledHandle } from "./clock.js";

/**
 * A stand-in for `requestAnimationFrame` that hands out one platform id and reuses it once
 * the frame has run, which makes the two-id-space hazard deterministic.
 */
class SingleIdFrameScheduler {
  public static readonly PLATFORM_HANDLE = 7;

  readonly #pendingCallbacks: (() => void)[] = [];
  readonly #canceledPlatformHandles: number[] = [];
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
      this.#canceledPlatformHandles.push(platformHandle);
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

  public get canceledPlatformHandles(): readonly number[] {
    return this.#canceledPlatformHandles;
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
    // A program that never had the pair is left without it.
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
  // A fresh stand-in per case so recorded cancellations do not carry over.
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
    expect(frameScheduler.canceledPlatformHandles).toStrictEqual([
      SingleIdFrameScheduler.PLATFORM_HANDLE,
    ]);
  });

  it("issues a distinct handle per piece of work even when the platform reuses one", () => {
    // Passing the platform number through would give both frames one handle, and canceling the
    // already-run one would take the live one with it.
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
    expect(frameScheduler.canceledPlatformHandles).toStrictEqual([]);
  });

  it("negative control: the same cancel DOES stop the frame it names", () => {
    // Guards against a `cancel` that is a no-op for every input passing the case above.
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
  it("runs a timeout, and a canceled one does not run beside it", async () => {
    const clock = new RealClock();
    let canceledRan = false;
    let sentinelRan = false;

    const canceled = clock.scheduleTimeout(() => {
      canceledRan = true;
    }, 1);
    clock.scheduleTimeout(() => {
      sentinelRan = true;
    }, 1);
    clock.cancel(canceled);

    await new Promise<void>((resolve) => {
      clock.scheduleTimeout(resolve, 20);
    });

    // The sentinel is the negative control: a clock that ran nothing would fail here.
    expect(sentinelRan).toBe(true);
    expect(canceledRan).toBe(false);
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
