// The bridge and the store both run-console suites are driven with.
//
// `agent-console-model.test.ts` and `agent-console-reads.test.ts` each declared the
// same two helpers, byte for byte. They agreed because neither had been touched: an
// initialised store growing a required member, or the unscripted bridge learning a
// second override, would have had to be changed twice, and a suite left behind would
// have gone green over a subject its sibling no longer shares.
//
// THE BRIDGE SCRIPTS NOTHING ON PURPOSE. Both suites are about WHEN a read is
// performed and who owns it, never about what it answers, so every read settling as
// refused is the honest fixture: a scripted reply would invite a case to assert on a
// value neither file is about.

import {
  fixtureBridgeWithGrowth,
  unscriptedScenario,
} from "../../bridge/fixture-bridge.test-support.js";
import type { ConsoleBridge } from "../../bridge/index.js";

/** A real fixture bridge that scripts no reply, so every read settles as refused. */
export function unscriptedBridge(id: string): ConsoleBridge {
  return fixtureBridgeWithGrowth(unscriptedScenario(id), {});
}
