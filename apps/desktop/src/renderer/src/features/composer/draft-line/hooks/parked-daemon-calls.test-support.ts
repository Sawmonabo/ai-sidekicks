// Send calls that park until the case settles them, so a case controls a call issued under one
// address that completes after the composer moved to another. Parked calls form one queue,
// settled oldest first: a settle-by-method helper would answer the wrong call when a case
// issues one method twice.

import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { bridgeAnswering } from "@test/helpers/fixture-bridge.js";
import { WAITING_FOR_INPUT_SCENARIO } from "../../../../../../../fixtures/scenarios/waiting-for-input.js";
import type { ComposerSendCalls } from "../send-dispatch.js";
import { interventionResponse, sendCallsAnswering } from "../send-router.test-support.js";

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
        new Promise((resolve) => {
          this.#parked.push({ resolve });
        }),
    );
  }

  /** How many calls are waiting. */
  public get parkedCount(): number {
    return this.#parked.length;
  }

  /** Answer the oldest parked steer as the run rejecting it for this reason. */
  public rejectOldest(rejectionReason: string): void {
    this.#takeOldest().resolve(interventionResponse("rejected", 8, { rejectionReason }));
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
  readonly resolve: (value: unknown) => void;
}
