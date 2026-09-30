// The console's clock seam, an interface rather than direct calls to `Date.now` and
// `requestAnimationFrame` for two reasons:
//
//   1. In fixture mode the fixture clock is the only clock the renderer reads; a frozen tick
//      names one exact frame only if nothing reaches past it to the wall clock.
//   2. A test can count armed timers only if every timer in the console is minted through one
//      object.
//
// `ManualClock` is that counting instrument and the fixture's frozen clock: nothing advances
// until a test or scenario advances it.

/** An opaque handle for canceling scheduled work. */
export type ScheduledHandle = number;

/** The clock and scheduler every console subsystem takes as a dependency. */
export interface Clock {
  /** Milliseconds since an arbitrary epoch. Monotonic within one clock. */
  now(): number;
  /** Run on the next paint opportunity. */
  scheduleFrame(callback: () => void): ScheduledHandle;
  /** Run after at least `delayMs`. */
  scheduleTimeout(callback: () => void, delayMs: number): ScheduledHandle;
  /** Cancel a frame or timeout that has not run. Idempotent. */
  cancel(handle: ScheduledHandle): void;
}

/**
 * The two frame functions, declared rather than read off the DOM lib because `lib/` is also
 * compiled by node-context programs with no DOM. Optional: when absent, `RealClock` uses
 * timeouts.
 */
interface FrameScheduling {
  readonly requestAnimationFrame?: (callback: (time: number) => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
}

const frameScheduling = globalThis as unknown as FrameScheduling;

/**
 * The real clock. Frames use `requestAnimationFrame` where the document has one and a
 * zero-delay timeout where it does not, as in a `node`-environment test project.
 */
export class RealClock implements Clock {
  /**
   * Armed work, keyed by the handle this clock issued.
   *
   * The clock mints its own handles because `requestAnimationFrame` and `setTimeout` number
   * theirs in two independent spaces, so canceling an already-run frame with the platform
   * number could cancel an unrelated timeout.
   */
  readonly #armedWorkByHandle = new Map<ScheduledHandle, ArmedWork>();
  #nextHandle = 1;

  public now(): number {
    return Date.now();
  }

  public scheduleFrame(callback: () => void): ScheduledHandle {
    const scheduleAnimationFrame = frameScheduling.requestAnimationFrame;
    if (scheduleAnimationFrame === undefined) {
      return this.scheduleTimeout(callback, 0);
    }
    const handle = this.#mintHandle();
    const platformHandle = scheduleAnimationFrame(() => {
      this.#armedWorkByHandle.delete(handle);
      callback();
    });
    this.#armedWorkByHandle.set(handle, { isFrame: true, platformHandle });
    return handle;
  }

  public scheduleTimeout(callback: () => void, delayMs: number): ScheduledHandle {
    const handle = this.#mintHandle();
    const platformHandle = globalThis.setTimeout(() => {
      this.#armedWorkByHandle.delete(handle);
      callback();
    }, delayMs) as unknown as number;
    this.#armedWorkByHandle.set(handle, { isFrame: false, platformHandle });
    return handle;
  }

  public cancel(handle: ScheduledHandle): void {
    const armed = this.#armedWorkByHandle.get(handle);
    if (armed === undefined) {
      // Never armed, already run, or already canceled: no platform call with a handle not owned.
      return;
    }
    this.#armedWorkByHandle.delete(handle);
    if (armed.isFrame) {
      frameScheduling.cancelAnimationFrame?.(armed.platformHandle);
      return;
    }
    globalThis.clearTimeout(armed.platformHandle as unknown as ReturnType<typeof setTimeout>);
  }

  /** Work still armed; the counterpart of `ManualClock.pendingCount`. */
  public get pendingCount(): number {
    return this.#armedWorkByHandle.size;
  }

  #mintHandle(): ScheduledHandle {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    return handle;
  }
}

/**
 * A clock that advances only when told to; the fixture's frozen clock and the timer audit for
 * tests: `pendingCount` says whether anything is still armed.
 */
export class ManualClock implements Clock {
  #currentTime: number;
  #nextHandle = 1;
  #entries: ScheduledEntry[] = [];

  public constructor(startTime = 0) {
    this.#currentTime = startTime;
  }

  public now(): number {
    return this.#currentTime;
  }

  public scheduleFrame(callback: () => void): ScheduledHandle {
    return this.#schedule(callback, 0, true);
  }

  public scheduleTimeout(callback: () => void, delayMs: number): ScheduledHandle {
    return this.#schedule(callback, delayMs, false);
  }

  public cancel(handle: ScheduledHandle): void {
    this.#entries = this.#entries.filter((entry) => entry.handle !== handle);
  }

  /** Work still armed. Zero is the idle-CPU budget's precondition. */
  public get pendingCount(): number {
    return this.#entries.length;
  }

  /** Armed frame callbacks, separated so a test can tell a paint from a timeout. */
  public get pendingFrameCount(): number {
    return this.#entries.filter((entry) => entry.isFrame).length;
  }

  /** Run every armed frame callback, in arm order. Does not move time. */
  public runFrame(): void {
    const due = this.#entries.filter((entry) => entry.isFrame);
    this.#entries = this.#entries.filter((entry) => !entry.isFrame);
    for (const entry of due) {
      entry.callback();
    }
  }

  /**
   * Move time forward, running every timeout that falls due, in order, including work a
   * callback arms inside the window.
   *
   * Frames are excluded and run only by `runFrame`: a frame is armed due now, so selecting on
   * due time would paint every pending frame on any advance, including `advance(0)`.
   */
  public advance(deltaMs: number): void {
    const target = this.#currentTime + deltaMs;
    for (;;) {
      const due = this.#entries
        .filter((entry) => !entry.isFrame && entry.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.handle - right.handle);
      const next = due[0];
      if (next === undefined) {
        break;
      }
      this.#entries = this.#entries.filter((entry) => entry.handle !== next.handle);
      this.#currentTime = Math.max(this.#currentTime, next.dueAt);
      next.callback();
    }
    this.#currentTime = target;
  }

  #schedule(callback: () => void, delayMs: number, isFrame: boolean): ScheduledHandle {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#entries.push({ handle, dueAt: this.#currentTime + delayMs, callback, isFrame });
    return handle;
  }
}

/** One armed piece of work, and which platform call must be told to drop it. */
interface ArmedWork {
  readonly isFrame: boolean;
  readonly platformHandle: number;
}

interface ScheduledEntry {
  readonly handle: ScheduledHandle;
  readonly dueAt: number;
  readonly callback: () => void;
  readonly isFrame: boolean;
}
