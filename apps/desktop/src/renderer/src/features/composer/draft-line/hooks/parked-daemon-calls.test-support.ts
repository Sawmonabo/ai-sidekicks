// Send calls that park until the case settles them.
//
// A scripted answer arrives on its own schedule, which suits "what does this composer
// do with the reply" and not "what does it do while the reply is still traveling":
// a call issued under one address, completing after the composer has moved to another.
// Parking the call puts the case in charge of that interval.
//
// The transport the held state belongs to is the shipped fixture and not a cast
// object: the clock and the scenario stay the fixture's.
//
// ONE QUEUE, SETTLED OLDEST FIRST, rather than a map keyed by method or by params. The
// cases issue at most a handful of calls and settle them in issue order, and a
// settle-by-method helper would answer the wrong call the first time one case issued
// the same method twice.
//
// It sits beside the send controller's settlement suite, the one suite that parks a call.
import type { PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { bridgeAnswering } from "@test/helpers/fixture-bridge.js";
import { WAITING_FOR_INPUT_SCENARIO } from "../../../../../../../fixtures/scenarios/waiting-for-input.js";
import type { ComposerSendCalls } from "../send-dispatch.js";
import { interventionResponse, sendCallsAnswering } from "../send-router.test-support.js";

export class ParkedDaemonCalls {
  readonly #parked: ParkedCall[] = [];
  public readonly bridge: PlatformBridge;
  public readonly calls: ComposerSendCalls;

  public constructor() {
    // The composer's own scenario, because these cases are the composer's.
    this.bridge = bridgeAnswering(async () => undefined, WAITING_FOR_INPUT_SCENARIO).bridge;
    this.calls = sendCallsAnswering(
      async () =>
        new Promise((resolve) => {
          this.#parked.push({ resolve });
        }),
    );
  }

  /** How many calls are waiting. A case asserts on this to prove one was issued. */
  public get parkedCount(): number {
    return this.#parked.length;
  }

  /** Answer the oldest parked steer as the run rejecting it for this reason. */
  public rejectOldest(rejectionReason: string): void {
    this.#takeOldest().resolve(interventionResponse("rejected", 8, { rejectionReason }));
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

/** One parked call's way out. */
interface ParkedCall {
  readonly resolve: (value: unknown) => void;
}
