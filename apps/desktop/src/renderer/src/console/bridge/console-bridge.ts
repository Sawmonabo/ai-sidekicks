// What the console holds instead of `window.sidekicks`.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge requires the fixture to
// be "shape-identical to `SidekicksBridge`". The cheapest way to keep a claim like
// that true is to make it a type: both bridges below ARE `SidekicksBridge`, so a
// namespace added to the contract breaks the fixture at compile time rather than at
// review time.
//
// The growth port sits BESIDE the bridge rather than inside it, for the same
// reason. Folding unregistered wires into `SidekicksBridge` would put methods on the
// preload contract that the preload does not expose — the fixture would then be
// shape-identical to a lie. Beside it, the two surfaces stay honest: `sidekicks` is
// exactly what the preload gives, `growth` is exactly what it does not.

import type { SidekicksBridge } from "@ai-sidekicks/contracts";
import type { GrowthPort } from "./growth-port.js";
import type { ScenarioEngine } from "./scenario.js";

/** Which bridge the console is running against. Rendered, never inferred. */
export type ConsoleBridgeSource = "live" | "fixture";

export interface ConsoleBridge {
  /** Exactly the preload contract. Shape-identical across both sources. */
  readonly sidekicks: SidekicksBridge;
  /** The single fixture-only seam for wires the corpus has not registered. */
  readonly growth: GrowthPort;
  readonly source: ConsoleBridgeSource;
  /** Present only under the fixture, so a surface can drive playback in a story. */
  readonly scenarioEngine: ScenarioEngine | undefined;
}
