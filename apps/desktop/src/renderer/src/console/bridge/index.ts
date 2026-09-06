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

// The growth port's public face. The composition root builds a session-snapshot
// read over it and every surface that offers sessions reads the directory through
// `seats/`, so the port type, the one summary shape those surfaces render, the
// refusal they render instead, and the builder that mints one all leave through this
// door — the same door the bridge itself does, because a growth refusal IS what this
// bridge answers for a wire the corpus has not registered.
// `growthUnavailableFromRejection` deliberately does NOT: every growth call in the
// console settles through `readings/read-settlement.js` below, which keeps the
// daemon's own code rather than restamping it, so that builder's only importer is a
// suite beside it — the class `barrel-census.test.ts` fails on this door.
// `GrowthUnavailable` DOES, and the substrate this family sits on takes it off: the
// one surface that named it there settles through that same reading now. Here the
// outcome's refusal arm is named again, by the run pane's control dispatch, which
// reads a port answer it did not settle through a hook — a reader, so a line.
// `GrowthSessionSummary` leaves through the module that DECLARES it, never through
// `growth-values/index.js`. That inner barrel is the bridge's own sub-module door,
// reached deep by the three modules inside this family that read several planes at
// once; forwarding a name through it from here would chain one barrel into another,
// which `console-no-barrel-chain` now fails and which makes a symbol's home a matter
// of following two hops instead of reading one specifier.
export { growthUnavailable } from "./growth-port/growth-port.js";
export type { GrowthPort } from "./growth-port/growth-port.js";
export type { GrowthSessionSummary } from "./growth-values/sessions.js";
export type { GrowthUnavailable } from "./growth-port/growth-outcome.js";

// Which kind of nothing a growth refusal IS — the console never asked, or the asking
// failed. Every surface that offers the node's sessions has to answer it before it
// can choose an absence, and three of them were answering it by eye and each getting
// it wrong the same way, so the reading leaves through this door beside the code it
// reads.
export { isUnbuiltWireRefusal } from "./growth-port/growth-outcome.js";
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

// The code a refusing port answers with, published because one view family's own
// refusal union is declared as this code widened by its own — so the union is built
// from the port's word for it rather than from a second literal that would drift.
export { WIRE_UNREGISTERED_REFUSAL_CODE } from "./growth-port/growth-outcome.js";

// How a growth read ENDS when its seam can also REJECT. It lives in this family
// because it settles a promise the growth port returned and knows nothing about any
// surface, and in `readings/` because what it is about is the READING rather than any
// one wire. It leaves through this door and through no inner one, and the rule for
// that is stated once — in `readings/read-settlement.ts`'s own header, where a reader
// meets the module: no `bridge/` sibling reads this pair, so an inner barrel would
// publish a name nothing inside the family takes, which is the dead export
// `structure:dead-code` reports.
// `READ_SETTLEMENT_REFUSAL_ORIGIN` deliberately stays off this door for the same
// rule from the other side: its only readers are the suites that assert who a
// synthesized refusal names, and a door line no production reader uses is a dead
// export rather than a convenience.
export { settleGrowthRead, useSettledGrowthRead } from "./readings/read-settlement.js";
export type { SettledReadRefusal } from "./readings/read-settlement.js";

// The workflow plane's read shapes, for the family that renders them. Declared on
// this substrate because no code package registers a `workflow.*` type yet, and
// re-exported here rather than deep-imported because a view family reaches another
// family only through its door. Every one of them goes when `packages/contracts`
// registers the plane and `wire-shapes/workflow-projection.ts` is deleted with its
// slate row.
export { WORKFLOW_DEFINITION_SCOPES } from "./wire-shapes/workflow-projection.js";
export type {
  WorkflowDefinitionScope,
  WorkflowDefinitionSummary,
  WorkflowPhaseState,
  WorkflowRunListEntry,
  WorkflowRunSnapshot,
  WorkflowVersionChainEntry,
} from "./wire-shapes/workflow-projection.js";

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

// `entity-body-reads.ts` is deliberately NOT published here. Its two reads have no
// production consumer yet — the composition root will hand `membershipRoleOf` to
// `useCallerMembershipRole` as its injected lookup, and the stamped posture waits on
// the projector that carries the member into a run body — and a door line whose only
// importer is a test is the class `test/console/architecture/barrel-census.test.ts`
// fails. Their suites read the declaring module, which is the disposition that census
// names for exactly this state.
