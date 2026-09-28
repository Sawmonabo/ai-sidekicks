// A bridge whose every daemon call parks until the case settles it.
//
// A fixture scenario answers on its own schedule, which suits "what does this surface
// do with the reply" and not "what does it do while the reply is still travelling":
// a call issued under one address, completing after the surface has moved to another.
// Parking the call puts the case in charge of that interval.
//
// Built over the shipped fixture and not a cast object: the clock, the scenario, and
// every port the case does not park stay the fixture's.
//
// ONE QUEUE, SETTLED OLDEST FIRST, rather than a map keyed by method or by params. The
// cases issue at most a handful of calls and settle them in issue order, and a
// settle-by-method helper would answer the wrong call the first time one case issued
// the same method twice.
//
// It sits in the composer family and not under `test/console/` because the renderer
// project compiles under `rootDir: apps/desktop/src`, so a renderer file cannot import
// from `apps/desktop/test/...`.

import type { ConsoleBridge } from "../../console/bridge/index.js";
import { bridgeAnswering } from "../../console/bridge/fixture/call-plane/bridge.test-support.js";
import { COMPOSER_SCENARIO } from "../../console/bridge/scenario/composer/composer.js";

/** One parked call's two ways out. */
interface ParkedCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
}

export class ParkedDaemonCalls {
  readonly #parked: ParkedCall[] = [];
  public readonly bridge: ConsoleBridge;

  public constructor() {
    // The composer's own scenario, because these cases are the composer's: a call
    // this double does not park still reaches the fixture's script rather than a
    // hand-written literal.
    this.bridge = bridgeAnswering(
      async () =>
        new Promise((resolve, reject) => {
          this.#parked.push({ resolve, reject });
        }),
      COMPOSER_SCENARIO,
    ).bridge;
  }

  /** How many calls are waiting. A case asserts on this to prove one was issued. */
  public get parkedCount(): number {
    return this.#parked.length;
  }

  /**
   * Refuse the oldest parked call the way the daemon refuses one.
   *
   * A plain `{ code, message }` envelope, which is what `wire-errors.ts` matches
   * structurally — the shape a console surface carries through verbatim rather than
   * rendering under its own last-resort code.
   */
  public refuseOldest(code: string, message: string): void {
    this.#takeOldest().reject({ code, message });
  }

  /** Answer the oldest parked call with this reply. */
  public resolveOldest(reply: unknown): void {
    this.#takeOldest().resolve(reply);
  }

  #takeOldest(): ParkedCall {
    const parked = this.#parked.shift();
    if (parked === undefined) {
      throw new Error("no call is parked");
    }
    return parked;
  }
}
