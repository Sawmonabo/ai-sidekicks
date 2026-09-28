// The bridge and calls both run-console suites are driven with.
//
// THE BRIDGE SCRIPTS NOTHING AND THE CALLS REJECT, ON PURPOSE. Both suites are about WHEN
// a read is performed and who owns it, never about what it answers, so every read settling
// as failed is the honest fixture: a scripted reply would invite a case to assert on a
// value neither file is about.

import { createFixtureBridge, type ConsoleBridge } from "../../bridge/index.js";
import { unscriptedScenario } from "../../bridge/fixture/call-plane/bridge.test-support.js";
import type { AgentConsoleCalls } from "./agent-console-reads.js";

/** A real fixture bridge that scripts no reply. */
export function unscriptedBridge(id: string): ConsoleBridge {
  return createFixtureBridge({ scenario: unscriptedScenario(id) });
}

/** Calls that reject, so every read they feed settles as failed. */
export const REJECTING_AGENT_CONSOLE_CALLS: AgentConsoleCalls = {
  listAgents: () => Promise.reject(new Error("no agent list is scripted")),
  readChildRunLinks: () => Promise.reject(new Error("no child run links are scripted")),
};
