// The console's clock seam.
//
// Two reasons this is an interface rather than direct calls to `Date.now` and
// `requestAnimationFrame`:
//
//   1. `Spec-023 §Console Design (Meridian)` §The fixture bridge: "the fixture
//      clock is the only clock the renderer reads in fixture mode". A frozen tick
//      only names one exact frame if nothing anywhere reaches past it to the wall
//      clock — so the seam has to exist at the bottom, not at the scenario engine.
//   2. The budgets forbid polling. "no timer fires except the refresh scheduler's
//      deadline and the presence heartbeat" is a claim a test can only check if
//      every timer in the console is minted through one object it can count.
//
// `ManualClock` is that counting instrument and the fixture's frozen clock at
// once: nothing advances until a test or a scenario advances it.

/** An opaque handle for cancelling scheduled work. */
export type ScheduledHandle = number;

/** The clock and scheduler every console subsystem takes as a dependency. */
export interface ConsoleClock {
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
 * The two frame functions, declared rather than read off the DOM lib.
 *
 * `core/` sits at the bottom of the console's import graph and is reached from
 * node-context tiers whose program has no DOM. Declaring the pair as OPTIONAL is
 * also the honest statement of what `RealClock` assumes: they may be absent, and
 * the timeout path below is what runs when they are.
 */
interface FrameScheduling {
  readonly requestAnimationFrame?: (callback: (time: number) => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
}

const frameScheduling = globalThis as unknown as FrameScheduling;

/** One armed piece of work, and which platform call has to be told to drop it. */
interface ArmedWork {
  readonly isFrame: boolean;
  readonly platformHandle: number;
}

/**
 * The real clock. `requestAnimationFrame` where the document has one and a
 * zero-delay timeout where it does not — a `node`-environment test project has no
 * animation frames, and a substrate that threw there would be untestable outside
 * a browser.
 */
export class RealClock implements ConsoleClock {
  /**
   * Armed work, keyed by the handle this clock issued.
   *
   * The clock mints its OWN handles rather than passing the platform's through, and
   * that is the difference between `cancel` being idempotent and only looking it.
   * `requestAnimationFrame` and `setTimeout` number their handles in two
   * independent spaces that both start at 1, so a returned platform number does not
   * say which space it came from. Cancelling a frame that had already run therefore
   * fell through to `clearTimeout` carrying a number some unrelated timeout was
   * still holding — a cancellation of someone else's work, with nothing to see.
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
      // Never armed, already run, or already cancelled. All three are the no-op
      // `cancel`'s idempotence promises, and none of them may reach a platform
      // call carrying a handle this clock no longer owns.
      return;
    }
    this.#armedWorkByHandle.delete(handle);
    if (armed.isFrame) {
      frameScheduling.cancelAnimationFrame?.(armed.platformHandle);
      return;
    }
    globalThis.clearTimeout(armed.platformHandle as unknown as ReturnType<typeof setTimeout>);
  }

  /** Work still armed. The frame path's counterpart to `ManualClock.pendingCount`. */
  public get pendingCount(): number {
    return this.#armedWorkByHandle.size;
  }

  #mintHandle(): ScheduledHandle {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    return handle;
  }
}

interface ScheduledEntry {
  readonly handle: ScheduledHandle;
  readonly dueAt: number;
  readonly callback: () => void;
  readonly isFrame: boolean;
}

/**
 * A clock that advances only when told to.
 *
 * The fixture bridge's frozen clock and every deterministic test run on this. It
 * is also the console's timer audit: `pendingCount` answers "does anything still
 * have a timer armed?", which is how the idle-CPU budget's "no timer fires" claim
 * is checked rather than asserted.
 */
export class ManualClock implements ConsoleClock {
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
   * Move time forward, running everything that falls due in order. Work armed by
   * a callback during the advance runs too, if it falls due inside the window —
   * which is what makes a re-arming scheduler observable rather than invisible.
   */
  public advance(deltaMs: number): void {
    const target = this.#currentTime + deltaMs;
    for (;;) {
      const due = this.#entries
        .filter((entry) => entry.dueAt <= target)
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
