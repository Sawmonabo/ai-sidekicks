// A read that a push signal refreshes, and never a poll.
//
// A SEAT rather than one family's module: the channel directory, the roster, the
// agent console, the mount inventory, and the attention plane each make a live read,
// and every one of them has the same five-part discipline — which
// `Spec-023 §Console Design (Meridian)`'s collaboration sections state as rules about
// the roster and which the others need identically. It renders nothing, which is what
// lets it sit below the view families that spend it:
//
//   1. **Subscribe before reading.** The subscription is opened first, so no update
//      can land in the gap between a read returning and a handler attaching. A
//      surface that read first would miss exactly the changes that happened while
//      it was reading, and would look correct doing it.
//   2. **The signal is opaque.** A push carries no state. It is answered with a
//      fresh read, so the surface holds no second copy of the publisher's model and
//      cannot drift from it.
//   3. **One read per burst.** Every refresh goes through `store/scheduling.ts`'s
//      `RefreshScheduler`, the console's refresh chokepoint — trailing debounce with
//      an absolute deadline, so a continuous stream still gets a read.
//   4. **No stale reply wins.** The scheduler serializes: a read requested while one
//      is in flight becomes the NEXT read rather than a parallel one, so two replies
//      are never racing and no sequence counter is needed to drop the loser. The
//      shipped Tier-1 roster needs one because it calls the bridge directly; routing
//      through the chokepoint is what retires it.
//   5. **No flicker.** `not-loaded` is entered once, at construction. A refresh
//      replaces the value in place and never returns the surface to its loading
//      shape, because a roster that blinked on every presence push would be
//      unreadable in a busy room.
//
// AND ONE THAT IS ABOUT TEARDOWN. `dispose()` is terminal: the subscription is
// released and the scheduler is disposed, so a late push cannot re-arm a timer
// behind a section that unmounted. The clock is injected rather than read off the
// platform, so a test drives all of this on frozen time with no real timers.
//
// AND ONE ABOUT THE SUBSCRIPTION THAT CANNOT BE OPENED AT ALL. Rule 1 puts the
// subscribe first, which means a `subscribe` that throws SYNCHRONOUSLY throws out of
// `start()` — and `start()` is called from a mount effect, so the throw lands in
// React's commit phase and takes the surface down instead of producing the model's
// own `failed` state. That is not hypothetical: the installed Tier-1 preload bridge
// implements every daemon method by throwing, so the presence roster's subscribe is
// exactly this call under a live window. So `start()` catches it, releases whatever
// partial subscription it may have taken, and settles the read as `failed` carrying
// the thrower's own words — and requests no read, because a value fetched behind a
// subscription that never opened could never be refreshed and would render as a
// live surface that has quietly stopped listening.

import { useCallback, useSyncExternalStore } from "react";

import type { Unsubscribe } from "@ai-sidekicks/contracts";

import {
  ConsoleRefusalError,
  Emitter,
  isConsoleRefusal,
  normalizeWireRejection,
  type ConsoleClock,
  type ConsoleRefusal,
} from "../core/index.js";
import { wireRejectionToError } from "../../../../shared/wire-errors.js";
import type { DaemonReply, GrowthOutcome } from "../bridge/index.js";
import { RefreshScheduler, type RefreshReason } from "../store/index.js";

/**
 * The codes this module mints when a failure carried none of its own.
 *
 * Declared once and derived from, because both the read arm and the subscribe arm
 * name one of them and a second spelling in either place is a rename waiting to go
 * half-applied. A failure that arrives carrying a daemon code keeps that code —
 * these two are the fallback, never a translation.
 */
export const PUSH_DRIVEN_READ_FAILURE_CODES = ["read-failed", "subscribe-failed"] as const;

/** One such code. Derived, so the set is stated exactly once. */
export type PushDrivenReadFailureCode = (typeof PUSH_DRIVEN_READ_FAILURE_CODES)[number];

/** What a push-driven read has to show. Total; every arm renders something. */
export type PushDrivenReadState<TValue> =
  | { readonly kind: "not-loaded" }
  | { readonly kind: "loaded"; readonly value: TValue }
  | { readonly kind: "failed"; readonly refusal: ConsoleRefusal };

export interface PushDrivenReadOptions<TValue> {
  readonly clock: ConsoleClock;
  /** Performs the read. Rejections become the `failed` arm, never a silent empty. */
  readonly read: () => Promise<TValue>;
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
  #started = false;
  #disposed = false;

  public constructor(options: PushDrivenReadOptions<TValue>) {
    this.#options = options;
    this.#scheduler = new RefreshScheduler({
      clock: options.clock,
      perform: async () => {
        await this.#performRead();
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

  /** Whether a subscription is open. Asserted by the subscribe-first test. */
  public get isSubscribed(): boolean {
    return this.#unsubscribe !== undefined;
  }

  /** Subscribe to state changes. Returns an idempotent unsubscribe. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Open the subscription and request the first read, in that order.
   *
   * Idempotent, because React mounts an effect twice under strict mode and a second
   * subscription would double every refresh for the life of the surface.
   */
  public start(): void {
    if (this.#started || this.#disposed) {
      return;
    }
    this.#started = true;
    try {
      this.#unsubscribe = this.#options.subscribe(() => {
        this.refresh("terminal-event");
      });
    } catch (subscriptionFailure: unknown) {
      // Released rather than merely dropped: a seam that registered the handler and
      // then threw on its way out has left a live registration, and the handle it
      // never returned is unreachable from anywhere else.
      this.#releaseSubscription();
      this.#settle({
        kind: "failed",
        refusal: consoleRefusalFrom(subscriptionFailure, this.#options.origin, "subscribe-failed"),
      });
      return;
    }
    this.refresh("subscribe");
  }

  /** Ask for a read. Repeated calls inside the coalescing window cost one read. */
  public refresh(reason: RefreshReason): void {
    if (this.#disposed) {
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

  /** Close whatever subscription is open, at most once. Safe with none. */
  #releaseSubscription(): void {
    const release = this.#unsubscribe;
    this.#unsubscribe = undefined;
    release?.();
  }

  async #performRead(): Promise<void> {
    try {
      const value = await this.#options.read();
      if (this.#disposed) {
        return;
      }
      this.#settle({ kind: "loaded", value });
    } catch (error) {
      if (this.#disposed) {
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
 * The refusal a rejection is, in the console's one refusal shape.
 *
 * TWO ARMS, and the first is the whole reason this function still exists beside
 * `core/wire-rejection.ts`. A refusal this console already built and threw is handed
 * back BY REFERENCE: a `GrowthUnavailable` carries `operationId`, `slateRow`, and
 * `owningDocument` beside the three members every refusal has, and the normalizer
 * REBUILDS from the three it reads — deliberately, so nothing of a hostile rejection
 * survives onto the answer — which would drop exactly the part that says who owes
 * the wire. So a value that is already a `ConsoleRefusal` is not renormalized.
 *
 * Everything else goes to `normalizeWireRejection`, which is total and owns every
 * other reading: a daemon envelope keeps its own code (folding those into
 * `read-failed` rendered one generic code for a permission denial, a missing
 * session, and a broken transport), a tRPC-shaped rejection keeps its dotted type,
 * and a value whose own property access throws still answers a refusal.
 *
 * A free function rather than a private method because a MUTATION's rejection needs
 * exactly this translation and has no read to route through: a second copy of these
 * lines is the duplicate refusal constructor `apps/desktop/AGENTS.md` forbids.
 *
 * `fallbackCode` names WHICH failure produced it, for a rejection that carried no
 * code of its own — and it is the CALLER's word rather than this module's set,
 * because a preference write that rejected is neither of the two a push-driven read
 * has, and reporting it as `read-failed` would tell a reader the wrong thing about
 * an act that changed something. The DETAIL that travels with it is the thrower's
 * own message, read through the repository's total stringifier, so a refusal this
 * console synthesizes still carries the author's words rather than a guess.
 */
export function consoleRefusalFrom(
  error: unknown,
  origin: string,
  fallbackCode: string = "read-failed",
): ConsoleRefusal {
  if (error instanceof ConsoleRefusalError) {
    return error.refusal;
  }
  if (isConsoleRefusal(error)) {
    return error;
  }
  return normalizeWireRejection(origin, error, {
    code: fallbackCode,
    detail: wireRejectionToError(error, { total: true }).message,
  });
}

/**
 * The value a daemon reply served, raised as a throw where it refused instead.
 *
 * The call door answers a closed `served | refused` value and never throws, and a
 * read body here has to answer a VALUE or throw, because rule 1 puts the subscribe
 * first and the failure arm this model settles into is fed by its own `catch`. So
 * the two shapes meet in exactly one place, here, rather than in a four-line branch
 * at each of the console's live reads.
 *
 * A `ConsoleRefusalError` and not a bare `Error`, so {@link consoleRefusalFrom} on
 * the other side of that `catch` recognises it and hands the door's refusal back
 * VERBATIM — the code the daemon wrote, the sentence it wrote, the origin that says
 * which seam answered. Wrapping it in anything else would relabel a permission
 * denial as `read-failed` on the way through the very mechanism that exists to stop
 * that.
 */
export function servedValueOrRaise<TValue>(reply: DaemonReply<TValue>): TValue {
  if (reply.status === "refused") {
    throw new ConsoleRefusalError(reply.refusal);
  }
  return reply.value;
}

/**
 * The value a growth operation served, raised as a throw where it refused instead.
 *
 * {@link servedValueOrRaise}'s twin, and two functions rather than one over both
 * unions: the two seams discriminate on different words (`refused` against
 * `unavailable`) because they refuse for different reasons — a registered wire that
 * answered badly, against a wire the corpus has not registered at all — and one
 * helper spanning them would have to accept either word, which is how a caller ends
 * up unable to tell those apart.
 *
 * `GrowthUnavailable` IS a `ConsoleRefusal`, so the throw carries the port's own
 * refusal whole: its code, its sentence, and the operation and owning document a
 * growth refusal names. Rebuilding it would drop exactly the part that says who owes
 * the wire.
 */
export function servedGrowthValueOrRaise<TValue>(outcome: GrowthOutcome<TValue>): TValue {
  if (outcome.status === "unavailable") {
    throw new ConsoleRefusalError(outcome);
  }
  return outcome.value;
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
