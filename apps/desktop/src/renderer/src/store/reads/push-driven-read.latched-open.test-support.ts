// A deliberately faulty open, kept runnable as a negative control for the re-open cases in
// `push-driven-read.reopen.test.ts`. Nothing here is asserted to be correct.
//
// The fault: `start()` marks the model started before the subscribe attempt and the refusal
// arm never clears the mark, while `refresh()` cannot take a subscription of its own. On a
// seam that refuses once, every later trigger is then a no-op for the life of the window.
//
// It is the smallest thing that reproduces that: no scheduler, emitter or clock, because what
// is measured is how many times the seam was asked to subscribe and whether the refusal ever
// stopped being the answer. It does not model the real fault's reads requested behind a dead
// subscription, which needs a scheduler.

import type { Refusal } from "@renderer/lib/refusal.js";
import { type PushDrivenReadState } from "./push-driven-read.js";
import { SUBSCRIBE_FAILED } from "@renderer/lib/reads/read-failure-codes.js";
import { coerceToRefusal } from "@renderer/lib/coerce-to-refusal.js";

/** What the control is built over: the subscribe seam and the origin its refusal carries. */
export interface LatchedOpenOptions {
  readonly origin: string;
  readonly subscribe: (onChangeSignal: () => void) => () => void;
}

/**
 * The faulty open: marked started before the attempt, and never unstarted. Its `state` and
 * `isSubscribed` are named for the real model's, so a case compares the same questions.
 */
export class LatchedOnceOpen {
  readonly #options: LatchedOpenOptions;
  #state: PushDrivenReadState<string> = { kind: "not-loaded" };
  #unsubscribe: (() => void) | undefined;
  #started = false;

  public constructor(options: LatchedOpenOptions) {
    this.#options = options;
  }

  public get state(): PushDrivenReadState<string> {
    return this.#state;
  }

  public get isSubscribed(): boolean {
    return this.#unsubscribe !== undefined;
  }

  /** The fault: the mark is set first and the refusal arm leaves it standing. */
  public start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    try {
      this.#unsubscribe = this.#options.subscribe(() => undefined);
    } catch (subscriptionFailure: unknown) {
      this.#state = {
        kind: "failed",
        refusal: refusalFrom(subscriptionFailure, this.#options.origin),
      };
    }
  }

  /** A trigger asks for a read and never for a subscription. */
  public refresh(): void {
    if (this.#unsubscribe === undefined) {
      return;
    }
    this.#state = { kind: "loaded", value: "roster" };
  }
}

/** The same conversion the real seam performs, so the two refusals are comparable. */
function refusalFrom(subscriptionFailure: unknown, origin: string): Refusal {
  return coerceToRefusal(subscriptionFailure, origin, SUBSCRIBE_FAILED);
}
