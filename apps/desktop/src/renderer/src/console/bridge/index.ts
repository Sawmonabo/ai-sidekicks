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
// seam reading one declaration rather than two spellings of one string. The two
// `run.*` stream NAMES beside it in that table are still not re-exported: their
// consumers so far are in this family, which reaches them directly, and a barrel
// specifier no cross-family import uses is a dead export rather than a convenience.
export { SESSION_EVENT_STREAM } from "./daemon/session-event-streams.js";

// Which run state a `run.*` transition kind announces — the same table, on the
// same rule, now that it has a cross-family consumer: the run-lifecycle projector
// one family up checks a durable payload's `newState` against it before storing a
// state. That check has to read THIS mapping rather than re-derive one, or the
// console would hold two answers to which state a kind announces and the fold
// would be measured against the wrong one.
export { runStateForTransitionKind } from "./daemon/session-event-streams.js";

export {
  SidekicksBridgeProvider,
  useBridgeResolution,
  useConsoleBridge,
  useConsoleClock,
} from "./BridgeProvider.js";

export { createFixtureBridge } from "./fixture/fixture-bridge.js";

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
} from "./daemon/daemon-reply.js";
export type {
  // Consumed by T-023p-1C-2, T-023p-1C-3
  DaemonReply,
  // Consumed by T-023p-1C-2, T-023p-1C-3
  DaemonReplyRefusalCode,
} from "./daemon/daemon-reply.js";
export type {
  ConsoleDaemonMethod,
  DaemonRequestOf,
  DaemonResponseOf,
} from "./daemon/daemon-reply-registry.js";
// The live bridge, for the surfaces and suites that build one over an installed
// preload contract rather than reading `window.sidekicks` themselves.
export { createLiveBridge } from "./live-bridge.js";

// 12.11's scripted view host. The TYPE leaves through this door because the browser
// family wraps one into the host a pane publishes through and has to be able to name
// it: the wiring table sits in a view family and the seam it selects on is declared
// down here, which is the only place a bridge can hold it. The factory and the
// transport marker deliberately do NOT — the fixture bridge builds one and the two
// suites that assert on the marker read the module that declares it, which is what
// `test/console/architecture/barrel-census.test.ts` names for a door line no
// production module would ever import.
export type { ScriptedPaneViewHost } from "./fixture/pane-view-host-script.js";

// The growth port's public face. The composition root builds a session-snapshot
// read over it and two surfaces read the session directory through it, so the
// port type, the one summary shape those surfaces render, the refusal they render
// instead, and the two builders that mint one all leave through this door — the
// same door the bridge itself does, because a growth refusal IS what this bridge
// answers for a wire the corpus has not registered. The second builder is for the
// arm a caller cannot answer for itself: a call that REJECTED rather than
// resolving, whose refusal has to keep this port's `origin` and this port's code
// rather than one the caller invented.
// `GrowthSessionSummary` leaves through the module that DECLARES it, never through
// `growth-values/index.js`. That inner barrel is the bridge's own sub-module door,
// reached deep by the three modules inside this family that read several planes at
// once; forwarding a name through it from here would chain one barrel into another,
// which `console-no-barrel-chain` now fails and which makes a symbol's home a matter
// of following two hops instead of reading one specifier.
export { growthUnavailable, growthUnavailableFromRejection } from "./growth-port/growth-port.js";
export type { GrowthPort } from "./growth-port/growth-port.js";
export type { GrowthSessionSummary } from "./growth-values/sessions.js";
export type { GrowthUnavailable } from "./growth-port/growth-outcome.js";
// The two-arm reading a surface holds for one such call — the port's answer, or the
// refusal a call that produced none was read as. Through this door and deliberately
// not through `growth-port/index.js`: no sibling inside `bridge/` takes it, and an
// inner barrel line no sibling reaches is a dead export `structure:dead-code` reports,
// which is how two speculative lines came off that door already.
//
// The claim is the line-comment spelling and not a `@consumedBy` JSDoc tag, measured
// rather than chosen: knip does not report a specifier on THIS door at all — a planted
// dead type re-exported here raised nothing, where the same type re-exported through
// `seats/index.ts` was reported at both its declaration and its specifier — so a JSDoc
// tag here is an unused tag and `--treat-tag-hints-as-errors` fails the run on it.
// `barrel-census.test.ts` is the gate that does report it, and it reads either
// spelling, so the line comment satisfies the instrument that has the claim.
export type {
  // Consumed by T-023p-1C-4
  GrowthReading,
} from "./growth-port/growth-outcome.js";

// The boot-time scenario decision. Exported through this door because the
// renderer root reads it — it is the one console fact that arrives on the
// document URL rather than through the bridge, and the root is above every
// family. `ScenarioFixtureControl` deliberately does NOT ship through here: its
// only caller is the provider beside it, and its only reader is a driver in
// another process that imports the module directly.
export { ScenarioSelection } from "./scenario-runtime/scenario-selection.js";

// The decode boundary for a delivered session-event envelope. Through the door
// because the frame's binder is the reader and the parse is this family's job: the
// wire's own shapes are read here and nowhere above.
export { readConsoleSessionEvent } from "./daemon/session-event-payload.js";

// `membershipRoleOf` is the injected lookup `useCallerMembershipRole` takes: the
// store's roster holds the role and deliberately names no wire member, so the read
// that narrows one lives here and travels through the door to the surfaces that
// gate a control on the caller's role (the approvals goal editor first). Its
// sibling `stampedExecutionPostureOf` is NOT published: the stamped posture waits on
// the projector that carries the member into a run body, and a door line whose only
// importer is a test is the class `test/console/architecture/barrel-census.test.ts`
// fails — its suite reads the declaring module, which is the disposition that census
// names for exactly this state.
export { membershipRoleOf } from "./daemon/entity-body-reads.js";

// The reported node state a payload member carries. Through the door for the reason
// the line above is: the narrowing runs against the contract's own schema, which this
// family admits and no view family may import, so the read belongs here and travels
// out — and the terminal's host-presence fold is the production reader that makes the
// line a door line rather than a claim.
export { readNodeState } from "./daemon/node-state-read.js";
