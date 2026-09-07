// A bridge whose every daemon call parks until the case settles it.
//
// The collaborator a TIMING claim needs. A fixture scenario answers on its own
// schedule, which is the right collaborator for "what does this surface do with the
// reply" and the wrong one for "what does this surface do while the reply is still
// travelling" — and every settlement-identity rule in the console is about the
// second: a call issued under one address, completing after the surface has moved to
// another. Parking the call is what puts the case in charge of that interval.
//
// OVER THE REAL FIXTURE, AND NOT A CAST. An object cast to `ConsoleBridge` answers
// every stream and every call with whatever its author remembered to write, which is
// how this double came to carry `growth: {}` — so a surface under test that reached
// the growth port threw instead of refusing typed — and `scenarioEngine: undefined`,
// which left it with no frozen clock, so a case that grew a scheduled read had to
// hand-roll its own settle. The parking is a call arm over the shipped fixture now:
// the clock, the scenario, and every port the case does not park stay the fixture's.
//
// ONE QUEUE, SETTLED OLDEST FIRST, rather than a map keyed by method or by params.
// The cases that use this issue at most a handful of calls and settle them in issue
// order, so an index would be a second structure over a list short enough to read —
// and a settle-by-method helper would quietly answer the wrong call the first time
// one case issued the same method twice, which is exactly the shape these cases are
// written to explore.
//
// THE `.test-support.ts` SUFFIX IS LOAD-BEARING and not decoration: it is what the
// package's own naming says a shared double is, and the file had shipped under a
// production name — indistinguishable, to knip and to a reader, from a module the
// composer mounts.
//
// WHY IT SITS IN THE COMPOSER FAMILY AND NOT UNDER `test/console/`. That directory is
// the home for the console TIER harnesses, and those tiers are their own tsconfig
// programs. Its consumers here are two CO-LOCATED unit tests, which the renderer
// composite project compiles under `rootDir: apps/desktop/src` — a renderer file
// importing `apps/desktop/test/...` is TS6059, so the shared double cannot live
// there and be reachable from `src/`. Two consumers in two sibling directories of one
// family put it at that family's own level, which is where `apps/desktop/AGENTS.md`
// puts anything the second use hoists.

import type { ConsoleBridge } from "../../console/bridge/index.js";
import { bridgeAnswering } from "../../console/bridge/fixture/fixture-bridge.test-support.js";
import { COMPOSER_SCENARIO } from "../../console/bridge/scenarios/composer.js";

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
