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

export type {
  ConsoleBridge,
  // Consumed by T-023p-1C-4
  ConsoleBridgeSource,
} from "./console-bridge.js";

// The one answer to "which clock does this window run on". Exported because the
// two composition roots that build a clocked subsystem — the session registry and
// the durable UI-state store — both ask it, and two readings of the bridge's
// engine would be two clocks the moment one of them forgot the fixture arm.
export { consoleClockFor } from "./console-bridge.js";

// The subscribe seam's own vocabulary. Exported because the binder one family up
// passes it to `daemon.subscribe` and the fixture answers it — two sides of one
// seam reading one declaration rather than two spellings of one string. The two
// `run.*` stream NAMES beside it in that table are still not re-exported: their
// consumers so far are in this family, which reaches them directly, and a barrel
// specifier no cross-family import uses is a dead export rather than a convenience.
export { SESSION_EVENT_STREAM } from "./session-event-streams.js";

// Which run state a `run.*` transition kind announces — the same table, on the
// same rule, now that it has a cross-family consumer: the run-lifecycle projector
// one family up checks a durable payload's `newState` against it before storing a
// state. That check has to read THIS mapping rather than re-derive one, or the
// console would hold two answers to which state a kind announces and the fold
// would be measured against the wrong one.
export { runStateForTransitionKind } from "./session-event-streams.js";

export {
  SidekicksBridgeProvider,
  useBridgeResolution,
  useConsoleBridge,
  useConsoleClock,
} from "./BridgeProvider.js";

export { createFixtureBridge } from "./fixture-bridge.js";

// The one door a daemon reply enters the console through. Exported as the CALL
// plus the answer it gives and the method set it admits — and deliberately not the
// registry, the bindings, or the schemas behind them: a surface names a method and
// renders a served value or a refusal, and a surface that could reach a schema
// would be a surface that could parse a second time, differently.
export {
  // Consumed by T-023p-1C-2, T-023p-1C-3
  callDaemon,
  // Consumed by T-023p-1C-2, T-023p-1C-3
  DAEMON_REPLY_REFUSAL_ORIGIN,
} from "./daemon-reply.js";
export type {
  // Consumed by T-023p-1C-2, T-023p-1C-3
  DaemonReply,
  // Consumed by T-023p-1C-2, T-023p-1C-3
  DaemonReplyRefusalCode,
} from "./daemon-reply.js";
export type {
  ConsoleDaemonMethod,
  DaemonRequestOf,
  DaemonResponseOf,
} from "./daemon-reply-registry.js";

// The growth port's public face. The composition root builds a session-snapshot
// read over it and two surfaces read the session directory through it, so the
// port type, the one summary shape those surfaces render, the refusal they render
// instead, and the builder that mints one all leave through this door — the same
// door the bridge itself does, because a growth refusal IS what this bridge
// answers for a wire the corpus has not registered.
// `GrowthSessionSummary` leaves through the module that DECLARES it, never through
// `growth-values/index.js`. That inner barrel is the bridge's own sub-module door,
// reached deep by the three modules inside this family that read several planes at
// once; forwarding a name through it from here would chain one barrel into another,
// which `console-no-barrel-chain` now fails and which makes a symbol's home a matter
// of following two hops instead of reading one specifier.
export { growthUnavailable } from "./growth-port.js";
export type { GrowthPort } from "./growth-port.js";
export type { GrowthSessionSummary } from "./growth-values/sessions.js";
// The manifest envelope a served `artifactList` answers with. Through this door
// because the repos family's artifact model reads one into a row, and a family
// reaching past a barrel into the bridge's own modules would be the deep import
// the structure rules exist to prevent. It leaves through `artifacts.js` — the
// module that DECLARES it — on the rule the paragraph above states.
export type { GrowthArtifactSummary } from "./growth-values/artifacts.js";
// The read's own reply union and the encoding a reader switches on, for the same
// reason and through the same module: the artifact pane consumes both arms of a
// served payload read, and the arm it lands on is what it draws.
export type {
  GrowthArtifactPayloadEncoding,
  GrowthArtifactRead,
} from "./growth-values/artifacts.js";
export type { GrowthUnavailable } from "./growth-outcome.js";

// The boot-time scenario decision. Exported through this door because the
// renderer root reads it — it is the one console fact that arrives on the
// document URL rather than through the bridge, and the root is above every
// family. `ScenarioFixtureControl` deliberately does NOT ship through here: its
// only caller is the provider beside it, and its only reader is a driver in
// another process that imports the module directly.
export { ScenarioSelection } from "./scenario-selection.js";
