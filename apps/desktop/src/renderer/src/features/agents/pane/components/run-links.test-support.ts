// The bridge and calls both agents pane suites are driven with.
//
// THE BRIDGE SCRIPTS NOTHING AND THE CALLS REJECT, ON PURPOSE. Both suites are about WHEN
// a read is performed and who owns it, never about what it answers, so every read settling
// as failed is the honest fixture: a scripted reply would invite a case to assert on a
// value neither file is about.
import { createFixtureBridge } from "@renderer/services/platform/platform-bridge.fixture.js";
import { type PlatformBridge } from "@renderer/services/platform/platform-bridge.js";
import { unscriptedScenario } from "@test/helpers/fixture-bridge.js";
import type { AgentConsoleCalls } from "../../agent-reads.js";

/** A real fixture bridge that scripts no reply. */
export function unscriptedBridge(id: string): PlatformBridge {
  return createFixtureBridge({ scenario: unscriptedScenario(id) });
}

/** Calls that reject, so every read they feed settles as failed. */
export const REJECTING_AGENT_CONSOLE_CALLS: AgentConsoleCalls = {
  listAgents: () => Promise.reject(new Error("no agent list is scripted")),
  readChildRunLinks: () => Promise.reject(new Error("no child run links are scripted")),
};
