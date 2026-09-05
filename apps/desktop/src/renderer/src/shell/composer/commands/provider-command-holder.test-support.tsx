// The enumeration holder's shared scaffolding.
//
// Both suites drive the same holder over the same fixture bridge, because the claim
// they split is about ONE reading served to more than one reader — and two setups
// would have made the second reader's case about a second reading.

import type { ProviderCommandListResult } from "@ai-sidekicks/contracts";
import { type ConsoleBridge } from "../../../console/bridge/index.js";
import { bridgeAnswering } from "../../../console/bridge/fixture-bridge.test-support.js";
import { COMPOSER_SCENARIO } from "../../../console/bridge/scenarios/composer.js";
import type { ComposerTarget } from "../chips/chip-models.js";
import {
  addressedProviderBinding,
  type AddressedProviderBinding,
} from "./provider-command-catalog.js";

export const ENUMERATION_METHOD = "driver.listProviderCommands";

export interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/**
 * The real fixture bridge with a recorder in front of `daemon.call`.
 *
 * The bridge family's own helper rather than a spread of this suite's: the call
 * door's chokepoint gate holds that a test outside `bridge/` stands in for a surface,
 * and a surface goes through the door.
 *
 * `parkedEnumerations`, where a case supplies it, collects a resolver for every
 * enumeration call instead of letting it answer — which is the only way to hold one
 * bridge's reply outstanding across a swap to another bridge and then let it land.
 */
export function recordingBridge(
  recorded: RecordedCall[],
  parkedEnumerations?: ((reply: unknown) => void)[],
): ConsoleBridge {
  return bridgeAnswering((call, forward) => {
    recorded.push({ method: call.method, params: call.params });
    if (parkedEnumerations !== undefined && call.method === ENUMERATION_METHOD) {
      return new Promise<unknown>((resolveEnumeration) => {
        parkedEnumerations.push(resolveEnumeration);
      });
    }
    return forward();
  }, COMPOSER_SCENARIO).bridge;
}

/**
 * A reply naming one command, in the registered result shape.
 *
 * Named distinctively so a case can tell WHICH bridge answered rather than only that
 * something did — which is the whole claim when a stale reply lands late.
 */
export function enumerationReplyNaming(commandName: string): ProviderCommandListResult {
  const binding = { driverName: "claude", providerAccountId: null };
  return {
    bindings: [
      {
        runId: null,
        binding,
        entries: [{ name: commandName, kind: "command", binding }],
        complete: true,
      },
    ],
  };
}

/**
 * Two agent addresses, distinct and shaped the way the wire requires.
 *
 * `ListProviderCommandsRequest` declares `agentId` a UUID, and the call door parses
 * the REQUEST before it leaves — so an id shaped like a label refuses at the door and
 * every case below would be reading `request-unsendable` instead of the enumeration
 * it means to assert on. What these cases need of the two ids is only that they
 * differ, which is why they are written here rather than borrowed from a scenario.
 */
export const FIRST_AGENT = "019b7a11-1100-7a6e-8110-ada11a5a3301";
export const SECOND_AGENT = "019b7a11-1100-7a6e-8110-ada11a5a3302";

export function targetForAgent(agentId: string): ComposerTarget {
  return {
    path: "provider-bound",
    sessionId: COMPOSER_SCENARIO.sessionId,
    agentId,
    agentName: undefined,
    driverName: "claude",
    targetRunId: "019b7a11-1100-740e-8110-d1a4c1150311",
    expectedRunVersion: 4,
    runState: "waiting_for_input",
    providerFailureDetail: undefined,
  };
}

/**
 * The binding the send path's lookup is scoped to.
 *
 * Derived from the same target the hook is driven with rather than written out, so a
 * case cannot accidentally look up under a binding its own composer is not addressed
 * to — which is the thing the lookup is being held to.
 */
export const ADDRESSED: AddressedProviderBinding = addressedProviderBinding(
  targetForAgent(FIRST_AGENT),
);

export function enumerationCalls(recorded: readonly RecordedCall[]): readonly RecordedCall[] {
  return recorded.filter((entry) => entry.method === ENUMERATION_METHOD);
}
