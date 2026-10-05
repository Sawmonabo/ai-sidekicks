// One clock identity for a mount, over a clock the window replaces underneath it.
// `LiveAnnouncerProvider` pins the clock it is given, but `PlatformBridgeProvider` replaces its
// resolution in place with a different frozen clock, so the identity is this object and every
// method forwards to the window's clock as it is when the method runs.
//
// `cancel` routes to the clock that armed the work: a `ScheduledHandle` is a number each clock
// mints for itself, so a cancel sent elsewhere would cancel a stranger's timer. Work is not
// re-armed on the replacement, which would fire twice on the real clock.

import type { Clock, FrameScheduling, ScheduledHandle } from "./clock.js";

/**
 * A stable `Clock` over a clock the caller may replace.
 *
 * Constructed once per mount and given the window's current clock through {@link holdClock}.
 * The caller writes it from a layout effect, which runs before any passive effect of the same
 * commit, so a consumer's effect reads the clock that commit resolved.
 */
export class ForwardingClock implements Clock {
  #clock: Clock;
  readonly #armed = new Map<ScheduledHandle, ArmedElsewhere>();
  #nextHandle: ScheduledHandle = 1;

  public constructor(clock: Clock) {
    this.#clock = clock;
  }

  /** Take the window's clock as it is now; work already armed keeps its own clock. */
  public holdClock(clock: Clock): void {
    this.#clock = clock;
  }

  /** The current clock's reading; it can go backwards across a replacement (two time bases). */
  public now(): number {
    return this.#clock.now();
  }

  /** Arm on the current clock, and remember which one that was. */
  public scheduleFrame(callback: () => void): ScheduledHandle {
    const clock = this.#clock;
    return this.#arm(clock, (settle) => clock.scheduleFrame(settle), callback);
  }

  /** Arm on the current clock, and remember which one that was. */
  public scheduleTimeout(callback: () => void, delayMs: number): ScheduledHandle {
    const clock = this.#clock;
    return this.#arm(clock, (settle) => clock.scheduleTimeout(settle, delayMs), callback);
  }

  /** The current clock's own clock for `frames`; it does not follow a later replacement. */
  public withFrames(frames: FrameScheduling): Clock {
    return this.#clock.withFrames(frames);
  }

  /**
   * Cancel through the clock that armed the work. Idempotent: a handle this never minted, or
   * one already fired or canceled, cancels nothing.
   */
  public cancel(handle: ScheduledHandle): void {
    const armed = this.#armed.get(handle);
    if (armed === undefined) {
      return;
    }
    this.#armed.delete(handle);
    armed.clock.cancel(armed.handle);
  }

  // The entry is dropped before the callback runs, so a fired handle leaves nothing behind.

  #arm(
    clock: Clock,
    armOn: (settle: () => void) => ScheduledHandle,
    callback: () => void,
  ): ScheduledHandle {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    const underlying = armOn(() => {
      this.#armed.delete(handle);
      callback();
    });
    this.#armed.set(handle, { clock, handle: underlying });
    return handle;
  }
}

/** Which clock is behind one handed-out handle, and what that clock called the work. */
interface ArmedElsewhere {
  readonly clock: Clock;
  readonly handle: ScheduledHandle;
}
