// Shared scaffolding for the enumeration suites: a fixture bridge that records every daemon call,
// and a composer target addressed at one agent.

import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { bridgeAnswering, type RecordedDaemonCall } from "@test/helpers/fixture/bridge.js";
import { WAITING_FOR_INPUT_SCENARIO } from "@fixtures/scenarios/waiting-for-input.js";
import type { ComposerTarget } from "../../composer-target.js";

/** The wire method the enumeration calls. */
const ENUMERATION_METHOD = "driver.listProviderCommands";

/** The fixture bridge with a recorder in front of `daemon.call`. */
export function recordingBridge(recorded: RecordedDaemonCall[]): PlatformBridge {
  return bridgeAnswering((call, forward) => {
    recorded.push({ method: call.method, params: call.params });
    return forward();
  }, WAITING_FOR_INPUT_SCENARIO).bridge;
}

/**
 * An agent address shaped as the wire requires: the request declares `agentId` a UUID and
 * `callDaemon` parses it before sending, so a label-shaped id refuses as `request-unsendable`.
 */
export const FIRST_AGENT = "019b7a11-1100-7a6e-8110-ada11a5a3301";
/** A second agent id, so a case can address a different agent. */
export const SECOND_AGENT = "019b7a11-1100-7a6e-8110-ada11a5a3302";

/** A provider-bound composer target addressed at the given agent. */
export function targetForAgent(agentId: string): ComposerTarget {
  return {
    path: "provider-bound",
    sessionId: WAITING_FOR_INPUT_SCENARIO.sessionId,
    agentId,
    driverName: "claude",
    targetRunId: "019b7a11-1100-740e-8110-d1a4c1150311",
    expectedRunVersion: 4,
    providerFailureDetail: undefined,
  };
}

/** The recorded calls that were enumeration requests. */
export function enumerationCalls(
  recorded: readonly RecordedDaemonCall[],
): readonly RecordedDaemonCall[] {
  return recorded.filter((entry) => entry.method === ENUMERATION_METHOD);
}
