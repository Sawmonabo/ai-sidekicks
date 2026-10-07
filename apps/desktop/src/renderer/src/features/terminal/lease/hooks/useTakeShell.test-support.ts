// What the take's suites share: the shell and pane subscription a take names, and a bridge whose
// `session.takeControl` answers are held until a case settles them.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";
import type { SessionTakeControlResponse } from "@ai-sidekicks/contracts/pty";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import { TERMINAL_LEASE_SCENARIO } from "#fixtures/scenarios/terminal-lease.js";
import { bridgeAnswering, type RecordedDaemonCall } from "#test/helpers/fixture/bridge.js";
import { SHELL_ID, THIS_DEVICE_ID } from "../state.test-support.js";
import type { TakeShellTarget } from "./useTakeShell.js";

/** The shell a take names, and the pane's output subscription to it the hold is bound to. */
export const TAKE_TARGET: TakeShellTarget = {
  sessionId: TERMINAL_LEASE_SCENARIO.sessionId as SessionId,
  terminalId: SHELL_ID,
  outputSubscriptionId: "019b7b30-0280-7c3d-8110-cca0117a0141" as SubscriptionId,
};

// The method the take sends.
const TAKE_CONTROL_METHOD = "session.takeControl";

/**
 * A bridge whose `session.takeControl` calls are each held until a case serves or refuses them;
 * every other call is the scenario's.
 */
export class HeldTakes {
  readonly #settlements: ((settle: () => SessionTakeControlResponse) => void)[] = [];
  readonly #answering = bridgeAnswering(async (call, passThrough) => {
    if (call.method !== TAKE_CONTROL_METHOD) {
      return passThrough();
    }
    const settle = await new Promise<() => SessionTakeControlResponse>((resolve) => {
      this.#settlements.push(resolve);
    });
    return settle();
  }, TERMINAL_LEASE_SCENARIO);

  public get bridge(): PlatformBridge {
    return this.#answering.bridge;
  }

  /** Every take sent, in order. */
  public get takes(): readonly RecordedDaemonCall[] {
    return this.#answering.calls.filter((call) => call.method === TAKE_CONTROL_METHOD);
  }

  /** Serve one held take as the daemon does, naming this device as the holder. */
  public serve(takeIndex: number): void {
    this.#settlementAt(takeIndex)(() => ({
      terminalId: SHELL_ID,
      holderDeviceId: THIS_DEVICE_ID,
    }));
  }

  /** Refuse one held take with the daemon's own code and message. */
  public refuse(takeIndex: number, code: string, message: string): void {
    this.#settlementAt(takeIndex)(() => {
      throw Object.assign(new Error(message), { code: -32603, data: { type: code } });
    });
  }

  #settlementAt(takeIndex: number): (settle: () => SessionTakeControlResponse) => void {
    const settlement = this.#settlements[takeIndex];
    if (settlement === undefined) {
      throw new Error(`no take number ${String(takeIndex)} is out`);
    }
    return settlement;
  }
}
