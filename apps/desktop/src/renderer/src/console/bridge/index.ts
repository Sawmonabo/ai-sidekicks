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
  readChannelId,
  readProviderAccountId,
  readQueueItemId,
  readRunId,
  readRunState,
  readSessionId,
  readWorkspaceId,
} from "./daemon/wire-identifiers.js";
export { readRunRolledBack, readRunStateChange } from "./run-streams/run-state-events.js";
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
  TRIGGER_PHRASE,
  asApprovalCategory,
  asApprovalState,
  asInvalidationTrigger,
  asRememberedScopeKind,
  rememberedScopeKindPhrase,
  type RememberedScopeKind,
} from "./approvals/approval-vocabulary.js";
export { registerApprovalFlowProjectors } from "./approvals/approval-flow-projection.js";

// The goal payload readings. Through this door because the approvals surface is a
// view family and may hold no validator: what it consumes is the ANSWER — a text, an
// origin pair, or a boolean — and never the schema that produced one.
//
// The two BOUNDS a goal is refused against are deliberately not here. They are caps,
// so `console/core/constants.ts` is their one home and `core/index.js` is the door a
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
// `provider-quota-feed.ts` owns how many readings there are and how long each lives —
// and, beside the three window triggers, the fourth moment that owes one a re-read: a
// settled sign-in or a registered token changes what the registry says and neither is
// a window fact, so the surface that caused one asks rather than reading for itself.
export { useProviderAccountRefresh, useProviderQuotas } from "./quotas/provider-quota-feed.js";
export type { ProviderQuotaReadout } from "./quotas/provider-quota-readout.js";
export { remainingPercentOf } from "./quotas/provider-quota-fold.js";
export type { ProviderQuotaReading } from "./quotas/provider-quota-fold.js";

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
// The abandoned-read refusal travels beside the call itself, for the COMPOSED read
// only: one that calls the door more than once has `await` boundaries the door cannot
// see, and an abort landing in one of those gaps has to stop the fold under the code
// the door already answers with rather than under a second name for one settlement.
// `settings/pages/mounts/mount-inventory.ts` is that read — a workspace list followed
// by a per-mount fan-out.
export {
  abandonedReadRefusal,
  callDaemon,
  // Consumed by T-023p-1C-2
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
// or names the type. Two families since reach past that path: `repos/growth-call.ts`
// catches a REJECTED call — the one path the port never answers on — and hands the
// rejection to the builder, returning the type, and the workflow run pane's control
// dispatch names the outcome's refusal arm for a port answer it did not settle
// through a hook. So both travel, and the rule that took them off is unchanged: a
// door line stands while a production module reaches it, and these two are reached.
// `GrowthSessionSummary` leaves through the module that DECLARES it, never through
// `growth-values/index.js`. That inner barrel is the bridge's own sub-module door,
// reached deep by the three modules inside this family that read several planes at
// once; forwarding a name through it from here would chain one barrel into another,
// which `console-no-barrel-chain` now fails and which makes a symbol's home a matter
// of following two hops instead of reading one specifier.
export {
  growthUnavailable,
  growthUnavailableFromRejection,
} from "./growth-port/growth-refusals.js";
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
// What a provider-session import reports as it runs. Published because the import
// panel drains the progress subscription and renders the producer's own turn count
// and state verbatim; a shape read only inside the fixture would leave the surface
// narrowing an `unknown` it has no schema for.
export type { GrowthImportProgress } from "./growth-values/sessions.js";
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
// The served shape of a growth SUBSCRIPTION, published beside the outcome for the
// same reason: the deep-link path's owner drains one, and a view family that had to
// name the shape itself would be declaring a second reading of what this port
// promises.
export type { GrowthStream } from "./growth-port/growth-outcome.js";
// The window's one transport-reconnect signal, published as the CLASS rather than as
// the floor's subscribe-only view: the doors that report into it — this family's own
// stream door, the seat every view family subscribes through, and the frame's
// session-event binder — reach the bridge through here, and a door publishing only
// `TransportReconnectObservable` would leave them able to subscribe and unable to
// report. A reading takes the floor's view instead, off `core/index.js`.
export { TransportReconnectSignal } from "./transport/transport-reconnect.js";
// The rule for what an OPEN observed, published beside the signal because the two
// callers outside this family — `seats/wire-access.ts` and the frame's session-event
// binder — each take a daemon subscription of their own and would otherwise each
// decide what taking one proves.
export { openObservedSubscription } from "./transport/observed-subscription.js";

// The per-operation request and value table. Published for exactly one reader: the
// collaboration family's mutation coordinator, which binds a growth WRITE the way it
// already binds a daemon method — reading both halves off the registry rather than
// declaring them at the call site, so a surface naming an operation the slate does not
// carry, or sending it the wrong payload, does not compile. It travels as a type and
// carries no port with it, so nothing gains a way to CALL an operation through it.
export type { GrowthOperationSignatures } from "./growth-signatures/signature-table.js";

// The `invitesList` outcome, its served row, and the armable expiries of a set of
// them. Published because TWO sibling view families read that one operation — the sent
// ledger and the received shelf — and a view family may not import its sibling, so
// each had declared the pair itself under a name of its own, and each then wrote the
// expiry walk a second time. Derived off the growth signature here, once.
export type {
  InvitesListOutcome,
  InvitesListRefusal,
  ServedInvite,
} from "./growth-port/invites-outcome.js";
export { expiryDeadlinesOf } from "./growth-port/invites-outcome.js";

// The channel plane's shapes, published because the collaboration family RENDERS
// them: an audience badge, a pair-labelled row, a create form whose every field is one
// member of `GrowthChannelConfig`, and the receipts the four lifecycle writes answer
// with. They leave through the module that DECLARES them rather than through
// `growth-values/index.js`, on the `console-no-barrel-chain` rule — and the three
// vocabularies are here rather than on that inner door because their only readers are
// outside this family, which is exactly what a sub-module door does not publish.
export {
  GROWTH_CHANNEL_AUDIENCES,
  GROWTH_CHANNEL_KINDS,
  GROWTH_CHANNEL_TURN_POLICIES,
  type GrowthChannelAudience,
  type GrowthChannelConfig,
  type GrowthChannelCreateReceipt,
  type GrowthChannelKind,
  type GrowthChannelLifecycleReceipt,
  type GrowthChannelRosterEntry,
  type GrowthChannelTurnPolicy,
} from "./growth-values/channels.js";

// The membership plane's two, on the same rule: the ledger renders the identifier its
// controls are keyed by, and the roster's detail card renders the devices behind one
// person's aggregate. The device ROW inside that fan-out is deliberately not a third
// line — the card maps over `GrowthPresenceDetail["devices"]` and names the row type
// nowhere, and a door is never widened for symmetry.
export type {
  GrowthMembershipRosterEntry,
  GrowthPresenceDetail,
} from "./growth-values/memberships.js";

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
// The mint's own request union, through the same door and for the same reason: the
// diff pane composes one from the subject its address resolved to, and a second copy
// of the two arms written in that family would go on offering an attribution the wire
// had stopped admitting. The response shape stays off this door — nothing outside the
// bridge names it, the pane reading the manifest id straight off the served value.
export type { GrowthDiffArtifactCreateRequest } from "./growth-values/gitflow.js";
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
// The diagnostics plane's shapes, from the module that DECLARES them rather than
// through the inner values door — the barrel-chain rule the `GrowthSessionSummary`
// line above states. The settings family renders every one of these: a health banner
// keyed on the state, a stuck badge keyed on the signal, a recovery prompt whose
// control set IS the action vocabulary, and a retention table keyed on the bucket. A
// view family derives from the shape the wire declares or it drifts from it silently.
//
// ONE VALUE VOCABULARY LEAVES, AND THE OTHER TWO DELIBERATELY DO NOT.
// `GROWTH_RECOVERY_ACTIONS` is here because the prompt's control set is built by
// mapping it, so the page would otherwise re-spell a closed set the wire owns. The
// state and bucket arrays are read by nothing outside this family: their members
// reach the page through the union TYPES beside them, which is what a keyed lookup
// needs, and a door line no production module imports is a dead export the barrel
// census fails.
export {
  GROWTH_RECOVERY_ACTIONS,
  type GrowthFailureDetail,
  type GrowthHealthComponent,
  type GrowthHealthState,
  type GrowthHealthStatus,
  type GrowthRecoveryAction,
  type GrowthRecoveryReceipt,
  type GrowthRedactionBucket,
  type GrowthRedactionPolicy,
  type GrowthStuckRunInspection,
} from "./growth-values/diagnostics.js";

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
// THE TWO FUNCTIONS AND NEITHER OF THEIR TYPES. A caller composes the import target as
// a literal and reads the reading's `status` where it stands, so the two type names
// have no production importer and a door line for one would be a name published for
// symmetry — which the barrel census fails, and rightly: the module that declares them
// is where its own test reads them from.
export {
  parseWorkflowDefinitionFile,
  serializeWorkflowDefinitionFile,
} from "./wire-shapes/workflow-definition-file-form.js";

// The other validator this family holds, and the reason it is here rather than beside
// the form it serves: a schema the wire delivered, compiled once into something a
// locally composed draft can be checked against. Every family above this one is barred
// from importing a schema library at all, which is a claim about the LAYER — a validator
// sits below every surface, so no surface can hold a second reading of one.
//
// `SchemaValidationIssue` IS published, and it was not while every caller only READ a
// report. The schema form now composes findings of its own — a drawn row the projection
// dropped, which the answer has no way to express and the schema therefore never sees —
// and folds them into the report the surface renders, so it constructs issues rather than
// mapping them and needs the shape. One production importer, one door line.
//
// The member-path trio DOES leave, because the surfaces that read a report address their
// controls by those same paths: `SchemaMemberPath` is the one representation a descriptor
// and an issue both carry, `isSameMemberPath` is how a control finds the findings that are
// about it, and `encodeMemberPointer` is the single string spelling anything keyed on a
// path may take. All three sit beside the producer, because a second reading of a path is
// exactly how two spellings of one member come apart.
export {
  compileSchemaValidator,
  encodeMemberPointer,
  isSameMemberPath,
} from "./wire-shapes/json-schema-check.js";
export type {
  SchemaMemberPath,
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
export { ScenarioSelection } from "./scenario-runtime/scenario-selection.js";

// The decode boundary for a delivered session-event envelope. Through the door
// because the frame's binder is the reader and the parse is this family's job: the
// wire's own shapes are read here and nowhere above.
export { readConsoleSessionEvent } from "./daemon/session-event-payload.js";

// The three body reads that narrow a wire shape, all through the door because each
// has a production reader above this family. `membershipRoleOf` is the injected
// lookup `useCallerMembershipRole` takes: the store's roster holds the role and
// deliberately names no wire member, so the read that narrows one lives here and
// travels to the surfaces that gate a control on the caller's role — the approvals
// goal editor and `terminal/pane/BoundTerminalPane.tsx`, which takes it through
// `useCallerMembershipRole` to decide whether this viewer may hold the write lease.
// `stampedExecutionPostureOf` is the composer's posture chip's: it parses the
// candidate against the registered `RunStateChangeEvent` shape, which is the whole
// point — a surface checking two members loosely and asserting the type admitted a
// body with no `networkAccess`, and the chip then rendered an empty label beside two
// full ones. This door line waited on a production consumer and now has one, in
// `shell/composer/chips/chip-models.ts`.
export { membershipRoleOf, stampedExecutionPostureOf } from "./daemon/entity-body-reads.js";

// The reported node state a payload member carries. Through the door for the reason
// the line above is: the narrowing runs against the contract's own schema, which this
// family admits and no view family may import, so the read belongs here and travels
// out — and the terminal's host-presence fold is the production reader that makes the
// line a door line rather than a claim.
export { readNodeState } from "./daemon/node-state-read.js";

// The two Awareness activity fields' readings, through the door because the
// collaboration family folds a snapshot of them into its indicator registry and a
// view family may not reach past a barrel into this one. They leave through
// `growth-values/presence.js`, the module that DECLARES them, on the rule the
// `GrowthArtifactSummary` line above states.
export type {
  GrowthActivitySnapshot,
  GrowthAgentActivityReading,
  GrowthComposingReading,
} from "./growth-values/presence.js";

// The pending confirmation and the six arms one attempt on it can end in. Through
// the door and from their declaring module for the same reason: the confirmation
// surface is the collaboration family's, and every arm it renders is one of these.
export type {
  GrowthInviteAttempt,
  GrowthInviteOutcome,
  GrowthPendingInvite,
  GrowthPendingInvitePreviewFailure,
  GrowthPendingInviteRefused,
  GrowthPendingInviteState,
} from "./growth-values/invites.js";

// The composer's own composing publisher. It lives in this family because it is a
// write adapter over the growth port — the `quotas/` reads' mirror image — and it
// leaves through this door because its one production reader is the composer, which
// sits outside the console entirely and reaches every console family through a door.
export { ComposingPublisher } from "./presence/composing-publisher.js";

// The WebAuthn ceremony seam. Through the door because the sign-in family is the
// reader and this family is where the seam has to live: the fixture WRITES an
// outcome and the sign-in family READS one, so the union sits below both — the
// "two sides of one seam share a module" rule, applied across a bridge. The
// encoder is deliberately absent: a renderer that could compose an `authenticated`
// arm could assert an identity nothing established, so the writer is published to
// the fixture through that directory's own door and to nobody else.
//
// THE THREE VALUE TUPLES ARE DELIBERATELY NOT HERE. They are the reader's own
// vocabulary, narrowed against inside the declaring module and driven by its suite
// from there; the sign-in family reads the TYPES, whose totality is what makes its
// copy tables complete. Publishing the tuples would put three names on this door
// whose only reader is a test.
export {
  readCeremonyOutcome,
  type DeviceGrantHandoff,
  type ParticipantIdentityClaims,
  type WebAuthnCeremonyOutcome,
  type WebAuthnCustody,
  type WebAuthnProbeResult,
  type WebAuthnRefusalReason,
} from "./web-authn/ceremony-outcome.js";

// The session goal: the fold that says what it is, and the two operations that change
// it. Through this door because two VIEW families read it — the approvals pane's card
// and the workspace sidebar's one-line reading — and those two may not import one
// another; the module's own header says why this is the lowest family that owns its
// inputs.
export type { SessionGoalProjection } from "./session-goal.js";
export { clearSessionGoal, foldSessionGoal, updateSessionGoal } from "./session-goal.js";

// The MCP governance plane's shapes, from the module that DECLARES them rather than
// through the inner values door — the barrel-chain rule the `GrowthSessionSummary` line
// above states. The settings family renders every one of these: an inventory row per
// binding, the per-session legs behind it, the tool overrides pinned on it, and the
// per-leg outcomes a mutation answers with. `GrowthMcpServerStatus` travels with them
// because the page's status-to-tone table is a `Record` total over it, which is what
// makes a sixth status a compile error at the page rather than a blank cell.
//
// The status ARRAY is deliberately absent, and so is every other vocabulary in that
// module. Nothing above this family enumerates one — the surfaces render the value that
// arrived and key a total record on the type — and a door line no production module
// reaches is a dead export the barrel census fails rather than a convenience.
export type {
  GrowthMcpBindingRef,
  GrowthMcpInventoryEntry,
  GrowthMcpLiveApplicationResult,
  GrowthMcpMutationResult,
  GrowthMcpServerLegStatus,
  GrowthMcpServerStatus,
  GrowthMcpToolOverride,
} from "./growth-values/mcp.js";
// And the identity those rows are keyed by, from the same declaring module. It leaves
// this family because the operator page keys one settlement per binding by it, and it
// lives beside the shapes because the fixture's own inventory ledger keys by it too:
// one binding, one identity, whichever height of the DAG is asking.
export { mcpBindingKeyOf } from "./growth-values/mcp.js";
