// The write side of the console's scheduling: one queue, no interval. It accumulates events and
// drains them into the store's chokepoint on one frame boundary, so four streaming lanes cost
// one transition and one render. `refresh-scheduler.ts` is the read half; the two share no symbol.
//
// It takes the clock as a dependency rather than reaching for `requestAnimationFrame`, so a test
// drives it on frozen time and `ManualClock.pendingCount === 0` after settle checks that no
// timer fires. `SessionStoreRegistry` constructs it in the running console; nothing else may
// arm a timer.
//
// It keeps its batch when `drain` throws and never lets the exception reach the clock, which
// removes a due callback before invoking it, so one escaping throw would drop every other
// session's pending drain. `dispose()` is terminal: a late event cannot re-arm a timer that
// outlives its pane.

import { APPLY_COALESCE_MS } from "@renderer/lib/reads/refresh/caps.js";
import { type Clock, type ScheduledHandle } from "@renderer/lib/clock.js";
import type { ProjectedSessionEvent } from "../entities/entities.js";

/** The drain the queue performs. Exactly one call per coalescing window. */
export type ApplyDrain = (events: readonly ProjectedSessionEvent[]) => void;

/** Construction inputs for an `ApplyQueue`. */
export interface ApplyQueueOptions {
  readonly clock: Clock;
  readonly drain: ApplyDrain;
  /**
   * The coalescing window, in milliseconds. `0` or less arms `Clock.scheduleFrame` (a paint);
   * a positive value arms a timeout of that length, for a host with no frame source and for
   * draining at a named time on frozen clocks. Defaults to `APPLY_COALESCE_MS`.
   */
  readonly coalesceMs?: number;
  /**
   * Called when `drain` throws; the batch is kept either way. Unlike `RefreshScheduler.onError`
   * it never re-throws: this drain runs inside a clock callback, and an escaping throw would
   * drop the other sessions' pending callbacks. The queue keeps the batch, counts the failure
   * and tells this sink.
   */
  readonly onDrainError?: (error: unknown) => void;
}

/** Coalesces a session's wire events into one drain per frame; see the file header. */
export class ApplyQueue {
  readonly #clock: Clock;
  readonly #drain: ApplyDrain;
  readonly #coalesceMs: number;
  readonly #onDrainError: ((error: unknown) => void) | undefined;
  #buffer: ProjectedSessionEvent[] = [];
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
   * Drains that threw and whose batch was kept. Counted because a drain that rejects a batch is
   * a defect below this queue, and an exception would cost the clock's whole pass.
   */
  public get failedDrainCount(): number {
    return this.#failedDrainCount;
  }

  /** Events waiting for the next drain. */
  public get pendingCount(): number {
    return this.#buffer.length;
  }

  /**
   * Events handed to a disposed queue. Dropping them is correct, but a subscription still
   * delivering into a closed session is an upstream leak.
   */
  public get droppedAfterDisposeCount(): number {
    return this.#droppedAfterDisposeCount;
  }

  /** Enqueue one event. Arms a single frame or timeout; never an interval. */
  public enqueue(event: ProjectedSessionEvent): void {
    this.enqueueAll([event]);
  }

  /** Enqueue many. Still one drain. */
  public enqueueAll(events: readonly ProjectedSessionEvent[]): void {
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
   * Drain now, synchronously; the teardown and test path. The batch leaves the buffer before the
   * drain runs so a re-entrant enqueue lands behind it, and returns in front of newer events if
   * the drain throws. The retry rides the next enqueue, so a failing drain cannot spin a loop.
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

  /** Drop everything queued without draining. Terminal: a later enqueue counts and drops. */
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
