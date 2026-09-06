// The open this seam REPLACED, kept runnable so the replacement has a control.
//
// WHY A COPY EXISTS AT ALL. `apps/desktop/AGENTS.md` forbids a test driving a local
// stand-in for the module under test, and this is not one: nothing here is asserted
// to be correct. It is the negative control the re-open redesign owes — the shape
// whose defect the redesign exists to remove — so a case can put the two side by side
// on one seam and show that they diverge. A control that only describes the old
// behaviour in a comment proves nothing the day someone reintroduces it.
//
// THE DEFECT, IN THREE LINES. `start()` marked the model started BEFORE the subscribe
// attempt; the refusal arm settled `failed` and returned without clearing that mark;
// and `refresh()` could take no subscription of its own, so with none held it did
// nothing at all. So on the shipped Tier-1 preload — where every daemon method throws
// — the first open refused and every repair, focus, reconnect, and press afterwards
// was a guaranteed no-op, for the life of the window.
//
// THE HALF THIS CONTROL DOES NOT MODEL, stated rather than implied by its absence.
// The replaced shape also went on requesting reads behind a subscription nothing had
// ever taken; that is `push-driven-read.ts`'s own header, and it is unmeasurable here
// because this control holds no scheduler to request one from. What is here is the
// half a scheduler is not needed for, and the third line above describes the trigger
// as this control implements it — a guaranteed no-op — rather than as the model's
// read-behind-a-dead-seam.
//
// It is deliberately the SMALLEST thing that reproduces that: no scheduler, no
// emitter, no clock. What the control measures is how many times the seam was asked
// to subscribe and whether the refusal ever stopped being the answer, and neither
// needs the parts left out.

import type { ConsoleRefusal } from "../core/index.js";
import { consoleRefusalFrom, type PushDrivenReadState } from "./push-driven-read.js";

/** The failure code the replaced shape settled a refused open under. */
const SUBSCRIBE_FAILED = "subscribe-failed";

/** What the control is built over: the two seam arms the old open touched. */
export interface LatchedOpenOptions {
  readonly origin: string;
  readonly subscribe: (onChangeSignal: () => void) => () => void;
}

/**
 * The replaced open: started before the attempt, and never unstarted.
 *
 * Its `state` and `isSubscribed` are named for the real model's, so a case reads the
 * two through the same words and the divergence is in the answers rather than in the
 * question.
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

  /** The defect: the mark is set first and the refusal arm leaves it standing. */
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

  /** The other half: a trigger asked for a read and never for a subscription. */
  public refresh(): void {
    if (this.#unsubscribe === undefined) {
      return;
    }
    this.#state = { kind: "loaded", value: "roster" };
  }
}

/** The same conversion the real seam performs, so the two refusals are comparable. */
function refusalFrom(subscriptionFailure: unknown, origin: string): ConsoleRefusal {
  return consoleRefusalFrom(subscriptionFailure, origin, SUBSCRIBE_FAILED);
}
