// A read that a push signal refreshes, and never a poll. It renders nothing, so it sits in
// `store/` below the features that use it. Five rules: subscribe before reading, so no update
// lands in the gap; treat the signal as opaque, answering a push with a fresh read; coalesce
// every refresh through `RefreshScheduler`; serialize, so no stale reply wins; and replace the
// value in place, never returning a loaded view to its loading shape (`not-loaded` is entered
// at construction and after an open that succeeded following a refusal).
//
// `dispose()` is terminal: it releases the subscription, disposes the scheduler and abandons
// the read in flight. The read body receives that round's signal; a read that ignores it still
// has its answer discarded. The clock is injected, so tests run on frozen time.
//
// A `subscribe` that throws synchronously would take the view down from a mount effect, and
// the installed stub preload bridge implements every daemon method by throwing. So the open
// catches it, settles `failed` with the thrower's words, and requests no read, since a value
// fetched behind a subscription that never opened could never be refreshed.
//
// A refused open is not the end of the read. "Started" means the subscription handle and
// nothing else, so a trigger (repair, focus, reconnect, a person asking again) re-attempts the
// open and success clears the refusal. `#opening` is the single flight, because a seam may
// signal synchronously from inside its own `subscribe`. `dispose()` beats all of it.
import type { Unsubscribe } from "#shared/preload-api.js";

import { Emitter } from "#renderer/lib/emitter.js";
import { type Clock } from "#renderer/lib/clock.js";
import { type ExtendedRefusal } from "#renderer/lib/refusal/extensions.js";
import { RefreshScheduler, type RefreshReason } from "#renderer/lib/reads/refresh/scheduler.js";
import { type ReadRound } from "#renderer/lib/reads/scope.js";
import { SUBSCRIBE_FAILED } from "#renderer/lib/reads/failure-codes.js";
import { keepStandingRefusal } from "#renderer/lib/reads/refresh/standing-refusal.js";
import { coerceToRefusal } from "#renderer/lib/coerce-to-refusal.js";

/** What a push-driven read has to show. Total; every arm renders something. */
export type PushDrivenReadState<TValue> =
  | { readonly kind: "not-loaded" }
  | { readonly kind: "loaded"; readonly value: TValue }
  | { readonly kind: "failed"; readonly refusal: ExtendedRefusal };

/** Options for a `PushDrivenRead`. */
export interface PushDrivenReadOptions<TValue> {
  readonly clock: Clock;
  /**
   * Performs the read. Rejections become the `failed` arm, never a silent empty.
   *
   * The signal is the round's: it aborts when a newer read supersedes this one and when the
   * model is disposed. A read that forwards it to the daemon call stops costing anything once
   * its view goes; one that ignores it still has its answer discarded.
   */
  readonly read: (signal: AbortSignal) => Promise<TValue>;
  /**
   * Opens the change subscription. Called before the first read is requested. The callback
   * takes no payload on purpose: a push is answered with a fresh read.
   */
  readonly subscribe: (onChangeSignal: () => void) => Unsubscribe;
  /** Names this read in a refusal, so a failure says which read failed. */
  readonly origin: string;
}

/**
 * One wire read, kept current by a push signal.
 *
 * A class rather than a hook body because it owns a subscription, a scheduler and a teardown.
 * {@link usePushDrivenRead} is the React binding and holds nothing.
 */
export class PushDrivenRead<TValue> {
  readonly #options: PushDrivenReadOptions<TValue>;
  readonly #changes = new Emitter<void>("push-driven read");
  readonly #scheduler: RefreshScheduler;
  #state: PushDrivenReadState<TValue> = { kind: "not-loaded" };
  #unsubscribe: Unsubscribe | undefined;
  #opening = false;
  #disposed = false;

  public constructor(options: PushDrivenReadOptions<TValue>) {
    this.#options = options;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async (reasons, round) => {
        await this.#performRead(reasons, round);
      },
      // The perform body already turns a rejection into the `failed` arm, so this covers only a
      // throw from that conversion; without it the scheduler re-throws inside a timer callback
      // that no view can render.
      onError: (error) => {
        this.#settle({ kind: "failed", refusal: this.#refusalFor(error) });
      },
    });
  }

  /** The current state. Stable by identity between changes, so a selector can compare. */
  public get state(): PushDrivenReadState<TValue> {
    return this.#state;
  }

  /** Reads actually performed. The coalescing assertion, counted rather than inferred. */
  public get readCount(): number {
    return this.#scheduler.performCount;
  }

  /**
   * Whether a subscription is held, the model's only reading of "started". Two readings of one
   * fact is how a refused open left a model that believed it had started while holding nothing.
   */
  public get isSubscribed(): boolean {
    return this.#unsubscribe !== undefined;
  }

  /**
   * Whether {@link dispose} has run. `dispose()` is terminal, so a holder that re-mounts the
   * same instance (React's second strict-mode mount) uses this to recognize the corpse and open
   * a fresh model; `isSubscribed` cannot tell it from a model nobody has started.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Subscribe to state changes. Returns an idempotent unsubscribe. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Opens the subscription and requests the first read, in that order.
   *
   * Idempotent while the subscription is held, since strict mode mounts an effect twice and a
   * second subscription would double every refresh. Not idempotent after a refused open, which
   * is how a re-mounting view gets its subscription back.
   */
  public start(): void {
    this.#open("subscribe");
  }

  /**
   * Asks for a read, taking the subscription first where it is not held. Repeated calls inside
   * the coalescing window cost one read.
   */
  public refresh(reason: RefreshReason): void {
    if (this.#disposed) {
      return;
    }
    if (this.#unsubscribe === undefined) {
      this.#open(reason);
      return;
    }
    this.#scheduler.request(reason);
  }

  /** Release the subscription and the scheduler. Terminal. */
  public dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#scheduler.dispose();
    this.#releaseSubscription();
  }

  /**
   * Takes the subscription, then requests the read the caller came for. The handle is stored
   * only once `subscribe` has returned it, so a seam signaling synchronously from inside its
   * own subscribe re-enters holding nothing, which `#opening` catches.
   */
  #open(reason: RefreshReason): void {
    if (this.#disposed || this.#opening || this.#unsubscribe !== undefined) {
      return;
    }
    this.#opening = true;
    try {
      const release = this.#options.subscribe(() => {
        this.refresh("terminal-event");
      });
      if (this.#disposed) {
        // Disposed from inside the subscribe call; only here can the just-handed handle close.
        release();
        return;
      }
      this.#unsubscribe = release;
    } catch (subscriptionFailure: unknown) {
      // Cleared ahead of the `finally` so a listener answering this refusal with a synchronous
      // `refresh()` reaches `#open`, not the guard.
      this.#opening = false;
      this.#settleFailed(
        coerceToRefusal(subscriptionFailure, this.#options.origin, SUBSCRIBE_FAILED),
        [reason],
      );
      return;
    } finally {
      this.#opening = false;
    }
    if (this.#state.kind === "failed") {
      // The subscription is live again, so the refusal beside it is no longer true.
      // `not-loaded` because no value is held; the read requested below fills it.
      this.#settle({ kind: "not-loaded" });
    }
    this.#scheduler.request(reason);
  }

  /** Close whatever subscription is open, at most once. Safe with none. */
  #releaseSubscription(): void {
    const release = this.#unsubscribe;
    this.#unsubscribe = undefined;
    release?.();
  }

  async #performRead(reasons: readonly RefreshReason[], round: ReadRound): Promise<void> {
    try {
      const value = await this.#options.read(round.signal);
      // The round, not `#disposed` alone: disposal aborts the round, and so does a newer read.
      if (round.signal.aborted) {
        return;
      }
      this.#settle({ kind: "loaded", value });
    } catch (error) {
      if (round.signal.aborted) {
        // An abandoned read has no failure to report; its view is gone or already rendering a
        // newer answer.
        return;
      }
      this.#settleFailed(this.#refusalFor(error), reasons);
    }
  }

  /** Settles `failed`, leaving the standing refusal in place where nothing new failed. */
  #settleFailed(refusal: ExtendedRefusal, reasons: readonly RefreshReason[]): void {
    const standing = this.#state.kind === "failed" ? this.#state.refusal : undefined;
    const kept = keepStandingRefusal(standing, refusal, reasons);
    if (kept === standing) {
      return;
    }
    this.#settle({ kind: "failed", refusal: kept });
  }

  #settle(next: PushDrivenReadState<TValue>): void {
    this.#state = next;
    this.#changes.emit();
  }

  #refusalFor(error: unknown): ExtendedRefusal {
    return coerceToRefusal(error, this.#options.origin);
  }
}
