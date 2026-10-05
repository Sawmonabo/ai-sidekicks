// The bridge and calls both agents pane suites are driven with. The bridge scripts nothing and the
// calls reject: the suites are about when a read is performed and who owns it, not what it answers.
import {
  createFixtureBridge,
  type FixtureBridge,
} from "@renderer/services/platform/platform-bridge.fixture.js";
import { unscriptedScenario } from "@test/helpers/fixture/bridge.js";
import type { AgentsPaneCalls } from "./agent-reads.js";

/** A fixture bridge that scripts no reply, and the engine whose frozen clock its window runs on. */
export function unscriptedBridge(id: string): FixtureBridge {
  return createFixtureBridge({ scenario: unscriptedScenario(id) });
}

/** Calls that reject, so every read they feed settles as failed. */
export const REJECTING_AGENTS_PANE_CALLS: AgentsPaneCalls = {
  listAgents: () => Promise.reject(new Error("no agent list is scripted")),
  readChildRunLinks: () => Promise.reject(new Error("no child run links are scripted")),
};
