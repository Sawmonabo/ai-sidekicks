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
// Neither loses work to a callback that fails. The read side surfaces a rejected
// `perform` through `onError`; the write side keeps its batch when `drain` throws
// and never lets the exception reach the clock, because the clock removes a due
// callback before invoking it and one escaping throw would take every other
// session's pending drain with it.
//
// Both are terminal on `dispose()`. A pane that unmounts mid-stream must not be
// able to re-arm a timer from a late event — "a timer that outlives its pane" is
// one of the failure modes this substrate exists to make unrepresentable, and a
// `dispose` that merely cancelled the current arm would leave the next `enqueue`
// to start it again.
//
// AND THE READ SIDE OWNS ITS SUPERSESSION. Every fire opens a round on this
// scheduler's own read line and hands it to the performer, so a read that cannot be
// superseded and cannot be abandoned is not a thing this class can produce. What a
// round is, and which reads ignore theirs, is `read-cancellation.ts`'s to say.

import {
  APPLY_COALESCE_MS,
  type ConsoleClock,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
  type ScheduledHandle,
} from "../core/index.js";
import type { ConsoleSessionEvent } from "./entities.js";
import { ReadScope, type ReadRound } from "./read-cancellation.js";

/**
 * Why a refresh was requested. Rendered in diagnostics; never inferred.
 *
 * `participant-request` is the one a person caused: somebody pressed the control that
 * reads again. It is its own member rather than borrowed from a neighbour, and the rule
 * is that a press is a reason of its own — never disguised as a subscription, which
 * says a surface has just opened, and never as a terminal event, which says the wire
 * delivered something. Both of those are claims about the SYSTEM, and a diagnostics
 * trail that recorded a person's press as either would report a read nobody asked for
 * beside the reads nobody did, with no way afterwards to tell which was which. The
 * scheduler treats it exactly as it treats the rest — it coalesces, it does not jump a
 * queue — because a reason names why a read happened and never how urgent it was.
 */
export type RefreshReason =
  | "subscribe"
  | "window-focus"
  | "reconnect"
  | "terminal-event"
  | "gap-repull"
  | "participant-request";

/**
 * The read a scheduler performs. Rejections are surfaced, never swallowed.
 *
 * THE ROUND IS SUPPLIED, NEVER ASKED FOR — already taken, so there is no arrangement
 * a caller can decline and no pairing a caller can get half of. Ignoring it is a read
 * that cannot be superseded, which is now a visible omission at one call site.
 */
export type RefreshPerformer = (
  reasons: readonly RefreshReason[],
  round: ReadRound,
) => Promise<void>;

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
  /**
   * The read line every read this scheduler fires is on.
   *
   * CONSTRUCTED HERE AND NOT ACCEPTED FROM A CALLER, which is the whole of the
   * pairing: a supersession rule a caller supplies is one a caller can omit, and
   * thirteen readers across five families each decided that for themselves — some
   * with a latch, most with a `#disposed` flag read after the `await`, one with
   * nothing. It is not published either, since a caller holding the scope could
   * abandon a line it does not own; a performer is handed its round and nothing more.
   */
  readonly #readScope = new ReadScope();
  readonly #perform: RefreshPerformer;
  readonly #debounceMs: number;
  readonly #maxWaitMs: number;
  readonly #onError: ((error: unknown) => void) | undefined;

  #pendingReasons: RefreshReason[] = [];
  /** When the current window's FIRST request arrived. Written only by `request`. */
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
    // Stamped HERE, ahead of the in-flight branch below, rather than inside
    // `#arm()`. The absolute deadline is measured from the first request of a
    // window, and a request made while a read is outstanding OPENS one: it is
    // already waiting, it just has no timer yet. Stamping only where a timer is
    // armed dated the deadline from the in-flight read's COMPLETION, so a repair
    // queued behind a read that itself outlasted `maxWaitMs` was made to wait a
    // further debounce interval past the deadline it was already overdue against.
    this.#firstRequestAt ??= this.#clock.now();
    if (this.#inFlight) {
      this.#requestedDuringFlight = true;
      return;
    }
    this.#arm();
  }

  /** Drop anything armed. The pane-unmount path; performs no read, and is terminal. */
  public dispose(): void {
    this.#disposed = true;
    // Abandoned rather than ignored on landing: the owner is gone, so the reply is
    // never parsed and no projection is built. Ignoring kept the work either way.
    this.#readScope.abandon();
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
    const debounceDeadline = now + this.#debounceMs;
    // `request` is the single writer of the stamp and every path into `#arm()`
    // comes from one, so the fallback is a total-function guard rather than a
    // second place a window can start. An overdue deadline yields a non-positive
    // delay, which `Math.max` below floors at zero — the queued repair runs at the
    // in-flight read's completion instead of a debounce interval after it.
    const absoluteDeadline = (this.#firstRequestAt ?? now) + this.#maxWaitMs;
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
    // Per fire and not per scheduler: a round is one read, and opening it here ends
    // the previous one — ordinarily a settled one, since fires serialize.
    const round = this.#readScope.openRound();
    try {
      await this.#perform(reasons, round);
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
