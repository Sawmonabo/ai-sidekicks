// The write side of the console's scheduling: one queue, no interval.
//
// The no-interval-polling rule has a write half as well as a read half. `ApplyQueue` is
// the write half: it accumulates events and drains them into the store's chokepoint on
// one frame boundary, so four streaming lanes cost one transition and one render.
// `refresh-scheduler.ts` beside it is the read half; the two share no symbol, which is
// why they are two modules and not one.
//
// It has no interval. It takes the clock as a dependency rather than reaching for
// `requestAnimationFrame`, so a test drives it on frozen time with no real timers
// at all — and `ManualClock.pendingCount === 0` after settle is how the idle-CPU
// budget's "no timer fires" claim is CHECKED rather than asserted.
// `SessionStoreRegistry` is what constructs it in the running console; nothing
// else in the tree may arm a timer.
//
// It loses no work to a callback that fails: it keeps its batch when `drain`
// throws and never lets the exception reach the clock, because the clock removes
// a due callback before invoking it and one escaping throw would take every other
// session's pending drain with it.
//
// It is terminal on `dispose()`. A pane that unmounts mid-stream must not be able
// to re-arm a timer from a late event — "a timer that outlives its pane" is one of
// the failure modes this substrate exists to make unrepresentable, and a `dispose`
// that merely cancelled the current arm would leave the next `enqueue` to start it
// again.

import { APPLY_COALESCE_MS, type ConsoleClock, type ScheduledHandle } from "../../core/index.js";
import type { ConsoleSessionEvent } from "../entities/index.js";

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
  /**
   * Called when `drain` throws. The batch is kept either way.
   *
   * Deliberately NOT the `RefreshScheduler.onError` contract, whose absent arm
   * re-throws: that scheduler's failure surfaces from an `async` function, where
   * a rejection reaches the host as an unhandled rejection and disturbs nothing
   * else. This drain runs inside a frame or timeout callback the console's clock
   * is iterating, and `ManualClock.runFrame` takes its due entries out of the
   * queue BEFORE invoking them — so an escaping throw does not defer the other
   * pending callbacks, it drops them, and one defective session's drain would
   * silently cancel every other session's. So the queue never re-throws; it keeps
   * the batch, counts the failure, and tells this sink.
   */
  readonly onDrainError?: (error: unknown) => void;
}

export class ApplyQueue {
  readonly #clock: ConsoleClock;
  readonly #drain: ApplyDrain;
  readonly #coalesceMs: number;
  readonly #onDrainError: ((error: unknown) => void) | undefined;
  #buffer: ConsoleSessionEvent[] = [];
  #armedHandle: ScheduledHandle | undefined;
  #drainCount = 0;
  #failedDrainCount = 0;
  #droppedAfterDisposeCount = 0;
  #disposed = false;

  public constructor(options: ApplyQueueOptions) {
    this.#clock = options.clock;
    this.#drain = options.drain;
    this.#coalesceMs = options.coalesceMs ?? APPLY_COALESCE_MS;
    this.#onDrainError = options.onDrainError;
  }

  /** Drains performed. One per window that held events; the coalescing assertion. */
  public get drainCount(): number {
    return this.#drainCount;
  }

  /**
   * Drains that threw and whose batch was kept.
   *
   * Counted rather than merely handled, on the posture `droppedAfterDisposeCount`
   * already takes: keeping the events is the correct response, but a drain that
   * rejects a batch is a defect below this queue, and a count is how it becomes
   * visible without an exception that would cost the clock's whole pass.
   */
  public get failedDrainCount(): number {
    return this.#failedDrainCount;
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

  /**
   * Drain now, synchronously. The teardown and test path.
   *
   * A batch is taken out of the buffer before the drain runs so a re-entrant
   * enqueue lands behind it rather than inside it — and put BACK, in front of
   * whatever arrived meanwhile, if the drain throws. Nothing is lost and nothing
   * escapes: the retry rides the next enqueue rather than a re-arm here, so a
   * drain that fails deterministically cannot spin a frame loop.
   */
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
    try {
      this.#drain(batch);
      this.#drainCount += 1;
    } catch (error) {
      this.#buffer = [...batch, ...this.#buffer];
      this.#failedDrainCount += 1;
      this.#onDrainError?.(error);
    }
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
