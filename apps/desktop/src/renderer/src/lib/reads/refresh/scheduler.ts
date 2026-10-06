// Coalesces "read again" requests into one serialized read. There is no interval polling.
//
// A read fires at `min(lastEvent + debounce, firstEvent + maxWait)`, so a stream cannot starve the
// trailing debounce. The scheduler takes a `Clock` instead of reading `Date.now`, so tests drive
// it on frozen time. `store/session/apply/queue.ts` is the write-side counterpart. Each fire
// opens a round on the scheduler's own read line; `lib/reads/scope.ts` defines rounds.

import { type Clock, type ScheduledHandle } from "../../clock.js";
import { REFRESH_DEBOUNCE_MS, REFRESH_MAX_WAIT_MS } from "./caps.js";
import { ReadScope, type ReadRound } from "../scope.js";

/**
 * Why a refresh was requested. Rendered in diagnostics; never inferred.
 *
 * `user-request` is a person pressing the control that reads again. It is its own reason, never
 * recorded as `subscribe` or `terminal-event`, which are claims about the system. It coalesces
 * like the rest and does not jump the queue.
 */
export type RefreshReason =
  | "subscribe"
  | "window-focus"
  | "reconnect"
  | "terminal-event"
  | "gap-repull"
  | "user-request";

/**
 * The read a scheduler performs. Rejections are surfaced, never swallowed. The round is handed
 * in, not requested, so a read that ignores it is a visible omission at one call site.
 */
export type RefreshPerformer = (
  reasons: readonly RefreshReason[],
  round: ReadRound,
) => Promise<void>;

/** Construction options for `RefreshScheduler`. */
export interface RefreshSchedulerOptions {
  readonly clock: Clock;
  readonly perform: RefreshPerformer;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  /** Called when `perform` rejects. Absent means the rejection is re-thrown. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Debounces and serializes reads: bursts of `request` calls become one `perform`, and a request
 * made mid-read becomes the next read. `dispose()` is terminal; a late request cannot re-arm it.
 */
export class RefreshScheduler {
  readonly #clock: Clock;
  /**
   * The read line every fired read is on. Built here, not accepted from a caller, who could
   * omit the supersession rule or abandon a line it does not own; a performer gets its round only.
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
    // Stamped before the in-flight branch: a request made mid-read already opens a window, so
    // its deadline counts from the request, not from the read's completion.
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
    // Abandoned rather than ignored on landing: the owner is gone, so the reply is never parsed.
    this.#readScope.abandon();
    if (this.#armedHandle !== undefined) {
      this.#clock.cancel(this.#armedHandle);
      this.#armedHandle = undefined;
    }
    this.#pendingReasons = [];
    this.#firstRequestAt = undefined;
    // Cleared so the in-flight read's `finally` does not try to re-arm.
    this.#requestedDuringFlight = false;
  }

  /** Arms the timeout with the reasons callers gave; it never invents a `RefreshReason`. */
  #arm(): void {
    if (this.#disposed) {
      return;
    }
    const now = this.#clock.now();
    const debounceDeadline = now + this.#debounceMs;
    // `request` is the only writer of the stamp, so the fallback is not a second way to start a
    // window. An overdue deadline gives a non-positive delay, floored at zero below: the queued
    // repair runs as soon as the in-flight read completes.
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
    // One round per fire; opening it ends the previous one, ordinarily settled since fires
    // serialize.
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
        // Re-arm rather than recurse: the read asked for mid-flight becomes the next read, never
        // a parallel one.
        this.#arm();
      }
    }
  }
}
