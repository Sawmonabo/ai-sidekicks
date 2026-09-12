// A read that a push signal refreshes, and never a poll.
//
// A SEAT rather than one family's module: the channel directory, the roster, the
// agent console, the mount inventory, and the attention plane each make a live read,
// and every one of them has the same five-part discipline — stated for the roster and
// needed identically by the others. It renders nothing, which is what lets it sit
// below the view families that spend it:
//
//   1. **Subscribe before reading.** The subscription is opened first, so no update
//      can land in the gap between a read returning and a handler attaching. A
//      surface that read first would miss exactly the changes that happened while
//      it was reading, and would look correct doing it.
//   2. **The signal is opaque.** A push carries no state. It is answered with a
//      fresh read, so the surface holds no second copy of the publisher's model and
//      cannot drift from it.
//   3. **One read per burst.** Every refresh goes through `store/read/refresh-scheduler.ts`'s
//      `RefreshScheduler`, the console's refresh chokepoint — trailing debounce with
//      an absolute deadline, so a continuous stream still gets a read.
//   4. **No stale reply wins.** The scheduler serializes: a read requested while one
//      is in flight becomes the NEXT read rather than a parallel one, so two replies
//      never race and no sequence counter is needed to drop the loser. The shipped
//      The pre-console roster needs one because it calls the bridge directly; routing through
//      the chokepoint is what retires it.
//   5. **No flicker.** A refresh replaces the value in place and never returns a
//      loaded surface to its loading shape, because a roster that blinked on every
//      presence push would be unreadable in a busy room. `not-loaded` is entered at
//      construction and on one other occasion — an open that succeeded after a
//      refusal, where nothing has arrived behind the new subscription yet.
//
// AND ONE THAT IS ABOUT TEARDOWN. `dispose()` is terminal: the subscription is
// released and the scheduler is disposed, so a late push cannot re-arm a timer behind
// a section that unmounted. The clock is injected rather than read off the platform,
// so a test drives all of this on frozen time with no real timers. Disposing also
// ABANDONS the read in flight rather than only ignoring what it settles as — the
// scheduler's own read line does that — so a section that unmounted mid-read stops
// paying for the reply's parse and this model's projection of it, instead of paying
// for both and discarding the result. The read body is handed that round's signal;
// what it does with it is the read's own business, and a read that ignores it lands
// exactly where it always did.
//
// AND ONE ABOUT THE SUBSCRIPTION THAT CANNOT BE OPENED AT ALL. Rule 1 puts the
// subscribe first, so a `subscribe` that throws SYNCHRONOUSLY throws out of the open
// — which runs from a mount effect, so the throw lands in React's commit phase and
// takes the surface down instead of producing the model's own `failed` state. Not
// hypothetical: the installed stub preload bridge implements every daemon method
// by throwing, so the presence roster's subscribe is exactly this call under a live
// window. So the open catches it and settles `failed` carrying the thrower's own
// words — and requests no read, because a value fetched behind a subscription that
// never opened could never be refreshed and would render as a live surface that has
// quietly stopped listening.
//
// WHICH IS WHY A REFUSED OPEN IS NOT THE END OF THE SURFACE. What "started" means here
// is the subscription HANDLE and nothing else. A separate flag, set before the attempt
// rather than after it, made a refused open permanent: every later open returned at the
// guard, `refresh()` went on requesting reads behind a subscription nothing had ever
// taken, and the surface stayed `failed` for the life of the window — under the shipped
// stub preload, whose subscribe throws, that is the ordinary path and not the unlucky
// one. So a trigger — repair, focus, reconnect, a person asking again — re-attempts the
// open, and one that succeeds clears the refusal rather than leaving `failed` beside a
// live subscription. `#opening` is the single flight: an attempt already running is not
// a second subscription, which matters because a seam may signal synchronously from
// inside its own `subscribe` and re-enter holding nothing. `dispose()` beats all of it.

import { useCallback, useSyncExternalStore } from "react";

import type { Unsubscribe } from "@ai-sidekicks/contracts";

import { Emitter, type ConsoleClock, type ConsoleRefusal } from "../../core/index.js";
import { RefreshScheduler, type ReadRound, type RefreshReason } from "../../store/index.js";
import { SUBSCRIBE_FAILED } from "./read-failure-codes.js";
import { consoleRefusalFrom } from "./served-value.js";

/** What a push-driven read has to show. Total; every arm renders something. */
export type PushDrivenReadState<TValue> =
  | { readonly kind: "not-loaded" }
  | { readonly kind: "loaded"; readonly value: TValue }
  | { readonly kind: "failed"; readonly refusal: ConsoleRefusal };

export interface PushDrivenReadOptions<TValue> {
  readonly clock: ConsoleClock;
  /**
   * Performs the read. Rejections become the `failed` arm, never a silent empty.
   *
   * The signal is the round's, from the read line the scheduler beneath this model
   * owns: it aborts when a newer read supersedes this one and when the model is
   * disposed. A read that forwards it to the call door stops costing anything the
   * moment its surface goes; one that ignores it still has its answer discarded, and
   * that is the difference the parameter exists to make visible.
   */
  readonly read: (signal: AbortSignal) => Promise<TValue>;
  /**
   * Opens the change subscription. Called exactly once, BEFORE the first read is
   * requested. The callback takes no payload on purpose — rule 2 above.
   */
  readonly subscribe: (onChangeSignal: () => void) => Unsubscribe;
  /** Names this read in a refusal, so a failure says which read failed. */
  readonly origin: string;
}

/**
 * One wire read, kept current by a push signal.
 *
 * A class rather than a hook body: it owns a subscription, a scheduler, and a
 * teardown, and `apps/desktop/AGENTS.md` puts stateful logic in a class with
 * private fields. {@link usePushDrivenRead} is the React binding and holds nothing.
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
      perform: async (_reasons, round) => {
        await this.#performRead(round);
      },
      // The perform body already converts a rejection into the `failed` arm, so
      // this handler covers only a throw from the conversion itself. It must exist:
      // without it the scheduler re-throws, and a re-throw inside a timer callback
      // reaches no `catch` a surface could render.
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
   * Whether a subscription is held — and the model's ONLY reading of started. Two
   * readings of one fact is how a refused open left a model that believed it had
   * started while holding nothing.
   */
  public get isSubscribed(): boolean {
    return this.#unsubscribe !== undefined;
  }

  /**
   * Whether {@link dispose} has run. The reading a resource holder needs.
   *
   * `dispose()` is terminal, so a disposed model answers `start()` and `refresh()`
   * with nothing at all. A holder that re-mounts the same instance — React's second
   * strict-mode mount, whose cleanup already disposed the first — has to be able to
   * recognise that corpse and open a fresh model instead of committing it, and
   * `isSubscribed` cannot tell it apart from a model nobody has started yet.
   */
  public get isDisposed(): boolean {
    return this.#disposed;
  }

  /** Subscribe to state changes. Returns an idempotent unsubscribe. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Open the subscription and request the first read, in that order.
   *
   * Idempotent while the subscription is held, because React mounts an effect twice
   * under strict mode and a second subscription would double every refresh for the
   * life of the surface — and deliberately not idempotent after an open that
   * refused, which is how a re-mounting surface gets its subscription back.
   */
  public start(): void {
    this.#open("subscribe");
  }

  /**
   * Ask for a read, taking the subscription first where it is not held.
   *
   * Repeated calls inside the coalescing window cost one read. A caller asking while
   * the subscription is down wants the live surface back, not one read behind a dead
   * seam — so the open is part of what this does.
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
   * Take the subscription, then request the read the caller came for. The handle is
   * stored only once `subscribe` has RETURNED it, so a seam signalling synchronously
   * from inside its own subscribe re-enters holding nothing — which `#opening`
   * catches rather than take a second subscription no one can release.
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
        // Disposed from inside the subscribe call. The handle has just been handed
        // over and nothing else holds it, so here is the only place it can close.
        release();
        return;
      }
      this.#unsubscribe = release;
    } catch (subscriptionFailure: unknown) {
      // `#opening` is cleared HERE, ahead of the `finally`, so a listener answering
      // this refusal with a synchronous `refresh()` reaches `#open` and not the guard.
      // Nothing is released: the handle is assigned only after `subscribe` returned.
      this.#opening = false;
      this.#settle({
        kind: "failed",
        refusal: consoleRefusalFrom(subscriptionFailure, this.#options.origin, SUBSCRIBE_FAILED),
      });
      return;
    } finally {
      this.#opening = false;
    }
    if (this.#state.kind === "failed") {
      // The subscription is live again, so the refusal beside it has stopped being
      // true. `not-loaded` because this model holds no value — the read requested
      // below is what fills it.
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

  async #performRead(round: ReadRound): Promise<void> {
    try {
      const value = await this.#options.read(round.signal);
      // The round and not `#disposed` alone: disposal aborts the round, so this
      // covers the same case and one more — a read this line has already superseded
      // — with one reading rather than two that can disagree.
      if (round.signal.aborted) {
        return;
      }
      this.#settle({ kind: "loaded", value });
    } catch (error) {
      if (round.signal.aborted) {
        // An abandoned read has no failure to report: whatever it settled as, the
        // surface that would have rendered the refusal is gone or is already
        // rendering a newer read's answer.
        return;
      }
      this.#settle({ kind: "failed", refusal: this.#refusalFor(error) });
    }
  }

  #settle(next: PushDrivenReadState<TValue>): void {
    this.#state = next;
    this.#changes.emit();
  }

  #refusalFor(error: unknown): ConsoleRefusal {
    return consoleRefusalFrom(error, this.#options.origin);
  }
}

/**
 * Read one {@link PushDrivenRead} from React.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect: the model already
 * is an external store, and mirroring its state into component state would be the
 * second copy this whole module exists to avoid. The model is constructed by
 * whoever owns its lifetime — never in a render body.
 */
export function usePushDrivenRead<TValue>(
  model: PushDrivenRead<TValue>,
): PushDrivenReadState<TValue> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => model.onChange(onStoreChange),
    [model],
  );
  const read = useCallback(() => model.state, [model]);
  return useSyncExternalStore(subscribe, read, read);
}
