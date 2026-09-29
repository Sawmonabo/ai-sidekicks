// The bridge door.
//
// Everything the console reaches the outside world through: the `ConsoleBridge`
// contract, the two implementations (live preload, `define`-gated fixture), the
// provider and hooks that resolve one of them exactly once at mount, the growth
// port that refuses every wire the console does not yet have, and the ledger that
// makes those refusals checkable against the growth slate.
//
// WHY THE GROWTH LEDGER IS PART OF THIS DOOR. The console is built against wires
// that do not exist, and the honest way to do that is a port whose every operation
// refuses by name plus a manifest that says which slate row each refusal serves.
// A surface consuming `GrowthPort` and a test auditing the ledger are reading one
// vocabulary; splitting them across two doors would let the port grow an operation
// the ledger never heard of, which is precisely what the ledger shape test catches.
//
// WHAT IS NOT HERE. `scenario/corpus.ts` is the seat board six concurrent family
// branches each add one line to, and it is reached through `scenario-manifest.js`
// rather than re-exported here, so a family editing its own seat never touches
// this file.
//
// HOW A CLAIM IS SPELLED HERE. A line published ahead of its importer carries a
// line comment naming the surface that will import it, and never a `@consumedBy`
// JSDoc tag — measured rather than chosen: knip does not report a specifier on THIS
// door at all.
// A planted dead type re-exported here raised nothing, where the same type re-exported
// through `seats/index.ts` was reported at both its declaration and its specifier, so
// a JSDoc tag here is an unused tag and `--treat-tag-hints-as-errors` fails the run on
// it. This package's barrel-door rule does cover such a line and is read by a person
// either spelling, so the line comment satisfies it.
//
// Nor is the scripted pane view host — not its type, not its factory, not its
// transport marker. `console-bridge.ts` names the type on the contract and reaches
// it by its own specifier; the browser family reads the script structurally off
// `ConsoleBridge.paneViewHostScript` and names the type nowhere; and the modules
// that assert on the marker take it from the module that declares it. A door line
// for any of them would be a published name with no importer, which is the class
// this package's module rules reject.
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

// The Awareness room's subscribe name, on that same rule and now with two cross-family
// readers: the roster and the activity feed both answer this push with a read of their
// own, and each spelling the string itself would put a name only the daemon's table
// gets to fix in three places — where a correction to one of them leaves the others
// subscribed to a string the daemon does not serve, which reads as a quiet session.
export { PRESENCE_EVENT_STREAM } from "./daemon/session-event-streams.js";

// Which run state a `run.*` transition kind announces — the same table, on the
// same rule, now that it has a cross-family consumer: the run-lifecycle projector
// one family up checks a durable payload's `newState` against it before storing a
// state. That check has to read THIS mapping rather than re-derive one, or the
// console would hold two answers to which state a kind announces and the fold
// would be measured against the wrong one.
export { runStateForTransitionKind } from "./daemon/session-event-streams.js";

// The one widening of the daemon's branded `subscribe` signature, and the registered
// stream names the console opens through it. Here rather than beside a caller because
// two families need it and neither may import the other — `daemon-streams.ts` records
// the whole reasoning, including why a subscription is a different seam from a call.
export {
  PROVIDER_ACCOUNT_SUBSCRIBE_STREAM,
  QUEUE_SUBSCRIBE_STREAM,
  RUN_STATE_SUBSCRIBE_STREAM,
  subscribeDaemon,
  subscribeNodeDaemon,
} from "./daemon/daemon-streams.js";

// The wire's own readings of an identifier and of a run-state frame. Here because a
// schema is the wire's and `console/bridge/**` is the wire's edge: a family above
// this one consumes a typed reader that answers the value or `undefined`, and never
// a validator. Seven surfaces used to reach for the schema themselves, which is one
// parse per call site of exactly the kind the call door next door exists to end.
export {
  isLiveRunState,
  readProviderAccountId,
  readQueueItemId,
  readRunId,
  readRunState,
  readSessionId,
  readWorkspaceId,
} from "./daemon/wire-identifiers.js";
export {
  readInterruptRunParams,
  readInterventionRequest,
  readQueueItemCreateRequest,
} from "./daemon/wire-requests.js";

// The approvals surface's wire readings: the two reply narrowings, the resolve
// request they pair with, and the vocabulary that classifies the wire strings both
// carry. Here rather than beside the pane because `packages/contracts` publishes no
// approval payload at all, so these ARE validators, and the console's one validator
// family is this one — the pane may hold none. The projector beside them folds the
// same wire's events; a surface consumes the ANSWER and never the schema.
export {
  hasCompleteResolvedQuad,
  isResolvedState,
  type ApprovalRecord,
  type ApprovalResolveRequest,
  type ParsedRows,
  type RememberedRule,
} from "./approvals/approval-records.js";
export {
  CATEGORY_PHRASE,
  REMEMBERED_SCOPE_KINDS,
  SCOPE_KIND_PHRASE,
  STATE_PHRASE,
  STATE_TONE,
  asApprovalCategory,
  asApprovalState,
  asRememberedScopeKind,
  rememberedScopeKindPhrase,
  type RememberedScopeKind,
} from "./approvals/approval-vocabulary.js";
// The state union itself, beside the narrowing and the two tables already published
// here. A surface that grouped by state could reach the narrowing and the phrases and
// still had no way to write a table TOTAL over the five, so it would have had to
// restate them — which is the second spelling of a wire vocabulary this door exists
// to prevent. The sidebar's approvals section is its first reader.
export type { ApprovalState } from "./approvals/approval-vocabulary.js";
export { registerApprovalFlowProjectors } from "./approvals/approval-flow-projection.js";

// The goal payload readings. Through this door because the approvals surface is a
// view family and may hold no validator: what it consumes is the ANSWER — a text, an
// origin pair, or a boolean — and never the schema that produced one.
//
// The two BOUNDS a goal is refused against are deliberately not here. They are caps,
// so `console/core/constants/session-goal-caps.ts` is their one home and `core/index.js` is the door a
// surface reads them through — this family consumes them like any other caller.
export {
  isSendableGoalText,
  readGoalOriginKeys,
  readGoalPayloadText,
} from "./wire-shapes/session-goal-payloads.js";

// The declared-capability read, and the two shapes its consumers resolve against.
// Here rather than beside either consumer because two view families gate controls on
// it and neither may import the other — one read per bridge serves both, and a hook
// living in one of them would make the other's copy a second call on one wire.
export {
  useDriverCapabilities,
  useDriverCapabilityRepairRead,
} from "./driver-capabilities/driver-capability-read.js";
export { useRunDriverBindings } from "./driver-capabilities/run-driver-binding.js";
export type { DriverCapabilityReadout } from "./driver-capabilities/driver-capability-read.js";
// The pure readers over that readout, from the module that declares them: the wire
// and the questions asked of its answer are two subjects, and a door line pointing at
// whichever file used to hold both would say otherwise.
export {
  readingAcrossRuns,
  readingForDriver,
  readingForRun,
  withRunDriverBindings,
} from "./driver-capabilities/driver-capability-readings.js";
export type { DriverCapabilityReading } from "./driver-capabilities/driver-capability-readings.js";

// How far a reading got and why it got no further — the pair both wire readings
// below publish, and the accessor a surface reads the refusal through. One home,
// because two copies of the pair had drifted into two answers about when a refusal
// stops being true.
export { readRefusalOf } from "./readings/reading-lifecycle.js";
export type { WireReadState } from "./readings/reading-lifecycle.js";

// The session's one queue reading. Here for the same reason the capability read is:
// the runs pane and the composer's shelf ask two questions of one list, and each
// used to ask its own down its own subscription.
export { useQueueFeed, useQueueRepairRead } from "./queue/queue-feed.js";
export type { QueueFeed } from "./queue/queue-reading.js";
export type { ProviderQuotaReadout } from "./quotas/provider-quota-readout.js";

// This machine's OS notification permission: one read, one scheduler, one latch.
//
// Here for the quotas' reason and one more of its own. The answer is the MACHINE's, so
// it is not a session's or a page's to hold; and its two consumers — the notification
// centre and the notifications settings page — are view families, which may not import
// each other. Each folds the three wire arms differently and both are right, so what
// leaves this door is the reading and never a verdict.
export {
  useOsNotificationPermission,
  type OsNotificationPermissionReading,
} from "./os-notification-permission.js";

export {
  DesktopBridgeProvider,
  useBridgeResolution,
  useConsoleBridge,
  useConsoleClock,
} from "./BridgeProvider.js";

export { createFixtureBridge } from "./fixture/call-plane/bridge.js";

// The one door a daemon reply enters the console through. Exported as the CALL
// plus the answer it gives and the method set it admits — and deliberately not the
// registry, the bindings, or the schemas behind them: a surface names a method and
// renders a served value or a refusal, and a surface that could reach a schema
// would be a surface that could parse a second time, differently.
// The abandoned-read refusal travels beside the call itself, for the COMPOSED read
// only: one that calls the door more than once has `await` boundaries the door cannot
// see, and an abort landing in one of those gaps has to stop the fold under the code
// the door already answers with rather than under a second name for one settlement.
// `settings/pages/mounts/mount-inventory.ts` is that read — a workspace list followed
// by a per-mount fan-out.
export {
  abandonedReadRefusal,
  callDaemon,
  // Consumed by the settings family.
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
export type {
  SessionSummary,
  TimelineResubscribeRequest,
  TimelineSubscribeCall,
} from "./daemon/session-reads.js";

// The attention projection's own vocabulary. Published because the notification
// plane NARROWS against it: it used to declare a second copy of these five triggers
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
// The window's one transport-reconnect signal, published as the CLASS rather than as
// the floor's subscribe-only view: the doors that report into it — this family's own
// stream door, the seat every view family subscribes through, and the frame's
// session-event binder — reach the bridge through here, and a door publishing only
// `TransportReconnectObservable` would leave them able to subscribe and unable to
// report. A reading takes the floor's view instead, off `core/index.js`.
export { TransportReconnectSignal } from "./transport/transport-reconnect.js";
// The rule for what an OPEN observed, published beside the signal because the two
// callers outside this family — `seats/read/wire-access.ts` and the frame's session-event
// binder — each take a daemon subscription of their own and would otherwise each
// decide what taking one proves.
export { openObservedSubscription } from "./transport/observed-subscription.js";

// The saved definition the registry serves. Published because the definition picker
// in the agent console projects one onto its own row shape, and a projection cannot
// be written against a type it cannot name. It is declared on the substrate rather
// than in a view family — see `wire-shapes/agent-plane.ts`'s header — and it leaves
// through the module that DECLARES it, never through `wire-shapes/index.js`, on the
// `console-no-barrel-chain` rule the `GrowthSessionSummary` block above states.
export type { AgentDefinition } from "./wire-shapes/agent-definition.js";

// The agent plane's reply and request shapes. Published because the agent console
// and the session header RENDER them: they are declared on the substrate rather than in a
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

// The workflow plane's read shapes, for the family that renders them. Declared on
// this substrate because no code package registers a `workflow.*` type yet, and
// re-exported here rather than deep-imported because a view family reaches another
// family only through its door. Every one of them goes when `packages/contracts`
// registers the plane and `wire-shapes/workflow-projection.ts` is deleted with its
// slate row.
export { WORKFLOW_DEFINITION_SCOPES } from "./wire-shapes/workflow-projection.js";
// The plane's EVENT taxonomy, beside its read shapes and from the module that
// declares it. The run pane names these kinds to say when its snapshot goes stale;
// `wire-shapes/workflow-events.ts` states why a kind set is safe to arm against an
// unregistered wire where a payload shape would not be.
// Beside it, the one payload MEMBER a reader of those kinds needs: which run the frame
// is about. The run pane scopes its live-round reading on it, so a phase advancing in
// one run does not re-read every pane showing another.
export {
  WORKFLOW_EVENT_TYPES,
  workflowRunIdOfEventPayload,
} from "./wire-shapes/workflow-events.js";
export type {
  WorkflowDefinitionScope,
  WorkflowDefinitionSummary,
  WorkflowPhaseState,
  WorkflowRunListEntry,
  WorkflowRunSnapshot,
  WorkflowVersionChainEntry,
} from "./wire-shapes/workflow-projection.js";

// The definition BODY, on the same terms and for the same family: a detail surface
// renders the phase sequence, the entry record, the content hash and the schema
// marker, and composes the one write all five authoring acts ride. Declared beside the
// projection rather than inside it because a definition's BODY and a run's PROJECTION
// are two subjects — the first is what an author edits and the second is what an
// engine reports — and they go when their own slate rows land, which are two rows.
export type {
  McpServerBindingRef,
  WorkflowDefinitionCreateBody,
  WorkflowDefinitionReadResult,
  WorkflowPhaseDefinition,
  WorkflowVersionBody,
} from "./wire-shapes/workflow-definition-body.js";

// The file form's two sides, through the door because the surface that offers an
// export and an import is a view family and the READING side is a validator — pasted
// text narrowed against closed vocabularies into a typed request.
//
// AND THROUGH THE CODEC RATHER THAN THE FORM ITSELF, because this door is on the
// initial import graph and the form carries a YAML parser, a body reader and a
// tool-binding reader. The codec is two awaited function bodies; everything under it is
// fetched the first time somebody presses export or import. The module's own header
// says why the deferral is on this side of the door.
//
// THE TWO FUNCTIONS AND NEITHER OF THEIR TYPES. A caller composes the import target as
// a literal and reads the reading's `status` where it stands, so the two type names
// have no production importer and a door line for one would be a name published for
// symmetry — which the barrel census fails, and rightly: the module that declares them
// is where its own test reads them from.
export {
  parseWorkflowDefinitionFile,
  serializeWorkflowDefinitionFile,
} from "./wire-shapes/workflow-definition-file-codec.js";

// How an answer's members are ADDRESSED, and it leaves eagerly because everything above
// reads it before anything is compiled: `SchemaMemberPath` is the one representation a
// descriptor and an issue both carry, `isSameMemberPath` is how a control finds the
// findings that are about it, and `encodeMemberPointer` is the single string spelling
// anything keyed on a path may take. All three sit in one module, because a second
// reading of a path is exactly how two spellings of one member come apart.
export { encodeMemberPointer, isSameMemberPath } from "./wire-shapes/schema-member-path.js";
export type { SchemaMemberPath } from "./wire-shapes/schema-member-path.js";

// The other validator this family holds, and the reason it is here rather than beside
// the form it serves: a schema the wire delivered, compiled once into something a
// locally composed draft can be checked against. Every family above this one is barred
// from importing a schema library at all, which is a claim about the LAYER — a validator
// sits below every surface, so no surface can hold a second reading of one.
//
// AND THROUGH THE LOADER RATHER THAN THE COMPILER ITSELF, because this door is on the
// initial import graph and the compiler carries a schema library's JSON-Schema entry
// point behind it. Its only production readers are inside the schema form seat, which is
// a loader-backed chunk — so a runtime line for `compileSchemaValidator` assigned that
// library to the STATIC chunk, on the rule this package's module shape states,
// and put it on the document of every session that never draws a form. Measured, that
// line alone carried the initial graph past its budget. The loader is one awaited function
// body; the module's own header says why the deferral is on this side of the door.
//
// THE TYPES ARE FREE AND STAY, because a type reference erases: the seat names the
// validator and the report it renders, and the loader's own signature names the validator
// it resolves to. `SchemaValidationIssue` is published for a reader that CONSTRUCTS one —
// the schema form composes findings of its own, a drawn row the projection dropped, which
// the answer has no way to express and the schema therefore never sees.
export { loadSchemaValidatorCompiler } from "./wire-shapes/json-schema-check-loader.js";
export type {
  SchemaValidationIssue,
  SchemaValidationReport,
  SchemaValidator,
} from "./wire-shapes/json-schema-check.js";

// The boot-time scenario decision. Exported through this door because the
// renderer root reads it — it is the one console fact that arrives on the
// document URL rather than through the bridge, and the root is above every
// family. `ScenarioFixtureControl` deliberately does NOT ship through here: its
// only caller is the provider beside it, and its only reader is a driver in
// another process that imports the module directly.
export { ScenarioSelection } from "./scenario/selection.js";

// What a window plays when the launch named no scenario. Through the same door and
// from the module that declares it, because the first-launch rule in `frame/` asks
// whether the composition it is about to open into is the one nobody chose — and a
// named scenario is an ask that rule must not override.
export { DEFAULT_SCENARIO_ID } from "./scenario/selection.js";

// The decode boundary for a delivered session-event envelope. Through the door
// because the frame's binder is the reader and the parse is this family's job: the
// wire's own shapes are read here and nowhere above.
export { readConsoleSessionEvent } from "./daemon/session-event-payload.js";
export { readRollbackBoundaryPayload } from "./daemon/rollback-boundary-payload.js";
// And the boundary for the OTHER frame a session's log arrives in: one backward
// `timeline.read` window. Through the door for the same reason — the ledger's walk
// back past its window head is the reader, and a family above this one may not read a
// `TimelineRow`.
export { readEarlierTimelinePage } from "./daemon/timeline-page.js";

// The session goal: the fold that says what it is, and the two operations that change
// it. Through this door because two VIEW families read it — the approvals pane's card
// and the workspace sidebar's one-line reading — and those two may not import one
// another; the module's own header says why this is the lowest family that owns its
// inputs.
export type { SessionGoalProjection } from "./session-goal.js";
export { foldSessionGoal } from "./session-goal.js";
