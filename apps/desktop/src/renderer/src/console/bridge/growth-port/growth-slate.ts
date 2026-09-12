// The console's in-tree growth slate.
//
// The slate is the honest ledger of every wire the console builds against the
// fixture and does not yet have. This module is that ledger as data, so the growth
// port and the scenario manifest can be checked against it by a test rather than by
// a reviewer's memory.
//
// The coupling the test enforces is this: a row leaves the table when its wire
// lands, and a console change that wires a surface live against an unregistered
// wire is a review rejection. So every row here carries
// `wireRegistered: false` — that is what being ON the slate MEANS — and every port
// entry naming a row must declare itself fixture-only. When a wire lands, its row
// is deleted here and from the owning document in the same change, and the test then fails on the
// port entry that still claims fixture-only, which is exactly the reminder the
// console wants at that moment.
//
// THE ROW SHAPE AND THE CLOSED ID SET ARE `growth-slate-row.ts`'S — read that module
// for what a row IS. What is left here is the ledger itself and the two views over
// it, which is the half that changes every time a surface is built against a wire
// the corpus has not registered.
//
// AND THE CONSUMING SURFACE IS `growth-slate-consumers.ts`'S, split off by CONSUMER.
// What stays here is what a RUNNING console reads: `wire` composes the sentence a
// person sees when an operation refuses, `owningDocument` travels on that refusal's
// ledger, and `wireRegistered` is the gate two ledger cards read. Which surface waits
// on a row is read by no shipped module at all, and this table is on the initial
// import graph — so those fifty-seven sentences are next door, where the bundler leaves them
// off the document every session downloads.

import type { GrowthSlateRow, GrowthSlateRowId } from "./growth-slate-row.js";

/**
 * Every row, keyed by its id.
 *
 * A `Record` keyed by `GrowthSlateRowId` rather than a bare array, and each value's
 * `id` pinned to its own key by the mapped type. The array this replaced listed the
 * rows a SECOND time beside the union above, and nothing checked the two agreed: an
 * id added to the union with no row beneath it compiled fine and threw at runtime
 * the first time a port entry named it. Both directions are now compile errors —
 * a missing row, an unknown key, and a row filed under the wrong id.
 *
 * Insertion order is the owning table's order and `Object.values` preserves it, so
 * `GROWTH_SLATE_ROWS` below still reads in table order for diff legibility.
 */
const GROWTH_SLATE_ROWS_BY_ID: {
  readonly [Id in GrowthSlateRowId]: GrowthSlateRow & { readonly id: Id };
} = {
  "browser-pane-namespace": {
    id: "browser-pane-namespace",
    wire: "browser pane kind, the browser bridge namespace, and the two node-wide browser settings",
    owningDocument:
      "the preload bridge contract and the console's design language; the embedded-browser decision",
    wireRegistered: false,
  },
  "browser-tool-relay": {
    id: "browser-tool-relay",
    wire: "browser tool set as callback-tool rows plus the daemon-to-desktop tool-call relay",
    owningDocument: "the provider driver design; the embedded-browser decision",
    wireRegistered: false,
  },
  "terminal-pane": {
    id: "terminal-pane",
    wire: "terminal pane as a renderer surface with the shared-terminal write lease's renderer obligations",
    owningDocument: "the runtime-node and shared-terminal design",
    wireRegistered: false,
  },
  "dev-server-probe": {
    id: "dev-server-probe",
    wire: "live-listener probe for the dev-server chip",
    owningDocument: "the daemon method surface, or the embedded-browser decision",
    wireRegistered: false,
  },
  "session-lifecycle-verbs": {
    id: "session-lifecycle-verbs",
    wire: "session lifecycle verbs — rename, archive, close, reactivate",
    owningDocument: "the session core",
    wireRegistered: false,
  },
  "session-directory-read": {
    id: "session-directory-read",
    wire: "typed session snapshot read for a store's base state, and the user's session directory read, over the daemon method union, plus the resume-position member on that read's request — `SessionReadRequest` is strict over `sessionId` alone and `SessionSubscribeRequest.afterCursor` is the only cursor a registered request carries",
    owningDocument:
      "the daemon method union; the session.read payloads (no directory read is registered)",
    wireRegistered: false,
  },
  "daemon-control-methods": {
    id: "daemon-control-methods",
    wire: "daemon status-read, stop, and restart method strings",
    owningDocument: "the daemon method surface",
    wireRegistered: false,
  },
  "onboarding-methods": {
    id: "onboarding-methods",
    wire: "the five-method onboarding registration and its error codes",
    owningDocument: "the onboarding design",
    wireRegistered: false,
  },
  "shell-config-preferences": {
    id: "shell-config-preferences",
    wire: "shell-config preference carrier on the bridge (crash-report opt-out, the two browser switches, the auto-update toggle)",
    owningDocument: "the preload bridge contract and the shell's state and data implications",
    wireRegistered: false,
  },
  "health-subscribe": {
    id: "health-subscribe",
    wire: "the health subscription",
    owningDocument: "the observability and failure-recovery design",
    wireRegistered: false,
  },
  "agent-snapshot-axes": {
    id: "agent-snapshot-axes",
    wire: "the four `agent.*` verbs (roster read, attach, configuration update, detach) and the agent-list projection of the four attach-time snapshot axes (optional members)",
    owningDocument: "the sidekick-definitions design and the orchestration design",
    wireRegistered: false,
  },
  // The linkage read is its own row rather than a member of the agent row above,
  // because it is a different namespace with a different owner: an agent is a
  // user in a session and a child run is a relationship between two RUNS, and
  // the refusal fold it carries has no counterpart on any agent read.
  "child-run-linkage": {
    id: "child-run-linkage",
    wire: "one parent run's child-run links and the fold of the creates that were refused",
    owningDocument: "the orchestration design",
    wireRegistered: false,
  },
  // THE TWO SWITCH TERMINALS ARE TWO ROWS, NOT ONE, AND THAT IS THE CONSUMER TALKING.
  // They are registered by one amendment and will leave this table together, which is
  // an argument for one row — but a slate row's job is to name a wire and the SURFACE
  // waiting on it, and these two are waited on by different surfaces for opposite
  // reasons. The failed terminal is a caution the composer's target chip renders; the
  // applied terminal is a settlement the agent card's own line renders, and it is the
  // one the runs view needs to draw a status row at all. Folded into one row, the
  // second surface was invisible: the ledger named the failure alone, and every reader
  // of it concluded the console was owed one event.
  "agent-provider-switch-failure": {
    id: "agent-provider-switch-failure",
    wire: "the `agent.provider_switch_failed` event type, so a deferred switch that could not be applied reaches a client that did not issue the mutation",
    owningDocument: "the event taxonomy and the orchestration design",
    wireRegistered: false,
  },
  "agent-provider-switch-terminal": {
    id: "agent-provider-switch-terminal",
    wire: "the `agent.provider_switched` event type, so a switch that applied at a deferred boundary reaches a client that did not issue the mutation — the settlement carrying its continuity arm and its declared losses",
    owningDocument: "the event taxonomy and the orchestration design",
    wireRegistered: false,
  },
  "gitflow-actions": {
    id: "gitflow-actions",
    wire: "the branch-context read, the diff-artifact create, the PR-preparation call, the git action-execute vocabulary, and the gitflow error namespace",
    owningDocument: "the git flow and change-proposal design",
    wireRegistered: false,
  },
  // WHERE THE PANE'S SAVE GOES, AND WHY IT IS NOT A ROW HERE. An artifact read hands
  // back bytes, and the pane has to be able to put them somewhere — so the question is
  // whether that producer is missing too. It is not: `native.showSaveDialog` is on the
  // `SidekicksBridge` contract in `packages/contracts/src/desktop-bridge.ts` beside the
  // rest of the `native` namespace, and both bridges refuse it as an absent CAPABILITY
  // rather than an unregistered wire. A row here would be the wrong record of that —
  // this table's rows are wires no document registers, and adding one for a method the
  // contract already names would put a wire on the slate that has nothing to land.
  //
  // The residual is narrower and belongs to that package rather than to this one: its
  // `SaveDialogOptions` and `SaveDialogResult` are stubs declaring no member, so
  // a caller can neither suggest a filename nor read back the path a person chose. That
  // is a shape to fill in where it is declared, not a wire to register here, and it is
  // recorded at the row it would otherwise be minted against so the next reader does
  // not mint one.
  "artifact-ingest-and-crud": {
    id: "artifact-ingest-and-crud",
    wire: "attachment ingest method-name table and artifact CRUD method strings",
    owningDocument: "the artifacts, files, and attachments design",
    wireRegistered: false,
  },
  "artifact-allowlist-and-abort": {
    id: "artifact-allowlist-and-abort",
    wire: "effective allow-list read; ingest abort",
    owningDocument: "the artifacts, files, and attachments design",
    wireRegistered: false,
  },
  "worktree-setup-recipe": {
    id: "worktree-setup-recipe",
    wire: "the worktree setup-recipe carrier",
    owningDocument: "the worktree and execution-root design",
    wireRegistered: false,
  },
  "workflow-event-registration": {
    id: "workflow-event-registration",
    wire: "registration of the twenty-four workflow event types",
    owningDocument: "the event taxonomy and the workflow design",
    wireRegistered: false,
  },
  "workflow-definition-scope": {
    id: "workflow-definition-scope",
    wire: "the workflow-definition project-scope reference meaning",
    owningDocument: "the workflow design",
    wireRegistered: false,
  },
  "timeline-epoch-attestation": {
    id: "timeline-epoch-attestation",
    wire: "the timeline read's epoch and revision-attestation member",
    owningDocument: "the timeline design",
    wireRegistered: false,
  },
  "timeline-path-reference": {
    id: "timeline-path-reference",
    wire: "validated path-reference member on timeline rows",
    owningDocument: "the timeline design",
    wireRegistered: false,
  },
  "approval-method-payloads": {
    id: "approval-method-payloads",
    wire: "registered request and reply payload shapes for the four `approval.*` methods the pane calls",
    owningDocument: "the approvals design",
    wireRegistered: false,
  },
  "approval-remembered-rule": {
    id: "approval-remembered-rule",
    wire: "per-row remembered-rule match on approval rows",
    owningDocument: "the approvals design",
    wireRegistered: false,
  },
  "approval-amendment-arm": {
    id: "approval-amendment-arm",
    wire: "the approval amendment arm",
    owningDocument: "the approvals design",
    wireRegistered: false,
  },
  "session-goal-methods": {
    id: "session-goal-methods",
    wire: "registered request and reply payload shapes for `session.goalUpdate` and `session.goalClear`",
    owningDocument: "the orchestration design",
    wireRegistered: false,
  },
  "session-search": {
    id: "session-search",
    wire: "the session-search query surface",
    owningDocument: "the session core",
    wireRegistered: false,
  },
  "provider-session-import": {
    id: "provider-session-import",
    wire: "provider-session import ingest",
    owningDocument: "a design that does not exist yet",
    wireRegistered: false,
  },
  "attention-plane": {
    id: "attention-plane",
    wire: "the attention projection read and the notification preference pair, with the `AttentionItem` trigger and severity domains they carry",
    owningDocument:
      "the attention design (the three operations) and its build plan (the `packages/contracts/src/attention/` schemas, which no code package carries)",
    wireRegistered: false,
  },
  "workflow-run-control": {
    id: "workflow-run-control",
    wire: "nine of the thirteen workflow method strings — the definition enumeration, the run start and read, the operator cancel and resume pair, the phase-output read, the gate resolve, the human-form submit, and the gate-chain verify — with the run, phase, definition, and output shapes they carry",
    owningDocument:
      "the workflow design (the definition, run, gate, phase-output, and human-form operations, and the operator cancel and resume pair) and its build plan (the shared-contracts and client-SDK registration, which no code package carries)",
    wireRegistered: false,
  },
  "workflow-run-enumeration": {
    id: "workflow-run-enumeration",
    wire: "a read of the workflow runs a session holds, each entry carrying back the channel a chat-borne start named (`channelId`) — provenance `workflowRunStart` takes as an input and no registered read returns, so a channel-scoped surface has no way to ask which of a session's runs belongs to it. Registered nowhere, and not one of the thirteen rows the row above draws on: every registered run operation addresses ONE run by an id the caller must already hold, so a surface that lists runs has no wire to ask and no id to ask it with",
    owningDocument:
      "the workflow design (the run operations, none of which enumerates) and its build plan (the shared-contracts and client-SDK registration an enumeration would join)",
    wireRegistered: false,
  },
  "caller-user-identity": {
    id: "caller-user-identity",
    wire: "the caller's own user identity — which of a session's projected users this window IS",
    owningDocument:
      "the authenticated-principal and authorization model (the resolved principal's outbound disposition, which it does not yet carry); the identity design (the reply shape)",
    wireRegistered: false,
  },
  "callback-tool-registry-read": {
    id: "callback-tool-registry-read",
    wire: "a read of a session's registered callback-tool set, which rides only the spawn and resume parameters and has no read seam",
    owningDocument:
      "the provider driver design (the session callback-tool registry) and its contract (the SessionCallbackTool shape and the client-facing driver namespace a read verb would join)",
    wireRegistered: false,
  },
  "sidekick-definition-registry": {
    id: "sidekick-definition-registry",
    wire: "all five sidekick method strings — the definition list, create, update, and delete, plus the per-session peer-invocation grant — with the saved-definition shape and the five definition-plane refusal codes they carry",
    owningDocument:
      "the sidekick-definitions design and its API and transport changes (the shapes are registered in the payload contracts and the codes in the error contracts, and no code package carries either)",
    wireRegistered: false,
  },
  "hydrated-event-read": {
    id: "hydrated-event-read",
    wire: "the hydrated event read that pairs a verified event row with its opened machine-authored body, and the human-text body no arm of that read opens",
    owningDocument:
      "the assistant-output event family; the machine-authored content column (the HydratedSessionEvent projection over session_events.content_payload, which the daemon builds and no bridge namespace serves; the user half rides session_events.pii_payload under the same design and has no read projection at all)",
    wireRegistered: false,
  },
  "cost-receipt-read": {
    id: "cost-receipt-read",
    wire: "the session cost receipt read and the orchestration budget read — the committed-spend fold and its per-run, per-caused-by, and per-paying-account decomposition",
    owningDocument:
      "the session cost receipt (the decomposition and its two partition identities); the orchestration payload contracts (the two method strings and their reply shapes, registered there and in no code package)",
    wireRegistered: false,
  },
  "workflow-version-chain": {
    id: "workflow-version-chain",
    wire: "a read of the version chain one run's pinned version belongs to, addressed by that opaque version id. Registered nowhere, and the mirror image of the row above it: workflow.versionRead addresses a version by (definitionId, versionNumber) and the definition enumeration carries only each definition's latest, so a surface holding a run's pin holds no way to name any other version of the same definition",
    owningDocument:
      "the workflow design (the definition and version operations, none of which resolves a version id) and its build plan (the shared-contracts and client-SDK registration a chain read would join)",
    wireRegistered: false,
  },
  "health-status-read": {
    id: "health-status-read",
    wire: "the one-shot node health read — the overall status category and the per-component readings, each with its own state and last-checked time, beside the subscription the strip follows",
    owningDocument:
      "the observability design (the health projection); the health method-name registry (the method string and its two schemas, registered there and in no code package)",
    wireRegistered: false,
  },
  "daemon-version-negotiation": {
    id: "daemon-version-negotiation",
    wire: "a bridge read of the negotiated ack the shell holds — the agreed protocol version, the incompatible-handshake reason on a refusal, and the daemon's supported-protocol set on the two refusals that carry one, beside the version this console proposed. `daemon.hello` is registered, but a window may not re-issue it: the daemon latches the first handshake per connection and refuses every later one. What is missing is a READ of the reply the shell already holds, which no bridge or preload namespace carries",
    owningDocument:
      "the daemon supervision lifecycle (step 3, which requires an incompatible handshake be surfaced to the renderer with reads permitted and names no seam that carries it); the envelopes themselves in packages/contracts/src/jsonrpc-negotiation.ts (DaemonHello / DaemonHelloAck and the three incompatible-handshake reasons)",
    wireRegistered: false,
  },
  "timeline-live-resubscribe": {
    id: "timeline-live-resubscribe",
    wire: "a re-subscribe that opens a session's stream AFTER a position the caller states, so a window told about entries it never received replays from the last place it kept rather than re-reading the whole log. The method is registered and its request already carries that position; what is missing is a seam that can send one — the preload bridge's subscribe half names an EVENT and takes no request object, so there is nowhere on it for a position to travel, and the console's only reachable repair is the whole-window re-read",
    owningDocument:
      "the timeline design (the replay-from-a-kept-position reading a degraded ledger renders); the preload bridge contract (the daemon namespace, whose subscribe half carries an event name and no request)",
    wireRegistered: false,
  },
  "workspace-execution-context": {
    id: "workspace-execution-context",
    wire: "a workspace's own execution context — the normalized checkout root a turn-boundary snapshot operates on, and the marker that says a run is executing under a FALLBACK execution mode rather than the mode that was selected. Neither reaches a client: the checkout root is a column on run_execution_contexts and is carried by no reply, and no registered field anywhere carries the fallback marker, so the three roots a branch-mode workspace can hold cannot be shown together and a substituted mode cannot be told apart from a chosen one",
    owningDocument:
      "the execution-mode fallback rule (the selected mode is marked distinctly from normal worktree mode) and the turn-boundary snapshot rule (the normalized checkout root, and the run_execution_contexts.checkout_root column that holds it); the worktree build plan (the shared-contracts and client-SDK registration a read would join)",
    wireRegistered: false,
  },
  "mount-health-identity-verdict": {
    id: "mount-health-identity-verdict",
    wire: "the identity-mismatch verdict a mount's health projection reports — the third member of the mount-health status union. The member is on the contract and no producer can emit it: the daemon-side projection that would derive it is unbuilt, and the repo namespace that would carry a mount read is registered by no handler, so the console's fail-closed three-verdict projection has a live source for none of the three",
    owningDocument:
      "the repo mount-health rules (the three-member union, its precedence, and the read-time derivation); the repo-identity build plan (the daemon-side projection, which consumes its own common-directory re-derivation and persisted anchor write, and the daemon handler namespace and client-SDK surface that would carry the read)",
    wireRegistered: false,
  },
  "channel-lifecycle-verbs": {
    id: "channel-lifecycle-verbs",
    wire: "channel.create / channel.mute / channel.unmute / channel.archive — the four channel lifecycle verbs, with their request and reply shapes and the channel.* refusal codes they raise",
    owningDocument:
      "the channel design (the create-time-immutable ChannelConfig); the orchestration payload contracts (the four method strings and their payload shapes, registered there and in no code package)",
    wireRegistered: false,
  },
  "user-presence-detail": {
    id: "user-presence-detail",
    wire: "user.presenceDetail — the owner/operator-only per-device presence fan-out behind the aggregated summary every role may read",
    owningDocument:
      "the identity design (the aggregated summary is the unauthorized-default projection); the user method-name registry (PresenceDetailReadRequest / PresenceDetailReadResponse, registered there and in no code package)",
    wireRegistered: false,
  },
  "terminal-control-holder": {
    id: "terminal-control-holder",
    wire: "the session's shared-terminal write-lease holder, registered as RuntimeNodeRosterResponse.controlHolder and carried by no shipped schema: RuntimeNodeRosterResponseSchema is strict and declares nodes alone, so the transport that reads the roster today refuses a reply that carries the member at all",
    owningDocument:
      "the shared-terminal rule (one shared terminal per session, one holder at a time); the session terminal-control method registry (controlHolder, and the null it resolves to when the holding node reads offline)",
    wireRegistered: false,
  },
  // The Awareness activity field. Edge-triggered by the owning daemon rather than
  // timed by a receiver, and read through the same daemon presence handler that
  // serves the heartbeat beside it.
  "presence-activity-fields": {
    id: "presence-activity-fields",
    wire: "the Awareness activity field `activity.runs` — a read of the session's live activity state, which run is working in which channel and since when",
    owningDocument:
      "the presence design (the activity field beside the heartbeat); the daemon presence handler surface the field is published through; the preload bridge contract (no presence namespace is on the shipped bridge)",
    wireRegistered: false,
  },
  "notification-permission-read": {
    id: "notification-permission-read",
    wire: "the shell's own reading of whether this machine will display an OS notification for this application. `native.showNotification` is on the preload contract and returns void, so the renderer cannot observe a denial through it, and no bridge member reports the permission",
    owningDocument:
      "the preload bridge contract and the main-process responsibilities (which own OS notification emission and the do-not-disturb honouring, and register no permission read); the attention design's in-app-only fallback (the one the reading selects) and its rule that in-app attention survives a denied permission, which never says how a surface learns of one",
    wireRegistered: false,
  },
  "shell-status-signals": {
    id: "shell-status-signals",
    wire: "the shell's own status as one feed — the daemon supervisor's step and its attempt count out of five, the daemon.hello negotiation ack (compatible, protocolVersion, reason, daemonSupportedProtocols), the loopback-fallback signal, and the keystore-unavailable signal. Every one of them is a main-process fact and none of them is a daemon call: the renderer is not a direct daemon client, the ack belongs to the connection the main process holds, and a second handshake from here would be refused as one already completed",
    owningDocument:
      "the preload bridge contract (no namespace carries any of it); the daemon supervision lifecycle (the six steps and the five-attempt ladder), the loopback fallback and the offline read-only mode, and the native keystore's memory-only degradation; the daemon method surface (the DaemonHelloAck shape, which packages/contracts publishes and no bridge namespace serves)",
    wireRegistered: false,
  },
  "onboarding-desktop-surface": {
    id: "onboarding-desktop-surface",
    wire: "`onboarding.presentChoice` and `onboarding.telemetryPrompt`, the two preload-bridge methods the onboarding desktop surface names — the main-process hosts for the relay choice's secret entry and the telemetry answer",
    owningDocument:
      "the preload bridge contract (which admits `onboarding` by name); the onboarding desktop surface",
    wireRegistered: false,
  },
  "workflow-definition-authoring": {
    id: "workflow-definition-authoring",
    wire: "the three remaining registered workflow method strings — workflow.definitionRead, workflow.versionRead, and the single workflow.definitionCreate all five authoring acts ride — with the definition body they carry: the phase records, the four phase types and four gate types, the entry record, and the reference-only tool bindings. Three of the four rows the run-control row deliberately leaves out; the fourth is the draft save, which is declared with no V1 handler and so has nothing to reach. The write additionally carries a copy-on-write parent pointer no read reply returns, which is this row's own type-member prerequisite",
    owningDocument:
      "the workflow design (the definition read, the version read, and the create; the definition-scope rule, with its copy-on-write consequence and the operator-scope authorization a shared-target create clears; and the definition file form export serializes into and import parses from) and its build plan (the shared-contracts and client-SDK registration, which no code package carries)",
    wireRegistered: false,
  },
  "health-diagnostics-reads": {
    id: "health-diagnostics-reads",
    wire: "the four `health.*` operations that have no row of their own — one run's classified failure detail, one run's stall reading, the operator's recovery request, and the diagnostic redaction policy — with the request and reply shapes each carries. The status projection is `health-status-read` above, which this page's banner consumes beside the session header; the health SUBSCRIPTION is a third row and a third wire, and this page is forbidden to consume one",
    owningDocument:
      "the observability design (the failure-classification, stuck-run, recovery, and redaction-policy surfaces); the observability payload contracts and the health method-name registry (the four method strings and their request/reply shapes, registered there and in no code package — `packages/contracts/src/health/health.ts` is named as their eventual home and does not exist)",
    wireRegistered: false,
  },
  "provider-account-signin-and-token": {
    id: "provider-account-signin-and-token",
    wire: "the brokered sign-in, its cancel, and the registration that carries the one write-only non-interactive token member — the three account-plane verbs the registry read and its live tail do not cover",
    owningDocument:
      "the node provider-readiness and sign-in handoff, and the non-interactive token registration beside it; the credential-custody decision (brokered sign-in and bounded token custody); the provider-account payload contracts (the three method strings, whose request and reply shapes `packages/contracts/src/provider-account.ts` already publishes and which no bridge namespace serves)",
    wireRegistered: false,
  },
  "mcp-governance-plane": {
    id: "mcp-governance-plane",
    wire: "the MCP governance namespace — the unified server inventory read and the enablement and trust mutations, with the binding identity, the redacted configuration read-back, the per-leg live status, the tool overrides, and the per-leg application outcomes they carry. Eight further operations are registered on the same namespace (upsert, remove, the two override verbs, OAuth login, reconnect, the per-binding get, and the live-status subscription) and are the owning plan's to call from the body it mounts",
    owningDocument:
      "the MCP operator surface and its unified inventory; the MCP governance contract surfaces (the eleven method strings and every shape above, registered there and in no code package)",
    wireRegistered: false,
  },
  "node-self-declaration": {
    id: "node-self-declaration",
    wire: "a read delivering this node's own attach declaration — its identity, contract version, self-reported health, and capability set — to the renderer. Registered nowhere: the trust stance puts the declaration's composition in the main process and no bridge namespace carries it, so the attach control mounts against the fixture only",
    owningDocument:
      "the preload bridge contract (the shell namespace a node self-declaration would join, on the shell-config carrier's precedent); the shell's trust stance (which puts the composition in main)",
    wireRegistered: false,
  },
  "workflow-human-form-schema": {
    id: "workflow-human-form-schema",
    wire: "the prompt and the input schema of a phase parked on a person, as two live-scoped members of the run read's phase projection. Registered nowhere: that projection carries the four park members and no form content at all, so a phase waiting on somebody is legible and unanswerable — and the definition body that holds a human phase's prompt and schema is addressed by the definition and a version NUMBER, which a run holding one opaque version id has neither half of, so composing the form from the definition is not merely a second read but an unaddressable one",
    owningDocument:
      "the park surfacing on the workflow read model (the live-scoped phase-state members this pair joins, and the one-response rule a separately-fetched prompt would break) and the human-phase configuration (the prompt and the JSON Schema a human phase asks with); the workflow build plan (the shared-contracts and client-SDK registration these members would join)",
    wireRegistered: false,
  },
  "intervention-history-read": {
    id: "intervention-history-read",
    wire: "a run-scoped read of the durable intervention rows — the `origin` admission-path discriminator, the admitted queue item's row-anchored linkage, and the decrypted directive body, with a body-unavailable answer where the authoring key has been shredded",
    owningDocument:
      "the intervention design's required behaviour and its state and data implications (the durable columns and the resolution rule); its build plan (the read seam, which no method string, event payload, or code package carries)",
    wireRegistered: false,
  },
  "queue-item-run-binding": {
    id: "queue-item-run-binding",
    wire: "the run each queued item is bound to — `queue_items.target_run_id`, which the registered `QueueItemSummary` carries no member for and its `.strict()` parse rejects",
    owningDocument:
      "the run-bound delivery redesign; the intervention payload contracts (the summary shape that omits it)",
    wireRegistered: false,
  },
};

/**
 * The rows, in the plan table's order. Order is load-bearing only for diff
 * legibility; every lookup keys on ids.
 */
export const GROWTH_SLATE_ROWS: readonly GrowthSlateRow[] = Object.values(GROWTH_SLATE_ROWS_BY_ID);

/**
 * Row lookup.
 *
 * Total, and it did not used to be: the linear search this replaced threw a
 * `RangeError` on an id with no row, which is the right behaviour for a set the
 * compiler cannot close and the wrong shape for one it can. The record above is
 * exhaustive over `GrowthSlateRowId`, so a typo is now a compile error at the call
 * site and there is no runtime arm left to take.
 */
export function growthSlateRow(id: GrowthSlateRowId): GrowthSlateRow {
  return GROWTH_SLATE_ROWS_BY_ID[id];
}
