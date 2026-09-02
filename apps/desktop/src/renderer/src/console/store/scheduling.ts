// The two schedulers the console is allowed to own.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules, "No interval polling":
// "Reads happen on subscribe, on window focus, on reconnect, and on the terminal
// events the owning spec names — through one refresh scheduler firing at
// `min(lastEvent + delay, firstEvent + maxWait)`, serialized, so a trailing
// debounce cannot starve under a stream."
//
// Two objects realise that sentence and nothing else in the console arms a timer:
//
//   • `RefreshScheduler` — the read side. Coalesces a burst of reasons-to-re-read
//     into one read, with an absolute deadline so a continuous stream still gets a
//     read, and serialization so two reads never overlap.
//   • `ApplyQueue` — the write side. Accumulates events and drains them into the
//     store's chokepoint on one frame boundary, so four streaming lanes cost one
//     transition and one render.
//
// Neither has an interval. Both take the clock as a dependency rather than reading
// `Date.now` or reaching for `requestAnimationFrame`, so a test drives them on
// frozen time with no real timers at all — and `ManualClock.pendingCount === 0`
// after settle is how the idle-CPU budget's "no timer fires" claim is CHECKED
// rather than asserted. `SessionStoreRegistry` is what constructs both in the
// running console; nothing else in the tree may arm a timer.
//
// Both are terminal on `dispose()`. A pane that unmounts mid-stream must not be
// able to re-arm a timer from a late event — "a timer that outlives its pane" is
// one of the failure modes this substrate exists to make unrepresentable, and a
// `dispose` that merely cancelled the current arm would leave the next `enqueue`
// to start it again.

import {
  APPLY_COALESCE_MS,
  type ConsoleClock,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
  type ScheduledHandle,
} from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";

/** Why a refresh was requested. Rendered in diagnostics; never inferred. */
export type RefreshReason =
  | "subscribe"
  | "window-focus"
  | "reconnect"
  | "terminal-event"
  | "gap-repull";

/** The read a scheduler performs. Rejections are surfaced, never swallowed. */
export type RefreshPerformer = (reasons: readonly RefreshReason[]) => Promise<void>;

export interface RefreshSchedulerOptions {
  readonly clock: ConsoleClock;
  readonly perform: RefreshPerformer;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  /** Called when `perform` rejects. Absent means the rejection is re-thrown. */
  readonly onError?: (error: unknown) => void;
}

export class RefreshScheduler {
  readonly #clock: ConsoleClock;
  readonly #perform: RefreshPerformer;
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #onError: ((error: unknown) => void) | undefined;

  #pendingReasons: RefreshReason[] = [];
  #firstRequestAt: number | undefined;
  #armedHandle: ScheduledHandle | undefined;
  #inFlight = false;
  #requestedDuringFlight = false;
  #performCount = 0;
  #disposed = false;

  public constructor(options: RefreshSchedulerOptions) {
    this.#clock = options.clock;
    this.#perform = options.perform;
    this.#debounceMs = options.debounceMs ?? REFRESH_DEBOUNCE_MS;
    this.#maxWaitMs = options.maxWaitMs ?? REFRESH_MAX_WAIT_MS;
    this.#onError = options.onError;
  }

  /** How many reads have actually been performed. The coalescing assertion. */
  public get performCount(): number {
    return this.#performCount;
  }

  /** True while a timeout is armed or a read is in flight. */
  public get isArmed(): boolean {
    return this.#armedHandle !== undefined || this.#inFlight;
  }

  /** Reasons waiting for the next read, in request order. Rendered, never guessed. */
  public get pendingReasons(): readonly RefreshReason[] {
    return this.#pendingReasons;
  }

  /**
   * Ask for a read. Repeated calls inside the window collapse into one; the
   * absolute deadline measured from the FIRST request is what a continuous stream
   * cannot push out.
   */
  public request(reason: RefreshReason): void {
    if (this.#disposed) {
      return;
    }
    this.#pendingReasons.push(reason);
    if (this.#inFlight) {
      this.#requestedDuringFlight = true;
      return;
    }
    this.#arm();
  }

  /** Drop anything armed. The pane-unmount path; performs no read, and is terminal. */
  public dispose(): void {
    this.#disposed = true;
    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
      this.#armedHandle = undefined;
    }
    this.#pendingReasons = [];
    this.#firstRequestAt = undefined;
    // Cleared too, or the in-flight read's `finally` re-arms a disposed scheduler
    // and the pane that unmounted keeps a timer alive behind it.
    this.#requestedDuringFlight = false;
  }

  /**
   * Arm the timeout, without inventing a reason.
   *
   * Separate from `request` because the re-arm after an in-flight read has to
   * happen with the reasons the CALLERS gave. An earlier shape re-armed by calling
   * `request("reconnect")`, which fabricated a diagnostics reason for a read that
   * may have been asked for by a terminal event — exactly the inference the
   * `RefreshReason` doc forbids.
   */
  #arm(): void {
    if (this.#disposed) {
      return;
    }
    const now = this.#clock.now();
    this.#firstRequestAt ??= now;
    const debounceDeadline = now + this.#debounceMs;
    const absoluteDeadline = this.#firstRequestAt + this.#maxWaitMs;
    const fireAt = Math.min(debounceDeadline, absoluteDeadline);

    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
    }
    this.#armedHandle = this.#clock.scheduleTimeout(
      () => {
        this.#armedHandle = undefined;
        void this.#fire();
      },
      Math.max(0, fireAt - now),
    );
  }

  async #fire(): Promise<void> {
    const reasons = this.#pendingReasons;
    this.#pendingReasons = [];
    this.#firstRequestAt = undefined;
    this.#inFlight = true;
    this.#performCount += 1;
    try {
      await this.#perform(reasons);
    } catch (error) {
      if (this.#onError === undefined) {
        throw error;
      }
      this.#onError(error);
    } finally {
      this.#inFlight = false;
      if (this.#requestedDuringFlight) {
        this.#requestedDuringFlight = false;
        // Re-arm rather than recurse: serialization is the point, so the read
        // that was asked for mid-flight becomes the NEXT read, never a parallel
        // one.
        this.#arm();
      }
    }
  }
}

/** The drain the queue performs. Exactly one call per coalescing window. */
export type ApplyDrain = (events: readonly ConsoleSessionEvent[]) => void;

export interface ApplyQueueOptions {
  readonly clock: ConsoleClock;
  readonly drain: ApplyDrain;
  /**
   * The coalescing window, in milliseconds.
   *
   * `0` (or less) means the unit is a PAINT: the queue arms
   * `ConsoleClock.scheduleFrame`, which is `requestAnimationFrame` on the real
   * clock and an explicit `runFrame()` on the manual one. Any positive value arms
   * a timeout of that length instead, which is what a host with no frame source
   * wants and what makes a drain observable at a named number of milliseconds of
   * frozen time. Defaults to `APPLY_COALESCE_MS`, one 60 Hz frame.
   */
  readonly coalesceMs?: number;
}

export class ApplyQueue {
  readonly #clock: ConsoleClock;
  readonly #drain: ApplyDrain;
  readonly #coalesceMs: number;
  #buffer: ConsoleSessionEvent[] = [];
  #armedHandle: ScheduledHandle | undefined;
  #drainCount = 0;
  #droppedAfterDisposeCount = 0;
  #disposed = false;

  public constructor(options: ApplyQueueOptions) {
    this.#clock = options.clock;
    this.#drain = options.drain;
    this.#coalesceMs = options.coalesceMs ?? APPLY_COALESCE_MS;
  }

  /** Drains performed. One per window that held events; the coalescing assertion. */
  public get drainCount(): number {
    return this.#drainCount;
  }

  /** Events waiting for the next drain. */
  public get pendingCount(): number {
    return this.#buffer.length;
  }

  /**
   * Events handed to a disposed queue.
   *
   * Counted rather than silently ignored: dropping them is correct — the store
   * they were bound for is gone — but a subscription still delivering into a
   * closed session is a leak upstream, and a count is how it becomes visible.
   */
  public get droppedAfterDisposeCount(): number {
    return this.#droppedAfterDisposeCount;
  }

  /** Enqueue one event. Arms a single frame or timeout; never an interval. */
  public enqueue(event: ConsoleSessionEvent): void {
    this.enqueueAll([event]);
  }

  /** Enqueue many. Still one drain. */
  public enqueueAll(events: readonly ConsoleSessionEvent[]): void {
    if (events.length === 0) {
      return;
    }
    if (this.#disposed) {
      this.#droppedAfterDisposeCount += events.length;
      return;
    }
    this.#buffer.push(...events);
    this.#arm();
  }

  /** Drain now, synchronously. The teardown and test path. */
  public flush(): void {
    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
      this.#armedHandle = undefined;
    }
    if (this.#buffer.length === 0) {
      return;
    }
    const batch = this.#buffer;
    this.#buffer = [];
    this.#drainCount += 1;
    this.#drain(batch);
  }

  /**
   * Drop everything queued without draining. A pane that unmounted mid-stream.
   *
   * Terminal: a later `enqueue` counts and drops rather than re-arming, so no
   * timer can outlive the store this queue fed.
   */
  public dispose(): void {
    this.#disposed = true;
    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
      this.#armedHandle = undefined;
    }
    this.#buffer = [];
  }

  #arm(): void {
    if (this.#armedHandle !== undefined) {
      return;
    }
    const run = (): void => {
      this.#armedHandle = undefined;
      this.flush();
    };
    this.#armedHandle =
      this.#coalesceMs <= 0
        ? this.#clock.scheduleFrame(run)
        : this.#clock.scheduleTimeout(run, this.#coalesceMs);
  }
}
