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
//
// HOW A CLAIM IS SPELLED HERE. A line published ahead of its importer carries the
// `// Consumed by T-023p-1C-<n>` line comment and never a `@consumedBy` JSDoc tag —
// measured rather than chosen: knip does not report a specifier on THIS door at all.
// A planted dead type re-exported here raised nothing, where the same type re-exported
// through `seats/index.ts` was reported at both its declaration and its specifier, so
// a JSDoc tag here is an unused tag and `--treat-tag-hints-as-errors` fails the run on
// it. `barrel-census.test.ts` is the gate that does report such a line, and it reads
// either spelling, so the line comment satisfies the instrument that has the claim.
//
// Nor is the scripted pane view host — not its type, not its factory, not its
// transport marker. `console-bridge.ts` names the type on the contract and reaches
// it by its own specifier; the browser family reads the script structurally off
// `ConsoleBridge.paneViewHostScript` and names the type nowhere; and the modules
// that assert on the marker take it from the module that declares it. A door line
// for any of them would be a published name with no importer, which is the class
// `test/console/architecture/barrel-census.test.ts` fails.
//
// Nor is `createLiveBridge`. Its one production reader is `BridgeProvider.tsx`
// beside it, which imports the declaring module, and the harnesses that build a
// live bridge over the fixture's own preload namespace do the same — a door line
// would be a second path to a symbol no cross-family production module takes, and
// `.dependency-cruiser.families.mjs` names this symbol where it records why a
// `.test-support` module is subtracted from the door rule at all.

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
  callDaemon,
  // Consumed by T-023p-1C-3
  DAEMON_REPLY_REFUSAL_ORIGIN,
} from "./daemon/daemon-reply.js";
export type { DaemonReply, DaemonReplyRefusalCode } from "./daemon/daemon-reply.js";
export type {
  ConsoleDaemonMethod,
  DaemonRequestOf,
  DaemonResponseOf,
} from "./daemon/daemon-reply-registry.js";

// One widening from a held id string to a registered request's branded id, beside the
// door whose request parse is what makes it a checked widening rather than a claim.
export { heldIdAsWireId } from "./daemon/wire-ids.js";

// The growth port's public face. The composition root builds a session-snapshot
// read over it and every surface that offers sessions reads the directory through
// `seats/`, so the port type, the one summary shape those surfaces render, the
// refusal they render instead, and the builder that mints one all leave through this
// door — the same door the bridge itself does, because a growth refusal IS what this
// bridge answers for a wire the corpus has not registered.
// `growthUnavailableFromRejection` AND `GrowthUnavailable` are here for readers
// outside the session directory, which is the distinction the reading layer drew when
// it took both off. A directory read settles through `readings/read-settlement.js`
// below and keeps the daemon's own code, so nothing on that path mints a port refusal
// or names the type. Three families since reach past that path: `repos/growth-call.ts`
// catches a REJECTED call — the one path the port never answers on — and hands the
// rejection to the builder, returning the type; the workflow run pane's control
// dispatch names the outcome's refusal arm for a port answer it did not settle
// through a hook; and the workspace family's auxiliary hand-off reaches the type from
// the act side, translating a growth refusal into its own vocabulary by branching on
// which growth code was raised, so it names the union rather than a settled read's
// `SettledReadRefusal`. So both travel, and the rule that took them off is unchanged:
// a door line stands while a production module reaches it, and these two are reached.
// `settledGrowthCall` travels beside them and on the same rule — it is what every
// growth ACT settles through, and the auxiliary pane hand-off and its error watch are
// the production callers that make the line a door line rather than a claim.
// `GrowthSessionSummary` leaves through the module that DECLARES it, never through
// `growth-values/index.js`. That inner barrel is the bridge's own sub-module door,
// reached deep by the three modules inside this family that read several planes at
// once; forwarding a name through it from here would chain one barrel into another,
// which `console-no-barrel-chain` now fails and which makes a symbol's home a matter
// of following two hops instead of reading one specifier.
export {
  growthUnavailable,
  growthUnavailableFromRejection,
  settledGrowthCall,
} from "./growth-port/growth-port.js";
// `GrowthPortRefusalCode` stays OFF this door beside it. The closed code union is
// what the port's own refusal arms are written in, and nothing outside
// `growth-port/growth-outcome.ts` names it at all, so a door line for it would
// publish a specifier with no importer — the class `barrel-census.test.ts` fails.
// `createRefusingGrowthPort` is withheld on the same rule from the other side: its
// one production caller is `live-bridge.ts` inside this family, which takes it
// through `growth-port/index.js`, the inner door its siblings already read.
export type { GrowthPort } from "./growth-port/growth-port.js";
// The operation id, beside the port and the builder that both speak it. Withheld, it
// made `GrowthPort` unusable through this door by anyone composing a partial one: the
// port's method types and `growthUnavailable`'s parameter are BOTH written in this
// union, so a family scripting a port could not name the type it had to satisfy and
// reached for `as unknown as Partial<GrowthPort>` instead — a cast that switches off
// the checking on the whole object to get past one member it could not spell. It
// leaves through `growth-port/growth-entry.js`, the module that declares it.
export type { GrowthOperationId } from "./growth-port/growth-entry.js";
export type { GrowthSessionSummary } from "./growth-values/sessions.js";
// The attention projection's own vocabulary. Published because the notification
// plane NARROWS against it: it used to declare a second copy of these six triggers
// and two severities, which is two closed sets that agree until one of them is
// widened and nothing notices.
export {
  ATTENTION_SEVERITIES,
  ATTENTION_TRIGGERS,
  type AttentionItem,
  type AttentionProjection,
  type AttentionSeverity,
  type AttentionTrigger,
} from "./wire-shapes/attention-projection.js";
// The outcome union itself. A caller outside this family narrows on it; its refusal
// ARM does not travel, for the reason stated above the growth-port block.
export type { GrowthOutcome } from "./growth-port/growth-outcome.js";

// The `invitesList` outcome and its served row. Published because TWO sibling view
// families read that one operation — the sent ledger and the received shelf — and a
// view family may not import its sibling, so each had declared the pair itself under
// a name of its own. Derived off the growth signature here, once.
export type {
  InvitesListOutcome,
  InvitesListRefusal,
  ServedInvite,
} from "./growth-port/invites-outcome.js";

// The saved definition the registry serves. Published because the definition picker
// in the agent console projects one onto its own row shape, and a projection cannot
// be written against a type it cannot name. It is declared on the substrate rather
// than in a view family — see `wire-shapes/agent-plane.ts`'s header — and it leaves
// through the module that DECLARES it, never through `wire-shapes/index.js`, on the
// `console-no-barrel-chain` rule the `GrowthSessionSummary` block above states.
export type { SidekickDefinition } from "./wire-shapes/sidekick-definition.js";

// The agent plane's reply and request shapes. Published because the agent console
// and the cast bar RENDER them: they are declared on the substrate rather than in a
// view family — see `wire-shapes/agent-plane.ts`'s header — so the family that draws
// a roster card reads its shape through this door like any other cross-family import.
// They leave through the module that declares them on the same rule as the line
// above.
export type {
  AgentAttachReading,
  AgentAttachRequest,
  AgentConfigUpdateReading,
  AgentConfigUpdateRequest,
  AgentDetachRequest,
  AgentListRequest,
  AgentPendingSwitch,
  AgentResolvedConfiguration,
  AgentRosterEntry,
  AgentRosterReading,
  AgentSwitchSettlement,
  ChildRunLink,
  ChildRunLinkReadRequest,
  ChildRunLinkReading,
  ChildRunRejection,
  PeerInvocationReading,
  PeerInvocationSetRequest,
} from "./wire-shapes/agent-plane.js";

// The manifest envelope a served `artifactList` answers with. Through this door
// because the repos family's artifact model reads one into a row, and a family
// reaching past a barrel into the bridge's own modules would be the deep import
// the structure rules exist to prevent. It leaves through `artifacts.js` — the
// module that DECLARES it — on the rule the paragraph above states.
export type { GrowthArtifactSummary } from "./growth-values/artifacts.js";
// The PR-preparation vocabulary, through the same door and for the reason the
// artifact vocabularies below are here: the repos family's prepared proposal carries
// this state and used to DECLARE a second copy of the two words, member for member,
// each under a comment claiming to be the one home. The family aliases this one now,
// so a member the wire drops stops being assignable in the gate.
export {
  GROWTH_PR_PREPARATION_STATES,
  type GrowthPrPreparationState,
} from "./growth-values/gitflow.js";
// The read's own reply union and the encoding a reader switches on, for the same
// reason and through the same module: the artifact pane consumes both arms of a
// served payload read, and the arm it lands on is what it draws.
export type {
  GrowthArtifactPayloadEncoding,
  GrowthArtifactRead,
} from "./growth-values/artifacts.js";
// The manifest's own closed vocabularies, through the same door and for the reason
// that door exists: the repos family renders every one of them — a state chip, a
// visibility chip, a type filter, a replication sentence, a delete receipt's
// disposition — and it used to DECLARE a second copy of each, member for member,
// under a comment claiming to be the one home. A view family derives from the shape
// the wire declares or it drifts from it silently, and the drift that matters is the
// wire dropping a member: a second union goes on offering it with nothing failing.
export {
  GROWTH_ARTIFACT_TYPES,
  // The receipt itself, beside the disposition it carries: a surface that renders
  // where the bytes went is holding the whole receipt, and publishing the member's
  // vocabulary without the record it sits in left the family annotating one and
  // inferring the other.
  type GrowthArtifactDeleteReceipt,
  type GrowthArtifactPayloadDisposition,
  type GrowthArtifactReplicationStatus,
  type GrowthArtifactState,
  type GrowthArtifactType,
  type GrowthArtifactVisibility,
} from "./growth-values/artifacts.js";
// The port's own refusal vocabulary, for the callers that turn a REJECTED call into a
// refusal. A growth call has two failure paths — the port answers `unavailable`, or the
// call throws — and the artifact pane used to stamp the second with the repos family's
// daemon-read origin and a daemon-reply code, so one operation reported two subsystem
// names and neither was the port's.
export { GROWTH_PORT_REFUSAL_ORIGIN } from "./growth-port/growth-outcome.js";
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
export type { GrowthReading } from "./growth-port/growth-outcome.js";

// The code a refusing port answers with, published because one view family's own
// refusal union is declared as this code widened by its own — so the union is built
// from the port's word for it rather than from a second literal that would drift.
export { WIRE_UNREGISTERED_REFUSAL_CODE } from "./growth-port/growth-outcome.js";

// The growth ledger's row lookup, through the door this file's header already claims
// it for ("the ledger that makes those refusals checkable"). A view family that must
// render an absence names the row that would fill it, and reading the row through the
// barrel is what keeps a family out of this one's interior — the deep import a card
// would otherwise take is exactly the reach past a door the layout rules forbid.
export { growthSlateRow, type GrowthSlateRow } from "./growth-port/growth-slate.js";

// The posture vocabulary the definitions registry declares. Through this door
// because the new-session draft's picker offers the same three modes: a second
// declaration in the workspace family would be the parallel closed set the module
// rule forbids, and the draft's own type derives from the contracts package, so the
// compiler holds the two to each other at the call site.
export { SIDEKICK_POSTURE_MODES } from "./wire-shapes/sidekick-definition.js";

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
export { readRollbackBoundaryPayload } from "./daemon/rollback-boundary-payload.js";

// `membershipRoleOf` is the injected lookup `useCallerMembershipRole` takes: the
// store's roster holds the role and deliberately names no wire member, so the read
// that narrows one lives here and travels through the door to the surfaces that
// gate a control on the caller's role — `terminal/pane/BoundTerminalPane.tsx`, which
// takes it through `useCallerMembershipRole` to decide whether this viewer may hold
// the write lease, is the reader today and the reason the line is a door line. Its
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
