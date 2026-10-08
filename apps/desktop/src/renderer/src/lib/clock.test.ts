// `RealClock` mints its own handles because `requestAnimationFrame` and `setTimeout` number
// theirs in two independent spaces; the frame cases drive that. The platform's frame scheduler
// is stubbed, the clock under test is not. A timeout past what one platform timeout holds waits in
// capped steps, so a row's age a year out never fires at once.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealClock } from "./clock.js";
import { ageChangesAt, formatAge } from "./wire/figures.js";

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
});

describe("RealClock — a timeout longer than one platform timeout holds", () => {
  const LONGEST_PLATFORM_TIMEOUT_MILLISECONDS = 2_147_483_647;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("waits in capped steps and runs at its deadline, so a year-old age turns over on time", () => {
    vi.useFakeTimers({ now: Date.UTC(2027, 9, 1) });
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clock = new RealClock();
    const createdAt = "2026-10-01T00:00:00.000Z";
    const turnsOverAt = ageChangesAt(createdAt, clock.now());
    let ranAt: number | undefined;
    clock.scheduleTimeout(() => {
      ranAt = clock.now();
    }, turnsOverAt - clock.now());

    vi.advanceTimersByTime(LONGEST_PLATFORM_TIMEOUT_MILLISECONDS + 1);
    expect(ranAt, "the wake fired before its deadline").toBeUndefined();
    expect(formatAge(createdAt, clock.now())).toBe("1y");

    vi.advanceTimersByTime(turnsOverAt - clock.now());
    expect(ranAt).toBe(turnsOverAt);
    expect(formatAge(createdAt, turnsOverAt)).toBe("2y");
    const delays = setTimeoutSpy.mock.calls.map(([, delay]) => delay ?? 0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(LONGEST_PLATFORM_TIMEOUT_MILLISECONDS);
  });
});
