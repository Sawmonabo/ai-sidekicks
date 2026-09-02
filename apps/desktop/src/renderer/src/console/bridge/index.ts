// The bridge door.
//
// Everything the console reaches the outside world through: the `ConsoleBridge`
// contract, the two implementations (live preload, `define`-gated fixture), the
// provider and hooks that resolve one of them exactly once at mount, the growth
// port that refuses every wire the console does not yet have, and the ledger that
// makes those refusals checkable against `Plan-023 §Console growth slate`.
//
// WHY THE GROWTH LEDGER IS PART OF THIS DOOR. The console is built against wires
// that do not exist, and the honest way to do that is a port whose every operation
// refuses by name plus a manifest that says which slate row each refusal serves.
// A surface consuming `GrowthPort` and a test auditing the ledger are reading one
// vocabulary; splitting them across two doors would let the port grow an operation
// the ledger never heard of, which is precisely what I-023-13 exists to catch.
//
// WHAT IS NOT HERE. `scenarios/index.ts` is the seat board six concurrent family
// branches each add one line to, and it is reached through `scenario-manifest.js`
// rather than re-exported here, so a family editing its own seat never touches
// this file.

export type { ConsoleBridge, ConsoleBridgeSource } from "./console-bridge.js";

// The one answer to "which clock does this window run on". Exported because the
// two composition roots that build a clocked subsystem — the session registry and
// the durable UI-state store — both ask it, and two readings of the bridge's
// engine would be two clocks the moment one of them forgot the fixture arm.
export { consoleClockFor } from "./console-bridge.js";

// The subscribe seam's own vocabulary. Exported because the binder one family up
// passes it to `daemon.subscribe` and the fixture answers it — two sides of one
// seam reading one declaration rather than two spellings of one string.
export { SESSION_EVENT_STREAM } from "./console-bridge.js";

export {
  SidekicksBridgeProvider,
  useBridgeResolution,
  useConsoleBridge,
} from "./BridgeProvider.js";

export { createFixtureBridge } from "./fixture-bridge.js";

// The growth port's public face. The composition root builds a session-snapshot
// read over it and two surfaces read the session directory through it, so the
// port type, the one summary shape those surfaces render, the refusal they render
// instead, and the builder that mints one all leave through this door — the same
// door the bridge itself does, because a growth refusal IS what this bridge
// answers for a wire the corpus has not registered.
export { growthUnavailable } from "./growth-port.js";
export type { GrowthPort, GrowthSessionSummary } from "./growth-port.js";
export type { GrowthUnavailable } from "./growth-outcome.js";

// The boot-time scenario decision. Exported through this door because the
// renderer root reads it — it is the one console fact that arrives on the
// document URL rather than through the bridge, and the root is above every
// family. `ScenarioFixtureControl` deliberately does NOT ship through here: its
// only caller is the provider beside it, and its only reader is a driver in
// another process that imports the module directly.
export { ScenarioSelection } from "./scenario-selection.js";
