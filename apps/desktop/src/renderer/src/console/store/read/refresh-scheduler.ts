// The read side of the console's scheduling: one scheduler, no interval.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules, "No interval polling":
// "Reads happen on subscribe, on window focus, on reconnect, and on the terminal
// events the owning spec names — through one refresh scheduler firing at
// `min(lastEvent + delay, firstEvent + maxWait)`, serialized, so a trailing
// debounce cannot starve under a stream."
//
// `RefreshScheduler` is that scheduler. It coalesces a burst of reasons-to-re-read
// into one read, with an absolute deadline so a continuous stream still gets a
// read, and serialization so two reads never overlap. `apply-queue.ts` beside it
// is the write side of the same sentence; the two share no symbol, which is why
// they are two modules and not one.
//
// It has no interval. It takes the clock as a dependency rather than reading
// `Date.now` or reaching for `requestAnimationFrame`, so a test drives it on
// frozen time with no real timers at all — and `ManualClock.pendingCount === 0`
// after settle is how the idle-CPU budget's "no timer fires" claim is CHECKED
// rather than asserted. `SessionStoreRegistry` is what constructs it in the
// running console; nothing else in the tree may arm a timer.
//
// It loses no work to a callback that fails: a rejected `perform` surfaces
// through `onError` rather than vanishing.
//
// It is terminal on `dispose()`. A pane that unmounts mid-stream must not be able
// to re-arm a timer from a late event — "a timer that outlives its pane" is one of
// the failure modes this substrate exists to make unrepresentable, and a `dispose`
// that merely cancelled the current arm would leave the next `request` to start it
// again.
//
// AND IT OWNS ITS SUPERSESSION. Every fire opens a round on this scheduler's own
// read line and hands it to the performer, so a read that cannot be superseded and
// cannot be abandoned is not a thing this class can produce. What a round is, and
// which reads ignore theirs, is `read-cancellation.ts`'s to say.

import {
  type ConsoleClock,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_WAIT_MS,
  type ScheduledHandle,
} from "../../core/index.js";
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
