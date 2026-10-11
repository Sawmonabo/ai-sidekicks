// Send calls that park until the case settles them, so a case controls a call issued under one
// address that completes after the composer moved to another. Parked calls form one queue,
// settled oldest first: a settle-by-method helper would answer the wrong call when a case
// issues one method twice.

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";
import { WAITING_FOR_INPUT_SCENARIO } from "#fixtures/scenarios/waiting-for-input.js";
import type { ComposerSendCalls } from "../send/dispatch.js";
import { sendCallsAnswering } from "../send/router.test-support.js";

/** Send calls whose replies the case supplies, over the shipped fixture bridge. */
export class ParkedDaemonCalls {
  readonly #parked: ParkedCall[] = [];
  public readonly bridge: PlatformBridge;
  public readonly calls: ComposerSendCalls;

  public constructor() {
    // The composer's own scenario.
    this.bridge = bridgeAnswering(async () => undefined, WAITING_FOR_INPUT_SCENARIO).bridge;
    this.calls = sendCallsAnswering(
      async () =>
        new Promise((_resolve, reject) => {
          this.#parked.push({ reject });
        }),
    );
  }

  /** How many calls are waiting. */
  public get parkedCount(): number {
    return this.#parked.length;
  }

  /** Answer the oldest parked send as the daemon refusing it under this code. */
  public rejectOldest(code: string): void {
    this.#takeOldest().reject({ code, message: "The background service refused this message." });
  }

  #takeOldest(): ParkedCall {
    const parked = this.#parked.shift();
    if (parked === undefined) {
      throw new Error("no call is parked");
    }
    return parked;
  }
}

/** One parked call's way out. */
interface ParkedCall {
  readonly reject: (rejection: unknown) => void;
}
