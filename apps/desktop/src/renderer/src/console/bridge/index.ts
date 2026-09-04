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
export { SESSION_EVENT_STREAM } from "./session-event-streams.js";

// Which run state a `run.*` transition kind announces — the same table, on the
// same rule, now that it has a cross-family consumer: the run-lifecycle projector
// one family up checks a durable payload's `newState` against it before storing a
// state. That check has to read THIS mapping rather than re-derive one, or the
// console would hold two answers to which state a kind announces and the fold
// would be measured against the wrong one.
export { runStateForTransitionKind } from "./session-event-streams.js";

// The one widening of the daemon's branded `call` / `subscribe` signatures, and the
// registered method-name constants the console reaches through it. Here rather than
// beside a caller because two families need it and neither may import the other —
// `daemon-calls.ts` records the whole reasoning.
export {
  COMPACT_CONTEXT_METHOD,
  DAEMON_STREAM_REFUSAL_ORIGIN,
  DRIVER_LIST_CAPABILITIES_METHOD,
  LIST_PROVIDER_COMMANDS_METHOD,
  PROVIDER_ACCOUNT_LIST_METHOD,
  PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
  QUEUE_CANCEL_METHOD,
  QUEUE_LIST_METHOD,
  QUEUE_SUBSCRIBE_STREAM,
  RUN_INTERVENE_METHOD,
  RUN_PAUSE_METHOD,
  RUN_RESUME_METHOD,
  RUN_STATE_SUBSCRIBE_STREAM,
  callDaemon,
  subscribeDaemon,
  subscribeNodeDaemon,
} from "./daemon-calls.js";
export type { DaemonStreamOpen } from "./daemon-calls.js";

// The declared-capability read, and the two shapes its consumers resolve against.
// Here rather than beside either consumer because two view families gate controls on
// it and neither may import the other — one read per bridge serves both, and a hook
// living in one of them would make the other's copy a second call on one wire.
export {
  declaredFlagsForDriver,
  useDriverCapabilities,
  useDriverCapabilityRepairRead,
} from "./driver-capability-read.js";
export { SessionRepairWatcher } from "./session-repair-watcher.js";
export type { DeclaredDriverFlags, DriverCapabilityReadout } from "./driver-capability-read.js";

// The session's one queue reading. Here for the same reason the capability read is:
// the runs pane and the composer's shelf ask two questions of one list, and each
// used to ask its own down its own subscription.
export { useQueueFeed } from "./queue-feed.js";
export type { QueueFeed, QueueReadPhase } from "./queue-reading.js";

// The node's provider-account quotas: one read, one tail, one fold per bridge.
//
// Here rather than in the composer because the readings are the NODE's and not a
// session's — `usage.rate_limit_update` is bound to the node-scope sentinel session,
// so no session store ever held one and the composer's timeline fold could only ever
// have rendered a fixture. A settings surface listing accounts asks the same
// question of the same registry, so the read lives at the bridge where both reach it.
//
// Three modules, and the door re-exports each symbol from the one that DECLARES it:
// `provider-quota-fold.ts` owns which reading is current and what a surface renders
// for it, `provider-account-quota.ts` owns the wire that feeds it, and
// `provider-quota-feed.ts` owns how many readings there are and how long each lives.
export { useProviderQuotas } from "./provider-quota-feed.js";
export type { ProviderQuotaReadPhase, ProviderQuotaReadout } from "./provider-account-quota.js";
export { PROVIDER_QUOTA_REFUSAL_ORIGIN } from "./provider-account-quota.js";
export { remainingPercentOf } from "./provider-quota-fold.js";
export type { ProviderQuotaReading } from "./provider-quota-fold.js";

// State that belongs to the bridge and session it was produced under. Here rather
// than beside either consumer because two of them — the runs pane's live feed and
// the composer's attachment picker — sit in different families that may not import
// one another, and the failure it closes is the same failure in both: a mounted
// surface rebound to another subject rendering the previous one's answer, and a read
// still in flight settling into a surface that has since moved on.
export { useSessionScopedState } from "./session-scoped-state.js";
export type { SessionScopedState } from "./session-scoped-state.js";

export {
  SidekicksBridgeProvider,
  useBridgeResolution,
  useConsoleBridge,
  useConsoleClock,
} from "./BridgeProvider.js";

export { createFixtureBridge } from "./fixture-bridge.js";

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
export type { GrowthUnavailable } from "./growth-outcome.js";

// The boot-time scenario decision. Exported through this door because the
// renderer root reads it — it is the one console fact that arrives on the
// document URL rather than through the bridge, and the root is above every
// family. `ScenarioFixtureControl` deliberately does NOT ship through here: its
// only caller is the provider beside it, and its only reader is a driver in
// another process that imports the module directly.
export { ScenarioSelection } from "./scenario-selection.js";
