// One mutation in flight at a time, and the reply that settles it.
//
// WHY THIS IS A CLASS AND NOT TWO PIECES OF COMPONENT STATE
//
// Every mutation this pane performs is DURABLE. `agent.attach` creates an agent;
// `agent.configUpdate` can mint or supersede a durable pending switch; `agent.detach`
// moves a lifecycle state. A control that records no pending state answers a second
// press with a second request, so one intended act becomes two durable records and
// two replies race to decide which settlement is shown. The guard has to be
// synchronous — a `useState` flag is only written on the next render, so two presses
// delivered in one task both read the stale value and both call the wire — which is
// why the latch lives in a field this object writes the instant `submit` is entered,
// and React reads the result rather than owning it.
//
// GENERIC IN WHAT IT SETTLES WITH, because the job is the same for every one of them
// and a second latch beside this one would be two answers to "is something in
// flight". The settlement is whatever the caller's own call resolves to; a mutation
// with nothing to show settles with `undefined` rather than growing an arm.
//
// WHAT IT DOES NOT DO. It cancels nothing: the bridge exposes no cancellation, so
// the honest claim is that a second press is REFUSED, not that a call was stopped.
// And it holds no copy of any read — an attached agent reaches the surface through
// the roster read's own push signal, exactly as it did before.
//
// The refusal translation is `collaboration/push-driven-read.ts`'s
// `consoleRefusalFrom`, which is the family's one converter: a daemon refusal
// travels through verbatim and anything else becomes a refusal naming the caller.
// The origin is a constructor argument because this object does not know which
// subsystem it serves, and inventing one here would put a second origin vocabulary
// beside the column's own.

import { useCallback, useSyncExternalStore } from "react";

import { consoleRefusalFrom } from "../../collaboration/push-driven-read.js";
import { Emitter, type ConsoleRefusal, type Unsubscribe } from "../../core/index.js";

/**
 * What one mutation control has to show. Total; every arm renders something.
 *
 * `in-flight` is its own arm rather than a boolean beside an outcome, so a surface
 * cannot render last attempt's settlement next to this attempt's spinner: the
 * previous settlement is GONE the moment a new attempt starts.
 */
export type MutationAttemptState<TSettlement> =
  | { readonly status: "idle" }
  | { readonly status: "in-flight" }
  | { readonly status: "settled"; readonly settlement: TSettlement }
  | { readonly status: "refused"; readonly refusal: ConsoleRefusal };

const IDLE: { readonly status: "idle" } = { status: "idle" };

export interface MutationAttemptOptions {
  /** Names a failure the thrown value carried no refusal of its own for. */
  readonly origin: string;
}

export class MutationAttempt<TSettlement> {
  readonly #origin: string;
  readonly #changes = new Emitter<void>("mutation attempt");
  #state: MutationAttemptState<TSettlement> = IDLE;

  public constructor(options: MutationAttemptOptions) {
    this.#origin = options.origin;
  }

  /** The current state. Stable by identity between changes, so a selector compares. */
  public get state(): MutationAttemptState<TSettlement> {
    return this.#state;
  }

  /** Subscribe to settlements. Returns an idempotent unsubscribe. */
  public onChange(listener: () => void): Unsubscribe {
    return this.#changes.subscribe(listener);
  }

  /**
   * Perform one mutation, or admit nothing because one is already in flight.
   *
   * Returns whether the attempt was ADMITTED, so a caller that records something
   * about the submission — which subject it was for, say — records it for the call
   * that actually happened rather than for the press the latch refused. A caller
   * with nothing to record ignores it.
   *
   * The caller supplies the call rather than the models, so the object that owns
   * the latch never has to hold a handle whose identity can change under it — and
   * a test drives the real latch against a call it controls instead of standing in
   * for the latch itself.
   */
  public submit(perform: () => Promise<TSettlement>): boolean {
    if (this.#state.status === "in-flight") {
      return false;
    }
    this.#settle({ status: "in-flight" });
    perform().then(
      (settlement) => {
        this.#settle({ status: "settled", settlement });
      },
      (error: unknown) => {
        this.#settle({ status: "refused", refusal: consoleRefusalFrom(error, this.#origin) });
      },
    );
    return true;
  }

  #settle(next: MutationAttemptState<TSettlement>): void {
    this.#state = next;
    this.#changes.emit();
  }
}

/**
 * Read one {@link MutationAttempt} from React.
 *
 * `useSyncExternalStore` rather than mirroring the state into a component: the
 * latch already is an external store, and a second copy is the drift this whole
 * module exists to remove.
 */
export function useMutationAttempt<TSettlement>(
  attempt: MutationAttempt<TSettlement>,
): MutationAttemptState<TSettlement> {
  const subscribe = useCallback(
    (onStoreChange: () => void) => attempt.onChange(onStoreChange),
    [attempt],
  );
  const read = useCallback(() => attempt.state, [attempt]);
  return useSyncExternalStore(subscribe, read, read);
}
