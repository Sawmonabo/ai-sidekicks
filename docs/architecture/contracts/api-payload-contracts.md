# API Payload Contracts

Typed payload definitions for all named interfaces across all specs. Each contract specifies request shape, response shape, and error shapes using TypeScript/Zod notation.

**Usage:** Implementation agents translate these definitions into Zod schemas in `packages/contracts/src/` when the shape crosses a boundary between independently built surfaces — the daemon, the desktop app, the CLI, the control plane, the relay, and the phone and web clients — or is a wire enum or schema. A shape this file marks daemon-internal or in-process lives in `packages/runtime-daemon`, and one only the control plane uses lives in the control plane's package; this file documents them beside the wire so a reader sees the whole seam. The organization by plan follows the build order recorded in [cross-plan-dependencies.md](../cross-plan-dependencies.md).

**Schema reference:** Column types and constraints are in [Local SQLite Schema](../schemas/local-sqlite-schema.md) and [Shared Postgres Schema](../schemas/shared-postgres-schema.md).

---

## Authenticated Principal And Authorization Model

Every control-plane endpoint defined in this document is implicitly scoped to the authenticated caller. Authorization rules — including every Cedar policy evaluation — treat the following as controlling inputs:

- **Principal identity.** The Cedar `principal` is the `sub` claim of the caller's PASETO v4.public access token (a `UserId`). This is the only identity Cedar evaluates. See [RFC 9068 §2.2 — `sub` claim](https://datatracker.ietf.org/doc/html/rfc9068#section-2.2) for the `sub`-as-principal pattern and [ADR-010 Tokens, Passkeys And The Remote Channel](../../decisions/010-tokens-passkeys-and-the-remote-channel.md) for the V1 PASETO profile.
- **Proof-of-possession binding.** Each access token carries a DPoP-style confirmation claim (`cnf.jkt`, per [RFC 9449 §3.1 — Public Key Confirmation via Thumbprint](https://datatracker.ietf.org/doc/html/rfc9449#section-3.1)) whose value is the SHA-256 thumbprint of the caller's bound JWK. A token is valid only when accompanied by a DPoP proof signed by the matching private key. The bound access token is presented as `Authorization: DPoP <token>` per [RFC 9449 §7.1](https://www.rfc-editor.org/rfc/rfc9449#section-7.1) — never `Bearer`, which a conforming resource server rejects for a DPoP-bound token — and the accompanying proof carries the token's `ath` hash per [RFC 9449 §4.3](https://www.rfc-editor.org/rfc/rfc9449#section-4.3); see [security-architecture.md §DPoP sender-constraining](../security-architecture.md#control-plane-authentication) for the canonical statement. `cnf.jkt` is a replay-protection binding — **not** a second principal identity; Cedar never reads it as a `principal` input.
- **No person in a request body.** A request carries no body field naming a person, and Cedar reads none: the control plane's caller is the verified `sub`, and on the machine a write records the device its connection came from.
- **Run control.** Interventions, the orchestration-layer `run.pause` / `run.resume` verbs and a person's `driver.compactContext` are accepted from any connection the transport admits: the desktop app or the CLI on the daemon's local socket ([security-architecture.md §Local Daemon Authentication](../security-architecture.md#local-daemon-authentication)), or a linked device inside its encrypted channel to the machine, from a device key the account's statement chain trusts. Nothing checks session ownership or run authorship. The event records the connection's device, which the channel's handshake proves ([security-architecture.md §Relay Authentication And Encryption](../security-architecture.md#relay-authentication-and-encryption)). Contract text: [Spec-003 §Interfaces And Contracts](../../specs/003-queue-steer-pause-resume.md#interfaces-and-contracts); rule owner: [Spec-010 §Required Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#required-behavior).
- **Local-daemon endpoints.** Endpoints reachable only over the daemon's local IPC socket (JSON-RPC 2.0 per [ADR-009 JSON-RPC IPC Wire Format](../../decisions/009-json-rpc-ipc-wire-format.md)) are authorized by socket reachability plus a required 256-bit session token presented by the desktop app or the CLI client (see [security-architecture.md §Local Daemon Authentication](../security-architecture.md#local-daemon-authentication)); they do not require a PASETO access token. The renderer is not a direct daemon client — renderer-originated requests are brokered by the main process through the preload bridge. The gateway stamps the connection's device on the dispatch context every handler receives; no handler checks who the caller is.
- **A write records its device.** A write whose acceptance admits later work — a queued message, a steer, an approval rule, a pending provider switch — records on its own row the device whose connection carried it, never a person, so the record outlives the request. An approval's resolution records the answering device's id, which a card answered elsewhere reads as `Answered on <device>` ([Spec-027 §Required Behavior](../../specs/027-remote-control.md#required-behavior)). Spend is counted per session, run and provider account, never per person.

**See also:** [Security Architecture §Permission Matrix](../security-architecture.md#permission-matrix), [ADR-010 Tokens, Passkeys And The Remote Channel](../../decisions/010-tokens-passkeys-and-the-remote-channel.md), [Cedar terminology — principal, action, resource, context](https://docs.cedarpolicy.com/overview/terminology.html).

---

## Source-of-Truth Policy

This file is the **design surface** for cross-cutting payload contracts — brand types, procedure-type assignments, method-name formats, error envelopes, and other shapes that span multiple plans and are declared here before any package implements them. Cross-package consumers reading this file see a single canonical declaration of how the wire surface is shaped.

Package-local typed surfaces are **canonical in code**, not in this file. Examples (non-exhaustive):

- `MethodRegistry` interface — `packages/contracts/src/jsonrpc-registry.ts`
- `LocalSubscriptionProducer<T>` streaming primitive — `packages/contracts/src/jsonrpc-streaming.ts` (the client-side consumer shape is `LocalSubscriptionConsumer<T>` at `packages/client-sdk/src/transport/types.ts`)
- `SecureDefaults` config + effective-settings — `packages/runtime-daemon/src/bootstrap/secure-defaults.ts`
- LSP-style streaming method-name taxonomy (`$/subscription/notify`, `$/subscription/cancel`) — `packages/contracts/src/jsonrpc-streaming.ts`
- `SessionEvent` discriminated-union schema — `packages/contracts/src/event.ts`
- The daemon's method and event map — the `DaemonMethod` union, the method-to-params and method-to-result maps (`DaemonParams`, `DaemonResult`) and the `DaemonEvent` union with its event-to-payload map (`DaemonEventPayload`), built from the contracts' own method descriptors — `packages/contracts/src/daemon-methods.ts`. The preload bridge's `daemon.call` and `daemon.subscribe` are typed by it, and the renderer's daemon client takes its types from it rather than restating them.

This file does **NOT** maintain doc-side mirrors of those types. A consumer searching for the canonical runtime type reads the code path directly; this file's role for those surfaces is to cite the code location and explain cross-cutting consistency, not to redefine them. The Zod schema in code is the source of truth, and divergence between this file's prose and the Zod schema is resolved in favor of the schema.

Cross-cutting shapes (procedure-type tables, method-name regexes, brand-type catalogs) are declared in this file; package-local interface shapes are not.

**Three spellings for a member that may have no value, one per situation.** A state row that reports a fact spells it required and nullable (`spendLimitUsdMicros: number | null`): the member is always present, and `null` is the fact that no limit is set, never a member the writer forgot. A patch that can clear a value spells it optional and nullable (`spendLimitUsdMicros?: number | null`): an omitted member leaves the stored value as it stands, and an explicit `null` clears it, the merge-patch reading (RFC 7386). A create-time request that is never patched spells it plain optional (`tokenLimit?: number`): omitted means the default, and there is no stored value to clear. Every schema mirrors the spelling of the shape it validates, and a reader that cannot tell "absent" from "cleared" is a defect in the schema, not a case to handle in the caller.

---

## Branded ID Types

All domain IDs use branded string types for compile-time safety.

```ts
type SessionId = string & { readonly __brand: "SessionId" };
type UserId = string & { readonly __brand: "UserId" };
type NodeId = string & { readonly __brand: "NodeId" };
type RunId = string & { readonly __brand: "RunId" };
type QueueItemId = string & { readonly __brand: "QueueItemId" };
type InterventionId = string & { readonly __brand: "InterventionId" };
type ArtifactId = string & { readonly __brand: "ArtifactId" }; // encoding: an RFC 9562 UUID the daemon mints at manifest creation, distinct from the payload's SHA-256 digest — Spec-012 §Required Behavior; this block registers brands, never encodings
type WorkspaceId = string & { readonly __brand: "WorkspaceId" };
type WorktreeId = string & { readonly __brand: "WorktreeId" }; // BranchContextId: §Plan-007
type RepoMountId = string & { readonly __brand: "RepoMountId" };
type ApprovalRequestId = string & { readonly __brand: "ApprovalRequestId" };
type WorkflowDefinitionId = string & { readonly __brand: "WorkflowDefinitionId" };
type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };
type EventCursor = string & { readonly __brand: "EventCursor" };
```

---

## Cross-Cutting: Error Contract

All API responses use this error envelope on failure.

```ts
// Canonical error response
interface ErrorResponse {
  code: string; // namespaced: 'session.not_found', 'auth.token_expired', etc.
  message: string; // human-readable description
  details?: Record<string, unknown>; // structured context
}

// Error code namespaces
type ErrorNamespace =
  | "session" // session lifecycle errors
  | "auth" // authentication/authorization
  | "run" // run state machine violations
  | "approval" // approval flow errors
  | "workspace" // workspace lifecycle errors; sibling "repo" mount-lifecycle namespace per the canonical registry
  | "artifact" // artifact publication errors
  | "workflow" // workflow execution errors
  | "driver" // provider driver errors
  | "relay" // relay/transport errors
  | "system"; // internal system errors
// Illustrative V1 subset; `error-contracts.md` is the canonical namespace registry.

// Rate limiting response (Spec-019; canonical shape per Plan-018 I-018-4 —
// identical in error-contracts.md §Rate Limiting and packages/contracts/src/rate-limiter.ts)
interface RateLimitResponse {
  code: "rate_limited";
  retryAfter: number; // seconds until retry is allowed
  limit: number; // total allowed requests in the window
  remaining: number; // requests remaining in the current window
  resetAt: string; // ISO 8601 timestamp when the limit resets
}
```

---

## Shared Enums

```ts
type SessionState = "provisioning" | "active" | "archived" | "closed" | "purge_requested";
type PresenceState = "online" | "idle" | "reconnecting" | "offline"; // per-device liveness

type RunState =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "pausing"
  | "paused"
  | "completed"
  | "interrupted"
  | "failed";
// A state the run does not leave on its own. A send into an `interrupted` run returns it to `running`
// with everything it knew ([Run State Machine §Definitions](../../domain/run-state-machine.md#definitions)).
type TerminalRunState = "completed" | "interrupted" | "failed";
type BlockingRunState = "waiting_for_approval" | "waiting_for_input" | "paused";
type RunFailureCategory =
  | "provider failure"
  | "transport failure"
  | "local persistence failure"
  | "projection failure"
  | "refused"; // the provider's safety check refused a turn and no other model could take it (Spec-005 §Run Lifecycle)

type QueueItemState = "queued" | "admitted" | "superseded" | "canceled" | "not_delivered";
type InterventionType = "steer" | "interrupt" | "cancel" | "faster_model_retry"; // Spec-003 §Required Behavior and Spec-004 §Required Behavior; ApplyInterventionParams (Plan-003 T1.8) carries the first three, and the daemon carries out `faster_model_retry` itself. Undo is `session.restore`, never an intervention
type InterventionState = "requested" | "accepted" | "applied" | "rejected" | "degraded" | "expired";

type ApprovalCategory =
  | "tool_execution"
  | "file_write"
  | "network_access"
  | "destructive_git"
  | "plan_approval"
  | "gate"
  | "human_step_contribution";
type ApprovalDecision = "approved" | "rejected";
type ApprovalState = "pending" | "approved" | "rejected" | "canceled";

// The five permission levels, most careful to least, in the one vocabulary every surface that names a
// level uses ([Spec-010 §Required Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#required-behavior)).
// Only the first three ever raise an approval; at `sandboxed` and `yolo` the daemon answers every ask
// itself under the level's own posture. Plan is deliberately NOT a member: planning is a session's own
// mode, not a permission level, and the level still governs what a plan may read. A provider's own mode
// name never appears here — each level is one of that provider's own modes underneath, and the realized
// sandbox-and-network composition is `ExecutionPosture` below.
type ExecutionPostureMode = "readonly" | "ask" | "reviewed" | "sandboxed" | "yolo";

// Where a session's work runs. `bound-root` works in the root already bound to the workspace — the
// project's own checkout, or a chat's managed workspace — and makes nothing; `provisioned-worktree`
// works in a worktree the daemon's worktree lifecycle made or reused (reuse accepts only a worktree this
// daemon created).
type ExecutionMode = "bound-root" | "provisioned-worktree";
// `preparing` covers both modes while the root is made ready (`repo.executionRootPrepare`); it is a
// different fact from the session state `provisioning` and never appears on screen.
type WorkspaceState = "preparing" | "ready" | "stale" | "archived";
type WorktreeState = "creating" | "ready" | "dirty" | "merged" | "retired" | "failed";
type RepoMountState = "attached" | "detached" | "archived"; // VcsType + RepoMountHealth: §Plan-006

type ArtifactState = "pending" | "published" | "superseded";
type DriverCapabilityFlag =
  | "resume"
  | "steer"
  | "interactive_requests"
  | "mcp"
  | "tool_calls"
  | "reasoning_stream"
  | "model_mutation"
  | "structured_output" // schema-constrained final output (Spec-004 §Per-Driver Capability Matrix)
  | "rollback" // cuts the bound conversation back to an earlier message in place, the driver's conversation cut (Spec-004 §Per-Driver Capability Matrix)
  | "session_fork" // forks the bound conversation via forkConversation into a new provider conversation carrying history up to and including a message, the source left untouched; registered together with its caller session.fork, and never an undo (Spec-004 §Per-Driver Capability Matrix)
  | "session_goals" // setSessionGoal / clearSessionGoal
  | "callback_tools" // daemon-curated callback-tool registry
  | "subagents" // provider-native in-session subagents under subagentPolicy
  | "context_compaction" // compacts the bound session's own provider-side context on user request via compactContext (Spec-004 §User-triggered context compaction)
  | "provider_commands" // enumerates the provider's native slash-commands and skills via listProviderCommands — a LIVE read, never a stored registry (Spec-004 §The provider command and skill surface)
  | "output_speed"; // declares a user-settable provider-side output-speed mode; BOTH pinned drivers declare it, and detectionSource is STATIC on both because reading the declared state is not zero-turn (Spec-004 §The output-speed axis). Claude realizes the axis through its own fast-output setting; Codex realizes it through the participant-settable per-turn `serviceTier` override on `turn/start` — present in the default, non-field-gated generation — against the speed tiers its model catalog publishes (`Model.serviceTiers`, `defaultServiceTier`, each tier `{ id, name, description }`, with a `Fast` tier carried in upstream source), behind the provider's own `features.fast_mode` gate and surfaced to the person as the composer's `Fast` / `Standard` control and the `/fast` word
// The executable union
// (packages/contracts/src/provider-driver.ts) must export every member above, so no member is
// declarable in doc only. The shipped assertValidCapabilityFlags rejects
// any snapshot whose key count differs, so the union, the validator, the
// driver_capabilities.capability_flag CHECK in the one local schema and the conformance tests
// change together as ONE change or not at all.
```

---

## The Session Screen's Reads, By Region

An index, not a second contract: each region of the session screen, what it needs, and the operations that answer it, named as the session screen's design names them. It exists because the screen's regions cut across every plan section below, and a builder reading one section cannot see that one region is served by several of them. The operations not built yet, with their members and owners, are listed in [§Operations Not Yet Built](#operations-not-yet-built); this table only names them.

| Region | What it needs | What answers it |
| --- | --- | --- |
| The sessions list and the palette | Every session grouped by shape, each with its name or first message, its state, its pin and mute marks and the exchange line while it trades messages; the project headers; a session's seen dot; a search across every session; the acts on a row | `session.list`, served live; `repo.projectList`, served live, for the project headers; `attention.seenUpdate` for the seen dot; `session.search`; `session.create`, `session.rename`, `session.pin`, `session.unpin`, `session.mute`, `session.unmute`, `session.archive`, `session.reactivate`, `session.close`, `session.convert` and `session.fork` for the acts |
| Session | Its id, name, shape, state, mute and goal; its project, worktree and base; the pending worktree move; its elapsed time and its ahead count; the unsent draft and the staged files; the spend rows by account; the snapshot count | `session.read` for the session's own facts — its shape, its mute, the pending move, the draft and the staged files among them — and `session.subscribe` for every change after it; `session.setWorkingFolder` to move it; `session.restart` for a provider process that ended; `repo.mountRead` and `repo.worktreeStatusRead` for the project, the worktree, the base and the ahead count; `orchestration.costReceiptRead`'s per-account axis for the spend rows; `session.snapshotList` for the snapshot count |
| The composer | The draft and its staged files, pictures, marks and resources; the `/` list; the `@` file search; the model, effort, speed, level, mode, goal and auto-compact controls and the context figure; the tool-servers list with its switches; the side question, `/review` and `/reload` | `session.draftUpdate`, `session.attachmentAdd` and `session.attachmentRemove`, with `preview.marksSend` for the marks chip; `session.providerCommandsSubscribe` for the `/` list; `session.fileSearch`; `session.mcpResourceList` for a server's resources; `session.mcpServerList` and `session.mcpServerUpdate` for the tool-servers list; `agent.configUpdate` for the model, effort, speed or provider, never the account, which is `providerAccount.setCurrent`; `session.permissionLevelUpdate`, `session.modeUpdate`, `session.goalUpdate`, `session.goalClear`, `session.autoCompactUpdate` and `session.contextSubscribe`; `session.sideQuestionAsk`, `session.reviewStart` and `session.definitionsReload`; `driver.listModes`, `driver.listModels`, `driver.listCapabilities` and `driver.compactContext` for what the provider offers and its compaction |
| The inspector | The session's memory, hooks, the rules in force, its artifacts, its cost and budget, and its snapshots | `session.memoryRead` and `session.autoMemoryUpdate`; `session.hookList`; `approval.ruleList` and `approval.ruleRevoke`; `artifact.list` and `artifact.read`; `orchestration.costReceiptRead` and `orchestration.budgetRead`; `session.maxStepsUpdate`, `session.spendLimitUpdate` and `session.tokensPerRunUpdate`; `session.snapshotList` |
| Undo | The dry run's files, lines and skipped files, the commands still running and the agents that would stop; the undo itself, in one of its three ways or to a named snapshot | `session.restorePreview`, then `session.restore` |
| Turns | The person's turns, the agent's prose, its reasoning, and the state-changing rows the console itself appends; a row's large body; a patch a call did not carry; the find box over history not yet loaded; code colors | `timeline.read`, and live rows on `session.subscribe`; `timeline.reasoningSurfaceRead`; `timeline.bodyRead`; `timeline.patchRead`; `timeline.search`; `highlight.read` |
| Tool runs | The verb, its target, its duration or live elapsed, a result summary, diff hunks, a failure mark, a held mark; a block by the provider's own reviewer, with its reason line and whether it can be allowed once | The same timeline rows, with the `approval.reviewer_denied` and `approval.denial_overridden` records on the blocked call's row; `command.list` for the ones still running |
| Child agents | Each child's id and parent, its model and, where it was a peer call, the agent that was asked (`via`), its state, activity, tools, tokens, spend and timer, its own rows and its stream; a child's steer, interrupt and pause, and the stop of a whole subtree | `orchestration.childRunLinkRead` and `agent.list` for the tree and its facts; `timeline.childRunExpand` for a child's rows; `run.subscribeState` for state; `run.childSteer`, `run.childInterrupt`, `run.childPauseSet` and `run.childrenStop` for the controls. The daemon's own paths call `orchestration.runCreate`; no region does |
| The pending messages and the run's controls | The messages waiting for the agent, their order and their edits, the lead's and each child's; the interrupt, the pause and its continue; the answer to a restart's mismatch | `run.subscribeQueue` and `run.queueList`; `run.queueCreate`, with `replacesQueueItemId` for an edit; `run.queueCancel` and `run.queueReorder`, each taking a child as well; `run.intervene` for the interrupt; `run.pause` and `run.resume`; `run.recoveryResolve` |
| Approvals, plans and questions | One pending request with its title, its summary, the child that raised it, and its answers; `Allow once` on an action the provider's own reviewer blocked at `Reviewed`; the plan card and its verdict; the question card and its answers | `approval.projectionRead`, answered by `approval.resolve`; `approval.denialOverride` for `Allow once`; `plan.resolve`; `question.resolve`. The daemon raises an approval request itself from a provider's callback, so no region calls `approval.requestCreate` |
| Worktrees | The per-project list with ahead, behind, dirtiness and occupancy; the root branch and the branches to cut from; the progress of the setup steps; removing a worktree, and the removed ones kept to put back | `repo.worktreeStatusRead`, whose worktree rows carry the candidate facts; `repo.branchList`; `repo.executionRootPrepare`, with `carryUncommitted`; `repo.worktreeSetupSubscribe` and `repo.worktreeSetupRetry`; `repo.worktreeRetire`; `repo.removedWorktreeList`, `repo.worktreeRestore` and `repo.removedWorktreeDelete` |
| Projects | Attaching a folder, from this machine or from another device; a converted chat's place in its project; cloning from an address, its progress, its questions and its large files | `repo.attach`; `repo.folderList` for another device's folder list; `repo.workspaceBind`; `repo.mountRead`; `repo.cloneFolderRead`, `repo.clone`, `repo.cloneSubscribe`, `repo.cloneAnswer`, `repo.cloneCancel` and `repo.largeFilesPull` |
| Review | The scope tabs, the base list, the files with their hunks, a file outside the diff, the commits, the pull-request form and state, its checks, logs and threads, the held notes, and staleness; the ship acts and their commands | `gitflow.branchContextRead` for the branch, the base list, the commits and what the pull-request form opens with; `gitflow.diffRead` for the diff; `repo.fileRead` for a file or a folded gap; `gitflow.gitActionPreview`, `gitflow.gitActionExecute` and `gitflow.gitActionSubscribe` for the ship acts; `gitflow.commitMessageGenerate` and `gitflow.changeRequestTextGenerate`; `gitflow.changeRequestSubscribe` for the request, its checks and its threads; `gitflow.reviewerList` and `gitflow.labelList`; `gitflow.reviewSubmit`, `gitflow.threadResolve` and `gitflow.threadReply`; `gitflow.checkLogRead`; `session.reviewNoteAdd`, `session.reviewNoteUpdate`, `session.reviewNoteRemove` and `session.reviewNoteList` for the held notes; `repo.workingTreeSubscribe` for the tree-staleness signal behind the reload |
| Terminal | The session's shells and their order; per-shell output; each shell's control lease | `pty.list`, served live; `pty.open`, `pty.close` and `pty.reorder`; `pty.outputSubscribe` for each shell's bytes; `pty.write` and `pty.resize` from the device holding the shell; `session.setTerminalFlowControl` for each watching connection's behind state; `session.takeControl` with the `pty.control_changed` broadcast, all keyed per shell. A device reads its own id from the connection handshake's reply, so it tells its own hold from another device's and from an agent run's |
| Commands | The running commands in the order they started — the command as the agent ran it, when it started, and the transcript row each belongs to; its output as it prints; its ending with a result and a duration; stopping it, moving it to the background, typing into it | `command.list`, served live, carrying the `command.output` frames, and the stored `command.ended` record; `command.stop`, `command.background` and `command.write` |
| Preview | The open pages with each one's address, title, icon, load state, zoom and whether its history has somewhere to go; the discovered dev servers; the machine the page runs on; the live picture on another device; the staged marks | `preview.pageList`, served live; `preview.pageOpen`, `preview.pageClose`, `preview.pageActivate`, `preview.pageReorder`, `preview.navigate` and `preview.zoom`; `preview.devServerList`, served live; `preview.screencastSubscribe` on another device; the staged marks live in the composer store until `preview.marksSend` sends them. The browser's saved-site verbs and the page host's own traffic are in [§Page-Host Method Registry](#page-host-method-registry) |
| Cloud tasks | The session's tasks sent to a provider's cloud, each one's last reported state and attempts, a ready attempt's diff, and bringing one back | `cloud.taskStart`; `cloud.taskList`, served live; `cloud.taskRead`; `cloud.taskDiffRead`; `cloud.taskApply`; the event `cloud.task_updated` |
| Voice | Dictation into the draft; a spoken call with the agent; the voices offered; which session voice is on in | `voice.dictationStart`, `voice.dictationWrite`, `voice.dictationStop` and `voice.dictationSubscribe`; `voice.callStart`, `voice.callStop` and `voice.callSubscribe`; `voice.voiceList`; `voice.stateUpdate` and `voice.stateSubscribe` |
| The working line | What the agent is doing, or Codex's own sentence while it holds a turn for a safety check; the elapsed clock, the tokens received this turn, the turn's state word, its task list, the warnings count and its list, and the connection state | `run.subscribeState` for the state and the activity, and for Codex's sentence (`run.safety_buffering_updated`); `turn.usage` for the tokens; `turn.tasks` for the list; the `session.notice` records of kind `provider_warning` for the warnings; the `daemon.status` topic on `daemon.subscribe` for the connection state |
| The bell and the notifications list | The count of what is waiting, one line per moment, and the moment a banner speaks for | `attention.projectionRead`, served live: the whole projection, then every change. Main settles each banner it posts with `attention.bannerSettle`; no region calls it |
| The service | Whether the background service answers, its liveness, and the flush before a quit | `daemon.status.read`; `daemon.ping`, main's liveness check; `daemon.flush` before a quit, which never stops the service; the boot card's `Retry` is the bridge's `daemon.requestStart()` |
| The preload bridge | How the renderer reaches the daemon, the machine and its own windows | `daemon.call` and `daemon.subscribe`; `native.copyToClipboard`, `native.revealInFileExplorer`, `native.showOpenDialog`, `native.getDroppedFileRef`, `native.savePastedImage`, `native.showSaveDialog`, `native.openExternal`, `native.openInEditor` and `native.openInTerminal`, each file operation taking or returning a `FilePathRef` token that main's relay turns into a path; `window.setAppearance`, `window.subscribeAppearance`, `window.subscribeFullscreen`, `window.setMinimumSize` and `window.subscribeToNavigationRequest` |

---

## Operations Not Yet Built

Every desktop ↔ backend operation below has its name, its owning spec and its owning plan, and none has a handler yet. A method's request and response schemas land in `packages/contracts` with the unit that builds it, and its row leaves this table when its handler ships. Where a section above already documents a method's payload, that section is the payload's home; this table is only the list of what is still to build. The members are the ones the design states; a method carried on the relay reaches the daemon the same way as one sent from the desktop app.

### `account.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `account.delete` | `sidekicks delete-account`: every refresh-token family revoked, then the hosted account's rows deleted in one transaction | [Spec-020](../../specs/020-data-retention-and-gdpr.md) | [Plan-015](../../plans/015-identity-and-user-state.md) Phase 5 T5.5 |
| `account.export` | The hosted account's own records, for `Export all data`'s `hosted-account.json` | [Spec-020](../../specs/020-data-retention-and-gdpr.md) | [Plan-015](../../plans/015-identity-and-user-state.md) Phase 5 T5.5 |

### `agent.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `agent.configUpdate`, settling with `agent.provider_binding_changed` or `agent.provider_binding_change_failed` | Switch a running agent's binding: model, effort or speed settles in place; a pick under the other provider switches provider at the run's end | [Spec-014 §Same-Agent Provider Switch](../../specs/014-multi-agent-orchestration.md#same-agent-provider-switch) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.1, T3.8, T2.9, T1.4 |
| `agent.definitionCreate` | Save a new definition (`New sidekick`, `Duplicate`) with `bindings`, `icon`, `accentHue`, `turnCap` | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T2.2 |
| `agent.definitionDelete` | Delete a definition; discard an orphaned record | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T2.2 |
| `agent.definitionExport`, writing into the folder the dialog picked | Export one or many definitions, one Markdown file per definition, the account left out | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) Phase 2 T2.2 |
| `agent.definitionImport`, reading the folder the dialog picked | Import the folder's definition files: creates only, never overwrites, suffixes a colliding name, skips and lists every file that is not a definition | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) Phase 2 T2.2 |
| `agent.definitionList`, with reply members `workflowUsage` and **`lastUsedAt`** | Read the agent registry: every definition from every origin, the plugin origin read-only, `plugin · <name>`, from the daemon's plugin homes, each with `origin`, `scope`, `sourcePath`, `orphaned`, `disabledInProvider` (the provider has it switched off) and `loadError` (it failed to load, with the reason), each its own field and not one exclusive state, plus the agent's own `hooks` and `memoryScope` on every origin, `workflowUsage` and `lastUsedAt` (both derived per reply). A definition whose file names a provider this app doesn't run is listed, carrying that name apart from the binding's `ProviderName`; its provider chip reads `<name> · not supported here`. The agent card draws the orphaned state: set apart, the extras the record still holds, the last known path, `Reattach` and `Discard`. One read serves the library, the composer's Sidekicks group, the workflow node's chooser and the pane's name/icon/color labels. | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T2.2 |
| `agent.definitionUpdate` | Save edits: rename, replace `bindings` whole, every core field; also reattach an orphaned record to a file | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T2.2 |
| `agent.list` (a live list: the list, then each change, like `session.list`) | The session's agents, the lead and every child: binding, state, resolved-from definition, which provider runs it | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.1, T3.2 |
| `agent.definitionSubscribe` | Follow the agent registry: the whole `agent.definitionList` reply again each time a definition changes (a save, delete or import from any window; a provider's file added, changed or removed on disk; a plugin landing or leaving), so every open window's library, composer group and workflow chooser stay current | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) Phase 2 T2.2 |

### `approval.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `approval.projectionRead` | The pending asks for the approval card | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.2, T3.3 |
| `approval.resolve` | Answer an ask | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.1, T2.3 |
| `approval.ruleList` | The rules in force on the session | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.5 |
| `approval.ruleRevoke` | Revoke a rule | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.5, T3.4 |
| `approval.denialOverride {sessionId, denialId}`, recording `approval.denial_overridden`; the block itself is recorded as `approval.reviewer_denied {sessionId, runId, agentId, denialId, eventId, reason, overridable}` | `Allow once` on an action the provider's own reviewer blocked at `Reviewed`: the agent is told it may try that one action again, the row then reads `Allowed once` on every screen, and a press on a block already allowed is answered with the settled row | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.13; the provider leg in [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.34 |

### `artifact.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `artifact.list` | The session's artifacts | [Spec-012](../../specs/012-artifacts-files-and-attachments.md) | [Plan-011](../../plans/011-artifacts-files-and-attachments.md) T14.12 |
| `artifact.read` | One artifact's content | [Spec-012](../../specs/012-artifacts-files-and-attachments.md) | [Plan-011](../../plans/011-artifacts-files-and-attachments.md) T14.1, T14.7 |

### `attention.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `attention.deliveryRead {}` → `{webAddress: {saved, host, lastOutcome}, emailDigest: {passwordSaved, lastOutcome}}`, `lastOutcome` being `{at, result: delivered \| refused \| unreachable \| timedOut \| signInRefused \| notEncrypted, httpStatus?, undelivered}` or `null`; `attention.deliveryTest {channel: webAddress \| emailDigest}` → `{outcome}`; refusals `attention.delivery_store_unavailable` (`cause: locked \| unavailable`) and `attention.delivery_not_configured` (`missing: address \| password`) | What each delivery channel last did, and a test send for each | [Spec-017](../../specs/017-notifications-and-attention-model.md) | [Plan-016](../../plans/016-notifications-and-attention-model.md) T1.3, T3.3 |
| `attention.mailPasswordSave {password}` → `{}` and `attention.mailPasswordRemove {}` → `{}`; the digest's settings (`sendTo`, `mailServer?`, `port?`, `userName?`, `after: hour \| fourHours \| day`, default `day`) are keys in the machine settings file, which the service writes; `digested_at` on each attention entry | The email digest: `Email me what I have not seen`, at most one email per `After` period through the person's own mail account, its password kept as its own item in the operating system's credential store | [Spec-017 §Cross-Device Delivery](../../specs/017-notifications-and-attention-model.md#cross-device-delivery) | [Plan-016](../../plans/016-notifications-and-attention-model.md) T1.3, T3.5 |
| `attention.projectionRead`, served live: the whole projection, then every change; `attention.bannerSettle {entryId, state}`, main-only, a no-op once the entry is past `pending` | The bell's count and its list, one stable id per moment; main mirrors the count to the app icon and posts and withdraws the OS notification from the same projection, and while no main is connected the daemon's attention service starts the app windowless to post it | [Spec-017](../../specs/017-notifications-and-attention-model.md) | [Plan-016](../../plans/016-notifications-and-attention-model.md) T2.4, T1.2 |
| one entry on `attention.projectionRead` with trigger `workflow_notify`, its `momentId` from the run, node and execution index and its `stepId`, posted by main | The Notify node posts a notification | [Spec-017](../../specs/017-notifications-and-attention-model.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.18 |
| `attention.seenUpdate` {sessionId} | Mark a session seen (its done dot filled or hollow) | [Spec-017](../../specs/017-notifications-and-attention-model.md) | [Plan-016](../../plans/016-notifications-and-attention-model.md) T1.3, T2.4 |
| `attention.webAddressSave {address}` → `{host?, signingSecret?}`, `attention.webAddressSecretRotate {}` → `{signingSecret}`, `attention.webAddressRemove {}` → `{}`; the channel's switch and kinds are keys in the machine settings file, which the service writes; `web_address_state` (`pending \| delivered \| undelivered`) and an attempt count on each attention entry | The web address: `Send to a web address`, one signed message per moment of the kinds picked for it, the address and its signing secret each kept as its own item in the operating system's credential store | [Spec-017 §Cross-Device Delivery](../../specs/017-notifications-and-attention-model.md#cross-device-delivery) | [Plan-016](../../plans/016-notifications-and-attention-model.md) T1.3, T3.4 |

### `browser.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `browser.chromiumFetch` | `Fetch it again` | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `browser.chromiumRead` | Which Chromium is in use, its version, when fetched | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `browser.chromiumRead` answers `cannotStart {reason: missingSystemLibraries, installStep}`, `installStep` being Playwright's own `sudo npx playwright@<version> install-deps chromium` for the version the service carries | The daemon's headless Chromium cannot start for missing Linux system libraries | [ADR-034](../../decisions/034-embedded-browser-for-preview.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `browser.siteCookiesClear {origin}` | `Clear cookies` for one site | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `browser.siteDataClear` | Clear all site data | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `browser.siteDataForget` | Forget one site | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `browser.siteDataList` → rows with `hasCookies` | Sites with saved data, each saying whether it holds an unexpired cookie | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `browser.siteSignIn {origin}` | Sign a site in | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |

### `callbackTool.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `callbackTool.list` | Allowlist catalog, source 1: the daemon's callback tools, each with the label a person reads | [Spec-004 §Required Behavior](../../specs/004-provider-driver-contract-and-capabilities.md#required-behavior), [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) Phase 3 T3.4 |

### `cloud.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| event `cloud.task_updated` | A task's reported state changed | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `cloud.taskApply {taskId, attempt?}` | Bring a task back | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `cloud.taskDiffRead {taskId, attempt?}` | A ready Codex attempt's diff | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `cloud.taskList {sessionId}` (live) | The session's cloud tasks | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `cloud.taskRead {taskId}` | One task's last reported state and attempts | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `cloud.taskStart {sessionId, prompt, environment?, attempts?}` → `{taskId}` | Send a message to the provider's cloud as a new cloud task | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |

### `command.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `command.background` | `Move to background` | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.29 |
| `command.list` (subscription) | The running commands | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.29 |
| `command.stop` | Stop a running command; `Stop all commands` sends it once per command | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.29 |
| `command.write {sessionId, commandId, text?, endOfInput?}` | Typed input to a command that is waiting for it, and `End input` | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.29 |

### `controlPlane.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `controlPlane.call {procedure, input}`, on the service's local socket, answered with that procedure's output | The window's control-plane calls, which main forwards: the service holds every control-plane credential, attaches the hosted account's access token and signs each request's DPoP proof, so neither main nor the page holds one. `procedure` is one of the control-plane procedures the desktop's screens call (`device.list`, `device.linkStart`, `device.linkRedeem`, `device.link`, `device.linkCancel`, `device.rename`, `device.revoke`, `device.forget`, `device.statementList`, `device.pushAddressSet`, `runtimenode.rename` and `runtimenode.remove`); relay negotiation and any other procedure is refused under the code its contract registers | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-025](../../plans/025-remote-control.md) Phase 3 |

### `daemon.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `daemon.backupRead` → the last run, the folder, the total size, and each backup with its time, its size and the app version that wrote it | Read the backups: the last run, the folder, the total size and the list | [Spec-013 §Backup Policy](../../specs/013-persistence-recovery-and-replay.md#backup-policy) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-15 |
| `daemon.backupStart`; events `backup.completed`, `backup.failed` and `backup.restored` on the daemon's sentinel session | `Back up now`, and the daily backup | [Spec-013 §Backup Policy](../../specs/013-persistence-recovery-and-replay.md#backup-policy) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-15 |
| `daemon.configRead` | Read the machine-wide service settings: listener port, `Stop a run after`, `Ask me after one start leads to` as `workflowChainAskAfterRuns`, a number of runs or `null` for `Never ask`, `Max steps per turn`, `Spend limit`, `Tokens per run`, tool memory cap, the package cache limit, traces, replay log | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-12 |
| `daemon.configUpdate` | Change one of those settings | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-12 |
| `daemon.dataErase {}` | `Erase all data`: remove everything the app keeps on this machine, and the app's credential-store items | [Spec-020](../../specs/020-data-retention-and-gdpr.md) | [Plan-019](../../plans/019-data-retention-and-gdpr.md) T22.2.2 |
| `daemon.dataExport {destination}` → a job; `daemon.dataExportSubscribe` for its progress | `Export all data`: everything this machine keeps for the person, as a readable folder | [Spec-020](../../specs/020-data-retention-and-gdpr.md) | [Plan-019](../../plans/019-data-retention-and-gdpr.md) T22.2.1 |
| `daemon.machineSettingsRead` | Read the machine's settings file; `machineSettings.read()` carries it | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-2-9, [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-13 |
| `daemon.machineSettingsUpdate {change}` → the file as written | Write a change to the machine's settings file; the service is the file's one writer, and `machineSettings.write(change)` hands the change here | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-2-9, [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-13 |
| `daemon.packageCacheClear {cache: bun \| uv \| all}` | Clear one package cache or both | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.14 |
| `daemon.packageCacheRead` | Read what each package cache holds: bun's, `uv`'s, and the time each was read | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.14 |
| `daemon.restart` | Restart the service | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-2, T-005r-1-5, T-005r-1-7 |
| `daemon.retentionPurge` | `Delete old data` | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md), [Spec-020](../../specs/020-data-retention-and-gdpr.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-11 |
| `daemon.retentionRead` | Read the two retention bounds, `Keep sessions for` and `Keep diagnostic logs for`, and the counts `Delete old data` would remove | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md), [Spec-020 §Retention Policy](../../specs/020-data-retention-and-gdpr.md#retention-policy) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-11 |
| `daemon.retentionUpdate` | Change a retention bound | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md), [Spec-020](../../specs/020-data-retention-and-gdpr.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-11 |
| `daemon.status.read` | The service's facts: version, start time, processor and memory with the time each was read, and `secretsFile`, the path of the file secrets are kept in, present only on Linux with no Secret Service. `Check again` calls it again. | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-1, T-005r-1-4, T-005r-1-7 |
| `daemon.stop` | Stop the service (the confirm counts the Codex sessions typed in a terminal) | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-2, T-005r-1-5, T-005r-1-7 |
| `daemon.machineSettingsSubscribe` | Each written change to the machine's settings file, the first delivery being the current file; `machineSettings.subscribe()` carries it | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-2-9, [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-13 |

### `device.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `device.notificationSettingsSet {notifyOutsideTheApp, countOnAppIcon, kinds, pushKey, webPushKeys?}` | Hand each machine a device's notification switches and push keys | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 5 |
| `device.statementApply {statements}` | Hand a machine the statements a device has seen | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 2 |
| `device.trustedList` | A machine's own verified view of the trusted devices | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 2 |

### `driver.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `driver.listModes` | The levels and modes a session can run | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T4.1, T4.2, T4.3 |

### `git.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| event `git.settled`, cause `committed \| pushed \| pulled \| pull_request_opened \| review_posted` (`pulled {branch, commitId}`, `review_posted {requestNumber, verdict}`) | Durable record of a commit, a push, a pull, a pull request opened or a review posted | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-004](../../plans/004-session-event-taxonomy-and-audit-log.md) T1.12, [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.2, T11.4, T11.9 |

### `gitflow.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `gitflow.branchContextRead` | Branch and ship facts: uncommitted count, ahead/behind, pushed, open change request, pending merge/rebase/bisect with the command that ends it, default branch, the hosting service's name and its request word, pull request or merge request, whether the branch never left this machine, and everything the change-request form opens with | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.1 |
| `gitflow.changeRequestSubscribe {sessionId, depth: summary \| full}` | Live read of the open change request: state, can-merge, review decision, threads, checks | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.8 |
| `gitflow.changeRequestTextGenerate` | Generate change-request title and body | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.5 |
| `gitflow.checkLogRead` | A failing check's raw log | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.8 |
| `gitflow.commitMessageGenerate` | Generate a commit message | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.5 |
| `gitflow.diffRead` | Review's diff: Changes, Branch (with its commits, narrowable to one commit) or Pull request scope against a base; file kind words, binary, cut-short, untracked, one patch per path | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.3 |
| `gitflow.gitActionExecute` | Ship acts: commit, push, pull, open change request (base, draft, reviewers, labels); retry from the failed command | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.3 |
| `gitflow.gitActionPreview {sessionId, act, formValues}` → `{commands}` | Show the exact commands an act will run, before the press | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.4 |
| `gitflow.gitActionSubscribe` | Per-command progress of a running ship act | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.4 |
| `gitflow.hostAdd {host}` | Add a host (checked; refused in place, nothing saved) | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) Phase 4 T11.7 |
| `gitflow.hostList` | List self-hosted git hosts | [Spec-009 §Git Hosting Adapter](../../specs/009-gitflow-pr-and-diff-attribution.md#git-hosting-adapter) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) Phase 4 T11.7 |
| `gitflow.hostRemove` | Remove a host | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) Phase 4 T11.7 |
| `gitflow.labelList` | Label candidates | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.8 |
| `gitflow.reviewSubmit` | Submit a review with a verdict | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.9 |
| `gitflow.reviewerList` | Reviewer candidates | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.8 |
| `gitflow.threadReply` | Reply on a thread | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.8 |
| `gitflow.threadResolve` | Resolve a thread | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.8 |

### `highlight.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `highlight.read` | Syntax color spans the daemon computes once per file and caches; every surface paints the spans it is handed | [Spec-021 §Console Libraries](../../specs/021-desktop-app-and-renderer.md#console-libraries), [ADR-033](../../decisions/033-one-syntax-colorer-in-the-daemon.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-5-4 |

### `mcp.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `mcp.clearToolOverride` | Clear a per-tool override | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.4.3 |
| `mcp.get` | Read one server | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.2.4 |
| `mcp.list` | List MCP servers | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.2.4 |
| a `mcp.list` and `mcp.get` server entry reading `failed` carries `failedReason: commandNotRunnable` | A tool server whose command cannot run after a move | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.2.4 |
| `mcp.oauthLogin` | Sign in to a server (returns the sign-in URL; the app opens it) | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.5.1, T28.5.2 |
| `mcp.oauthLogout {serverId}` | Sign out of a server: delete the service's refresh token, and its signing key for a server that demands proof-of-possession tokens, and refuse every access token it handed out | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) Phase 5 T28.5.11 |
| `mcp.reconnect` | Reconnect a server | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.5.4 |
| `mcp.registrySearch {query, cursor?}` → `{servers: [...], nextCursor?}` | Search the public MCP Registry and fill `Add a server` from a result | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) Phase 3 T28.3.12 |
| `mcp.removeServer` | Remove a server | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.3.1, T28.3.4 |
| `mcp.setEnabled` | Turn a server on or off | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.3.3 |
| `mcp.setToolOverride` | Set a per-tool override | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.4.3 |
| `mcp.subscribe` | Follow server state | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.2.10 |
| `mcp.upsertServer` | Add or edit a server | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T28.3.1, T28.3.4 |

### `orchestration.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `orchestration.budgetRead` | Per-agent spend, routed up the parent chain | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.4, T3.2 |
| `orchestration.childRunLinkRead` | The agent tree at every depth and each child's head (model, effort, via, tokens, spend, start time, ancestry); the badge's live, total and waiting figures | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.3, T3.2 |
| `orchestration.costReceiptRead` | The session's spend by provider and account | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.9, T2.13 |
| `orchestration.runCreate` | Admit a run under an agent | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.1, T2.2 |

### `plan.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `plan.resolve` | Answer the plan card: keep, build, or build in a fresh session | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.11 |

### `plugin.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `plugin.appList {provider: "codex", pluginId}` → `{apps: [{appId, name, accounts: [{providerAccountId, linked, connectUrl}]}]}` | A Codex plugin's apps: each app's link state on every Codex account, and `Connect <App>` per account | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md), [Spec-029](../../specs/029-skills.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T6.1; [Plan-026](../../plans/026-skills.md) |
| `plugin.catalogList {provider, query?, cursor?}` → `{plugins: [{id, provider, name, displayName, description, marketplace, carries: {agents, skills, mcpServers, hooks}, installed, installedInTerminal}], nextCursor?}` | Browse each provider's plugin catalog, filtered as the person types | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md), [Spec-029](../../specs/029-skills.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T6.1; [Plan-026](../../plans/026-skills.md) |
| `plugin.install {provider, id}`, event `plugin.installed` | Install a plugin, and `Use in Sidekicks` for one installed in the person's own terminal | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md), [Spec-029](../../specs/029-skills.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T6.1; [Plan-026](../../plans/026-skills.md) |
| `plugin.installedList {provider?}` | The installed plugins, and those installed in the person's own terminal | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md), [Spec-029](../../specs/029-skills.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T6.1; [Plan-026](../../plans/026-skills.md) |
| `plugin.marketplaceAdd {provider, source}` | Add a marketplace by repository address or folder | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md), [Spec-029](../../specs/029-skills.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T6.1; [Plan-026](../../plans/026-skills.md) |
| `plugin.marketplaceRemove {provider, name}` | Remove a marketplace | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md), [Spec-029](../../specs/029-skills.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T6.1; [Plan-026](../../plans/026-skills.md) |
| `plugin.read {provider, id}` | Read what one plugin carries, each item by name and description, and its source | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md), [Spec-029](../../specs/029-skills.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T6.1; [Plan-026](../../plans/026-skills.md) |
| `plugin.uninstall {provider, id}`, event `plugin.uninstalled` | Remove a plugin | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md), [Spec-029](../../specs/029-skills.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T6.1; [Plan-026](../../plans/026-skills.md) |

### `presence.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `presence.read {}` | Read the devices connected to this machine: each one's `deviceId`, `deviceType`, whether an app window is in front on it (`appVisible`) and its liveness `state` (`PresenceState`). It carries no last-seen time: a device card's `Connected now` and `Last seen` are `device.list`'s alone | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 5 |
| `presence.subscribe {}` | Follow the devices connected to this machine as they come and go | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 5 |
| `presence.heartbeat`, carrying `PresenceHeartbeat` (`deviceId`, its liveness state, and its `deviceType`, `focusedSessionId`, `lastActivityAt` and `appVisible`) | A device tells the machine whether an app window is in front on it, a locked or sleeping screen counting as not in front, when that changes and otherwise every 15 seconds; the machine keeps the last one per device | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phases 4 and 5 |

### `preview.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `preview.devServerList` | Discovered dev servers | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `preview.marksSend` | Send frozen marks to the provider | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `preview.navigate` | Navigate, back, forward, reload | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `preview.pageActivate` | Activate a page | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `preview.pageClose` | Close a page | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `preview.pageCookiesClear` | Clear one site's cookies in the desktop host | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-1 |
| `preview.pageCookiesRead` | Cookie carry: read the desktop host's cookies at handover | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-1 |
| `preview.pageCookiesWrite` | Cookie carry: write cookies into the desktop host at handover | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-1 |
| `preview.pageList` subscription | The session's pages, live (address, title, back/forward depth, active, order, zoom), read by the renderer and by main | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `preview.pageList`'s record carries `released`, favicon, load state and zoom | The page budget: bounded by the machine's memory, the oldest idle page released first with its address kept, a page unseen ten minutes released; main destroys the view when the list says released | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2, T-020r-8-1 |
| `preview.pageOpen` | Open a page | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `preview.pageOpen`, called by main with the popup's address | A popup the page opens becomes a page in the list, never a window | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-1 |
| `preview.pageOpen` and `preview.navigate` answer the address Preview loads, with `movedFrom: port` when the carry took the next free port | Preview reaches a port WSL does not carry to Windows | [ADR-034](../../decisions/034-embedded-browser-for-preview.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| `preview.pageReorder` | Reorder pages | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |
| main reports each view as `preview.pageTargetReport {pageId, targetId}`; the daemon sends debugger commands through `preview.pageDebuggerSend {pageId, message}`, and main returns replies and events as `preview.pageDebuggerReport {pageId, message}`; Playwright joins with `connectOverCDP(transport)` | The page host's debugger link and the relay: Playwright reaches the desktop's Preview pages with no listening port | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-1 |
| `preview.portShareList` (a live read), `preview.portShareAdd {port}`, `preview.portShareRemove {port}` | The shared-ports list | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 7 |
| `preview.portTicketIssue {port}` → `{address}` | A shared port's own address for a browser tab | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 8 |
| `preview.portTunnelOpen {port}` → a stream on the channel, `preview.portTunnelClose` | A tunnel from another device to a shared port | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 4 |
| `preview.screencastSubscribe` | Screencast plus input for another device | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 7 |
| `preview.zoom` | Per-page zoom factor | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-8-2 |

### `provider.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `provider.install {provider}`; `provider.installSubscribe` → `{state: running \| installed \| failed {reason, command}}`, its first message the last outcome; `provider.installStop` | Install a missing provider with one press, where the service runs, on every platform | [Spec-025 §Interfaces And Contracts](../../specs/025-provider-accounts-and-credential-homes.md#interfaces-and-contracts) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.5 |
| `provider.list` | Provider status (installed, version, too old) and the provider's own knobs | [Spec-025 §Interfaces And Contracts](../../specs/025-provider-accounts-and-credential-homes.md#interfaces-and-contracts), [Spec-004 §Provider Parameter Vocabularies](../../specs/004-provider-driver-contract-and-capabilities.md#provider-parameter-vocabularies) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.4 |
| `provider.probe {provider}` | `Check again` on a provider's Command: resolve the executable again and re-read its version | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.4 |
| `provider.protectedPathList` | Read the protected paths, with the source of each | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.4 |
| `provider.standingRuleList` | Read the provider's own standing rules on this machine, each in the provider's own words | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.4 |
| `provider.standingRuleRevoke` | Revoke one of them where the provider keeps it | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.4 |
| `provider.terminalPluginUpdate {provider, enabled}` | `Use Sidekicks in terminal Claude Code`: put the app's terminal plugin into the person's own Claude Code, or take it out | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.4 |
| `provider.update` | Change one provider knob. A command-path change also re-checks the command and re-reads its models. | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md), [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.4 |

### `providerAccount.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `providerAccount.list` | List accounts, with usage windows and read times | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.3 |
| `providerAccount.login` | Start a sign-in | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.5 |
| `providerAccount.loginCancel` | Cancel a sign-in | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.5 |
| `providerAccount.memoryImport` | Copy memories into an account's folder, once | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.7 |
| `providerAccount.probe` | `Check now` | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.3 |
| `providerAccount.register` | Register an account | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.3 |
| `providerAccount.remove` | Remove an account (refused while a run holds it) | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.3 |
| `providerAccount.resetCredentialHome` | `Sign out` (reset the credential folder) | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.3 |
| `providerAccount.setCurrent` | Move the Default mark (switch accounts) | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.3 |
| `providerAccount.subscribe` | Follow the account list | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.5 |
| `providerAccount.update` | Update billing mode, keep-fresh and window start | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.3 |
| `providerAccount.update({wakeForWindowStartEnabled})`, whose reply carries `wakeHelper: installed \| notInstalled {reason}` | Wake this computer for an account's window start | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.3 |
| `providerAccount.usageRead` | Tokens and spend by day and by model, plus provider totals | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T4.1 |

### `pty.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `pty.close {sessionId, terminalId, force?}`, sent once per shell | Close a shell and end it: `×`, middle-click, `Close`, `Close others`, `Close to the right`; refused while a run holds the shell, confirmed in place (`<device> holds this shell. Close it?`) while another device holds it | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |
| `pty.list` (a live list) | List and follow the session's shells; a shell opened on another device arrives as a new tab | [Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |
| `pty.open` | Open a shell with `+`; the machine's own limit is refused in words | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |
| `pty.outputSubscribe` | A shell's live output: replay at its last size, then tail | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |
| `pty.reorder` | Reorder shell tabs; the order is held by the daemon | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |
| `pty.resize` | Resize a shell: only the device holding it sets its rows and columns | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |
| `pty.write` | Type into a shell; gated by the lease | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |

### `question.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| the session's own question card, `question.asked` carrying the wait's `waitId`, answered by `question.resolve` | Wait-for-chat-reply: the person's answer resumes the step | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T3.4 |
| `question.resolve` | Answer an agent's question | [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T3.11 |

### `repo.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `repo.attach` refused as `repo.folder_unreachable` | A folder picked in another distribution | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.1, T1.2, T2.3 |
| `repo.attach` | Attach a project folder (new-session picker, Settings › Projects) | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.1, T1.2, T2.3 |
| `repo.branchList` | Ordered branch list for both base pickers, with ↑/↓ figures and the tree holding each branch | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.9 |
| `repo.clone {url, parentFolder?, projectId?}` → `{projectId}`, ending in `repo.attached` | Clone a repository from the address or path the person typed, which goes to git as typed; the session is minted at once and the finished folder attaches as `Open folder…` attaches one. Refused before anything is fetched with `repo.clone_refused`, reason `destination_not_empty` | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T2.2, T2.3 |
| `repo.cloneAnswer {projectId, questionId, answer}` | Answer git's question during a clone: a user name, a password or token, a key's passphrase, or whether to trust a host's key | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.10 |
| `repo.cloneCancel {projectId}` | Cancel a clone | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.10 |
| `repo.cloneFolderRead {}` → `{folder, source: setting \| lastProject \| home}` | Where a clone goes, and where that folder came from | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.10 |
| `repo.cloneSubscribe {projectId}` | The clone card's live state | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.10 |
| `repo.detach` | Delete a project, from Projects' `Delete` or Runtime's `Remove` on the project's folder (sessions and folder stay) | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md), [Spec-002](../../specs/002-machine-registration.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.7, T1.2, T2.3 |
| `repo.executionRootPrepare` (+ `carryUncommitted`) | New worktree from a base, optionally carrying uncommitted work | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.3, T1.2, T2.3 |
| `repo.fileRead` | Read a working-tree file not in the diff, and the lines inside a collapsed gap | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.3 |
| `repo.folderList {path?, filter?, showHidden?}` → the folder in view and every entry in it, each with its path, and `more: true` when the filter would narrow more; the service may page the entries or load them incrementally, and no folder is unreachable | The machine's folders, listed in place for another device | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.11 |
| `repo.largeFilesPull {projectId}` | Get the large files a clone left as placeholders when Git LFS was not installed | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.10 |
| `repo.mountList` | Every folder the service can reach, each with what is using it | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.2 |
| `repo.mountRead` | One mount's facts: its origin (`attached`, a project's folder; `managed`, a chat's workspace; `worktree`, a worktree the app made, under its project) and what uses it | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.2, T1.2, T2.3 |
| event `repo.mount_health_changed {repoMountId, health}` | A mount's health as the re-probe changes it, on the stream of every session on that mount; with `repo.mountRead`'s health, the session's lost-folder banner | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md), [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.12 |
| `repo.projectArchive` | Archive a project | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.9 |
| `repo.projectBranchPatternUpdate {projectId, pattern \| null}` | Set or clear a project's own branch-name pattern (`Every project`'s pattern is a key in the machine's settings file, written through `daemon.machineSettingsUpdate`) | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.9 |
| `repo.projectEnvironmentUpdate` | Save a project's own environment rows (the machine-wide rows go through `daemon.machineSettingsUpdate`) | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.9 |
| `repo.projectList` | List projects (name, folder, session count) | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.9 |
| `repo.projectList` and `repo.mountList` rows carry `onOtherSideDisk: boolean` | A project or worktree folder on the other side's disk | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.2, T3.9 |
| `repo.projectReactivate` | Unarchive a project | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.9 |
| `repo.projectRename` | Rename a project | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.9 |
| `repo.projectSetupUpdate` | Save a project's worktree setup steps | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md), [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.9 |
| `repo.removedWorktreeDelete {removedWorktreeId}` | Delete a kept worktree now | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.11 |
| `repo.removedWorktreeList {projectId?}` → rows `{removedWorktreeId, projectId, name, branch, headCommit, removedAt, sizeBytes, sizeReadAt}` | The kept worktrees, for Runtime | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.11 |
| `repo.workingTreeSubscribe` | Tree-staleness signal from the watch on the working folder (watch or slow-tick mode) | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.12 |
| `repo.workspaceBind` (+ `executionMode`) | Bind a session to its project and where it works — a worktree of its own, or the checkout the project already has — on convert; a new session binds in `session.create`'s own step | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.1, T1.3, T2.4 |
| `repo.worktreeRestore {removedWorktreeId}` → `{worktreeId, path, branch, onNewBranch}`, or a refusal with `reason` | Put a kept worktree back | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.11 |
| `repo.worktreeRetire {worktreeId, discard}` | Remove a worktree, from the switcher or from Runtime's `Remove` on an app-made worktree | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.4, T1.2, T2.2 |
| `repo.worktreeSetupRetry` | Retry setup from the failed step | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.12 |
| `repo.worktreeSetupSubscribe` | Setup progress per step, surviving leaving the session | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.12 |
| `repo.worktreeStatusRead` (keyed by project) | Worktree switcher list: repo-root row plus each worktree with base, ahead/behind, dirty count, occupying sessions, `countsAsOf`; project-wide | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.4, T1.2, T2.4 |

### `run.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `run.childInterrupt` {targetRunId, childHandle, expectedRunVersion, clientIdempotencyKey} | Interrupt one named child | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T3.13 |
| `run.childPauseSet` {targetRunId, childHandle, paused, expectedRunVersion, clientIdempotencyKey} | Pause one named child, and continue it (the toggle's two presses) | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T3.13 |
| `run.childSteer` {targetRunId, childHandle, content, expectedRunVersion, clientIdempotencyKey}; `run.queueList`, `run.subscribeQueue`, `run.queueCancel` and `run.queueReorder` take `childHandle` too | Steer one named child: its box, onto the child's own queue held by the daemon, with pending rows, `Remove`, `Edit` and reorder as the lead's | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.1, T2.3, T4.1 |
| `run.childrenStop` {runId} | Stop every running child at every depth (`Stop all running`, and the child half of `Interrupt everything`, whose lead half is `run.intervene`) | [Spec-003](../../specs/003-queue-steer-pause-resume.md), [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T3.13 |
| `run.intervene` {type: "interrupt"} | `Interrupt` the lead (Escape or the word): pending messages go as the next turn, and a live exchange ends on both sides | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.2, T2.4, T4.1; [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) |
| `run.pause` | `Pause` | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.6, T3.4, T4.1 |
| `run.queueCancel` | Remove a pending message | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.1, T2.3, T4.1 |
| `run.queueCreate`, with `replacesQueueItemId` for an edit | Send: one Send to the lead; pending rows; `Retry`; `Edit` replaces a queued item in place in one call, the old item reading `superseded`, and is refused once the agent has taken the message; reorder is `run.queueReorder` | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.1, T2.1, T4.1 |
| `run.queueCreate` with an addressee member `to` | The person writes to another session with `@name` from the composer | [Spec-003](../../specs/003-queue-steer-pause-resume.md), [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.1, T2.1, T4.1 |
| `run.queueList` | The pending messages | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.1, T4.1 |
| `run.queueReorder {sessionId, childHandle?, queueItemIds}` | Reorder the waiting messages: one daemon-held order over the items still waiting, on the lead's queue or a child's | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T2.10 |
| `run.recoveryResolve {runId, choice: keep_provider \| undo_to_agreed \| continue_provider \| hand_over}`, event `run.recovery_resolved` | After a restart, settle a mismatch between the session's record and the provider's: a read-only surplus is added with no question, and any other asks with two named choices | [Spec-013](../../specs/013-persistence-recovery-and-replay.md) | [Plan-012](../../plans/012-persistence-recovery-and-replay.md) T15.5 |
| `run.refusalChoiceResolve {runId, choice: retry_fallback \| edit_prompt}`, events `run.refusal_choice_requested {sessionId, runId, refusedModel, fallbackModel, sentence?, safetyCategory?, retractedMessageIds?}` and `run.refusal_choice_resolved {sessionId, runId, choice: retry_fallback \| edit_prompt \| cancelled, deviceId?}` | Claude Code's retry-or-edit choice when its safety check refuses a turn and names a fallback model: `Edit message` then `Retry on <fallback model>` on the `Refused` row, the run `waiting_for_input` until the first answer; an `Interrupt`, or a message sent while it waits, answers `cancelled`, and the retracted messages leave the flow on the answer. A second or late answer is refused with `run.invalid_transition` (409), and the device that answered second closes its row with no error | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md), [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md), [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.38; [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T4.17 |
| `run.usageCreditsChoiceResolve {runId, choice: switch_default \| consent}`, events `run.usage_credits_choice_requested {sessionId, runId, modelName, overagesEnabled, balanceCents?, currency?, fallbackModel?}` and `run.usage_credits_choice_resolved {sessionId, runId, choice: switch_default \| consent \| interrupted \| unanswered, deviceId?}` | Claude Code's switch-or-credits choice when a Fable turn needs usage credits: `Switch to <model>` and, only while usage credits are on, `Continue on usage credits` on one row under Claude Code's own title, the run `waiting_for_input` until the first answer; an `Interrupt` or an undo interrupts the turn and answers nothing (`interrupted`), and a message sent while it waits is settled by Claude Code itself (`unanswered`). A second or late answer is refused with `run.invalid_transition` (409), and the device that answered second closes its row with no error | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md), [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md), [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.42; [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T4.18 |
| `run.resume` | The second press of `Pause`, which continues | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.6, T3.5, T4.1 |
| event `run.safety_buffering_updated` {sessionId, runId, turnId, active, fasterModel?}, relayed live on `run.subscribeState` and never kept | Codex's own sentence in the working line's action words while Codex holds a turn for a safety check; no flow row | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) |
| `run.subscribeQueue` | The queue stream | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T4.1 |
| `run.subscribeState` | The run-state stream: state slot, activity, the row dots | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.3, T4.1 |

### `session.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `session.archive`, event `session.archived` | Archive a session; its provider process stays as it was, and sleeps when idle as any session's does | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.5 |
| `session.attachmentAdd` | Stage a file: copied to the daemon at staging time and kept outside the checkout; also stages an MCP resource (Preview's marks chip is `preview.marksSend`'s) | [Spec-001](../../specs/001-session-core.md), [Spec-012](../../specs/012-artifacts-files-and-attachments.md) | [Plan-011](../../plans/011-artifacts-files-and-attachments.md) T14.11 |
| `session.attachmentCover {attachmentId, boxes: [{x, y, width, height}]}` → the new attachment | Cover part of a staged picture before Send | [Spec-012](../../specs/012-artifacts-files-and-attachments.md) | [Plan-011](../../plans/011-artifacts-files-and-attachments.md) T14.10 |
| `session.attachmentRemove` | Unstage a file with a chip's `×` | [Spec-012](../../specs/012-artifacts-files-and-attachments.md) | [Plan-011](../../plans/011-artifacts-files-and-attachments.md) T14.11 |
| `session.autoCompactUpdate` | This session's own auto-compact point (slider, `/autocompact`) | [Spec-011 §Context Window and Usage Meters](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md#context-window-and-usage-meters) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T3.9 |
| `session.autoMemoryUpdate` | The `Auto memory` switch | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md), [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31; [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-5-4 |
| event `session.branch_changed` | A branch changed outside the app is written back to the session | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.12 |
| `session.close`, event `session.closed` | Close a session; its provider process ends with it, and the session sits in the `Archived` group, dimmed, with `Closed` where `Unarchive` would be, readable and searchable until `Delete old data` purges it and counts it in its confirm | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.5 |
| `session.contextSubscribe` | What fills the context: one read feeds the ring and the inspector's section | [Spec-011 §Context Window and Usage Meters](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md#context-window-and-usage-meters) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T3.8 |
| `session.convert` {sessionId, repo path}, event `session.converted` | Convert a chat to a project: attach, copy the files in, skip paths the repo already has, keep the workspace, send the agent a note | [Spec-001 §Required Behavior](../../specs/001-session-core.md#required-behavior) | [Plan-001](../../plans/001-session-core.md) T6.7; [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.8 |
| `session.create` with `leadDefinitionId` and **`scratch: true`** → `resolvedConfiguration`; session record member **`scratchForDefinitionId`** | Try it, step 1: start the scratch session (no repo) whose lead is the definition, and get the resolved-binding echo. Reuse the open one if it exists. | [Spec-001](../../specs/001-session-core.md), [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3; [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) Phase 3 |
| A step of `session.create`, and of `session.fork` for a chat, done by the daemon's managed-workspace service | Create the chat's git-initialized managed workspace at `<home>/.ai-sidekicks/workspaces/<session-id>` and register it as a mount with a managed origin | [Spec-001](../../specs/001-session-core.md), [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3; [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) |
| `session.create` | Create a session with the lead's model and effort and, in a project, a `binding` naming the project and where it works (a worktree of its own or the project's checkout, `executionMode`: `provisioned-worktree` or `bound-root`), bound in the same step; a chat's managed workspace is made and registered as a mount in the same step; the created record names the lead | [Spec-001 §Interfaces And Contracts](../../specs/001-session-core.md#interfaces-and-contracts) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3 |
| `session.definitionsReload` | `/reload`: refresh agent and skill definitions by hand | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T3.6; [Plan-026](../../plans/026-skills.md) Phase 3 |
| `session.fileSearch` {query} | `@` file search in the working folder | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.9 |
| `session.fork`; the parent is recorded on the new `session.created` | Fork a session from a message anchor (a chat fork gets its own managed workspace) | [Spec-001 §Required Behavior](../../specs/001-session-core.md#required-behavior) | [Plan-001](../../plans/001-session-core.md) T2.2, T3.3 |
| `session.goalClear`, event `session.goal_cleared` | `/goal clear` | [Spec-014 §Session Goals](../../specs/014-multi-agent-orchestration.md#session-goals) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.1, T2.6, T1.2 |
| `session.goalUpdate` | `/goal <condition>` sets or replaces the goal | [Spec-014 §Session Goals](../../specs/014-multi-agent-orchestration.md#session-goals) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.1, T2.6, T1.2 |
| `session.hookList` | Inspector `Hooks` section, `{sessionId, provider, kind}` discriminated on `kind`, with `provider` as data: `loadedHooks` carries `folders`, the hooks a provider reports it loaded, per folder with that folder's errors and warnings (Codex `hooks/list {cwds}`); `hookFiles` carries `files`, the files a provider that reports none reads hooks from (Claude Code). The daemon's own hooks are never listed | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md), [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31; [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-5-4 |
| `session.import` | Start an import | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.6 |
| `session.importPreview` | Count the projects an import would attach before it runs | [Spec-025 §Interfaces And Contracts](../../specs/025-provider-accounts-and-credential-homes.md#interfaces-and-contracts) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.6 |
| `session.importStop` | Stop an import | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.6 |
| `session.importSubscribe` | Follow an import's progress | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.6 |
| `session.list` | The sessions list: rows grouped by shape, each a title and a state, with archived and closed sessions in the `Archived` group; live. Each entry carries `activity` (`running`, `waiting`, `done`, `failed` or `idle`) and `activityRenewedAt`: the daemon republishes a quiet run's entry every 15 s, and a reader treats a `running` or `waiting` reading older than 45 s as `idle` and never ages a `failed` one | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.2 |
| `session.maxStepsUpdate` | This session's own `Max steps per turn` override | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.12, T3.1 |
| `session.spendLimitUpdate` | This session's own `Spend limit` | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.4, T3.1 |
| `session.tokensPerRunUpdate` | This session's own `Tokens per run` | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.4, T3.1 |
| `session.mcpResourceList {sessionId, serverName}` → `{serverName, resources, complete}` | A server's resources for `Attach a resource…`; the pick stages through `session.attachmentAdd` | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) Phase 5 T28.5.12 |
| `session.mcpServerList {sessionId}` (a live list) | This session's tool servers, live, grouped by state | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) Phase 5 T28.5.12 |
| `session.mcpServerUpdate {sessionId, serverName, enabled}` | A per-session on/off switch for one server | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) Phase 5 T28.5.12 |
| `session.memoryRead` | Inspector `Memory` section: the memory paths and the account's own store | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md), [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31; [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-5-4 |
| `session.modeUpdate {sessionId, mode: build \| plan}` | The Build or Plan mode chip | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md), [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.28 |
| `session.mute {sessionId}` and `session.unmute {sessionId}` → `{}`, events `session.muted {sessionId, at}` and `session.unmuted {sessionId, at}`; `muted` on `session.list` and `session.read` entries | Mute and unmute a session's notifications; held by the daemon, seen by every device | [Spec-017](../../specs/017-notifications-and-attention-model.md), [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3; [Plan-016](../../plans/016-notifications-and-attention-model.md) |
| event `session.notice` of kind `provider_warning` {sessionId, kind, source: warning \| deprecation, text, details?} | The working line's `⚠ N warnings` word and its list, in Codex's own words; no flow row | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) |
| `session.overviewRead {afterRevision}` → `{revision, sessions: [{id, title, provider, state, agents: [{name, provider, state}]}], remoteControl: {state}}` | The terminal pane's read: every session with its agents and Remote Control's state, answered when anything moves | [Spec-001](../../specs/001-session-core.md), [ADR-035](../../decisions/035-claude-code-mods-are-an-optional-terminal-bridge.md) | [Plan-001](../../plans/001-session-core.md) T6.14 |
| `session.permissionLevelUpdate {sessionId, level: readonly \| ask \| reviewed \| sandboxed \| yolo}` → `{sessionId, level}` | The permission level chip | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.12 |
| `session.pin` and `session.unpin`, events `session.pinned` and `session.unpinned` | Pin and unpin a session inside its group, pin order kept; held by the daemon | [Spec-001 §Required Behavior](../../specs/001-session-core.md#required-behavior) | [Plan-001](../../plans/001-session-core.md) T6.6 |
| `session.providerCommandsSubscribe` | The live `/` list: the process's slash commands plus each working server's prompts | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T4.9 |
| `session.reactivate`, event `session.reactivated` | Unarchive a session; a closed session offers no `Unarchive` | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.5 |
| Field `shape: "chat" \| "project"` on the session snapshot, read through `session.read` and `session.list` | The durable shape column: chat or project | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3 |
| The `shape: "chat"` field on `session.read`; no read of its own | The strip's `Session workspace` label | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.8 |
| `session.read` | One session's facts: title, shape, state, project, worktree, base, elapsed time, ahead count, snapshot count, pending folder move, address, draft and staged files, lead binding | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3 |
| `session.rename`, event `session.renamed` | Rename a session | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.4 |
| `session.restart` | Restart a provider process that ended, or restart after a provider update | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.30 |
| `session.restore`; result `requested`, `restored`, per-part `conversation` and `files` failures, and `reason`; a `resend` member makes Edit and resend one call, and a call carrying `resend` takes the scope `conversation-and-files`, and `includeAlsoChanged: boolean`, false unless the ask's include line was pressed, puts back the dry run's `alsoChangedBy` paths too | Undo: conversation and files, conversation only, or files only | [Spec-013](../../specs/013-persistence-recovery-and-replay.md) | [Plan-012](../../plans/012-persistence-recovery-and-replay.md) T15.7 |
| `session.restorePreview` {sessionId, target: a message id or a snapshot id, scope} | Undo's dry run: files, lines, skipped files with reasons, the lines on what is not put back, the running commands, which agents would stop and whether they can resume | [Spec-013](../../specs/013-persistence-recovery-and-replay.md) | [Plan-012](../../plans/012-persistence-recovery-and-replay.md) T15.7 |
| `session.reviewNoteAdd` | Add a held review note | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.9 |
| `session.reviewNoteList` | The session's notes, live, each with `stranded` computed against the current diff | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.9 |
| `session.reviewNoteRemove` | Discard a note | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.9 |
| `session.reviewNoteUpdate` | Edit a note | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T11.9 |
| `session.reviewStart` {target: working tree, staged, or branch} | `/review [target]` | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.28 |
| `session.search` | Search across sessions | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.9 |
| `session.setTerminalFlowControl` {sessionId, terminalId, paused} | Flow control to the shell's process, per shell and per watching connection | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-7 |
| `session.setWorkingFolder` | Move the working folder; re-targeting the current folder is the cancel; the pending intent sits on the session row | [Spec-001](../../specs/001-session-core.md), [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-001](../../plans/001-session-core.md) T6.10; [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.1 |
| `session.sideQuestionAsk` {question} | `/btw`: a side question on a throwaway copy | [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md), [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.28 |
| `session.snapshotList` | List snapshots in the inspector | [Spec-013](../../specs/013-persistence-recovery-and-replay.md) | [Plan-012](../../plans/012-persistence-recovery-and-replay.md) T15.6 |
| `session.takeControl` {sessionId, terminalId, force?}, event `pty.control_changed` (with `holderRunId`) | Take one shell's lease, ordinary or forced; there is no release | [Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-3 |
| `session.terminalProviderSessionList {}` | Name the provider sessions typed in a terminal that are inside a provider's shared service, each a `TerminalProviderSession` with `provider` as data, working, idle or not reachable | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md), [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.2 |

### `skill.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `skill.availabilityUpdate` | Set a skill's switch on each provider, written through that provider's own per-session off switch; a skill may be off everywhere | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phases 2, 6 |
| `skill.create` | Create a skill folder under `.ai-sidekicks/skills`, global or project, name folded, collision suffixed, on both providers | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 2 |
| `skill.fileRead` | Read one file's body | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 5 |
| `skill.list` | List every skill folder across every origin, the read-only plugin origin `plugin · <name>` among them: its id (`skillId`, kept through a rename made in the app, the folder's address `#/skills/<id>`), origin, scope, folder path, front-matter name and description, the file list (path, size, readable or not), availability, icon, call form per provider, and the facts it shares with `agent.definitionList` under the same spellings: `orphaned`, `disabledInProvider`, `loadError`. The skill row draws the orphaned state: set apart, the extras the record still holds, the last known path, `Reattach` and `Discard` | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phases 1, 3, 4, 6 |
| `skill.recordDiscard` | Discard an orphaned skill record | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 2 |
| `skill.recordReattach` | Reattach an orphaned skill record (availability and icon) to a folder picked with the platform's chooser, taking its token, accepted only while the record is orphaned | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 2 |
| `skill.scan` | The widening scan over every file in the folder | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phases 2, 6 |
| `skill.subscribe` | Follow the skill list: the whole `skill.list` reply again each time a save from any window or the daemon's watch over the origins changes it, so the Skills screen and the composer's Skills group stay current | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 2 |
| `skill.update` | Save a folder whole (front matter, bodies, files added, renamed or removed, icon), for ours and for a provider's own folder in place; a new name renames a folder of ours, refused as `skill.name_taken` (`folderPath`) when another folder of ours holds it in the same place | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 2 |

### `timeline.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `timeline.bodyRead` {sessionId, rowId} | A row's large body or whole output, read only when its control is pressed | [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T3.5 |
| `timeline.childRunExpand` | A child's rows, fetched on demand, including a finished child's stored record | [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T1.4, T3.1 |
| `timeline.patchRead` {sessionId, toolCallId} | Every patch a call did not carry, in one read | [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T3.6 |
| `timeline.read` | Read the transcript | [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T1.4, T2.4 |
| `timeline.reasoningSurfaceRead` | The reasoning surface | [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T1.4, T1.3, T3.2 |
| `timeline.search` | Search one session's unloaded history | [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T3.7 |

### `turn.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `turn.tasks` (subscription) | The turn's task list | [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T3.10 |
| `turn.usage` (subscription) | Tokens received this turn | [Spec-011](../../specs/011-live-timeline-visibility-and-reasoning-surfaces.md) | [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T3.10 |

### `voice.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `voice.callStart {sessionId, offerSdp}` → `{answerSdp}`, sent at the first Space in a Codex session; Codex `thread/realtime/start {threadId, transport: {type: "webrtc", sdp}, version: "v3", outputModality: "audio", voice, initialItems, clientManagedHandoffs: true, includeStartupContext: false}` and its `thread/realtime/sdp`, `voice` read from the machine settings file and `initialItems` the session's earlier spoken exchange, oldest dropped first to fit 128 items and 8,192 estimated tokens | Start a Codex call | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33 |
| `voice.callStop`; Codex `thread/realtime/stop` | End a Codex call | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33 |
| `voice.callSubscribe`; from Codex's `thread/realtime/*` notifications, routed by `threadId` | A call's events | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33 |
| `voice.dictationStart {sessionId}` | Start dictation on a Claude Code session | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33 |
| `voice.dictationStop {cancel}` | End or drop the recording | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33 |
| `voice.dictationSubscribe` | The words in progress and settled, and a refusal | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33 |
| `voice.dictationWrite` (16 kHz 16-bit mono, 100 ms frames) | The recording's audio | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33 |
| `voice.stateUpdate {sessionId \| null}` → `{sessionId \| null}`; `voice.stateSubscribe`, live, the first delivery the current state | Which session voice is on in | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33 |
| `voice.voiceList`; Codex `thread/realtime/listVoices` (its `v1` list and `defaultV1`); the pick is written through the machine settings verb, never into Codex's configuration | The voices Codex offers | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33 |

### `workflow.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `workflow.definitionCreate` | Save a new workflow; also Duplicate and sharing to shared scope | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.2, T1.5, T1.7 |
| `workflow.definitionDelete` | Delete a workflow (soft) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.10 |
| `workflow.definitionExport` | Export a version as a file | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.5 |
| `workflow.definitionImport` | Import a file | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.5 |
| `workflow.definitionList` | List definitions (Workflows tab, tab count, `/workflow` name completion) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.2, T1.5 |
| `workflow.definitionRead` | Read one definition (builder, Duplicate, `open` and `schedule` verbs) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.2 |
| `workflow.definitionUpdate` | Save a new version: Save, Restore, `schedule` verb | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.5 |
| `workflow.draftRead` | Read the builder's draft back after a reload | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.19 |
| `workflow.draftUpdate` | Save the builder's unsaved draft | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.19 |
| `workflow.enabledSet` | Turn a workflow on or off | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.10 |
| `workflow.expressionPreview` | Preview an expression's value against the last run | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.19 |
| `workflow.fixSessionCreate` | Fix a failed step in a fresh session; the run keeps a link to it | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.15 |
| `workflow.gateResolve` | Approve or Reject in the step panel, and the `Answer this run` key | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.3 |
| `workflow.humanFormDraftSave` | Save a form as it is typed | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.2 |
| `workflow.humanFormRead` | Load a waiting form: prompt, fields, saved draft, revisions | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T3.2 |
| `workflow.humanFormSubmit` | Submit a form | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T3.2 |
| `workflow.keptVarsClear` | Clear the values `Keep for later runs` kept for one workflow | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.11 |
| `workflow.kindList` | Node catalog | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.13 |
| `workflow.layoutSet` | Save the canvas layout without a new version | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.8 |
| `workflow.permissionLevelUpdate` | Set the workflow's own permission level from the builder's level pill | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.8 |
| `workflow.nodeExecute` with scope `"node"` or `"fromHere"` | Run this node, and Run from here | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.9 |
| `workflow.pinDataSet` | Pin or unpin a node's test data: inspector, step panel Pin, Copy this run into the builder | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.8 |
| the `workflow.results_posted` and `workflow.step_*` events, drawn as transcript row kind `workflow_run` | The progress row, then the results row, in the session that asked | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.3, T5.7 |
| `workflow.resultsPost` | Pull a run's results into this session | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.11 |
| `workflow.runAttentionList` | The runs-needing-you section and Next waiting (N) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.16 |
| `workflow.runCancel` | Cancel a run | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.20, T5.22 |
| `workflow.runDelete` | Delete one run | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.14 |
| `workflow.runKeepSet` | Mark a run Keep, so deleting old runs leaves it | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.14 |
| `workflow.runList` | List runs (table, count, latest run for `results <name>`) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.5 |
| `workflow.runRead` | Read one run and its steps | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.22 |
| `workflow.runResume` | Resume a parked run | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.21, T5.22 |
| `workflow.runRetry` | Retry from a step | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.8 |
| `workflow.runStart` | Start a run: Run now in two places, Re-run, `/workflow run`, the inputs panel | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.9 |
| `workflow.runsDelete` | Delete runs older than a date; Keep runs and waiting runs are untouched | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.14 |
| `workflow.runsDeletePreview` | Count what `Delete runs older than…` would remove, before it runs | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.14 |
| `workflow.runsPauseSet` | Pause new runs | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.10 |
| `workflow.secretCreate {scope, scopeRef, name, secretValue}` → `{secretId, scope, scopeRef, name}` | Create a workflow secret from the Credential chooser's `New secret` | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.12 |
| `workflow.secretDelete {secretId}` | `Delete` a secret | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.12 |
| `workflow.secretList {scopeRef?}` → `[{secretId, scope, scopeRef, name}]` | List the secrets the chooser offers: this project's and the shared ones, by name | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.12 |
| `workflow.secretReplace {secretId, secretValue}` → `{secretId}` | `Replace value` on a secret | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.12 |
| `workflow.stepRead` | Read a step's input, output or log (step panel, inspector data panels) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.7 |
| `workflow.subscribe` | Live updates: runs, steps, schedules, the start hold | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.12 |
| `workflow.versionChainRead` | Version history (Versions panel list, the pinned-version chip) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.11 |
| `workflow.versionDiffRead` | Structural difference between two versions (panel count, canvas highlight, old and new params) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.11 |
| `workflow.versionRead` | Read one saved version (Versions panel, run graph) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.2 |
| `workflow.webhookListenerRead` | Webhook listener state: port, and whether it is listening or the port is taken | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.17 |
| `workflow.webhookTokenRotate` | Create or rotate a workflow's webhook token; the token is shown once | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.17 |

### `worktree.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| events `worktree.created`, `worktree.retired`, `session.swept_to_repo_root` | Worktree lifecycle records and the per-session sweep | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-004](../../plans/004-session-event-taxonomy-and-audit-log.md) T1.2 |

---

## Plan-001 — Session Core

```ts
// SessionCreate
interface SessionCreateRequest {
  clientIdempotencyKey: string; // a UUID
  // Where the new session works, bound in this same call, so no session exists unbound and its shape is
  // known from its first record.
  binding: SessionBinding;
  // The lead's binding spelled out: its driver, model, account and effort, as the app chose them for a
  // new session. A create names this, `leadDefinitionId`, or both; beside a definition, it is the binding
  // the definition runs on. `providerAccountId` null follows the provider's current account.
  lead?: AgentProviderBinding;
  // The saved definition this session's LEAD runs under: a request that spells its axes out in full
  // names none, and one naming a definition need not respell the axes the definition supplies. It is how
  // Try it starts a scratch session led by the definition under test, and it is the same daemon path a
  // workflow node and the cross-provider bridge already need — not a choose-your-lead surface. What it
  // resolved to comes back as the reply's `resolvedConfiguration` (`AgentResolvedConfiguration`, §Plan-024).
  leadDefinitionId?: AgentDefinitionId;
  // A Try-it scratch session for the definition `leadDefinitionId` names. It requires that member and a
  // `chat` binding, so it has no repo. The daemon keeps at most one open scratch session per definition,
  // so a request for a definition that already has one returns that session instead of a second; the
  // session stays in the sessions list, named, until the person closes it.
  scratch?: true;
}

// A chat names nothing more: the daemon makes the chat's managed workspace inside the create and registers
// it as a mount whose managed origin names this one chat. A project names the project's mount and where the
// session works in it — the project's own checkout (`bound-root`) or a worktree of its own
// (`provisioned-worktree`) — and the daemon checks, in the same step, that the picked root belongs to the
// project, the check `repo.workspaceBind` makes when a chat converts. A mount belongs to the machine,
// not to one session, so every project session names the project's one mount.
type SessionBinding =
  | { kind: "chat" }
  | { kind: "project"; repoMountId: RepoMountId; executionMode: ExecutionMode };
interface SessionCreateResponse {
  sessionId: SessionId;
  state: SessionState;
  ownerUserId: UserId; // the account holder the session belongs to; set once at creation and immutable
  // Present iff the request carried `leadDefinitionId`: the echo lets a caller render what it actually
  // got instead of re-reading the registry and assuming it has not moved (§Plan-024).
  resolvedConfiguration?: AgentResolvedConfiguration;
}

// session.created payload (Spec-005 §Session Lifecycle). A session has exactly one main agent and that
// agent is born with the session rather than joined to it later, so this event is the creating record of
// that agent's row in the agents projection (`AgentListEntry`, `agent.list` in §Plan-013) and no attach event exists.
// It is also the one record of the session's shape at birth, of the session it was forked from, and of the
// definition a scratch session tries, so the session's row is rebuilt from events alone.
interface SessionCreatedPayload {
  sessionId: SessionId;
  shape: SessionShape;
  mainAgent: AgentListEntry; // the agent as `agent.list` describes it, one shape for one live agent
  // Present exactly on a forked session: the session it was forked from and the message it was forked
  // at. Parentage is recorded here and nowhere else (`session.fork` below).
  parent?: { sessionId: SessionId; anchorCursor: EventCursor };
  // Present exactly on a Try-it scratch session (`scratch` on SessionCreateRequest).
  scratchForDefinitionId?: AgentDefinitionId;
  actor?: string | null;
}

// SessionRead
interface SessionReadRequest {
  sessionId: SessionId;
}
interface SessionReadResponse {
  session: SessionSnapshot;
  timelineCursors: { earliest: EventCursor; latest: EventCursor; acknowledged?: EventCursor }; // earliest: the position immediately BEFORE the oldest surviving row (Plan-004 T4.1), a directly resumable cursor — constant encode(-1), because no row leaves a live session: compaction is lossless, and deleting a session deletes all of its rows. Consumer: resume from acknowledged ?? earliest; gap detection decode(acknowledged) < decode(earliest) ⇒ events lost ⇒ reset projection + resume from earliest.
}

// SessionSubscribe
interface SessionSubscribeRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor;
}
// Response over the daemon's local socket: replay, then tail, as a stream of frames. The daemon coalesces
// the session's events into one frame per 16 ms or 50 events, whichever comes first, the window opening on
// the first event so nothing waits longer than it. A frame carries changes, never the whole transcript,
// and every change carries its cursor. The daemon never waits for a subscriber: one that falls behind is
// dropped for, and the next frame that fits carries `gap`; the subscriber then repairs from the daemon's
// record by cursor, and past a gap of 1,024 events reads `session.read` and resumes from its latest cursor
// instead of filling. When a subscriber that fell behind has caught up on its queue, the daemon sends it
// one frame with no changes, carrying `gap` and the newest cursor, so a session that goes quiet right after
// a drop still tells the subscriber it is behind.
interface SessionSubscribeFrame {
  events: Array<{ cursor: EventCursor; event: EventEnvelope }>; // EventEnvelope: §Plans 003, 004 And 005
  gap?: {
    resumeAfterCursor: EventCursor; // the last cursor this subscriber was sent before the drop
    latestCursor: EventCursor; // the newest cursor the daemon holds for the session
    repair: "fill" | "snapshot"; // fill: read the missing events by cursor; snapshot: past 1,024 missing events
  };
}
type SessionSubscribeStream = AsyncIterable<SessionSubscribeFrame>;

// A session's shape, decided by its BINDING and carried as a stored discriminator — the `shape` column on
// the session's row — never a mode flag on a request and never guessed from a path prefix
// ([ADR-030](../../decisions/030-two-session-shapes.md)). A `chat` session is bound to a daemon-owned,
// git-initialized managed workspace, one per session, at `<home>/.ai-sidekicks/workspaces/<session-id>`,
// a path the daemon makes and never takes from a caller. The daemon creates it inside `session.create`
// (and inside `session.fork` for a chat, whose fork gets a workspace of its own) and registers it as a
// mount whose managed origin names that one chat. It is deleted whole when the session is purged, kept
// when the session is archived, and skipped by the archive sweep. A `project` session is bound to a repo
// the person attached, which is defined against that mount's origin rather than against a folder
// existing. Converting a chat to a project copies the workspace's files into the attached repo and moves
// the shape IN PLACE with the session's history kept, which is why the shape is a member of the snapshot
// and not an immutable creation argument.
type SessionShape = "chat" | "project";

// Shared projection types
interface SessionSnapshot {
  id: SessionId;
  state: SessionState;
  shape: SessionShape;
  // The session's own name. Absent means untitled, which is the ordinary state: a surface listing an
  // untitled session shows its first message rather than a generated title, so no default is
  // materialized here.
  name?: string;
  // Whether the person muted this session's notifications (`session.mute` below). The same fact rides each
  // `session.list` entry.
  muted: boolean;
  // Present exactly on a Try-it scratch session: the definition it tries.
  scratchForDefinitionId?: AgentDefinitionId;
  // The working-folder move a run boundary will apply, or null when none is pending
  // (`session.setWorkingFolder` below); `worktreeId: null` targets the project's repo root.
  pendingWorkingFolder: { worktreeId: WorktreeId | null } | null;
  // The daemon-held composer store below: the whole unsent draft (empty when there is none) and the whole
  // staged set, so every device opens the same half-written message.
  draft: string;
  attachments: SessionAttachmentSummary[];
  // This session's OWN bound on how many steps one turn may take, absent where the person set none —
  // in which case the machine's own Runtime value applies, and where that is unset the turn is
  // unbounded and each provider does what it does on its own. What the bound does and how each
  // provider realizes it is Spec-003 §The Step Bound On A Turn's; it is not a budget, and reaching
  // it ends the turn and then the run, as run.interrupted with trigger "step_limit".
  maxStepsPerTurn?: number;
  // The address another session writes to when it messages this one — what the session inspector
  // offers as `Copy address`. It names the inbox the daemon holds for the session — one socket (a named
  // pipe on Windows) in Claude Code's socket directory, stable for the session's whole life; the daemon
  // forwards each frame to the live process and, while the session sleeps, takes the first frame, wakes
  // the session through Claude Code's resume and delivers the frame as the message. Present on every
  // session. No read of its own exists, deliberately — the one surface that shows it already reads this
  // snapshot, and a second verb would be a second source for one fact (Spec-014 §Sessions Talking To
  // Each Other).
  address: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Console session operations ----
// The verbs the session screen calls beside the three above. Payload owner: [Spec-001 §Interfaces And Contracts](../../specs/001-session-core.md#interfaces-and-contracts).

// SessionRename — session.rename. The name lives on the session record. `null` clears it and returns the
// session to untitled rather than writing an empty title, so a name is never the empty string. Renaming to
// the name the session already has writes nothing.
interface SessionRenameRequest {
  sessionId: SessionId;
  name: string | null;
}
interface SessionRenameResponse {
  sessionId: SessionId;
  name?: string; // absent after a clear, which is the same shape the snapshot carries
}

// SessionMaxStepsUpdate — session.maxStepsUpdate. Sets or clears THIS session's own bound on how many
// steps one turn may take. `null` clears the override and returns the session to the machine's own
// Runtime value; a number is a positive integer, and a number below 1 is refused. A session id the
// daemon does not hold is refused with `session.not_found` and nothing is appended. A change reaches
// the session's NEXT turn and never the turn in flight, which is why the reply echoes the stored
// override rather than any running turn's effective value. The machine-wide value is not written
// here — it belongs to the Runtime settings page (§Settings Surface Reads And Writes), so one number
// has one home on each side of the override.
interface SessionMaxStepsUpdateRequest {
  sessionId: SessionId;
  maxStepsPerTurn: number | null;
}
interface SessionMaxStepsUpdateResponse {
  sessionId: SessionId;
  maxStepsPerTurn?: number; // absent after a clear, which is the same shape the snapshot carries
}

// SessionSpendLimitUpdate / SessionTokensPerRunUpdate — session.spendLimitUpdate /
// session.tokensPerRunUpdate. Set or clear THIS session's own `Spend limit` and `Tokens per run`,
// which start at the Runtime settings page's values when the session is created. `null` is
// `Unlimited`, after which nothing stops or refuses on that limit. A spend limit is a non-negative
// integer of micro-dollars and a token limit a positive integer; anything else is refused, as is a
// session id the daemon does not hold (`session.not_found`), and nothing is appended. Saving a higher
// limit carries on the turn or run that limit stopped, as `Raise limit` does (Spec-014 §Budget
// Policies). Both answer with the budget state, served from the one budget-accountant accessor as the
// read is, so a reply and an immediately following `orchestration.budgetRead` carry the same figures.
interface SessionSpendLimitUpdateRequest {
  sessionId: SessionId;
  spendLimitUsdMicros: number | null;
}
interface SessionTokensPerRunUpdateRequest {
  sessionId: SessionId;
  tokensPerRun: number | null;
}

// SessionFork — session.fork. Mints a session of the SAME shape from a message anchor, carrying the
// transcript prefix up to and including that message with live timers settled and streams stopped in
// the copy, and carrying the parent's execution posture and tool set. A `project` fork lands on a
// new worktree cut off the parent's current one at its current commit; a `chat` fork stays a chat, with
// a managed workspace of its own, and involves no worktree. Parentage is recorded on the forked session's
// OWN session-created record (`SessionCreatedPayload.parent`) and NOT as a second event: one read of the
// new session answers where it came from, and the parent's own history is untouched.
interface SessionForkRequest {
  sessionId: SessionId;
  // The anchored message, addressed in the same cursor vocabulary session.subscribe and
  // timeline.read use. The fork carries every row up to and including this position.
  anchorCursor: EventCursor;
  // Absent leaves the fork untitled — the ordinary case, since the fork affordance asks for no name.
  name?: string;
}
interface SessionForkResponse {
  sessionId: SessionId; // the minted session
  shape: SessionShape; // always the parent's
  worktreeId?: WorktreeId; // present exactly on a `project` fork
}

// SessionSetWorkingFolder — session.setWorkingFolder. ONE call requesting the move of a session's
// working folder to another of its project's worktrees, or back to the repo root. An idle session
// moves at once — same session, same history, new directory, and the live provider process
// reconnects there. A request made mid-run never refuses: the pending intent is recorded ON THE
// SESSION ROW rather than queued, and applies at the run boundary. Re-targeting to the current
// directory IS the cancel, and a later request SUPERSEDES the pending one rather than queuing behind
// it, so a session holds at most one pending move. Removing a worktree clears every pending move
// pointing at it and sweeps the sessions standing in it back to the repo root.
interface SessionSetWorkingFolderRequest {
  sessionId: SessionId;
  worktreeId: WorktreeId | null; // null targets the project's repo root
}
interface SessionSetWorkingFolderResponse {
  sessionId: SessionId;
  // `applied` — the session moved now, either because it was idle or because the request
  // re-targeted the current directory and thereby cleared a pending move. `pending` — a run was
  // live and the intent is recorded for the boundary. These two arms are what the composer strip
  // reads to draw either the new tree or `<current> → <target> when this run ends`.
  disposition: "applied" | "pending";
  worktreeId: WorktreeId | null;
}

// The daemon-held, SESSION-SCOPED composer store: the draft, its staged files, and the held review
// notes of §Plan-008 below. Daemon-held rather than window-held for one reason — a half-written
// message or review reaches the person's other devices, and Send needs no upload step because the
// file was already copied. Typed unsent text is NEVER written to renderer-local storage.

// SessionDraftUpdate — session.draftUpdate.
interface SessionDraftUpdateRequest {
  sessionId: SessionId;
  text: string; // the whole draft; an empty string clears it
}
interface SessionDraftUpdateResponse {
  sessionId: SessionId;
  updatedAt: string;
}

// SessionAttachmentAdd — session.attachmentAdd. Staging COPIES each file to the daemon and keeps the
// copy OUTSIDE the checkout, so a staged file survives a working-folder move and never appears in a
// diff. Several items at a time; a file item is a file, never a folder. A file arrives as the
// `FilePathRef` token the platform's own chooser, a drop or a paste gave the renderer
// ([Spec-021 §Preload Bridge Contract](../../specs/021-desktop-app-and-renderer.md#preload-bridge-contract)),
// and main's relay turns the token into the path the daemon copies, so no path string comes from the
// renderer or from another device; a pasted picture is a file too, written by main to a temporary file
// whose token it mints. Each accepted item is validated by the Plan-011 ingest pipeline — a picture is
// kept, shown and sent as its original bytes — and is addressed by its `ArtifactId`
// from then on, so the original path is never read again, which is also why a pasted or dropped file
// stages through this same operation rather than a second one.
interface SessionAttachmentAddRequest {
  sessionId: SessionId;
  items: SessionAttachmentItem[];
}
// `clientStagingId` is the client's own id for one item, so a retried item is staged once: the daemon
// answers a repeated id with the item it already staged or refused.
type SessionAttachmentItem =
  | { kind: "file"; clientStagingId: string; file: FilePathRef }
  // Preview's marks chip is staged by `preview.marksSend` (§Page-Host Method Registry), never here.
  // One resource a tool server offers, picked from `session.mcpResourceList`. Its content is untrusted
  // and its `uri` is never used as a path.
  | { kind: "mcpResource"; clientStagingId: string; serverName: string; uri: string };
interface SessionAttachmentAddResponse {
  sessionId: SessionId;
  // The WHOLE staged set, so a client renders what the daemon holds instead of merging its own add.
  attachments: SessionAttachmentSummary[];
  // One entry per item not staged, so no item is dropped in silence. The cause is the daemon's own: a
  // limit hit, named — how many files one message carries, how large a file may be, each figure read
  // from what the daemon accepts — a provider that takes no attachments, a card waiting on the person, a
  // picture the provider will not take, refused in that provider's own words, or a copy that failed. How
  // many were taken is the request's items less these.
  refused: Array<{ clientStagingId: string; error: ErrorResponse }>;
}
interface SessionAttachmentSummary {
  artifactId: ArtifactId;
  clientStagingId: string; // the id the item was staged under, so the client matches its chip
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}
interface SessionAttachmentRemoveRequest {
  sessionId: SessionId;
  artifactId: ArtifactId;
}
interface SessionAttachmentRemoveResponse {
  sessionId: SessionId;
  attachments: SessionAttachmentSummary[]; // the whole remaining set, the same reason as on add
}

// SessionMute / SessionUnmute — session.mute and session.unmute. Muting withholds this session's
// `Finished` and `Failed` notifications on every channel and every device — no banner, no web-address
// message, no email-digest line — and withdraws those of its banners still standing. `Waiting on you`, a
// workflow's Notify step, the bell's list and its count are untouched, so a mute never hides what waits
// on the person ([Plan-016](../../plans/016-notifications-and-attention-model.md#invariants) I-016-3).
// The daemon holds the mute, so every device sees it, and it has no timer. Muting a muted session appends
// nothing, and likewise unmuting an unmuted one.
interface SessionMuteRequest {
  sessionId: SessionId;
}
type SessionMuteResponse = Record<string, never>; // `{}`: the mute is read back through `session.read`
interface SessionUnmuteRequest {
  sessionId: SessionId;
}
type SessionUnmuteResponse = Record<string, never>;

// session.muted / session.unmuted payloads (Spec-005 §Session Lifecycle). The session row's `muted_at`
// is rebuilt from these events and goes with the session.
interface SessionMutedPayload {
  sessionId: SessionId;
  at: string; // ISO 8601
}
interface SessionUnmutedPayload {
  sessionId: SessionId;
  at: string; // ISO 8601
}

// SessionSearch — session.search. One search over session titles and message text across every session
// the list holds, archived ones included, answering the palette's search box. Hits come grouped by
// session, in the index's own ranked order, with no cap.
interface SessionSearchRequest {
  query: string;
}
interface SessionSearchResponse {
  groups: Array<{
    sessionId: SessionId;
    name?: string; // absent for an untitled session, as on the snapshot
    hits: SessionSearchHit[];
  }>;
}
interface SessionSearchHit {
  // The message the hit sits in, in the cursor vocabulary `timeline.read` uses, so pressing the hit lands
  // the transcript on that message and loads whatever history that takes.
  cursor: EventCursor;
  line: string; // the line the match sits in
  matchRanges: Array<{ start: number; end: number }>; // the matched letters within `line`
}

// TimelineSearch — timeline.search. The same search over one session's own rows, answering the session's
// find box: every hit in that session, in the session's own order, so the box counts the whole session
// and loads the history a hit sits in only when the person steps to it.
interface TimelineSearchRequest {
  sessionId: SessionId;
  query: string;
}
interface TimelineSearchResponse {
  hits: SessionSearchHit[];
}
```

### Session Method-Name Registry

The console's `session.*` operations beyond the [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase 3 rows registered in §JSON-RPC Method-Name Registry below, and beyond the lease verb and the flow-control signal registered in §Session Terminal-Control Method Registry. Names are `dotted-camelCase` per the canonical `METHOD_NAME_FORMAT`. These ride the **daemon JSON-RPC transport only**: a session's name, its working folder, its draft, its staged files and its mute are node-local state the terminal-owning daemon is the record authority for, so no control-plane tRPC sibling exists — the `repo.*` / `approval.*` posture. Method strings stay imperative and disjoint-by-form from the past-participle [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) durable event names (`session.renamed`, `session.goal_updated`, `session.muted`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `session.rename` | `mutation` | `SessionRenameRequest` | `SessionRenameResponse` |
| `session.fork` | `mutation` | `SessionForkRequest` | `SessionForkResponse` |
| `session.setWorkingFolder` | `mutation` | `SessionSetWorkingFolderRequest` | `SessionSetWorkingFolderResponse` |
| `session.maxStepsUpdate` | `mutation` | `SessionMaxStepsUpdateRequest` | `SessionMaxStepsUpdateResponse` |
| `session.spendLimitUpdate` | `mutation` | `SessionSpendLimitUpdateRequest` | `OrchestrationBudgetState` |
| `session.tokensPerRunUpdate` | `mutation` | `SessionTokensPerRunUpdateRequest` | `OrchestrationBudgetState` |
| `session.draftUpdate` | `mutation` | `SessionDraftUpdateRequest` | `SessionDraftUpdateResponse` |
| `session.attachmentAdd` | `mutation` | `SessionAttachmentAddRequest` | `SessionAttachmentAddResponse` |
| `session.attachmentRemove` | `mutation` | `SessionAttachmentRemoveRequest` | `SessionAttachmentRemoveResponse` |
| `session.mute` | `mutation` | `SessionMuteRequest` | `SessionMuteResponse` |
| `session.unmute` | `mutation` | `SessionUnmuteRequest` | `SessionUnmuteResponse` |
| `session.search` | `query` | `SessionSearchRequest` | `SessionSearchResponse` |

`session.goalUpdate` and `session.goalClear` are registered in §Plan-013's method registry, where the goal's delivery contract lives, and are listed here only so the console's session surface reads whole in one place.

**Every search read goes over one index.** The palette's search box and a session's own find box are answered by ONE daemon search over session titles and message text: `session.search`, the cross-session form, returns hits grouped by session, each hit carrying its own message anchor, in the index's own ranked order with no cap; `timeline.search`, the single-session form, returns every hit in that session so the find box counts the whole session and loads the history a hit sits in only when the person steps to it. Both shapes are in the §Plan-001 block above. `timeline.search` sits in the `timeline` namespace with the session's other row reads and is registered in [§Timeline Method-Name Registry](#timeline-method-name-registry). The renderer walks no rows it does not hold, which is the whole reason the read is daemon-side. The index behind both is SQLite's own FTS5 over session titles and message text, which the daemon's `better-sqlite3` 13.0.3 build carries against SQLite 3.53.4 ([local-sqlite-schema §Session Search Index](../schemas/local-sqlite-schema.md#session-search-index)).

**A session's address mints no read.** The address another session writes to when it messages this one rides `SessionSnapshot` above, because the one surface that shows it — the inspector's `Copy address` — already reads that snapshot, and a second verb would be a second source for one fact. It is the inbox the daemon holds for the session, present for the session's whole life. The two operations two sessions actually talk through are tools the daemon serves to the providers and are registered in §Plan-013's registry note, not here.

**`Copy link` and `sidekicks open <address>` mint no method.** A session's link is `sidekicks://session/<id>`, one form with one function that composes it and one that parses it in `packages/contracts`, and three places share it: the session's `Copy link` copies it as one plain line, main's link handler routes it, and `sidekicks open <address>` on the CLI hands it to the running app through the platform's own registered link type, so it adds no second path into the app and carries nothing the address does not. The link handler is in the main process ([Spec-021 §Main Process Responsibilities](../../specs/021-desktop-app-and-renderer.md#main-process-responsibilities)): it parses the link, drops a malformed one, and hands the renderer only the parsed `SessionId` through `window.subscribeToNavigationRequest`. No daemon wire surface is involved.

---

## Plan-025 — Remote Control Bootstrap (control-plane tRPC)

The control plane's typed [tRPC v11](https://trpc.io/) router is served from Cloudflare Workers via [`@trpc/server/adapters/fetch`](https://trpc.io/docs/server/adapters/fetch) per [ADR-013 tRPC Control-Plane API](../../decisions/013-trpc-control-plane-api.md). The control plane keeps no session record, so it serves no session route and no session event stream: a device reaches a session only through the machine that holds it, over the relay, and that machine's service answers with its own `session.*` methods (§Session Method-Name Registry).

The procedure-type assignments follow the tRPC convention: read-only operations use `query` (HTTP GET-like, idempotent); writes / state-changes use `mutation` (HTTP POST-like, non-idempotent). Method-name strings are `dotted-camelCase` per the format defined in §Plan-005-Partial — Local IPC Daemon Control below — the same convention applies to Plan-025's tRPC HTTP procedures and Plan-005's JSON-RPC IPC methods, so client SDK call-site shape is symmetric across local IPC and remote control-plane calls. Within-segment camelCase is permitted in nested namespaces per LSP precedent (e.g. `textDocument.didOpen`, `settings.effectiveRead`).

---

## Plan-005-Partial — Local IPC Daemon Control

[Plan-005 Phase 3](../../plans/005-local-ipc-and-daemon-control.md) defines the JSON-RPC IPC surface served by the local runtime daemon to in-tree clients (CLI, desktop renderer). The subset of that surface built beside Plan-001's session-core types ([Plan-005 §Execution Windows (V1 Carve-Out)](../../plans/005-local-ipc-and-daemon-control.md#execution-windows-v1-carve-out)) is declared here: (1) the canonical method-name format that [Plan-005 §I-005-8](../../plans/005-local-ipc-and-daemon-control.md#i-005-8--method-names-conform-to-the-canonical-format-declared-in-api-payload-contractsmd) requires the registry to enforce mechanically at `register(method, ...)` call time and (2) the JSON-RPC handshake `protocolVersion` field type, an ISO 8601 `YYYY-MM-DD` date string with current value `"2026-05-01"` ([§JSON-RPC Handshake `protocolVersion` Field](#json-rpc-handshake-protocolversion-field) below). The rest of Plan-005's shapes are canonical elsewhere and not mirrored here: the `MethodRegistry` runtime shape in `packages/contracts/src/jsonrpc-registry.ts`; the `LocalSubscriptionProducer<T>` shape in `packages/contracts/src/jsonrpc-streaming.ts` (its client-side consumer `LocalSubscriptionConsumer<T>` lives in `packages/client-sdk/src/transport/types.ts`); and the JSON-RPC error envelope in [error-contracts.md §JSON-RPC Wire Mapping](./error-contracts.md#json-rpc-wire-mapping).

### JSON-RPC Method-Name Registry

**Canonical format**: `dotted-camelCase`. Method-name strings match the regex:

```
/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/
```

Every dot-delimited segment starts with a lowercase letter and may contain camelCase (`[a-z][a-zA-Z0-9]*`) — the first segment (the namespace root) included. This is the dotted-camelCase segment style of the LSP precedent ([Language Server Protocol §General Messages](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) — e.g. `workspace.executeCommand`, and camelCase-rooted names such as `textDocument.didOpen`) and the MCP precedent ([Model Context Protocol §Protocol Messages](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) — `tools.list`, `tools.call`), applied uniformly to every segment, the root included. A segment may carry an uppercase letter inside it but never start with one, in any position (`Session.create` fails), and a name has at least two segments. Most roots are one lowercase word (`session`, `daemon`, `run`, `repo`, `voice`); a camelCase root such as `providerAccount` or `callbackTool` passes the same rule. Each root's methods are documented in the section of the plan that owns them, and [§Operations Not Yet Built](#operations-not-yet-built) lists every documented method no handler serves yet. The V1 `session.*` surface (`session.create`, `session.read`, `session.subscribe`) uses all-lowercase segments; nested-namespace operations like `settings.effectiveRead` and `driver.listCapabilities` (lowercase root + camelCase tail) are permitted under this regex, as is a camelCase root such as `providerAccount.list`.

The regex accepts the registered surface and rejects:

- `session/create` — slash-style (visually conflated with HTTP path segments; ambiguous in JSON-RPC contexts where method names appear in the JSON `method` field, not URLs).
- `SessionCreate` — PascalCase (collides with the project's TypeScript type-name convention; `Session.create` is rejected on the same ground — the root widening admits an uppercase letter _inside_ a segment, never at its start; `SessionCreate` is already a request-payload type symbol per `packages/contracts/src/session.ts`, so a string-form would be ambiguous at every call site).
- `sessionCreate` — bare camelCase without a namespace dot (cannot express the namespace/operation split without a convention-internal delimiter; doesn't scale to nested namespaces).

**Method-name table** (Plan-005 Phase 3 surface):

| Method | Procedure type | Notes |
| --- | --- | --- |
| `session.create` | RPC (request/response) | Materialize new session row + emit `SessionCreated`. |
| `session.read` | RPC (request/response) | Resolve session by id. |
| `session.subscribe` | Long-lived (`LocalSubscriptionConsumer<EventEnvelope>`) | Replay-then-tail event stream. |

**Cross-transport consistency**: This same `dotted-camelCase` format is used by Plan-025's tRPC HTTP procedures (per §Plan-025 — Remote Control Bootstrap above). Both transport surfaces share the convention so that client SDK call-site shape is symmetric across local IPC and remote control-plane calls.

**Register-time enforcement** ([Plan-005 §I-005-8](../../plans/005-local-ipc-and-daemon-control.md#i-005-8--method-names-conform-to-the-canonical-format-declared-in-api-payload-contractsmd)): the method registry's `register(method, handler)` call MUST evaluate `method` against this regex and throw on mismatch. This is mechanical validation, not human review — out-of-format names cannot reach the dispatcher.

```ts
const METHOD_NAME_FORMAT = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

function register(method: string, handler: Handler): void {
  if (!METHOD_NAME_FORMAT.test(method)) {
    throw new Error(`method name "${method}" violates dotted-camelCase canonical format`);
  }
  // ... registry insertion
}
```

The runtime regex check is owed by the Plan-005 substrate at `packages/runtime-daemon/src/ipc/registry.ts#isCanonicalMethodName` (the `register()`-time guard), which imports the canonical regex as the `METHOD_NAME_FORMAT` constant exported from `packages/contracts/src/jsonrpc-registry.ts` (the single source — no per-package re-declaration); the `MethodRegistry` interface itself is likewise canonical in code there per the §Source-of-Truth Policy at the top of this file.

### JSON-RPC Handshake `protocolVersion` Field

The field is carried across the [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) JSON-RPC handshake substrate (`packages/contracts/src/jsonrpc.ts`, `packages/contracts/src/jsonrpc-negotiation.ts`, `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`, and the client-SDK transport surface).

**Canonical format**: ISO 8601 date-string in `YYYY-MM-DD` form. The substrate Zod schema at `packages/contracts/src/jsonrpc-negotiation.ts#ProtocolVersionSchema` MUST be:

```ts
const ProtocolVersionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
```

**Current value**: `"2026-05-01"` — the date string is the V1 protocol version. The daemon's supported set at `packages/runtime-daemon/src/ipc/protocol-negotiation.ts#DAEMON_SUPPORTED_PROTOCOL_VERSIONS` is `["2026-05-01"]` for V1; future revisions advance the date and append to the array.

**Ordering convention**: ISO 8601 date-strings are lexicographically equivalent to chronologically ordered. The `negotiateProtocol` algorithm uses string-sort() (`[...].sort.at(-1)!`) for max-version selection, with no separate semver parser. Floor / ceiling discrimination uses the same lex order against the daemon's supported set.

**Rationale**: This project is an AI-agent IPC running `claude-driver` and `codex-driver` provider processes; the [Model Context Protocol (MCP) §Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture) is the closest analog, and MCP uses date-string `protocolVersion` (e.g. `"2025-06-18"`) for the same handshake semantics. Date-strings encode release date inherently, dodge the semver "v1.5 with no v1.4" ambiguity, and are immediately readable in logs and error reports without a parser.

**Distinction from `EventEnvelopeVersion`**: `protocolVersion` is the JSON-RPC handshake field on every request — it identifies the wire-protocol revision the client and daemon speak. `EventEnvelopeVersion` (per [ADR-017](../../decisions/017-cross-version-compatibility.md), defined under §Plans 003, 004 And 005 below) is a semver `MAJOR.MINOR` brand on event envelopes — it identifies the event-data schema revision. The two surfaces are independent and evolve on independent cadences, and neither stands in for the other.

### JSON-RPC Request `id` Bound

**Canonical bound**: a request `id` may not exceed `JSON_RPC_ID_MAX_BYTES` (256) bytes once JSON-encoded. The constant is declared at `packages/contracts/src/jsonrpc.ts` beside the frame's message-size limit and re-exported unchanged by `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts`, which enforces it.

**Where it is enforced**: at the **request** boundary, before dispatch — an over-bound id refuses as `-32600 Invalid Request` with `data.type: "invalid_envelope"`, and that refusal carries `id: null` rather than echoing the offending value. Enforcement is two-sited and both sites are required: the envelope's id gate refuses the request, and the gateway's id-extraction helper — through which the `jsonrpc` and `method` gates build their error frames, and which answers _before_ the id gate — falls back to a null id, without which the one frame guaranteed to be small would be the one carrying the oversized echo.

**Why a request-side bound rather than a response-side subtraction**: JSON-RPC requires a response to echo the request's `id`, so the id is the one response member a response schema does not choose. A reply is bounded by the substrate's absolute message-size limit ([Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format)), and an oversized reply cannot carry its own error — the send path drops the connection instead. Without this bound, a 900 KB id inside an otherwise-valid request makes every reply to it unencodable and the session unrecoverable from contract-valid data alone.

**Why the encoded form**: measuring the JSON encoding rather than the JavaScript string length covers escaping (a control character encodes to six ASCII bytes) and lets one rule read identically for the string, number, and null id forms the envelope admits.

**Consumers**: any page builder sizing a reply against the frame it will become subtracts a framing reserve that includes this bound — see [Plan-010](../../plans/010-live-timeline-visibility-and-reasoning-surfaces.md) T1.5 and its `TIMELINE_PAGE_FRAME_RESERVE_BYTES` derivation. The reserve is therefore derived from an enforced rule rather than an assumed allowance.

---

## Plan-025 — Machine Registration

The `runtimenode` namespace names the one machine that runs the daemon; "runtime node" is the backend's word for it. The machine registers with the control plane through `runtimenode.register` when it first connects, keyed by its id and its owning user and never by a session ([Plan-025](../../plans/025-remote-control.md)). Other devices read whether the machine is reachable from its relay connection, so the namespace has no attach, heartbeat, capability or roster method, and no session carries a `runtime_node.*` event. This document specifies the `runtimenode.*` methods in the §Machine Registration Method Registry below.

Method-name strings are `dotted-camelCase` per `METHOD_NAME_FORMAT`, defined in §Plan-005-Partial — Local IPC Daemon Control above (the `register(method, …)` guard at the regex constant). The `runtimenode` namespace token is the concatenated domain noun: `runtimeNode` would also validate, but the concatenated root is the registered form and stays as it is. The underscore `runtime_node` form is **rejected** as a method name by `METHOD_NAME_FORMAT` (no underscores).

### Machine Registration Method Registry

The machine's own record on the control plane: the daemon registers it, and the person renames or removes it from any linked device. Every call is decided against the caller's verified PASETO `sub`; a call that changes a row decides against that row read under lock in the same transaction, and a caller who does not own the machine is refused `runtimenode.permission_denied`, the one refusal that never says whether the machine exists. The owning user is always the caller's verified identity and never a request member. The shapes are in `packages/contracts/src/runtime-node.ts`.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `runtimenode.register` | `mutation` | `RuntimeNodeRegisterRequest` | `RuntimeNodeRegisterResponse` — control-plane tRPC ONLY, **daemon-called** at the machine's first connection to the control plane (Plan-025 Phase 3) |
| `runtimenode.rename` | `mutation` | `RuntimeNodeRenameRequest` | `null` — control-plane tRPC ONLY (Plan-025 Phase 3) |
| `runtimenode.remove` | `mutation` | `RuntimeNodeRemoveRequest` | `null` — control-plane tRPC ONLY; the removal is the `runtimenode.removed` statement it posts to the account's chain (Plan-025 Phase 5) |
| `runtimenode.certificateChallengeSet` | `mutation` | `RuntimeNodeCertificateChallengeSetRequest` | `null` — self-hosted relay ONLY, **daemon-called** while a shared-port certificate for the machine's wildcard name is being issued (Plan-025 Phase 8) |

```ts
interface RuntimeNodeRegisterRequest {
  nodeId: NodeId;
  identityKey: MachineIdentityKey; // the service's Ed25519 key, the one key a machine has: `{algorithm: "ed25519", publicKey}`, the public half in base64; stored as runtime_nodes.public_key and key_algorithm
  name: string; // the machine's name as the person sees it
  platform: string; // the operating system the service runs on, as the service reports it
  serviceVersion: string; // the service's semver version
}
interface RuntimeNodeRegisterResponse {
  nodeId: NodeId;
  registeredAt: string; // ISO-8601, control-plane clock
}

interface RuntimeNodeRenameRequest {
  nodeId: NodeId;
  name: string;
}

interface RuntimeNodeRemoveRequest {
  nodeId: NodeId;
  statement: string; // the signed runtimenode.removed statement, base64url, appended to the account's chain as its signer wrote it
}

// The relay writes the DNS challenge record only for a machine that proves its key, and only for the
// minutes of the challenge.
interface RuntimeNodeCertificateChallengeSetRequest {
  nodeId: NodeId;
  challengeValue: string; // the ACME DNS-01 value for the machine's wildcard name
  // 128-char lowercase hex signature by the machine's identity key over the JCS-canonical
  // { nodeId, challengeValue } of this request, checked against runtime_nodes.public_key for nodeId
  machineSignature: string;
}
```

### Device, Statement Chain And Push Method Registry

The control-plane procedures that keep the person's devices, passkeys and trust chain, and deliver a sealed push. A device calls them directly; the desktop app calls them through the service's `controlPlane.call`. Every call is decided against the caller's verified PASETO `sub`, from any device the chain has not revoked, and the owning user is never a request member. The members are the ones [Spec-027 §Interfaces And Contracts](../../specs/027-remote-control.md#interfaces-and-contracts) states; the `device.*` shapes are in `packages/contracts/src/device.ts` and `push.send`'s in `packages/contracts/src/push.ts`, each landing with the unit that builds it.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `device.list` | `subscription` | `DeviceListRequest` | `DeviceListEvent` — the machines, devices and passkeys with each one's connected state and last-seen time, then each statement's event carrying its kind as its name, `device.forgotten` and `runtimenode.registered`; event-driven, no polling (Plan-025 Phase 5) |
| `device.linkStart` | `mutation` | `DeviceLinkStartRequest` | `DeviceLinkStartResponse` — opens the five-minute single-use link (Plan-025 Phase 5) |
| `device.linkRedeem` | `mutation` | `DeviceLinkRedeemRequest` | `DeviceLinkRedeemResponse` — the new device redeems the link; both devices then show the six digits derived from their keys (Plan-025 Phase 5) |
| `device.link` | `mutation` | `DeviceLinkRequest` | `null` — posts the `device.linked` statement; re-linking on the same key is refused (Plan-025 Phase 5) |
| `device.linkCancel` | `mutation` | `DeviceLinkCancelRequest` | `null` (Plan-025 Phase 5) |
| `device.rename` | `mutation` | `DeviceRenameRequest` | `null` — posts the `device.renamed` statement (Plan-025 Phase 5) |
| `device.revoke` | `mutation` | `DeviceRevokeRequest` | `null` — posts the `device.revoked` statement (Plan-025 Phase 5) |
| `device.forget` | `mutation` | `DeviceForgetRequest` | `null` — removes a revoked device's row; its `device.revoked` stays in the chain (Plan-025 Phase 5) |
| `device.statementList` | `query` | `DeviceStatementListRequest` `{after}` | `DeviceStatementListResponse` — the account's statements after the given head (Plan-025 Phase 2) |
| `device.pushAddressSet` | `mutation` | `DevicePushAddressSetRequest` `{platform: "apns" \| "fcm" \| "webPush", address}` | `null` — stored as `devices.push_address`, dropped at revoke (Plan-025 Phase 5) |
| `push.send` | `mutation` | `PushSendRequest` | `null` — **daemon-called**: the machine hands over a notice it sealed, and the control plane delivers it through the person's own APNs, FCM or VAPID credentials, storing nothing about it; every push expires after 24 hours (Plan-025 Phase 5) |

### Session Terminal-Control Method Registry

The shared-terminal write lease ([Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior)) exposes one `session.*` method, `session.takeControl`. A **second `session.*` method sits in the second table row and is not a lease operation at all** — `session.setTerminalFlowControl`, the renderer's back-pressure signal, registered and specified in its own block after the lease shapes below; it is grouped here because it addresses the same shell surface and takes the same transport posture, and it is called out as separate because it gates no bytes, holds no lease and adjudicates nothing. The lease method is **daemon JSON-RPC ONLY** — deliberately NOT the dual-transport shape of the `runtimenode.*` mutations above: for those, the tRPC callee (the control plane) is itself the record authority, whereas the lease authority is the terminal-owning daemon, so a tRPC registration would place the mutation on a party that can neither adjudicate nor enforce it. A Remote Control device calls the same method over its end-to-end channel to the machine, and the relay carries it as ciphertext it cannot read, so every take is adjudicated where the lease lives. **The machine is the only lease authority, and the control plane keeps no copy of the lease.** Every client — the machine's own windows and every Remote Control device alike — reads the holder by folding the daemon's `pty.control_changed` broadcasts and the take responses; the daemon broadcasts every take and the auto-release classes (disconnect and agent-run write-burst end — [Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior)). No control-plane table, roster member or projection-sync call carries a holder, so nothing about a shell reaches the control plane.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `session.takeControl` | `mutation` | `SessionTakeControlRequest` | `SessionTakeControlResponse` — daemon JSON-RPC ONLY in V1 (no control-plane tRPC registration; [Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior) transport posture) |
| `session.setTerminalFlowControl` | `mutation` | `SessionSetTerminalFlowControlRequest` | `SessionSetTerminalFlowControlResponse` — daemon JSON-RPC ONLY (the same V1 transport posture as the lease method: the PTY host this drives is daemon-local, so no other party can act on the signal). Not a lease operation — consumed by [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-7 |

**One lease per shell.** A session opens as many shells as the machine can hold, each its own tab, and the write lease is keyed per shell rather than per session: `terminalId` is a required member of the take request and of the flow-control signal below, and every `pty.control_changed` broadcast carries it, so the holder is named PER SHELL: so one device can hold one shell while another of the account's devices — or an agent's running command — holds another. Without the key a take on one tab would silently move every other tab's lease, and the lease line under the tab strip could not speak for the active tab alone. The identifier is the daemon's own handle for that shell; no client mints one. The daemon's own lease record is keyed per shell with it, so two shells' transitions never serialize against each other.

**No release verb.** A shell's lease belongs to the connection that took it. A device gives a shell back only by another device taking it, or by that connection ending — the pane closing or the socket dropping, a lid closed mid-command included — which is the disconnect auto-release; closing a pane gives back only the leases that pane's own connection holds. Nothing on any screen releases a shell, so no operation does.

**The forced take.** `session.takeControl` carries a `force` member rather than a second method, because the act is the same act under a stronger precondition. A forced take moves the shell's lease off ANOTHER OF THE ACCOUNT'S DEVICES, broadcasts `pty.control_changed` with the reason `taken_by_force`, and never touches the foreground process — the handoff lands between write frames, so a running program is untouched and the displaced device loses only a half-typed line. It is **refused while the hold belongs to an agent run that is writing**, and that refusal is normative rather than a courtesy: the person stops or pauses the run instead, and the run-lifecycle release frees that shell. The refusal is what makes the agent-path hold different from the device-path hold, so an agent-held shell is NOT the idempotent self-retake case even though both holds sit on the same device: a run's hold is a holder of its own, named on the lease record and on every broadcast as `holderRunId`, which is exactly what the precondition reads.

```ts
interface SessionTakeControlRequest {
  sessionId: SessionId; // no caller field on the wire — the caller is the connection's device, per the transport rule below
  // The shell this lease is for. The lease is one per shell, so every take names its shell.
  terminalId: string;
  // A forced take moves the lease off another of the account's devices. Absent or `false` is the
  // ordinary first-acquire take, which refuses `pty.control_held_by_other` against a live holder.
  force?: boolean;
}

interface SessionTakeControlResponse {
  controlHolder: string; // the calling DEVICE's identifier — first-acquire-holds, or the force, succeeded
  terminalId: string;
}
```

**The renderer's back-pressure signal.** `session.setTerminalFlowControl` is the daemon-facing operation behind the renderer terminal's own flow control, declared per shell by each connection watching that shell: the connection declares the shell paused when its terminal says it is behind, and resumed once it has caught up. The daemon pauses the shell's read on its PTY host only while every live watcher of that shell is behind, so a flooding process is slowed where it is producing rather than filling the renderer and losing output at a discard watermark ([Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-7, which consumes this method and maps the pause onto each backend). A single watcher that falls behind while another keeps up stops receiving output and catches up from the shell's replay window or from a snapshot, so one slow device never freezes a healthy one, and a connection's behind state clears when that connection ends. **It is keyed by the shell and the watching connection**: `terminalId` is a required member, because a session opens several shells and a pause on one never stalls another, and the connection is the caller's own, known from the transport and never a request member. **One method with a boolean rather than a pair**, because the renderer is declaring a state it is in rather than asking for two different acts, and a declared state is idempotent — the same value twice is the same state and changes nothing. It is **not gated by the write lease**: it moves no bytes toward the shell and asserts no authority over it, so making it lease-held would let a device without the lease be flooded by its own terminal with no way to say so. It mints **no error code**: a call naming a shell this daemon does not hold is an accepted no-op, because a back-pressure signal racing a closing shell is ordinary and a refusal would hand the client something it can do nothing about.

```ts
interface SessionSetTerminalFlowControlRequest {
  sessionId: SessionId; // no caller field on the wire — the caller is the connection's device, per the transport rule below
  // The shell this connection is declaring its state for; the daemon's own handle, as on the take.
  terminalId: string;
  // The state this connection is declaring for that shell: true while it is behind, false once it has
  // caught up. Not a pair of verbs — the same value twice is the same state.
  paused: boolean;
}

interface SessionSetTerminalFlowControlResponse {
  accepted: true; // the uniform lifecycle-success shape this document already uses; nothing is read back
}
```

Refusals are typed in [Error Contracts §PTY](./error-contracts.md#pty): holder identity is session-visible presence metadata (the `pty.control_changed` broadcast exposes it to the account's own devices); a take while another of the account's devices holds the lease returns `pty.control_held_by_other` with `data.fields.holderDeviceId`; a terminal write with no lease held returns `pty.control_not_held`. A take by the current holder is idempotent success — no transition occurs and nothing broadcasts. Every successful transition broadcasts `pty.control_changed` ([Spec-005 census](../../specs/005-session-event-taxonomy-and-audit-log.md#pty-control-session_lifecycle)), authored by the terminal-owning daemon; transitions include the two auto-release classes — holder disconnect and the agent-run write-burst release (the acquiring run's first lifecycle transition out of `running` after an agent-path take; the acquiring run and its agent are set by the daemon on the lease record, never taken from a request field, and move to the new run on an agent-path take from a different run on the same device, which broadcasts like any change of holder). A take broadcasts `reason: 'taken'`, a forced take `'taken_by_force'`, and the auto-release classes `'auto_released_disconnect' | 'auto_released_run_idle'` ([Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior)); every broadcast carries `terminalId`. A client reads a broadcast carrying `released` or `auto_released_authorization_lost` as an unread transition. The take request carries no caller field: the caller is the connection's device. A local daemon JSON-RPC caller is the **device co-located with the node**, the daemon's own recorded local device, and the node's own agent runs take their write bursts through the daemon's in-process lease authority on that **same device** (no wire hop), but a run's hold is a holder of its own. The lease record keeps the run, and the `pty.control_changed` broadcast names it as `holderRunId`, absent while a device holds the shell, while `holderDeviceId` stays the machine's own device identity; the agent is read from the run, so every device reads that an agent's running command holds the shell and is offered the run's own stop rather than a take, and a take against a run's hold — from the node's own device included — is refused with `pty.control_held_by_other` rather than treated as the idempotent self-retake case. A linked device's take binds the **device identity** its channel's handshake proves ([§Authenticated Principal And Authorization Model](#authenticated-principal-and-authorization-model)) and rides the terminal-byte channel per Spec-002's forward constraint — so `controlHolder` and the idempotent self-retake comparison are well-defined on every path that can reach the lease authority.

---

## Plans 003, 004 And 005

### Plan-003 — Provider Driver Contract (Internal Interface)

```ts
// Internal driver interface. Two kinds of nominal-TypeScript surface ship here. (a) The
// daemon-CONSTRUCTED param types (`CreateSessionParams` … `ApplyInterventionParams` + the
// intervention payloads) are genuinely trusted — the daemon constructs them in-process.
// (b) The driver-CONSTRUCTED returns — the capability flags, `DriverCapabilities`,
// `GetCapabilitiesResult`, `ProviderSessionHandle`, and `ProviderModel`/`ProviderMode` — are
// normalized at the Plan-003 Phase-3 driver boundary (the driver, daemon-owned code, parses
// raw provider output there) and returned to the daemon as already-trusted normalized values,
// so they ship nominal by design and are not re-parsed at this contract layer. Their persisted
// free-form fields (`DriverCapabilities.contractVersion`, `ProviderSessionHandle.resumeHandle`,
// and `DriverCliVersionReport.rawVersion` — the CLI-version string as the provider printed it,
// riding the nominal `GetCapabilitiesResult` return exactly like `contractVersion`) are bounded
// at the Plan-003 Phase-2 write seam (semver / non-empty + length + NUL), not here.
// Zod validates ONLY the surfaces that parse UNTRUSTED
// provider output (the trust boundary): the result envelopes `DriverInterventionResult`,
// `DriverResumeResult`, `ForkConversationResult`, `DriverGoalResult`, and `DriverAuthProbeResult`,
// provider-declared `ProviderToolMetadata`, and the driver-normalized `CallbackToolInvocation` /
// `McpServerStatusEmission` (each built from provider wire output before the daemon-injected
// seam sees it).
// `resumeSession` returns the `DriverResumeResult` discriminated union (defined below)
// to make silent-replacement structurally inexpressible per Spec-004 §Fallback Behavior.
// `getCapabilities` returns the `GetCapabilitiesResult` wrapper (defined below) so the
// per-tool `ProviderToolMetadata[]` rides alongside the flag matrix in a single
// round-trip per Plan-003 Phase 4.
// Within the Zod-validated surfaces, `ProviderToolMetadata` STRIPS unknown keys (Spec-004
// §Default Behavior forward-compat: "Unknown capability fields are ignored (tolerant
// reader)" — contractVersion is change-detection, not negotiation),
// while the result envelopes reject unknown keys (`.strict()`);
// and every untrusted provider-output free-form string (`ProviderToolMetadata.name`/`.description`,
// `DriverInterventionResult.fallbackAction`, `DriverResumeResult.bindingId`/`.providerFailureDetail`,
// `ForkConversationResult.fallbackAction`/`.bindingId`, `DriverGoalResult.fallbackAction`,
// `DriverAuthProbeResult.detail`, `CallbackToolInvocation.toolName`/`.toolCallId`,
// `McpServerStatusEmission.serverName`
// and `ProviderCommandEntry.name`/`.description`/`.scope`/`.argumentHint`/`.server` plus
// `ProviderOutputSpeedState.declared`/`.reason`, the ones that reach a client: both shapes are
// built from provider-, skill- or tool-server-authored metadata at the driver's own normalize
// boundary and both travel to a client, so an unbounded one is an arbitrarily large IPC response
// and renderer workload) —
// each on a Zod-validated result envelope, `ProviderToolMetadata`, or a driver-normalized
// seam shape (`CallbackToolInvocation` / `McpServerStatusEmission` / `ProviderCommandEntry` /
// `ProviderOutputSpeedState`) below —
// are runtime-bounded (length + non-whitespace + NUL-rejection) via the package's `wireFreeFormString`
// helper — Zod constraints not expressible in these TS interface shapes.
// The daemon's provider layer (`packages/runtime-daemon/src/provider/`) realizes this enumeration for the
// driver-internal shapes; `packages/contracts/src/provider-driver.ts` (`DriverInterventionResult`) and
// `packages/contracts/src/provider-driver-transcript.ts` (`ProviderCommandEntry`, `ProviderOutputSpeedState`)
// realize it for the ones that reach a client, and `packages/contracts/src/session.ts` holds the
// `wireFreeFormString` helper both use.
interface ProviderDriver {
  createSession(params: CreateSessionParams): Promise<ProviderSessionHandle>;
  resumeSession(params: ResumeSessionParams): Promise<DriverResumeResult>;
  startRun(params: StartRunParams): Promise<void>;
  interruptRun(params: InterruptRunParams): Promise<void>;
  applyIntervention(params: ApplyInterventionParams): Promise<DriverInterventionResult>;
  // Fork the bound conversation at a message into a NEW provider conversation, leaving the source
  // untouched: the provider leg of `session.fork`. Never a rollback (see `ForkConversationParams`).
  forkConversation(params: ForkConversationParams): Promise<ForkConversationResult>;
  // Cut the bound conversation IN PLACE back to a message: undo's conversation leg (see the note
  // beside `ForkConversationParams`). Mechanics and shapes: Spec-004 §Interfaces And Contracts.
  rewindConversation(params: RewindConversationParams): Promise<RewindConversationResult>;
  respondToRequest(params: RespondToRequestParams): Promise<void>;
  // `Allow once` on a block by the provider's own reviewer at the `reviewed` level: the driver half of
  // `approval.denialOverride`. Claude Code's driver sends the sentence Claude Code's own Recently
  // denied list sends; Codex's driver calls `thread/approveGuardianDeniedAction` with the review Codex
  // sent, and Codex's reviewer still reviews the retry. It reaches a running turn at once and starts a
  // turn when none is running. It retries nothing itself: the agent decides whether to try again.
  overrideDenial(params: OverrideDenialParams): Promise<void>;
  setSessionGoal(params: SetSessionGoalParams): Promise<DriverGoalResult>;
  clearSessionGoal(params: ClearSessionGoalParams): Promise<DriverGoalResult>;
  closeSession(params: CloseSessionParams): Promise<void>;
  listModels(): Promise<ProviderModel[]>;
  listModes(): Promise<ProviderMode[]>;
  getCapabilities(): Promise<GetCapabilitiesResult>;
  probeAuth(): Promise<DriverAuthProbeResult>;
  // Compose the hand-over brief a session on a DIFFERENT provider is started from, on a throwaway
  // copy of the old session and never on the live one; required of every driver (Spec-004
  // §Interfaces And Contracts; Spec-014 §Continuity, and what is declared rather than dropped).
  // It returns the old provider's own summary of the copy, or the fixed template where the copy's
  // summary is not readable, saying which of the two it did, with the declared-loss list. What
  // follows the summary — the last two exchanges word for word — and the plain transcript file
  // written beside the brief are the daemon's. The copy's one turn is spent on the session's own
  // account; the live session starts no turn and its conversation is unchanged.
  exportHandoverBrief(params: ExportHandoverBriefParams): Promise<DriverHandoverBriefResult>;
  // Ask the provider to compact the bound session's OWN context, on a user's explicit
  // request and never on a threshold, timer, or heuristic (Spec-004 §User-
  // triggered context compaction). Gated on `context_compaction`. It SETTLES on the provider's
  // typed compaction evidence — the frame that already produces usage.context_compacted — and
  // NEVER on the request being accepted: the Codex method answers an empty ack and the Claude leg
  // is a driver_command frame that only settles, so acceptance is evidence of delivery and of
  // nothing else. There is deliberately NO prompt-injected emulation arm; a driver that cannot
  // compact declares the flag false and the call refuses as driver.capability_unsupported.
  // The wait for that evidence has no time limit of the driver's own: it ends at the frame, or
  // `failed` when the run's runtime binding stops being live (a provider that exits
  // mid-compaction), never `applied`. Late evidence is NOT lost: a compaction frame arriving after the
  // wait ended normalizes into usage.context_compacted exactly as an unsolicited provider-initiated
  // compaction does, so no boundary escapes Spec-003's rewind classifier.
  compactContext(params: CompactContextParams): Promise<DriverCompactionResult>;
  // Read the provider's own enumeration of native slash-commands and skills for the bound
  // session (Spec-004 §The provider command and skill surface). Gated on
  // `provider_commands`. A LIVE read held as driver-session state and discarded with it: not
  // persisted, not cached across sessions, and folded into no projection — which is why this
  // capability adds no table and no column. Every entry carries the (driverName,
  // providerAccountId) it was read under, and that binding is a ROUTING INVARIANT: an entry is
  // offerable only to agents of that same binding, and the one entry V1 dispatches is dispatchable
  // only through them.
  listProviderCommands(params: ListProviderCommandsParams): Promise<ProviderCommandListResult>;
}

// Console-parity shapes (Spec-004 §Desktop Console Parity Surfaces).
//
// AUTHORIZATION (both client-facing operations, `driver.compactContext` and
// `session.providerCommandsSubscribe`, at the wire boundary — before the capability gate and before
// any driver dispatch). Neither mints a Cedar action and neither mints an error code.
//   * A session that does not exist is refused the already-registered `session.not_found`.
//   * Any connection that reaches the session may call either one; nothing checks who the caller
//     is (§Authenticated Principal And Authorization Model, run control).
//
// WIRE ADDRESSING. Neither client-facing operation takes a `bindingId`, and the daemon resolves
// the live runtime binding at dispatch. This is not stylistic: no client-facing read publishes a
// `bindingId` anywhere, so a binding-addressed wire request would be unconstructible from every
// response a client can obtain, and a client that somehow held one would be holding a
// daemon-internal lifecycle identifier whose liveness it cannot check.
//
// Each takes the identifier its own authorization and its own consumer already use:
//   * `driver.compactContext` takes a RUN. It mutates that run's provider context, so the run is
//     what it acts on.
//   * `session.providerCommandsSubscribe` takes a SESSION. The `/` list is bound to the session's
//     live provider process, so the daemon follows that process and a new process brings a new
//     list; the client never names an agent, a run or a binding to get it. Every entry still carries
//     the `(driverName, providerAccountId)` it was read under
//     ([Spec-004 §The provider command and skill surface](../../specs/004-provider-driver-contract-and-capabilities.md#the-provider-command-and-skill-surface)).
//
// `driver.compactContext` refuses in a FIXED ORDER, each on an ALREADY-REGISTERED code, so this
// addressing mints none: `session.not_found` (unknown session), then `run.not_found` (no such run, or not one of that session), then
// `driver.unavailable` (no live runtime binding: one was never started, or the process is gone).
// A live binding whose driver lacks the flag still refuses at the capability gate with
// `driver.capability_unsupported`. A caller therefore cannot name another leg's binding
// at all: the class of request the driver-side dispatch check exists to reject is unrepresentable
// on the wire, and that check remains as the daemon-interior backstop rather than as the only one.
interface CompactContextRequest {
  sessionId: SessionId;
  runId: RunId;
}

interface ProviderCommandsSubscribeRequest {
  sessionId: SessionId;
}

// The DRIVER-FACING params, composed by the daemon AFTER that resolution. They stay binding-
// addressed because run -> bindings is 1:many and the operation acts on exactly one leg; they
// cross no wire, and no client constructs one.
interface CompactContextParams {
  sessionId: SessionId;
  // Daemon-resolved at dispatch, the same per-binding addressing goal delivery uses: run ->
  // bindings is 1:many, so the operation names the leg it acts on.
  bindingId: string;
}

// The result of a compaction ATTEMPT, not of the request — a DISCRIMINATED UNION on `status`
//, so no arm can carry a member another arm's state makes meaningless and no
// consumer has to guess which optional members its arm implies. `applied` is reachable only
// after the provider's typed compaction frame is observed, and `boundaryPosition` is REQUIRED
// there, typed `number | null` so a frame carrying no position is representable without being
// synthesized. `refused` means NOTHING WAS SENT;
// `failed` means something was sent and no boundary was witnessed. There is deliberately no
// `capability_undeclared` reason: an undeclared flag refuses at the static capability gate with
// `driver.capability_unsupported` BEFORE the driver is called ([Spec-004 §Required Behavior](../../specs/004-provider-driver-contract-and-capabilities.md#required-behavior)),
// so an arm for it would be a second, contradictory encoding of one refusal.
type DriverCompactionResult =
  | { status: "applied"; boundaryPosition: number | null }
  // `command_absent`: the pre-dispatch presence check on the emulated leg did not find the
  // command in the provider's own enumeration for this binding.
  | { status: "refused"; reason: "command_absent" }
  // `binding_lost`: the run's runtime binding stopped being live (process
  // exit or disposal) before one arrived. `provider_error`: the mechanism itself errored.
  // Every arm records a diagnostic; none is silent, and none can settle `applied`.
  | { status: "failed"; reason: "binding_lost" | "provider_error" };

interface ListProviderCommandsParams {
  sessionId: SessionId;
  bindingId: string;
}

// One enumerated provider command, skill or tool-server prompt. `binding` is not decoration: it is
// the routing key the invariant is enforced on, carried WITH the data so a consumer cannot lose it
// by filtering a held list instead of re-reading. `kind` distinguishes the things published
// under one syntax — a provider's command, a skill, and a working tool server's prompt, which carries
// that server's own name in `server`, the group the list draws it under. `argumentHint` is the
// provider's own hint for what follows the word, present only where the provider publishes one.
// `scope` is present only where the provider declares one (the Codex skills
// surface does, the Claude handshake enumeration does not), so its absence means the provider
// stated no scope rather than that the scope is unknown to the driver. `enabled` follows that same
// present-iff-the-provider-declares-one rule: the Codex `skills/list`
// entry carries an `enabled` Boolean ([Spec-004 §Per-Driver Capability Matrix](../../specs/004-provider-driver-contract-and-capabilities.md#per-driver-capability-matrix)) and the Claude
// handshake enumeration publishes no enabled/disabled distinction at all, so ABSENT means the
// provider draws no such distinction on this surface — never that the entry's state is unknown to
// the driver, and never a driver-synthesized `true`, which would be exactly the fabricated reading
// the verbatim rules elsewhere in this section forbid. The driver DOES NOT FILTER: a disabled entry
// is returned, because dropping it would make the result stop being the provider's enumeration as
// observed, and a consumer would have no way to tell a disabled command from one that does not
// exist. What the flag governs is OFFERABILITY, not presence — an entry whose `enabled` is
// explicitly `false` is not offerable and is rendered unavailable rather than advertised as
// runnable, since the bound provider will not execute it; an absent `enabled` is offerable.
//
// THE LIST IS AN OFFER, NEVER A GATE. Picking an entry puts its own form into the composer: a
// provider's command or a skill as the word it is, a tool server's prompt as that prompt's text
// (read on Codex, which never asks a server for its prompts, through the daemon's own MCP client).
// A word the person types is sent as typed whether or not an entry matches it: a word on no list
// reaches the provider, which answers it as it does in its own terminal, so nothing here refuses
// text for starting with `/` and there is no literal-slash escape. The one entry the driver sends on
// its own is the compaction command, composed by the driver's emulated leg and reached through
// `compactContext`, which checks presence against this same enumeration and settles on typed
// evidence ([Spec-004 §Required Behavior](../../specs/004-provider-driver-contract-and-capabilities.md#required-behavior)).
//
// CHECKED AT THE NORMALIZE BOUNDARY. Every entry is assembled from provider-, skill- and
// tool-server-authored metadata — a local skill file's front matter is the person's to write, a provider
// handshake enumeration is provider-writable, and a tool server's prompt list is the server's.
// `name`, `description`, `scope`, `argumentHint` and `server` are therefore `wireFreeFormString`-checked
// (length + non-whitespace + NUL-rejection) exactly as the other untrusted provider-output strings
// enumerated at the head of this section are. The list carries every entry the provider publishes,
// with no count of the driver's own; the palette draws only the rows in view.
// The binding an enumeration belongs to: the driver, parsed as a `ProviderName`, and the account.
// `providerAccountId` is null where the session has bound no account; absence is stated, never
// synthesized.
interface ProviderCommandBinding {
  driverName: ProviderName;
  providerAccountId: string | null;
}
interface ProviderCommandEntry {
  name: string;
  kind: "command" | "skill" | "prompt";
  description?: string;
  argumentHint?: string;
  scope?: string;
  server?: string; // present iff `kind` is "prompt": the tool server that publishes it
  // Absent = the provider draws no enabled/disabled distinction on this surface. `false` = the
  // provider published the entry AND declared it disabled: returned, never filtered, not offerable.
  enabled?: boolean;
  binding: ProviderCommandBinding;
}

// One binding's enumeration, WHOLE: the driver's read and every emission of the session's
// subscription carry the complete list, never a patch, so a consumer is never handed a delta to
// apply and a new provider process yields a new list rather than an amended one.
interface ProviderCommandListResult {
  binding: ProviderCommandBinding;
  entries: ProviderCommandEntry[];
}

// One emission of `session.providerCommandsSubscribe` (§Running-Command Method Registry below): the
// list of the session's live provider process, whole — on the first frame, on each change the
// provider pushes (Claude Code's `commands_changed`, Codex's `skills/changed`), and again for each
// new process — with each working tool server's prompts.
interface ProviderCommandsUpdate {
  sessionId: SessionId;
  binding: ProviderCommandBinding;
  entries: ProviderCommandEntry[];
}

// The canonical transcript (ADR-027) is a PROJECTION the daemon rebuilds per call and caches
// nowhere; the hand-over brief's one-line notes, its word-for-word tail and its transcript file are
// read from it (Spec-004 §The Canonical Transcript And The Hand-Over Brief). No transcript is
// replayed into a fresh provider session, so no driver operation takes it.
// The daemon-side fold of a run's normalized events into ordered turns (Spec-004 §The canonical
// transcript is a projection, never a store). It never crosses a wire and is never persisted, so
// only its IDENTITY is mirrored here: the per-turn element shape is authored by Plan-003 T3.16 in
// `packages/runtime-daemon/src/provider/transcript/canonical-transcript.ts` and is bounded by the Spec-005 normalized taxonomy,
// which is what makes "anything that never became an event is not in the transcript" true by
// construction rather than by discipline.
interface CanonicalTranscriptProjection {
  sessionId: SessionId;
  runId: RunId;
  // The log position this fold was taken at. Two folds at the same position render identically and
  // one taken after an appended event does not — the projection-not-a-store property, asserted.
  builtAtPosition: number;
  turns: readonly CanonicalTranscriptTurn[]; // element shape owned by Plan-003 T3.16, above
}

interface CreateSessionParams {
  sessionId: SessionId;
  config: Record<string, unknown>;
  executionPosture?: ExecutionPosture; // spawn-time posture — provider legs that bind posture at process spawn (Claude `--settings` sandbox) realize it here; the per-run effective posture rides StartRunParams (Spec-004 §Required Behavior)
  // The REQUESTED accelerated-output mode (Spec-004 §The output-speed axis). Gated on the
  // `output_speed` flag, which both providers declare, and validated against that driver's declared
  // `outputSpeedLevels` BEFORE it reaches the provider — an out-of-vocabulary value refuses with
  // `agent.provider_axis_invalid` rather than reaching the provider. Each provider takes it its own
  // way: Codex as a service tier on thread establishment and again on each turn; Claude Code through
  // `apply_flag_settings {fastMode: true}` between turns, from the next run, with no restart. It rides
  // the create so the first turn already runs at it, and `ResumeSessionParams` re-realizes it below.
  // Requesting it is NOT the same as getting it — what the provider actually declared is observed
  // later as binding-held `ProviderOutputSpeedState`.
  outputSpeed?: string;
  callbackTools?: SessionCallbackTool[]; // daemon-curated callback-tool registry exposed into the session, served on the daemon's one MCP `url` entry per session (Claude Code through `--mcp-config`, Codex as a `url` entry in the conversation's `mcp_servers` at `thread/start`), never Codex `dynamicTools`; gated on the callback_tools flag
  subagentPolicy?: SubagentPolicy; // provider-native in-session subagent policy pass-through under the single-supervisor invariant (Spec-014 semantics); gated on the subagents flag
  outputSchema?: Record<string, unknown>; // normalized JSON Schema constraining schema-constrained final output (Spec-004 §Per-Driver Capability Matrix structured_output); gated on the structured_output flag. The Claude leg binds it per session at spawn (--json-schema); the Codex leg realizes it per turn via StartRunParams.outputSchema (turn/start.outputSchema). Named consumers: Plan-013 orchestration reads
  // Provider-account identity at spawn (Plan-003 T3.41). OPAQUE TO THE DRIVER — never parsed, never used to locate credential material: the
  // driver receives the already-constructed spawn environment, and pinning the account's credential
  // home into it (and denying the ambient names a bound leg must not read) are obligations on the
  // spawn path — Plan-023's fail-closed binding, consumed per CP-003-8 — not properties this member
  // carries. RESOLVED BY THE DAEMON AND NEVER SUPPLIED BY A CLIENT: the daemon resolves exactly one
  // account and stamps it here — the account pinned by the run's saved agent definition or workflow
  // step where one pins, and otherwise the provider's current account, the one carrying the mark on
  // the provider surface when the run starts (§Plan-023 — Provider Accounts And Credential Homes).
  // No wire request carries an account per session or per run, so there is no override to authorize
  // and no client-supplied value to reconcile against the resolution. Spawn-bound because a run's
  // paying account is bound for the run's LIFETIME — `ResumeSessionParams` re-realizes it below from
  // the durable record rather than re-resolving whichever account is current at the resume. Omitting
  // it is the unchanged default path.
  providerAccountId?: string;
  // THIS SESSION'S OWN bound on how many steps one turn may take, carried onto the spawn because one
  // leg realizes it as a start flag (Spec-003 §The Step Bound On A Turn). Absent means
  // the session set no bound of its own, in which case the machine's own Runtime value applies and
  // where that is unset each provider does what it does on its own. The driver carries the number
  // onto its own realization: `--max-turns` on the Claude leg, where the provider enforces it, and
  // the daemon's own per-turn count on the Codex leg, that provider publishing no cap. Spawn-bound
  // like posture and speed, so `ResumeSessionParams` re-realizes it below; reaching the bound ends
  // the turn and then the run, as run.interrupted with trigger "step_limit". It is not a budget.
  maxStepsPerTurn?: number;
  onCallbackToolCall?: (invocation: CallbackToolInvocation) => Promise<CallbackToolResult>; // daemon-injected callback-tool dispatcher; the driver invokes it on a provider callback-tool request and answers the provider with the result. Gated on the callback_tools flag; the daemon-side host routes through Plan-009's Cedar pipeline (CP-003-6 / Plan-009 T2.8). See CallbackToolInvocation below
  onMcpServerStatus?: McpServerStatusProducer; // daemon-injected MCP server-status sink; the driver emits the per-session MCP server-status census (init) + status-change updates through it as typed McpServerStatusEmission values — the closure is pre-bound to the leg identity (sessionId + bindingId) at spawn and stamps them into the consumer-facing McpServerStatusUpdate. Producer-only at Plan-003 — the consumer is Plan-022's status normalizer (§Plan-022 — MCP Governance Contract Surfaces below; Spec-024). See McpServerStatusEmission below
}

interface ResumeSessionParams {
  sessionId: SessionId;
  resumeHandle: string; // opaque provider-owned handle
  // Resume is a FRESH process spawn (the C-12 posture-relaunch precedent), so every spawn-bound
  // surface CreateSessionParams binds must re-realize here or the resumed leg silently sheds it —
  // a posture-less resume relaunches UNSANDBOXED, a schema-less one unconstrained. The DATA legs below are
  // reconstructed by the daemon from the durable
  // runtime_bindings.spawn_config record (written at every spawn; Plan-003 T1.7) — never from the
  // original client request, which recovery does not have; the two FUNCTION legs are re-injected
  // fresh at every spawn (functions are never stored in spawn_config).
  executionPosture?: ExecutionPosture;
  // The requested mode, re-realized on the fresh process. It is a reconstructed leg of
  // spawn_config for exactly the reason posture is: a speed-less resume relaunches at the
  // provider's default while `agents.output_speed` still records the person's accepted choice,
  // which is the silent-shedding failure this list exists to prevent. What the relaunched process
  // declares is observed as binding-held `ProviderOutputSpeedState` (the reason is
  // given on `ProviderSessionHandle` below), never returned on `DriverResumeResult`,
  // so a mode that stops being available across a restart surfaces as an observation rather than
  // as a stale request.
  outputSpeed?: string;
  callbackTools?: SessionCallbackTool[];
  subagentPolicy?: SubagentPolicy;
  outputSchema?: Record<string, unknown>; // the Claude leg re-binds per session at spawn (--json-schema); the Codex leg realizes per turn via StartRunParams.outputSchema
  // A reconstructed data leg (T3.41) — the one whose silent shedding is a BILLING fault
  // rather than a capability one: a resume that re-resolved "whichever account is current now"
  // would move a live run's spend onto an account it was never admitted against, mid-run, with the
  // receipt's per-paying-account key still claiming the original. Moving the current account moves a
  // live SESSION in place at its next request, the cost splitting at the provider's acknowledgment —
  // never by re-resolving this stamp at a resume. The session's own total keeps counting across that
  // move: the requests before it stay under the account they ran on, the requests after it under the
  // new one, and the receipt carries both as account rows summing to one total.
  // Read back from the durable
  // `runtime_bindings.spawn_config` record written at the original spawn — never re-resolved, and
  // never re-supplied: no wire request carries an account, and recovery holds none to take one from.
  // Same opacity rule as on `CreateSessionParams` above.
  providerAccountId?: string;
  // A reconstructed data leg: a resume that dropped the session's own step
  // bound would relaunch the Claude leg without `--max-turns` while the session record still holds
  // the number the person set, which is the silent shedding this list exists to prevent. Read back
  // from `runtime_bindings.spawn_config` like its siblings, never re-read from the session record at
  // the resume, so a bound changed mid-run reaches the next turn rather than the relaunch.
  maxStepsPerTurn?: number;
  onCallbackToolCall?: (invocation: CallbackToolInvocation) => Promise<CallbackToolResult>; // re-injected dispatcher — an omitted rebind would strand provider callback-tool requests unanswered on the resumed leg
  onMcpServerStatus?: McpServerStatusProducer; // re-injected census sink, pre-bound to the resumed leg's identity — the resumed leg re-emits its init census through it
}

interface StartRunParams {
  runId: RunId;
  agentConfig: Record<string, unknown>;
  conversationHistory?: unknown[];
  executionPosture?: ExecutionPosture; // per-run effective posture — the same object the daemon stamps on run.running (Spec-005 §Run Lifecycle). Codex realizes per-turn (turn/start sandbox params); a provider that binds posture at spawn realizes it at session boundaries, and a mid-session posture change on such a leg resolves via session relaunch, never silent partial application (Spec-004 §Required Behavior)
  outputSchema?: Record<string, unknown>; // per-turn schema-constrained final output (Codex turn/start.outputSchema); the Claude leg binds it at spawn via CreateSessionParams.outputSchema (--json-schema). Gated on structured_output (Spec-004 §Per-Driver Capability Matrix)
}

interface InterruptRunParams {
  runId: RunId;
  reason?: string;
}

// Discriminated union over `type` — each intervention type coupled to its payload
// shape. `expectedRunVersion` is the MANDATORY fail-closed comparand (Plan-002
// D-002-2) repeated on every arm — absent value rejected, never applied.
// `clientIdempotencyKey` is the MANDATORY requester-generated UUID (Spec-004 §Required
// Behavior): the daemon dedupes on it (replay-or-conflict), and it rides
// through to the driver so provider-remote invocations that honor dedupe keys receive
// it (the `compensable` propagation pattern, Spec-004 §Tool Metadata). Same field set
// as the steer / interrupt / cancel arms of the InterventionRequestPayload union below; its fourth arm,
// `faster_model_retry`, never reaches the driver, because the daemon carries it out. Undo is not
// an intervention: it is `session.restore`, whose conversation leg reaches the driver through
// `rewindConversation` ([Spec-013 §Interfaces And Contracts](../../specs/013-persistence-recovery-and-replay.md#interfaces-and-contracts)).
type ApplyInterventionParams =
  | {
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: SteerPayload;
    }
  | {
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: InterruptPayload;
    }
  | {
      type: "cancel";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      payload: CancelPayload;
    };

// The ATTACHMENT-CARRIER contract, stated once here and cited from the InterventionRequestPayload
// `steer` arm in §Plan-002. The element type is ArtifactId — an id into Spec-012's manifest space, never an
// untyped element and never an inline byte payload; caller bytes enter through the
// boundary-validated ingest paths instead. [Spec-012 §Required Behavior](../../specs/012-artifacts-files-and-attachments.md#required-behavior) states that encoding
//: an RFC 9562 UUID the daemon mints at manifest creation, carried distinctly from the
// payload's SHA-256 digest — which is what makes an element REFUSABLE at this parse boundary rather
// than only at resolution time. Caller-declared ORDER is preserved end to end, and an
// element the turn cannot resolve or deliver surfaces as an explicit cause-bearing unresolved marker
// IN ITS DECLARED POSITION — silently dropping it is prohibited (Plan-011 I-011-5, Spec-012
// §Fallback Behavior). Neither property is a parse concern; what the untyped arm could not do at all
// was carry an id a resolver could look up, so the rule had nothing to attach to and CP-011-1 made
// the retyping a PREREQUISITE of the first change that wires delivery through this carrier.
// The carrier sets no count bound of its own: how many files a message carries is what the daemon and the
// provider accept, and a provider that will not take one refuses in its own words. The brand is
// homed with its earliest-shipping consumer per Plan-003 CP-003-5 — this payload — and every later
// consumer imports it (`packages/contracts/src/provider-driver.ts#ArtifactIdSchema`); Plan-011 Task 1
// imports rather than restates, so no second definition of an artifact id exists.
interface SteerPayload {
  content: string;
  attachments?: ArtifactId[];
  expectedTurnId?: string;
}

interface InterruptPayload {
  reason?: string;
}

interface CancelPayload {
  reason?: string;
}

interface DriverInterventionResult {
  status: "applied" | "degraded"; // the complete driver-level vocabulary — `rejected` / `expired` are orchestration-layer verdicts rendered around driver dispatch, never driver-returned (Spec-004 §Required Behavior; normative mapping in queue-and-intervention-model.md §Driver Result To Lifecycle Mapping)
  fallbackAction?: string; // e.g. 'queue_and_interrupt' for degraded steer
}

// The conversation FORK: the provider leg of `session.fork`, which mints a new session of the same
// shape carrying history up to and including a message while the source keeps running untouched
// ([§Plan-001 — Session Core](#plan-001--session-core)). The driver starts a new provider
// conversation from the source's history at that message and never writes to the source; each
// provider's mechanism is Spec-004's. It is never a rollback: undo cuts the conversation IN PLACE
// through `rewindConversation`.
interface ForkConversationParams {
  sessionId: SessionId;
  position: number; // the normalized session position of the message the fork carries history up to and including (the vocabulary `DriverResumeResult.sessionPosition` reports); the driver maps it to its provider's own anchor
  bindingId: string; // the SOURCE leg — the run's live runtime binding, daemon-resolved at dispatch (run→bindings is 1:many, so `sessionId` alone cannot name it); no client payload carries it
}

type ForkConversationResult =
  // `sessionPosition`: the driver-confirmed position the forked conversation ends at. `bindingId`:
  // the binding the forked conversation runs on — the store-minted surrogate of a binding row
  // registered through the relaunch pattern's write seam before the result returned, never itself a
  // resume handle; runtime-bounded (length + non-whitespace + NUL-rejection) like
  // `DriverResumeResult.bindingId`, per the trust-boundary enumeration above.
  | { status: "applied"; sessionPosition: number; bindingId?: string }
  | { status: "degraded"; fallbackAction?: string };

// The conversation CUT is `rewindConversation`: undo's conversation leg, in place on the run's own
// live runtime binding, reached through `session.restore` with a scope that includes the
// conversation. It targets a message identity, never a numeric or provider position; any position
// the provider needs stays inside the driver. Files are never the driver's: they are the daemon's
// per-session file checkpoint store ([Spec-013 §Required Behavior](../../specs/013-persistence-recovery-and-replay.md#required-behavior)).
// `run.rolled_back` records the cut. Its parameter and result shapes and each provider's mechanism
// are daemon-internal ([Spec-004 §Interfaces And Contracts](../../specs/004-provider-driver-contract-and-capabilities.md#interfaces-and-contracts)).

// Goal delivery. A goal is a command sent to one agent, never what the session is: `goalText` is the
// condition the person typed after `/goal` (not blank, no NUL, no length cap of the app's own), sent to the
// agent the command targets. Codex leg: `thread/goal/set` / `thread/goal/clear` (the `objective`
// field), live. Claude Code leg: its own `/goal <condition>` and `/goal clear`, sent as user
// messages. Neither leg writes goal text into a system prompt. The provider checks the goal each
// time the agent would stop, and the daemon folds what each provider reports into
// `session.goal_updated`, whose status is one of `active`, `paused`, `blocked`, `usage-limited`,
// `budget-limited`, `complete` or `impossible` (`complete` and `impossible` are final; only Claude
// Code sends `impossible`, with its reason); clearing is `session.goal_cleared`, never a status
// (Spec-005; [Spec-014 §Session Goals](../../specs/014-multi-agent-orchestration.md#session-goals)).
// Durable truth is those events; driver-held state is never the recovery source.
interface SetSessionGoalParams {
  sessionId: SessionId;
  // Leg addressing: the goal goes to the target agent's live binding, and `run` → bindings is 1:many
  // in the store (store-minted surrogate ids; e.g. a posture relaunch mints a new binding for the
  // same run) — so the BINDING is the leg key. The driver resolves its provider session from the
  // binding it established at createSession/resumeSession (DriverResumeResult already returns
  // bindingId); runId rides along for run-scoped context and telemetry.
  bindingId: string;
  runId: RunId;
  goalText: string;
}

interface ClearSessionGoalParams {
  sessionId: SessionId;
  bindingId: string; // leg key — the same leg addressing as SetSessionGoalParams
  runId: RunId;
}

type DriverGoalResult =
  // `applied` = the provider took the goal for the target agent (both V1 legs deliver it natively) —
  // a fallback narrative on a successful application is unrepresentable.
  | { status: "applied" } // success carries no fallback field
  | { status: "degraded"; fallbackAction?: string }; // the provider did not take the goal

// Return shape of `ProviderDriver.resumeSession()`. Discriminated union over `status`
// makes silent-replacement structurally inexpressible: the failure variant has no
// `bindingId`, so a successful resume cannot be conflated with a failed one. Spec-004
// §Fallback Behavior requires that resume failure "surface `provider failure` detail and
// a visible `recovery-needed` condition; it must not silently create a replacement provider
// session under the same canonical run." The `resumed` variant's REQUIRED `sessionPosition`
// is the driver's normalized monotonic position — turn/event ordinal, the same
// number-cursor convention as `lastReplayedSequence`/`afterSequence` below — which the daemon
// compares against its recorded position; divergence reconciliation (halt-for-human, rollback
// markers as the position floor) is Spec-013's, per ADR-016's
// rule that the local log is authoritative. The compare also catches a provider silently returning a
// fresh session on resume (e.g. Claude on a working-directory mismatch): a fresh session's
// position cannot match the recorded one. Timestamps for the resumed case live on
// `runtime_bindings.updated_at` (Plan-003 T2.1); the result shape carries only the
// discriminated-union semantic payload.
type DriverResumeResult =
  // NO `outputSpeedState` MEMBER, and its absence is deliberate rather than
  // an omission: a resume is a fresh spawn, so it has exactly the defect `ProviderSessionHandle`
  // does — the declaring handshake is turn-bearing, and this result resolves before any turn-bearing
  // exchange on the relaunched process. The declared state is observed later, as the binding-held
  // state `ProviderOutputSpeedState` below defines.
  | {
      status: "resumed";
      bindingId: string;
      sessionPosition: number;
    }
  | {
      status: "failed";
      recoveryCondition: RecoveryCondition;
      providerFailureDetail: string;
    };

// Named once, referenced at every carrying surface: REQUIRED form on `DriverResumeResult.failed` above; optional form
// on `RunStateChangeEvent` and `RecoveryStatusReadResponse.sessions[]` below. `recovery-needed` = generic, the person must
// reconcile. `reauth-required` = the provider session or credential expired (detected mid-run
// via the provider's typed auth-failure signals or at resume/probe time); remediation is
// re-authenticating the provider CLI on the runtime node, after which recovery may retry
// (Spec-004 §Fallback Behavior). A structurally invalid history is neither: the driver throws a permanent
// structural refusal carrying `freshSessionRequired: true`, never retried, and the session continues in a
// fresh provider session started from the hand-over brief (Spec-004 §Required Behavior).
type RecoveryCondition = "recovery-needed" | "reauth-required";

// Typed provider usage-limit signal (Plan-003 T3.40). A SIBLING AXIS beside `RecoveryCondition` above, never a member of it — that axis
// names why a run needs the person; this one names a provider-stated allowance state, minted here
// and scoped per-account by Plan-023 keying on `(accountId, credentialGeneration)` (CP-003-7 ⇄
// CP-023-2). Recognition is TYPED-ONLY (I-003-6): each driver leg keys on a structured provider
// event it can name — never message prose, an exit code, or a bare HTTP status — and an
// unrecognized shape emits NOTHING, an absence that reads "not known to be limited", never "known
// not to be limited". Deliberately nominal at the driver seam rather than Zod-schema'd: `cause`
// and `provenance` are closed literals the driver SELECTS and `resetsAt` is a timestamp the
// driver COMPOSES, so no member is provider-verbatim and a schema over them would validate the
// driver against itself (the provider-verbatim shapes above are schema'd for exactly the opposite
// reason).

// One cause, plan-allowance exhaustion. The neighbor conditions (Codex workspace/member credit depletion and the Codex
// spend-control ceiling, Claude billing faults) are account-plane or payment facts rather than
// plan-allowance exhaustion, each named in the contracts file rather than absorbed here.
type ProviderUsageLimitCause = "plan-allowance-exhausted";

// Whether the reset instant is the provider's own statement or the runtime's derivation, so a
// consumer can tell the two apart. Primary sources, per the AGENTS.md citation standard: the
// Codex leg stamps provider-stated off the published rate-limit shapes — the
// `account/rateLimits/read` pull + `account/rateLimits/updated` push pair the provider-wire
// reference family's codex file records (Generated schema, Verified at the codex-cli 0.150.1
// pin), consumed by the shipped codex event-normalizer's push row. The Claude leg stamps
// runtime-derived because no Claude surface states a reset instant: the arithmetic is
// observation time plus the `api_retry` frame's own `retry_delay_ms`, emitted only on the
// final announced retry beside the typed `rate_limit` error member — the mid-session retry
// taxonomy the provider-wire claude file records (Binary probe, Verified at Claude Code
// 2.1.245). The sibling-axis rule and typed-only recognition are `Spec-004 §Fallback
// Behavior`'s.
type ProviderUsageLimitResetProvenance = "provider-stated" | "runtime-derived";

interface ProviderUsageLimitResetBoundary {
  resetsAt: string; // RFC 3339 UTC — the encoding `WorkflowStep.resumeAt` already consumes
  provenance: ProviderUsageLimitResetProvenance;
}

// The signal itself. The BOUNDARY IS OPTIONAL AND THE CAUSE IS NOT: a limit can be recognized
// with no reset instant to report, but never without a cause — and carrying `resetsAt` and
// `provenance` inside one shape makes "an instant with no provenance" and "a provenance stamp
// with no instant" both inexpressible.
interface ProviderUsageLimitSignal {
  cause: ProviderUsageLimitCause;
  resetBoundary?: ProviderUsageLimitResetBoundary;
}

interface RespondToRequestParams {
  runId: RunId;
  requestId: string;
  response: unknown;
}

interface OverrideDenialParams {
  sessionId: SessionId;
  // The provider's own denial the daemon kept with the block: Claude Code's action as its
  // `PermissionDenied` hook received it, or Codex's review as Codex sent it.
  providerDenial: unknown;
}

interface CloseSessionParams {
  sessionId: SessionId;
}

// NO `outputSpeedState` MEMBER. This is the driver-constructed RETURN of `createSession`, which
// resolves before `startRun` can begin the first turn-bearing exchange, and `Spec-004 §Detection
// source is static` establishes that the handshake declaring the speed state is emitted only as
// part of such an exchange. A member here could therefore never be populated on any path, and a
// structurally always-absent member is a field minted ahead of its producer — the ground on
// which a capability flag with no reader is not shipped. The observation is
// binding-held state instead; see `ProviderOutputSpeedState` below.
interface ProviderSessionHandle {
  providerSessionId: string;
  resumeHandle: string;
}

// The provider's own report — never a probe of its own and never synthesized from the request
//. IT IS BINDING-HELD DRIVER-SESSION STATE, NOT A SPAWN RETURN.
// The declaring handshake is emitted only as part of a turn-bearing exchange (`Spec-004 §Detection
// source is static`), so neither `createSession` nor `resumeSession` can carry it: both resolve
// before the first such exchange, and neither may spend a synthetic turn or block waiting for one.
// The driver therefore records the state against the binding WHEN THE HANDSHAKE ACTUALLY ARRIVES,
// on the first turn-bearing exchange the user's own work produces, and holds it for the
// binding's life — the same held-state shape `listProviderCommands` already uses. Until then the
// binding HAS NO OBSERVATION, and every reader of it is absent-until-observed rather than defaulted.
// READ AND DISCARDED WITH THE SESSION: it is deliberately NOT written to `runtime_bindings.spawn_config`, which records
// what was REQUESTED so a resume can re-realize it, and not to `agents.output_speed`, which
// records the person's accepted choice. Persisting an observation into either would create a
// second, staler record of a fact the live session already holds — and would make a mode that
// stopped being available look accepted after a restart. It reaches clients as a LIVE-SCOPED
// projection on `AgentListResponse.agents[]`, present only while the binding it was read on is
// live.
//
// `declared` is carried VERBATIM and is deliberately not narrowed to `outputSpeedLevels`: that
// vocabulary bounds what a caller may REQUEST, while this is what the provider REPORTED, and a
// provider that returns a level the driver's table does not list is reporting a real state under
// version skew — coercing it to `off` would fabricate exactly the false reading this member
// exists to prevent. `reason` is the provider's own explanation, present only where the provider
// supplied one; its absence means the provider gave no reason, never that there was none. Both
// strings are provider-authored and `wireFreeFormString`-bounded per the head of §Plan-003.
interface ProviderOutputSpeedState {
  declared: string;
  reason?: string;
}

interface ProviderModel {
  id: string;
  name: string;
  capabilities: string[];
  effortLevels?: string[]; // per-model reasoning-effort vocabulary, copied verbatim from the provider's own catalog read — the lists differ per model WITHIN one provider, so there is no provider-wide list (Spec-004 §Provider Parameter Vocabularies); absent = the model exposes no effort selection
}

interface ProviderMode {
  id: string;
  name: string;
}

// Effective sandbox/permission posture (shape owned by Spec-004, policy semantics by Spec-010 §Required
// Behavior). Referenced by RunStateChangeEvent.executionPosture? (the run.running
// audit stamp) and by CreateSessionParams/StartRunParams (the spawn/turn carriers).
// This is what a DRIVER APPLIES, not what a person chooses: a person chooses one of the five
// permission levels, the posture carries that level verbatim as its `mode` (`ExecutionPostureMode`
// in §Shared Enums), and each driver resolves it into the network and filesystem composition below
// against its own provider's modes, per Spec-010 §Required Behavior. The level-to-provider-mode
// realization is each driver's, recorded per driver in Spec-010 §Required Behavior; no table here
// restates it, and the posture carries no vocabulary of its own beside the level.
type ExecutionPostureNetwork =
  | { networkAccess: "none" | "full"; allowedDomains?: never } // allowedDomains structurally absent
  | { networkAccess: "allowed-domains"; allowedDomains: [string, ...string[]] }; // non-empty by construction (Spec-010 cross-field invariants, fail closed)

type ExecutionPosture = ExecutionPostureNetwork & {
  mode: ExecutionPostureMode; // the session's permission level (§Shared Enums) — the only posture vocabulary in the product (Spec-010 §Required Behavior)
  writableRoots: string[];
  profileName?: string;
  credentialPolicyRef: string; // a plain reference naming the credential deny list the daemon handed the provider — REQUIRED on every run. The provider's own rule enforces the list (Claude Code's deny rules hold in every permission mode; Codex's filesystem denies hold wherever its sandbox runs, which Full Access does not) (Spec-010 §Required Behavior).
};

// Daemon-curated callback tool exposed into a session (authorization semantics
// Spec-010). Mirrors the function-form provider tool shape (name + description +
// JSON-Schema input) — served on the daemon's one MCP `url` entry per session (Claude Code
// through `--mcp-config`, Codex as a `url` entry in the conversation's `mcp_servers` at
// `thread/start`), never Codex `dynamicTools`; Claude Code surfaces the tools as
// `mcp__<server>__<tool>`. Every invocation flows through the daemon's approval pipeline and
// lands as an ordinary `tool_activity` row (Spec-005). Daemon-constructed and daemon-trusted —
// never provider output.
interface SessionCallbackTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema for the tool's arguments
}

// Callback-tool dispatch seam (Plan-003 T1.8 / T3.15 leg 3). The daemon injects
// `onCallbackToolCall` at spawn (CreateSessionParams above); when the provider issues a callback-tool
// request (a tool call on the daemon's MCP `url` entry, from either provider), the driver translates the wire request
// into a `CallbackToolInvocation`, invokes the injected dispatcher, and answers the provider with the
// `CallbackToolResult` — no invocation is left unanswered, no approval bypass invented. The daemon-side
// dispatcher is Plan-003's callback-tool host (`provider/callback-tool-host.ts`), routing every
// invocation through Plan-009's Cedar approval pipeline by the daemon's own approval service — the
// in-process request create that `approval.requestCreate` names, which the daemon raises from a
// provider callback and no client calls (CP-003-6 covers driver-host permission callbacks) —
// Plan-003 authors no Plan-009 symbols — and landing the outcome as an ordinary `tool_activity` row. `CallbackToolInvocation` is normalized
// at the driver boundary from untrusted provider output; `CallbackToolResult` is daemon-constructed
// and trusted. Fail-closed availability: exposure is keyed on the daemon's approval service, not on
// any wire registration. While that service is not running, spawn WITHHOLDS the callbackTools
// registry (tools not exposed) and the host's runtime backstop answers any stray invocation `denied`
// + a DriverDiagnosticRecord — never `completed` without Cedar, never unanswered; the allow path
// opens once Plan-009's approval service runs (CP-003-6).
interface CallbackToolInvocation {
  toolName: string; // untrusted provider output — wireFreeFormString-bounded (the trust-boundary header's string enumeration); resolved against the session's registered SessionCallbackTool set, and an UNKNOWN name answers `failed` without dispatch
  arguments: Record<string, unknown>; // validated against the registered tool's inputSchema BEFORE any Cedar round-trip — schema-invalid arguments answer `failed` without dispatch, so malformed provider output never reaches the approval pipeline
  toolCallId: string; // untrusted provider correlation id — wireFreeFormString-bounded, copied verbatim onto the answered result (tool-event pairing is exact-string match)
  sessionId: SessionId;
  runId: RunId;
}
type CallbackToolResult =
  | { status: "completed"; output?: unknown; error?: never }
  | { status: "denied"; output?: never; error?: string }
  | { status: "failed"; output?: never; error?: string };

// MCP server-status producer seam (Plan-003 T1.8 / T3.13). Producer-only: the daemon
// injects `onMcpServerStatus` at spawn (CreateSessionParams above); the driver emits the per-session MCP
// SERVER inventory (name + status) at init plus status-change updates through it — never an untyped
// record. Servers only, never a per-server tool-list assumption (support is not visibility, Spec-004
// §Per-Driver Capability Matrix). Driver telemetry surface: nothing is persisted,
// so no table is created. The consumer is Plan-022's status normalizer (Spec-024 — §Plan-022 — MCP Governance Contract Surfaces below); consumer semantics live there.
type McpServerStatus = "unknown" | "starting" | "connected" | "needs-auth" | "failed";
// Driver-emitted shape: serverName + status ONLY. The driver NEVER supplies leg identity — the daemon
// pre-binds the injected producer closure to the leg at spawn (sessionId + the store-minted bindingId,
// pre-minted before the spawn per the relaunch write-seam pattern), so a driver cannot misattribute —
// or spoof — another leg's rows, and the init census emitted DURING createSession needs no id the driver
// does not have. `serverName` is untrusted provider/CLI output — wireFreeFormString-
// bounded at the driver normalization seam (the string enumeration above) before it reaches the
// producer.
interface McpServerStatusEmission {
  serverName: string;
  status: McpServerStatus;
}
// Daemon-stamped consumer-facing record (what the Plan-022 status normalizer reads): the pre-bound
// producer closure stamps the leg identity onto every emission.
interface McpServerStatusUpdate {
  sessionId: SessionId;
  bindingId: string; // leg key — daemon-stamped from the injection context, never driver-supplied; run→bindings is 1:many (the SetSessionGoalParams.bindingId precedent), so statuses key per (binding, server): a relaunched leg's fresh census supersedes its OWN predecessor without clobbering a concurrent live leg's rows
  serverName: string;
  status: McpServerStatus;
}
type McpServerStatusProducer = (emission: McpServerStatusEmission) => void;

// Provider-native in-session subagent policy (orchestration semantics Spec-014). Single-supervisor invariant: the daemon is the only cross-session supervisor —
// provider subagents run in-session only, their usage aggregates into the run's own budgets, and
// their tool calls flow through the same approval pipeline. `maxConcurrent` is the person's
// `Helpers at once` for that provider: absent, the default, is no limit, and the daemon lifts the
// provider's own built-in limit; `0` runs none, and the daemon withholds the provider's helper tool;
// any other number N is passed as Codex's own limit, `features.multi_agent_v2.max_concurrent_threads_per_session` set to N + 1,
// because Codex counts the lead among those threads (its helper limit is that setting minus one), and
// on Claude Code, which has no such setting, the daemon's pre-tool hook on the Agent tool holds a new helper's start
// until one of that session's running helpers finishes.
// There is no ceiling of the app's own (Spec-004 §Parity Capability Mechanism Grades; Spec-014
// §Provider-Native Subagents).
type SubagentPolicy =
  // Discriminated on `enabled`: a disabled policy carries no limits or definitions —
  // "off but configured" is unrepresentable; the daemon sends the full arm on enable.
  | { enabled: false }
  // Both limit members are OPTIONAL and neither is the daemon's own. The daemon sets no depth and
  // no concurrency ceiling of its own: `maxDepth` carries the person's own provider setting where
  // they have set one and is absent where they have not, and `maxConcurrent` reads as above. The
  // provider's own nesting limit is what bounds
  // the tree, and where the provider refuses a level its refusal is shown in the provider's words.
  // A driver passes each member through as it stands and clamps nothing — a driver-side ceiling
  // would refuse what neither the person nor the provider bounded
  // (Spec-014 §Provider-Native Subagents).
  | {
      enabled: true;
      maxDepth?: number;
      maxConcurrent?: number;
      definitions: SubagentDefinition[];
    };

// Unified per-subagent definition the driver maps onto its provider form (Claude Code's --agents
// entries; Codex [agents] config). Fields beyond `name` are optional — each leg maps
// what its provider supports and ignores the rest (tolerant mapping, graded on the matrix).
interface SubagentDefinition {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  effort?: string;
  maxTurns?: number;
}

// Driver transport configuration — a daemon driver-registry config surface, not
// an RPC payload. V1: the Codex driver only (app-server --listen unix://|ws://, config-gated,
// off by default); the Claude CLI exposes no local listener, and no provider process is reached
// from another machine: another device drives the session through the daemon. `bearerTokenRef` is a
// daemon-config reference to the ws bearer credential — a reference, never the secret value
// (the credentialPolicyRef ref-not-value pattern).
type DriverTransportConfig =
  | { transport: "stdio" } // the V1 default — no local listener, no endpoint
  | { transport: "unix-socket"; endpoint: string } // unix:// URL, REQUIRED
  // ws:// URL + bearer credential reference, both REQUIRED — an unauthenticated ws listener is unrepresentable:
  | { transport: "websocket"; endpoint: string; bearerTokenRef: string };

interface DriverCapabilities {
  flags: Record<DriverCapabilityFlag, boolean>;
  contractVersion: string; // change-detection signal, not negotiation: recorded at daemon start, compared on each refresh to invalidate capability snapshots; the daemon never version-gates behavior on it (Spec-004 §Default Behavior)
}

// Per-tool idempotency classification used by the daemon's two-phase command-receipt
// protocol during crash recovery (Spec-004 §Tool Metadata; Spec-013 §Idempotency
// Protocol).
type IdempotencyClass = "idempotent" | "compensable" | "manual_reconcile_only";

// Durable MCP Tasks recovery handle (Plan-003 T5.1). A task-augmented MCP call under MCP 2025-11-25's
// experimental Tasks utility carries a receiver-generated `taskId` (from the `CreateTaskResult`
// acceptance response). It is NOT a new RPC payload: the daemon persists it on the receipt as the
// additive nullable `command_receipts.mcp_task_id` column (Plan-003 EXTENDs Plan-002's table per
// cross-plan-dependencies.md; DDL in local-sqlite-schema.md §Queue and Intervention Tables —
// bounded ≤256 code points + non-empty + NUL-reject: the id is untrusted remote-peer output, and
// the write seam mirrors it). That column is the durable handle Spec-013 recovery reads to poll
// `tasks/get` + `tasks/result` instead of halting the `manual_reconcile_only` floor; NULL until the
// receiver accepts — a crash before that leaves the halt intact (Spec-004 §Recovery Consequences).

// INGRESS shape — what a provider driver DECLARES via `getCapabilities()`. `idempotency_class`
// is OPTIONAL: a driver MAY omit it and an undeclared class is NOT a contract violation. Were the
// field required here, Zod would reject a conformant-but-silent driver at ingress BEFORE the
// default could apply — defeating Spec-004 §idempotency_class. The daemon's capability-normalization seam
// (Plan-003 T2.4 hydration) resolves an omitted class to `manual_reconcile_only` (the conservative
// default per Spec-004 §idempotency_class), producing a `NormalizedProviderToolMetadata`.
interface ProviderToolMetadata {
  name: string;
  idempotency_class?: IdempotencyClass;
  description?: string;
}

// NORMALIZED shape — the daemon-side projection AFTER the normalization seam has applied the
// `manual_reconcile_only` default. `idempotency_class` is REQUIRED, so the type system forbids
// persisting an un-normalized value into the NOT NULL `driver_tools.idempotency_class` column.
// This is the only tool-metadata shape that crosses the persistence boundary; ingress
// `ProviderToolMetadata` never does.
interface NormalizedProviderToolMetadata {
  name: string;
  idempotency_class: IdempotencyClass;
  description?: string;
}

// CLI-version report: two facts. `rawVersion` is the verbatim provider-printed version string,
// always present (untrusted provider output on the nominal `GetCapabilitiesResult` return — bounded at
// the Plan-003 write seam like `contractVersion`, not the Zod trust boundary); `parsedVersion` is the
// driver-parsed MAJOR.MINOR.PATCH, present only when the printed version parses. Nothing writes
// `"unknown"` as a version. The minimum-version check runs only on a parsed version, against the
// per-driver minimum Spec-004 §Required Behavior states (a pin is cited from the provider-wire
// reference family, and neither is restated here): a parsed version below it refuses as
// `driver.cli_version_below_floor`, and a provider whose printed version the parser cannot read
// still runs. Both values are read from the version the SPAWNED process reports in-band, not from
// a launcher symlink.
interface DriverCliVersionReport {
  rawVersion: string;
  parsedVersion?: string;
}

// Zero-turn authentication probe result. Zod `.strict()` — a result
// envelope rejecting unknown keys, correct for an internal owned contract paired with
// contract versioning. The probe feeds the account's sign-in reading, never a check before a
// session starts: a start runs, and a real sign-in failure arrives as the provider's own refusal.
// `indeterminate` (probe surface unavailable or unparseable) stays distinguishable so the person
// can tell probe health from credential state, and it never refuses a start (Spec-004 §Required
// Behavior). Mid-run credential expiry is a different surface: the
// provider's typed auth-failure signals map to RecoveryCondition 'reauth-required'.
interface DriverAuthProbeResult {
  status: "authenticated" | "unauthenticated" | "indeterminate";
  detail?: string; // provider-reported account/plan detail (untrusted free-form, bounded)
}

// Return type of `ProviderDriver.getCapabilities()`. Spec-004 §Tool Metadata semantically
// separates whole-driver capability flags from per-tool metadata; the wrapper keeps
// `DriverCapabilities` pure (flags + contractVersion only) while still carrying both
// surfaces in a single round-trip. Precedent: MCP separates `initialize`
// server capabilities from `tools/list`; LSP separates `ServerCapabilities` from
// registered tool surfaces. `cliVersion` is REQUIRED and always carries the printed version;
// its parsed form is present only where the version parses.
interface GetCapabilitiesResult {
  capabilities: DriverCapabilities;
  tools: ProviderToolMetadata[];
  cliVersion: DriverCliVersionReport;
  // Per-flag provenance of the reading above (Spec-004 §Required Behavior). `probed` means decided against the installed
  // build by a zero-turn probe whose negative control still refused; `static` means declared
  // from the driver's own per-driver table, which Spec-004 admits only where the flag has no
  // ADMISSIBLE probe -- zero-turn, non-mutating, and decisive at the consumed granularity --
  // and requires the mechanism table to name the conjunct that fails. Sibling of `cliVersion` for the same reason `cliVersion` is
  // one: it is a property of THIS reading, not of a capability, so `DriverCapabilities` stays
  // pure (flags + contractVersion). ADDITIVE-OPTIONAL and LIVE-SCOPED, not required — present
  // and TOTAL over the flag set whenever the wrapper is a live driver read; absent exactly
  // when it was reconstructed by `DriverCapabilitiesWriter.hydrate()` from the durable cache,
  // which persists flag VALUES for change detection and NOT provenance (so no column is
  // minted, and a required member would be unsatisfiable on that path). Absence therefore
  // reads as "cache reconstruction", never as "unknown provenance" — a consumer that needs
  // provenance re-reads the driver. Driver-side only: deliberately NOT carried on the client-facing
  // `driver.listCapabilities` payload, which this member does not widen. The client-facing `driver.*`
  // set is `driver.listModes`, `driver.listModels`, `driver.listCapabilities` and
  // `driver.compactContext`, documented in the Plan-005 namespace registry under CP-005-5. Each
  // reads the driver or acts on an already-existing session, and none establishes, restores, starts,
  // or tears a session down; every other operation above is daemon-internal, and the session's `/`
  // list reaches a client as `session.providerCommandsSubscribe` (§Running-Command Method Registry).
  detectionSource?: Record<DriverCapabilityFlag, CapabilityDetectionSource>;
  // The output-speed axis's VALUE VOCABULARY (Spec-004 §Provider Parameter
  // Vocabularies + §The output-speed axis). Present iff `capabilities.flags.output_speed` is
  // `true`; absent or empty means the axis is unsettable and an `agent.configUpdate` carrying
  // `outputSpeed` refuses fail-closed rather than forwarding an unvalidated value.
  // STATICALLY DECLARED from the same per-driver table the `output_speed` flag itself comes
  // from, and never read from the provider: obtaining the provider's declared speed state costs
  // a turn-bearing request, which is exactly the conjunct that makes that flag `static`, so a
  // vocabulary sourced by reading would contradict its own detection source. Unlike
  // `detectionSource`, this member IS served on the client-facing `driver.listCapabilities`
  // payload — its reader is a client control that must offer the choice set, the same reason
  // `ProviderModel.effortLevels` travels to the client that renders the effort selector. The
  // values themselves are the provider's own; this contract names none of them.
  //
  // PRESENT ON BOTH READ PATHS, and that is a consequence of being static rather than a second
  // rule. Because the vocabulary is a property of the DRIVER, not of a reading, the
  // wrapper carries it identically whether it was built by a live `getCapabilities()` call or
  // reconstructed by `DriverCapabilitiesWriter.hydrate()` — the hydrating path re-derives it from
  // the same per-driver table the live path reads, so nothing has to survive the durable cache.
  // This is exactly why it does NOT follow `detectionSource` into absence-on-hydrate: that member
  // is a fact about one reading and cannot be re-derived, while this one is a constant of the
  // driver and always can. Consequently the durable capability cache gains NO column. A
  // client therefore never receives `output_speed: true` without the values it must render, on
  // either path, so Plan-013's fail-closed refusal rule can never be triggered by the cache.
  outputSpeedLevels?: string[];
  // Each provider's BUILT-IN TOOLS, in the provider's own spelling — Claude Code: `Read`, `Edit`,
  // `Write`, `Bash`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Agent`; Codex: `shell`, `apply_patch`,
  // `web_search` — the list an agent definition's tool allowlist picks from, beside the daemon's
  // callback tools and the MCP catalog. `Agent` is Claude Code's canonical name for its spawn tool,
  // whose alias `Task` is what its init frame shows. STATIC like `outputSpeedLevels`, from the same
  // per-driver table, so it is present on both read paths and the durable capability cache gains no
  // column; served on the client-facing `driver.listCapabilities` payload and bounded there like
  // `outputSpeedLevels`. The words a person reads for each tool are the renderer's, never this list's.
  builtInTools: string[];
}

type CapabilityDetectionSource = "static" | "probed";
```

**Two Codex signals that draw no flow row.** The Codex driver maps a safety check that holds a turn, and Codex's warnings and deprecations, onto the two shapes below; neither is a row in the flow, and a Claude Code session carries neither, because Claude Code sends neither signal. The names and their categories are [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s.

```ts
// run.safety_buffering_updated — Codex's `model/safetyBuffering/updated`, its `showBufferingUi`
// carried as `active` (Spec-005 §Run Lifecycle). A LIVE event on the run's own state stream,
// `run.subscribeState`, outside the session-event union: the daemon never appends it, so it has no
// sequence, is not kept in the session's history and is not replayed; a re-opened session does not show it. While `active` is true the
// working line's action words read Codex's own sentence in place of the verb, and when Codex
// clears the flag or the reply starts, the verb returns.
interface RunSafetyBufferingUpdatedPayload {
  sessionId: SessionId;
  runId: RunId;
  turnId: string;
  active: boolean;
  fasterModel?: string; // the faster model Codex names, carried as sent
}

// session.notice of kind `provider_warning` (Spec-005 §Session Lifecycle): Codex's `warning`, whose
// `message` becomes `text`, or its `deprecationNotice`, whose `summary` becomes `text` and whose
// `details` are kept beside it. Recorded so the working line's warnings count and its list survive
// a reload; it draws no flow row. `configWarning` and `guardianWarning` are not this kind, nor is
// the `warning` right after `model/rerouted` in the same turn, which is that switch's `sentence`.
interface SessionNoticeProviderWarning {
  sessionId: SessionId;
  kind: "provider_warning";
  source: "warning" | "deprecation";
  text: string; // Codex's own words
  details?: string; // a deprecation's details; absent on a warning
}
```

### Running-Command Method Registry (Plan-003)

The console's window onto the shell commands an agent started. The provider decides how a command runs and the console never forces it — it sets no time limit of its own, never chooses foreground or background for a command, and never reports a command's processor or memory use. What the console adds is one live view with four acts, on the `command` root riding the **daemon JSON-RPC transport only**: the running set is the daemon's own, folded from one provider's whole-set change notification (which a repeated handshake also returns after a reconnect) and the other's background-terminal listing, so a reconnect converges without a client reconciling two readings.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `command.list` | `subscription` | `CommandListSubscribeRequest` | `CommandListUpdate` (stream) |
| `command.stop` | `mutation` | `CommandStopRequest` | `CommandStopResponse` |
| `command.background` | `mutation` | `CommandBackgroundRequest` | `CommandBackgroundResponse` |
| `command.write` | `mutation` | `CommandWriteRequest` | `CommandWriteResponse` |

`command.list` is a subscription and not a read, because the set changes without anyone asking and a command can outlive the turn that started it. `command.background` is capability-gated: exactly one pinned provider can move a waited-on command to the background, and on the other the control does not exist — absent rather than disabled — so the verb is never dispatched there and a word typed for it is answered by the console with one row rather than a refused call. `command.write` answers a command that is waiting for its input: text the person typed, or `End input`, which closes the command's input; a prompt that opens the terminal raises the same input line with the prompt's own words.

```ts
// One running command, in the order the commands started. `name` is the command as the agent ran it,
// which is also what the transcript row shows; `startedAt` is what the live timer counts from, so the
// timer is a rendering of one fact rather than a second clock. `waitingInForeground` is true only where
// the provider is holding the agent's turn on this command, which is the one state the background act
// applies to.
interface RunningCommand {
  commandId: string;
  runId: RunId;
  name: string;
  startedAt: string;
  waitingInForeground: boolean;
  // True while the command is waiting on its own input, reported by the daemon's command wrapper from
  // the kernel's own signal; kept with the session, so every device shows the same input line.
  waitingForInput: boolean;
}
interface CommandListSubscribeRequest {
  sessionId: SessionId;
}
// The WHOLE set per emission, because the provider's own change notification carries the whole set and a
// subscriber composing deltas could hold a command the provider has already dropped. The set going empty
// is what takes the view away.
interface CommandListUpdate {
  sessionId: SessionId;
  commands: RunningCommand[];
}

// Ending a command is never a bare failure to the agent: the row records that the person ended it, and
// the agent receives one short message naming the stopped command, so its next step reads an
// instruction rather than an unexplained error. Stopping every command in a session is this same verb once
// per running command — there is no sweep verb, and nothing here touches an agent.
interface CommandStopRequest {
  sessionId: SessionId;
  commandId: string;
}
interface CommandStopResponse {
  commandId: string;
  stopped: true;
}

// Moving a waited-on command to the background continues the agent's turn and starts the output
// streaming into the command's own row. Refused where the bound provider has no such mechanism, and where
// no command is waiting in the foreground.
interface CommandBackgroundRequest {
  sessionId: SessionId;
  commandId: string;
}
interface CommandBackgroundResponse {
  commandId: string;
  waitingInForeground: false;
}

// Typed input to a command that is waiting for it, or `End input`. The daemon's command wrapper sits
// after each provider's permission decision and inside its sandbox, holding the command's standard
// input: `text` is written to it and `endOfInput` closes it (end-of-file on a terminal). The wrapper
// is not a sandbox; it runs inside the provider's. A read waits for the person or `End input`,
// bounded only by the provider's and the runtime's own limits.
interface CommandWriteRequest {
  sessionId: SessionId;
  commandId: string;
  text?: string;
  endOfInput?: boolean;
}
interface CommandWriteResponse {
  commandId: string;
}
```

**Two records the flow folds.** A command's output arrives as `command.output` and streams into that command's own row as it prints; the row is the one home for the whole output, and the live view above it is a window onto the same rows rather than a second copy. A command settles as `command.ended`, carrying which of the three endings it was — it finished, it failed, or the person ended it — because a row that cannot say which of the three happened cannot be read. The taxonomy is [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s.

**The live command list is `session.providerCommandsSubscribe`.** The `/` list a session offers is bound to the LIVE provider process: on Claude Code it is the process's first frame, replaced whole by each `commands_changed` push, and a new process — a new session, a switch of provider or worktree at its boundary — brings a new frame and a new list; on Codex, whose wire parses no slash text, it is the console's words and the skills the daemon lists (`skill.list`), the other provider's skills grayed beside them; Codex's own `skills/list` is read only for what Codex loaded, so a skill Codex failed to load stays listed and grayed with its load error, matched to its row by its `SKILL.md` path. Each working tool server's prompts join it; Codex never asks a server for its prompts, so on a Codex session the daemon lists and reads them itself through its own MCP client, for every server it can reach. The subscription takes `ProviderCommandsSubscribeRequest` and emits `ProviderCommandsUpdate`, the whole list on every emission (§Plan-003 above), over the daemon JSON-RPC transport only.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `session.providerCommandsSubscribe` | `subscription` | `ProviderCommandsSubscribeRequest` | `ProviderCommandsUpdate` (stream) |

### Voice Method Registry (Plan-003)

Talking instead of typing, on both providers, with the same keys: `/voice` turns voice on in the session it is typed in, and holding Space (or, after `/voice tap`, tapping it) talks. Voice is on in one session at a time on this computer; the daemon holds which, so every window and device showing that session shows the same, and it is off after the daemon restarts. What each provider does with the words differs:

- **Claude Code: dictation into the draft.** The window captures the microphone, cuts it to 16 kHz 16-bit mono and hands the frames to the daemon, which runs its own socket to Anthropic's speech service, one per recording, signed in with the session's account, and relays the words back. Dictation never passes through Claude Code, so no other Claude Code session hears it.
- **Codex: Codex's own spoken call.** The window is the call's WebRTC peer. The daemon passes the window's offer in `thread/realtime/start` on the account's Codex service and returns Codex's answer from `thread/realtime/sdp`, routes Codex's `thread/realtime/*` notifications to the call by `threadId`, and, when a turn that answers a spoken message ends, sends its final answer to `thread/realtime/appendSpeech`, cut at 990 tokens, so the voice speaks it. A call belongs to the one conversation it is started on.

The mode (hold or tap, one for both providers) and the call voice are keys in the machine's settings file, `voice.mode` (`hold` or `tap`, default `hold`) and `voice.callVoice` (the voice a spoken call answers in; only Codex's call speaks today, and `voice.voiceList` gives the choices; missing reads as Codex's default), read and written through the preload bridge's `machineSettings.read()` / `machineSettings.write(change)` ([§Settings Surface Reads And Writes](#settings-surface-reads-and-writes)). No method here carries the mode, and nothing is written into either provider's own configuration. From another device the device in hand is the microphone: dictation's frames reach the machine over the encrypted relay, and a call's offer and answer pass through the machine. The speech socket and `thread/realtime/appendSpeech` are the daemon's own, and no client calls them.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `voice.stateUpdate` | `mutation` | `VoiceStateUpdateRequest` | `VoiceStateUpdateResponse` |
| `voice.stateSubscribe` | `subscription` | `VoiceStateSubscribeRequest` | `VoiceState` (stream) |
| `voice.dictationStart` | `mutation` | `VoiceDictationStartRequest` | `VoiceDictationStartResponse` |
| `voice.dictationWrite` | `mutation` | `VoiceDictationWriteRequest` | `VoiceDictationWriteResponse` |
| `voice.dictationStop` | `mutation` | `VoiceDictationStopRequest` | `VoiceDictationStopResponse` |
| `voice.dictationSubscribe` | `subscription` | `VoiceDictationSubscribeRequest` | `VoiceDictationUpdate` (stream) |
| `voice.callStart` | `mutation` | `VoiceCallStartRequest` | `VoiceCallStartResponse` |
| `voice.callStop` | `mutation` | `VoiceCallStopRequest` | `VoiceCallStopResponse` |
| `voice.callSubscribe` | `subscription` | `VoiceCallSubscribeRequest` | `VoiceCallUpdate` (stream) |
| `voice.voiceList` | `query` | `VoiceVoiceListRequest` | `VoiceVoiceListResponse` |

```ts
// Which session voice is on in, or null. Moving it ends the other session's call, and `Voice ended`
// lands there.
interface VoiceStateUpdateRequest {
  sessionId: SessionId | null;
}
interface VoiceStateUpdateResponse {
  sessionId: SessionId | null;
}
interface VoiceStateSubscribeRequest {}
// The first emission is the current state, then one per change.
interface VoiceState {
  sessionId: SessionId | null;
}

// Dictation, on a Claude Code session. The request carries no mode: hold or tap is the window's,
// read from the machine's settings file, and the socket runs the same in both.
interface VoiceDictationStartRequest {
  sessionId: SessionId;
}
interface VoiceDictationStartResponse {}
// One 100 ms frame of the recording's audio, 16 kHz 16-bit mono, 600 a minute (about 32 KB a
// second).
interface VoiceDictationWriteRequest {
  sessionId: SessionId;
  frame: DictationAudioFrame;
}
interface VoiceDictationWriteResponse {}
// Ends the recording. `cancel: true` is Escape's: the recording is dropped and its words with it.
interface VoiceDictationStopRequest {
  sessionId: SessionId;
  cancel: boolean;
}
interface VoiceDictationStopResponse {}
interface VoiceDictationSubscribeRequest {
  sessionId: SessionId;
}
// The words, or a refusal. The speech service's in-progress words replace `inProgress`, and its
// settling of them moves them into `committed`; the draft shows the committed words, a space, then
// the words in progress, dimmed until they settle.
type VoiceDictationUpdate =
  | { sessionId: SessionId; committed: string; inProgress: string }
  | { sessionId: SessionId; refusal: VoiceRefusal };

// The refusals the daemon can know, each drawn as the strip's one-line refusal, the same on both
// providers. Refusals about the microphone itself are the window's own.
type VoiceRefusal =
  // `Voice isn't available on <account>.`: the provider gives this account no voice (on Claude Code
  // an API-key or cloud-provider account).
  | { reason: "no_voice_on_account" }
  // `Dictation couldn't sign in to <account>.` with `Sign in again`: the service refused the
  // account's sign-in (401 or 403).
  | { reason: "sign_in_refused" }
  // `Dictation couldn't be sent.` with `Try again`: the connection failed after the one retry, the
  // service refused with another 4xx, or on Codex a call could not start or dropped.
  | { reason: "not_sent" }
  // `No speech heard.`: the recording closed having heard sound but no words.
  | { reason: "no_speech" };

// A Codex call, started at the first hold or tap of Space once voice is on there. The daemon passes
// the offer in `thread/realtime/start` with the voice picked in the machine's settings file and the
// session's earlier spoken exchange, and returns Codex's answer.
interface VoiceCallStartRequest {
  sessionId: SessionId;
  offerSdp: string;
}
interface VoiceCallStartResponse {
  answerSdp: string;
}
// Sent once the window has closed the call: when voice is turned off or moves to another session.
interface VoiceCallStopRequest {
  sessionId: SessionId;
}
interface VoiceCallStopResponse {}
interface VoiceCallSubscribeRequest {
  sessionId: SessionId;
}
// The call's life: started; the live words, the person's as they pass in and the voice's replies;
// and its end, with its cause.
type VoiceCallUpdate =
  | { sessionId: SessionId; event: "started" }
  | {
      sessionId: SessionId;
      event: "words";
      speaker: "person" | "voice";
      text: string;
      final: boolean;
    }
  | {
      sessionId: SessionId;
      event: "ended";
      cause: "turned_off" | "moved" | { refusal: VoiceRefusal };
    };

// The voices Codex offers (its own `v1` list) and its default, for `/voice settings`. The pick is
// written to the machine's settings file, never into Codex's configuration.
interface VoiceVoiceListRequest {
  sessionId: SessionId;
}
interface VoiceVoiceListResponse {
  voices: string[];
  defaultVoice: string;
}
```

### Plan-004 — Session Event Taxonomy

```ts
// EventEnvelopeVersion — branded semver "MAJOR.MINOR" string per ADR-017 §Decision #1.
// Wire form and persisted form are both string (never numeric). Parsing extracts MAJOR
// and MINOR as integers for numeric comparison; lexical string comparison is unsafe
// (e.g. "1.10" lexically < "1.9"). The connection handshake's `version.floor_exceeded` /
// `version.ceiling_exceeded` reasons are about the wire protocol
// (§JSON-RPC Handshake `protocolVersion` Field), not this brand.
type EventEnvelopeVersion = string & { readonly __brand: "EventEnvelopeVersion" };
// Format: /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/ — validated at envelope construction.

// EventEnvelope — canonical event message
interface EventEnvelope {
  id: string;
  sessionId: SessionId;
  sequence: number;
  occurredAt: string; // ISO 8601
  category: EventCategory;
  type: string; // specific type within category
  actor?: string | null; // user_id, agent_id, or null for system
  payload: Record<string, unknown>; // category-specific fields; may carry the cross-cutting sourceEpoch + sourcePosition pair (below)
  correlationId?: string;
  causationId?: string;
  version: EventEnvelopeVersion; // semver "MAJOR.MINOR" per ADR-017 §Decision #1 (never numeric)
}

// sourceEpoch + sourcePosition — the cross-cutting epoch-attribution payload pair
// (Plan-004 T1.8, the CP-002-12 registration; Spec-005 §Event Type
// Enumeration). Stamped TOGETHER at ingestion by Plan-002 T3.11's late-append leg on
// pre-rollback-epoch rows (the pair from the straggler's per-event operation
// association — (epoch, turn) recorded at operation open — falling back to the closed
// delivery generation's always-superseding retained pair; Spec-003 §Required Behavior
// owns the fence and generation-rotation mechanics) of the four late-append families
// — assistant_output,
// tool_activity, usage_telemetry and artifact_publication (a provider permission ask from
// before a cut is absorbed, never appended): sourceEpoch names the
// pre-rollback execution epoch, sourcePosition the normalized session position (the
// Spec-003 targetPosition turn-boundary vocabulary) the row occupies within it —
// registered because no run-scoped family payload carries a native position key, and
// the supersede cutoff (turn > targetPosition) cannot rank a late row against its
// epoch's surviving prefix without one. Admission is keyed on run-scopedness, not
// family membership: only run-scoped SessionEventSchema branches of those families
// admit the pair (via Plan-004 T1.8's withEpochStamp helper, whose pairing
// refinement requires both keys + runId on any stamped payload); variants without
// run attribution — the account-plane usage.rate_limit_update foremost — and every
// run_lifecycle branch never admit it (stragglers absorb, never append). Absent on
// every current-epoch row — absence means current-epoch, and the stamp is never
// fabricated at read time. The pair rides INSIDE payload, so it sits in the RFC 8785
// canonical bytes with no envelope-level field
// added — the canonical set above is unchanged — and it is part of the v1.0
// baseline payload contract. Compaction preserves the sourceEpoch + sourcePosition
// + runId triple, on accepted run.rolled_back boundary rows the
// runId/runVersion/targetPosition rewind cutoff, and on every run-scoped row its runId
// (Spec-005 §Compacted Event Format), so Plan-002 T3.16's supersede projection keys cross-epoch rows durably even after
// both the boundary and the stale rows compact. Execution-epoch semantics are
// Spec-003-owned (§Required Behavior + Run State Machine §Invariants): 0 before any
// rollback, advancing with each accepted run.rolled_back rewind regardless of the
// file-leg disposition. The key names are pinned by SOURCE_EPOCH_PAYLOAD_KEY /
// SOURCE_POSITION_PAYLOAD_KEY in packages/contracts/src/event-envelope.ts — a rename is
// forbidden-non-additive per ADR-017 §Decision #8.
type SourceEpoch = number; // int >= 0 — SourceEpochSchema in packages/contracts/src/event-envelope.ts (Plan-004 T1.8)
type SourcePosition = number; // int >= 0 — SourcePositionSchema, same file (Plan-004 T1.8); Spec-003 targetPosition vocabulary

type EventCategory =
  | "run_lifecycle"
  | "assistant_output"
  | "tool_activity"
  | "interactive_request"
  | "artifact_publication"
  | "session_lifecycle"
  | "approval_flow"
  | "usage_telemetry"
  // Extended per Spec-005 §Runtime Node Lifecycle, §Recovery Events,
  // §Security Events, §Event Maintenance,
  // §Orchestration Admission, §MCP Governance and the
  // workflow families (§Workflow Lifecycle through §Workflow Gate Resolution). The
  // category list and its event types are Spec-005 §Event Type Summary's, which
  // carries the table; read them there, never restated here.
  | "runtime_node_lifecycle"
  | "recovery_events"
  | "security_events"
  | "event_maintenance"
  | "orchestration_admission"
  | "mcp_governance"
  // The workflow families are separate categories rather than one, so a reader can query a
  // run's life, its steps, its parallel coordination and its gates apart from one
  // another — the split run_lifecycle and approval_flow already make between runs and
  // approvals (Spec-005 §Workflow Lifecycle through §Workflow Gate Resolution; emitted by Plan-014).
  | "workflow_lifecycle"
  | "workflow_phase_lifecycle"
  | "workflow_parallel_coordination"
  | "workflow_gate_resolution";
// Individual event types within each category are enumerated in Spec-005 §Event Type Enumeration.

// ---------------------------------------------------------------------------
// Payload variants authored in packages/contracts/src/event-declared-variants.ts
// (event.compacted and the event_maintenance base) and
// packages/contracts/src/event-variant-types.ts (usage.model_rerouted, its
// schema in packages/contracts/src/event.ts), which Plan-004
// owns, rather than imported from an emitting plan's module (contrast the
// repo/workspace/worktree family, authored in repo.ts / worktree.ts under
// emitter-authors-payload); Plan-004 T1.10 registers event.compacted.
// Registering a payload variant is additive-MINOR per ADR-017 §Decision #8;
// these type strings are listed in Spec-005 §Event Type Summary, so
// registering them adds no event type.
//
// Session binding (Spec-005 §Daemon-Scope Event Binding): relay.pin_refused and
// the event_maintenance types bind the reserved RFC 9562 §5.10 Max UUID sentinel
// session_id (lowercase). Binding is an emitter obligation: the envelope's
// SessionId already admits the sentinel, so no schema carve-out exists.
//
// Of these, only usage.model_rerouted is run-scoped (its payload carries runId),
// so it alone admits the sourceEpoch + sourcePosition pair documented above.
// relay.pin_refused payload (security_events) — base {nodeId, occurredAt} + the relay's host and the
// two key-hash prefixes, per Spec-005 §Security Events. The daemon records it on its sentinel session
// when a pinned relay presents a key other than the one pinned when it was linked, and refuses the
// connection. Emitted by the relay pin (Plan-025 Phase 3), not by Plan-004, so its schema,
// RelayPinRefusedPayloadSchema, is authored in packages/contracts/src/relay.ts under
// emitter-authors-payload and imported by the union, like the repo/workspace/worktree family.
// Each prefix is the first 8 bytes of its key hash, never a token.
interface RelayPinRefusedPayload {
  nodeId: NodeId;
  occurredAt: string; // ISO 8601
  relayHost: string;
  pinnedSpkiPrefix: string;
  presentedSpkiPrefix: string;
}

// usage.model_rerouted payload (usage_telemetry), per Spec-005 §Usage Telemetry, which maps each
// provider frame onto these members. Draws the `Model switched` row (Spec-011 §Flow Row Kinds).
interface UsageModelReroutedPayload {
  sessionId: SessionId;
  runId: RunId;
  agentId?: AgentId;
  fromModel: string;
  toModel: string; // the model the request ran on, and the model it is priced at
  scope: "turn" | "session" | "local"; // one turn; the rest of the session; only a subagent's, a side question's or a background fork's response
  sentence?: string; // the provider's own sentence, absent when it sent none
  explanation?: string; // the provider's explanation, shown verbatim
  cause: "safety" | "model_unavailable" | "model_blocked" | "out_of_credits";
  safetyCategory?: string; // the provider's open safety category, such as "cyber" or "bio"
}

// event_maintenance payload base — {nodeId, operationId, occurredAt}, per
// Spec-005 §Event Maintenance. occurredAt re-spells the envelope member (the
// spec's shape; both sit in the RFC 8785 canonical bytes).

interface EventCompactedPayload {
  nodeId: NodeId;
  operationId: string;
  occurredAt: string; // ISO 8601
  removedSessions: Array<{ sessionId: SessionId; fromSeq: number; toSeq: number }>; // each session the deletion removed, with the range of rows it deleted
}

// EventReadAfterCursor
interface EventReadAfterCursorRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor; // absent ≡ start-of-log position -1: full surviving-range read, subscription first-connect parity (Plan-004 T4.1)
  limit?: number; // default 100
}
interface EventReadAfterCursorResponse {
  events: EventEnvelope[];
  nextCursor: EventCursor;
  hasMore: boolean;
}

// EventReadWindow
interface EventReadWindowRequest {
  sessionId: SessionId;
  fromSequence: number;
  toSequence: number;
}
interface EventReadWindowResponse {
  events: EventEnvelope[];
}

// EventSubscription
interface EventSubscriptionRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor; // replay from this point; omit for live-only
}
// Response: a stream of EventEnvelope
```

---

### Plan-005 — Local IPC And Daemon Control

```ts
// JSON-RPC 2.0 method shapes

// DaemonHello
interface DaemonHelloParams {
  clientVersion: string;
  supportedProtocols: string[];
}
interface DaemonHelloAck {
  compatible: boolean; // false leaves the connection to read-only calls
  protocolVersion: string; // the negotiated version; when incompatible, the daemon's preferred one
  reason?:
    | "version.floor_exceeded"
    | "version.ceiling_exceeded"
    | "protocol.handshake_already_completed"; // only when incompatible
  serverCapabilities?: string[];
  daemonSupportedProtocols?: string[]; // when incompatible, so the client can pick a version to retry with
  // The connecting device's own id: the one a terminal lease names as its holder (`holderDeviceId`
  // on `pty.control_changed`), so a client tells this device holding a shell apart from another
  // device holding it, and, by `holderRunId`, from an agent's run holding it.
  deviceId: DeviceId;
}

// DaemonStatusRead
interface DaemonStatusReadParams {}
interface DaemonStatusReadResult {
  processState: "running" | "starting" | "stopping" | "degraded";
  protocolVersion: string;
  transportEndpoint: string;
  // The service's own facts for Settings › Runtime and `sidekicks daemon status`. Processor and
  // memory are read only when this is called — the page opening, `Check again` — never on a timer,
  // each stamped with the time it was read; `null` draws `Not read yet`. They count the service's
  // own processes and nothing else: the daemon and every process it started (on a Windows computer
  // whose service runs in WSL, read inside the distribution, plus the service's Windows half and its
  // `wsl.exe`; the WSL virtual machine is not counted).
  version: string;
  startedAt: string; // ISO 8601
  processor: { percent: number; readAt: string } | null;
  memory: { residentBytes: number; readAt: string } | null;
  // The data directory this daemon holds. A second daemon cannot hold it, which is why the sign-in and
  // sign-out verbs refuse while this one is up and name what to stop — so the status read has to say
  // which directory is held, not merely that something is.
  dataDirectory: string;
  // The path of the file the daemon keeps its secrets in, mode 0600, present ONLY on Linux where no
  // Secret Service answers; Settings › Runtime then shows `Secrets are kept in <path>, readable only
  // by you, because no Secret Service is running.` Absent on every other machine.
  secretsFile?: string;
  // The relay block, present ONLY while a relay is configured — absent otherwise, never an empty block
  // and never a disabled one, in the text output and the machine-readable output alike. Its fields are
  // Remote Control's own relay wire; nothing here is a second reading of it.
  relay?: {
    devices: Array<{
      name: string;
      connected: boolean;
      // Ages rather than timestamps, because the figure a person reads is how long ago; absent means no
      // frame has gone that way at all, which is a different fact from a frame long ago.
      lastFrameOutAgeMs?: number;
      lastFrameInAgeMs?: number;
      reconnectCount: number;
      // Counts each frame the relay refuses as malformed or unauthenticated; there is no per-device quota.
      rejectedFrameCount: number;
    }>;
  };
}

// DaemonStop / DaemonRestart (no DaemonStart: a service that is not running answers no method, so starting it is never an IPC method. The command line starts it with `sidekicks daemon start` (Plan-005 T-005r-3-4); the desktop app's main process starts it through the preload bridge's `daemon.requestStart()`, and quitting the app leaves the service and every run running)
// Separate per-method request schemas (NOT a shared `action` discriminator): each carries the idle-drain
// deadline that I-005-14 quiesce depends on. The 5000ms default is applied by the Zod schema (Plan-005
// T-005r-1-2), so the field is input-optional but always present post-parse. A confirmed stop or
// restart wins: another connected client never refuses it, so both results are the uniform
// { accepted: true }.
interface DaemonStopParams {
  idleDrainDeadlineMs?: number; // default 5000
}
interface DaemonStopResult {
  accepted: true;
}
interface DaemonRestartParams {
  idleDrainDeadlineMs?: number; // default 5000
}
interface DaemonRestartResult {
  accepted: true;
}

// DaemonPing — `daemon.ping`, main's liveness check on its link to the service. Main sends it only
// after 5 s with no frame from the service, so a busy link carries none; after 20 s with no frame
// main counts the link as dead, shows it on the connection state and restarts the service with its
// backoff. The answer is the evidence of life, so it carries nothing.
interface DaemonPingParams {}
interface DaemonPingResult {}

// DaemonConfigRead / DaemonConfigUpdate — `daemon.configRead` / `daemon.configUpdate`, the
// machine-wide service settings Settings › Runtime edits, one configuration surface (Spec-006).
// Separate from the per-session `session.maxStepsUpdate`, `session.spendLimitUpdate` and
// `session.tokensPerRunUpdate`, and from the command line's
// `settings.effectiveRead`, with which it shares no field.
interface DaemonConfigReadParams {}
interface DaemonConfig {
  workflowListenerPort: number;
  listener: { listening: boolean; reason?: "portTaken" }; // a taken port is saved, not refused, and reads here
  runTimeLimit: "none" | "30m" | "1h" | "4h" | "12h" | "24h"; // `Stop a run after`
  workflowChainAskAfterRuns: number | null; // `Ask me after one start leads to`: 25, 100 (the default), 500 or 2,000 runs; null is `Never ask`
  maxStepsPerTurn: number | null; // null is `Unlimited`: each provider does what it does on its own
  spendLimitUsdMicros: number | null; // `Spend limit`, what each new session starts from; null is `Unlimited`
  tokensPerRun: number | null; // `Tokens per run`, what each new session starts from; null is `Unlimited`
  toolMemoryCapBytes: number | null;
  toolMemoryCapEnforceable: boolean;
  packageCacheLimitBytes: number | null; // the package caches' `Cache limit`; null is `Unlimited`, and then the service never clears a cache on its own. With a size set, after each successful install the service reads that tool's cache and clears it when it is larger, leaving the other tool's cache alone
  recordTraces: boolean;
  recordReplayLog: boolean;
  replayLogPath: string; // the file the replay log writes, which the page names
}
type DaemonConfigReadResult = DaemonConfig;
// One member per press, like `providerAccount.update`; the reply is the whole configuration after it.
// A value that is not a port or not a size is refused, and nothing changes.
type DaemonConfigUpdateParams = Partial<
  Omit<DaemonConfig, "listener" | "toolMemoryCapEnforceable" | "replayLogPath">
>;
interface DaemonConfigUpdateResult {
  config: DaemonConfig;
}

// DaemonPackageCacheRead — `daemon.packageCacheRead`, what each workflow package cache holds: one
// walk of each cache folder, taken only when called (the page opening, `Check again`) and, under a
// custom `Cache limit`, after an install; nothing samples it on a timer. The page adds the total.
interface DaemonPackageCacheReadParams {}
interface DaemonPackageCacheReadResult {
  bun: { bytes: number; readAt: string };
  uv: { bytes: number; readAt: string };
}
// DaemonPackageCacheClear — `daemon.packageCacheClear`: `uv`'s cache through `uv cache clean`, bun's
// by removing its folder; never a step's code folder or the Python the service manages, so a step
// already installed keeps working. A clear waits for the installs using that cache and an install
// waits for a clear; the reply is the new reading.
interface DaemonPackageCacheClearParams {
  cache: "bun" | "uv" | "all";
}
type DaemonPackageCacheClearResult = DaemonPackageCacheReadResult;

// SessionTerminalProviderSessionList — `session.terminalProviderSessionList`: the provider sessions a
// person typed in a terminal that are inside a provider's shared service, each working, idle or not
// reachable, with `provider` as data, read off
// the same directory entries the agents' session listing names, so Runtime and the agents read one
// fact. `Stop`'s confirm counts them and the service update's waiting step counts the working ones;
// read when a confirm opens and while an update waits, never on a timer. Empty while `Reach Codex
// sessions started in a terminal` is off.
interface SessionTerminalProviderSessionListParams {}
interface TerminalProviderSession {
  provider: ProviderName;
  name: string;
  threadId: string;
  state: "working" | "idle" | "unreachable";
}
interface SessionTerminalProviderSessionListResult {
  sessions: TerminalProviderSession[];
}

// LocalSubscription
interface LocalSubscriptionParams {
  sessionId: SessionId;
  afterCursor?: EventCursor;
  categories?: EventCategory[]; // filter to specific categories
}
// Response: a JSON-RPC notification stream of LocalSubscriptionFrame on the already-registered
// $/subscription/notify method — one frame per batch, never one frame per event.

// The batched subscription frame (Plan-005 Phase 2D). The producer coalesces what it is
// handed into one frame per 16 ms or 50 events, whichever comes first, and the window opens on the
// FIRST event rather than the last: a throttle, not a debounce, so a lone event is never held for a
// whole window while a burst still collapses into one delivery.
interface LocalSubscriptionFrame {
  // Changes only, never the whole record, and every change carries its own cursor — which is what
  // lets a consumer say where it got to without the producer keeping a position per consumer.
  changes: Array<{ cursor: EventCursor; value: EventEnvelope }>;
  // Present on the first frame that fits after the producer dropped for this consumer, and on that
  // frame alone — never left standing on every frame after it, which would make one gap and a
  // continuing one indistinguishable. The producer never waits for a consumer, so a consumer that
  // falls behind is dropped for; a drop it is not told about is the single failure this member
  // exists to make impossible. Seeing it, the consumer repairs against the daemon's own record by
  // cursor through `afterCursor` above, and past the point that record can still fill it takes a
  // snapshot read from beyond the gap instead of a fill. So what a consumer holds is either
  // complete or visibly short, never silently short, and the record rather than the screen is the
  // truth.
  gap?: true;
}
```

The frame above is defined here because it is a cross-cutting wire primitive, the class §Source-of-Truth Policy keeps in this file; the producer that emits it, `LocalSubscriptionProducer<T>`, stays canonical in code at `packages/contracts/src/jsonrpc-streaming.ts` under that same policy, and the Zod schema there governs on any divergence. Nothing is minted for the batching: the frame rides the registered `$/subscription/notify` method, the repair is the `afterCursor` read this surface already takes, and no method name, error code, or setting is added. Producer side: [Plan-005 §Phase 2D](../../plans/005-local-ipc-and-daemon-control.md#phase-2d--substrate-supplement-the-subscription-frame-is-batched-carries-changes-only-and-never-waits-for-a-consumer). Consumer side: [Plan-020](../../plans/020-desktop-app-and-renderer.md)'s transcript frame, which repairs by snapshot on the `gap` flag.

---

## Plans 002 And 015

### Plan-002 — Queue Steer Pause Resume

```ts
// QueueItemCreate
interface QueueItemCreateRequest {
  sessionId: SessionId;
  payload: Record<string, unknown>;
  // An edit of a message still waiting, made in one call: the named item reads `superseded` and this
  // one takes its place in the order, so the edited message keeps its position. Refused once the agent
  // has taken the named message. The daemon does the replacing itself — on Claude Code a cancel and a
  // resend inside this call, on Codex a replacement in its own hold, because a resend there would move
  // the message to the end of the queue — and a client never sends a cancel and a resend for an edit.
  replacesQueueItemId?: QueueItemId;
}
interface QueueItemCreateResponse {
  queueItemId: QueueItemId;
  state: QueueItemState;
  createdAt: string;
}
// Orchestration seam (D-013-9): Plan-013's orchestration-run-service composes with
// the daemon queue-admission service IN-PROCESS, passing an OrchestrationRunLinkCarrier (see
// §Plan-013) after its own admission pipeline passes. The in-process admission API returns the
// minted RunId (the run.queued emission's runId) alongside queueItemId, and run.queued carries the
// carrier fields durably (Spec-005 §Run Lifecycle run.queued row — additive optional fields). The wire
// run.queueCreate method never accepts the carrier — child-run creation goes through orchestration.runCreate only.

// QueueItemList
interface QueueItemListRequest {
  sessionId: SessionId;
  state?: QueueItemState; // filter
  // A live child's own queue in place of the lead's (the child's handle, defined with the child controls
  // below). The same member narrows run.subscribeQueue, run.queueCancel and run.queueReorder, so a
  // child's pending rows work as the lead's do.
  childHandle?: string;
}
interface QueueItemListResponse {
  items: QueueItemSummary[];
}

interface QueueItemSummary {
  id: QueueItemId;
  state: QueueItemState;
  notDeliveredReason?: "timed_out" | "failed"; // present exactly on a not_delivered item: it waited past the daemon's own delivery timeout, or its delivery failed outright
  priority: number;
  createdAt: string;
  updatedAt: string;
}

// QueueItemCancel
interface QueueItemCancelRequest {
  queueItemId: QueueItemId;
  childHandle?: string; // the child whose queue holds the item
}
interface QueueItemCancelResponse {
  queueItemId: QueueItemId;
  state: "canceled";
}

// QueueItemReorder — one daemon-held order over the items still waiting, on the lead's queue or a
// child's. `queueItemIds` is the full new order and is refused unless it names exactly the items still
// waiting. On Codex the daemon reorders its own hold; on Claude Code it cancels and resends in the new
// order. The daemon holds the order itself because a cancel and a resend on Codex would put the message
// last. The answer is the queue in its new order.
interface QueueItemReorderRequest {
  sessionId: SessionId;
  childHandle?: string;
  queueItemIds: QueueItemId[];
}

// InterventionRequest (discriminated union by type)
// `expectedRunVersion` is the MANDATORY optimistic-concurrency comparand (Plan-002 D-002-2,
// fail-closed): every intervention carries the run version the caller last observed, and the
// daemon rejects the request as `expired` when it does not match the run's current `runVersion`
// (surfaced on RunStateChangeEvent / RunControlAck / InterventionRequestResponse below). The field
// is required — an absent comparand is rejected, never applied (an optional field would let a caller
// bypass the stale-replay guard by omitting it). The compared-against counter is `runVersion`
// (Plan-002 D-002-1): an any-run-progression counter that advances on every run progression,
// applied interventions included — distinct from the immutable EventEnvelope `.version` wire-contract
// field (Spec-005 §EventEnvelope Version Semantics).
// `clientIdempotencyKey` is the second mandatory guard — a requester-generated UUID
// giving at-least-once delivery exactly-once application: the daemon persists it on the
// interventions row (UNIQUE(target_run_id, client_idempotency_key)); an identical retry replays
// the originally recorded outcome without re-dispatching, and key reuse with a differing payload
// is rejected as `intervention.idempotency_conflict` (Spec-004 §Required Behavior). The two
// guards are orthogonal: `expectedRunVersion` defeats stale replays of OUTDATED intent;
// `clientIdempotencyKey` defeats duplicate applications of the SAME intent.
type InterventionRequestPayload =
  | {
      // The console never sends this arm: the person's steer is always a queue send, `run.queueCreate`.
      type: "steer";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      content: string;
      // Same element type and same carrier contract as the driver-boundary `SteerPayload.attachments`
      // in §Plan-003 above, where the ordering rule, the unresolved-marker rule, and both count bounds
      // are stated once (CP-011-1). This arm and that payload are the two ends of
      // one carrier: the daemon maps this list onto that one, so a second statement of the rule here
      // would be a second source of truth for one delivery contract.
      attachments?: ArtifactId[];
      expectedTurnId?: string;
    }
  | {
      // The lead's interrupt. `Interrupt everything` is this arm on the lead's run plus `run.childrenStop`
      // on the same run (§Run-Control Method-Name Registry below).
      type: "interrupt";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      reason?: string;
      // The messages still waiting when the turn ends: sent at once as the next turn (`nextTurn`), or
      // put back into the draft one line per message in send order (`returnToDraft`, which
      // `Interrupt everything` sends).
      pending: "nextTurn" | "returnToDraft";
      // `Send now` on a waiting message: the interrupt ends the turn and this item goes first, the rest
      // following in order as the next turn's messages.
      deliverFirst?: QueueItemId;
    }
  | {
      type: "cancel";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      reason?: string;
    }
  | {
      // Codex's retry on the faster model its safety check names (Spec-004 §Required Behavior): the
      // daemon interrupts the turn, forks the conversation to just before it and sends the same message
      // again on `model`. A turn that is no longer the latest, or whose reply has started, is `rejected`.
      type: "faster_model_retry";
      targetRunId: RunId;
      expectedRunVersion: number;
      clientIdempotencyKey: string;
      expectedTurnId: string;
      model: string;
    };

// On an idempotent replay (same clientIdempotencyKey, identical payload) this response is
// reconstructed from the persisted intervention row — same interventionId, current state,
// current runVersion — never a second application.
//
// Undo is not an intervention. Putting a session back to before one of its messages, or to one of its
// snapshots, is the session's own call, `session.restore`, read first through its dry run
// `session.restorePreview`, which takes the same request and changes nothing; the dry run's figures are
// in §Plan-012 — Persistence Recovery And Replay below, and the request and the result are these. The request names a `target` — a message's identity
// or a snapshot's, never a numeric or provider position — and a `scope`: "conversation-and-files" |
// "conversation" | "files". One undo is one intent with one result: `requested` (the scope asked for),
// `restored` (the scope that applied, or "nothing"), and, for each requested part that did not apply,
// `failures.conversation` / `failures.files` carrying its `reason`, because the conversation cut can land
// while the files cannot be put back, or the reverse. Edit and resend is the same one call, and a call
// carrying `resend` takes the scope `conversation-and-files`, so a cut that landed while the resend failed
// is its own outcome, `resend-unapplied`, reported on that result and never as a second call's failure;
// the edited message goes back in the composer. The conversation cut alone is recorded by
// `run.rolled_back` (RunRolledBackEvent below), and every undo's outcome by `session.restore_finished`.
type RestoreScope = "conversation-and-files" | "conversation" | "files";
interface SessionRestoreRequest {
  sessionId: SessionId;
  target: string; // a stable message identity or snapshot identity, never a numeric or provider position
  scope: RestoreScope; // "conversation-and-files" whenever `resend` is present
  clientIdempotencyKey: string; // per session: a retried call never cuts twice
  resend?: string; // the edited message; its presence makes edit and resend one call
  includeAlsoChanged: boolean; // false unless the person pressed the include line: also put back the paths another session in the same folder changed since the point
}
interface SessionRestoreResult {
  requested: RestoreScope;
  restored: RestoreScope | "nothing";
  // What actually went back, which may differ from the dry run's figures if the tree moved in between.
  fileCount: number;
  lineCount: number;
  skipped: Array<{ path: string; reason: SessionRestoreSkipReason }>; // §Plan-012 below
  failures?: {
    conversation?: { reason: string }; // the conversation part was requested and did not apply
    files?: { reason: string }; // the files part was requested and did not apply
  };
  resend?: { outcome: "resend-unapplied"; reason: string }; // the cut landed and the resend did not go
}
interface InterventionResponseBase {
  interventionId: InterventionId;
  state: InterventionState;
  runVersion: number; // post-application run counter (D-002-1) — the caller threads this into the next intervention's `expectedRunVersion`. Carried on the response because an applied native steer advances the run version WITHOUT a `run.*` state change (Spec-003 §Driver-Level Steer Mechanics), so for that path the response is the only place the caller can read the fresh comparand.
  rejectionReason?: string; // machine-readable cause on a `rejected` OUTCOME, which is a normal `run.intervene` response and not a JSON-RPC transport error, so the CLI renders WHY (e.g. `driver.capability_unsupported`). A request-admission refusal (e.g. `intervention.idempotency_conflict`, 422) is a JsonRpcError that produces no intervention row, so it never rides here. Replay-durable: the cause persists in the intervention row's own `rejection_reason` column (Plan-002 T1.4 DDL), so an idempotent replay reconstructs the SAME machine-readable reason from that column, never fabricating one.
}
type InterventionRequestResponse = InterventionResponseBase & {
  interventionType: InterventionType;
  result?: Record<string, unknown>;
};

// RunStateChange (event, not request/response). The `run.failed` variant carries the
// `providerFailureDetail` surface that mirrors the `failed`-variant `providerFailureDetail` of `DriverResumeResult`
// (§Plan-003 above) — Spec-004 §Fallback Behavior requires resume-failure detail to reach the canonical audit
// log so Plan-012's recovery dispatcher and Plan-010's timeline can render the actionable
// reason for the failure without re-querying the driver. Plan-003 CP-003-4; Plan-004 Phase 3. The field holds prose only; a typed cause rides `failureCause`, never this text.
interface RunStateChangeEvent {
  runId: RunId;
  runVersion: number; // run-progression counter (D-002-1): the optimistic-concurrency comparand clients read via run.subscribeState and pass back as `expectedRunVersion`. Advances on every run progression, applied interventions included. A no-state-change advance with no per-type event of its own (e.g. native steer) is NOT emitted as a discrete run.subscribeState event (no transition to record, [Spec-003 §Driver-Level Steer Mechanics](../../specs/003-queue-steer-pause-resume.md#driver-level-steer-mechanics)); the carve-out is an undo's conversation cut — it transitions no state, but its per-type RunRolledBackEvent below rides the same stream carrying the fresh runVersion, so subscribers are never blind to a rewind. A non-intervening subscriber may still hold a stale comparand after a steer-like advance until its next guarded request is correctly rejected `expired`, whereupon it re-reads run-state and retries (reject→re-read→retry; V1 adds no broadcast push for such no-per-type-event bumps — Spec-005 §Security Events / Run Lifecycle). Distinct from the immutable EventEnvelope `.version` (Spec-005 §EventEnvelope Version Semantics) — that is the wire-contract semver; this is the run aggregate's concurrency token.
  previousState: RunState;
  newState: RunState;
  failureCategory?: RunFailureCategory;
  recoveryCondition?: RecoveryCondition; // named type in §Plan-003 above: 'recovery-needed' | 'reauth-required'
  // The run's typed failure cause, present only on a `run.failed` (Spec-005 §Run Lifecycle):
  // `failureCause: { cause, origin }`, a named, closed failure-cause union in `packages/contracts` whose
  // first member is the refusal cause below; each provider's own causes are normalized into it by its
  // driver. The refusal member carries the refusing model and the provider's words.
  failureCause?: {
    cause: "refused";
    // `provider` where the driver normalized the provider's own cause; `daemon` where the app's own
    // refusal or failure ended the run.
    origin: "provider" | "daemon";
    model: string;
    sentence?: string; // the provider's own sentence, absent when it sent none
    explanation?: string; // the provider's explanation, shown verbatim
    safetyCategory?: string; // the provider's open safety category, such as "cyber" or "bio"
  };
  providerFailureDetail?: string; // populated on `run.failed` when failureCategory='provider': the provider's free-form failure prose, in its own field
  completionKind?: "turn" | "task"; // on `run.completed`: whether the completion closes a conversational turn or the whole task — optional in the shared shape only for pre-B1 history; post-B1 emitters MUST set it (Spec-005 §Run Lifecycle run-state payload)
  intendedClose?: true; // daemon-initiated closeSession clean-terminal discriminator: present only on that path, absent on every other terminal; consumers MUST NOT classify such a terminal as a crash (Spec-005 §Run Lifecycle "Intended-close discriminator")
  executionPosture?: ExecutionPosture; // named type in §Plan-003 above (same shape, shared with the CreateSessionParams/StartRunParams spawn/turn carriers). Stamped only on run.running — the post-setup-gate spawn-success transition, where the resolved workspace root and effective posture are final (Plan-002 gate seam; a run.starting stamp would be premature) — recording the run's effective sandbox/permission posture for audit (Spec-005 §Run Lifecycle run-state payload; shape owned by Spec-004, policy semantics per Spec-010 §Required Behavior). Optionality covers non-running rows only: run.running emitters MUST stamp the complete posture object — including credentialPolicyRef, which every run carries.
  trigger?: "step_limit" | "spend_limit" | "token_limit" | "workflow_phase_canceled"; // stop-condition provenance (additive per ADR-017): rides run.interrupted when the service stops a run itself, at the step limit, the spend limit or the token limit the person set (D-013-6), or because its workflow phase was canceled. Absent on natural completion and user-initiated paths. The console has no runs pane to render it in: a stopped run's cause is told on the working line, which is where a run is paused and interrupted, and in the transcript's own state-changing rows ([Spec-021 §Required Behavior](../../specs/021-desktop-app-and-renderer.md#required-behavior)).
  // A run's linkage and its admission stamps ride the run.queued row alone (RunQueuedPayload, §Plan-013),
  // never this stream.
  timestamp: string;
}

// Forward, NON-STATE conversation-cut event (Spec-005 §Run Lifecycle, its per-type row). Emitted when an
// undo's conversation cut lands — `session.restore` with a scope that includes the conversation; a
// files-only undo emits none. `targetPosition` is the daemon's own normalized position of the turn
// boundary the run landed at: the daemon and the provider adapter keep that position, and it never
// appears in the undo request, which names a message or a snapshot. Non-terminal — zero interaction with
// the at-most-once terminal backstop — and deliberately NO previousState/newState: a cut is not a state
// transition, and fabricating one would corrupt the transition stream consumers replay. Rides
// `run.subscribeState` alongside `RunStateChangeEvent` (the RPC table below).
interface RunRolledBackEvent {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number; // the progression value after the cut, which advanced it
  targetPosition: number; // the turn-boundary anchor the run landed at (normalized session position)
}

// Run-control mutations (Spec-003 §Required Behavior). `pause` interrupts the active run + persists conversation/run
// state + queues a resume (orchestration-layer, never driver-gated per I-002-9); `resume` returns the
// `paused` run to active execution with the SAME run id. Both carry a MANDATORY `expectedRunVersion`
// optimistic-concurrency guard with the SAME fail-closed semantics as InterventionRequestPayload: a stale
// comparand rejects the request (the run is left untouched), never silently applied. This
// EXTENDS Plan-002 D-002-2's mandatory-comparand obligation to these orchestration-layer verbs — `pause` /
// `resume` hold no InterventionType membership (ADR-011), so the guard binds them by deliberate extension,
// NOT by D-002-2's original intervention-only scope.
interface RunPauseRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
interface RunResumeRequest {
  targetRunId: RunId;
  expectedRunVersion: number;
}
// Shared pause/resume ack: echoes the post-transition run state + the advanced `runVersion`, so the
// caller threads the fresh comparand into its next guarded request without a round-trip to run.subscribeState.
interface RunControlAck {
  runId: RunId;
  newState: RunState;
  runVersion: number;
}

// Subscription request shapes. Both subscriptions are session-scoped: the canonical event stream is
// per-session (Spec-005) and ADR-001 makes the session the authorization unit, so a caller subscribes
// within a session it can reach and fans out per run client-side via RunStateChangeEvent.runId.
interface RunStateSubscribeRequest {
  sessionId: SessionId;
}
interface RunQueueSubscribeRequest {
  sessionId: SessionId;
  childHandle?: string; // a live child's own queue in place of the lead's
}

// A child's three controls: the session's own steer, interrupt and pause addressed at one live child
// (Spec-003 §Required Behavior). A child is addressed by the run it belongs to, `targetRunId`, PLUS
// `childHandle`, the provider's own handle for its subagent — never a bare child id. `childHandle` names
// only a provider's own subagent: a child the daemon bridges as a run of its own is steered, interrupted
// and paused through that run's own verbs. Each request carries the same guards as
// InterventionRequestPayload, on the run the child belongs to. A refusal is `run.child_control_refused`
// with `reason` `child_unknown` | `child_ended` | `provider_refused`, shared by all of them; a lost hold is
// a result, never a refusal.
interface RunChildSteerRequest {
  targetRunId: RunId;
  childHandle: string;
  content: string;
  expectedRunVersion: number;
  clientIdempotencyKey: string;
}
// A child's steer goes onto the child's own queue, held by the daemon, so it answers as a queue send does
// (QueueItemCreateResponse), and the child's pending rows take `Remove`, `Edit` and reorder as the lead's do.
interface RunChildInterruptRequest {
  targetRunId: RunId;
  childHandle: string;
  expectedRunVersion: number;
  clientIdempotencyKey: string;
}
// The pause toggle: `paused: true` takes the hold, and `paused: false`, the toggle's second press,
// answers the held callback with allow.
interface RunChildPauseSetRequest {
  targetRunId: RunId;
  childHandle: string;
  paused: boolean;
  expectedRunVersion: number;
  clientIdempotencyKey: string;
}
interface RunChildControlAck {
  targetRunId: RunId;
  childHandle: string;
}
interface RunChildPauseSetResponse extends RunChildControlAck {
  paused: boolean; // the hold as it now stands
  holdLost?: true; // present only when the held callback was canceled under the pause: the pause is LOST, never read as a release
}
// The one stop that reaches a subtree: every child under the run, at every depth, one stop per id
// walked from the daemon's own parent-to-child index, never relayed through the lead.
interface RunChildrenStopRequest {
  runId: RunId;
}
interface RunChildrenStopResponse {
  // One row per child the walk reached, so a failure is reported on its own row and never hides the rest.
  children: Array<{
    runId: RunId; // the run the child belongs to
    childHandle?: string; // absent for a child the daemon bridges as a run of its own
    outcome: "stopped" | "already_ended" | "failed";
    reason?: string; // present exactly when outcome = 'failed'
  }>;
}
```

### Run-Control Method-Name Registry

Plan-002's queue / intervention / pause-resume operations and a child's controls are exposed as the `run.*` methods registered here as the canonical wire contract; the ones that act on the lead's run are defined in Plan-002 (D-002-3 / CP-002-4); the reciprocal namespace `provides` is recorded on [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) (the `run.*` method-name owner) in the cross-plan dependency map. Method-name strings are `dotted-camelCase` per `METHOD_NAME_FORMAT`, defined in §Plan-005-Partial — Local IPC Daemon Control above — the `run.*` namespace token is the run-aggregate domain noun, distinct from the `run_lifecycle` **event** taxonomy in [Spec-005 §Run Lifecycle](../../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle) (the underscore form is a valid event name but is rejected as a method name by `METHOD_NAME_FORMAT`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `run.queueList` | `query` | `QueueItemListRequest` | `QueueItemListResponse` |
| `run.queueCreate` | `mutation` | `QueueItemCreateRequest` | `QueueItemCreateResponse` |
| `run.queueCancel` | `mutation` | `QueueItemCancelRequest` | `QueueItemCancelResponse` |
| `run.queueReorder` | `mutation` | `QueueItemReorderRequest` | `QueueItemListResponse` |
| `run.intervene` | `mutation` | `InterventionRequestPayload` | `InterventionRequestResponse` |
| `run.pause` | `mutation` | `RunPauseRequest` | `RunControlAck` |
| `run.resume` | `mutation` | `RunResumeRequest` | `RunControlAck` |
| `run.childSteer` | `mutation` | `RunChildSteerRequest` | `QueueItemCreateResponse` |
| `run.childInterrupt` | `mutation` | `RunChildInterruptRequest` | `RunChildControlAck` |
| `run.childPauseSet` | `mutation` | `RunChildPauseSetRequest` | `RunChildPauseSetResponse` |
| `run.childrenStop` | `mutation` | `RunChildrenStopRequest` | `RunChildrenStopResponse` |
| `run.subscribeState` | `subscription` | `RunStateSubscribeRequest` | `RunStateChangeEvent \| RunRolledBackEvent` (stream) |
| `run.subscribeQueue` | `subscription` | `RunQueueSubscribeRequest` | `QueueItemSummary` (stream) |

**What `run.pause` and `run.resume` realize, per provider.** Pause is a daemon feature, not a provider verb, and it writes no file. On a Claude Code lead it is two hooks registered in the session's `initialize` request and answered over the wire; on a child, on either provider, it is the daemon's pre-tool hook holding that child's next tool call, taken through the approval pipeline the daemon already owns; on a Codex lead it is the boundary interrupt. A hold ends only by an answer — allow from the resume, or deny carrying the person's typed words, which the child reads as its instruction — never by ending the hook, because any exit but a deny lets the held call run. The daemon sets the callback's timeout to a day on every hook it registers, so a hold is lossless: the held call simply goes unanswered, the leg burns no tokens and loses nothing. A cancellation of a held callback is treated as a LOST pause and never as a release. There is no separate "pause now" operation: `run.pause` and `run.resume` are the whole control, and a continue after a pause is a send rather than an operation of its own.

**A child's steer, interrupt and pause.** A live child gets the same three controls its session has, as calls of its own — `run.childSteer`, `run.childInterrupt` and `run.childPauseSet {paused}` — because the lead's steer and interrupt act on the lead; each rests on a provider-driver operation of its own beside the lead's. `run.childrenStop {runId}` is the one call that stops a subtree. What each satisfies:

- **The target.** A child's durable handle is the run it belongs to PLUS the provider's own child handle together, never a bare child id: `targetRunId` and `childHandle`, the task id from Claude Code's task-started frame or the thread id from Codex's turn-started frame, each persisted by the daemon at dispatch so a restart re-attaches every child by id. `childHandle` names only a provider's own subagent; a child the daemon bridges as a run of its own is addressed through that run's own verbs.
- **The mechanism, the same on both providers.** For a provider's own helper at any depth, a steer to a running child is the daemon's post-tool hook returning the words as added context aimed at that child — `agent_id` on Claude Code, the helper the hook input names on Codex — or, when it arrives as the child finishes, the continuation the helper-finish hook (`SubagentStop`) returns; the pause is the daemon's pre-tool hook holding the child's next call; the interrupt is that hold plus the end of its running command — never the provider's own stop-task tool; a steer to a held child answers the held call deny with the typed words; and a finished child is continued through its parent, which is asked to message it (`SendMessage` on Claude Code, `followup_task` on Codex). A steer lands at the child's next tool call, or as it finishes. Every helper a Codex agent starts is a multi-agent v2 helper, to which Codex refuses `turn/start` and `turn/steer`, so neither is ever sent to one; `turn/interrupt` reaches it.
- **The pause toggle.** `run.childPauseSet {paused: true}` takes the hold; `paused: false`, the toggle's second press, answers the held callback with allow. A cancellation of a held callback is a LOST pause, reported on the result as `holdLost`, never read as a release.
- **Support is learned, not declared.** The provider-support flags the session's init frame answers are the first reading; a control the provider then refuses is learned FROM THE REFUSAL and remembered per child, and the mechanism is never named to the person.
- **No fan-out.** An interrupt of one child reaches that child and nothing under it, and whatever dispatched it keeps running. The three stops that do reach a subtree — interrupt everything (`run.intervene {type: "interrupt"}` on the lead's run plus `run.childrenStop` on the same run), stop all running (`run.childrenStop`), and the undo's stop of the children started after its point — are one stop per id walked from the daemon's own parent-to-child index at every depth, never a relay through the lead, because neither provider's lead can stop a subtree. `run.childrenStop` reports each child's outcome on its own row, so one failure never hides the rest.

A refusal of any of the three is `run.child_control_refused`, with `reason` `child_unknown`, `child_ended` or `provider_refused`. Spec-003's V1 control set is the same three controls; these address them at a child.

`run.queueList` is the only `query` (idempotent read); the mutations are state-changing per the tRPC procedure-type convention in §Plan-025 — Remote Control Bootstrap above. The lead's interrupt is `run.intervene {type: "interrupt"}`, and the person's steer is always a queue send, `run.queueCreate`: an edit of a waiting message is one `run.queueCreate` carrying `replacesQueueItemId`, and a new order is one `run.queueReorder`, never a client's cancel and resend. The `subscription`s stream their payload type per emission rather than returning a single response — `run.subscribeState` streams `RunStateChangeEvent | RunRolledBackEvent | RunSafetyBufferingUpdatedPayload` (the last is Codex's live safety-check hold, never appended; the state shape carries the `runVersion` comparand clients pass back as `expectedRunVersion`; the per-type non-state rollback arm — [Spec-005 §Run Lifecycle (run_lifecycle)](../../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle) — rides the same stream so subscribers observe position rewinds without a fabricated transition), and `run.subscribeQueue` streams the existing `QueueItemSummary` projection (no separate queue-change event type is introduced). All request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/src/run-control.ts` (CP-002-3) per the §Source-of-Truth Policy.

### Plan-025 — Remote Control Relay

```ts
// RelayNegotiation — one relay connection per device key and one per machine key. No session appears
// here: one channel joins one device and one machine and carries every session on that machine.
interface RelayNegotiationRequest {
  nodeId: NodeId; // the machine the connection reaches: the caller's own machine, or the machine a device opens its channel to
  transportPreferences: string[]; // e.g. ['websocket', 'http2']
}
interface RelayNegotiationResponse {
  relayEndpoint: string; // the WSS URL the caller dials
  transportProtocol: string;
  connectionToken: string; // short-lived connect token bound to the calling device or machine and to the machine it reaches; a token presented for another device or machine is refused, and an expired one is refused
  ttl: number; // seconds
}

// The control plane keeps no presence record and no session. Whether a device is connected is read
// from its relay connection onto `device.list` (§Device, Statement Chain And Push Method
// Registry). After a reconnect the
// device runs a fresh handshake on its channel and reopens its sessions over it, each stream resuming
// from its last event through the machine's own `session.*` methods.
```

**The channel.** Each channel is the Noise Protocol Framework's `Noise_KK_25519_ChaChaPoly_SHA256` handshake and transport, run afresh on every connection and every 10 minutes on a long one ([Spec-027 §The encryption envelope](../../specs/027-remote-control.md#the-encryption-envelope)). The connection's first frame, before any handshake message, is `{channelVersion, profiles}`: the channel version and the profiles the connecting device runs, in its order of preference. The machine answers `{profile}`, the first of them it also runs, or closes the connection with `channel.no_common_profile` ([Error Contracts §Relay](./error-contracts.md#relay)), with nothing to fall back to. Both ends bind the offer and the answer into the handshake's prologue. A profile is one full Noise protocol name, and there is one, `Noise_KK_25519_ChaChaPoly_SHA256`. The first frame's shape, the profile names and `channel.no_common_profile` are wire, so they live in `packages/contracts`, and the shared channel package, which holds the handshake and the transport, imports them.

### Plan-015 — Identity And User State

```ts
// UserProjectionRead
interface UserProjectionReadRequest {
  sessionId: SessionId;
}
interface UserProjectionReadResponse {
  user: UserProjection;
}

interface UserProjection {
  userId: UserId;
  displayName: string;
}

// UserStateUpdate
interface UserStateUpdateRequest {
  userId: UserId;
  displayName?: string;
  metadata?: Record<string, unknown>;
}
interface UserStateUpdateResponse {
  userId: UserId;
  updatedAt: string;
}
```

### User Method-Name Registry

Plan-015's identity / user-state reads and updates are exposed as `user.*` methods (Plan-015 CP-015-3). The reciprocal `provides` is recorded on [Plan-005](../../plans/005-local-ipc-and-daemon-control.md). Same `dotted-camelCase` `METHOD_NAME_FORMAT` as the other namespaces above.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `user.projectionRead` | `query` | `UserProjectionReadRequest` | `UserProjectionReadResponse` |
| `user.stateUpdate` | `mutation` | `UserStateUpdateRequest` | `UserStateUpdateResponse` |

`user.projectionRead` returns the user's id and display name and carries no device presence. Which devices are connected is a fact of the device cards on the Devices page in Settings, which read each device's connected state and last-seen time from the live `device.list`, and each machine reports the devices connected to it through its own `presence.read {}` and `presence.subscribe {}`. `user.stateUpdate` is the one mutation. Every method's daemon-side responder is authored (T4.5) per the D-015-3 no-method-without-responder rule. Canonical Zod schemas live in `packages/contracts/` per the §Source-of-Truth Policy.

### WebAuthn Ceremony Procedure Registry

These are **control-plane tRPC procedures on the control plane's tRPC router** (§Plan-025 — Remote Control Bootstrap), not daemon JSON-RPC methods. Their callers are the web client, the phone apps and the device-code page, where the platform offers passkeys: the desktop app carries no WebAuthn, so no passkey is added or used from it. No method string is minted, and Plan-015's I-015-4 daemon-as-gateway rule is untouched. The table holds **the ceremony operations and the credential-lifecycle operation**.

| Operation | Procedure type | Authentication | Request schema | Response schema |
| --- | --- | --- | --- | --- |
| `WebAuthnRegistrationOptionsIssue` | `mutation` | required; **none** for account creation on the device-code page, which sends `{userCode, displayName}` in place of a session and receives the creation options with a `transactionId` (below) | `WebAuthnRegistrationOptionsIssueRequest` | `WebAuthnRegistrationOptionsIssueResponse` |
| `WebAuthnRegistrationVerify` | `mutation` | required: it adds a passkey to an account that exists; account creation's registration is verified by the device-code Approval row's creation arm (below) | `WebAuthnRegistrationVerifyRequest` | `WebAuthnRegistrationVerifyResponse` |
| `WebAuthnAuthenticationOptionsIssue` | `mutation` | **none** | `WebAuthnAuthenticationOptionsIssueRequest` | `WebAuthnAuthenticationOptionsIssueResponse` |
| `WebAuthnAuthenticationVerify` | `mutation` | **none** | `WebAuthnAuthenticationVerifyRequest` | `WebAuthnAuthenticationVerifyResponse` |
| `WebAuthnCredentialRevoke` | `mutation` | required | `WebAuthnCredentialRevokeRequest` | `WebAuthnCredentialRevokeResponse` |

Both issue legs are `mutation` rather than `query` because each one **writes** — it records a challenge row, which is the fence the whole ceremony rests on.

**The authentication pair is deliberately unauthenticated.** Sign-in is pre-authentication by construction: the ceremony is what produces the credential, so a new phone or browser holds nothing to present, and gating it would make the flow unreachable exactly when it is needed ([Spec-016 §Required Behavior](../../specs/016-identity-and-user-state.md#required-behavior)). What bounds that caller instead is the **ceremony transaction id** — server-minted on the options reply, quoted back on the verify request, single-use, and expiring on the challenge's own clock, so the caller is bound to one transaction rather than to a session. Throttling is the existing [Spec-019 §Canonical Endpoint Group Registry](../../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry) `auth.endpoint` row (per source address); **no registry row is minted**, because a per-token budget beside the per-source one would have nothing to bound here, single-use consumption already capping attempts per transaction at exactly one. The registration pair stays authenticated: enrollment binds an authenticator to an existing user, and an unauthenticated enrollment would let anyone bind a key to someone else's account. **Account creation is the one exception.** `Create an account` on the device-code page makes a new account and adds nothing to one that exists, so it needs no sign-in: its registration is bound to the device-code transaction the page was opened with, good once, and limited per source address under the same `auth.endpoint` row as the passkey sign-in. Adding a passkey to an account that exists stays signed in. **`WebAuthnCredentialRevoke` is authenticated for the same reason and one more:** it resolves the credential row under the **caller's own** user id, which there is no way to know without a session. That resolution is also what makes the operation safe to expose — a request naming another user's credential id deletes nothing and returns success, exactly as a request naming an id that does not exist does, so the reply enumerates no one's authenticators. Revocation is a hard `DELETE` rather than a `revoked_at` tombstone: a tombstone would let the verify leg tell _revoked_ from _unknown_, the one distinction every refusal arm of this registry is written to withhold, and it would mint a column to obtain it. Removing the user's **last** credential is permitted — a new device still links through a link from a device already in use, and refusing would keep a compromised authenticator enrolled precisely when the user is trying to retire it.

**What the replies carry, and why the split is where it is.** The authentication-**options** reply carries the `rpId`, the origin, the challenge, and the transaction id. The authentication-**verify** reply carries the verdict and a **freshly issued PASETO access/refresh pair**. The token pair rides the verdict because that is the moment the user is known, and it is issued rather than merely unlocked because a new device holds no refresh token to unwrap — a sign-in that only unlocks a stored one is unreachable exactly on the device that needs it. It is sender-constrained per [ADR-010](../../decisions/010-tokens-passkeys-and-the-remote-channel.md) to the DPoP key the caller proves possession of on the verify request; that proof binds a key and establishes no identity, so it does not make this pair a credentialed one and the `Authentication` column above stays **none**.

**Which DPoP proof, and why the shipped validator cannot serve this route.** [RFC 9449](https://datatracker.ietf.org/doc/html/rfc9449) defines two proof forms, and this route needs the one the corpus has not implemented. A **token-request** proof ([§5](https://datatracker.ietf.org/doc/html/rfc9449#section-5)) accompanies a request _for_ a token and carries no `ath`, because no access token exists yet. A **resource-request** proof ([§4.3](https://datatracker.ietf.org/doc/html/rfc9449#section-4.3)) accompanies a request that _presents_ one and **requires** `ath`, the hash of that token — which is the form every already-credentialed path in this corpus validates, including the CP-015-7 daemon credential seam. Pointing that validator at `WebAuthnAuthenticationVerify` would reject every legitimate sign-in for a missing `ath`; relaxing the check instead would accept a proof minted for some other request. So the verify leg validates the §5 form on its own terms: `typ` `dpop+jwt`, `htm` and `htu` matching this request's method and URI, `iat` inside the accepted window, a single-use `jti`, an embedded public `jwk` of a permitted algorithm carrying no private parameters, a signature verifying under that `jwk` — and **`ath` required to be absent** rather than merely unchecked, so an oversupplied proof is refused rather than accepted-and-ignored. The issued pair's `cnf.jkt` is the JWK SHA-256 thumbprint of that same key and is computed from the proof, never taken from a separate claim the caller makes; without that the route would hand an unauthenticated caller a bearer pair. A missing, malformed, replayed, or `ath`-bearing proof refuses the whole verification and issues nothing (Plan-015 I-015-11 / T6.3).

Refusals are `user.webauthn_challenge_invalid` (400) for an unknown, consumed, or expired challenge or transaction id, and `user.webauthn_verification_failed` (400) for every verification arm — bad signature, wrong origin, wrong `rpId`, UV mismatch, regressed counter — so the reply is no oracle for which check failed.

### Hosted Account Route Registry

The control plane's account routes that `sidekicks sign-in`, `sidekicks sign-out` and `sidekicks delete-account` run, the service's token trade, and the reply the data export writes as `hosted-account.json`. They are control-plane routes, never daemon methods; the device-code sign-in follows the OAuth 2.0 Device Authorization Grant ([RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628)). The shapes are in `packages/contracts/src/account.ts` and the unit's refusal codes in `packages/contracts/src/error.ts`, each landing with the task that builds it ([Plan-015](../../plans/015-identity-and-user-state.md) T5.4, T5.5).

| Route | Caller | Authentication | Request | Reply |
| --- | --- | --- | --- | --- |
| Device authorization | `sidekicks sign-in` | none | the RFC 8628 device authorization request | a device code, a user code and the verification address; the command line prints the code and the address, opens the address where a browser exists, and polls the token route (T5.4) |
| Approval | the device-code page at the verification address | a passkey assertion; for `Create an account`, none: the new account's first passkey registration, bound to this device-code transaction, good once, and limited per source address under `auth.endpoint` like the passkey sign-in | `{userCode, transactionId, assertion}`, the assertion answering `WebAuthnAuthenticationOptionsIssue`; for `Create an account`, `{userCode, transactionId, attestation}`, the attestation answering `WebAuthnRegistrationOptionsIssue`'s creation options, and the user record, its first passkey and the approval commit in one transaction | approves the code for the account the passkey belongs to, or for the account `Create an account` made, and carries no token, so the page keeps nothing in the browser; refuses with `user.webauthn_challenge_invalid` or `user.webauthn_verification_failed` as the verify leg does, and an unknown or expired user code with the unit's own code (T5.4) |
| Token | `sidekicks sign-in`, polling | the device code, with a DPoP proof under this machine's key | the device code | a refresh token bound to the proved key (`cnf.jkt`, that key's JWK SHA-256 thumbprint); `authorization_pending` until the code is approved or expires (T5.4) |
| Enrollment | `sidekicks sign-in` once the refresh token is issued, and a removed machine linked again once its new key's statement is on the chain | an access token with a DPoP proof | the machine's id, the identity key's public half, its name, its platform and the installed service's version | writes the machine's `runtime_nodes` row under the account; refuses a different key for a machine already enrolled unless a later `runtimenode.added` for that id is on the chain (T5.4) |
| Trade | the service, through its credential provider | the refresh token, with a DPoP proof under the same key | the refresh token | a short-lived PASETO v4.public access token and a new refresh token of the same family, the presented one marked spent; a spent refresh token presented again revokes the whole family (T5.4) |
| Sign-out | `sidekicks sign-out` | the signed-in machine's tokens | none | revokes the refresh-token family; the refresh token has no expiry of its own and lasts until sign-out or revocation (T5.4) |
| `account.delete` | `sidekicks delete-account` | the signed-in account | none | revokes every refresh-token family of the account, hard-deletes the account's rows through [Spec-020 §Erasure Paths](../../specs/020-data-retention-and-gdpr.md#erasure-paths) Path 2, and returns; a second call returns the same result and deletes nothing more; the command line then signs this machine out (T5.5) |
| `account.export` | the data export ([Plan-019](../../plans/019-data-retention-and-gdpr.md)) | the signed-in account | none | the account record and its device list, written as `hosted-account.json`; changes nothing (T5.5) |

---

## Plans 006, 007 And 009

### Plan-006 — Repo Attachment And Workspace Binding

```ts
// Plan-006 shared shapes (D-006-2 / D-006-4) — canonical origin
// packages/contracts/src/repo.ts; Plan-007 imports these per Plan-006 CP-006-1.
// A project is a git repository: `repo.attach` refuses a folder that is not one, and a chat's own
// workspace is git-initialized from its first byte, so there is no non-git kind.
type VcsType = "git";
// Derived projection, never persisted — Spec-007 §Repo Mount Health (V1 Definition).
// "identity_mismatch": root reachable but the re-derived common directory no longer
// equals the attach-persisted anchor (repo_mounts.metadata.commonDir); "unreachable"
// takes precedence; re-attach is the recovery (additive-on-unshipped:
// widened before any Phase-3 wire consumer).
interface RepoMountHealth {
  status: "healthy" | "unreachable" | "identity_mismatch";
  checkedAt: string; // ISO-8601 instant of the probe that produced the verdict
}
// repo.mount_health_changed — sent by the daemon's re-probe on the stream of every session on the
// mount whenever the verdict changes; the session's lost-folder banner reads it (Spec-007 §Fallback
// Behavior).
interface RepoMountHealthChangedPayload {
  repoMountId: RepoMountId;
  health: RepoMountHealth;
}

// RepoAttach — a mount belongs to the machine, not to one session: attach makes the project's one mount
// and no workspace. A session reaches the mount by binding to it — in the same step as `session.create`
// for a new session, through `repo.workspaceBind` for a converted chat. The mount's node is the daemon's
// own, stamped by the daemon and never taken from a caller. A folder that is not a git repository is
// refused; the repository is keyed by its git common folder, so attaching a linked worktree's folder
// finds the repository already attached.
interface RepoAttachRequest {
  // On the machine itself the path comes from the platform's own folder chooser, whose token the main
  // process's relay turns into a path; from another device it is the path of the folder `repo.folderList`
  // showed.
  localPath: string; // user-entered path (provenance; persisted as repo_mounts.local_path)
}
interface RepoAttachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState;
  vcsType: VcsType;
  canonicalRoot: string; // resolver output (absolute, symlink-resolved), never the echoed input
}

// RepoMountRead
interface RepoMountReadRequest {
  repoMountId: RepoMountId;
}
interface RepoMountReadResponse {
  id: RepoMountId;
  nodeId: NodeId; // the daemon's own node id, stamped at attach — never taken from a caller
  // What the mount is: `attached`, a project's folder; `managed`, a chat's own workspace; `worktree`, a
  // worktree the app made, under its project.
  origin: "attached" | "managed" | "worktree";
  managedSessionId?: SessionId; // present exactly when origin = 'managed': the one chat whose workspace this is
  usedBySessionIds: SessionId[]; // the sessions bound to this mount now — one mount serves every session in its project
  localPath: string; // user-entered provenance
  canonicalRoot: string; // resolver output — the trust-envelope and dedupe key
  vcsType: VcsType;
  state: RepoMountState;
  health: RepoMountHealth; // derived projection (defined above), never persisted
  attachedAt: string;
}

// RepoDetach (Plan-006 D-006-6; Spec-007 §Detach Semantics)
interface RepoDetachRequest {
  repoMountId: RepoMountId;
}
interface RepoDetachResponse {
  repoMountId: RepoMountId;
  state: RepoMountState; // 'detached' — terminal; re-attach creates a new mount row
  archivedWorkspaceIds: WorkspaceId[]; // dependent workspaces archived by the cascade
}

// WorkspaceBind — binds one session to its project's mount and to where it works: a worktree of its own
// (`provisioned-worktree`) or the checkout the project already has (`bound-root`). A new session binds in
// the same step as `session.create`; this call serves a converted chat, and it checks, once, that the
// picked folder belongs to the project.
interface WorkspaceBindRequest {
  sessionId: SessionId;
  repoMountId: RepoMountId;
  executionMode: ExecutionMode;
  directory?: string; // relative: subdirectory under the mount canonical root; absolute: names a working tree git lists for the mount's repository (Spec-007 trust-envelope rule) — containment re-checked after symlink resolution either way
}
interface WorkspaceBindResponse {
  workspaceId: WorkspaceId;
  // No root in this answer. A client reads the bound root from the workspace's `fsRoot` in `WorkspaceListResponse` once `workspace.ready` arrives: the EXACT ADMITTED RESOLVED DIRECTORY the bind requested — `directory` resolved against the mount canonical root for the relative form, taken as supplied for the absolute form, symlink-resolved and admitted by containment within an admitted root; equal to a containing root only when the bind names the root itself.
  executionMode: ExecutionMode;
  state: WorkspaceState;
}

// WorkspaceList
interface WorkspaceListRequest {
  sessionId: SessionId;
  repoMountId?: RepoMountId; // filter
}
interface WorkspaceListResponse {
  workspaces: Array<{
    id: WorkspaceId;
    repoMountId: RepoMountId;
    executionMode: ExecutionMode;
    state: WorkspaceState;
    fsRoot?: string;
    lastError?: string; // present iff state = 'stale' from a recorded failure (workspaces.metadata.lastError, Spec-007 §State And Data Implications)
  }>;
}
```

### Repo Method-Name Registry

Plan-006's repo-attachment and workspace-binding surface is exposed as `repo.*` methods (Plan-006 D-006-1, CP-006-5). Names register under the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out, and each name matches the `METHOD_NAME_FORMAT`. These methods ride the daemon JSON-RPC transport only — repo mounts and workspaces are node-local filesystem state (ADR-004), so no control-plane tRPC sibling exists. Method strings are imperative and disjoint-by-form from the past-participle Spec-005 durable event names (`repo.attached`, `repo.detached`).

| Method               | Procedure type | Request schema         | Response schema         |
| -------------------- | -------------- | ---------------------- | ----------------------- |
| `repo.attach`        | `mutation`     | `RepoAttachRequest`    | `RepoAttachResponse`    |
| `repo.mountRead`     | `query`        | `RepoMountReadRequest` | `RepoMountReadResponse` |
| `repo.workspaceBind` | `mutation`     | `WorkspaceBindRequest` | `WorkspaceBindResponse` |
| `repo.workspaceList` | `query`        | `WorkspaceListRequest` | `WorkspaceListResponse` |
| `repo.detach`        | `mutation`     | `RepoDetachRequest`    | `RepoDetachResponse`    |

Canonical Zod schemas live in `packages/contracts/src/repo.ts` per the §Source-of-Truth Policy.

Plan-007's worktree surface adds further `repo.*` methods (Plan-007 D-007-3) — the same namespace, not a new root, because the namespace-root enumeration admits `repo` and mounts, workspaces and worktrees form one repo aggregate — and the session move `session.setWorkingFolder`, which registers on the session root (§Session Method-Name Registry). A session's place is chosen in `session.create` or `repo.workspaceBind`, so no mode select exists, and a worktree's figures ride `repo.worktreeStatusRead`, so no reuse check exists. Registration rides the same Plan-005-partial `MethodRegistry` path. Method strings stay imperative and disjoint-by-form from the past-participle Spec-005 durable event names (`worktree.created` through `worktree.retired`).

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `repo.executionRootPrepare` | `mutation` | `ExecutionRootPrepareRequest` | `ExecutionRootPrepareResponse` |
| `repo.worktreeRetire` | `mutation` | `WorktreeRetireRequest` | `WorktreeRetireResponse` |
| `repo.worktreeStatusRead` | `query` | `WorktreeStatusReadRequest` | `WorktreeStatusReadResponse` |

Canonical Zod schemas for these pairs live in `packages/contracts/src/worktree.ts` (Plan-007 D-007-1) per the §Source-of-Truth Policy. The others — `repo.removedWorktreeList`, `repo.worktreeRestore`, `repo.removedWorktreeDelete`, `repo.worktreeSetupSubscribe`, `repo.worktreeSetupRetry`, `repo.branchList` and `repo.workingTreeSubscribe` — are listed in [§Operations Not Yet Built](#operations-not-yet-built), and their schemas land in the same file with the unit that builds them.

**The worktree-candidate read is `repo.worktreeStatusRead`, widened rather than joined by a sibling.** The switcher's rows need ahead, behind, dirtiness and occupancy per candidate directory; those members are above, on that read's own worktree rows. One read rather than two is the contract, not a convenience: a switcher composing its rows from a status read and a separate counts read could draw a directory as free while another read called it occupied, and the trash lock is exactly the affordance that must never be wrong.

**The tree-staleness signal is the daemon's, never the pane's inference.** The daemon watches the session's working folder and emits the signal; Review draws a reload affordance from it and re-reads nothing until the person presses. A working folder too large for the machine's own watch limit is checked on a slow tick instead, and the signal says which mode produced it, because a stale mark that is slow to arrive must not read as a tree that never changed. The bound is read from what the machine's watch limit allows and is never a figure on a screen.

**The worktree records the console depends on.** Creating and removing a worktree each leave a durable record under one category, so those rows survive a reload; a removal additionally leaves a PER-SESSION record for each session it swept back to the repo root, because the sweep changes where that session is standing and the session's own flow has to say so. Removal clears every pending working-folder move pointing at the removed tree, is refused while an agent is running in it, and never stops a run. The lifecycle records are `worktree.created` and `worktree.retired`, and the per-session one is `session.swept_to_repo_root`; the taxonomy census is [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s, and what is fixed here is that these records exist and what each carries.

**Removing a worktree keeps what it discards.** `repo.worktreeRetire {worktreeId, discard}` is the one removal of a worktree the app made, from the worktree switcher and from Runtime's `Remove`; a project's own folder is removed only by `repo.detach`. `discard: false` is the ordinary removal: when the tree has something to lose that the confirm did not show, it is refused with `worktree.retire_conflict`, whose `reason` is `root_busy` or `has_changes` and, for `has_changes`, carries the current risks so the confirm redraws them; ignored files such as an `.env` count as something to lose. `discard: true` is sent only after the discard confirm, and the daemon keeps what it discards until the person deletes it: the tree's own shells and project processes end first, then the folder moves whole into `worktrees/<project>/.removed/`, git's per-worktree record is copied, the staged objects are packed, the large-file objects staged pointers name are kept, and every commit the kept record names is pinned under `refs/sidekicks/removed/<id>/`. That removal's result carries `kept: {removedWorktreeId}`, and its `worktree.retired` record carries the same `removedWorktreeId`. Nothing deletes a kept worktree on its own. `repo.removedWorktreeList {projectId?}` lists the kept worktrees for Runtime, each row `{removedWorktreeId, projectId, name, branch, headCommit, removedAt, sizeBytes, sizeReadAt}`. `repo.worktreeRestore {removedWorktreeId}` is `Put back`, from the switcher, the swept sessions' flow row and Runtime: the tree goes back on its own branch when that branch still points at the recorded commit and no other worktree holds it, and otherwise on `<branch>-restored`; it answers `{worktreeId, path, branch, onNewBranch}` or a refusal with its `reason`, and records `worktree.created` with `restoredFrom`. `repo.removedWorktreeDelete {removedWorktreeId}` is `Delete now`, which removes the kept folder and its pins.

**Project administration.** A project is its own durable record kept beside its mount: its display name, its archived mark, its worktree setup steps, its own environment rows and its own branch-name pattern. `repo.projectList` is the live list the sessions list's project headers and Settings › Projects read, so a project attached on another device appears at once. The actions on a project's row:

- **Rename** is `repo.projectRename`: it sets the display name and leaves the folder on disk untouched. It is the only name a person types for a project; the folder's own basename stands until they do.
- **Open in editor** is the bridge's `native.openInEditor`, which opens the project's folder in the editor Settings › General names.
- **Archive** is `repo.projectArchive`: it takes the project out of the session list's grouping and into an archived group carrying one action, unarchive; its sessions are kept and come back with it. **Unarchive** is `repo.projectReactivate`, the inverse, which restores the grouping.
- **Delete** is `repo.detach`, the project's one removal act and the same act as Runtime's `Remove` on the project's folder. It is refused only while an agent runs anywhere in the project. It takes the project out of the projects page and out of the session list, forgets its setup steps and its branch-name pattern, and ARCHIVES its sessions, which stay readable. Nothing on disk is touched and it is not undoable, which is why the confirm states all three facts before it acts.
- **The setup steps** are written through `repo.projectSetupUpdate`: a per-project recipe — files to copy, commands to run in order, and a time limit — read and written from the projects page. They run with the repository's own git config, its hooks included, raise no approval card at any permission level, and make no approval rule. They are the person's own list on this machine rather than a file inside the repository.
- **The environment rows** are two lists. The machine-wide list is passed to every process the app starts and belongs to the machine's settings file; a project's own list, written through `repo.projectEnvironmentUpdate`, is passed to every process that project's sessions start and belongs to the project record. A name in a project's list WINS over the same name machine-wide. The daemon reads both lists when it starts a project's process. A credential-shaped name is refused at save, in the list it was typed into, and nothing is written — credentials live in the account's credential home, never in an environment row — and so is a name the app sets itself on the processes it starts.
- **The branch-name pattern** is written through `repo.projectBranchPatternUpdate {projectId, pattern | null}`, `null` returning the project to the machine's own pattern.

**Cloning from a URL.** `Clone repository…` in the new-session picker clones a repository and attaches the finished folder as `Open folder…` attaches one; the session is minted at once. `repo.cloneFolderRead {}` → `{folder, source: setting | lastProject | home}` is the one answer to where a clone goes: the folder `Clone new repositories into` on Settings › Projects names (a key in the machine's settings file), else the folder holding the most recently attached project, else the home folder. `repo.clone {url, parentFolder?, projectId?}` → `{projectId}` creates the project record at once, marked as cloning, and a `projectId` reruns a failed or canceled clone of that project. The address or path the person typed goes to git as typed, and git's own transport rules decide; submodules are included, and a destination that exists and is not empty is refused before anything is fetched. The daemon runs git as an argument list with the person's own git config and credentials, stores no credential, and routes git's questions — a user name, a password or token, a key's passphrase, whether to trust a host's key — through its own askpass program to the clone card in the composer. `repo.cloneSubscribe {projectId}` streams the card's state — the phase, the percent, a question waiting, the failure line in git's own words, and done — at most four updates a second, the latest winning; `repo.cloneAnswer {projectId, questionId, answer}` answers git's question, and the answer goes to git and nowhere else; `repo.cloneCancel {projectId}` stops git and removes the folder the clone made before the card offers `Clone` again. Where the cloned repository keeps large files in Git LFS and Git LFS is not installed, `repo.largeFilesPull {projectId}` fetches them once it is. A finished clone ends in the daemon's ordinary attach, `repo.attached`, which the sessions list reads through `repo.projectList`.

### Plan-007 — Worktree Lifecycle And Execution Modes

```ts
// Branded IDs introduced by Plan-007 (canonical origin: packages/contracts/src/worktree.ts;
// declared in-block rather than under §Branded ID Types / §Shared Enums for cite stability)
type BranchContextId = string & { readonly __brand: "BranchContextId" };

// ExecutionRootPrepare — materializes (or binds) the execution root for the workspace's selected mode.
// Wire-initiated prepares are pre-run by definition; the run-setup gate calls the service directly,
// supplying the run id that populates worktrees.created_by_run_id + run_execution_contexts.
interface ExecutionRootPrepareRequest {
  workspaceId: WorkspaceId;
  branchName?: string; // REQUIRED for a provisioned-worktree prepare on the wire (pre-run, no slug-rule seed; absent → typed workspace.branch_name_required refusal); the run-setup gate derives per the Spec-008 slug rule service-side (Plan-007 D-007-18)
  baseRef?: string; // worktree base; default = mount HEAD branch; detached HEAD without baseRef → typed refusal
  carryUncommitted?: boolean; // carry the current checkout's uncommitted work into the new worktree
}
interface ExecutionRootPrepareResponse {
  executionRoot: string;
  state: WorkspaceState;
  worktreeId?: WorktreeId; // set exactly for provisioned-worktree
  branchContextId?: BranchContextId; // set for both modes (Spec-008 §State And Data Implications)
}

// WorktreeRetire — records retirement; disk cleanup is asynchronous (cleaned_at stamps it). `discard:
// false` is the ordinary removal, refused when the tree has something to lose the confirm did not show;
// `discard: true` is sent only after the discard confirm, and the daemon keeps what it discards
// (§Repo Method-Name Registry above).
interface WorktreeRetireRequest {
  worktreeId: WorktreeId;
  discard: boolean;
}
interface WorktreeRetireResponse {
  worktreeId: WorktreeId;
  state: Extract<WorktreeState, "retired">;
  kept?: { removedWorktreeId: string }; // present exactly on a `discard: true` removal: the kept copy `Put back` restores
}

// WorktreeStatusRead — daemon-owned read surface over worktree records incl. provenance
// (Spec-008 §Interfaces; feeds the execution-mode-picker status view)
interface WorktreeStatusReadRequest {
  sessionId: SessionId;
  repoMountId?: RepoMountId;
}
interface WorktreeStatusReadResponse {
  worktrees: Array<{
    worktreeId: WorktreeId;
    repoMountId: RepoMountId;
    branchName: string;
    fsRoot: string;
    state: WorktreeState;
    createdBySessionId: SessionId;
    createdByRunId?: RunId;
    createdAt: string;
    updatedAt: string;
    cleanedAt?: string; // async disk-cleanup stamp; absent until the sweep runs (local-sqlite `cleaned_at`)
    // ---- The candidate facts the worktree switcher draws ----
    // ONE read serves ahead, behind, dirtiness and occupancy per candidate directory, on this
    // existing repo surface rather than a second one, so the switcher never composes a picture from
    // several reads that can disagree. The daemon keeps them true with a background fetch — every few
    // minutes while a session on the project is live, under the person's own git identity, never
    // pulling and never pruning.
    //
    // Commits reachable from this worktree's branch and not from its upstream, and the converse.
    // Unpushed means not reachable from ANY remote-tracking branch of this folder, which is local
    // knowledge and never a hosting read.
    aheadCount: number;
    behindCount: number;
    // Uncommitted files in the directory. A count rather than a flag, because the removal confirm
    // names what would be lost concretely.
    dirtyFileCount: number;
    // The sessions standing in this directory. Occupancy is why a removal is refused and why the
    // trash names its occupant, and it is the daemon's answer rather than a renderer-side tally: two
    // sessions may share a worktree, exclusivity applying at the run step and not at attach.
    occupyingSessionIds: SessionId[];
    // When the background fetch that produced `aheadCount` and `behindCount` last succeeded. Present
    // whenever the LAST attempt failed, so the figures stay as they were and the row can say `as of
    // <time>` instead of silently reading stale numbers as current; absent means the figures are from
    // the latest attempt and it succeeded.
    countsAsOf?: string;
  }>;
}

// session.swept_to_repo_root payload (Spec-005 §Repo, Workspace, and Worktree Lifecycle). A sweep is not
// a state transition: it records that this session's working folder is now the repository root because the
// worktree it was attached to was removed. `worktreeId` names the REMOVED tree, and `pendingMoveCleared`
// is present only where the same removal cleared a pending working-folder move that pointed at it — the
// presence-discriminator idiom, absent rather than `false`. One event is appended per session the removal
// moved, so each moved session's own flow row survives a reload.
interface SessionSweptToRepoRootPayload {
  sessionId: SessionId;
  repoMountId: RepoMountId;
  worktreeId: WorktreeId;
  pendingMoveCleared?: true;
}
```

### Plan-009 — Approvals Permissions And Trust Boundaries

```ts
// Plan-009 shapes (D-009-1/D-009-3) — canonical origin
// packages/contracts/src/approval.ts. PermissionCheck, whose two shapes live in the daemon
// (`packages/runtime-daemon/src/policy/`, beside the permission check), is a daemon-internal API
// (Spec-010: "inside the local daemon"); it has no JSON-RPC method string and no
// SDK surface in V1 (D-009-5; the in-process check is the composed enforcement
// gate per D-009-18 — evaluate, then on an ask-policy outcome create the request
// via the approval service (whose create persists and emits `approval.requested` —
// the single emission seam), and notify the run-blocking seam before returning).

type RememberedRuleId = string & { readonly __brand: "RememberedRuleId" }; // → §Branded ID Types

// The rule an approval hands to the provider — explicit enum, not free-form (Spec-010 §Interfaces And
// Contracts). `request_only` (Spec-010 §Default Behavior) is expressed by OMITTING rememberedScope,
// never by an enum member. The subject is the one the daemon derived from the ask and the card
// displayed (D-009-10): a command's program and first subcommand; a network request's host; a written
// file's name. The provider keeps the rule and answers by it, at every level that asks; the daemon keeps
// no rule store, and the session's own answers are its record.
interface RememberedScope {
  // 'session' = the provider's session rule, which the card's middle button makes by being pressed:
  // Claude Code's session flag settings (`apply_flag_settings {permissions}`), Codex's `acceptForSession`.
  // 'project' = the provider's project rule file, which the same button's own arm writes: Claude Code's
  // `.claude/settings.local.json` through the answer's `destination: "localSettings"`, Codex's
  // `.codex/rules/sidekicks.rules`, written by the daemon and listed in the repository's `.git/info/exclude`.
  kind: "session" | "project";
  pattern: string; // the subject the daemon derived from the ask and the card displayed; re-derived at resolve, and an echoed pattern that differs is refused
  // Allow or block. A block is the `network_access` decline's own rule — the host is refused with NO
  // card raised until the rule is replaced — so the rule set is two-sided and
  // a decline is not merely the absence of a grant. REQUIRED rather than defaulted: a missing sense
  // would have to read as `allow`, and a silently-widened block is the one reading a permission rule
  // must never take.
  sense: "allow" | "block";
}

// Why a rule ended: the person revoked it, its session (the provider's own session) ended, or the tool
// server whose tool it covers was removed. A project's rules live in the project's own folder and stay
// with it.
type InvalidationTrigger = "explicit" | "session_end" | "server_removed";

// approval_flow event payload for six of the `approval.*` variants — `requested`, `approved`, `rejected`,
// `canceled`, `remembered`, `rule_revoked` (Spec-005 §Approval Flow; mirror of the canonical
// Zod schema). The variants carry the projection-rebuild fields (D-009-6 replay
// rebuild; D-009-7 events-canonical): `requested` carries the request fields; the
// resolution events carry the answering device + effective scope; `remembered`
// carries the rule the answer handed to the provider (binding = `rememberedScope`, origin
// resolution via `approvalRequestId`), the session's own record of it, which the daemon lists and
// carries across a restart of the provider's process; decision and state ride
// the event type; envelope timestamps supply the created/updated instants. The other
// members of the same category have payloads of their own and are not this shape:
// `moderation.review_flagged`, `approval.reviewer_denied` and `approval.denial_overridden`,
// see their payloads below, and the `plan.*` types, whose records are §The plan verdict's.
// Variant-required fields are enforced at the EMISSION seam via the exported per-type
// refinement (Plan-009 T1.1 `approvalFlowPayloadRefinementFor`): requested ⇒ runId /
// approvalRequestId / requestedBy / resourceDescriptor; approved / rejected ⇒
// approvalRequestId / deviceId / effectiveScope; canceled ⇒ approvalRequestId;
// remembered ⇒ approvalRequestId / rememberedScope / ruleId;
// rule_revoked ⇒ ruleId / invalidationTrigger —
// a malformed event fails at the emission parse, never at restart projection (I-009-9).
// Requested rows a provider permission ask originates additionally carry `askId` — its PRESENCE is
// required at the CP-009-5 normalizer seam (T2.8, the sole such emitter): the origin-blind
// refinement cannot know whether a requested payload came from a provider ask, so it enforces
// nothing about it.
interface ApprovalFlowEventPayload {
  sessionId: SessionId;
  runId?: RunId; // absent on rule_revoked (no in-flight request)
  approvalRequestId?: ApprovalRequestId; // ditto
  askId?: string; // present on approval.requested when the request originates from a provider permission ask (Claude Code's can_use_tool for any tool but its question tool, or a Codex approval request), which it records once: the daemon's own id for the ask, a ULID (the provider's request id is delivery routing state, never this id), persisted at creation as the durable ask↔approval association — restart/replay reconstructs which native ask an outcome must answer when several asks are in flight on one run, so the answer reaches the provider across a restart; required at the CP-009-5 normalizer emission seam (T2.8 — the sole requester a provider ask originates), set only by the daemon's in-process create from a provider ask, and never supplied by a client; persisted on the approval_requests projection row (ask_id — local-sqlite-schema.md §Approval Tables)
  category: ApprovalCategory;
  scope: string;
  requestedBy?: string; // present on approval.requested — recorded requester actor (the agent's actor id, or the device a person's request came from, Spec-010 §Required Behavior)
  resourceDescriptor?: Record<string, unknown>; // present on approval.requested — audit-grade target (Spec-010 §Interfaces And Contracts); on a provider permission ask it also holds the ask's tool name and the provider's own prompt text, where sent
  effectiveScope?: string; // present on approval.approved / approval.rejected — recorded effective scope (≤ requested, I-009-6)
  clientResolutionId?: string; // present on approval.approved / approval.rejected — the resolving request's own `clientResolutionId`, echoed so the device whose answer landed knows it did
  deviceId?: DeviceId; // present on approval.approved / approval.rejected — the answering device's id, the device whose connection carried the answer; a card answered elsewhere reads it as `Answered on <device>`
  rememberedScope?: RememberedScope;
  ruleId?: RememberedRuleId; // present on approval.remembered / approval.rule_revoked
  invalidationTrigger?: InvalidationTrigger; // present on approval.rule_revoked
}

// moderation.review_flagged payload — an `approval_flow` event with its own shape
// (Spec-005 §Approval Flow registry row). A warning or a required review from Codex's own
// reviewer at the `reviewed` level, which the flow draws as one system message with no control,
// in the words `text` carries. The Codex driver's event normalizer emits it (Plan-003 T3.34) from
// those Codex signals; Codex's per-turn moderation metadata, a display hint with no words,
// is never this event and stays in the daemon's log. Claude Code sends no such signal.
interface ModerationReviewFlaggedPayload {
  sessionId: SessionId;
  runId: RunId;
  agentId: AgentId;
  // Required; always resolves to the event of the approval request or tool call Codex's reviewer holds.
  eventId: string;
  // `review_warning`: a `guardianWarning`, drawn `Review warning · <text>`. The normalizer pairs each
  // warning with the review Codex completes right after it and records none for a warning that
  // reports an approval, or for one about an action the reviewer blocked, whose words are on that
  // action's own row (`approval.reviewer_denied`).
  // `review_required`: an `autoApprovalReview/strictReviewRequired`, drawn `Review required · <text>`.
  signal: "review_warning" | "review_required";
  // The words the row shows. For a warning, Codex's sentence exactly as Codex sent it. A required
  // review carries no words, so its text is the sentence Codex's own app writes for it:
  // "This request requires additional safety checks, some tool calls might take extra time".
  text: string;
}

// A daemon-minted identifier for one block by the provider's own reviewer. It is stable across a
// restart and across the person's devices, so a press on any screen names the same block.
type DenialId = string & { readonly __brand: "DenialId" };

// approval.reviewer_denied payload — an `approval_flow` event with its own shape (Spec-005 §Approval
// Flow registry row). At the `reviewed` level the provider's own reviewer blocked one action — Claude
// Code's auto-mode classifier, captured by its `PermissionDenied` hook and the result's
// `permission_denials`; Codex's automatic reviewer, captured from `item/autoApprovalReview/completed`.
// The blocked call keeps its row in the flow, a failed row whose reason line reads
// `Blocked · <reason>`, with one button, `Allow once`, wherever `overridable` is true. The daemon keeps
// the provider's own denial with this record — Claude Code's action as the hook received it, Codex's
// review as Codex sent it — so an override still works after a restart; it never rides the payload.
interface ApprovalReviewerDeniedPayload {
  sessionId: SessionId;
  runId: RunId;
  agentId: AgentId;
  denialId: DenialId;
  // The event of the blocked call, whose row carries the reason line and the button.
  eventId: string;
  // The reviewer's reason in the provider's own words: Claude Code's denial reason, such as
  // `[Data Exfiltration]`; Codex's review rationale.
  reason: string;
  // False where the provider lets no person overrule the block — Claude Code's block without a
  // classifier verdict, and Codex's review that timed out — and the row then carries no button.
  overridable: boolean;
}

// approval.denial_overridden payload — an `approval_flow` event with its own shape. The person pressed
// `Allow once` and the agent was told it may try that one action again; the row reads `Allowed once`
// and the button goes on every screen. The agent decides whether to retry, and nothing runs by itself.
interface ApprovalDenialOverriddenPayload {
  sessionId: SessionId;
  denialId: DenialId;
}
// ApprovalResolve
interface ApprovalResolveRequest {
  approvalRequestId: ApprovalRequestId;
  decision: ApprovalDecision;
  effectiveScope?: string; // granted scope; defaults server-side to the request's scope; never broader than requested
  // The rule this resolution hands to the provider, absent for a one-time answer. Its `sense` must agree
  // with `decision` — an `approved` resolution mints an `allow`, a `rejected` one a `block` — and the
  // pair is schema-refined, so a decline cannot mint a grant. A block is reachable only from the
  // `network_access` category, which is the one ask whose decline has a subject worth blocking.
  // `pattern` carries the DERIVED SUBJECT the card's own button displayed: for a command, the program
  // and its first subcommand; for a network request, the host; for a file write, the file's name.
  // The daemon derives it from the ask and the client echoes what it showed, so the rule can never
  // cover more than the words the person pressed.
  rememberedScope?: RememberedScope;
  // What the person typed on `Decline`'s one optional line, sent to the agent through the provider's own
  // refusal field; absent sends a bare decline. Only on a `rejected` decision.
  declineText?: string;
  // The command or path as the person edited it on the card before answering; it is what goes back with
  // the answer and what the row then records as having run. Absent when the shown text was answered as it stood.
  editedInput?: string;
  // Minted by the answering client and echoed on the `approval.approved` / `approval.rejected` event, so
  // the device whose answer landed knows it did and only the others read that it was answered elsewhere.
  clientResolutionId: string;
}
interface ApprovalResolveResponse {
  approvalRequestId: ApprovalRequestId;
  state: ApprovalState;
  effectiveScope: string; // the recorded grant (Spec-010 §Required Behavior)
  resolvedAt: string;
}

// PermissionCheck (daemon-internal pre-execution gate — no wire method string, D-009-5/D-009-18;
// both shapes are the daemon's own, in `packages/runtime-daemon/src/policy/`)
interface PermissionCheckRequest {
  runId: RunId;
  category: ApprovalCategory;
  scope: string;
  resourceDescriptor: Record<string, unknown>;
}
interface PermissionCheckResponse {
  allowed: boolean;
  reason: "policy_allow" | "remembered_rule" | "approved" | "pending_approval" | "denied";
  // D-009-17 semantics: policy_allow = Cedar/own-node-envelope permit with no human approval
  // artifact (Spec-010 §Required Behavior); remembered_rule = the session's own answers carry an allow
  // on this subject that the daemon answers for a provider with no verb of its own (a Codex session
  // allow after a restart); approved = a recorded approved resolution covers this exact request;
  // pending_approval = request created/open (allowed=false); denied = Cedar forbid, a rejected
  // resolution, a host the session blocked on Codex, which has no session block of its own, or
  // fail-closed refusal (the typed `approval.persistence_unavailable`
  // error additionally surfaces on fail-closed paths so audit can distinguish them).
  // Invariants: allowed === (reason ∈ {policy_allow, remembered_rule, approved});
  approvalRequestId?: ApprovalRequestId; // present iff reason = 'pending_approval': the one request
  // the ask opened, which the first answer from any device settles.
}

// ApprovalProjectionRead
interface ApprovalProjectionReadRequest {
  sessionId: SessionId;
  state?: ApprovalState; // filter
  category?: ApprovalCategory; // filter
}
interface ApprovalProjectionReadResponse {
  approvals: Array<{
    id: ApprovalRequestId;
    runId: RunId;
    requestedBy: string; // recorded requester actor — the agent's actor id, or the device a person's request came from (Spec-010 §Required Behavior)
    category: ApprovalCategory;
    scope: string;
    resourceDescriptor: Record<string, unknown>; // requested resource (Spec-010 §Interfaces And Contracts)
    state: ApprovalState;
    createdAt: string;
    updatedAt: string; // last state-transition instant (a canceled row settles here; no resolution row)
    resolvedAt?: string; // resolved quad present iff state ∈ {approved, rejected}
    decision?: ApprovalDecision;
    deviceId?: DeviceId; // AC-3: the answering device, which a card answered elsewhere reads as `Answered on <device>`
    effectiveScope?: string; // AC-3: what scope
    rememberedScope?: RememberedScope; // present iff the resolution handed a rule to the provider
  }>;
}

// RememberedRuleList — the rules in force on the session, the session's own and its project's alike,
// read from where the providers keep them: Claude Code's `list_permission_rules`, Codex's project rule
// files and the session's own answers (Spec-010 §Interfaces And Contracts). A revoked rule is gone
// from the list; its revocation stays on the session's record as `approval.rule_revoked`.
interface RememberedRuleListRequest {
  sessionId: SessionId;
}
interface RememberedRuleListResponse {
  rules: Array<{
    ruleId: RememberedRuleId; // daemon-minted, stable while the rule's place and text are unchanged
    scope: RememberedScope; // the scope, the derived subject and the sense
  }>;
}

// RememberedRuleRevoke — the explicit revocation path (Spec-010 §State And Data Implications): removes
// the rule where the provider keeps it — a Claude Code session rule from the session's flag settings, a
// Codex session allow by the daemon's hook holding the next call on its subject, a project rule from the
// provider's project file — and emits `approval.rule_revoked`
interface RememberedRuleRevokeRequest {
  ruleId: RememberedRuleId;
}
interface RememberedRuleRevokeResponse {
  ruleId: RememberedRuleId;
  revokedAt: string;
  invalidationTrigger: "explicit";
}

// ApprovalDenialOverride — `Allow once` on a block by the provider's own reviewer at the `reviewed`
// level. It tells the agent it may try that one action again, by the provider's own means: on Claude
// Code the daemon sends the sentence Claude Code's own Recently denied list sends, "Permission granted
// for: <the action>. You may now retry this command if you would like."; on Codex it calls
// `thread/approveGuardianDeniedAction` with the review Codex sent, and Codex's reviewer still reviews
// the retry. The sentence reaches a running turn at once and starts a turn when none is running, as
// that turn's input; it is the daemon's, never drawn as the person's message. The first press records
// `approval.denial_overridden` and settles the block on every screen.
interface ApprovalDenialOverrideRequest {
  sessionId: SessionId;
  denialId: DenialId;
}
// The settled override. A press on a block already allowed, from this screen or another, returns the
// same answer with the instant the first press landed and sends the provider nothing. A block that is
// not overridable is refused with `approval.denial_not_overridable`, a `denialId` the daemon holds no
// block for with `approval.denial_not_found`, and a press after the block's session has ended with
// `session.already_closed` (error-contracts.md §Approval, §Session).
interface ApprovalDenialOverrideResponse {
  sessionId: SessionId;
  denialId: DenialId;
  overriddenAt: string;
}
```

**The providers keep the card's rules.** The session's permission level decides whether anything asks at all: only the careful levels raise a card, and at the levels that never ask no card exists and no rule can be made — moving a session's level to one of those while a card is open ANSWERS that card and the blocked row runs. A rule the card makes is handed to the provider, which answers by it at every level that asks; the daemon keeps no rule store, and each rule is one provider's. On Claude Code a session rule is the session's flag settings, set by `apply_flag_settings {permissions}` with the whole allow and deny lists on each call and carried at launch by `--settings`, and a project allow rides the answer's `destination: "localSettings"` into `.claude/settings.local.json`, where the daemon writes a project block itself, since a decline drops any rule it carries. On Codex a session allow is `acceptForSession`; the daemon writes a project rule as a `prefix_rule` or `network_rule` into the project's `.codex/rules/sidekicks.rules`, adds that one path to the repository's `.git/info/exclude`, and answers the ask `acceptForSession`; where Codex has no verb — a session allow taken back, a session block, a session allow after a restart — the daemon's own tool hook and its answers to Codex's asks carry it from the session's own answers. The inspector's `Rules` lists and revokes the rules in force on one session through `approval.ruleList` and `approval.ruleRevoke`; Settings › Providers lists and revokes every standing rule on the machine through `provider.standingRuleList` and `provider.standingRuleRevoke`, from the same files.

**The plan verdict.** A plan turn ends with a held provider request on Claude Code and a plan item on Codex; the daemon turns either into ONE plan record the screen renders and ONE call answers. The record is `plan.proposed`; the call is `plan.resolve`; the outcome is recorded by `plan.accepted` and `plan.handed_off`, so the system messages that tell it survive a reload. Each rides the `approval_flow` category ([Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md), which owns the names and the census), because a plan card is an attention entry on exactly the terms an approval is, which is why the verdict lives beside the approval surface rather than in a namespace of its own.

```ts
// A daemon-minted identifier for one plan record. The record is minted when a plan turn ends and is
// the session artifact the inspector lists and the reader renders (§Plan-011 below), so the id is
// stable across a reload and across the person's other devices.
type PlanId = string & { readonly __brand: "PlanId" };

// plan.proposed — the record the screen renders. `title` is the plan's first heading and `text` its
// Markdown as the agent wrote it; the two counts are the daemon's own read of the plan, the
// top-level steps and the files the plan names, and they are what the card's summary line states.
// `planFilePath` is present only where the provider wrote the plan as a file, which is one provider
// and not the other — its absence means the plan is an item of the thread and there is no file, never
// that the path is unknown. The text is taken from the held request or the plan item and NEVER read
// off the disk.
interface PlanProposedPayload {
  planId: PlanId;
  sessionId: SessionId;
  runId: RunId;
  title: string;
  text: string;
  stepCount: number;
  fileCount: number;
  planFilePath?: string;
}

// plan.resolve — the one call that answers a plan record. Three verdicts:
//   `keep`  — keep planning. Nothing is appended, plan mode stays on, and the person's next message
//             is the feedback; the daemon answers a held provider request with a denial carrying the
//             sentence that stops the leg, and leaves the thread in plan mode where there is no
//             request to answer. The record settles `open`: the held request is already denied, so no
//             later verdict can answer it. A revised plan mints a NEW record with new counts.
//   `build` — build here. The build runs on in this session with its history intact; the daemon
//             answers the held request by allowing it and setting the session's own permission mode,
//             or restores the level's sandbox on the thread and starts the next turn.
//   `fresh` — build in a fresh session. The daemon mints a session on the SAME project and worktree,
//             named after the plan's first heading, seeded with the plan; the planning session keeps
//             its whole transcript.
// Written as one shape rather than a union because only one verdict carries members: the arm is
// presence-discriminated on `fresh`, which is REQUIRED on that verdict and forbidden on the other two
// (schema-refined), so a `build` request cannot smuggle a session to mint.
interface PlanResolveRequest {
  planId: PlanId;
  verdict: "keep" | "build" | "fresh";
  // The session to mint, present exactly on `fresh`: the provider it runs and the level it starts
  // at. The account is not one and no client names one — a minted session runs on its provider's
  // current account, the way every session does (§Plan-023 — Provider Accounts And Credential Homes).
  // Everything else is the planning session's — same project, same worktree, and the plan as the seed.
  fresh?: {
    driverName: string;
    // The planning session's level, or the level the person picked in the `Fresh session with` list
    // where that provider cannot give it. A level that provider, its account or the model cannot run
    // is refused with `session.permission_level_unavailable`, naming the level, and no session is
    // minted.
    level: ExecutionPostureMode;
  };
}
interface PlanResolveResponse {
  planId: PlanId;
  // The plan record's state after the verdict, which is the word the inspector's artifact row reads:
  // `open` after `keep`, `accepted` after `build`, `handed_off` after `fresh`. `waiting` is the record's
  // state only before its first verdict.
  state: "open" | "accepted" | "handed_off";
  // Present exactly on an accepted `fresh` verdict: the minted session, so the caller switches to it
  // without a follow-up read.
  freshSessionId?: SessionId;
}
```

### Approval Method-Name Registry

Plan-009's approval surface is exposed as the `approval.*` methods below (D-009-5); `approval.requestCreate` is not one of them: the daemon raises it in process from a provider's callback, so it has no method string and no SDK method. Names register under the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out (`repo.*` precedent). These methods ride the **daemon JSON-RPC transport only** — approval state is daemon-local SQLite per ADR-016 (coordination-records-only Postgres; no control-plane approval storage or tRPC sibling exists in V1; the person's other devices reach these methods through Remote Control, over their own channel to the machine that runs the session, ADR-016 Option B). Method strings are imperative and disjoint-by-form from the past-participle Spec-005 `approval_flow` durable event names (`approval.resolve` method vs `approval.approved` event; `approval.ruleRevoke` vs `approval.rule_revoked` — the underscore event form is regex-invalid as a method name). `PermissionCheck` is deliberately **not** registered: it is the daemon-internal pre-execution gate (Spec-010: "inside the local daemon"), no V1 client consumes a wire preflight, and exposing one would invite stale-verdict (time-of-check/time-of-use) authorization against the security gate (D-009-5/D-009-18). The console has no approvals list of its own, so no plural list method exists: the one waiting request is a card on the composer.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `approval.resolve` | `mutation` | `ApprovalResolveRequest` | `ApprovalResolveResponse` |
| `approval.projectionRead` | `query` | `ApprovalProjectionReadRequest` | `ApprovalProjectionReadResponse` |
| `approval.ruleList` | `query` | `RememberedRuleListRequest` | `RememberedRuleListResponse` |
| `approval.ruleRevoke` | `mutation` | `RememberedRuleRevokeRequest` | `RememberedRuleRevokeResponse` |
| `approval.denialOverride` | `mutation` | `ApprovalDenialOverrideRequest` | `ApprovalDenialOverrideResponse` |
| `plan.resolve` | `mutation` | `PlanResolveRequest` | `PlanResolveResponse` |

`plan` is a registered namespace root of its own, and this is the only verb in it: the plan verdict is one call, and a plan record is READ from the session's artifact list rather than through a namespace of its own, so no `plan.list` or `plan.read` exists to register. It rides the **daemon JSON-RPC transport only**, for the reason its siblings do — the held provider request the verdict answers is held by this daemon and by nothing else, so a control-plane sibling would place the mutation on a party that cannot answer it. A verdict against a record that is no longer waiting applies nothing and reads back the record's state, as `question.resolve` does, because the first answer settles the plan everywhere and the record is the receipt.

Canonical Zod schemas live in `packages/contracts/src/approval.ts` per the §Source-of-Truth Policy.

---

## Plans 008, 011 And 012

### Plan-008 — Gitflow PR And Diff Attribution

```ts
// BranchContextRead — the ship facts for the folder a session works in, keyed by the session. The daemon
// maps each session to its working folder and keeps one watch and one cache per folder, shared by every
// session working there, so two sessions in one checkout read one set of facts. The read answers before
// any run, and it carries everything the change-request form opens with — the base, the head, whether the
// act pushes first (`neverLeftMachine`) and the hosting service's request word — so no separate prepare
// call exists. It is re-read after every git act, on each `git.settled`, and when the working tree changes.
interface BranchContextReadRequest {
  sessionId: SessionId;
}
interface BranchContextReadResponse {
  headBranch: string;
  baseBranch: string; // the recorded base
  defaultBranch: string;
  upstreamRef?: string;
  uncommittedFileCount: number;
  aheadOfBase: number;
  behindBase: number;
  unpushedCommitCount: number;
  neverLeftMachine: boolean; // the branch has never been pushed, so opening a change request pushes first
  pendingOperation?: { kind: "merge" | "rebase" | "bisect"; endCommand: string }; // a git operation left half-done, with the command that ends it
  changeRequests: Array<{
    number: number;
    url: string;
    state: "open" | "merged" | "closed";
    mergeable?: "mergeable" | "conflicting" | "unknown";
    reviewDecision?: "approved" | "changes_requested" | "review_required";
  }>; // newest open first
  hosting?: { serviceName: string; requestWord: "pull_request" | "merge_request" }; // absent where no hosting service answers for the remote
}

// DiffRead — Review's diff. A pane read that is retried and re-read, so it mints nothing and stores
// nothing. Three scopes against a base — the working changes, the branch (narrowable to one of its
// commits) and a change request — plus a `workflowRun` arm that diffs two snapshot points of one workflow
// run, read from that run's own capture folder with the repository's objects as an alternate. One entry
// per path; an untracked file the repository does not ignore reads as added. The daemon cuts a diff too
// large for the machine and says so in `partial`; a file's body is never capped.
type DiffReadRequest =
  | { sessionId: SessionId; scope: "changes"; base?: string }
  | { sessionId: SessionId; scope: "branch"; base?: string; commitId?: string } // commitId narrows to one commit
  | { sessionId: SessionId; scope: "change_request"; changeRequestNumber: number }
  | {
      sessionId: SessionId;
      scope: "workflowRun";
      workflowRunId: WorkflowRunId;
      fromPoint: string;
      toPoint: string;
    }; // two of the run's snapshot points: its start, an approval pause, its end
interface DiffReadResponse {
  head: string;
  base: string;
  partial: boolean;
  files: Array<{
    path: string;
    oldPath?: string; // present on a rename
    kind: "added" | "deleted" | "renamed" | "modified";
    binary?: boolean;
    // git's blob id for each side, as `git diff --full-index` gives it (the working file's hash on the
    // working side); a gap read and a held note's comparison key on it. Absent on the side where the file
    // does not exist.
    oldBlobId?: string;
    newBlobId?: string;
    additions: number;
    deletions: number;
    patch?: string; // the file's unified patch; absent for a binary file or one that could not be read
    unreadable?: "too_large" | "permission_denied" | "not_regular_file";
    newestTurn?: number; // the latest turn of this session that changed the file, read from the per-turn checkpoints
    changedByStepId?: string; // on the workflowRun arm only: the step that changed the file, per file and never per line
  }>;
  commits?: Array<{ commitId: string; subject: string; landedAt: string }>; // the branch scope's commits
}

// The four ship acts. The preview and the act are built by the same daemon code, so the
// commands shown before the press are the commands that run.
type GitAct = "commit" | "push" | "pull" | "open_change_request";
interface GitActFormValues {
  commit?: { subject: string; body?: string };
  changeRequest?: {
    base: string;
    title: string;
    description: string;
    draft: boolean;
    reviewers: string[];
    labels: string[];
  };
}

// GitActionPreview — the exact commands an act will run, shown before the press.
interface GitActionPreviewRequest {
  sessionId: SessionId;
  act: GitAct;
  formValues: GitActFormValues;
}
interface GitActionPreviewResponse {
  commands: string[];
}

// GitActionExecute — runs one ship act in the session's working folder under the person's own git and
// hosting identity, with no amend and no force push. A failed command is a failed step on the act's
// progress stream, not an error reply, and `retryFromCommand` resumes at the command that failed.
interface GitActionExecuteRequest {
  sessionId: SessionId;
  action: GitAct;
  formValues: GitActFormValues;
  retryFromCommand?: number; // the index of the command to resume at
}
interface GitActionExecuteResponse {
  actId: string;
  commands: string[];
}

// GitActionSubscribe — the per-command progress of one running act, replayed then followed. The durable
// record is `git.settled`; this stream lives only as long as the act.
interface GitActionSubscribeRequest {
  actId: string;
}
interface GitActionProgress {
  commands: Array<{
    index: number;
    text: string;
    state: "pending" | "running" | "done" | "failed";
    output?: string;
  }>;
  settled: boolean; // true once the act has ended
}

// CommitMessageGenerate / ChangeRequestTextGenerate — one throwaway turn on the session's provider and
// account that carries no conversation, runs read-only and outside the repository with thinking off, and
// reads the diff within its cut, the branch and recent commit subjects. A failure is refused under the
// code this contract registers for it (error-contracts.md §Gitflow), carrying the provider's own words,
// and never falls back to the other provider.
interface CommitMessageGenerateRequest {
  sessionId: SessionId;
}
interface CommitMessageGenerateResponse {
  subject: string;
  body: string;
}
interface ChangeRequestTextGenerateRequest {
  sessionId: SessionId;
}
interface ChangeRequestTextGenerateResponse {
  title: string;
  description: string;
}

// ChangeRequestSubscribe — the session's change requests, live. `summary` (state, can-merge, review
// decision) feeds the header's request word; `full` adds the description, the reviews and requested
// reviewers, the threads and the checks, for Review. While a subscriber holds it, the daemon sends the
// hosting service a conditional request every 60 s (an unchanged answer costs no quota) and refreshes at
// once after the person's own git and change-request acts; with no subscriber nothing asks the host. A
// failed read keeps the last state and says when the read failed, rather than ending the stream.
interface ChangeRequestSubscribeRequest {
  sessionId: SessionId;
  depth: "summary" | "full";
}
interface ChangeRequestUpdate {
  requests: Array<{
    number: number;
    url: string;
    state: "open" | "merged" | "closed";
    isDraft: boolean;
    mergeable?: "mergeable" | "conflicting" | "unknown";
    reviewDecision?: "approved" | "changes_requested" | "review_required";
    headCommitId: string;
    // Present at `full` depth only.
    author?: string;
    description?: string;
    reviews?: Array<{ reviewer: string; verdict: "comment" | "approve" | "request_changes" }>;
    requestedReviewers?: string[];
    threads?: Array<{
      threadId: string; // the hosting service's own thread handle, carried verbatim
      path?: string;
      line?: number;
      side?: "added" | "removed";
      state: "open" | "resolved" | "outdated";
      author: string;
      replies: Array<{ author: string; body: string }>;
    }>;
    checks?: Array<{
      checkId: string;
      name: string;
      status: "pending" | "success" | "failure";
      runUrl: string;
    }>;
  }>;
  readAt: string;
  lastReadFailedAt?: string;
}

// ReviewerList / LabelList — the candidates the change-request form offers.
interface ReviewerListRequest {
  sessionId: SessionId;
  query?: string;
}
interface ReviewerListResponse {
  reviewers: Array<{ login: string; name?: string }>;
}
interface LabelListRequest {
  sessionId: SessionId;
}
interface LabelListResponse {
  labels: Array<{ name: string; description?: string }>;
}

// ReviewSubmit — posts the session's held notes that are not stranded as ONE review carrying one
// verdict. The wire carries no note text: the notes come from the held-note store. A review can land
// PARTLY, and the reply says so per note: the notes that posted are recorded as sent and never offered
// again, the ones behind a failure stay held, and a second press posts only what is still held. A
// stranded note is never submitted and never appears in the reply.
interface ReviewSubmitRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  verdict: "comment" | "approve" | "request_changes";
  body?: string;
}
interface ReviewSubmitResponse {
  reviewUrl?: string; // absent when no review was created because every comment failed
  postedNoteIds: string[];
  failures: Array<{ noteId: string; reason: string }>; // `reason` is the hosting service's own words
}

// ThreadResolve / ThreadReply — act on one hosting thread. Resolving a thread already resolved succeeds.
interface ThreadResolveRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  threadId: string;
}
interface ThreadResolveResponse {
  threadId: string;
  state: "resolved";
}
interface ThreadReplyRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  threadId: string;
  body: string;
}
interface ThreadReplyResponse {
  commentId: string;
  url: string;
}

// CheckLogRead — the tail of a failing check's raw log; how much of the tail is read comes from the
// machine, and the log is shown as text.
interface CheckLogReadRequest {
  sessionId: SessionId;
  changeRequestNumber: number;
  checkId: string;
}
interface CheckLogReadResponse {
  text: string;
  truncated: boolean;
  totalBytes: number;
  runUrl: string;
}

// Self-hosted git hosts. A host is one name with no kind to pick: the service asks each installed tool,
// `gh` and `glab`, whether it answers for the host signed in, and keeps the kind of the one that does. A
// name that does not parse, and a host neither tool answers for, are refused in place and nothing is saved.
interface GitHost {
  host: string;
  kind: "github" | "gitlab";
}
interface GitHostListRequest {}
interface GitHostListResponse {
  hosts: GitHost[];
}
interface GitHostAddRequest {
  host: string;
}
interface GitHostAddResponse {
  host: GitHost;
}
interface GitHostRemoveRequest {
  host: string;
}
interface GitHostRemoveResponse {
  host: string;
}

// The held-note store's shapes (the `session.reviewNote*` verbs below). A note records the
// comparison it was written against, which is what a press on the note walks back to.
interface ReviewNoteComparison {
  scope: "changes" | "branch" | "change_request";
  base: string;
  headCommitId?: string; // exactly one of headCommitId and workingTreeBlobId
  workingTreeBlobId?: string;
  requestNumber?: number;
}
interface ReviewNote {
  noteId: string;
  comparison: ReviewNoteComparison;
  path: string;
  oldPath?: string; // a note on a renamed file
  side: "added" | "removed";
  line: number;
  startLine?: number; // a note on a range of lines
  quote: string; // the one-line quote of the line
  body: string;
  stranded: boolean; // the line no longer exists in the diff the note points into
}
interface ReviewNoteAddRequest {
  sessionId: SessionId;
  noteId: string; // minted by the client, so a retried add makes one note
  comparison: ReviewNoteComparison;
  path: string;
  oldPath?: string;
  side: "added" | "removed";
  line: number;
  startLine?: number;
  body: string;
}
interface ReviewNoteAddResponse {
  note: ReviewNote;
}
interface ReviewNoteUpdateRequest {
  sessionId: SessionId;
  noteId: string;
  body: string;
}
interface ReviewNoteUpdateResponse {
  note: ReviewNote;
}
interface ReviewNoteRemoveRequest {
  sessionId: SessionId;
  noteIds: string[]; // one press discards every note behind one question, and a steer clears every note
}
interface ReviewNoteRemoveResponse {
  removedNoteIds: string[];
}
interface ReviewNoteListRequest {
  sessionId: SessionId;
}
interface ReviewNoteListUpdate {
  notes: ReviewNote[]; // replayed, then followed; `stranded` recomputed against each note's comparison
}
// git.settled payload (Spec-005 §Artifact and Diff Publication). ONE record for the five git acts the
// transcript records — committing, pushing, pulling, opening a change request and posting a review — so
// those system messages survive a reload. Each `cause`
// carries exactly the reference its system message names: the commit's identifier for `committed`,
// the branch for `pushed`, the branch and the commit it landed on for `pulled`, the request's number plus
// its address on the hosting service for `pull_request_opened`, and the request's number plus the verdict
// for `review_posted`. `runId` is present where an agent performed the act as an ordinary tool call and
// absent where the person pressed the control.
interface GitSettledPayload {
  sessionId: SessionId;
  runId?: RunId;
  cause: "committed" | "pushed" | "pulled" | "pull_request_opened" | "review_posted";
  commitId?: string;
  branch?: string;
  requestNumber?: number;
  requestUrl?: string;
  verdict?: "comment" | "approve" | "request_changes";
}
```

Plan-008's git flow is exposed as the `gitflow.*` methods below. Method-name strings are `dotted-camelCase` per `METHOD_NAME_FORMAT`, defined in §Plan-005-Partial — Local IPC Daemon Control above — the `gitflow` namespace token is the gitflow domain noun (the Plan-008-owned `runtime-daemon/src/gitflow/` daemon module, D-008-3; consumed client-side by the `gitflowClient` SDK, [Plan-008 §Target Areas](../../plans/008-gitflow-pr-and-diff-attribution.md#target-areas)). The PascalCase request/response type symbols (such as `GitActionExecute`) are **rejected** as method strings by that regex — it reserves PascalCase for the project's TypeScript type-name convention — so each wire name differs from its payload type symbol. Names register under the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out. These methods ride the **daemon JSON-RPC transport only** — the ship facts, the diff and the held notes are this machine's git and daemon state, and the hosting service is reached from the daemon under the person's own signed-in identity, so no control-plane tRPC sibling exists. Every session-scoped method is keyed by the session, and the daemon resolves the session's working folder itself.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `gitflow.branchContextRead` | `query` | `BranchContextReadRequest` | `BranchContextReadResponse` |
| `gitflow.diffRead` | `query` | `DiffReadRequest` | `DiffReadResponse` |
| `gitflow.gitActionPreview` | `query` | `GitActionPreviewRequest` | `GitActionPreviewResponse` |
| `gitflow.gitActionExecute` | `mutation` | `GitActionExecuteRequest` | `GitActionExecuteResponse` |
| `gitflow.gitActionSubscribe` | `subscription` | `GitActionSubscribeRequest` | `GitActionProgress` (stream) |
| `gitflow.commitMessageGenerate` | `mutation` | `CommitMessageGenerateRequest` | `CommitMessageGenerateResponse` |
| `gitflow.changeRequestTextGenerate` | `mutation` | `ChangeRequestTextGenerateRequest` | `ChangeRequestTextGenerateResponse` |
| `gitflow.changeRequestSubscribe` | `subscription` | `ChangeRequestSubscribeRequest` | `ChangeRequestUpdate` (stream) |
| `gitflow.reviewerList` | `query` | `ReviewerListRequest` | `ReviewerListResponse` |
| `gitflow.labelList` | `query` | `LabelListRequest` | `LabelListResponse` |
| `gitflow.reviewSubmit` | `mutation` | `ReviewSubmitRequest` | `ReviewSubmitResponse` |
| `gitflow.threadResolve` | `mutation` | `ThreadResolveRequest` | `ThreadResolveResponse` |
| `gitflow.threadReply` | `mutation` | `ThreadReplyRequest` | `ThreadReplyResponse` |
| `gitflow.checkLogRead` | `query` | `CheckLogReadRequest` | `CheckLogReadResponse` |
| `gitflow.hostList` | `query` | `GitHostListRequest` | `GitHostListResponse` |
| `gitflow.hostAdd` | `mutation` | `GitHostAddRequest` | `GitHostAddResponse` |
| `gitflow.hostRemove` | `mutation` | `GitHostRemoveRequest` | `GitHostRemoveResponse` |

**One git-settlement record, whose cause names the act.** Committing, pushing, pulling, opening a change request and posting a review each settle into ONE durable record — `git.settled`, whose `cause` is one of `committed | pushed | pulled | pull_request_opened | review_posted` and names which of the five it was — so those system messages survive a reload and the transcript says what left this machine and what came into it. The name and the taxonomy census are [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s; what is fixed here is that one record carries all five acts. A review posted with the comment verdict alone reads as a comment on the request. The record is what the flow renders; it is not a second copy of the hosting state, which `gitflow.changeRequestSubscribe` keeps on its own. A result that arrives after the form it came from has closed, or after the pane has been pointed at another session, updates nothing on screen — and the record still lands, because the act happened.

**The held-note store and its verbs.** A review note is a DRAFT the daemon holds, scoped to the session, in the same session-scoped store as the composer draft and its staged files, so a half-written review reaches the person's other devices; typed unsent text is never written to renderer-local storage. `session.reviewNoteAdd` adds a note located at a file and a line — its path (the old path on a renamed file), its side, its line or range of lines — with its own words and the `comparison` it was written against, which is what a press on the note walks back to; `session.reviewNoteUpdate` edits a held note's words; `session.reviewNoteRemove` takes `noteIds`, an array, because one press discards every note behind one question and a steer clears every note at once; and `session.reviewNoteList` is the session's notes, live. A note leaves in exactly one of three ways — composed into the composer draft as a steer, posted as part of one review through `gitflow.reviewSubmit`, or discarded — and nothing else. The daemon checks each held note against the diff it points into and marks a note whose line no longer exists as stranded: it stays readable, editable and deletable, and is left out of a posted review, as is a note on uncommitted lines. Once a note is posted it stops being a held note and becomes a hosting thread, which takes `gitflow.threadReply` and `gitflow.threadResolve` and never the note's edit and delete. What is fixed here is the store — session-scoped, daemon-held, one home per note — and the `noteId` that `gitflow.reviewSubmit`'s result and the adapter's `submitReview` address a note by.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `session.reviewNoteAdd` | `mutation` | `ReviewNoteAddRequest` | `ReviewNoteAddResponse` |
| `session.reviewNoteUpdate` | `mutation` | `ReviewNoteUpdateRequest` | `ReviewNoteUpdateResponse` |
| `session.reviewNoteRemove` | `mutation` | `ReviewNoteRemoveRequest` | `ReviewNoteRemoveResponse` |
| `session.reviewNoteList` | `subscription` | `ReviewNoteListRequest` | `ReviewNoteListUpdate` (stream) |

The reads are `query`s, the live feeds `subscription`s and every other verb a `mutation`, per the tRPC procedure-type convention in §Plan-025 — Remote Control Bootstrap above. The daemon answers these verbs through its own hosting adapter, one per hosting kind, GitHub through the `gh` command-line tool and GitLab through `glab`, each under the person's own signed-in identity. The adapter is daemon-internal, in the daemon's gitflow module (`packages/runtime-daemon/src/gitflow/`), and is not part of this contract; its operations are stated in [Spec-009 §GitHostingAdapter Interface](../../specs/009-gitflow-pr-and-diff-attribution.md#githostingadapter-interface), and every reply a client reads is the verb's own shape above. Canonical Zod schemas live in `packages/contracts/src/gitflow/` per the §Source-of-Truth Policy.

### Plan-011 — Artifacts Files And Attachments

```ts
// --- ArtifactManifest: the persisted manifest record — the OCI-inspired envelope (Spec-012
//     §Interfaces And Contracts) plus the daemon-persisted `state`/`metadata` fields (not in the spec envelope).
//     Defined once here (the `ArtifactManifest` shape Plan-011 Task 1 mints in
//     packages/contracts/src/artifacts/); ArtifactPublish returns it (Spec-012 §Interfaces And Contracts),
//     ArtifactRead returns it plus a payload handle/inline (same spec section). 1:1 with the
//     `artifact_manifests` row's wire-shareable fields — each a dedicated column (D-011-2), incl. `annotations`
//     as a first-class OCI string→string map, never folded into freeform `metadata`. ---

// artifactType discriminator (Spec-012 §Interfaces And Contracts) — the five Spec-012 §Required Behavior families (file, diff, summary,
// log, design) plus workflow_output, the Spec-015 §Output Mode Specification workflow phase-output type. Spec-012 §Required Behavior
// admits "at least" those families, so workflow_output adds to them (D-011-4).
type ArtifactType = "file" | "diff" | "summary" | "log" | "design" | "workflow_output";

interface ArtifactManifest {
  id: ArtifactId;
  sessionId: SessionId;
  runId?: RunId;
  createdBy?: string; // = SQLite `created_by` — the device the publishing request came from; absent when the daemon itself produced the artifact
  artifactType: ArtifactType; // discriminator — Spec-012 §Interfaces And Contracts (D-011-4: file|diff|summary|log|design|workflow_output)
  digest: string; // OCI `digest` (SHA-256) = SQLite content_hash — required: a content-addressed manifest always has one (I-011-1)
  size: number; // OCI manifest-descriptor `size` (payload byte length) = SQLite size_bytes — server-derived, always present
  annotations: Record<string, string>; // OCI `annotations` string-map = SQLite annotations (NOT NULL DEFAULT '{}') — distinct from freeform `metadata`
  subject?: ArtifactId; // OCI `subject`: present only on a derivative (redacted/summarized) manifest → source manifest (I-011-2, Spec-012 §State And Data Implications)
  state: ArtifactState;
  metadata: Record<string, unknown>; // freeform daemon-side provenance/media-type — distinct from the OCI `annotations` map above
  createdAt: string;
}

// ArtifactPublish — Spec-012 §Interfaces And Contracts: "must return artifact id and manifest metadata."
// Trust-boundary rule (Spec-012 §Ingest Validation And Payload Bounds (V1)): the ingest
// pipeline binds to the TRUST BOUNDARY, not to a method name. A publish arriving from across the local
// client↔daemon boundary runs the same validation pipeline over `payload`, and one declaring
// `artifactType: "file"` is refused outright and directed to AttachmentIngest — the file family reaches
// the manifest space only through the validated ingest path. Daemon- and engine-produced publishes
// (the common case for the other families) originate inside the boundary and are not re-validated.
interface ArtifactPublishRequest {
  sessionId: SessionId;
  runId?: RunId;
  artifactType: ArtifactType; // discriminator — see ArtifactManifest.artifactType (Spec-012 §Interfaces And Contracts; D-011-4)
  payload: string; // the artifact bytes — UTF-8 text verbatim, or base64 (RFC 4648 §4) under payloadEncoding "base64"; never a binary field, because the Spec-006 local wire is JSON-only. The daemon decodes per the discriminator BEFORE hashing: content_hash and size_bytes bind the DECODED bytes, so an encoded and an unencoded publish of identical content share one CAS entry. A boundary-crossing publish is single-call and the 4 MB frame ceiling binds the SERIALIZED frame: base64's fixed 4/3 expansion gives the predictable ≈3 MB raw ceiling, while a utf8 payload's JSON-escaped size is content-dependent (quotes/backslashes/control characters expand 2–6× under JSON.stringify), so near-ceiling callers publish base64; larger file bytes take the AttachmentIngest trio, and daemon-internal publishes never cross the wire (Spec-012 §Ingest Validation And Payload Bounds (V1))
  payloadEncoding?: "utf8" | "base64"; // default "utf8" — the request-side encoding discriminator
  mediaType: string; // MIME type
  // --- producer-supplied OCI envelope inputs (D-011-3). `size`/`digest` are NOT here:
  //     the daemon derives size_bytes + content_hash from `payload`. ---
  subject?: ArtifactId; // OCI `subject`: set when publishing a derivative (redacted/summarized) form → points to the source manifest (I-011-2, Spec-012 §State And Data Implications); omit for originals. Resolution is SESSION-SCOPED: the id must resolve within sessionId's manifest space, and a foreign-session or unknown id refuses artifact.not_found (404) — derivative chains never cross sessions, which is what keeps the Spec-012 session-deletion sweep complete by construction
  annotations?: Record<string, string>; // OCI `annotations` string-map persisted to artifact_manifests.annotations; distinct from freeform `metadata`
  metadata?: Record<string, unknown>;
}
interface ArtifactPublishResponse {
  manifest: ArtifactManifest; // embedded manifest metadata (Spec-012 §Interfaces And Contracts); manifest.id is the artifact id, manifest.digest the content hash — no resolvable-URL indirection (D-011-3)
}

// ArtifactRead — Spec-012 §Interfaces And Contracts: "must return manifest plus retrievable payload handle or inline content."
// A chat's file is versioned: each write to the same path is a new version kept with the time it was
// written, and a read names the version it wants, the newest when `version` is absent. A picture's natural
// size and a PDF's first page and page count are read with the payload, for the quick look.
interface ArtifactReadRequest {
  artifactId: ArtifactId;
  version?: number; // counted from 1; absent reads the newest
  includePayload?: boolean; // default false, returns handle only
}
interface ArtifactReadResponse {
  manifest: ArtifactManifest; // the same envelope ArtifactPublish embeds (Spec-012 §Interfaces And Contracts)
  version: number; // the version in view
  versionCount: number; // how many versions exist, which the file pane's stepper reads
  writtenAt: string; // when the version in view was written
  payloadHandle?: string; // CAS key or URL for deferred retrieval
  payload?: string; // only if includePayload=true and size permits — where "permits" includes the base64 expansion: the encoded member plus envelope must fit the Spec-006 4 MB frame; UTF-8 text verbatim or base64 per payloadEncoding
  payloadEncoding?: "utf8" | "base64"; // present when payload is — "utf8" only for byte-exact valid UTF-8 payloads (which JSON round-trips losslessly), "base64" otherwise; callers switch on it, never sniff
}

// ArtifactList — the session's artifacts: every plan the agent finished and, on a chat session, every
// file and folder the chat wrote. The inspector's `Artifacts` section and a chat's files-written row both
// read it. A plan's state word is its manifest's `state`.
interface ArtifactListRequest {
  sessionId: SessionId;
}
interface ArtifactListResponse {
  artifacts: Array<{
    manifest: ArtifactManifest;
    title: string; // a plan's first heading; a file's or folder's path
    versionCount: number;
  }>;
}

// AttachmentIngest — the interface family purpose-built for untrusted caller-supplied bytes, and the
// primary surface the Spec-012 §Ingest Validation And Payload Bounds (V1) pipeline binds (the pipeline
// binds to the trust boundary, not to a method name — see the ArtifactPublish note above for the
// boundary-crossing publish arm). The other artifactType families are daemon- or engine-produced
// in the common case and carry no untrusted-upload surface. Ingest is a THREE-CALL STREAM, not a
// single payload-bearing call (Spec-012 §Ingest Validation And Payload Bounds (V1),
// transport binding): the local IPC transport enforces a hard 4 MB per-frame ceiling on the declared
// Content-Length BEFORE buffering the body (MAX_MESSAGE_BYTES, declared in
// packages/contracts/src/jsonrpc.ts and enforced by
// packages/runtime-daemon/src/ipc/local-ipc-gateway.ts, Spec-006 §Wire Format), so a payload
// larger than one frame cannot cross it and a single-call shape would be
// un-implementable on this wire. Chunks spool to a daemon-held temporary file OUTSIDE the CAS until
// Complete; the byte bound binds three times — the transport frame ceiling, Init's declared total, and
// the spooled running count at every Chunk, whose first breach terminates the stream and deletes the
// spool. An abandoned stream's spool is reaped by a daemon-local mtime-clocked reaper 48 h after
// its last write. The stream is a PROTOCOL, not a loose call
// sequence (Spec-012 stream protocol): Init is refused
// artifact.ingest_capacity_exhausted (429 — transient, retry later, no stream state created) at
// max_active_ingest_streams or when the spool's volume, its free space read at admission, has no room
// for the declaration beside the open streams' reservations; sequencing is replay-idempotent with violations terminal
// (artifact.ingest_stream_invalid, 409 — restart from Init); and a stream's tenure is wall-clock-
// bounded by max_ingest_stream_lifetime from Init, because the mtime reaper cannot see a hostile
// trickle that keeps its spool young. `mediaType` and `declaredSizeBytes` are ADVISORY
// INPUT, never trusted facts: the daemon derives both from the spooled bytes at Complete and
// reconciles — with per-field consequences that are deliberately NOT the same.
// A declared TYPE never refuses anything: the type read from the bytes is recorded and the
// declaration is dropped (Spec-012 pipeline step 1). A smaller actual SIZE resolves to the derived
// value in the response — but the declaration is also the stream's
// spool RESERVATION and per-stream ceiling: the running decoded count exceeding it
// refuses artifact.too_large (413) and deletes the spool, because admission against the disk's room
// counts declared bytes and an unenforced declaration would make it gameable. The derived
// values are what reach the manifest, the CAS key, and every downstream consumer.
// EVERY call of the trio is retry-safe against a lost response, and no member of these shapes carries
// idempotency state: a replayed Chunk is acknowledged
// without re-appending, and a replayed Complete replays its original response verbatim from a
// completion record the daemon holds on the stream's own registry entry. Calls on one ingestId are
// additionally SINGLE-FLIGHT — sequence validation, spool append, running-count and digest advance,
// and acknowledgment run as one critical section per stream — so an original racing its own retry
// takes the replay path rather than double-appending; concurrent calls on DIFFERENT streams never
// contend. Admission is likewise a serialized reserve-then-install ledger over the open-stream count
// and the reservation total against the disk's free space, so two concurrent Inits cannot both pass
// one remaining slot's bound.
// The trio's request shapes live in `packages/contracts/src/artifacts/`, beside `ArtifactListRequest`
// and `ArtifactReadRequest`. The trio has no abort call: Spec-012 names none, and an abandoned
// stream's spool is reaped as above.
interface AttachmentIngestInitRequest {
  sessionId: SessionId;
  runId?: RunId;
  fileName: string; // caller-supplied; length/character-bounded before it is recorded, and NEVER a storage path component — CAS addressing keys the payload by its SHA-256 (Spec-012 §Implementation Notes)
  mediaType?: string; // ADVISORY and OPTIONAL — absent is a first-class state; the type read from the bytes is what the manifest records, and no declaration refuses anything (Spec-012 pipeline step 1)
  declaredSizeBytes: number; // ADVISORY as metadata, BINDING as a reservation: reserved against the spool volume's free space, read at admission (a declaration the free disk cannot hold even with no other stream open is refused artifact.too_large (413) up front, naming the file and the room the disk has, since waiting can never admit it), and enforced as the stream's per-stream spool ceiling — the running decoded count may not exceed it; a smaller actual size reconciles downward at Complete without refusal
}
interface AttachmentIngestInitResponse {
  ingestId: string; // opaque single-use stream handle, session-bound and wall-clock-bounded by max_ingest_stream_lifetime from Init; scopes every subsequent Chunk/Complete call — each refused artifact.ingest_stream_invalid (409) once the stream is terminated, expired, or unknown, and every Chunk once it is completed. ONE carved exception: a replayed Complete on a completed stream whose completion record still lives replays the original response verbatim — see AttachmentIngestCompleteRequest
}
interface AttachmentIngestChunkRequest {
  ingestId: string;
  sequenceNumber: number; // 0-based, strictly consecutive. The daemon retains the last acknowledged sequence + the last appended chunk's SHA-256: an exact replay — same sequence, same bytes, the ordinary retry after a lost Chunk response — is acknowledged idempotently WITHOUT re-appending, so client retries are always safe; a same-sequence chunk with different bytes, a gap, or a regression terminates the stream (spool deleted) and refuses artifact.ingest_stream_invalid (409) — restart from Init
  chunk: string; // base64 (RFC 4648 §4) of at most max_attachment_chunk_bytes = 512 KiB raw payload (Spec-012 §Bounds) — the Spec-006 wire is JSON with no binary serialization, so bytes ride encoded, sized so the 4/3 expansion plus envelope fits the frame ceiling by arithmetic; the spool append decodes, and every byte bound counts the DECODED bytes
}
interface AttachmentIngestChunkResponse {
  ingestId: string;
  receivedBytes: number; // spooled running total of DECODED bytes after this chunk — the enforced byte bound; exceeding the Init-declared total refuses with artifact.too_large (413) and deletes the spool
}
interface AttachmentIngestCompleteRequest {
  ingestId: string; // the request's ONLY member — Complete runs the pipeline over the spooled bytes (type detection reads a bounded leading prefix); step 3's admitting CAS rename commits the payload — admission is the pipeline's final successful act (Spec-012 pipeline step 3). IDEMPOTENT within the stream's lifetime: the response is recorded on the stream's registry entry, stamped with the committed digest, so a retry after a lost response replays that response VERBATIM — same artifactId, same contentHash — re-running no gate and inserting no second manifest row. Because this request carries no member beyond the ingestId, a "divergent" Complete has no wire form; the digest stamp is a fail-closed defense-in-depth check against a state a daemon-minted single-use handle makes unreachable, not a caller-supplied discriminator. The record shares the entry's in-memory lifetime, so past max_ingest_stream_lifetime the retry receives artifact.ingest_stream_invalid (409) and a re-ingest costs a second manifest row over one deduplicated CAS payload, never duplicated bytes
}
interface AttachmentIngestCompleteResponse {
  artifactId: ArtifactId;
  contentHash: string;
  normalizedName: string;
  derivedMediaType: string; // read from the payload's bytes — this, not Init's `mediaType`, is what the manifest records; returned so a caller that guessed wrong learns the reconciled truth
  derivedSizeBytes: number; // server-derived byte length of the spooled payload — likewise authoritative over Init's declared bound
}

// --- Attachment references on turn-scoped carriers (Spec-012 §Interfaces And Contracts).
//     The element type is ArtifactId — an id into Spec-012's manifest space — carried as an ordered
//     ArtifactId[], never an untyped element and never an inline byte payload: a carrier references
//     artifacts by id only, and caller bytes enter through the boundary-validated ingest paths — the
//     AttachmentIngest trio, or a boundary-crossing ArtifactPublish payload, both of which run the
//     Spec-012 validation pipeline before anything is admitted. Caller-declared order
//     is preserved end to end, and an element the turn cannot resolve or deliver surfaces as an explicit
//     unresolved marker in its declared position naming its cause, `deleted` — silently dropping it
//     is prohibited (Spec-012 §Fallback Behavior). A carrier holds as many attachments as the daemon
//     and the provider accept, with no count of the app's own.
//     The driver-boundary
//     steer and intervention arms were typed `unknown[]` and DELIBERATELY NOT edited from the Plan-011
//     side, because those wire arms belong to the plans that own the driver boundary and retyping them
//     was registered as the Plan-011 cross-plan follow-up obligation CP-011-1 so the change would land
//     under its owners. IT HAS: both arms are `ArtifactId[]`, typed by Plan-003
//     (SteerPayload, §Plan-003 above — where the carrier contract is stated once) and Plan-002 (the
//     InterventionRequestPayload `steer` arm, §Plan-002), so every V1 attachment carrier registered
//     here is typed and CP-011-1's prerequisite — no V1 carrier may be wired to deliver an
//     attachment over an untyped arm — holds. ---
```

> **The artifact manifest envelope.** The ArtifactPublish/ArtifactRead pair composes a single named `ArtifactManifest` envelope ([Spec-012 §Interfaces And Contracts](../../specs/012-artifacts-files-and-attachments.md#interfaces-and-contracts)) instead of inlining and duplicating the fields — this is the `ArtifactManifest` shape Plan-011 Task 1 mints. `ArtifactPublishResponse` embeds `manifest: ArtifactManifest` per [Spec-012 §Interfaces And Contracts](../../specs/012-artifacts-files-and-attachments.md#interfaces-and-contracts) ("must return artifact id **and manifest metadata**"): the `ArtifactRead` clause grants handle/inline latitude to the **payload** on _Read_ only, never to the manifest, so both responses return the manifest metadata inline (D-011-3). `ArtifactReadResponse` is `manifest` + `payloadHandle?`/`payload?` ([Spec-012 §Interfaces And Contracts](../../specs/012-artifacts-files-and-attachments.md#interfaces-and-contracts)). The wire envelope mirrors the `artifact_manifests` row in [Local SQLite Schema](../schemas/local-sqlite-schema.md) 1:1: `digest`/`size` are **required** on the wire because a content-addressed manifest always carries both (I-011-1), and the at-rest `content_hash`/`size_bytes` columns are correspondingly **`NOT NULL`** — each producer (AttachmentIngest, ArtifactPublish) computes the SHA-256 + byte length from its own payload and inserts its manifest with both columns set in the same transaction as the payload-ref, and AttachmentIngest and ArtifactPublish are independent producers (the `artifactId` `AttachmentIngestCompleteResponse` returns resolves from the ingest-written manifest, not a later publish), so there is no payload-less manifest to reconcile (D-011-1). `annotations` is a dedicated OCI string→string column (D-011-2; at-rest `NOT NULL DEFAULT '{}'`), required on the wire, never folded into freeform `metadata`. Producer inputs are closed too (D-011-3): `ArtifactPublishRequest` accepts `subject?` (so a Task-4 I-011-2 derivative names its source at publish) and `annotations?`, while `size`/`digest` stay server-derived from `payload` — otherwise the `annotations` column and derivative `subject` would be write-dead.

**Plan artifacts and a chat's files.** Two console surfaces are projections of this manifest space and add no store of their own. **A finished plan** is written by the daemon as an artifact of its session in the existing summary family the moment the plan turn ends, keyed by its own stable id and carrying the plan's text as the agent wrote it; its state moves in place as the plan is answered, so the inspector's artifact list reads the plan's word — waiting, accepted, handed on — and the plan reader renders the STORED text and never the provider's own plan file. The artifact survives a restart and is listed on the person's other devices, which is the whole reason the plan is an artifact rather than a rendering of a held request. **A chat session's files** are artifacts too: every file and folder a chat writes into its managed workspace is one, and each write to the same path is a NEW VERSION of that artifact kept with the time it was written — a later write never replaces an earlier one, which is what lets the file pane step through versions and compare one against the one before it. That comparison is the only diff a chat draws and it is never against a repository, so no branch, commit, base or staging concept reaches it.

The session screen reads this manifest space through these methods on the daemon JSON-RPC transport. `artifact.list` is read again on `artifact.published` rather than on a timer.

| Method          | Procedure type | Request schema        | Response schema        |
| --------------- | -------------- | --------------------- | ---------------------- |
| `artifact.list` | `query`        | `ArtifactListRequest` | `ArtifactListResponse` |
| `artifact.read` | `query`        | `ArtifactReadRequest` | `ArtifactReadResponse` |

### Plan-012 — Persistence Recovery And Replay

```ts
// RecoveryStatusRead
interface RecoveryStatusReadRequest {
  sessionId?: SessionId; // omit for daemon-wide status
}
interface RecoveryStatusReadResponse {
  overall: "healthy" | "replaying" | "degraded" | "blocked";
  sessions: Array<{
    sessionId: SessionId;
    state: "healthy" | "replaying" | "degraded" | "blocked";
    lastReplayedSequence?: number;
    failureCategory?: RunFailureCategory;
    recoveryCondition?: RecoveryCondition; // named type in §Plan-003
    // Per-run identities behind a blocked/degraded session entry: names which
    // runs need reconciliation in a multi-run session — a Plan-012 T15.5 divergence halt or a
    // failed resume each land one entry. Optional and additive: absent when no run-level
    // recovery condition exists. Entry contract: a divergence-halt entry carries no
    // failureCategory (the run did not fail), and there is no failure to drill into; a
    // failed-resume entry carries failureCategory REQUIRED.
    haltedRuns?: Array<{
      runId: RunId;
      recoveryCondition: RecoveryCondition;
      failureCategory?: RunFailureCategory; // REQUIRED on a failed-resume entry; absent on a divergence halt
    }>;
  }>;
}

// ReplayReadAfterCursor
interface ReplayReadAfterCursorRequest {
  sessionId: SessionId;
  afterSequence: number;
  limit?: number;
}
interface ReplayReadAfterCursorResponse {
  events: EventEnvelope[];
  nextSequence: number;
  hasMore: boolean;
}

// ProjectionRebuild (idempotent operation)
interface ProjectionRebuildRequest {
  sessionId: SessionId;
  force?: boolean; // rebuild even if projections appear current
}
interface ProjectionRebuildResponse {
  sessionId: SessionId;
  rebuiltProjections: string[];
  asOfSequence: number;
}

// RuntimeBindingRead
interface RuntimeBindingReadRequest {
  runId: RunId;
}
interface RuntimeBindingReadResponse {
  runId: RunId;
  driverName: string;
  contractVersion: string;
  resumeHandle?: string;
  runtimeMetadata: Record<string, unknown>;
}

// ---- The file checkpoint store, and what undo reads ----
// The daemon copies aside every file the agent or one of its children is about to edit — Write, Edit,
// MultiEdit and NotebookEdit on Claude Code, `apply_patch` on Codex — at every prompt that starts a turn,
// from its own pre-tool hook, the same hook that holds a run for Pause: one mechanism, not a second
// interception path. What a shell command writes is inside the same store on both providers: around every
// command an agent or a child runs, the daemon captures the working folder before the command starts,
// holding the start until the capture is written, and again when it ends, holding nothing; every path
// that differs between the two captures enters the store as an ordinary copy under the checkpoint of the
// prompt that started the turn, and a file the command created is recorded as new and removed on undo. A
// capture is a git tree written from a per-session index into the session's own capture folder, never
// into the person's `.git`. The copies are held WITH THE SESSION and OUTSIDE THE CHECKOUT, so they never
// appear in a diff and survive a working-folder move; the last hundred checkpoints are kept with every
// file's first copy, and they survive a resume and a restart.
//
// Undo is two moments: a DRY RUN the person reads (`session.restorePreview`), then the restore itself
// (`session.restore`). Both take the same request — the session, a `target` that is a message's stable
// identity or a snapshot's, and a `scope` of `conversation-and-files`, `conversation` or `files` — and the
// restore's result is §Plan-002's undo result. The conversation half of a restore is the provider's OWN
// rewind verb; the file half is always this checkpointer.

// Why a file would be skipped, each shown with its reason in the count's hover title.
type SessionRestoreSkipReason =
  | "symbolic_link"
  | "hard_link"
  | "not_a_regular_file"
  | "directory_moved"
  | "too_large" // a file over 10 MiB that a command changed, on a volume that cannot clone it
  | "branch_moved_by_command"; // changed by a git command during which HEAD moved; putting it back would turn the branch's commits into uncommitted reversals

interface SessionRestorePreviewResponse {
  // The files that would be put back, and how many lines across them — the two figures the question
  // states before anything is written.
  fileCount: number;
  lineCount: number;
  // What would be skipped, each with its reason. The count is stated and each entry is readable, because
  // a skip the person cannot inspect is a silent partial restore.
  skipped: Array<{ path: string; reason: SessionRestoreSkipReason }>;
  // The agents started after the point, which the question names before it acts: on Claude Code the
  // conversation cut ends them and they cannot be resumed, on Codex the daemon stops each by id and they
  // resume. Zero means the question asks nothing extra.
  affectedChildCount: number;
  // The commands still running after the point, which the undo stops.
  runningCommands: number;
  // The data of the two lines the count's hover title carries whenever a command ran after the point:
  // the ignored folders an ordinary undo never puts back, by name, and whether a command ran at all.
  ignoredFolders: string[];
  commandsRanAfterPoint: boolean;
  // Paths another session working in the same folder also changed since the point, left as they are
  // unless the restore includes them.
  alsoChangedBy: Array<{ sessionId: SessionId; paths: string[] }>;
}
```

The dry run and the undo are `session.restorePreview` and `session.restore`, session verbs whose request and whose restore result are [§Plan-002 — Queue Steer Pause Resume](#plan-002--queue-steer-pause-resume)'s undo contract; `session.restorePreview` answers with `SessionRestorePreviewResponse` above and changes nothing. What is fixed here is the store — one hook for edits, a capture on each side of every command, three scopes addressed by a message or a snapshot — and a preview the person reads before anything is written.

---

## Plans 010 And 016

### Plan-010 — Live Timeline Visibility And Reasoning Surfaces

Every paged timeline reply is bounded by the frame it becomes (Plan-010 Phase 1). A JSON-RPC reply leaves the daemon inside one `Content-Length`-framed body, and a body over `MAX_MESSAGE_BYTES` is not a failed request: the framer refuses to emit it and the **connection closes** ([Spec-006 §Wire Format](../../specs/006-local-ipc-and-daemon-control.md#wire-format)). A row-count ceiling does not bound that — a `TimelineRow` carries free-form fields at `EVENT_FIELD_MAX_LEN` plus a 4 KiB `summary`, and `JSON.stringify` expands a control character to a six-byte escape, so 256 contract-valid rows exceed the cap several times over before `payload`, which this contract does not bound at all. So each of the paged members — `TimelineReadResponse.entries`, `ChildRunExpandResponse.entries`, and `ReasoningSurfaceReadResponse.reasoningEntries` — carries a byte budget (`TIMELINE_PAGE_MAX_BYTES`, the page's own constant — a 1,000,000-byte reply less a reserve for the envelope and the reply's non-paged members — declared apart from the 4 MB `MAX_MESSAGE_BYTES` and under it), a producer stops at whichever of the row limit and the byte budget trips first, and all these replies discriminate on `hasMore` so a caller can always continue. **The row limit that binds is the CALLER'S** (Plan-010 Phase 1): `TimelineReadRequest.limit` is optional and a response schema never sees the request, so `entries` is schema-bounded only at the global `TIMELINE_READ_LIMIT_MAX` and a read for ten rows answering with two hundred and fifty-six parses — a client sizing a viewport, a budget, or a render pass from the window it asked for is handed a larger one with nothing on the reply saying the request was not honored. The effective ceiling is therefore resolved per request — the caller's `limit` where it supplied one, the same global constant where it did not, which stays the default and the schema bound — and enforced at the daemon binder beside the request-scope checks, the only layer holding both numbers. `ChildRunExpandRequest` declares no `limit`, so its ceiling is that constant, stated on the same binder so one rule covers both paged reads. **The budget bounds aggregation and never bounds a page below one entry** (Plan-010 Phase 1): a continuing arm requires at least one entry — a page promising more and delivering none re-offers the same cursor forever while reading like progress — so where the first candidate alone exceeds the budget the producer pages that single entry and the reply is refused **for its size** at the response boundary, naming the member and its measured bytes on an error frame the substrate can deliver, rather than the page-fill helper returning a bare zero whose only representable answer is the empty continuing page the schema refuses. A **terminal** arm carries no such floor: an empty final page is the honest answer to a continuation whose cursor already sat at the end and to a filtered read that matched nothing. The budget does not reach a live event on `session.subscribe`, which is a single event on its own frame: an event that blows a frame by itself is an oversized event payload, and bounding it is an event-envelope and framer decision rather than one a Plan-010 page budget may make on their behalf.

```ts
// TimelineRead
interface TimelineReadRequest {
  sessionId: SessionId;
  afterCursor?: EventCursor;
  beforeCursor?: EventCursor;
  limit?: number;
}
// hasMore is the discriminant, not a flag beside an optional. The continuing arm REQUIRES nextCursor:
// a window promising more rows and supplying no way to ask for them leaves the caller re-reading the
// same window or giving up, and both lose rows the session holds (Spec-011 §Interfaces And Contracts,
// "cursor-based continuation"). The terminal arm PERMITS one and never requires it — the two members
// answer different questions, and a client that has just read to the end and now resumes session.subscribe
// from exactly there needs that position.
// The continuing arm additionally requires entries to be NON-EMPTY (Plan-010 Phase 1):
// a page promising more and delivering none advances no cursor while reading like progress, so the
// client re-asks from the same position and loops. The terminal arm keeps no floor — an empty final
// page is the honest answer to an exhausted continuation and to a filtered read that matched nothing.
// entries is additionally bounded by TIMELINE_PAGE_MAX_BYTES (see this section's opening note).
type TimelineReadResponse =
  | { entries: TimelineRow[]; hasMore: true; nextCursor: EventCursor }
  | { entries: TimelineRow[]; hasMore: false; nextCursor?: EventCursor };

interface TimelineRowBase {
  id: string;
  sessionId: SessionId;
  sequence: number;
  category: EventCategory; // open on three arms; PINNED on the rollback-boundary arm, and refused as "run_lifecycle" on the general arm
  type: string;
  actor?: string;
  summary: string; // human-readable summary
  timestamp: string;
  childRunSummary?: ChildRunSummary; // if this is a summarized child-run row
  payload: Record<string, unknown>;
}

type TimelineEntry = TimelineRowBase & { kind: "general" }; // the non-run arm: carries no run attribution structurally — the projector stamps kind from the event family, so a run-scoped family can never arrive on this arm. The arm additionally REFUSES category: "run_lifecycle" (Plan-010 Phase 1): all-or-none attribution is enforced by arm SELECTION, so a row whose kind was stamped wrong never reaches the run arm and its missing triple is never checked — it would arrive as a legitimately attribution-free general row. Every Spec-005 §Run Lifecycle type is run-scoped (the state transitions share a payload shape carrying a required runId; the non-state rows each re-list it), so the refusal costs no correct projection. The refusal is THREE-LEGGED, not category alone (Plan-010 Phase 1): category was only ever decisive for run_lifecycle, so the arm also refuses a canonical type in the derived census of Spec-005 types whose registered payload names a run unconditionally, and — for the types whose run identity is registered OPTIONAL (every artifact_publication type, the usage_telemetry types registered that way, user.message), which no type-level test can decide — a payload naming a run under either registered spelling, runId or the intervention family's targetRunId. The census is derived from Plan-004's per-category arrays rather than transcribed, so a type added to the taxonomy joins it without an edit here.

type RunScopedTimelineEntry = TimelineRowBase & {
  kind: "run"; // literal discriminator — row.kind narrowing is structural, never a probe of the free-form type: string
  runId: RunId; // run identity — with position + epoch, the REQUIRED all-or-none attribution triple the run.rolled_back live client rule keys on, never dug out of payload (CP-002-13): arm selection is by kind, so a run-scoped row missing any of the three fails ITS Zod arm — the malformed-row test — and can never fall through to the general arm
  position: number; // the row's projection-resolved originating run position (Plan-002 T3.16's uniform row-to-turn assignment); the live rule compares it against the run.rolled_back boundary's carried targetPosition (sequence is the session event sequence, never a run position)
  epoch: number; // the row's projection-resolved execution epoch (T3.16's row attribution: the stamped sourceEpoch on late rows, the operation association's epoch on in-time content-asynchronous rows, the run's current epoch at emission otherwise); position alone can never recover the epoch, since re-execution reuses ordinals
  superseded?: { targetPosition: number }; // present exactly when the row's turn is superseded, absence = current — projection-computed from Plan-002 T3.16's exported supersededTurns(runId); deliberately single-field: the marker's run identity and source epoch ARE the containing row's runId + epoch, so no duplicated fields exist to disagree and live marking (the row plus the boundary cutoff) is identical to replay marking by construction; targetPosition = the superseding rollback's rewind cutoff — the first accepted rollback in the run's lineage, at the row's epoch or later, that rewound the surviving history containing the row (a later rollback below an earlier retained prefix supersedes the inherited rows; a row ranks superseded when position exceeds the run's effective cutoff for its epoch — the minimum cutoff among accepted rollbacks at epoch >= the row's); identical on TimelineRead and on live delivery, rows delivered after a boundary arriving with the marker already projection-computed — per Spec-011 §Required Behavior
  // Where a projection echoes canonical keys into payload, they must AGREE with the outer triple
  // (Plan-010 Phase 1 — I-010-3's no-second-source rule reaching the payload): payload run
  // identity under either spelling (runId, targetRunId) must equal this row's runId, and payload
  // sourceEpoch / sourcePosition must equal this row's epoch / position. Echoing stays OPTIONAL and
  // absence passes; only disagreement is refused, because consumers filter and mark superseded on the
  // outer triple while the row's detail and provenance read the payload, so a row stating two
  // attributions is filed under one turn and sourced from another. The run-identity half binds every
  // arm carrying an outer runId.
};

type TimelineRollbackBoundary = Omit<TimelineRowBase, "category" | "type" | "payload"> & {
  kind: "rollback_boundary"; // literal discriminator
  category: "run_lifecycle"; // pinned with `type`, and for the same reason (Plan-010 Phase 1): run.rolled_back is registered under one category and no other, so leaving this open on the one arm whose event type is closed would leave the half that can still disagree — and a renderer grouping or filtering by category would file the rewind cutoff under the wrong family
  runId: RunId; // the rewound run
  position: number; // the boundary row's own originating position
  epoch: number; // the epoch the rollback rewound
  superseded?: { targetPosition: number }; // an earlier boundary row is itself superseded when a later rollback cuts below it — same single-field marker semantics as the run arm
  type: "run.rolled_back";
  payload: RunRolledBackEvent; // validated into the typed shape (defined under §Plans 002 And 015 above) at projection, so the live client rule reads a typed targetPosition — never an unsafe cast; an entry failing that validation is a projection defect surfaced at emission, never delivered untyped. Delivery is visibility-resolved: the boundary reaches every subscription holding any row of the affected run, so a subscriber holding that run's rows always receives the cutoff. Outer attribution and payload cannot disagree: the boundary arm's schema refines runId === payload.runId, sessionId === payload.sessionId, and position === payload.targetPosition (the boundary row ranks at the confirmed rewind floor — which is why a later rollback below it supersedes it), so a conflicting boundary fails parse as a projection defect, never delivered. The `Omit` on the base is load-bearing rather than stylistic (`packages/contracts/src/timeline/row.ts`): a plain `TimelineRowBase &` intersection would type `payload` as `Record<string, unknown> & RunRolledBackEvent`, which no `RunRolledBackEvent`-typed value satisfies (an interface carries no implicit index signature) and which `RunRolledBackEventSchema` cannot be annotated against — the typed payload this comment promises would be unconstructible. `type` is Omitted for the same reason it is re-declared: this arm narrows the base's free-form string to one literal.
};

type TimelineRow = TimelineRollbackBoundary | RunScopedTimelineEntry | TimelineEntry; // the row union every timeline surface returns — TimelineReadResponse.entries and ChildRunExpandResponse.entries are both TimelineRow — genuinely discriminated on the literal kind: the contracts Zod discriminatedUnion selects the arm by kind (rollback_boundary | run | general), each arm validates strictly, and consumers narrow structurally on row.kind — never probing type: string, never casting

// The incompleteness marker (Plan-010 T1.2). Spec-011 §Fallback Behavior requires that a child run whose detail fetch fails "remains
// visible and marked incomplete rather than disappearing"; without the mark,
// the only signal of incompleteness would be a low eventCount, which is indistinguishable from a child run
// that genuinely did little. Every cause is a term the corpus
// already owns — none is minted here:
type ChildRunIncompleteCause = "detail_fetch_failed"; // this daemon's own expansion read failed — Spec-011 §Fallback Behavior's own
//   naming of the condition ("if a child-run detail fetch fails"). Transient: a retry may succeed.
// Deliberately NOT reused: RepoMountHealth "unreachable" (scoped to filesystem mounts, whose own
// contract warns against overloading it across axes).
type ChildRunCompleteness =
  | { state: "complete" }
  | {
      state: "incomplete";
      cause: ChildRunIncompleteCause; // required on this arm only
      observedAt: string; // ISO-8601, daemon clock — when the cause was observed. Required because the
      //   cause is transient: a consumer deciding whether to retry, and a renderer
      //   deciding whether to age the notice, both need to know how old the reading is. A cause with no
      //   time is unactionable.
    };

interface ChildRunSummary {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  eventCount: number; // on the incomplete arm this is a LOWER BOUND — the count this daemon currently
  //   holds, not the child run's true total, which by definition it cannot know
  completeness: ChildRunCompleteness; // REQUIRED, not optional: an absent marker would be a third state
  //   meaning "probably fine", and Spec-011 §Fallback Behavior's rule is that incompleteness is STATED,
  //   never inferred from a small count.
  // runId !== parentRunId (Plan-010 Phase 1): a run that is its own parent makes the
  //   run-lineage graph cyclic, and every consumer of that graph walks it — the renderer nests a child
  //   under its parent, Spec-014's one-layer nesting rule is checked against the chain, and cost
  //   attribution sums along it. Refused once at the parse boundary rather than defended against
  //   separately at every walk. ChildRunExpandResponse carries the same refusal on the same pair.
}

// ReasoningSurfaceRead
// No member names a person (§Authenticated Principal And Authorization Model: no person in a request
// body), and the Zod arm is strict: a caller that sends one is refused, not silently stripped.
interface ReasoningSurfaceReadRequest {
  runId: RunId;
  afterCursor?: EventCursor; // continuation position, the same opaque cursor the sibling reads take (Plan-010 Phase 1) — a reasoning entry is projected from the run's events, so its resume position is an event position, and one namespace spelling its cursor two ways would make a client hold two kinds of bookmark for one surface
}
type ReasoningSurfaceReadResponse =
  // Availability is a discriminated union: an open shape — available: boolean with free optionals —
  // would serialize the available / unavailable cases identically, leaving Spec-011
  // §Acceptance Criteria's distinguish-the-cases requirement unrepresentable.
  // The available state is the one that PAGES, so it is the one that splits on hasMore (
  // Plan-010 Phase 1) — the same continuation rule TimelineReadResponse carries, nested inside the
  // availability discriminant so a paged reply is not a state of its own.
  // reasoningEntries is non-empty ON THE CONTINUING ARM ONLY (Plan-010 Phase 1).
  // A zero-entry available page claims a reasoning surface exists and then shows nothing, which renders
  // identically to unavailable while asserting the opposite — true of a FIRST read, and false of a
  // continuation whose afterCursor already sat at the end of the surface, which unavailable
  // would misstate. The schema cannot separate the two, because only the
  // request separates them: it carries the half it can see (the continuing arm, which is the arm that
  // can loop a client on a repeated cursor) and the daemon binder carries the first-page half, beside
  // the request-scope checks, under Plan-010 I-010-13.
  | {
      availability: "available"; // normalized reasoning present
      reasoningEntries: Array<{ sequence: number; content: string; timestamp: string }>; // required on this arm only, non-empty (continuing arm), bounded by TIMELINE_PAGE_MAX_BYTES
      hasMore: true;
      nextCursor: EventCursor;
    }
  | {
      availability: "available";
      reasoningEntries: Array<{ sequence: number; content: string; timestamp: string }>; // may be EMPTY on this arm — see the note above; a first read answering empty is refused at the binder
      hasMore: false;
      nextCursor?: EventCursor;
    }
  | { availability: "unavailable" }; // the run surfaced no reasoning; no entries — the client renders the unavailability placeholder from the state itself (I-010-7: absence never renders as nothing)
// The contracts Zod schema (T1.3) is a discriminatedUnion on availability with strict arms: entries on the
// unavailable arm or an `available: boolean` member fail parse — no tolerant fallback arm.

// ChildRunExpand
interface ChildRunExpandRequest {
  runId: RunId; // child run to expand
  afterCursor?: EventCursor; // continuation position (Plan-010 Phase 1) — named to match the sibling reads rather than a bare `cursor`: one namespace, one name for the position a caller resumes from
}
// Discriminated on hasMore exactly as TimelineReadResponse is, and for the same reason: a child run is
// not inherently smaller than a session window — a long-running subagent produces more rows than fit one
// frame — so the expansion needs the same continuation, on the same two arms, with the same rule about
// which of them may carry a cursor — and the same non-empty floor on the continuing arm, for the same
// reason: a child run's expansion loops a client on a repeated cursor exactly as a session read does.
// Two further rules the schema enforces (Plan-010 Phase 1):
// every entry that carries a run identity must carry THIS run's (the general arm is exempt, having none —
// a session-scoped row inside a child's window is context, not misattribution), and runId !== parentRunId,
// since a run that is its own parent makes the lineage graph cyclic and every walk of it — nesting,
// one-layer-depth checking, cost attribution — non-terminating.
type ChildRunExpandResponse = {
  runId: RunId;
  parentRunId: RunId;
  state: RunState;
  entries: TimelineRow[]; // bounded by TIMELINE_PAGE_MAX_BYTES as well as by the row cap
} & ({ hasMore: true; nextCursor: EventCursor } | { hasMore: false; nextCursor?: EventCursor });

// ---- What the working line reads: two per-turn subscriptions ----
// Both are per-turn live readings rather than projections of the log, and both are DERIVED from frames
// the provider already sends — neither adds a provider request and neither is polled.

// turn.usage — the tokens RECEIVED this turn. It starts at zero when the turn starts and steps up ONCE
// PER MODEL ROUND, never per word: each round adds the provider's own output count for that round — the
// output figure of Claude Code's per-message usage, and the `last` figure of Codex's token-usage
// notification — and the turn's figure is their sum. Reasoning is inside that count and is never added to
// it; the figure is never an iteration count and never a difference of two running totals, so the working
// line's reading means the same thing on both providers. It holds across a pause and stops at the turn's
// end; it is the only live token figure on the session screen, and the context ring, the cost receipt and
// a child's own tokens are different facts that keep their own surfaces.
interface TurnUsageSubscribeRequest {
  sessionId: SessionId;
  runId: RunId;
}
interface TurnUsageUpdate {
  runId: RunId;
  turnId: string;
  // Cumulative for this turn, not a delta: a subscriber that joins mid-turn reads the true figure
  // rather than having to sum what it missed.
  tokensReceived: number;
}

// turn.tasks — the agent's own task list for this turn, in the agent's own order. The driver folds
// Claude Code's task-list tool calls and Codex's plan-updated notification into one list; the daemon
// turns Codex's plan updates on per session, because the provider leaves them off by default. The list
// is the turn's: it goes when the turn is interrupted and returns with the next turn's list.
interface TurnTasksSubscribeRequest {
  sessionId: SessionId;
  runId: RunId;
}
interface TurnTasksUpdate {
  runId: RunId;
  turnId: string;
  // The WHOLE list per emission, in the agent's order, because a provider replaces its list rather
  // than patching it and a subscriber must never compose two halves into an order neither sent.
  tasks: Array<{ text: string; state: "not_started" | "in_progress" | "done" }>;
}

// ---- An agent's question ----
// Both providers can stop a turn to ask, with different mechanisms and one record: the daemon turns a
// held Claude Code question request or a Codex user-input request into ONE question record the screen
// renders and ONE call answers. It holds either request open with NO timer, rebuilds the card on a
// reload and on the person's other devices, and the first answer settles it everywhere. A question is an
// attention entry exactly as an approval is. Codex's NON-WAITING question is not this: it is the message
// item it already is, answered as an ordinary message, and the daemon marks the record answered when
// that message is taken.

// question.asked — the record the screen renders, registered in Spec-005's `interactive_request`
// category, which owns the name and the census.
interface QuestionAskedPayload {
  questionId: string;
  sessionId: SessionId;
  runId: RunId;
  // Several questions page one at a time; `pageCount` is how many there are and `questions` carries
  // them all, so paging needs no further read and typed text survives paging both ways.
  pageCount: number;
  questions: Array<{
    // The agent's own short header for the ask, shown as a chip; absent where it sent none.
    header?: string;
    // The question itself, and the agent's own heading shown as the summary line only where it sent
    // one.
    text: string;
    heading?: string;
    options: Array<{
      label: string;
      description?: string;
      // Present only where the provider attached a preview to the option, which one provider does and
      // the other does not; absence means the provider attached none.
      preview?: string;
    }>;
    // True where the provider marked the question as taking several answers, which decides whether the
    // rows are boxes or single-choice marks. One provider marks every question this way and the other
    // marks it per question, so the flag is the provider's reading and never a console default.
    severalAnswers: boolean;
    // True where the provider marked the question secret: the card then shows a masked field and NO
    // option rows, the value is never written into the flow, and the person's turn afterwards records
    // only that a secret was answered.
    secret: boolean;
  }>;
}

// question.resolve — one call answers every page. Per question the answer is exactly one of: the picked
// labels, typed text, a secret, or a skip — which is why the arms are a closed union rather than four
// optional members. A secret is delivered to the provider and NEVER stored: it reaches no event payload,
// no artifact and no projection. The person's turn is written as an ordinary message record with the
// secret masked.
type QuestionAnswer =
  | { kind: "picked"; labels: string[] }
  | { kind: "typed"; text: string }
  | { kind: "secret"; value: string }
  | { kind: "skipped" };
interface QuestionResolveRequest {
  questionId: string;
  // One entry per question, in the record's own order. Every question is answered together when the
  // last page is answered, so a partial list is refused rather than half-applied.
  answers: QuestionAnswer[];
}
interface QuestionResolveResponse {
  questionId: string;
  // The record is the receipt: a question that has been answered cannot be answered again, and a second
  // call reads this state rather than re-applying.
  state: "answered" | "canceled";
}
```

### Timeline Method-Name Registry

Plan-010's timeline surface is exposed as the `timeline.*` methods below, registered by Plan-010 (T1.4 registers the strings against the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out — the `repo.*` / `approval.*` precedent). These methods ride the **daemon JSON-RPC transport only**: the timeline is a daemon-local projection over the session event log per [ADR-016](../../decisions/016-shared-event-sourcing-scope.md), and no tRPC sibling exists in V1. Method tails are camelCase per the convention the Approval Method-Name Registry records.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `timeline.read` | `query` | `TimelineReadRequest` | `TimelineReadResponse` |
| `timeline.reasoningSurfaceRead` | `query` | `ReasoningSurfaceReadRequest` | `ReasoningSurfaceReadResponse` |
| `timeline.childRunExpand` | `query` | `ChildRunExpandRequest` | `ChildRunExpandResponse` |
| `turn.usage` | `subscription` | `TurnUsageSubscribeRequest` | `TurnUsageUpdate` (stream) |
| `turn.tasks` | `subscription` | `TurnTasksSubscribeRequest` | `TurnTasksUpdate` (stream) |
| `question.resolve` | `mutation` | `QuestionResolveRequest` | `QuestionResolveResponse` |

`turn` and `question` are two further registered roots on this same transport. They sit here rather than under `timeline` because a namespace names the thing it is about: the two subscriptions are readings of ONE TURN that end with it, while `timeline.*` reads the session's whole flow, and a question is a record with its own lifecycle rather than a row. Neither `turn.*` subscription is polled, and no `question.ask` exists to register — the record is minted by the daemon from the provider's own held request, never by a client.

The three `timeline` `query` rows are idempotent reads. The transcript's live rows ride the session's one stream, `session.subscribe`; a client that fell behind re-opens it with `afterCursor` at the last position it kept, and past a gap of 1,024 events takes a snapshot read. All request/response shapes are the interfaces defined directly above; the canonical Zod schemas live in `packages/contracts/src/timeline/` (T1.1–T1.3) per the §Source-of-Truth Policy.

### Plan-016 — Notifications And Attention Model

```ts
// AttentionProjectionRead — the machine's whole attention projection, served live: the first emission is
// the whole projection, then one emission per change. The bell's count and its list, the app icon's count
// and the operating-system notification are all read from it, and from nothing else.
// With no session named, the whole projection across every session and workflow run. Naming a session
// narrows by D-016-4: scope "run" requires runId, and runId is admissible only with scope "run".
interface AttentionProjectionReadRequest {
  sessionId?: SessionId;
  scope?: "run" | "session";
  runId?: RunId;
}
interface AttentionProjectionReadResponse {
  items: AttentionItem[]; // one emission of the stream
}

interface AttentionItem {
  id: string;
  // The MOMENT this entry speaks for — the session or run and the episode it is in, minted by the
  // projection and never composed by a client. Every operating-system notification carries it, so a
  // subject that moves from waiting to finished while nobody is looking REPLACES its banner in place
  // instead of standing a second one beside it: the waiting entry and the finished one that follows it
  // share this id. It is deliberately not `id` and deliberately not the state — an id per entry would
  // post a second banner for the same subject, and an id carrying the state would defeat the
  // replacement it exists to make possible. The notifications list groups by it too, one line per
  // moment. The main process posts from this projection and from nothing else: a `pending` entry only
  // while no console window is focused (a workflow's Notify step posts either way), and it withdraws the
  // banner when the entry resolves — so answering on another device clears it here. With the app not
  // running, the daemon starts the app's own program with no window to post the banner, and that process
  // exits.
  momentId: string;
  sessionId: SessionId;
  runId?: RunId;
  // The name the entry is shown under: the session's name, or the run's name on a run's entry. `summary`
  // never becomes a notification's body.
  subjectName: string;
  // The console draws four kinds from these: `Waiting on you` (`pending_approval`, `pending_input`;
  // counted, and withdrawn when resolved), `Finished` (`run_completed`) and `Failed` (`run_failed`), listed
  // under `Earlier` and never counted, and a workflow's Notify step (`workflow_notify`), listed under
  // `Earlier`, never counted and never withdrawn. A Notify step is one informational entry with no event
  // of its own.
  trigger:
    | "pending_approval"
    | "pending_input"
    | "run_completed"
    | "run_failed"
    | "workflow_notify";
  stepId?: string; // present on a `workflow_notify` entry: the step that posted it
  severity: "actionable" | "informational";
  summary: string;
  // What became of the entry's banner. The daemon writes `withheld` when it writes the entry for a kind
  // this machine's settings switch off, for the master switch off, and for a muted session's `Finished` or
  // `Failed`, and starts no windowless app for it; the main process settles every other outcome through
  // `attention.bannerSettle`, so a banner is never posted twice. Absent on an aggregate, which posts no
  // banner.
  bannerState?: "pending" | "posted" | "withheld" | "withdrawn";
  sourceEventId: string; // canonical event that triggered this
  createdAt: string;
  resolvedAt?: string;
}

// AttentionBannerSettle — called by the main process alone: records what became of an entry's banner. A
// no-op once the entry is past `pending`.
interface AttentionBannerSettleRequest {
  entryId: string;
  state: "posted" | "withheld" | "withdrawn";
}
interface AttentionBannerSettleResponse {}

// AttentionSeenUpdate — marks a session seen: the one seen-or-unseen fact the sessions list's done dot
// and the email digest read.
interface AttentionSeenUpdateRequest {
  sessionId: SessionId;
}
interface AttentionSeenUpdateResponse {}

// Delivery beyond this machine's screen. The switches are the machine's settings file's; these verbs hold
// the channels' secrets and report what each channel last did. Apart from the signing secret, returned
// once when it is minted or made new so the receiver can be set up, no secret is on a reply, an event, a
// log or an error.
interface AttentionDeliveryOutcome {
  at: string;
  // notAnAddress: a test of saved web-address text with no scheme and host; nothing was sent.
  result:
    | "delivered"
    | "refused"
    | "unreachable"
    | "timedOut"
    | "signInRefused"
    | "notEncrypted"
    | "notAnAddress";
  httpStatus?: number;
  undelivered: number;
}
interface AttentionDeliveryReadRequest {}
interface AttentionDeliveryReadResponse {
  webAddress: { saved: boolean; host?: string; lastOutcome: AttentionDeliveryOutcome | null };
  emailDigest: { passwordSaved: boolean; lastOutcome: AttentionDeliveryOutcome | null };
}
interface AttentionDeliveryTestRequest {
  channel: "webAddress" | "emailDigest";
}
interface AttentionDeliveryTestResponse {
  outcome: AttentionDeliveryOutcome;
}
interface AttentionMailPasswordSaveRequest {
  password: string; // write-only: sealed in the keychain, never read back
}
interface AttentionMailPasswordSaveResponse {}
interface AttentionMailPasswordRemoveRequest {}
interface AttentionMailPasswordRemoveResponse {}
interface AttentionWebAddressSaveRequest {
  address: string;
}
interface AttentionWebAddressSaveResponse {
  host?: string; // absent for saved text with no scheme and host, which reads masked
  signingSecret?: string; // present only on the first save, which mints it
}
interface AttentionWebAddressSecretRotateRequest {}
interface AttentionWebAddressSecretRotateResponse {
  signingSecret: string; // shown once
}
interface AttentionWebAddressRemoveRequest {} // removes the address and its signing secret
interface AttentionWebAddressRemoveResponse {}
// Refusals: `attention.delivery_store_unavailable` (`cause: locked | unavailable`) and
// `attention.delivery_not_configured` (`missing: address | password`).
```

> **Scope and aggregate carrier (Plan-016 D-016-2).** `runId` is the scope discriminator: an item carrying it is run-scoped, an item omitting it is the session-scoped aggregate that [Spec-017 §Required Behavior](../../specs/017-notifications-and-attention-model.md#required-behavior) requires alongside run scope. There is no separate aggregate type and no aggregate-only field. On an aggregate, `severity` carries the aggregation — `actionable` while **any** unresolved contributor (a run-scoped item or a pending request) is actionable, `informational` only when every contributor is — per [Spec-017 §Default Behavior](../../specs/017-notifications-and-attention-model.md#default-behavior), while `trigger` and `sourceEventId` are taken from one deterministically selected representative contributor: highest severity first (`actionable` before `informational`), then earliest `createdAt`, then lexicographically smallest `id`. Because the representative is a real contributor rather than a synthesized placeholder, `sourceEventId` always resolves on an aggregate and stays non-optional. Aggregates are read-projection-only: `attention.projectionRead` returns them and no delivery carries one — a banner, a web-address message or an email line speaks for the single canonical trigger that caused it, so no aggregate is ever delivered and no per-contributor fan-out is inferred from one. Canonical statement: [Plan-016 §API And Transport Changes](../../plans/016-notifications-and-attention-model.md#api-and-transport-changes) and [Plan-016](../../plans/016-notifications-and-attention-model.md) D-016-2.

### Attention Method-Name Registry

Plan-016's attention surface is exposed as the `attention.*` methods below, all on the **daemon JSON-RPC transport**: the attention projection is a daemon-local replay-derived projection over canonical session and run state per [ADR-016](../../decisions/016-shared-event-sourcing-scope.md) — the `timeline.*` posture above — and the delivery channels' secrets and outcomes are this machine's. They register against the Plan-005-partial daemon `MethodRegistry` per the §5 substrate-vs-namespace carve-out (the §2 `packages/runtime-daemon/src/ipc/` row's Plan-016 `attention.*` entry). Method tails are camelCase per the convention the Approval Method-Name Registry records.

| Method | Procedure type | Request schema | Response schema |
| --- | --- | --- | --- |
| `attention.projectionRead` | `subscription` | `AttentionProjectionReadRequest` | `AttentionProjectionReadResponse` (stream) |
| `attention.bannerSettle` | `mutation` | `AttentionBannerSettleRequest` | `AttentionBannerSettleResponse` |
| `attention.seenUpdate` | `mutation` | `AttentionSeenUpdateRequest` | `AttentionSeenUpdateResponse` |
| `attention.deliveryRead` | `query` | `AttentionDeliveryReadRequest` | `AttentionDeliveryReadResponse` |
| `attention.deliveryTest` | `mutation` | `AttentionDeliveryTestRequest` | `AttentionDeliveryTestResponse` |
| `attention.mailPasswordSave` | `mutation` | `AttentionMailPasswordSaveRequest` | `AttentionMailPasswordSaveResponse` |
| `attention.mailPasswordRemove` | `mutation` | `AttentionMailPasswordRemoveRequest` | `AttentionMailPasswordRemoveResponse` |
| `attention.webAddressSave` | `mutation` | `AttentionWebAddressSaveRequest` | `AttentionWebAddressSaveResponse` |
| `attention.webAddressSecretRotate` | `mutation` | `AttentionWebAddressSecretRotateRequest` | `AttentionWebAddressSecretRotateResponse` |
| `attention.webAddressRemove` | `mutation` | `AttentionWebAddressRemoveRequest` | `AttentionWebAddressRemoveResponse` |

**One live feed.** `attention.projectionRead` is a live read in the manner of `command.list`: its first emission is the whole projection and each later one follows a change, so the bell, the list, the app icon's count and the operating-system notification read one feed, the main process holding its own subscription beside the renderer's. `attention.bannerSettle` is called by the main process alone, including the windowless process the daemon starts to post a banner while no app runs, which settles the entry and exits.

**The preferences are the machine's settings file's.** No `attention.*` verb carries a notification preference, and the daemon keeps none of its own. `Notify me outside the app`, the four kinds beneath it (`Waiting on you`, `Finished`, `Failed`, `Notify steps`, each on by default), the web address's switch and kinds, and the email digest's settings other than its password are this device's, kept in the machine's settings file (§Settings Surface Reads And Writes below); the daemon reads them, with the session's mute, each time it writes an entry, and no preference gates a withdrawal.

**Delivery off this screen is the machine's own.** `Email me what I have not seen` is off by default. When on, the service sends at most one email per period — an hour, four hours or a day, a day by default — through the person's own mail account, sent by Nodemailer over TLS only (on 465 from the start, on 587 with a required STARTTLS, so a server that will not encrypt is refused before the password is written). It lists each `Waiting on you` still unresolved and each `Finished`, `Failed` or Notify-step moment whose session or run has not been opened since, each once, never a muted session's `Finished` or `Failed`, and names each session or run, its state, its time and its `sidekicks://` address, never what was said. `Send to a web address` is off by default. When on, the service sends one Standard Webhooks-signed JSON `POST` per moment of the kinds picked for it (`text`, `kind`, `state`, `subject`, `momentId`, `at`, `machine`, `link`; never what was said), never for a muted session's `Finished` or `Failed` and nothing for a withdrawal, and only while no console window is in front on any device, except that a workflow's Notify step always sends. The address is whatever the person typed; success is a 2xx answer within 15 s and a redirect is a failure; a failed send is retried at 5 s, 5 min and 30 min, with at most 100 waiting, the oldest dropped and counted past that. The mail password, the address and its signing secret are sealed in the operating system's keychain; the address is shown back as its host only, and text with no scheme and host, saved as typed like any other, reads masked with no host while each message to it fails and counts as undelivered. A push to another of the person's devices is sealed on this machine and sent through `push.send` ([Spec-027](../../specs/027-remote-control.md)); the control plane keeps no notification queue, filter or preference. Canonical Zod schemas live in `packages/contracts/src/attention.ts` per the §Source-of-Truth Policy.

### Page-Host Method Registry

The Preview pane and the machine-wide Browser page are served by two daemon JSON-RPC roots, `preview` and `browser`. Both register against the Plan-005 `MethodRegistry` in that plan's remainder, which owns them along with the daemon-side pieces they answer from ([Plan-005 CP-005-14](../../plans/005-local-ipc-and-daemon-control.md#cp-005-14--the-daemons-page-host-namespaces-preview-and-browser-owed-to-plan-020-cp-020-5)).

**Why the daemon and not the main process.** There are TWO page hosts and ONE endpoint: the desktop's own native page view, and — where no desktop runs — the daemon's headless browser, launched over Playwright's own pipe with no listening port and with `acceptDownloads: false`. One resolver in the daemon returns the live host and nothing above it branches, so an agent never knows which host it is talking to: the daemon reaches the desktop's pages through the relay's debugger link on the connection the app dials to the service, never a debug port, and the headless browser directly. Putting the verbs on the daemon is what makes that true; putting them on the main process would give the no-desktop case no surface at all. A file a page saves, in the Preview pane of the machine's own desktop window, opens the system save dialog: the Preview feature asks for it through the platform bridge, and the main process owns the dialog and the file write, so the window gains no file access. On another device, on the headless host, or anywhere no person at that machine can choose, the download is refused and nothing is written — on the desktop host main cancels it in `will-download` with its documented cancel, `event.preventDefault()`, and reports the refusal to the service, and the headless host is launched with downloads off — and the service sends one line back to the pane, `Downloads are off in Preview`. The renderer owns no page: it publishes the rectangle a page is positioned to and renders the outcomes, through the preload bridge's own page-host namespace — a **bridge namespace canonical in the `PlatformBridge` interface in the front end's `services/platform/`** per the §Source-of-Truth Policy, which shares the word `browser` with the root below and is a different surface: the bridge positions and captures a page, the root below manages pages and site data. The bridge's `daemon`, `native` and `window` namespaces are canonical in that same file and are not mirrored here; what the design fixes about them is one rule each — every address the console hands outward goes through the bridge's external-open except a loopback address printed in a reply, a tool row or a shell, which opens in the Preview pane instead; the composer's attach picker takes files only and several at a time, never a folder, and hands back tokens, never a path; and any side pane can move into its own window.

| Method | Procedure type | Request → Response | What it carries |
| --- | --- | --- | --- |
| `preview.pageList` | `subscription` | `PreviewPageListRequest` → `PreviewPageListResponse` (stream) | The session's open pages in the session's order — address, title, favicon, load state, history depth, zoom, and whether the page is released — plus the active index; read by the renderer and by the main process, which keeps one page view per page in step with it |
| `preview.pageOpen` | `mutation` | `PreviewPageOpenRequest` → `PreviewPageOpenResponse` | Opens a page from an address or from a discovered dev server; the main process also calls it with the address of a popup a page opens, so a popup becomes a page and never a window |
| `preview.pageClose` | `mutation` | `PreviewPageCloseRequest` → `PreviewPageCloseResponse` | Closes one page |
| `preview.pageActivate` | `mutation` | `PreviewPageActivateRequest` → `PreviewPageActivateResponse` | Makes one page the open one |
| `preview.pageReorder` | `mutation` | `PreviewPageReorderRequest` → `PreviewPageReorderResponse` | Moves one page to a new place in the strip; the order is the session's, so every device draws it the same |
| `preview.navigate` | `mutation` | `PreviewNavigateRequest` → `PreviewNavigateResponse` | Navigates a page; back, forward and reload ride the same verb rather than three of their own |
| `preview.zoom` | `mutation` | `PreviewZoomRequest` → `PreviewZoomResponse` | Sets a page's zoom factor on the executing machine |
| `preview.devServerList` | `subscription` | `PreviewDevServerListRequest` → `PreviewDevServer[]` (stream) | The dev servers discovered in the session's project — name, framework where known, port. Ticks only while a project session is live |
| `preview.marksSend` | `mutation` | `PreviewMarksSendRequest` → `PreviewMarksSendResponse` | The frozen picture and its marks, staged as one attachment in the session's composer; it goes to the provider with the ordinary Send |
| `preview.screencastSubscribe` | `subscription` | `PreviewScreencastSubscribeRequest` → `PreviewScreencastFrame` (stream) | The frame stream, its acknowledgments and the input channel — another device only, live only while that device has the pane open |
| `browser.siteDataList` | `query` | `BrowserSiteDataListRequest` → `BrowserSiteDataListResponse` | The sites with saved data, each saying whether it holds an unexpired cookie |
| `browser.siteDataForget` | `mutation` | `BrowserSiteDataForgetRequest` → `BrowserSiteDataForgetResponse` | `Forget`: one site's full erase — cookies, storage, cache and service workers — across its registrable domain |
| `browser.siteDataClear` | `mutation` | `BrowserSiteDataClearRequest` → `BrowserSiteDataClearResponse` | Clears every site's saved data |
| `browser.siteCookiesClear` | `mutation` | `BrowserSiteCookiesClearRequest` → `BrowserSiteCookiesClearResponse` | `Clear cookies`: one site's cookies across its registrable domain, parent-domain cookies included, and nothing else |
| `browser.siteSignIn` | `mutation` | `BrowserSiteSignInRequest` → `BrowserSiteSignInResponse` | `Sign in`: opens the site in a browser page of its own that belongs to no session, over the machine's one site-data set, showing the address line and nothing else |
| `browser.chromiumRead` | `query` | `BrowserChromiumReadRequest` → `BrowserChromiumReadResponse` | Which browser the headless host uses — an installed Chrome or Edge, or Playwright's Chromium — with its version and when it was fetched |
| `browser.chromiumFetch` | `mutation` | `BrowserChromiumFetchRequest` → `BrowserChromiumFetchResponse` | `Fetch it again`: fetches Playwright's Chromium again; its progress is the fetch's own flow row |

**The main process's page host.** The desktop's pages live in the main process, so the daemon also calls the main process, and the main process reports to the daemon, on the `preview` root. These calls ride the connection the app dials to the service, which the app labels with `DaemonHello.clientId` — a label, not authentication — and never the preload bridge or a port.

| Method | Direction | Procedure type | Request → Response | What it carries |
| --- | --- | --- | --- | --- |
| `preview.pageTargetReport` | main → daemon | `mutation` | `PreviewPageTargetReportRequest` → `PreviewPageTargetReportResponse` | Each page view's debug target, so the relay joins exactly the Preview pages |
| `preview.pageDebuggerSend` | daemon → main | `mutation` | `PreviewPageDebuggerSendRequest` → `PreviewPageDebuggerSendResponse` | One debug-protocol command to a page, which main passes to that page view's in-process debugger |
| `preview.pageDebuggerReport` | main → daemon | `mutation` | `PreviewPageDebuggerReportRequest` → `PreviewPageDebuggerReportResponse` | One debug-protocol reply or event from a page view |
| `preview.pageCookiesRead` | daemon → main | `query` | `PreviewPageCookiesReadRequest` → `PreviewPageCookiesReadResponse` | The desktop host's cookies, in Playwright's storage-state cookie shape, when the headless host takes over |
| `preview.pageCookiesWrite` | daemon → main | `mutation` | `PreviewPageCookiesWriteRequest` → `PreviewPageCookiesWriteResponse` | Cookies written into the desktop host when it takes over, `expires` mapped to Electron's `expirationDate` |
| `preview.pageCookiesClear` | daemon → main | `mutation` | `PreviewPageCookiesClearRequest` → `PreviewPageCookiesClearResponse` | One site's cookies cleared across its registrable domain, answered with Electron's `ses.clearData` given `dataTypes: ['cookies']`, the one call that removes a parent-domain cookie |
| `preview.pageSiteDataClear` | daemon → main | `mutation` | `PreviewPageSiteDataClearRequest` → `PreviewPageSiteDataClearResponse` | One site's saved data or, with no origins, every site's, answered with `ses.clearData({origins, dataTypes})` for named sites and `ses.clearData()` for all |

The main process attaches Electron's in-process debugger to each Preview page view and to no other `webContents`. The relay joins those pages into one browser whose target list is exactly the Preview pages, the console's own windows absent; on a page's session it passes only `Target.setAutoAttach`, the detach of that page's own children and `Target.getTargetInfo` for its own target, and refuses every other `Target.*` and `Browser.*` command, because a page's debugger reaches every target in the app. On the headless host the daemon does the same work in its own browser context: `context.clearCookies({domain})` for `Clear cookies`, and that plus the site's storage for `Forget`. Moving site data between the two hosts happens only when one takes over from the other: cookies through the cookie calls, local storage and IndexedDB replayed by script, and passkeys never crossing, which the pane says rather than silently dropping a login.

**The agent's browser tools are not session verbs.** They are one tool-server connection per session, hosted inside the daemon and attached to that session's debug endpoint, reached by the provider through the session's one MCP entry. The renderer learns about them the way it learns about any tool call — as rows in the transcript — so no verb above dispatches one. `Browser tools for sidekicks`, a switch in the machine's settings file, decides whether the browser tools are in that entry's tool list: off leaves only them out, and the entry stays for the daemon's other tools. `Remember site data`, the other browser switch, is the settings file's too; neither is a verb.

```ts
// One open page in a session's Preview pane. The id is the daemon's; no client mints one.
interface PreviewPage {
  pageId: string;
  address: string;
  title: string; // the host until the page's own title arrives
  favicon?: string;
  loadState: "loading" | "loaded" | "failed";
  // The history depth behind and ahead of where the page stands — what the back and forward controls
  // read to decide whether they can act. They are the one pair of controls the console grays in place
  // rather than hiding, because the person changes their subject by following a link.
  backDepth: number;
  forwardDepth: number;
  zoomFactor: number; // 1 when a page opens
  // A released page keeps its address, order and zoom and reloads when shown; the main process destroys
  // its page view. A page nobody has looked at for ten minutes is released, and when the machine's memory
  // falls below the workflow memory gate's headroom — 20% of physical memory, and at least 1 GiB — the
  // oldest page nobody is looking at is released first, one every 1.5 s until the reading is back above
  // it, never the page on screen.
  released: boolean;
}
interface PreviewPageListRequest {
  sessionId: SessionId;
}
// One emission of the stream: the first is the current state, then one per change. The daemon keeps each
// session's pages — address, order, which is active, zoom — in its own per-session page store: a service
// restart reconnects the page views the app still holds without reloading them, and headless pages, and
// every page after an app restart, come back released.
interface PreviewPageListResponse {
  pages: PreviewPage[]; // in the session's order
  // The page the pane is showing. -1 where the session has no page open, so an empty pane is
  // representable without an optional member that a reader could mistake for "unknown".
  activeIndex: number;
}

// Opening is EITHER an address the person entered or a server the daemon discovered — a closed union,
// so a caller cannot ask for both and leave the daemon to choose. An entry the pane will not take is
// refused by NAMING THE CAUSE and the page stays where it was: text that is not an address is refused
// as not-an-address rather than searched, and a scheme the pane cannot open says so. An address carrying
// a username or a password opens as typed. Nothing is ever searched on the web.
type PreviewPageTarget = { kind: "address"; address: string } | { kind: "devServer"; port: number };
interface PreviewPageOpenRequest {
  sessionId: SessionId;
  target: PreviewPageTarget;
}
interface PreviewPageOpenResponse {
  pageId: string;
  // The page the ceiling released to make room, where one was released. Its address is kept and it
  // reloads on demand, so this is a fact the pane may report and never a refusal.
  releasedPageId?: string;
}

interface PreviewPageCloseRequest {
  sessionId: SessionId;
  pageId: string;
}
interface PreviewPageCloseResponse {
  closed: true;
}

interface PreviewPageActivateRequest {
  sessionId: SessionId;
  pageId: string;
}
interface PreviewPageActivateResponse {
  activePageId: string;
}

// The order is the session's, so every device draws the same strip.
interface PreviewPageReorderRequest {
  sessionId: SessionId;
  pageId: string;
  toIndex: number; // the place in the list without that page
}
interface PreviewPageReorderResponse {
  pageIds: string[]; // the session's new order
}

// One verb for five acts, because all five move the same page's position in its own history.
interface PreviewNavigateRequest {
  sessionId: SessionId;
  pageId: string;
  to:
    | { kind: "address"; address: string }
    | { kind: "back" }
    | { kind: "forward" }
    | { kind: "reload" };
}
interface PreviewNavigateResponse {
  pageId: string;
  address: string;
  backDepth: number;
  forwardDepth: number;
}

interface PreviewZoomRequest {
  sessionId: SessionId;
  pageId: string;
  zoomFactor: number;
}
interface PreviewZoomResponse {
  pageId: string;
  zoomFactor: number;
}

// Discovery is the DAEMON'S, never the renderer's: one probe loop per daemon, enumerating the listening
// sockets owned by the session's own process tree and probing each briefly. `framework` is present only
// where the probe could tell, so its absence means the server did not say rather than that it has none.
interface PreviewDevServerListRequest {
  sessionId: SessionId;
}
interface PreviewDevServer {
  port: number;
  name?: string;
  framework?: string;
}

// A mark drawn on the frozen picture. Three kinds: a numbered comment, a numbered box, and a pen stroke,
// which is never numbered — which is why removing a comment renumbers the comments and boxes and leaves
// strokes alone. Every mark carries the element reference and bounding box taken from the page snapshot
// AT MARK-COMMIT TIME, so a mark drawn on another device's live picture reaches the agent as the same
// attachment as one drawn on the machine that runs the session. A reference is valid ONLY for the
// snapshot generation that minted it, which is why the generation rides with it and is never assumed to
// survive the next snapshot.
interface PreviewMark {
  kind: "comment" | "box" | "stroke";
  // Present on a comment and a box, absent on a stroke.
  number?: number;
  // The person's words, on a comment.
  text?: string;
  // Page coordinates in viewport CSS pixels. A stroke carries its points; a comment and a box carry
  // their rectangle.
  rect?: { x: number; y: number; width: number; height: number };
  points?: Array<{ x: number; y: number }>;
  // A stroke's color, taken from the hue slider when it was drawn; comments and boxes take the accent.
  color?: string;
  // The element the mark landed on, resolved by the daemon from the snapshot rather than by mutating
  // the page or asking it a second time. Absent where the mark hit no element.
  elementRef?: string;
  snapshotGeneration: number;
}
// `Send marks` stages ONE attachment in the session's composer — the picture with the marks plus, per
// mark, its number, note, element reference and box (a stroke: its points and color), the page's address
// and its width — and focuses the draft. The attachment goes to the provider with the ordinary Send, in
// that provider's own image shape, and shows in the transcript as the user turn's picture.
interface PreviewMarksSendRequest {
  sessionId: SessionId;
  pageId: string;
  // The frozen picture the marks were drawn on — the page capture on the machine, the screencast frame on
  // another device — carried as base64. It is never captured again at send, which would not match the
  // marks.
  image: string;
  address: string;
  width: number; // the page's width in CSS pixels when it was frozen
  // The marks that exist NOW, not the set at the moment the send control was pressed, so an attachment
  // whose last mark was removed sends nothing and goes away instead.
  marks: PreviewMark[];
}
interface PreviewMarksSendResponse {
  staged: SessionAttachmentSummary; // the composer's attachment chip, `<N> marks on <path>`
}

interface PreviewScreencastSubscribeRequest {
  sessionId: SessionId;
  pageId: string;
}
// Each frame carries what maps its pixels back to page coordinates, which is what lets a mark drawn on
// the picture carry the same element reference as one drawn on the page. Every frame is acknowledged:
// an unacknowledged stream stalls after a small fixed number of frames in flight, so acknowledgment is
// part of the contract rather than an optimization. The acknowledgments and the input travel back on the
// same channel the stream rides over the relay: the subscriber returns each frame's `ackToken`, another
// device's touches reach the page as touch events with touch emulation left off, a pinch zooms only the
// picture on the device, and typed keys reach the page as key input.
interface PreviewScreencastFrame {
  pageId: string;
  imageData: string;
  metadata: {
    offsetTop: number;
    pageScaleFactor: number;
    deviceWidth: number;
    deviceHeight: number;
    scrollOffsetX: number;
    scrollOffsetY: number;
  };
  // The token the subscriber returns to acknowledge this frame.
  ackToken: string;
}

// Site data is ONE set per machine, shared by every page, the tools and workflow steps, with per-site
// forgetting — not a partition per session. Rows are keyed per registrable domain; `origin`
// (`scheme://host:port`) names the site, and a clear or a forget covers its whole registrable domain,
// because a per-origin clear leaves a parent-domain cookie behind.
interface BrowserSiteDataListRequest {}
interface BrowserSiteDataListResponse {
  // `hasCookies` is true while the site holds at least one unexpired cookie (the row reads `Saved cookies`
  // and carries `Clear cookies`) and false while it holds other saved data and no cookie (`Saved site
  // data`, carrying `Sign in`). No member says whether the person is signed in, because a saved cookie
  // proves neither.
  sites: Array<{ origin: string; sizeBytes: number; lastUsedAt: string; hasCookies: boolean }>;
}
interface BrowserSiteDataForgetRequest {
  origin: string;
}
interface BrowserSiteDataForgetResponse {
  origin: string;
  forgotten: true;
}
interface BrowserSiteDataClearRequest {}
interface BrowserSiteDataClearResponse {
  cleared: true;
}
// Clears the site's cookies and nothing else — its storage, cache and service workers stay — and claims
// nothing about whether the person is signed out.
interface BrowserSiteCookiesClearRequest {
  origin: string;
}
interface BrowserSiteCookiesClearResponse {
  origin: string;
  cleared: true;
}
// When the sign-in page closes, the Browser page reads `browser.siteDataList` again.
interface BrowserSiteSignInRequest {
  origin: string;
}
interface BrowserSiteSignInResponse {
  origin: string;
}
interface BrowserChromiumReadRequest {}
interface BrowserChromiumReadResponse {
  source: "chrome" | "edge" | "playwright";
  version: string;
  fetchedAt?: string; // present for Playwright's Chromium
}
interface BrowserChromiumFetchRequest {}
interface BrowserChromiumFetchResponse {
  started: true; // a fetch already running is joined, not repeated
}

// The main process's page-host leg (the second table above).
interface PreviewPageTargetReportRequest {
  pageId: string;
  targetId: string;
}
interface PreviewPageTargetReportResponse {}
// One debug-protocol message, carried verbatim: a command on the send, a reply or an event on the report.
interface PreviewPageDebuggerSendRequest {
  pageId: string;
  message: string;
}
interface PreviewPageDebuggerSendResponse {}
interface PreviewPageDebuggerReportRequest {
  pageId: string;
  message: string;
}
interface PreviewPageDebuggerReportResponse {}
interface PreviewPageCookiesClearRequest {
  domain: string; // the site's registrable domain
}
interface PreviewPageCookiesClearResponse {
  domain: string;
}
interface PreviewPageSiteDataClearRequest {
  origins?: string[]; // absent clears every site
}
interface PreviewPageSiteDataClearResponse {
  cleared: true;
}
// `PreviewPageCookiesRead*` and `PreviewPageCookiesWrite*` carry the cookies in Playwright's
// storage-state cookie shape, `expires` mapped to Electron's `expirationDate` on write.
```

### Settings Surface Reads And Writes

**No `settings.*` method is registered.** The Settings screen is ten pages, and every page reads and writes through a named surface: the daemon's own verbs, the main process's bridge members, or the machine's settings file. This section says which each page uses; the build status of each daemon verb is in [§Operations Not Yet Built](#operations-not-yet-built).

- **General** goes through the main process's own update channel — `update.getState`, `update.subscribe`, `update.requestCheck`, `update.requestDownload` and `update.requestRestart` — and the app's reported facts (`app.version`, `app.platform`, `app.arch`, `app.locale`), with `native.listEditors()` for the editor list. The editor preference, the default checkout for a new project session, the new-session switch, the keep-awake switch and the crash-report switch are the machine's settings file's, read and written through `machineSettings.read()`, `machineSettings.write(change)` and `machineSettings.subscribe()`; the background service reads the keep-awake switch and holds the machine and its screen awake itself while any agent works.
- **Providers** is one section per provider, and its two halves read through different surfaces. **The accounts half** goes through the `providerAccount.*` namespace of §Plan-023: `providerAccount.list` and `providerAccount.subscribe`, `.register`, `.update`, `.remove`, `.setCurrent` (which moves the `Default` mark; a session on that provider moves to the new account in place at its next request), `.probe` (`Check now`, and the five-minute read), `.resetCredentialHome` (the page's `Sign out`), `.login` and `.loginCancel` (the brokered sign-in), `.memoryImport` (the one-time copy of the person's own provider memories into an account's home) and `.usageRead`. An account is named by the identity its provider reports — the address, the plan in the provider's own word, and the organization where the plan carries one — so no payload on this page carries a label the person typed, and the only field the person authors that the update mutation corrects is the billing mode. **The provider's half** goes through the `provider.*` root: `provider.list` (each provider's status and its own knobs), `provider.update` (one knob per press: the command path, whether the provider is available for new sessions, the helper processes at once, the automatic-compaction bound, the output style, and Codex's `Reach Codex sessions started in a terminal`), `provider.probe {provider}` (the command's `Check again`: the executable resolved again and its version re-read), `provider.protectedPathList` (each protected path with the source it came from), `provider.install {provider}`, `provider.installSubscribe` and `provider.installStop` (`Install`), and `provider.terminalPluginUpdate {provider, enabled}` (the terminal plugin switch, which writes only its own key in the person's Claude Code settings). Claude Code's `Advisor` row is the advisor default for sessions created later, a key of the machine's settings file written through `machineSettings.write(change)` and never a write to Claude Code's own settings; a session takes it when it is created and keeps its own value from then on. The standing rules the provider itself holds on this machine are read and revoked in the provider's own files through `provider.standingRuleList` and `provider.standingRuleRevoke`, each rule with its scope and source file. The session inspector's `Rules` section reads the same files, with the session's own answers, for one session through `approval.ruleList` and `approval.ruleRevoke` of §Plan-009; the daemon keeps no rule store of its own. The import of the provider's own existing conversations is `session.importPreview`, `session.import`, `session.importSubscribe` (its first message each provider's last outcome) and `session.importStop`. On a Windows computer with WSL, the supervisor's `daemon.listPlaces()` and `daemon.subscribePlaces()` draw the place row and `Change…`'s list, and `daemon.requestMove(place)`, `daemon.cancelMove()` and `daemon.subscribeMove()` carry the move.
- **MCP servers** goes through the operations §Plan-022 registers, with the live stream among them, and one registry search: `mcp.list`, `mcp.get`, `mcp.subscribe`, `mcp.upsertServer` and `mcp.removeServer`, each carrying `scope` and `scopeRef`, `mcp.registrySearch {query, cursor?}` answering `{servers, nextCursor?}`, `mcp.setEnabled`, `mcp.setToolOverride`, `mcp.clearToolOverride`, `mcp.oauthLogin` (the service's own sign-in), `mcp.oauthLogout {serverId}` and `mcp.reconnect`. A sign-in page opens through `native.openExternal`, and a server whose command cannot run after a move reads `failed` with `failedReason: commandNotRunnable` on its entry.
- **Projects** goes through the repository surface of §Repo Method-Name Registry above, with a project record beside its mount: `repo.projectList` (each row with `onOtherSideDisk`), `repo.projectRename`, `repo.projectArchive`, `repo.projectReactivate`, `repo.projectSetupUpdate`, `repo.projectEnvironmentUpdate` and `repo.detach`, which is the row's `Delete` (the sessions and the folder stay), with `native.openInEditor` for opening the project. The machine-wide environment rows and `Clone new repositories into` are the settings file's; the background service reads the environment rows when it starts a project's process and the clone folder at each clone. `repo.cloneFolderRead {}` → `{folder, source: setting | lastProject | home}`, served by the background service, is the one answer to where a clone goes, which this page's row and the session picker's `Clones into` line both draw.
- **Browser** goes through the `browser.*` root of §Page-Host Method Registry above — `browser.siteDataList`, `browser.siteDataForget`, `browser.siteDataClear`, `browser.siteCookiesClear {origin}`, `browser.siteSignIn {origin}`, `browser.chromiumRead` and `browser.chromiumFetch` — and through `gitflow.hostList`, `gitflow.hostAdd {host}` and `gitflow.hostRemove` of §Plan-008 for the self-hosted git hosts. Its two switches, `Remember site data` and `Browser tools for sidekicks`, are no verb: they are the machine's settings file's, and the background service reads them each time it launches the headless browser or a provider.
- **Keyboard** goes through nothing on the daemon's wire: the chord map is its own file on this install, `userData/keyboard-map.json`, holding only the overridden rows, read and written by the main process through `keyboardMap.read()` and `keyboardMap.write()`, which returns the map as stored. There is no change feed: one renderer drives every window, so one reader holds the map.
- **Appearance** goes through one bridge member rather than the daemon's wire: the theme, the color scheme, the text size and the transcript's width go to the main process through `window.setAppearance`, which writes its appearance record, and come back to every open console window, the one that made the change included, through `window.subscribeAppearance`, with the root token the session screen reads the transcript column's width from, so the two screens can never disagree about it. The screen-reader switch is the settings file's, because the background service reads it when it starts a Terminal pane's shell.
- **Notifications** goes through the machine's settings file — the switches, the kinds, the web address's switch and `Send` kinds, and the email digest's switch, `Send to`, `Mail server`, `Port`, `User name` and `After`, all under `notifications` and written by the background service — through `machineSettings.read()`, `machineSettings.write(change)` and `machineSettings.subscribe()`; the operating system's notification permission, read by the main process through `native.getNotificationPermission()` (on macOS through `node-mac-permissions`, off the main thread: `authorized` and `provisional` read as allowed, `denied` as refused, `not determined` as not asked yet); and the delivery verbs of §Attention Method-Name Registry above — `attention.deliveryRead`, `attention.deliveryTest`, `attention.mailPasswordSave`, `attention.mailPasswordRemove`, `attention.webAddressSave`, `attention.webAddressSecretRotate` and `attention.webAddressRemove`. The daemon keeps no notification preference of its own: it reads the settings file each time it writes an entry, and keeps a session's mute on the session.
- **Runtime** goes through the service's own surface, the supervisor in the main process, and the folders the service can reach. The service's own supervision surface is [Spec-006 §Required Behavior](../../specs/006-local-ipc-and-daemon-control.md#required-behavior)'s and the main process's supervision sequence is [Spec-021 §Required Behavior](../../specs/021-desktop-app-and-renderer.md#required-behavior)'s. The service: `daemon.status.read` (its version, start time, processor and memory with their read times; `secretsFile`, the path of the file secrets are kept in, present only on Linux with no Secret Service; `Check again` calls it again), `daemon.stop`, `daemon.restart`, and `session.terminalProviderSessionList`, the Codex sessions typed in a terminal, which `Stop`'s confirm and the update's waiting line count. The supervisor: `daemon.requestStart()`, `daemon.requestUpdate()`, `daemon.cancelUpdate()`, `daemon.subscribeUpdate()` and the `daemon.status` topic, which on Windows carries `cannotStart {reason}` when the service has written down why it cannot start and `whileSignedOut: on | off | passwordOutOfDate | notOffered`. The folders: `repo.mountList` (each folder with its origin — attached, managed or worktree — what uses it, and `onOtherSideDisk`), `repo.detach` for a project's folder, `repo.worktreeRetire {worktreeId, discard}` for a worktree the app made, and `repo.removedWorktreeList {projectId?}`, `repo.worktreeRestore {removedWorktreeId}` (`Put back`) and `repo.removedWorktreeDelete {removedWorktreeId}` (`Delete now`) for a discarded worktree the app kept. Retention: `daemon.retentionRead`, `daemon.retentionUpdate` and `daemon.retentionPurge`. The machine-wide configuration: `daemon.configRead` and `daemon.configUpdate` — the listener port, `Stop a run after`, `Ask me after one start leads to` as `workflowChainAskAfterRuns` (a number of runs, or `null` for `Never ask`), `Max steps per turn`, the memory cap for tool processes, the package cache limit, traces and the replay log. `Max steps per turn` here is the machine's own value every session starts from; its **per-session override** is registered as `session.maxStepsUpdate` in §Session Method-Name Registry above, so the two sides of one number have separate homes rather than one verb writing both. The package caches: `daemon.packageCacheRead` and `daemon.packageCacheClear {cache: bun | uv | all}`. Backup: `daemon.backupRead` and `daemon.backupStart` (`Back up now`), with the backup switch and folder in the machine's settings file; a restore is the supervisor's `daemon.requestRestore(backupId)`, because the service cannot replace its own store while it runs, and `backup.completed`, `backup.failed` and `backup.restored` land on the service's own session. The person's data: `daemon.dataExport {destination}`, which returns a job whose progress `daemon.dataExportSubscribe` carries, `destination` being the path the save dialog hands back; and `daemon.dataErase {}`. The webhook listener's state: `workflow.webhookListenerRead`.
- **Devices** goes, on the control plane, through `device.list`, `device.linkStart`, `device.linkRedeem`, `device.link`, `device.linkCancel`, `device.rename`, `device.revoke`, `device.forget`, `runtimenode.rename` and `runtimenode.remove`, from the desktop app through the service's `controlPlane.call` ([Spec-027 §Interfaces And Contracts](../../specs/027-remote-control.md#interfaces-and-contracts)); on each machine through `presence.read {}` and `presence.subscribe {}`; and through the shared-ports list, `preview.portShareList`, `preview.portShareAdd {port}` and `preview.portShareRemove {port}`; Settings' own stores hold nothing of it.

**The machine's settings file** is `<home>/.ai-sidekicks/machine-settings.json`, a place both the main process and a background service started from the command line can find without the app. It holds the auto-update preference, the crash-report switch, the editor preference, Claude Code's advisor default for new sessions, the default checkout, the new-session switch, the keep-awake switch, the notification preferences (the switches, the kinds, and the web address's and the email digest's settings other than their secrets), the browser's two switches, the screen-reader switch, the environment rows for every project, the backup switch and the backup folder, the `Branch names` pattern, the folder new clones go into (absent until the person sets one), and voice's two settings (the mode, and the call voice). The folders this machine can reach are not in it: they are the background service's, because only it knows which sessions use a folder. The background service is its one writer, so a change made on another device reaches it as surely as one made at the machine, and a machine running the service with no desktop app can still be changed: the service serves the file through `daemon.machineSettingsRead`, writes a change through `daemon.machineSettingsUpdate {change}`, answered with the file as written, and delivers each written change through `daemon.machineSettingsSubscribe`, the first delivery being the current file. The main process's `machineSettings.read()`, `machineSettings.write(change)` and `machineSettings.subscribe()` carry them; the main process alone may read the file directly, and only before the service first answers, for the values it needs at start (the auto-update preference and the crash-report switch); the renderer never reads the file. The service reads it each time it starts the headless browser, a provider process, a project session, a project's process, a Terminal pane's shell, a clone or a Codex voice call, and keeps no copy; a missing or broken file reads as the defaults there, and the service repairs it. One schema, `MachineSettings` in `packages/contracts/src/machine-settings.ts` beside `daemon.machineSettingsRead`, `daemon.machineSettingsUpdate` and `daemon.machineSettingsSubscribe`, describes the file for both readers. It is written by an ATOMIC RENAME over a schema-checked parse with fail-closed defaults, so a half-written file is never read and a malformed one falls back rather than crashing the screen. A small value may additionally be sealed through the platform's own one-blob encryption. Credential material — a token, a key, the web address's signing secret, the mail password — is never in this file and never in the app's own durable store: it lives in the operating system's keystore, which is why no payload above carries one.

**Settings appends no session event.** Its values are machine-local configuration, so nothing on the screen writes to a session's event log. The one stream the screen reads is the tool-server status and sign-in stream of §Plan-022, `mcp.subscribe`, which it reads and never writes.

---

## Plans 013 And 014

### Plan-013 — Multi-Agent Orchestration

Contracts per D-013-1..20. Canonical TypeScript source once shipped: `packages/contracts/src/orchestration.ts` (single file). `AgentId` is a new branded UUID (`brandedUuidIdSchema<AgentId>("AgentId")`). All mutations are daemon JSON-RPC (orchestration and agent authority is daemon-local, ADR-001/ADR-003 posture).

```ts
interface OrchestrationRunConfig {
  tokenLimit?: number; // the run's `Tokens per run`, input and output together; absent = `Unlimited`, the default (Spec-014 §Budget Policies)
}
type ChildRunProvenance = "provider_subagent" | "bridge_run" | "workflow_step"; // D-013-12: how a child was reached — the provider's own subagent, a bridge `run` call, or a workflow's `agent.run` step (§Plan-024). A `provider_subagent` link is written by the provider driver: Claude Code's subagent start and stop notifications and Codex's collaborating-agent events each add or close the run-link row for that subagent, so a provider's own subagents appear in the agent tree like any other child. Internal provenance: stored with the child's link and never drawn, so no mechanism word reaches the screen
type InterruptReason = "step_limit" | "spend_limit" | "token_limit" | "workflow_phase_canceled"; // the reason carried on a system-initiated interrupt, the same set as run.interrupted's `trigger`

// OrchestrationRunCreate — wire: orchestration.runCreate (admission pipeline D-013-9:
// agent resolution -> Plan-002 queue admission; zero-residue typed refusal + durable
// orchestration.rejected on deny). No count bounds admission: the runtime sets no limit on runs,
// agents, children, nesting depth or queued messages, so a refusal here is the provider's own or a
// target that does not resolve. A reached spend limit is never a refusal: while it stands no turn
// starts in the session (Spec-014 §Budget Policies). No console
// control calls it: its callers are the daemon's own paths (the bridge's `run` verb, §Plan-024, and a
// workflow's run-an-agent node) and the SDK.
// The target is EITHER an agent already in the session's agents projection, or a saved
// definition with no live agent yet, which the daemon resolves at the queue insert and records as
// run.queued's `resolvedAgent` (RunQueuedPayload below).
type OrchestrationRunTarget =
  | { targetAgentId: AgentId } // must resolve in the agents projection (agent.not_found)
  | { targetDefinitionId: AgentDefinitionId }; // resolved at the queue insert (agent.definition_not_found / agent.resolution_refused)
type OrchestrationRunCreateRequest = OrchestrationRunTarget & {
  sessionId: SessionId;
  parentRunId?: RunId; // present = child run; a child may create a child of its own to any depth, and no level is ever refused for being deep
  internalHelper?: boolean; // marks as non-user-facing; durable in run_links.internal_helper (default false)
  config?: OrchestrationRunConfig; // per-run override; admission resolves against session defaults and persists the merged result durably on run.queued (effectiveRunConfig — D-013-5 replay-stable enforcement)
};
interface OrchestrationRunCreateResponse {
  runId: RunId; // minted at Plan-002 queue admission (run.queued); orchestration adds no second id
  state: RunState; // "queued" at create
  parentRunId?: RunId;
  internalHelper: boolean; // echo of the durable flag (I-013-9)
}

// ChildRunLinkRead — wire: orchestration.childRunLinkRead. A read OF the daemon's parent-to-child
// index (the paragraph after the registry below), for the WHOLE session: every child at every depth,
// whether it has a run of its own (an agent a bridge `run` call started, linked in run_links —
// single-parent: `child_run_id` is the PK, so a child appears under exactly one parent; D-013-3) or is
// a provider's own helper inside its parent's run. The pane's list, the transcript's child rows and
// each child's own view all read this one source; the screen reads it again on subagent.started,
// subagent.completed, run.queued, orchestration.rejected and each run state change.
// `rejectedCreates` is event-folded at read time from the session's `orchestration.rejected` events:
// zero-residue refusals (I-013-7) leave no run/queue/link row, so the fold is the only data path that
// lets the child-run view surface refusal records (events-canonical projection, the budget
// accountant's posture).
interface ChildRunLinkReadRequest {
  sessionId: SessionId;
}
// One agent in the session's tree as the index names it: an agent with an id in the agents projection
// (the lead, or an agent a bridge `run` call started), or a provider's own helper by the run it runs
// in and the handle the index minted for it. The per-agent spend and the child controls key on it.
type AgentTreeMember =
  | { kind: "agent"; agentId: AgentId }
  | { kind: "providerChild"; runId: RunId; childHandle: string };
// What a child's head reads after its name.
interface ChildRunHead {
  modelId: string;
  effort?: string; // one word from the one effort ladder
  viaAgentName?: string; // present where the child was a peer call: the agent that was asked
  tokens: number;
  spendUsdMicros: number; // integer micro-dollars, the same fold as the per-agent spend on orchestration.budgetRead
  startedAt: string;
  ancestry: AgentTreeMember[]; // from the lead down to this child's parent
}
type ChildRunLink =
  | {
      kind: "run";
      childRunId: RunId;
      parentRunId: RunId;
      agentId: AgentId;
      internalHelper: boolean; // never dropped between durable home and read surface (I-013-9)
      state: RunState;
      head: ChildRunHead;
    }
  | {
      kind: "providerChild"; // steered, interrupted and paused through the run-control child verbs by `childHandle`
      runId: RunId;
      childHandle: string;
      parentChildHandle?: string; // present when its parent is itself a provider helper
      state: RunState;
      head: ChildRunHead;
    };
interface ChildRunLinkReadResponse {
  children: ChildRunLink[];
  // The Sidekicks badge's figures — children running now, children dispatched in all, and children
  // waiting on an approval — supplied by the daemon because the screen may hold only part of the list.
  counts: { live: number; total: number; waiting: number };
  rejectedCreates: Array<{
    parentRunId: RunId;
    targetAgentId?: AgentId;
    reason: string; // the refusing error-contracts.md code — the orchestration.runCreate admission vocabulary spans §Agent (agent.not_found), §Orchestration, and §Run (run.not_found parent reuse, D-013-11)
    detail?: string;
    occurredAt: string; // the event envelope timestamp
  }>;
}

// BudgetRead — wire: orchestration.budgetRead, and the reply of session.spendLimitUpdate and
// session.tokensPerRunUpdate (D-013-5; session_budgets row-canonical). Every amount is
// integer micro-dollars (millionths of a US dollar), the unit both providers report their own figures
// in, so small requests add up exactly; a figure is rounded once, where it is drawn.
interface OrchestrationBudgetReadRequest {
  sessionId: SessionId;
}
interface OrchestrationBudgetState {
  sessionId: SessionId;
  spendLimitUsdMicros: number | null; // the session's `Spend limit`; null = `Unlimited`, the default — one exists only where the person set it
  tokensPerRun: number | null; // the session's `Tokens per run`, input and output together for one run; null = `Unlimited`, the default
  // The ENFORCED number: what the accountant compares against spendLimitUsdMicros wherever a limit is
  // set (with spendLimitUsdMicros null nothing is compared and no turn is held for spend), and the one
  // session cost figure a surface shows — never a sum over a visible run list (Spec-014 §Cost Figure
  // Display Consistency; Plan-013 I-013-17). The budget accountant folds it from the persisted
  // usage.cost_update rows alone: each request is priced once, at completion, from the live price table
  // and never repriced, so a replay rebuilds the same figure. A request on a model or speed the price
  // table does not price yet is held with its exact tokens and joins this figure when a later fetch
  // prices it (Spec-014 §Cost Derivation And Absent-Cost Semantics). Plan-013 T2.4 asserts the
  // equality with the cost receipt's total at the same fold state.
  committedSpendUsdMicros: number;
  // Spend per agent in the session's tree, the lead included, routed up the parent chain at any depth:
  // `ownUsdMicros` is what the agent's own requests cost, `subtreeUsdMicros` that plus every descendant's.
  // Folded from the same usage rows as committedSpendUsdMicros; a helper request (a reviewer, a review)
  // counts on the agent it belongs to.
  agentSpend: Array<{ agent: AgentTreeMember; ownUsdMicros: number; subtreeUsdMicros: number }>;
}
type OrchestrationBudgetReadResponse = OrchestrationBudgetState;

// A goal belongs to one agent in the session and is that provider's own goal: the daemon sends the
// condition as the provider's own goal command and reads each ending back from what the provider
// writes. It never emulates a goal by injecting text into prompts (Spec-014 §Session Goals).
interface SessionGoal {
  text: string; // non-blank, NUL-rejected, no length cap of the app's own: the provider refuses in its own words (persisted to the event log and handed to the provider's own goal command)
}
// The goal's status, carried on session.goal_updated. `complete` and `impossible` are terminal: a goal's
// last status is what its row draws. Only Claude Code sends `impossible`, carrying the judge's reason.
// Clearing is session.goal_cleared, never a status.
type SessionGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usage-limited"
  | "budget-limited"
  | "complete"
  | "impossible";
interface SessionGoalUpdateRequest {
  sessionId: SessionId;
  agentId: AgentId; // the agent whose provider holds the goal
  goal: SessionGoal;
}
type SessionGoalUpdateResponse = { sessionId: SessionId; agentId: AgentId; goal: SessionGoal };
interface SessionGoalClearRequest {
  sessionId: SessionId;
  agentId: AgentId;
}
type SessionGoalClearResponse = { sessionId: SessionId }; // clearing with no goal set succeeds, as Codex does

// Agent surface (Plan-013 owns the V1 agent identity surface).
// An agent has no lifecycle state: it is in its session or it is not. An agent row is created by
// session.created (a session's lead) or run.queued (an agent resolved from a saved definition), and its binding moves only by the
// binding events below, so the agents projection is deterministic from the log alone.
// NO WIRE VERB BRINGS AN AGENT INTO A SESSION OR TAKES ONE OUT. A session has one main agent,
// and another agent takes part only where the main one delegates to it or where the person names
// it in the composer, so there is no step that binds a saved agent to a running session and none to
// undo. The verbs here mutate and read what the session already holds.
// wire: agent.configUpdate / agent.list
// The running agent's model, effort, output speed and provider, each moved by the person from the
// composer's controls. Every member is optional and an omitted member is UNCHANGED, never reset.
// Every accepted update is a switch of the agent's provider binding (`AgentProviderBinding`,
// §Plan-024) and settles with `agent.provider_binding_changed` or
// `agent.provider_binding_change_failed`; no other event records it. A change of model, effort or
// speed alone settles in place and draws no transcript row.
interface AgentConfigUpdateRequest {
  agentId: AgentId;
  modelId?: string;
  // D-013-17 — the provider axis ([Spec-014 §Same-Agent Provider Switch](../../specs/014-multi-agent-orchestration.md#same-agent-provider-switch)).
  // Moving this is the PROVIDER SWITCH, picked from the composer's model control, which lists both
  // providers' models under two headings; it applies at the end of the run in flight. Continuity is a
  // HAND-OVER BRIEF composed on a throwaway copy of the old session, never a replay of the whole
  // conversation as text (Spec-014 §Continuity). WHICH ACCOUNT PAYS IS NOT A MEMBER HERE: it moves on
  // the provider surface through `providerAccount.setCurrent` (§Plan-023), which moves every unpinned
  // running session on that provider. A caller supplying an account member is refused, not served — a
  // per-session account switch beside a provider-wide current account would let the two disagree.
  driverName?: string;
  effort?: string;
  // The output-speed axis ([Spec-014 §The mutation surface](../../specs/014-multi-agent-orchestration.md#the-mutation-surface)). Gated on the
  // target driver's `output_speed` capability flag, which both pinned providers declare;
  // a dispatch against a driver declaring it false refuses as driver.capability_unsupported and
  // is NEVER satisfied by moving `effort` instead, which is a different claim. It applies at a RUN
  // boundary and is carried on the running process by the provider's own settings call — on Claude
  // Code `apply_flag_settings {fastMode}`, accepted between turns with no restart and no file
  // written; on Codex its output-speed leg — so it settles in place like the model and the effort.
  // VALIDATED against the target driver's reported `GetCapabilitiesResult.outputSpeedLevels`, never
  // against a list hardcoded here — the rule `effort?` above already follows. An absent or empty
  // vocabulary makes the axis unsettable and the mutation refuses `agent.provider_axis_invalid`
  // (400) fail-closed, so no unvalidated value is ever forwarded to a provider.
  outputSpeed?: string;
  // Applies at the next boundary the TARGET AXIS permits, never at a fixed one: a turn boundary
  // for an axis the target driver takes as a per-turn override, a run boundary for a run-bound one
  // (`driverName` always, and `outputSpeed` — re-derived by listing rather than counted). A
  // multi-axis update takes the WIDEST of its axes' boundaries, so no axis applies earlier than its
  // own rule allows. `true` dispatches the documented `interrupt` intervention (`run.intervene`)
  // first and then switches — an entry point into a control the corpus already has, not a new run
  // control, so Spec-003's V1 control set is unchanged. The interrupt is authorized as
  // Action::"intervene" on the target run, and a refused interrupt refuses the switch rather than
  // leaving the agent half-moved. This arm HOLDS THE REQUEST OPEN across the boundary — which is what
  // lets its response carry the settlement below — and still writes the pending switch to the agent
  // row BEFORE dispatching the interrupt, so a crash in between costs the caller its answer and not
  // the switch.
  interruptAndSwitch?: boolean;
}
interface AgentConfigUpdateResponse {
  agentId: AgentId;
  updatedAt: string;
  switch: AgentBindingSwitchDisposition; // every accepted update is a switch of the binding
}

// Mutation and application are TWO MOMENTS (Spec-014 §Same-Agent Provider Switch), so what the
// mutation returns is a discriminated union and not a settlement. "pending" is the ordinary
// answer; the SETTLED arms are reachable only on the interruptAndSwitch arm, which collapses
// the two moments into one by holding its request open until the switch settles (Plan-013 T2.9 is
// that arm's only producer). A caller that reads `switch.continuity` without discriminating is
// reading a member that is absent on both the common path and the "failed" arm.
//
// The disposition has the arms below because holding a request open until settlement means every settlement the boundary
// can reach must be expressible to a caller still waiting for one. "applied" and "degraded" split
// the outcome by a TOTAL and stated mapping — `applied` iff the conversation arrived whole
// (`continuity` "in_place"), `degraded` iff it did not ("brief") — so the
// honest-degrade rule is carried by the wire's own discriminator rather than left to each client to
// re-derive from `continuity`. "failed" is the immediate arm's share of the
// `agent.provider_binding_change_failed` terminal: an accepted switch that cannot be applied settles
// the held-open request instead of stranding it, and reuses that event's `reason` vocabulary
// verbatim — one vocabulary across both surfaces — rather than minting a second one.
type AgentBindingSwitchDisposition =
  | AgentBindingSwitchPending
  | ({ status: "applied" } & AgentBindingSwitchOutcome)
  | ({ status: "degraded" } & AgentBindingSwitchOutcome)
  | AgentBindingSwitchFailed;

interface AgentBindingSwitchPending {
  status: "pending";
  // Daemon-minted, durable on the agent row, and the correlator between this acknowledgment and
  // the terminal `agent.provider_binding_changed` / `agent.provider_binding_change_failed` event. A
  // caller never supplies it.
  switchId: string;
  // The boundary this switch will apply at — resolved against the TARGET driver's declared
  // vocabulary, never assumed, and the widest of the moved members' individual boundaries.
  appliesAt: "turn_boundary" | "run_boundary";
  // TRUE on the interruptAndSwitch arm, FALSE on the deferred one. The boundary above says WHEN
  // the switch applies; this says whether REACHING that boundary requires an interrupt the daemon
  // must dispatch. They are independent — a deferred switch and an interrupted one can both
  // read "turn_boundary" — so neither a client nor a restarted daemon can re-derive the owed
  // interrupt from `appliesAt`, and the record has to carry it.
  interruptRequested: boolean;
  // The binding members this switch moves AND the value each is moving TO. The present keys are
  // exactly the moved members, so the boundary above stays re-derivable from it, and a client that
  // did not issue the mutation can render what the agent is switching to rather than only that it
  // is switching. Carrying the targets rather than only the member names is load-bearing for
  // durability: this same object is what the `agents.pending_switch` slot stores and what
  // `agent.list` serves as `pendingSwitch`, so `switching to …` survives a reload and reaches another
  // device, and an intent recording only WHICH members moved could not be applied at the boundary
  // once the caller's request is gone.
  pendingAxes: AgentBindingSwitchTarget;
  // Present when this update REPLACED an earlier still-pending switch on the same agent: at most
  // one switch is pending per agent, and a later update supersedes rather than queues (Spec-014
  // §Same-Agent Provider Switch). The superseded id never reaches a terminal event, so surfacing it
  // here is the only record a caller gets.
  replacedSwitchId?: string;
}

// The DURABLE SLOT IS A SUPERSET OF THE WIRE SHAPE. `agents.pending_switch` stores the
// `AgentBindingSwitchPending` record above PLUS members that are never returned to a caller
// and never appended to an event payload:
//
//   the admitting device — the device whose connection carried the switch (§Authenticated Principal
//     And Authorization Model: a write records its device). Both terminals require an `actor`, and a
//     switch settling after a restart has no request left to read one from. Its one writer,
//     `agent.configUpdate`, is the person's own act.
//   interruptDispatch — "requested" | "dispatched", present exactly when `interruptRequested` is
//     true. Deliberately NOT a boolean and not folded into `interruptRequested`, because recovery
//     must separate "crashed before the interrupt went out, so dispatch it" from "crashed after it
//     landed, so reconcile": redispatching in the second case fires a second interrupt at a run
//     that already took one. The advance to "dispatched" is its OWN durable write, made once the
//     interrupt is accepted; a crash between the two costs one idempotent redispatch, never a lost
//     switch.
//
// Both are recovery inputs rather than session-observable facts, so they live in the durable slot
// and never in a mutation reply; keeping the slot a superset is what lets the wire shape stay
// exactly the intent a client is entitled to see.

// The immediate arm's failure settlement, carrying the SAME vocabulary as the
// `agent.provider_binding_change_failed` event below — one vocabulary across two surfaces, so a
// held-open refusal and the terminal event render the same reason set. This is a RESULT, not a
// JSON-RPC error: the switch was accepted, a `switchId` was minted, and the pending switch was
// already recorded on the agent row, so the mutation succeeded and only the application did not.
// Refusals that happen BEFORE acceptance — an unknown axis, an invalid value — are the synchronous
// `agent.provider_axis_invalid` error instead, and mint no `switchId` and no pending switch.
interface AgentBindingSwitchFailed {
  status: "failed";
  switchId: string;
  reason: AgentBindingSwitchFailureReason;
  accountState?: AgentBindingSwitchAccountState; // present exactly when reason is "account_unavailable"
}

type AgentBindingSwitchFailureReason =
  | "driver_unavailable"
  | "model_unavailable"
  | "effort_unavailable"
  // The deferred application reached a target whose driver no longer declares
  // `output_speed`, or whose declared vocabulary no longer carries the pended value. A member of
  // its own because the axis settles at a run boundary the caller has already been acknowledged
  // for, so without it an axis-specific failure would render as one of the others and misname what
  // went wrong.
  | "output_speed_unavailable"
  | "interrupt_refused"
  | "target_unstartable"
  // The account the switch lands on cannot carry the run — an account move, or a provider switch
  // landing on the target provider's current account. `accountState` says why, and only
  // `reauth_required` offers `Sign in again`. An in-place account move whose new login fails at the
  // next request settles here too, the daemon handing the previous account back.
  | "account_unavailable";

type AgentBindingSwitchAccountState =
  | "reauth_required" // the login expired or was refused; the one state that offers `Sign in again`
  | "home_missing"
  | "indeterminate"
  | "not_registered";

// The binding members a switch moves, as a partial record: an omitted key is a member this switch
// does not move. It holds no account: the account moves on the provider surface
// (`providerAccount.setCurrent`, §Plan-023), in place at the next request, and writes no pending
// switch. One shape serves three surfaces — the wire acknowledgment above, the durable `agents.pending_switch`
// slot, and `agent.list`'s `pendingSwitch` member — so a client, a projector, and a restarted daemon
// all read the same record of the same intent.
// The record deliberately has no reset: no operation clears a binding member back to a driver
// default, so an omitted key is a member not moving and there is nothing else to encode.
// `driverName`, `modelId` and the account cannot be cleared at all (an agent always runs on one of
// each), and clearing `effort` or `outputSpeed` is not an operation `agent.configUpdate` offers,
// whose omitted members are uniformly "unchanged, never reset". `outputSpeed` is carried in this
// record rather than only at the coordinator: it applies at a run boundary, so it is a member likely
// to be pending across a restart, and a member a caller can request but the durable slot cannot hold
// would be acknowledged and then silently dropped.
interface AgentBindingSwitchTarget {
  driverName?: string;
  modelId?: string;
  effort?: string;
  outputSpeed?: string;
}

type AgentProviderAxis = keyof AgentBindingSwitchTarget;

// The settlement of a switch, carried by the `agent.provider_binding_changed` payload below.
interface AgentBindingSwitchOutcome {
  switchId: string; // correlates with the pending acknowledgment above
  // WHICH MECHANISM CARRIED THE CONVERSATION. Two different acts, not degrees of one.
  // "in_place" = a member carried on the RUNNING process — a per-turn override, a run-bound setting
  // the provider takes without a restart, or an account moved at the next request: nothing was
  // respawned and nothing was reconstituted.
  // "brief" = a DIFFERENT provider was started from a hand-over brief: the old provider's own
  // summary taken on a throwaway copy of the session, then the current diffs and branch read from
  // disk, then every earlier step as a one-line note, then the last exchanges verbatim, then a
  // REFERENCE to the whole old transcript, which the daemon writes as one plain file beside the
  // brief for the new provider to read on demand with its own file tools. Replaying the whole
  // conversation as text is deliberately NOT what a provider switch does: the expensive thing is
  // not pushed into the message, and it is still reachable. The file is not a transcript row.
  // "in_place" is `applied`; "brief" is `degraded` and is never
  // presented as an ordinary success. On the held-open arm that mapping is carried by the
  // disposition's own `status` discriminator above, so a client never re-derives it; on the terminal
  // event it is carried by this member alone, the event having no status.
  continuity: "in_place" | "brief";
  // REQUIRED, and an EMPTY ARRAY IS A CLAIM: it asserts that nothing was dropped. A driver that
  // does not know what it lost may not emit one. A loss is a `DeclaredLossKind`,
  // never a free string. Requiredness is scoped to the continuity arm: "in_place" MUST carry the
  // empty array (nothing was reconstituted, so no loss could occur), and "brief" MUST be non-empty
  // and MUST include "conversation_history_summarized" together with "provider_private_reasoning".
  // The claim is scoped to TRANSCRIPT CONTENT and to nothing else. An empty array
  // asserts that the conversation arrived intact; it asserts nothing about whether a requested
  // provider SETTING took effect on the new binding. Those are different facts with different
  // carriers — a speed setting the provider declined is reported by the live read-back on the
  // agent row, not by a loss kind — and conflating them would either fabricate a transcript loss
  // that did not happen or let an empty array be read as a guarantee it was never making.
  declaredLosses: DeclaredLossKind[];
}

type DeclaredLossKind =
  | "provider_private_reasoning" // non-portable by both vendors' stated rules; never translated. ALWAYS present on a "brief" settlement
  | "context_truncated" // only the last exchanges travel verbatim, so older ones did not (whole exchanges only, never halves)
  | "tool_call_history_repaired" // an unpaired call took a synthetic error result rather than being dropped
  | "conversation_history_summarized" // the brief's own summary stood in for the conversation the new provider cannot read
  | "helper_conversations" // the old provider's helper conversations under this session; their conclusions survive in the transcript, the conversations themselves do not
  | "tool_output_bodies" // earlier steps travel as one-line notes, so the bodies of their output do not. Files touched on disk are unchanged
  | "live_tool_calls" // tool calls arrive as history and never as work in flight; a call that was about to run does not run
  | "provider_skill_and_command_names" // the old provider's own skills and commands name nothing on the new one
  | "turn_content_unavailable"; // a logged turn's body could not be read when the fold ran; the turn is carried with its structural position and an empty body rather than being dropped, because an empty body alone reads as "the author said nothing" and a dropped turn reads as "the turn never happened" and both are false. Produced by the fold, which is daemon-side and upstream of the driver: it reaches AgentBindingSwitchOutcome.declaredLosses through the canonical projection

// agent.provider_binding_changed — a switch landed (Spec-005 §Agent Lifecycle). A change
// of model, effort or speed alone settles `in_place` with no declared losses and draws no transcript
// row; a provider switch or an account switch draws the switch row: the binding it left and the one
// it is on, the account the run landed on, how the conversation continued, and what did not carry
// over.
interface AgentProviderBindingChangedPayload extends AgentBindingSwitchOutcome {
  sessionId: SessionId;
  agentId: AgentId;
  actor: string; // the admitting device recorded on the pending switch
  from: AgentProviderBinding; // the binding the agent left, its account included
  to: AgentProviderBinding; // the binding it is on now; `providerAccountId` null where it follows the provider's current account
  // The account the run actually landed on, separate from `to.providerAccountId`, so an agent that
  // follows the current account is never silently pinned to the account it happened to land on.
  landedProviderAccountId: ProviderAccountId;
}

// agent.provider_binding_change_failed — a switch accepted as pending could not be applied, and the
// agent stays on the binding it had: the previous provider and account stay active, no success row is
// drawn, and the transcript gains one system message naming the attempted switch and the reason, with
// `Sign in again` only where `accountState` is `reauth_required`. Emitted on BOTH arms whenever an
// accepted switch fails at application: the pending slot is cleared by a terminal and never by a
// reply, so the immediate arm additionally settles its held-open request as the `failed` disposition.
// Exactly one of the binding events terminates every pending switch that is not superseded.
interface AgentProviderBindingChangeFailedPayload {
  sessionId: SessionId;
  agentId: AgentId;
  switchId: string;
  actor: string;
  from: AgentProviderBinding; // the binding it stayed on
  attempted: AgentBindingSwitchTarget; // the members the switch tried to move, the account included
  reason: AgentBindingSwitchFailureReason;
  accountState?: AgentBindingSwitchAccountState; // present exactly when reason is "account_unavailable"
}

// agent.list — a LIVE list: the session's agents, then each agent row again as it changes, like
// session.list, so a switch in flight and its settlement reach every window and device.
interface AgentListRequest {
  sessionId: SessionId;
}
interface AgentListResponse {
  agents: AgentListEntry[];
}
interface AgentListEntry {
  agentId: AgentId;
  name: string;
  // D-013-17: the agent's EFFECTIVE binding — the one it runs under now, never the pending one.
  // `providerAccountId` null = the agent follows the provider's current account (the one marked
  // `Default`); `effort` null = the driver's own default for the model; absent `outputSpeed` = never
  // set, so the provider's own default stands. Each member is served from its own column on the agent
  // row, the columns an applying switch commits into, so every member a switch can move is read back
  // here once it applies; a run-bound member readable only as a PENDING intent would go dark then.
  binding: AgentProviderBinding;
  // What the PROVIDER declared, as against `binding.outputSpeed`, which is what was REQUESTED
  // (Spec-004 §The output-speed axis). Projected at response-build time from the
  // binding-held `ProviderOutputSpeedState` — the observation the driver recorded when the
  // declaring handshake arrived — and stored in no column, so it cannot go stale. LIVE-SCOPED on
  // the SA-43 park-member precedent.
  //
  // ABSENT HAS THESE CAUSES, and none of them is "the mode is off": the
  // binding's driver declares no `output_speed` and there is nothing to read; the driver declares
  // it and NO TURN-BEARING EXCHANGE HAS YET CARRIED THE HANDSHAKE, so the observation has not
  // happened; or no binding for this agent is live. The middle arm is the one a reader right after
  // a switch will hit — an agent read immediately after a switch applies is expected to show the
  // requested value with this member absent — so consumers render "not yet observed", never "off"
  // and never a stand-in for `binding.outputSpeed`. Presence stays the discriminator for "this was read
  // from the provider"; absence means nothing has been read YET or ever, which is the same
  // instruction to the reader in every arm.
  //
  // An agent runs on one binding at a time, so the projection is that binding's declaration,
  // and the values in this row pair the current request with the declaration it produced. This member is what makes the prohibited false success
  // unrenderable — a provider that ACCEPTS the setting and then leaves the mode off shows a
  // requested value and a differing declared one, with the provider's own reason beside it.
  // That disagreement is deliberately NOT a switch failure: the switch applied, the provider
  // then declared something else, and reporting it as a failure would be the same false claim
  // in the other direction — so `AgentBindingSwitchFailed.reason` stays unwidened for it, and
  // `output_speed_unavailable` keeps its own narrower meaning (the mode could not be requested
  // at all: the vocabulary is gone, or the target driver stopped declaring the flag).
  observedOutputSpeed?: ProviderOutputSpeedState;
  // Present exactly while a switch is pending on this agent, so the deferred intent is readable
  // rather than inferable — including after a daemon restart, which re-arms it from the durable
  // agent row. A live list is how a caller that was not the mutator learns a switch is queued.
  pendingSwitch?: AgentBindingSwitchPending;
  // Present iff this agent was resolved from a saved definition — the row a name in a composer
  // produces. Every field as actually applied, with the resolved binding in place of the folded axes
  // (§Plan-024). It is a record of what the run started under, never a live view of the definition: the
  // definition may have moved since, and the agent keeps what it was given. Its
  // `resolvedFromDefinitionId` is the one home of the definition an agent came from.
  resolvedConfiguration?: AgentResolvedConfiguration;
  // Where the agent sits in the session's tree: from the lead down to this agent's parent, read
  // from the daemon's parent-to-child index (the same source as orchestration.childRunLinkRead's
  // `ancestry`); empty for the lead.
  ancestry: AgentTreeMember[];
  createdAt: string;
}

// run.queued payload (Spec-005 §Run Lifecycle): a run's creation, and the one durable record of how it came
// to be. The linkage members ride a run another run or a
// workflow created, on this row only and never on the run's state stream; an orchestration-created child's
// run_links row and its per-run limits rebuild from this event alone, while a provider's own subagent's row
// is written by the provider driver from that provider's subagent notifications. `effectiveRunConfig` is
// the admission-resolved OrchestrationRunConfig (request override else session default), kept so the
// token-limit enforcement rebuilds the same even if session defaults change mid-run (D-013-5).
//
// The run's agent is named ONE way, never both: `agentId` for an agent already in the projection, or
// `resolvedAgent` where the request that created the run named a saved definition instead — a peer
// invocation's own run included. `resolvedAgent` is the CREATING RECORD of that agent's row, in the one shape
// `agent.list` describes an agent: `session.created` mints a session's lead and this member mints an agent
// resolved from a definition, and no `agent.*` type creates a row. Its `resolvedConfiguration` is present,
// and that configuration's `resolvedFromDefinitionId` names the definition. Path-independent, like the admission stamps: the daemon mints the agent's id
// at the queue insert exactly as it mints the run id, whichever creation path admitted the run.
type RunQueuedPayload = {
  sessionId: SessionId;
  runId: RunId;
  runVersion: number;
  newState: "queued";
  parentRunId?: RunId;
  reachedBy?: ChildRunProvenance; // present with parentRunId: how the child was reached
  internalHelper?: boolean;
  effectiveRunConfig?: OrchestrationRunConfig;
  // ── Path-independent admission stamps: run.queued carries them for EVERY provider run, whether admitted
  // via the ordinary run.queueCreate path or orchestration admission (the orchestration path threads
  // their values through the OrchestrationRunLinkCarrier; the ordinary path stamps directly at the queue
  // write — CP-002-10 owns the stamps either way). Never client-suppliable, and never on the run's state
  // stream.
  // As-of-admission model family, frozen here for every admitted provider run: orchestration-
  // created runs resolve agentId → agent model → pricing-family key; ordinary runs resolve from
  // the admission-resolved provider model. Derived pricing keys off it; a later
  // agent.configUpdate model change never re-keys an admitted run, and replay
  // reads this field, never the current agents projection. Derived pricing resolves per usage
  // row: a row wire-attributed to another model (e.g. a differently-modeled subagent) keys off
  // that model's family; this field is the fallback when the wire carries no attribution.
  admittedModelFamily?: string;
  // The account the run was admitted against. Priced usage rows join to a paying account through the run,
  // and resume rebinds to this stamp rather than re-resolving the current default.
  admittedProviderAccountId?: ProviderAccountId;
} & (
  | { agentId?: AgentId; resolvedAgent?: never }
  | {
      agentId?: never;
      resolvedAgent: AgentListEntry & { resolvedConfiguration: AgentResolvedConfiguration };
    }
);

// Orchestration queue-admission carrier (D-013-9) — IN-PROCESS seam type, not a wire shape, declared
// in `packages/runtime-daemon/src/orchestration/` and never in `packages/contracts`:
// the orchestration-run-service passes it to Plan-002's daemon queue-admission service after its
// own admission pipeline passes; the run.queued event payload then carries these fields durably
// (Spec-005 §Run Lifecycle run.queued row — additive optional fields). The wire run.queueCreate handler
// never populates it — child-run creation goes through orchestration.runCreate only.
interface OrchestrationRunLinkCarrier {
  parentRunId?: RunId;
  reachedBy?: ChildRunProvenance; // present with parentRunId: how the child was reached
  internalHelper: boolean;
  agentId: AgentId; // the resolved target (CP-002-10): the wire's targetAgentId, written to run.queued as `agentId`, or the agent minted from its targetDefinitionId, written as `resolvedAgent`
  effectiveRunConfig: OrchestrationRunConfig; // admission-resolved post-merge values (request override else session default), persisted on run.queued so the token-limit enforcement rebuilds replay-stable (D-013-5)
}
```

**Method-string registry — Plan-013** (daemon JSON-RPC):

| Method | Procedure type | Request → Response | Notes |
| --- | --- | --- | --- |
| `orchestration.runCreate` | RPC | `OrchestrationRunCreateRequest` → `OrchestrationRunCreateResponse` | Admission pipeline; composes with Plan-002 queue admission in-process |
| `orchestration.childRunLinkRead` | RPC | `ChildRunLinkReadRequest` → `ChildRunLinkReadResponse` | A read of the daemon's parent-to-child index for the whole session: both kinds of child, their head facts, the badge counts, and event-folded `rejectedCreates` (zero-residue refusals, I-013-7) |
| `orchestration.budgetRead` | RPC | `OrchestrationBudgetReadRequest` → `OrchestrationBudgetReadResponse` | Committed spend and the per-agent spend, in micro-dollars |
| `orchestration.costReceiptRead` | RPC | `SessionCostReceiptRequest` → `SessionCostReceiptResponse` | Read-only decomposition of the committed-spend fold (D-013-16 — shapes below); served from the same accountant accessor as `orchestration.budgetRead`, so the two can never disagree |
| `session.goalUpdate` | RPC | `SessionGoalUpdateRequest` → `SessionGoalUpdateResponse` | [Spec-014 §Session Goals](../../specs/014-multi-agent-orchestration.md#session-goals); an accepted update emits `session.goal_updated` carrying the same canonical `goal` |
| `session.goalClear` | RPC | `SessionGoalClearRequest` → `SessionGoalClearResponse` | An accepted clear emits `session.goal_cleared` (clearing is the distinct operation — an update without a goal is malformed) |
| `agent.configUpdate` | RPC | `AgentConfigUpdateRequest` → `AgentConfigUpdateResponse` | The running agent's model, effort, speed and provider; never the account, which is `providerAccount.setCurrent` (§Plan-023). Settles with `agent.provider_binding_changed` or `agent.provider_binding_change_failed` |
| `agent.list` | subscription | `AgentListRequest` → `AgentListResponse` | Agents-table projection, live: the list, then each change |
| `session.terminalProviderSessionList` | RPC | `SessionTerminalProviderSessionListParams` → `SessionTerminalProviderSessionListResult` | The Codex sessions typed in a terminal; shapes in §Plan-005; empty while `Reach Codex sessions started in a terminal` is off |

`session.maxStepsUpdate`, `session.spendLimitUpdate` and `session.tokensPerRunUpdate`, the session's own `Max steps per turn`, `Spend limit` and `Tokens per run`, are registered with their shapes in §Session Method-Name Registry.

**The session-to-session tool mints no method here, and that is the point.** Two sessions talk through operations the daemon serves to the **providers** — `SendToSession {to, message, files}` and `ListSessions {}` — served on the daemon's one MCP `url` entry per session, on the daemon's own tool route — never a tool server inside Claude Code's `initialize` request and never a Codex dynamic tool — so a call arrives at the daemon as that provider's own MCP tool call and is answered there ([Spec-014 §Sessions Talking To Each Other](../../specs/014-multi-agent-orchestration.md#sessions-talking-to-each-other)). A send is an ordinary tool call under the sending session's own permission level — the levels that ask raise the ordinary approval card, `Sandboxed` and `YOLO` ask nothing, and no switch, setting or cap of the app's gates it — and what the message causes follows the receiving session's own level. The server and the namespace are both `sessions`, so the name a model reads is that prefix plus the tool — `mcp__sessions__SendToSession` on the one leg, the namespace plus the tool on the other. `to` is the other session's name and the daemon resolves the address from its own directory, so no caller spells one; `files` is an optional list of paths the sending session can read, which the daemon stages into the receiving session as attachments through [Spec-012](../../specs/012-artifacts-files-and-attachments.md)'s ingest pipeline, so they arrive as paths the receiving model reads with its own file tools on either provider rather than as bytes on this tool's own wire — both `Message` rows carry the file chips a sent turn's attachments already carry, and the only bound on them is that pipeline's. The daemon reads each of those paths **as the person's own user, at send time**, and a path that does not exist or cannot be read **fails the call with that path named in the tool result** rather than being dropped from the list while the rest arrive; there is no second gate on top of that read, since the receiving session runs as the same person on the same machine and could open the path itself. No client calls them, so no wire method is registered, no error code is minted, and no event type is added: a send's result carries one state at a time — `sent`, then `delivered`, `queued`, `held`, `refused` with the provider's own reason, or `not delivered` — and a refusal is the provider's own words rather than this corpus's error envelope. What the screen draws rides documented surfaces. The two rows are the ordinary tool events of the two sessions' logs, and a sent row's later states come over the run-state subscription. The exchange line on a session's row is the `exchange` member (`{peerSessionId, peerName, messageCount}`) of that session's `session.list` entry ([§Plan-001](#plan-001--session-core)), present while the session trades messages, so one feed serves every row and the list opens no stream per session. The messages waiting for a paused session are items of that session's own queue, held in arrival order with the sending session as their origin and read through `run.queueList` ([§Run-Control Method-Name Registry](#run-control-method-name-registry)). The daemon's phone book of sessions and addresses and its exchange table are daemon-interior and reach no wire; beside the exchange line, the one member a client reads is the address on `SessionSnapshot` (§Plan-001 above), which the inspector's `Copy address` lifts.

**The daemon's own agent tree, and why no verb reads it directly.** The daemon builds a parent-to-child index per session FROM THE PROVIDER STREAM — the task-started frame and its parent call id on one provider, the child's turn-started frame on the other — and persists it, because neither provider lists its children back on a resume. That index is the single source of every fan-out count the screen shows and of every stop that reaches more than one child: a subtree stop is one stop per id walked from the index at every depth, never a relay through the lead, because neither provider's lead can stop a subtree — one provider's own stop tool refuses a grandchild as another agent's, and the other has no stop-all verb at all. The durable handle for a child is the run plus the provider plus the child together, never a bare child id, which is what lets a restart re-attach every child by id. Four further things the index holds are daemon-interior and reach no wire: the per-child hold key that routes a pause to the right leg, the background request issued before a lead interrupt on one provider so a foreground child is not swept with it, the per-child stop behind the two sweeping controls, and the provider's own terminal verbs that end a command an interrupt left running. `orchestration.childRunLinkRead` above is the projection a client reads; it is a read OF the index, and no second verb exposes the index itself. The two child records the screen folds are `subagent.started` and `subagent.completed`, whose taxonomy is [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md)'s.

Error vocabulary: [error-contracts.md](./error-contracts.md) §Orchestration / §Agent (D-013-11), plus `driver.capability_unsupported` for a switch axis the target driver does not have, and for the goal RPCs `session.not_found` for a session id the daemon does not hold, appending nothing, and `driver.capability_unsupported` where the agent's provider cannot carry a goal. Durable events owned by Plan-013 (Spec-005 registrations): `agent.provider_binding_changed` / `agent.provider_binding_change_failed` (payloads above), `orchestration.rejected`, `session.spend_limit_reached` and `run.token_limit_reached` (a limit the person set, reached), `session.goal_updated` / `session.goal_cleared` (emitted by the goal RPCs above) — see [Spec-005 §Event Type Registry](../../specs/005-session-event-taxonomy-and-audit-log.md). `moderation.review_flagged` is not Plan-013's: the Codex normalizer emits it ([Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.34).

**Session cost receipt (Plan-013 D-013-16).** One read pair, `orchestration.costReceiptRead {sessionId}`, which refuses a session id the daemon does not hold with `session.not_found` and appends nothing. The reply is a **decomposition of the committed-spend fold**, not a second computation: every figure is served from the same accountant accessor that answers `orchestration.budgetRead`, so a divergence between the two is a bug in exactly one place. It answers the providers in the order the session first spent on them, the session's own provider first, each with one row per account that provider spent on, its `Voice` row where the session made voice calls, and a subtotal the daemon computes, then the session total. Every amount is integer micro-dollars. Read-only — no receipt member is accepted on any request, so a caller can never assert an attribution or a total.

```ts
interface SessionCostReceiptRequest {
  sessionId: SessionId;
}

// The partition identity below is the contract, not commentary. Each unit of committed spend appears
// in EXACTLY ONE row, so each provider's account rows, its voice row included, sum to its subtotal,
// and the subtotals sum to the session figure:
//   sum(providers[].subtotalUsdMicros) === sessionTotal.committedSpendUsdMicros
// A consumer asserting it is asserting that no row was double-counted or dropped.
interface SessionCostReceipt {
  sessionTotal: OrchestrationBudgetState; // the SAME shape the budget read/update replies carry — one type, one accessor
  // In the order the session first spent on each provider, the session's own provider first. The
  // receipt has no per-run lines.
  providers: SessionCostReceiptProvider[];
}

// One provider the session spent on.
interface SessionCostReceiptProvider {
  provider: string; // the provider driver key, as on an agent's binding
  accounts: SessionCostReceiptAccountRow[]; // one row per account this provider spent on
  voice?: { usdMicros: number }; // the `Voice` row, present where the session made voice calls on this provider
  subtotalUsdMicros: number; // computed by the daemon: the account rows plus the voice row
}

// One account's spend, named as Plan-023 supplies it and labeled with that account's billing mode.
interface SessionCostReceiptAccountRow {
  provider: string;
  account: string;
  billingMode: BillingMode; // subscription | metered | unknown (§Plan-023's BillingMode); labels the figure and never changes how it is derived
  tokens: number;
  usdMicros: number;
}
```

The receipt mints no event type, no error code and no table: it is a decomposition of the budget accountant's in-memory fold over the `usage.cost_update` rows, including the rows written for requests priced from a provider's own telemetry export. The account each row names comes from the per-turn usage rows, keyed on the account each request ran on, and its name and billing mode as Plan-023 supplies them ([Plan-023](../../plans/023-provider-accounts-and-credential-homes.md), CP-023-3); a turn split across two accounts by an account switch lands as two rows, so the rows still sum to the session total.

### Plan-014 — Workflow Authoring And Execution

A definition has ONE form on the wire and in the store: the node-graph document below. An author writes nodes and edges; the engine runs them, its agent and human node kinds delegating at run time to the daemon's own run-admission, orchestration, approval and form paths, so no second definition form exists to keep in step with it ([Spec-015 §Core SDK and persistence contracts](../../specs/015-workflow-authoring-and-execution.md#core-sdk-and-persistence-contracts)). `WorkflowGateResolveResponse` carries the id of the answer's row in `workflow_gate_resolutions`, the row `workflow.gate_resolved` names. A member is required unless it is marked optional, and every optional member says when it is absent.

The visual builder ([Spec-015 §Visual Workflow Builder](../../specs/015-workflow-authoring-and-execution.md#visual-workflow-builder), ADR-024) is why the definition-create request carries the copy-on-write parent pointer, and why `WorkflowToolBinding` exists. Neither promotion to `shared` scope nor the submit half of a file import mints an operation of its own: both ride `workflow.definitionCreate`.

Order, fan-out and join are the document's own edges ([Spec-015 §Graph model — nodes, ports, and edges (SA-31)](../../specs/015-workflow-authoring-and-execution.md#graph-model--nodes-ports-and-edges-sa-31)): a node runs when every one of its `main` inputs is settled, a fan-in waits in a per-node partial-input buffer until every slot is filled, and a document whose nodes declare no edges runs as the sequential chain its node order gives. Nothing outside the document declares that order.

```ts
// Workflow-definition scope (Spec-015 §State And Data Implications).
// Three values: `session` binds the definition to its authoring
// session, `project` spans a project's sessions, `shared` is the cross-project tier —
// a definition reusable by any project on the same daemon, out of the same local
// definition store. `shared` widens visibility/reuse breadth only: no distribution,
// no marketplace, no cross-machine sync.
type WorkflowDefinitionScope = "session" | "project" | "shared";

// Scope identity, in the shape Spec-024 already uses for scope-qualified bindings:
// non-empty for `session` (the authoring session id) and `project` (the project record's id); the empty string for `shared`, which is
// daemon-wide and refers to nothing narrower. Enforced at the schema layer as a typed
// validation error, with the DDL CHECK mirroring it as defense in depth — without it,
// `project` names no project and definition dedupe cannot converge.
//
// On requests the field is optional and the daemon derives what it can: absent at
// `session` means the request's own `sessionId`, absent at `shared` means the empty
// string. `project` is the one scope with nothing to derive from, so omitting it there
// is refused with `workflow.definition_refused` (finding `scope_ref_invalid`), never a
// silent default.
type WorkflowDefinitionScopeRef = string;

// WorkflowDefinitionCreate — workflow.definitionCreate
interface WorkflowDefinitionCreateRequest {
  // The session the author works in. Omitted from the Workflows screen, which belongs to no session: a
  // create there names `project` or `shared` scope, and a `session`-scoped create with no session has no
  // scope ref to derive, so it is refused as below.
  sessionId?: SessionId;
  name: string;
  // A save from the Save panel, a Duplicate, and a file import all ride this one operation,
  // at any scope, with no role check. A document the
  // daemon's re-check refuses answers `workflow.definition_refused`, carrying every
  // finding with the rule it breaks and the nodes it names.
  scope: WorkflowDefinitionScope;
  scopeRef?: WorkflowDefinitionScopeRef; // derived where it can be; required at `project`
  // Copy-on-write provenance: the content hash of the `shared` definition this one was
  // branched from when an author edited a shared definition. Provenance only — it is NOT
  // part of the hashed body, so a branched definition and a from-scratch definition with
  // identical bodies hash alike.
  // Spec-015 §Definition scope in the builder (SA-35)
  parentContentHash?: string;
  // The authored body is the NODE-GRAPH DOCUMENT below: exactly one trigger node, the other
  // nodes, and the edges between them. There is no second, compiled form: the agent and
  // human kinds are node kinds like any other, and their executors call the existing
  // run-admission, orchestration, approval and form paths at run time.
  document: WorkflowDocument;
}

interface WorkflowDefinitionCreateResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  // So a caller can pin the version it just authored without a follow-up read.
  contentHash: string; // BLAKE3 over RFC 8785 JCS canonicalization
  // The opaque server-minted reference to the just-authored version — the exact value
  // workflow.runStart accepts as `workflowVersionId`, so an author can start what it
  // just created without a follow-up read.
  workflowVersionId: string;
  createdAt: string;
}

// ---- The node-graph document: what an author writes and what a version stores ----
// Type names here are prefixed `Workflow` where the unprefixed name is already taken by another
// domain in this file — `NodeId` is the runtime-node brand and `RunId` the provider-run brand, so a
// workflow node and a workflow run carry their own brands and no reader has to guess which domain a
// bare `NodeId` belongs to.

type WorkflowNodeId = string & { readonly __brand: "WorkflowNodeId" };
// A kind key, dotted and readable: the family, then the kind within it. It is data rather than a
// closed union, because the catalog is enumerated by `workflow.kindList` below and a kind ships with
// its own spec and executor — a union here would have to be widened for every kind that lands.
type WorkflowNodeKindId = string;

// ONE JSON document, whose canonical bytes are its hashed field list canonicalized and hashed. Two
// members sit OUTSIDE the hashed body and therefore change no content hash: `layout`, which is canvas
// geometry, and `pinData`, which is sample data an author pinned onto a node. That is why moving a node
// on the canvas, or pinning data to try a branch, mints no version.
interface WorkflowDocument {
  schemaVersion: string; // V1 value: "2".
  name: string;
  description?: string;
  // Exactly one, and it is a node of the trigger family. A workflow with no trigger that can arm cannot
  // be enabled, which `workflow.enabledSet` below refuses rather than accepting silently.
  trigger: WorkflowNode;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  layout?: WorkflowLayout;
  pinData?: Record<string, WorkflowItem[]>;
}

interface WorkflowNode {
  id: WorkflowNodeId;
  kind: WorkflowNodeKindId;
  // Written once at insert and NEVER migrated in place: a kind ships side-by-side implementations and
  // the loader resolves the exact one the document names, so a saved workflow never needs a migration
  // pass to keep opening.
  kindVersion: number;
  name: string; // display label only; expressions address a node through its id, so a rename is metadata
  order: number; // sibling branch order, never geometry
  params: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
  // What a failure does is set ON THE NODE THAT FAILED, not in a document-wide settings block. The third
  // value materializes a real error output handle the failed items route to.
  onError?: "stop" | "continue" | "continue-error-output";
  retry?: { maxTries: number; waitMs: number }; // clamped engine-side
  executeOnce?: boolean;
  alwaysOutputData?: boolean;
}

// An edge names the two handles it joins, not just the two nodes: a node may carry several handles of
// each direction, and a connection that named only the nodes could not say which port it entered.
interface WorkflowEdge {
  id: string;
  source: WorkflowNodeId;
  sourceHandle: string;
  target: WorkflowNodeId;
  targetHandle: string;
}

// Canvas geometry, outside the hashed body but part of the document and persisted beside its body, so
// an exported or agent-authored workflow carries its picture. A document opened with NO layout is laid
// out deterministically, so it is never unopenable and opens the same way twice.
interface WorkflowLayout {
  nodes: Record<string, { x: number; y: number }>;
  viewport?: { x: number; y: number; zoom: number };
  notes?: Array<{ id: string; text: string; x: number; y: number; width: number; height: number }>;
}

// Data between nodes is ALWAYS an array of items, never a bare value: a node runs once over all the
// items of its input, or once per item where its kind declares that, and returns one array per output
// handle — an empty array meaning that branch is dead. Bytes never travel inside a run record: a binary
// value is an artifact reference plus its media type, name and size.
interface WorkflowItem {
  json: unknown;
  binary?: Record<
    string,
    { artifactId: ArtifactId; mimeType: string; fileName: string; size: number }
  >;
  // Lineage: which input item this output came from, so an expression can walk back across a branch and
  // a merge. The engine fills it for one-to-one, one-to-many and equal-count transforms and for the empty
  // item an always-output node emits; a kind that genuinely mints or collapses items sets it itself. A
  // missing or ambiguous lineage is a TYPED error shown in the inspector, never a thrown stack.
  pairedItem?: { item: number; input?: number } | Array<{ item: number; input?: number }>;
  error?: WorkflowStepError;
}

interface WorkflowStepError {
  message: string;
  // The node the failure belongs to. A per-item error rides the item itself, so one item can fail while
  // the rest of a batch succeeds.
  nodeId?: WorkflowNodeId;
}

// A reference to a step payload the run record does not inline. Under the inline bound the payload is
// carried as items; above it the payload is an artifact, and the panel that renders it says which — a
// reader must never be left guessing whether it is seeing the whole thing. Step data is kept until the
// person deletes the run or its session.
type WorkflowPayloadRef =
  | { kind: "inline"; items: WorkflowItem[] }
  | { kind: "artifact"; artifactId: ArtifactId; sizeBytes: number };

// Run statuses are the list below, and nothing else is displayed. `waiting` is never swept to `crashed` on
// a daemon start and is never pruned, so a run parked on a person survives a restart and rehydrates.
type WorkflowRunStatus =
  | "new"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "canceled"
  | "crashed";
// What a `waiting` step waits on: an approval, a form or a chat reply when it waits on a person,
// `chain` when an Execute workflow step's child is held behind its chain's question, and `account`
// when it is parked on a spent provider account. A run's step, its runs-table row and the attention
// read all use this one list.
type WorkflowWaitCause = "approval" | "form" | "reply" | "chain" | "account";
// How the run was started, which is a different question from who started it.
type WorkflowRunMode =
  | "manual"
  | "trigger"
  | "webhook"
  | "chat"
  | "agent"
  | "retry"
  | "sub-workflow";
// Who or what started it, as the run row renders it.
type WorkflowStartedBy =
  | { kind: "user"; userId: UserId }
  | { kind: "schedule" }
  | { kind: "chat"; sessionId: SessionId; messageAnchorCursor?: EventCursor }
  | { kind: "agent"; agentId: AgentId }
  | { kind: "webhook" }
  | { kind: "fileEvent" }
  | { kind: "parentWorkflow"; parentWorkflowRunId: WorkflowRunId };

// One execution of one node. `executionIndex` is per-run monotonic and gives a faithful "what happened
// when" list for a branching run, independent of graph shape; `source` records the edge that ACTUALLY fed
// each input and which run of the source produced it, which is what lets a run page say that this run of
// a merge consumed the third run of a loop. A null entry marks an input slot nothing fed.
interface WorkflowStep {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  attempt: number;
  executionIndex: number;
  source: Array<{ nodeId: WorkflowNodeId; outputIndex: number; executionIndex: number } | null>;
  // The execution instance (SA-6): a derived opaque identifier per Spec-015 §Deterministic identity (SA-21),
  // every bit a function of BLAKE3(workflowRunId || nodeId || attempt). NOT a ULID — a ULID's leading
  // 48 bits are a millisecond timestamp, which that preimage cannot produce. The digest's text rendering
  // is deliberately unfixed; see Spec-015 §Open Questions.
  stepRunId: string;
  // The step status list, the values of Spec-015 §Execution semantics. `waiting` is a step parked on a person, a chain's question or a spent
  // provider account; `waiting-memory` is a step the engine's memory gate holds before it starts, which
  // starts itself when memory frees up and is never a blocker that needs a person; `canceled` is a step
  // that was running or waiting when its run ended failed or canceled, or a branch a first-to-arrive
  // merge stopped.
  status:
    | "pending"
    | "running"
    | "waiting"
    | "waiting-memory"
    | "succeeded"
    | "failed"
    | "skipped"
    | "canceled";
  // Present only on a `waiting` step: what it waits on and, where the wait armed one, the instant it
  // resumes itself. Where none is armed, no instant is invented.
  waitCause?: WorkflowWaitCause;
  resumeAt?: string; // RFC 3339 UTC
  // --- Park surface: `resumeAt` above and the members below mirror the per-step park
  // columns of local-sqlite-schema.md §Workflow Tables (Plan-014). LIVE, NOT RECORD: the columns are a
  // durable record that survives resume and cancellation, and these members are a live view of it. A
  // daemon emits them for exactly the steps parked when the response is built and for no other, so a
  // step that parked earlier and has since resumed reads with none. Presence of `parkReason` is the
  // park's wire discriminator, which lets one workflow.runRead render a parked step without a timeline
  // replay (Spec-015 §Park surfacing on the read model). The status list is not widened for a park: a
  // parked step reads `waiting` with its wait cause, and these members add why and until when.
  //
  // Present whenever the step is parked; the union of Spec-015 §Park integrity and
  // cancelability (SA-41), in DDL order.
  parkReason?: "waiting-human" | "provider-usage-limited";
  // The bounded engine-authored cause. Present whenever `parkReason` is — SA-41 requires a parked step to
  // always carry one — 8 KiB, truncated on a UTF-8 boundary, never reaching a step output, artifact, or
  // agent-visible context (I-014-18).
  parkCause?: string;
  // The provider-account attention key the SA-39 fold groups concurrently parked steps by. Same presence
  // rule as `resumeAt`: armed by the park, cleared on exit, and confined by the step-row CHECK to
  // the waiting state.
  parkAttentionKey?: string;
  // Present only on a step waiting on a person whose node sets a `Timeout`: the instant the wait gives
  // up. An answer after it is refused with `workflow.step_not_waiting`, and at it the step fails with
  // `workflow.step_timed_out` and its node's `onError` decides what follows.
  waitDeadlineAt?: string; // RFC 3339 UTC
  // Present on an Execute workflow step: the child run it started, which the step panel links to.
  childWorkflowRunId?: WorkflowRunId;
  // The optimistic-concurrency token for workflow.humanFormSubmit, per attempt: 0 while the attempt has no
  // accepted submission, 1 after it — a step's output is write-once per attempt, so no higher value is
  // derivable, and a retry mints a new attempt that reads 0 again. Derived from the step's accepted output,
  // never from human_phase_form_state, which holds unsubmitted drafts only (Spec-015 §Human form drafts
  // (SA-27)). Present on `human.form` steps only.
  formRevision?: number;
  startedAt: string;
  finishedAt?: string;
  // The three refs a step panel reads. They are refs and not payloads, so a run read stays bounded
  // whatever the step produced.
  inputRef: WorkflowPayloadRef;
  outputRef: WorkflowPayloadRef;
  logRef: WorkflowPayloadRef;
  // Present only where a provider was billed for this step, carrying the account that paid. A step that
  // was never billed carries no figure and names no account rather than reading zero.
  cost?: { costUsdMicros: number; providerAccountId: ProviderAccountId };
  error?: WorkflowStepError;
  // Non-fatal hints the step attached — an unwired branch that dropped items, a deprecated param, a
  // truncated output. They render as a strip in the output panel and are never errors.
  advisories?: string[];
  // Present exactly where this step ran an agent under a saved definition: every field as actually
  // applied, including the binding the daemon resolved for it (§Plan-024). It rides the step's own record
  // rather than the run read, because the node's axes are changeable for that one use and the record is
  // what a step panel reads to say what actually ran.
  resolvedConfiguration?: AgentResolvedConfiguration;
}

// The value of a node's `tool` param: a reference, and only a reference. Carries NO `enabled`,
// `approvalMode`, or `idempotencyClass` facet — a tool's approval lives only in Settings › MCP
// servers (Spec-024 §Tool-Level Overrides), resolved live at step launch through the Spec-004
// tool-metadata layer. A definition carrying one is refused as an ordinary parse error naming
// the field (Spec-015 §Tool bindings are references, never inline policy (SA-33)).
// Identity COMPOSES the Plan-022-owned `McpServerBindingRef` discriminated union declared
// in §Plan-022 below rather than restating its members: Plan-014 consumes that identity and
// authors none of it (CP-014-6), and re-declaring it flat would drop the scope rules the union
// enforces at the schema layer (`scopeRef` forbidden for `user`, required for `project` and `local`).
// is Spec-024's config scope, never the workflow-definition scope above.
interface WorkflowToolBinding {
  binding: McpServerBindingRef;
  toolName: string;
}

// WorkflowDefinitionRead — workflow.definitionRead
interface WorkflowDefinitionReadRequest {
  definitionId: WorkflowDefinitionId;
  version?: number; // omit for latest
}
interface WorkflowDefinitionReadResponse {
  id: WorkflowDefinitionId;
  name: string;
  scope: WorkflowDefinitionScope;
  scopeRef: WorkflowDefinitionScopeRef;
  versionNumber: number;
  // The opaque server-minted reference to the returned version — the exact value
  // workflow.runStart accepts as `workflowVersionId`.
  workflowVersionId: string;
  document: WorkflowDocument;
  permissionLevel: ExecutionPostureMode; // the workflow's own level, which every run of it uses
  // The webhook token's dates, present only where the document's trigger is a webhook and a token
  // exists. The token itself is never read back — only its hash is kept, and
  // workflow.webhookTokenRotate shows a new one once — so the trigger's Address section reads
  // `Created <date>` and `Last used <time>` from here. With no token, every call to the workflow's
  // address is refused; `webhookTokenLastUsedAt` is absent until a call has presented the token.
  webhookTokenCreatedAt?: string;
  webhookTokenLastUsedAt?: string;
  // The last call to the webhook address and what became of it: it started a run, the trigger's
  // overlap choice skipped it because a run was still going, or it was refused, with the refusal's
  // code (`workflow.webhook_token_mismatch` for a token that does not match the kept hash).
  webhookLastFire?: {
    at: string;
    outcome: "started" | "skipped" | "refused";
    refusalCode?: string; // present exactly on `refused`
  };
  createdAt: string;
}

// WorkflowDefinitionList — workflow.definitionList. The one enumeration of saved workflows: the
// Workflows tab and its count, the `/workflow` name completion, the CLI `list` subcommand and an agent's
// `workflow_list` all read it. Called with a session (the chat verbs, an agent's tool), it returns that
// session's resolved scope set most-specific-first — the session's definitions, its project's, and the
// daemon's `shared` tier — deduped by `(scope, scopeRef, contentHash)` exactly as the store keys them,
// and it never discloses a definition outside that set (I-014-10). Called with no session (the
// Workflows screen, which belongs to no session), it returns every definition on this machine, with
// scope as a filter.
interface WorkflowDefinitionListRequest {
  sessionId?: SessionId; // omit from the Workflows screen
  scope?: WorkflowDefinitionScope; // omit for every visible scope
  limit?: number;
  cursor?: string;
}
interface WorkflowDefinitionListResponse {
  definitions: WorkflowDefinitionSummary[];
  // How many definitions the whole list holds, so a tab's count reads right on first paint.
  totalCount: number;
  nextCursor?: string;
}
interface WorkflowDefinitionSummary {
  id: WorkflowDefinitionId;
  name: string;
  scope: WorkflowDefinitionScope;
  scopeRef: WorkflowDefinitionScopeRef;
  latestVersionNumber: number;
  // The opaque server-minted reference to that latest version — the exact value
  // workflow.runStart accepts as `workflowVersionId`; clients pass it through
  // verbatim and never synthesize it. `latestVersionNumber` stays alongside it
  // because workflow.versionRead addresses by (definitionId, versionNumber).
  latestWorkflowVersionId: string;
  // So the caller that just listed an entry can pin it.
  contentHash: string;
  // Present only when the request named a session: true for the one entry per definition name that
  // most-specific-first resolution (`session`, then `project`, then `shared`) would actually pick from
  // that session, so a picker or `sidekicks workflow list` can show which definition a run would use
  // rather than leaving the caller to re-derive the order (Spec-015 §Definition scope in the builder
  // (SA-35)).
  resolvesAtThisContext?: boolean;
  // The facts a catalog row shows beside the name, so the table needs no second read per row.
  // The kind of the document's one trigger.
  triggerKind: WorkflowNodeKindId;
  // `lastRun` is absent where the definition has never run — a different fact from a run that failed.
  lastRun?: { workflowRunId: WorkflowRunId; status: WorkflowRunStatus; startedAt: string };
  // The armed schedule in words plus its next fire, absent where the definition declares no schedule.
  // The next fire is computed in the trigger's own timezone, which is a param on the schedule trigger.
  schedule?: { expression: string; timeZone: string; nextFireAt?: string };
  // The last fire the trigger's overlap choice skipped because a run was still going, with that run's
  // start, so the row reads "3:00 AM skipped · the 2:00 AM run was still going". A skipped fire is never
  // a run.
  lastSkippedFire?: { scheduledAt: string; runningSince: string };
  // Whether every trigger this definition declares is armed. It is the toggle's own truth, so the row
  // reverts visibly when the daemon refuses rather than holding an optimistic value.
  enabled: boolean;
  runCount: number;
  // The tags the row writes on its second line beside the scope word, and the tag filter narrows on.
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

// WorkflowVersionRead — workflow.versionRead. Reads one immutable version body.
// Versions are content-hashed and never mutated; a definition edit mints a new one.
interface WorkflowVersionReadRequest {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
}
interface WorkflowVersionReadResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  // The opaque server-minted reference to THIS version — the exact value
  // workflow.runStart accepts as `workflowVersionId`; see the constructibility
  // note there.
  workflowVersionId: string;
  contentHash: string;
  // The schema-version marker as the document carries it: `WorkflowDocument.schemaVersion`,
  // whose V1 value is "2" ([Spec-015 §Required Behavior](../../specs/015-workflow-authoring-and-execution.md#required-behavior)). A string rather
  // than a number, so a later "2.1" round-trips instead of collapsing to 2.
  schemaVersion: string;
  // The canonical body itself, without which nothing could reproduce the canonical bytes
  // or their content hash. The file form has exactly two top-level parts, the hashed
  // definition body and the optional non-hashed `layout`
  // ([Spec-015 §Definition file form — export and import (C-17)](../../specs/015-workflow-authoring-and-execution.md#definition-file-form--export-and-import-c-17)), so the name, the
  // trigger node and the node sequence all live INSIDE this document rather than beside
  // it. How a run begins is the document's own trigger node — exactly one, of a kind in the
  // trigger family, every one of which ships
  // ([Spec-015 §Entry node and the V1 trigger surface (SA-36)](../../specs/015-workflow-authoring-and-execution.md#entry-node-and-the-v1-trigger-surface-sa-36)). There is no
  // second entry record beside it and no start mode the daemon materializes.
  document: WorkflowDocument;
  createdAt: string;
}

// WorkflowRunStart. Callers: CLI, desktop, the intercepted `/workflow run` verb, and the
// `workflow_run` callback tool — all one operation;
// no chat caller mints a start mode (Spec-015 SA-36/SA-37). An agent's start, and each run a
// trigger fires, is judged under the SA-38 named Cedar operation action `workflow::start` and
// refused with `workflow.start_denied`; the person's own start passes no policy check.
interface WorkflowRunStartRequest {
  // The opaque server-minted version reference — the immutable version row's
  // primary key, returned verbatim by workflow.versionRead,
  // workflow.definitionRead, workflow.definitionList, and
  // workflow.definitionCreate. Clients pass it through and never synthesize or
  // parse it: no delimiter or encoding over (definitionId, versionNumber) exists
  // on the wire.
  workflowVersionId: string;
  // The session the run lives in. A start made from a chat names that chat's session, which is the
  // only session its progress row and its results row ever reach, and the daemon checks the caller
  // holds it, refusing `workflow.start_denied` otherwise. A start from outside a chat — Run now from
  // the Workflows screen or the builder, Re-run from a run's page — omits it, and the run lives in the
  // one session the workflow owns, created on its first such run and reused by every later one.
  sessionId?: SessionId;
  // The items the run starts on. A workflow declares the inputs it asks for on its trigger, each one
  // named, typed and carrying the value it starts on; the start affordance seeds a field per input and
  // this member carries what was filled in. Absent where the workflow declares none, which starts on the
  // press.
  input?: WorkflowItem[];
  // How this start was made. It is an INPUT here and the recorded outcome on the run: a chat caller mints
  // no start mode of its own, and `retry` and `sub-workflow` are minted by the operations that produce
  // them rather than requested.
  mode?: WorkflowRunMode;
}
interface WorkflowRunStartResponse {
  workflowRunId: WorkflowRunId;
  // The session the run lives in: the chat the request named, or the workflow's own.
  sessionId: SessionId;
  // Two of the run statuses are reachable from a start: the run is admitted and not yet dispatched, or
  // it is already running. Narrowing here keeps callers from switching on statuses a start cannot produce.
  state: "new" | "running";
  steps: WorkflowStep[];
}

// WorkflowRunRead — workflow.runRead. Run header plus the step array;
// the projection rebuilds from session_events (Spec-015 §State And Data Implications),
// so a read never consults request state.
interface WorkflowRunReadRequest {
  workflowRunId: WorkflowRunId;
}
interface WorkflowRunReadResponse {
  workflowRunId: WorkflowRunId;
  // The session the run lives in: the chat that started it, the one session the workflow owns for a run
  // nobody started from a chat, or, for a sub-workflow child, its parent's.
  sessionId: SessionId;
  // The workflow the run came from, which the header links to. A run whose definition was deleted still
  // opens, because it pins its version.
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
  // The status list, and nothing else is displayed: a run is new, running, waiting on a person or a
  // provider, succeeded, failed, canceled or crashed. A gated run is `waiting`, which is the one status
  // never swept on a daemon start and never pruned, so a run parked on a person survives a restart. The
  // stored status CHECK is in lockstep with this union.
  state: WorkflowRunStatus;
  // The step array, one entry per execution of one node, each carrying its input, output and log refs. It is the record a
  // run page draws its graph and its step panel from: the graph is the workflow's OWN canvas, read-only,
  // every node in the place the builder put it and colored by that node's step status, and the panel
  // holds one step at a time. A waiting step says what it waits on and when it resumes itself on its own
  // record, and a parked step carries the live park members, so one workflow.runRead renders why the
  // run is parked, per branch, with no timeline replay (Spec-015 §Park surfacing on the read model).
  steps: WorkflowStep[];
  // How the run was started and by whom, which the run row and the run header both read. `startedBy`
  // carries the message anchor on a chat-borne start, which is how a run links back to the message that
  // started it.
  mode: WorkflowRunMode;
  startedBy: WorkflowStartedBy;
  // The items the run started on, which Re-run starts the same version with again. Absent where the run
  // started on none.
  input?: WorkflowItem[];
  // The first run of this run's chain; its own id for a first run. A run started by an Execute workflow
  // step, by an error trigger, or by a session-event or file-watch trigger on something a run of a chain
  // did joins that chain, and the header names the chain's first run only when `chainRoot.runId` is not
  // this run's own id.
  chainRoot: {
    runId: WorkflowRunId;
    workflowId: WorkflowDefinitionId;
    workflowName: string;
    startedAt: string;
  };
  // Whether the daemon captured this run's execution context and pins its snapshot points at the start,
  // at each approval pause and at the end. True for a run in a project session; false for a run in a
  // chat session, which has no Review. It decides whether `Open in Review` opens what the run changed.
  executionContextCaptured: boolean;
  // Whether the person marked the run Keep, which `workflow.runsDelete` leaves untouched.
  keep: boolean;
  // The session a failed step's `Fix in a fresh session` opened, which the header links to for the life
  // of the run.
  fixSessionId?: SessionId;
  failureReason?: string; // preserved on any bound breach (SA-1, SA-2); also carries
  // the cancellation reason when `state` is `canceled`, mirroring the
  // `workflow_runs.failure_reason` / `failure_detail` split
  startedAt: string;
  endedAt?: string;
}

// WorkflowRunCancel — workflow.runCancel. It is the named producer of the `canceled` run
// status and the reachable caller of Plan-014 T5.20's engine
// cancelability rule. This operation and the
// workflow.canceled event type mint TOGETHER — a cancellation that moved run status
// without appending its canonical event would break the SA-25 rebuild, because a
// replay would restore the last suspension payload's schedule and attention key and
// resurrect a run the person canceled (I-014-22).
interface WorkflowRunCancelRequest {
  workflowRunId: WorkflowRunId;
  // The person's own cause, recorded on the run and carried in the
  // workflow.canceled payload. Bounded exactly as `parkCause` is — 8 KiB, truncated
  // on a UTF-8 boundary — and never reaching a phase output, artifact, or
  // agent-visible context.
  reason?: string;
}
interface WorkflowRunCancelResponse {
  workflowRunId: WorkflowRunId;
  // A literal rather than the run-status union: a successful cancel has exactly
  // one outcome, and narrowing here keeps callers from switching on states this
  // operation cannot produce.
  state: "canceled";
  // The `session_events.id` of the workflow.canceled event this call appended, in
  // the same unit of work as the status write (I-014-22). Returned so a caller can
  // correlate without a timeline read.
  canceledEventId: string;
  // True when the run was ALREADY `canceled` and this call was an idempotent
  // replay: no second status write, no second event, and `canceledEventId` names
  // the original. Deliberately NOT how a run that already ended otherwise answers — a
  // cancel against a run that ended `succeeded`, `failed` or `crashed` refuses
  // `workflow.run_not_cancelable`, because reporting success for a run that had
  // already ended would misinform the person about what their action did.
  alreadyCanceled: boolean;
}

// WorkflowRunResume — workflow.runResume. Resumes a parked
// run and carries the OPTIONAL explicit re-pin of
// Spec-015 §Frozen-definition repair (SA-40). The re-pin is a member of this request
// rather than a method of its own by design: SA-40 defines the repair only as an
// action ON a resume, so a separate method would admit the re-pin-without-resume
// shape that spec refuses.
interface WorkflowRunResumeRequest {
  workflowRunId: WorkflowRunId;
  // Omit for an ordinary resume, which continues on the frozen pinned version.
  // Supplying it requests the SA-40 repair EXPLICITLY — no timer, no armed schedule,
  // and no ordinary resume ever re-pins.
  versionRepin?: {
    // The version the caller intends to join. REQUIRED within this member: a repair
    // that resolved "latest" server-side would race the definition's own edits and
    // leave the audited from/to pair unverifiable against what the person saw.
    targetWorkflowVersionId: string;
  };
}
interface WorkflowRunResumeResponse {
  workflowRunId: WorkflowRunId;
  // `running` in the ordinary case. `waiting` where the engine immediately
  // re-parked — an SA-39 usage-limit park whose account is still spent re-parks on
  // the next dispatch. That is a legal outcome rather than a refusal, and the
  // re-park emits its own workflow.phase_suspended, which is how the person sees
  // what happened. Resuming ahead of an armed `resumeAt` is therefore permitted
  // and needs no override flag: the machine's own schedule was advisory pacing, and
  // the worst case is one observable re-park.
  state: "running" | "waiting";
  // Present only on an ACCEPTED re-pin: the version the run left and the one it
  // joined — the same pair the audited workflow.resumed payload carries, so the
  // projected run row stays a function of the log.
  repinnedFromWorkflowVersionId?: string;
  repinnedToWorkflowVersionId?: string;
}

// WorkflowStepOutputList — workflow.stepOutputList. A run's step outputs for a caller outside the run
// page — the CLI or an SDK — and only the agent and human steps' output summaries and artifact
// references: one step's full input, output or log comes only from workflow.stepRead. Outputs stay
// addressable after their step completes, and a retry adds entries rather than changing one.
interface WorkflowStepOutputListRequest {
  workflowRunId: WorkflowRunId;
}
interface WorkflowStepOutputListResponse {
  outputs: Array<{
    // The step the output belongs to, keyed as workflow.stepRead keys it.
    nodeId: WorkflowNodeId;
    executionIndex: number;
    // `artifact_ref` outputs point at a Plan-011 manifest; Plan-014 stores the
    // reference, never the bytes, and adds no second upload path.
    valueKind: "inline" | "artifact_ref";
    artifactId?: ArtifactId; // present exactly on `artifact_ref`
    summary: string;
    producedAt: string;
  }>;
}

// WorkflowGateResolve — workflow.gateResolve. Answers an approval: an approval step's Approve or Reject,
// from the approvals surface or from the step's own panel, through the one approval pipeline and its
// Cedar check; and the question the engine raises on a chain's first run once the chain has started as
// many runs as the person's setting allows, where `approved` is Keep going and `rejected` is Stop them
// all. The first answer settles the wait everywhere. An answer on a step no longer waiting, or after the
// step's `Timeout` instant even before its timer has run, is refused with `workflow.step_not_waiting`.
interface WorkflowGateResolveRequest {
  workflowRunId: WorkflowRunId;
  // The approval step being answered. Absent for a chain's question, which belongs to the run named
  // above — the chain's first run — rather than to a node.
  nodeId?: WorkflowNodeId;
  resolution: "approved" | "rejected";
  feedback?: string;
}
interface WorkflowGateResolveResponse {
  // The answer's row in workflow_gate_resolutions, which the workflow.gate_resolved event names.
  gateResolutionId: string;
  // When the answer was recorded, which the step panel's past-tense receipt reads.
  decidedAt: string;
}

// WorkflowHumanFormDraftSave — workflow.humanFormDraftSave.
// Ships at V1: the form kind activates it. Each save writes the daemon-held draft
// in human_phase_form_state, keyed by run and node (Spec-015 §Human form drafts
// (SA-27)), as the person types, so a half-filled form survives a reload; a client
// never keeps a form draft in window storage. A save carrying a stale
// `expectedRevision` is refused with `workflow.revision_stale`.
interface WorkflowHumanFormDraftSaveRequest {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  formState: Record<string, unknown>;
  expectedRevision?: number;
}
interface WorkflowHumanFormDraftSaveResponse {
  revision: number;
  savedAt: string;
}

// WorkflowHumanFormSubmit — workflow.humanFormSubmit. Optimistic concurrency: a submit
// carrying a stale `expectedRevision` is refused with `workflow.revision_stale`, never
// silently overwritten, and a submit on a step no longer waiting is refused with
// `workflow.step_not_waiting`. The current revision is read from
// workflow.humanFormRead's `formRevision`, the same value the run-read projection
// carries as WorkflowStep.formRevision: a fresh attempt reads 0,
// so a first submit carries expectedRevision: 0, and after an accepted submission
// any further submit against the same attempt is stale. An abandoned claim writes
// nothing, so the revision stays 0 and the next claimant's first submit succeeds
// (Spec-015 §Fallback Behavior re-claim). The draft save above carries its own draft
// counter (its store initializes at 1); that counter guards draft saves only and is
// never this submit token, which derives from the step's stored output alone (`workflow_steps`).
interface WorkflowHumanFormSubmitRequest {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  // One value per field of the form's input schema. A form has no artifact field: a
  // value that names a file or folder is a `path` field, picked through the platform's
  // own chooser.
  fields: Record<string, unknown>;
  expectedRevision: number;
}
interface WorkflowHumanFormSubmitResponse {
  nodeId: WorkflowNodeId;
  outputCount: number;
  submittedAt: string;
}

// ---- The builder, the catalog and the runs surface ----

// WorkflowDefinitionUpdate — workflow.definitionUpdate. A save writes a NEW IMMUTABLE VERSION and never
// mutates an existing one, so this operation mints a version rather than editing bytes. It is optimistic
// on the version the author loaded: a stale expectation is refused with `workflow.version_stale`, never
// silently rebased onto a version the author never saw. Save, Restore and the `/workflow schedule` verb
// all ride it. Saving an edit to a `shared` definition does NOT touch the original: it creates a
// new definition at the EDITING CONTEXT'S scope carrying the original's content hash as its parent, which
// is why the response can name a different definition from the one the request addressed.
interface WorkflowDefinitionUpdateRequest {
  definitionId: WorkflowDefinitionId;
  expectedVersionNumber: number;
  document: WorkflowDocument;
}
interface WorkflowDefinitionUpdateResponse {
  // The definition the version landed on — the requested one, or the copy-on-write branch where the
  // request edited a `shared` definition from a narrower scope.
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  workflowVersionId: string;
  contentHash: string;
  // Present exactly on the branch: the `shared` definition this one was copied from, which is also the
  // value stored as the new definition's parent hash.
  branchedFromContentHash?: string;
  createdAt: string;
}

// WorkflowDefinitionDelete — workflow.definitionDelete. A SOFT delete: the definition leaves the catalog
// and the runs that pinned its versions stay readable against those versions, which is why the response
// states how many runs that is — the confirm names the count before it acts, and it is not undoable.
interface WorkflowDefinitionDeleteRequest {
  definitionId: WorkflowDefinitionId;
}
interface WorkflowDefinitionDeleteResponse {
  definitionId: WorkflowDefinitionId;
  deleted: true;
  retainedRunCount: number;
}

// WorkflowDefinitionExport — workflow.definitionExport. Writes the canonical file form of one version — the
// hashed body plus the optional non-hashed layout section, with each Code node's package lock — to the file
// the person picked with the platform's own save dialog. It is a SERVER operation rather than a client-side
// serialization of a version read, because the canonical bytes and their content hash are the store's own
// and a round trip in either direction must reproduce them exactly. The renderer never names a path and
// never holds the file's bytes: the request carries the `FilePathRef` token `native.showSaveDialog`
// returned, and main's relay turns the token into the path the daemon writes (Spec-021 §Preload Bridge
// Contract).
interface WorkflowDefinitionExportRequest {
  definitionId: WorkflowDefinitionId;
  version?: number; // omit for latest
  includeLayout?: boolean; // default true; the layout section is outside the hashed body either way
  destination: FilePathRef;
}
interface WorkflowDefinitionExportResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  contentHash: string;
}

// WorkflowDefinitionImport — workflow.definitionImport. Reads the file the person picked with the platform's
// own open dialog — its `FilePathRef` token, turned into a path by main's relay — parses it, and submits it
// through the ORDINARY create path with the ordinary validation, all or nothing: a tool binding with an
// approval setting and an unknown top-level key are each refused as parse errors naming the field. A file
// whose schema version the daemon does not know is refused with `workflow.import_schema_unknown`. A Code
// node keeps the package lock the file carries, and one without a lock is locked on import, or kept with
// `Packages not locked` where the lock cannot be made. A document with no layout
// section is laid out deterministically on open, so an imported file is never unopenable.
interface WorkflowDefinitionImportRequest {
  sessionId?: SessionId; // omitted from the Workflows screen, as on workflow.definitionCreate
  source: FilePathRef;
  scope: WorkflowDefinitionScope;
  scopeRef?: WorkflowDefinitionScopeRef;
}
interface WorkflowDefinitionImportResponse {
  definitionId: WorkflowDefinitionId;
  versionNumber: number;
  workflowVersionId: string;
  contentHash: string;
  createdAt: string;
}

// WorkflowEnabledSet — workflow.enabledSet. Arms or disarms EVERY trigger one workflow declares; there is
// no per-trigger arming, because a workflow is enabled or it is not. A workflow with no trigger that can
// arm cannot be enabled and the operation REFUSES with `workflow.trigger_unarmable`, saying which trigger
// could not arm, rather than accepting and leaving a toggle that reads on while nothing fires.
interface WorkflowEnabledSetRequest {
  definitionId: WorkflowDefinitionId;
  enabled: boolean;
}
interface WorkflowEnabledSetResponse {
  definitionId: WorkflowDefinitionId;
  enabled: boolean;
  // How many of the definition's triggers are armed now. Zero on a disarm; on an arm it equals the
  // triggers the definition declares, since a partial arm refuses instead.
  armedTriggerCount: number;
}

// WorkflowRunList — workflow.runList. The runs enumeration, with the filters the runs table narrows
// on — workflow, status, trigger, and a date range — and one narrowing beside them: the version scope the
// Versions panel's Show runs hands in, which the table draws as one removable chip, never keeps, and
// Clear filters clears. Filters narrow the TABLE alone — whatever stands above it is unfiltered, which is
// why the runs that need someone are workflow.runAttentionList, a separate read rather than a filtered
// slice of this one.
interface WorkflowRunListRequest {
  sessionId?: SessionId; // omit for every run this daemon ran
  definitionId?: WorkflowDefinitionId;
  // The version scope Show runs hands in: only runs pinned to this version. Sent only with
  // `definitionId`, which Show runs sets to the same workflow.
  workflowVersionId?: string;
  status?: WorkflowRunStatus[];
  mode?: WorkflowRunMode[];
  startedAfter?: string;
  startedBefore?: string;
  limit?: number;
  cursor?: string;
}
// One row of the runs table, in the order the row reads it. A row carries no version: the pinned version
// is read in the header of the run's own page.
interface WorkflowRunSummary {
  workflowRunId: WorkflowRunId;
  definitionId: WorkflowDefinitionId;
  definitionName: string;
  // The session the run lives in: the chat that started it, or the one session the workflow owns for a
  // run nobody started from a chat. The row opens it.
  sessionId: SessionId;
  status: WorkflowRunStatus;
  mode: WorkflowRunMode;
  startedBy: WorkflowStartedBy;
  startedAt: string;
  durationMs?: number; // absent while the run is still going
  stepCount: number;
  // Where the run is and what it is doing, present only while the run is going: the live step's place in
  // the run and its name. It goes back to the finished step count when the run ends, so the row never
  // grows a second line.
  liveStep?: { index: number; total: number; nodeName: string };
  // Present only where a provider was billed, carrying the account that paid. A row that was never billed
  // carries no figure and names no account.
  cost?: { costUsdMicros: number; providerAccountId: ProviderAccountId };
  // What the run is waiting on, present only while it is `waiting`: the kind of wait, so a wait on a
  // person and a park on a spent provider account read apart; the cause in the engine's own words; and,
  // where the park armed one, the instant it will resume itself. Where none is armed, no instant is
  // invented.
  waitingOn?: { waitCause: WorkflowWaitCause; cause: string; resumeAt?: string };
}
interface WorkflowRunListResponse {
  runs: WorkflowRunSummary[];
  // How many runs the request's filters match, so the tab's count reads right on first paint.
  totalCount: number;
  nextCursor?: string;
}

// WorkflowVersionChainRead — workflow.versionChainRead. The chain one run's pinned version belongs to,
// addressed BY THAT VERSION ID rather than by the definition: a run pins its version, and a run whose
// definition was deleted still opens, so the read must work from the only handle such a run holds.
interface WorkflowVersionChainReadRequest {
  workflowVersionId: string;
}
interface WorkflowVersionChainReadResponse {
  definitionId: WorkflowDefinitionId;
  // Oldest first. Every version the chain holds, each addressable by `workflow.versionRead`.
  versions: Array<{
    workflowVersionId: string;
    versionNumber: number;
    contentHash: string;
    createdAt: string;
    // Who saved it: the person, or the agent that did. The Versions panel names it on each row, beside
    // the one-line count workflow.versionDiffRead computes.
    savedBy: { kind: "user" } | { kind: "agent"; agentId: AgentId };
  }>;
}

// WorkflowStepRead — workflow.stepRead. One step's input, output or log, by ref, paged and redacted. Every
// resolved secret value is added to the run's redaction set BEFORE the first log line is written, so
// redaction is a property of what was stored rather than of this read.
interface WorkflowStepReadRequest {
  workflowRunId: WorkflowRunId;
  // A step is addressed by the node it ran plus which execution of it, because a loop runs one node many
  // times and a retry mints a new attempt.
  nodeId: WorkflowNodeId;
  executionIndex: number;
  which: "input" | "output" | "log";
  limit?: number;
  cursor?: string;
}
interface WorkflowStepReadResponse {
  nodeId: WorkflowNodeId;
  executionIndex: number;
  which: "input" | "output" | "log";
  payload: WorkflowPayloadRef;
  nextCursor?: string;
}

// WorkflowRunRetry — workflow.runRetry. Re-runs from a NAMED STEP: that step and its descendants run
// again, with the prior run's data pinned upstream so the retry feeds on exactly what the original fed on.
// It mints a new run in `retry` mode rather than mutating the original, which stays readable. It is
// refused with `workflow.retry_unavailable` — `reason: "source_running"` while the source run is still
// going — and with `workflow.invalid_transition` for a step that did not fail.
interface WorkflowRunRetryRequest {
  workflowRunId: WorkflowRunId;
  fromNodeId: WorkflowNodeId;
}
interface WorkflowRunRetryResponse {
  workflowRunId: WorkflowRunId; // the new run
  sourceWorkflowRunId: WorkflowRunId;
  state: "new" | "running";
}

// WorkflowNodeExecute — workflow.nodeExecute. Executes one node in the builder against pinned or prior
// input. Run-this-node is the single-node case and run-from-here is the same call with the ancestors
// included: the target's ancestors plus the target run, clean step data is REUSED and only dirty nodes are
// re-executed. The dirty set lives in the builder, but the filtered run is computed by the DAEMON, which
// is authoritative — a client's lattice is a hint, never the plan. It runs a SAVED version and never
// unsaved bytes: a dirty draft is saved first and the version saved is the version run. Pinned data is
// honored here and IGNORED by every trigger-started run.
interface WorkflowNodeExecuteRequest {
  workflowVersionId: string;
  // Omitted from the builder, where the run lives in the one session the workflow owns; a chat that
  // asks for a node run names its own session, as workflow.runStart does.
  sessionId?: SessionId;
  nodeId: WorkflowNodeId;
  // `node` runs the one node; `fromHere` runs its ancestors and it.
  scope: "node" | "fromHere";
  // The nodes the builder believes are dirty. The daemon intersects this with what it can reuse and
  // answers with the set it actually ran, so a stale hint costs a re-execution and never a wrong result.
  dirtyNodeIds?: WorkflowNodeId[];
}
interface WorkflowNodeExecuteResponse {
  workflowRunId: WorkflowRunId;
  // The nodes the daemon actually executed, in execution order — the authoritative answer to what the
  // filtered run did.
  executedNodeIds: WorkflowNodeId[];
  reusedNodeIds: WorkflowNodeId[];
}

// WorkflowResultsPost — workflow.resultsPost. Posts a run's results into the session that asks for them, as
// the results row. The `/workflow results` verb sends the session it was typed in, and the daemon checks
// that session is the caller's own before it posts; the agent's `workflow_results_post` tool takes no
// session at all, the daemon deriving it from the invoking turn. Results are pulled into a session only
// from inside that session, never pushed into one that did not ask, and a run page carries no send-to-chat
// action at all. A run that has not finished is refused with `workflow.invalid_transition`. The post
// appends `workflow.results_posted` after the run's terminal status.
interface WorkflowResultsPostRequest {
  workflowRunId: WorkflowRunId;
  sessionId: SessionId;
}
interface WorkflowResultsPostResponse {
  workflowRunId: WorkflowRunId;
  posted: true;
}

// WorkflowSubscribe — workflow.subscribe. Run, step, schedule and definition notifications for the runs
// table, the Workflows tab and the canvas overlay: ONE subscription for the whole surface rather than one
// per row, which is what keeps a long table from opening a subscription per run. Its first notification is
// the scheduler hold and its waiting count as they stand, and every change to them rides it after, so a
// hold set on one device shows on another without a poll. A definition's change and a run's removal ride it
// too, so no open view keeps a row that is gone. A Notify step mints nothing here: it is one informational
// entry on the attention projection (§Plan-016 — Notifications And Attention Model).
interface WorkflowSubscribeRequest {
  sessionId?: SessionId; // omit for every run this daemon ran
  definitionId?: WorkflowDefinitionId;
}
type WorkflowSubscribeNotification =
  | { kind: "run"; run: WorkflowRunSummary }
  | { kind: "runRemoved"; workflowRunIds: WorkflowRunId[] }
  | { kind: "definition"; definition: WorkflowDefinitionSummary }
  | { kind: "definitionRemoved"; definitionId: WorkflowDefinitionId }
  | { kind: "step"; workflowRunId: WorkflowRunId; step: WorkflowStep }
  // A schedule armed, disarmed, or fired — and a fire the overlap policy SKIPPED, which shows on the
  // workflow's row and on that trigger's panel and is deliberately never a run.
  | {
      kind: "schedule";
      definitionId: WorkflowDefinitionId;
      nodeId: WorkflowNodeId;
      event: "armed" | "disarmed" | "fired" | "skipped";
      scheduledAt: string;
      nextFireAt?: string;
    }
  | { kind: "runsPause"; paused: boolean; waitingStartCount: number };

// WorkflowKindList — workflow.kindList. The node catalog with its param specs, so the palette, the
// inspector and an agent all read ONE list. One declarative description drives the parameter form, the
// canvas ports, the palette entry and the validation; everything that renders a node is a generic renderer
// over it.
interface WorkflowKindListRequest {}
interface WorkflowHandleSpec {
  id: string; // encodes the direction, the type and the index, so a handle is addressable without a lookup
  label: string;
  // `main` carries items; `tool` carries a capability.
  type: "main" | "tool";
  maxConnections?: number;
  required?: boolean;
}
// A param's declaration. The `collection` arm is the one that nests, holding a field list and optionally
// repeating; every other param is a leaf of one declared type. `showWhen` is the whole conditional-form
// engine: a param is drawn when the named sibling params hold one of the listed values.
type WorkflowParamSpec =
  | {
      id: string;
      label: string;
      type:
        | "string"
        | "text"
        | "number"
        | "boolean"
        | "select"
        | "multiselect"
        | "json"
        | "expression"
        | "path"
        | "glob"
        | "cron"
        | "secret"
        | "agent"
        | "mcp-tool"
        | "session";
      required?: boolean;
      // The only params a `secret://<scope>/<name>` reference resolves in: a step's Credential field, and an
      // HTTP request step's auth and headers. A node never stores a secret: the daemon resolves the
      // reference at step launch, the step record stores the reference and never the value, and a
      // reference in any other param, an expression included, is refused at save.
      sensitive?: boolean;
      default?: unknown;
      help?: string;
      options?: Array<{ value: unknown; label: string }>;
      showWhen?: Record<string, unknown[]>;
    }
  | {
      id: string;
      label: string;
      type: "collection";
      fields: WorkflowParamSpec[];
      multiple?: boolean;
    };
// The SERIALIZED form of one kind. The catalog's two computed members do not cross a wire: a kind whose
// output set derives from its params, and a kind's one-line summary of a configured node, are both
// functions of the params, and a function cannot be sent. `outputsDeriveFromParams` states that the set is
// computed so a reader knows the declared list is the base case rather than the whole truth, and the
// summary is composed by the client that holds the catalog's own code. An agent authoring a document
// reads everything below and needs neither.
interface WorkflowNodeKindSpec {
  kind: WorkflowNodeKindId;
  version: number;
  category: "trigger" | "agent" | "human" | "files" | "browser" | "developer" | "flow" | "output";
  displayName: string;
  description: string;
  icon: string;
  aliases?: string[]; // palette search only
  inputs: WorkflowHandleSpec[];
  outputs: WorkflowHandleSpec[];
  outputsDeriveFromParams: boolean;
  params: WorkflowParamSpec[];
  // True where the kind runs once per item rather than once over all of them.
  perItem?: boolean;
  capabilities?: {
    cancelable: boolean;
    resumable: boolean;
    sideEffects: "none" | "local" | "external";
  };
}
interface WorkflowKindListResponse {
  kinds: WorkflowNodeKindSpec[];
}

// WorkflowRunsPauseSet — workflow.runsPauseSet. The scheduler-wide hold on STARTING new runs. It takes no
// run id, because it is neither of the two per-run operations: one state per daemon over its whole
// scheduler. With the hold on, a run already going finishes and every new start waits — a schedule fire, a
// webhook, a file event, a chat verb, an agent's tool and a manual start alike — and turning it off
// starts what waited. The count is what the control reads.
interface WorkflowRunsPauseSetRequest {
  paused: boolean;
}
interface WorkflowRunsPauseSetResponse {
  paused: boolean;
  waitingStartCount: number;
}

// WorkflowLayoutSet — workflow.layoutSet. Saves the canvas layout — node positions, the viewport and the
// sticky notes — beside the definition body without minting a version: layout sits outside the hashed
// body, so dragging a node or Tidy up changes no byte, no hash and no version, and saved versions are
// untouched.
interface WorkflowLayoutSetRequest {
  definitionId: WorkflowDefinitionId;
  layout: WorkflowLayout;
}
interface WorkflowLayoutSetResponse {
  definitionId: WorkflowDefinitionId;
  updatedAt: string;
}

// WorkflowPermissionLevelUpdate — workflow.permissionLevelUpdate. Sets the workflow's own permission level from
// the builder's level pill; a new workflow starts at `yolo`. Every run of the workflow uses that level
// wherever the run lives, a chat's session or the workflow's own, and a live run takes a change from
// its next step. The level sits outside the hashed body, so a change mints no version.
interface WorkflowPermissionLevelUpdateRequest {
  workflowId: WorkflowDefinitionId;
  level: ExecutionPostureMode;
}
interface WorkflowPermissionLevelUpdateResponse {
  workflowId: WorkflowDefinitionId;
  level: ExecutionPostureMode;
}

// WorkflowPinDataSet — workflow.pinDataSet. Pins test data onto one node, or unpins it with `items: null`,
// from the inspector's Output panel, a run's step panel, or Copy this run into the builder — without a new
// version, because pinned data sits outside the hashed body. Pinned data is honored only in manual runs and
// ignored by every trigger-started run, and a node can be pinned only where it has a single `main` output
// and its items carry no binary payload.
interface WorkflowPinDataSetRequest {
  definitionId: WorkflowDefinitionId;
  nodeId: WorkflowNodeId;
  items: WorkflowItem[] | null;
}
interface WorkflowPinDataSetResponse {
  definitionId: WorkflowDefinitionId;
  nodeId: WorkflowNodeId;
  pinned: boolean;
}

// WorkflowDraftUpdate — workflow.draftUpdate. Holds the builder's unsaved draft in the daemon, so a reload
// loses nothing and nothing is kept in window storage. The first call for a draft omits `workflowDraftId`
// and the daemon mints one, which the builder's address carries so a reload finds the draft again. A draft
// of a saved workflow names the definition and the version it was opened from; a never-saved one names
// neither.
interface WorkflowDraftUpdateRequest {
  workflowDraftId?: string;
  definitionId?: WorkflowDefinitionId;
  basedOnVersionNumber?: number;
  document: WorkflowDocument;
}
interface WorkflowDraftUpdateResponse {
  workflowDraftId: string;
  updatedAt: string;
}

// WorkflowDraftRead — workflow.draftRead. The draft read back after a reload, by the id the builder's
// address carries. No draft is an answer, not a refusal.
interface WorkflowDraftReadRequest {
  workflowDraftId: string;
}
interface WorkflowDraftReadResponse {
  draft?: {
    workflowDraftId: string;
    definitionId?: WorkflowDefinitionId;
    basedOnVersionNumber?: number;
    document: WorkflowDocument;
    updatedAt: string;
  };
}

// WorkflowExpressionPreview — workflow.expressionPreview. An expression's value against the current item of
// the last run that executed the node, shown live under the field. Expressions are evaluated in the daemon
// only, on the same engine a run uses, with no time limit; the engine's cooperative yielding and
// cancellation stay. The preview never resolves a secret: a sensitive field previews the secret's name,
// never its value.
interface WorkflowExpressionPreviewRequest {
  // The unsaved draft the expression sits in, or the saved definition where the builder holds no edits.
  workflowDraftId?: string;
  definitionId?: WorkflowDefinitionId;
  nodeId: WorkflowNodeId;
  expression: string;
  itemIndex: number; // the item the inspector's data panels show
}
type WorkflowExpressionPreviewResponse =
  | { resolved: true; value: unknown }
  // Why it cannot resolve, in words the field shows in place of a value.
  | { resolved: false; reason: string };

// WorkflowVersionDiffRead — workflow.versionDiffRead. The structural difference between two versions,
// computed in the daemon over the hashed body only, so node positions never count as a change. The
// Versions panel's one-line count, the canvas highlight and the inspector's old and new params read it,
// and so does an agent reading what changed.
interface WorkflowVersionDiffReadRequest {
  fromWorkflowVersionId: string;
  toWorkflowVersionId: string;
}
interface WorkflowVersionDiffReadResponse {
  nodesAdded: WorkflowNodeId[];
  nodesRemoved: WorkflowNodeId[];
  nodesChanged: Array<{ nodeId: WorkflowNodeId; before: WorkflowNode; after: WorkflowNode }>;
  edgesAdded: WorkflowEdge[];
  edgesRemoved: WorkflowEdge[];
}

// WorkflowRunDelete — workflow.runDelete. Deletes one run's record, its steps and their data, and its
// capture folder with the run's snapshot points and their base pins; it is not undoable. A run that is
// `new`, `running` or `waiting` is refused with `workflow.run_not_deletable`, which reads "Cancel it
// first.", and nothing is deleted. The removal rides workflow.subscribe.
interface WorkflowRunDeleteRequest {
  workflowRunId: WorkflowRunId;
}
interface WorkflowRunDeleteResponse {
  workflowRunId: WorkflowRunId;
  deleted: true;
}

// WorkflowRunsDeletePreview — workflow.runsDeletePreview. What "Delete runs older than…" would remove,
// counted before it runs, so its confirm names it: how many runs go, and how many older runs stay
// because they are marked Keep or are `waiting`.
interface WorkflowRunsDeletePreviewRequest {
  olderThan: string; // RFC 3339 UTC
}
interface WorkflowRunsDeletePreviewResponse {
  deleteCount: number;
  keptCount: number;
  waitingCount: number;
}

// WorkflowRunsDelete — workflow.runsDelete. Deletes the runs older than the instant, each as
// workflow.runDelete deletes one; runs marked Keep and runs in `waiting` are untouched. The reply's count
// is the truth, since runs can change between the preview and the delete.
interface WorkflowRunsDeleteRequest {
  olderThan: string; // RFC 3339 UTC
}
interface WorkflowRunsDeleteResponse {
  deletedCount: number;
}

// WorkflowRunKeepSet — workflow.runKeepSet. Marks a run Keep, which `workflow.runsDelete` leaves
// untouched, or clears the mark. The change rides workflow.subscribe.
interface WorkflowRunKeepSetRequest {
  workflowRunId: WorkflowRunId;
  keep: boolean;
}
interface WorkflowRunKeepSetResponse {
  workflowRunId: WorkflowRunId;
  keep: boolean;
}

// WorkflowFixSessionCreate — workflow.fixSessionCreate. Opens a new session on a failed step's own project
// and checkout, seeded with the step's name, the input it ran on, the output it failed with, and a link to
// the step's session for reading. The step's own transcript receives nothing; the run keeps a link to the
// new session for its life, and Resume then reruns the step from its original input against the fixed
// checkout. It changes nothing about the run, so it is not an operator control like cancel and
// resume. A step that did not fail is refused with `workflow.invalid_transition`.
interface WorkflowFixSessionCreateRequest {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  executionIndex: number;
}
interface WorkflowFixSessionCreateResponse {
  sessionId: SessionId;
}

// WorkflowHumanFormRead — workflow.humanFormRead. A waiting form as the step panel draws it: the node's
// prompt, one field per entry of its input schema in the same param declarations the inspector renders,
// the draft saved so far with its revision, and the submit revision workflow.humanFormSubmit expects. A
// form read on a step no longer waiting is refused with `workflow.step_not_waiting`.
interface WorkflowHumanFormReadRequest {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
}
interface WorkflowHumanFormReadResponse {
  prompt: string;
  fields: WorkflowParamSpec[];
  draft?: { formState: Record<string, unknown>; revision: number; savedAt: string };
  formRevision: number;
}

// WorkflowRunAttentionList — workflow.runAttentionList. The runs that need someone, which stand above the
// runs table and outside its filters. The runs waiting on a person — an approval, a form, a chat reply, a
// chain's question — come oldest first, the order Next waiting walks them in. Above them sit the runs
// parked on a spent provider account, folded into one entry per attention key with the count of runs it
// holds, because the key is the account and never the run; nobody can answer those, so Next waiting never
// opens one. What it lists moves with workflow.subscribe's run notifications.
interface WorkflowRunAttentionListRequest {}
interface WorkflowRunAttentionListResponse {
  accountEntries: Array<{
    parkAttentionKey: string;
    parkCause: string;
    affectedRunCount: number;
    waitingSince: string; // the oldest of its runs
    resumeAt?: string;
  }>;
  personEntries: Array<{
    workflowRunId: WorkflowRunId;
    definitionName: string;
    waitCause: Exclude<WorkflowWaitCause, "account">;
    waitingSince: string;
  }>;
}

// WorkflowWebhookTokenRotate — workflow.webhookTokenRotate. Creates a workflow's webhook token, or replaces
// it. The token is in this reply and in no other: only its hash is kept, so a rotation makes the old token
// invalid from that moment, and while no token exists every call to the workflow's address is refused. A
// call whose token does not match the kept hash, compared in constant time, is refused with
// `workflow.webhook_token_mismatch`.
interface WorkflowWebhookTokenRotateRequest {
  definitionId: WorkflowDefinitionId;
}
interface WorkflowWebhookTokenRotateResponse {
  definitionId: WorkflowDefinitionId;
  token: string; // shown once
  createdAt: string;
}

// WorkflowWebhookListenerRead — workflow.webhookListenerRead. The daemon's loopback webhook listener: the
// one port every workflow's address uses, set in Settings, and whether it listens. It does not listen when
// the port was already held at daemon start; nothing moves to another port, and every webhook trigger
// shows that reason in place of its address.
interface WorkflowWebhookListenerReadRequest {}
interface WorkflowWebhookListenerReadResponse {
  port: number;
  listening: boolean;
}

// ---- Workflow secrets. A secret's value is sealed in the operating system's keychain (ADR-036) and is
// written to no document, step record, reply, event, log or error: `secretValue` is write-only and no read
// carries it. A secret's scope is `project` or `shared`, never a session. Its name is lowercase letters,
// digits and hyphens, starting with a letter or digit, at most 64 characters, and a sensitive param
// references it as `secret://<scope>/<name>`. A name that breaks that pattern, or that its scope already
// holds, is refused with `workflow.secret_name_invalid` (`reason: "pattern" | "taken"`). A keychain that is
// locked or unavailable refuses a write with `workflow.secret_store_unavailable`
// (`cause: "locked" | "unavailable"`). At step launch a secret the keychain does not hold fails the step
// with `workflow.secret_not_found`, carrying only the reference, and a locked or unavailable keychain fails
// it with `workflow.secret_store_unavailable`; either offers Retry from this step, and neither ever falls
// back to a plaintext value. ----
type WorkflowSecretScope = "project" | "shared";
interface WorkflowSecretSummary {
  secretId: string;
  scope: WorkflowSecretScope;
  scopeRef?: string; // the project's id at `project`; absent at `shared`
  name: string;
}

// WorkflowSecretList — workflow.secretList. The secrets a step's Credential chooser offers: this project's
// and the shared ones, by name — for a `shared` workflow's step, the shared ones only. Metadata only.
interface WorkflowSecretListRequest {
  scopeRef?: string; // the project whose secrets join the shared ones; omit for the shared ones alone
}
interface WorkflowSecretListResponse {
  secrets: WorkflowSecretSummary[];
}

// WorkflowSecretCreate — workflow.secretCreate. Seals a new secret's value in the keychain, then commits
// its record, so a record never names a value the keychain does not hold.
interface WorkflowSecretCreateRequest {
  scope: WorkflowSecretScope;
  scopeRef?: string; // the project's id at `project`; absent at `shared`
  name: string;
  secretValue: string;
}
type WorkflowSecretCreateResponse = WorkflowSecretSummary;

// WorkflowSecretReplace — workflow.secretReplace. Replaces a secret's value, sealed in the keychain before
// the record's change commits.
interface WorkflowSecretReplaceRequest {
  secretId: string;
  secretValue: string;
}
interface WorkflowSecretReplaceResponse {
  secretId: string;
}

// WorkflowSecretDelete — workflow.secretDelete. Removes the record and its keychain entry, recording the
// removal first so a crash between the two still finishes it. A version that still references the name
// fails its step with `workflow.secret_not_found`.
interface WorkflowSecretDeleteRequest {
  secretId: string;
}
interface WorkflowSecretDeleteResponse {
  secretId: string;
  deleted: true;
}

// WorkflowKeptVarsClear — workflow.keptVarsClear. Clears the values `Keep for later runs` kept for one
// workflow. Kept values belong to the workflow, not to a version: saving, restoring or duplicating a
// version leaves them, a duplicate starts with none, and deleting the workflow deletes them.
interface WorkflowKeptVarsClearRequest {
  workflowId: WorkflowDefinitionId;
}
interface WorkflowKeptVarsClearResponse {
  workflowId: WorkflowDefinitionId;
  clearedCount: number;
}

// ---- The durable workflow events ----
// The `workflow.*` types across the workflow families Spec-005 registers
// (§Workflow Lifecycle through §Workflow Gate Resolution). They ride the existing `EventEnvelope`
// and mint no second envelope schema: `causationId` carries the parent-event relationship, and the
// identity a type names — a run, one phase attempt, one step, or an armed trigger — rides the
// payload, which is what the four bases below are. The engine is the only emitter; the registry
// census is Spec-005's and is never restated here.
interface WorkflowRunEventPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
}
// workflow.created names a definition rather than a run — no run exists when a version is written —
// so it carries the definition and the version alone (Spec-005 §Workflow Lifecycle).
interface WorkflowCreatedPayload {
  sessionId: SessionId;
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
}
// One step attempt. Spec-015 §Event envelope and category split names the run id and the step run id
// as the identity fields a workflow payload carries:
// `stepRunId` is derived — BLAKE3 over the run, the node and the attempt number (Spec-015
// §Deterministic identity) — so a replay reproduces the same step-run identity rather than reading
// one off the payload.
interface WorkflowPhaseEventPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
  stepRunId: string;
}
// One execution of one node. The same four members `WorkflowStep` keys a step by, so a step
// event and the step row it belongs to are addressable by one identity.
interface WorkflowStepEventPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  attempt: number;
  executionIndex: number;
}
// Arming and firing happen before any run exists, so these carry the workflow and the trigger node
// instead of a run. `scheduledInstant` is present on the two fired types and absent on the armed
// ones: with the workflow and the node it is the occurrence's dedup key, which is what keeps a
// restart or a double-arm from firing the same occurrence twice.
interface WorkflowTriggerEventPayload {
  sessionId: SessionId;
  definitionId: WorkflowDefinitionId;
  nodeId: WorkflowNodeId;
  scheduledInstant?: string; // RFC 3339 UTC
}

// workflow.resumed — the structured resumption point Spec-015 §Cadence requires, so a reader
// reconstructs where the run picked up without replaying its whole history, plus the version pair on an
// accepted frozen-definition repair and only then: the same pair WorkflowRunResumeResponse carries, so
// the projected run row stays a function of the log (Spec-015 §Frozen-definition repair (SA-40)).
interface WorkflowResumedPayload extends WorkflowRunEventPayload {
  resumptionPoint: { activeStepRunIds: string[]; pendingGates: WorkflowNodeId[] };
  repinnedFromWorkflowVersionId?: string;
  repinnedToWorkflowVersionId?: string;
}
// workflow.canceled — appended in the same unit of work as the status write, so a projection
// rebuild cannot replay the last park and resurrect a canceled run. `reason` is the person's own
// and bounded exactly as a park cause is: 8 KiB, truncated on a UTF-8 boundary.
interface WorkflowCanceledPayload extends WorkflowRunEventPayload {
  reason: string;
}
// workflow.phase_failed — non-null exactly where a sibling branch's failure ended the run and
// so canceled this phase, rather than the phase failing on its own work.
interface WorkflowPhaseFailedPayload extends WorkflowPhaseEventPayload {
  cancellationReason: "sibling_failure" | null;
}
// workflow.phase_suspended — the park, in the same members the run read surfaces live on
// WorkflowStep: the reason, the bounded engine-authored cause, the durable resume instant
// where the park armed one, and the provider-account attention key where one was computed.
interface WorkflowPhaseSuspendedPayload extends WorkflowPhaseEventPayload {
  reason: "waiting-human" | "provider-usage-limited";
  parkCause: string;
  resumeAt?: string; // RFC 3339 UTC — absent narrows the park to one only the person resumes
  parkAttentionKey?: string;
}
// workflow.phase_waiting_on_pool — diagnostic, naming the resource pool whose capacity the phase is
// waiting on (Spec-015 §Execution semantics' named pools). It is emitted on entry to the blocked state
// and again at intervals while blocked, so `waitingSinceSeq` — the envelope sequence the wait began at —
// is what correlates the repeats back to one wait (Spec-015 §Cadence).
interface WorkflowPhaseWaitingOnPoolPayload extends WorkflowPhaseEventPayload {
  poolName: string;
  waitingSinceSeq: number;
}
// The step boundaries. A started event names the input it ran on, a finished event the output
// and log it produced plus its cost where a provider was billed, a failed event the error and the
// item index that failed, a canceled event the step alone, and a skipped event why it was skipped.
// A step's started event precedes its finished, failed or canceled event.
interface WorkflowStepStartedPayload extends WorkflowStepEventPayload {
  inputRef: WorkflowPayloadRef;
}
interface WorkflowStepFinishedPayload extends WorkflowStepEventPayload {
  outputRef: WorkflowPayloadRef;
  logRef: WorkflowPayloadRef;
  cost?: { costUsdMicros: number; providerAccountId: ProviderAccountId };
}
interface WorkflowStepFailedPayload extends WorkflowStepEventPayload {
  error: WorkflowStepError;
  failedItemIndex?: number;
}
type WorkflowStepCanceledPayload = WorkflowStepEventPayload;
interface WorkflowStepSkippedPayload extends WorkflowStepEventPayload {
  reason: "no-items" | "disabled";
}
// workflow.gate_resolved — the answer an approval took, in the same vocabulary
// WorkflowGateResolveRequest uses, on the step it answered or, for a chain's question, on the
// chain's first run. The gate's answer is a session event, and the answering device is recorded
// by its id; the event names the answer's row in workflow_gate_resolutions by that row's id.
interface WorkflowGateResolvedPayload extends WorkflowRunEventPayload {
  nodeId?: WorkflowNodeId; // the human.approval node answered; absent for a chain's question
  outcome: "approved" | "rejected";
  deviceId: DeviceId; // the answering device's id
  gateResolutionId: string; // the answer's row id in workflow_gate_resolutions
}
```

**Method-string registry — Plan-014** (daemon JSON-RPC; the `workflow` root, root plus camelCase tail per the Plan-013 convention above). Each row below has its shape above. Which of them the daemon serves is in [§Operations Not Yet Built](#operations-not-yet-built).

| Method | Procedure type | Request → Response | Notes |
| --- | --- | --- | --- |
| `workflow.definitionCreate` | `mutation` | `WorkflowDefinitionCreateRequest` → `WorkflowDefinitionCreateResponse` | Content-hashes and persists version 1; the daemon re-checks the whole document and refuses `workflow.definition_refused` with every finding |
| `workflow.definitionRead` | `query` | `WorkflowDefinitionReadRequest` → `WorkflowDefinitionReadResponse` | Latest version unless `version` is supplied; carries a webhook workflow's token dates and last fire, never the token |
| `workflow.definitionList` | `query` | `WorkflowDefinitionListRequest` → `WorkflowDefinitionListResponse` | Every saved workflow with the facts its catalog row shows, and the total; from a session, that session's resolved scope set, most-specific-first; with no session, every definition on this machine |
| `workflow.versionRead` | `query` | `WorkflowVersionReadRequest` → `WorkflowVersionReadResponse` | Immutable version body; a running instance stays pinned to its own |
| `workflow.runStart` | `mutation` | `WorkflowRunStartRequest` → `WorkflowRunStartResponse` | Binds a run to a pinned version, in the asking chat's session or the workflow's own; emits `workflow.started`; judges an agent's start and a trigger's fire under `workflow::start` and refuses `workflow.start_denied` (ADR-025) |
| `workflow.runRead` | `query` | `WorkflowRunReadRequest` → `WorkflowRunReadResponse` | Projection read; rebuildable from `session_events`. Carries the step array with each waiting step's cause, the chain's first run, whether the run's execution context was captured, the Keep mark and the fix session; the live park members ride each parked `WorkflowStep`, so a parked run renders from this one call (Spec-015 §Park surfacing on the read model) |
| `workflow.runCancel` | `mutation` | `WorkflowRunCancelRequest` → `WorkflowRunCancelResponse` | The named producer of the `canceled` run status; emits `workflow.canceled` in the same unit of work as the status write (I-014-22); refuses `workflow.run_not_cancelable` against a run that ended `succeeded`, `failed` or `crashed` (an already-`canceled` run replays idempotently) |
| `workflow.runResume` | `mutation` | `WorkflowRunResumeRequest` → `WorkflowRunResumeResponse` | The person's resumption of a parked run, carrying the optional explicit SA-40 re-pin as a request member rather than a method of its own; emits `workflow.resumed` (with the re-pin member on an accepted repair); refuses `workflow.resume_not_parked`, or one of the `workflow.repair_*` codes on the re-pin leg |
| `workflow.stepOutputList` | `query` | `WorkflowStepOutputListRequest` → `WorkflowStepOutputListResponse` | The agent and human steps' output summaries and artifact references, for the CLI and an SDK; one step's full input, output or log comes only from `workflow.stepRead`; a retry adds entries, never changes one (SA-16) |
| `workflow.gateResolve` | `mutation` | `WorkflowGateResolveRequest` → `WorkflowGateResolveResponse` | Answers an approval step, or a chain's question (`approved` keeps going, `rejected` stops them all); appends one `workflow_gate_resolutions` row; emits `workflow.gate_resolved`; refuses `workflow.step_not_waiting` on a step no longer waiting |
| `workflow.humanFormDraftSave` | `mutation` | `WorkflowHumanFormDraftSaveRequest` → `WorkflowHumanFormDraftSaveResponse` | Writes the daemon-held draft of a form step as it is typed; each save bumps the draft's own revision, and a stale one refuses `workflow.revision_stale` (SA-27) |
| `workflow.humanFormSubmit` | `mutation` | `WorkflowHumanFormSubmitRequest` → `WorkflowHumanFormSubmitResponse` | Optimistic-concurrency submit that resumes the run; refuses `workflow.revision_stale` or `workflow.step_not_waiting` |
| `workflow.definitionUpdate` | `mutation` | `WorkflowDefinitionUpdateRequest` → `WorkflowDefinitionUpdateResponse` | A new immutable version of an existing definition, optimistic on the expected version (`workflow.version_stale` when it is stale); an edit to a `shared` definition branches instead of touching the original |
| `workflow.definitionDelete` | `mutation` | `WorkflowDefinitionDeleteRequest` → `WorkflowDefinitionDeleteResponse` | Soft delete; the runs that pinned its versions stay readable, and the response states how many |
| `workflow.definitionExport` | `mutation` | `WorkflowDefinitionExportRequest` → `WorkflowDefinitionExportResponse` | Writes the canonical file form of one version, layout section and package locks included, to the file the platform's save dialog picked |
| `workflow.definitionImport` | `mutation` | `WorkflowDefinitionImportRequest` → `WorkflowDefinitionImportResponse` | Reads the file the platform's open dialog picked and submits it through the create path, all or nothing; refuses `workflow.import_schema_unknown` for an unknown schema version |
| `workflow.enabledSet` | `mutation` | `WorkflowEnabledSetRequest` → `WorkflowEnabledSetResponse` | Arms or disarms every trigger of one workflow; refuses `workflow.trigger_unarmable` where a trigger cannot arm |
| `workflow.runList` | `query` | `WorkflowRunListRequest` → `WorkflowRunListResponse` | The runs enumeration, with the filters the table narrows on, the version scope Show runs hands in, the total and paging |
| `workflow.versionChainRead` | `query` | `WorkflowVersionChainReadRequest` → `WorkflowVersionChainReadResponse` | The chain one run's pinned version belongs to, addressed by that version id |
| `workflow.stepRead` | `query` | `WorkflowStepReadRequest` → `WorkflowStepReadResponse` | One step's input, output or log by ref, paged and redacted |
| `workflow.runRetry` | `mutation` | `WorkflowRunRetryRequest` → `WorkflowRunRetryResponse` | Re-runs from a named step with the prior run's data pinned upstream; mints a new run in `retry` mode; refuses `workflow.retry_unavailable` or `workflow.invalid_transition` |
| `workflow.nodeExecute` | `mutation` | `WorkflowNodeExecuteRequest` → `WorkflowNodeExecuteResponse` | Executes one node, or it and its ancestors, against pinned or prior input; the daemon computes the filtered run |
| `workflow.resultsPost` | `mutation` | `WorkflowResultsPostRequest` → `WorkflowResultsPostResponse` | Posts a run's results into the session the verb was typed in, which the daemon checks is the caller's own; the agent's tool takes no session, the daemon deriving it from the invoking turn; refuses `workflow.invalid_transition` for an unfinished run |
| `workflow.subscribe` | `subscription` | `WorkflowSubscribeRequest` → `WorkflowSubscribeNotification` (stream) | The scheduler hold and its count first, then run, step, schedule and definition notifications and removals, for the runs table, the Workflows tab and the canvas overlay |
| `workflow.kindList` | `query` | `WorkflowKindListRequest` → `WorkflowKindListResponse` | The node catalog with its param specs, so the palette, the inspector and an agent read one list |
| `workflow.runsPauseSet` | `mutation` | `WorkflowRunsPauseSetRequest` → `WorkflowRunsPauseSetResponse` | The scheduler-wide hold on starting new runs; takes no run id and answers with how many starts are waiting |
| `workflow.layoutSet` | `mutation` | `WorkflowLayoutSetRequest` → `WorkflowLayoutSetResponse` | The canvas layout, saved beside the definition without a new version |
| `workflow.permissionLevelUpdate` | `mutation` | `WorkflowPermissionLevelUpdateRequest` → `WorkflowPermissionLevelUpdateResponse` | The workflow's own permission level, saved beside the definition without a new version |
| `workflow.pinDataSet` | `mutation` | `WorkflowPinDataSetRequest` → `WorkflowPinDataSetResponse` | Pins or unpins a node's test data without a new version; honored only in manual runs |
| `workflow.draftUpdate` | `mutation` | `WorkflowDraftUpdateRequest` → `WorkflowDraftUpdateResponse` | The builder's unsaved draft, held by the daemon so it survives a reload; the first call mints the draft's id |
| `workflow.draftRead` | `query` | `WorkflowDraftReadRequest` → `WorkflowDraftReadResponse` | The draft read back after a reload, by the id the builder's address carries |
| `workflow.expressionPreview` | `query` | `WorkflowExpressionPreviewRequest` → `WorkflowExpressionPreviewResponse` | An expression's value against the last run, evaluated in the daemon; never resolves a secret |
| `workflow.versionDiffRead` | `query` | `WorkflowVersionDiffReadRequest` → `WorkflowVersionDiffReadResponse` | The structural difference between two versions, over the hashed body only |
| `workflow.runDelete` | `mutation` | `WorkflowRunDeleteRequest` → `WorkflowRunDeleteResponse` | Deletes one run with its step data and snapshots; refuses `workflow.run_not_deletable` on a `new`, `running` or `waiting` run |
| `workflow.runsDeletePreview` | `query` | `WorkflowRunsDeletePreviewRequest` → `WorkflowRunsDeletePreviewResponse` | What "Delete runs older than…" would remove, counted before it runs |
| `workflow.runsDelete` | `mutation` | `WorkflowRunsDeleteRequest` → `WorkflowRunsDeleteResponse` | Deletes the runs older than an instant; runs marked Keep and runs in `waiting` are untouched |
| `workflow.runKeepSet` | `mutation` | `WorkflowRunKeepSetRequest` → `WorkflowRunKeepSetResponse` | Marks a run Keep, which deleting old runs leaves, or clears the mark |
| `workflow.fixSessionCreate` | `mutation` | `WorkflowFixSessionCreateRequest` → `WorkflowFixSessionCreateResponse` | Opens a fresh session to fix a failed step, which the run links to; refuses `workflow.invalid_transition` on a step that did not fail |
| `workflow.humanFormRead` | `query` | `WorkflowHumanFormReadRequest` → `WorkflowHumanFormReadResponse` | A waiting form: prompt, fields, the saved draft and the submit revision; refuses `workflow.step_not_waiting` |
| `workflow.runAttentionList` | `query` | `WorkflowRunAttentionListRequest` → `WorkflowRunAttentionListResponse` | The runs waiting on a person, oldest first, under the spent-account parks folded by attention key; no filter narrows it |
| `workflow.webhookTokenRotate` | `mutation` | `WorkflowWebhookTokenRotateRequest` → `WorkflowWebhookTokenRotateResponse` | Creates or rotates a workflow's webhook token, returned once; only its hash is kept, so the old token is refused from that moment |
| `workflow.webhookListenerRead` | `query` | `WorkflowWebhookListenerReadRequest` → `WorkflowWebhookListenerReadResponse` | The webhook listener's port and whether it listens |
| `workflow.secretList` | `query` | `WorkflowSecretListRequest` → `WorkflowSecretListResponse` | This project's secrets and the shared ones, by name, for a step's Credential chooser; never a value |
| `workflow.secretCreate` | `mutation` | `WorkflowSecretCreateRequest` → `WorkflowSecretCreateResponse` | Seals a new secret's value in the keychain under a scope and name; refuses `workflow.secret_name_invalid` or `workflow.secret_store_unavailable` |
| `workflow.secretReplace` | `mutation` | `WorkflowSecretReplaceRequest` → `WorkflowSecretReplaceResponse` | Replaces a secret's value in the keychain; refuses `workflow.secret_store_unavailable` |
| `workflow.secretDelete` | `mutation` | `WorkflowSecretDeleteRequest` → `WorkflowSecretDeleteResponse` | Deletes a secret's record and its keychain entry |
| `workflow.keptVarsClear` | `mutation` | `WorkflowKeptVarsClearRequest` → `WorkflowKeptVarsClearResponse` | Clears the values `Keep for later runs` kept for one workflow |

The canonical file form of a definition ([Spec-015 §Definition file form — export and import (C-17)](../../specs/015-workflow-authoring-and-execution.md#definition-file-form--export-and-import-c-17)) is a serialization of these same shapes — the file the authoring commitment names, carrying the schema-version marker, whose canonical bytes are the JCS-canonicalized JSON of the parsed document. It is not a second dialect and has no contract types of its own. `layout` is an optional top-level section of that document, outside the hashed body, and it is persisted in a column beside the definition body and carried by the file, so moving a node mints no version ([Spec-015 §Canvas layout is not definition bytes (SA-34)](../../specs/015-workflow-authoring-and-execution.md#canvas-layout-is-not-definition-bytes-sa-34)). Export and import are the operations above rather than client-side work over the create and version reads: the canonical bytes and their content hash belong to the store, a round trip in either direction must reproduce them exactly, and an import must run the create path's whole validation so it can carry no governance state. Both act on the file the person picked with the platform's own dialog: the renderer hands the daemon the dialog's `FilePathRef` token, main's relay turns it into the path, and the daemon alone reads or writes the file, so no path string and no file text crosses the bridge ([Spec-021 §Preload Bridge Contract](../../specs/021-desktop-app-and-renderer.md#preload-bridge-contract)). `workflow.definitionImport` submits through `workflow.definitionCreate`'s own path for that reason and adds no second parse.

Starting a workflow from chat likewise adds **no** method: the chat surfaces are client-surface sugar over `workflow.runStart` (ADR-025), and `workflow_run` below is a callback tool, not a JSON-RPC method.

The session's workflow callback tools (ADR-025; [Spec-015 §Interfaces And Contracts](../../specs/015-workflow-authoring-and-execution.md#interfaces-and-contracts); Plan-014 T5.8 / CP-014-7) are each a `SessionCallbackTool` of the §Plan-003 shape: a JSON-Schema input, a Cedar action, an approval category, and a `tool_activity` record on every invocation. They register into the Plan-003 callback-tool host registry at session spawn and every invocation routes through the CP-003-6 Cedar seam. Born-withheld: while the daemon's approval service is not running the whole registry is withheld at spawn and a stray invocation answers `denied` — never `completed` without Cedar. An agent's own tool allowlist decides which of them that agent holds.

| Tool | Adjudicated as |
| --- | --- |
| `workflow_kinds`, `workflow_list`, `workflow_read`, `workflow_runs`, `workflow_run_read`, `workflow_step_read`, `workflow_validate` | reads, gated on the session itself |
| `workflow_create`, `workflow_update`, `workflow_schedule_set`, `workflow_enable` (which takes the enabled flag, so it serves both the enable and the disable verb) | `Action::"workflow::author"` |
| `workflow_run`, `workflow_node_execute` | `Action::"workflow::start"` |
| `workflow_cancel` | `Action::"workflow::cancel"` |
| `workflow_resume` | `Action::"workflow::resume"` |
| `workflow_results_post` | `Action::"workflow::author"`, with the session derived from the invoking turn and never tool-supplied |

No tool in the set takes the session it acts on as an argument, per [Spec-010 §Interfaces And Contracts](../../specs/010-approvals-permissions-and-trust-boundaries.md#interfaces-and-contracts): the daemon derives it from the invoking turn's own context, validates the derived value, and refuses a smuggled one, so a forged target cannot be reached. `workflow_run` and `workflow_node_execute` take a definition by name and resolve it most-specific-first (session → project → shared), issuing the same start path as `workflow.runStart`; a Cedar denial answers `denied` carrying `workflow.start_denied`. None of these tools is a JSON-RPC method: the chat-start surface adds no registry row of its own.

Error vocabulary: [error-contracts.md](./error-contracts.md) §Workflow. Every refusal point on this surface carries a code of its own in the registry's `<root>.<noun>_<condition>` form, registered in its contract before the capability is implemented, and none ships unregistered ([Spec-015 §Loud-errors discipline (C-12)](../../specs/015-workflow-authoring-and-execution.md#loud-errors-discipline-c-12) forbids untyped refusals). A state refusal is 409, well-formed input the daemon cannot act on is 422, and findings ride the error as an extension list. The calls above refuse with: `workflow.not_found`; `workflow.gate_closed`; `workflow.start_denied` for a denied or unresolvable start; `workflow.run_not_cancelable` and `workflow.resume_not_parked` for cancel and resume; the [Spec-015 §Frozen-definition repair (SA-40)](../../specs/015-workflow-authoring-and-execution.md#frozen-definition-repair-sa-40) re-pin refusals `workflow.repair_not_parked`, `workflow.repair_attempt_in_flight` and `workflow.repair_version_unaccountable`; `workflow.definition_refused` (422), carrying `findings: [{rule, nodeIds, detail?}]` — the whole list the daemon's re-check finds, each `rule` from `WORKFLOW_DEFINITION_FINDING_RULES` in `packages/contracts/src/workflow-definition.ts`; `workflow.revision_stale` (409) for a stale form revision; `workflow.version_stale` (409) for a stale definition version; `workflow.step_not_waiting` (409) for a form submitted or read, or an approval answered, on a step no longer waiting; `workflow.retry_unavailable` (409, `reason: source_running`); `workflow.run_not_deletable` (409) on a `new`, `running` or `waiting` run; `workflow.invalid_transition` (409) for a run or step move its state does not allow, such as retrying a step that did not fail or posting results from an unfinished run; `workflow.trigger_unarmable` for a trigger that cannot arm; `workflow.import_schema_unknown` for an import whose schema version is unknown; and, on the secret verbs, `workflow.secret_name_invalid` (`reason: pattern | taken`) and `workflow.secret_store_unavailable` (`cause: locked | unavailable`). The webhook listener refuses a call whose token does not match with `workflow.webhook_token_mismatch`. A step that fails carries its code on its `error` and on the `workflow.step_failed` event, for the life of the run record: `workflow.code_over_budget`, `workflow.code_install_failed` (`reason: disk_space | tool_error`), `workflow.step_thread_failed` (`reason: out_of_memory | start_timeout | exited`), `workflow.sandbox_unavailable` (`provider: claude-code | codex`), `workflow.step_timed_out` (`cause: step_timeout | run_cap`), `workflow.secret_not_found` (carrying only the reference) and `workflow.secret_store_unavailable`. The park, pacing and cancelability rules mint no code of their own. Durable events owned by Plan-014: the `workflow.*` types across the workflow families enumerated in [Spec-015 §Event types (SA-19)](../../specs/015-workflow-authoring-and-execution.md#event-types-sa-19) and registered in the [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) census, whose categories that spec carries as its own sections; their typed payloads are the `Workflow*Payload` shapes above.

---

## Rate Limiting And Data Retention

### Spec-019 — Rate Limiting

Shapes below are canonical per [Plan-018](../../plans/018-rate-limiting-policy.md) (D-018-3/D-018-4/D-018-5). The relay counts requests on its sign-in routes only; code home is the control plane's `packages/control-plane/src/rate-limit/` for the limiter and its check types, and `packages/contracts/src/rate-limiter.ts` for the 429 envelope `RateLimitResponse` alone (Plan-018 Phase 1). Endpoint-group keys come from [Spec-019 §Canonical Endpoint Group Registry](../../specs/019-rate-limiting-policy.md#canonical-endpoint-group-registry).

```ts
// RateLimitCheck (internal operation, both backends). A counter error fails that one request like
// any backend error.
interface RateLimitCheckRequest {
  identity: string; // the caller's source address, canonical form (D-018-4): IPv4 exact dotted-quad / IPv6 normalized to its /64 prefix (D-018-5)
  endpoint: RateLimitEndpointGroup; // registry-key union (Spec-019 registry): the sign-in routes' one group
}
interface RateLimitCheckResponse {
  allowed: boolean;
  remaining: number;
  resetAt: string; // ISO 8601
  limit: number; // total threshold for this window
}
```

### Spec-020 — Data Retention, Export And Deletion

The data acts are daemon JSON-RPC verbs on the `daemon` root, registered by Plan-019 on Plan-005's `MethodRegistry`, with their params and result schemas in `packages/contracts/src/daemon-data.ts`: `daemon.dataExport {destination}` with `daemon.dataExportSubscribe` for its progress (`Export all data`), and `daemon.dataErase {}` (`Erase all data`) (§Operations Not Yet Built, `daemon.*`). They are daemon verbs rather than control-plane routes because the handlers read the daemon's own database and the machine's credential store, which a Cloudflare-Workers control plane cannot reach (Plan-019 D-019-1). A session's purge is `daemon.retentionPurge` (`Delete old data`). Deleting the hosted account is the control plane's `account.delete`, and `account.export` answers the export's `hosted-account.json` (§Operations Not Yet Built, `account.*`).

## Plan-022 — MCP Governance Contract Surfaces

Governed by [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md). The `mcp.*` operations register against the Plan-005 `MethodRegistry` when Plan-022 lands (the CP-005-2 late-namespace pattern; `mcp.subscribe` rides the Plan-005 streaming primitive, the `session.subscribe` consumer shape); the event payloads mirror [Spec-005 §MCP Governance (`mcp_governance`)](../../specs/005-session-event-taxonomy-and-audit-log.md#mcp-governance-mcp_governance) (registered into contracts by Plan-004 T1.9; payloads authored by Plan-022 — the emitter-authors-payload precedent); the status read model consumes the Plan-003 `McpServerStatusUpdate` seam (§Plans 003, 004 And 005 above). Authorization: every mutating operation is open to this machine's own client or any linked device, and no session, with no policy check and no ownership refusal — no `ApprovalCategory` value is added. Idempotency: every governance mutation — and the receipted operational commands `mcp.oauthLogin` and `mcp.oauthLogout` — carries the mandatory requester-generated UUID `clientIdempotencyKey` (the Spec-004/B3 discipline; the intervention-surface precedent) with durable receipt replay per Spec-024 §Authorization (`mcp.reconnect` is unreceipted). Error codes: [error-contracts.md §MCP Governance](./error-contracts.md#mcp-governance). Sanitization: no payload below carries config values, env-var values, header values, tokens, or unsanitized paths (Plan-022 I-022-1: credential custody is exactly what ADR-038 records) — raw `scopeRef` filesystem paths included: durable event payloads identify a binding by the path-free audit ref (`McpServerBindingAuditRef` below), never the path itself; `serverName` / `toolName` are untrusted provider-adjacent strings, `wireFreeFormString`-bounded under the trust-boundary header's free-form-string rule, classified as non-PII infrastructure identifiers per Spec-024 §Status Observation and Events. Identity throughout is the scope-qualified binding `(provider, scope, scopeRef, serverName)` per Spec-024 §Unified Inventory — a **discriminated union on `scope`**, so an invalid shape (`scopeRef` on `user`, or a missing `scopeRef` on `project`/`local`) is a schema-level rejection, never a service-layer surprise or a collapsed primary key. Every scope exists on both providers: Codex has no private per-project layer, so its `local` scope is the daemon's emulation described with the operations below. Two grains share this section deliberately: the config **binding** above and the Plan-003 **runtime-binding leg** (`sessionId` + `bindingId`) — live per-session state (status legs, live mutation results, reconnect targets) always keys by leg, never by collapsing legs into the binding scalar.

```ts
// ---- Primitives (Spec-024) ----
type McpProvider = "claude" | "codex";
type McpConfigScope = "user" | "project" | "local"; // scope axis of the binding identity, writable on both providers: user = the provider's own user configuration, every project on this machine; project = the project's own file, saved with the repository (Claude Code's `<project>/.mcp.json`, Codex's `<project>/.codex/config.toml`); local = this project on this machine only (Claude Code's per-project entry in its user configuration; on Codex, which has no such layer, a user entry kept switched off and switched on per conversation in that project's sessions). Scope-applicability is PER OPERATION (see the operations block)
type McpApplicationGrade = "live_reconcile" | "user_config_write" | "next_run" | "daemon_enforced"; // when/where a mutation takes effect — honest, typed, never silent (parity-triad degrade-honestly): live session set / provider config store (subsequent runs) / next-run composed config / daemon decision layer (immediate)
type McpApprovalMode = "auto" | "prompt" | "writes" | "approve"; // Codex-native vocabulary adopted as the normalized set; Claude-side enforcement is daemon-owned (Spec-024 §Tool-Level Overrides)

// The scope-qualified server binding (Spec-024 §Unified Inventory): identity is
// (provider, scope, scopeRef, serverName) — never merged across providers OR scopes. Same-named
// servers in two scopes are distinct configurations with independent status and overrides;
// collapsing them would bleed overrides across configurations.
// Structural validity is schema-level (a Zod discriminated union on `scope`), not service-layer:
// `user` FORBIDS scopeRef (persisted as '' in the daemon tables), and `project`/`local` REQUIRE a
// canonical non-empty scopeRef (the project root), so unrelated projects can never collapse onto one
// empty-string PK component. Payload/read-model types compose this union via intersection (never
// `interface extends` — unions don't extend).
type McpServerBindingRef =
  | { provider: McpProvider; scope: "user"; serverName: string }
  | { provider: McpProvider; scope: "project"; scopeRef: string; serverName: string }
  | { provider: McpProvider; scope: "local"; scopeRef: string; serverName: string };

// Event-side binding identity (Spec-024 §Status Observation and Events): path-free. scopeRef
// (canonical project root / keying directory) is a user-specific filesystem path — a Spec-020
// durable-tier PII class — and event payloads are durable and replayable, so the raw path never
// enters them: an event names the provider, the scope and the server, and nothing else.
// Requests and inventory reads keep the full McpServerBindingRef (transient wire / the person's read,
// not durable audit rows).
interface McpServerBindingAuditRef {
  provider: McpProvider;
  scope: McpConfigScope;
  serverName: string;
}

// Effective-binding derivation output (Plan-022 T28.4.5). NOT a carrier threaded in from another plan — Plan-022 derives this
// in-plan from the session sets it builds (T28.3.3, T28.3.8). `null` is a first-class answer meaning the tool
// resolved from NO governed binding: a provider built-in, or a tool served by the daemon's own
// ephemeral callback-tool host (Spec-004 §Required Behavior), which sits outside Spec-024 governance
// entirely (Spec-024 §Non-Goals) and is never override-governed.
// NEVER derived by parsing the delivered wire tool name: provider-side `mcp__<server>__<tool>`
// prefixing and collision-suffixing are provider defaults rather than wire invariants, so the
// mapping runs off the daemon's own registration identity.
type McpEffectiveBinding = McpServerBindingRef | null;

// mcp.upsertServer config input — the normalized governed surface, discriminated on transport.
// Env-var and header VALUES are write-only credential-adjacent material: accepted here, passed only
// to the sanctioned provider write path, NEVER round-tripped in inventory reads or event payloads
// (names may appear; values never do). Provider-conditional validation is schema-enforced (Zod
// refinements), not prose: a field marked Codex-only rejects for provider "claude" and vice versa,
// so the canonical request schema and SDK signature derive from this union without divergence.
// EVERY SCOPE TAKES WHAT THE PERSON TYPES: at `project` scope the values are written into the
// project's file in that provider's own format, as at the other scopes. A declaration may name a
// variable in place of a value — a Claude Code `env` or `headers` value written as a `${VAR}` or
// `${VAR:-default}` reference, a Codex server naming its variables through `envVars`,
// `envHttpHeaders` and `bearerTokenEnvVar`. On Claude Code the daemon expands the references from the
// session's own start environment before it sends the server set, holding the expanded value only
// for that call and never storing or logging it.
// PRESERVATION RULE (Spec-024 §Configuration Mutation): upserts are read-modify-write over the
// provider's own declaration — provider fields this union does not model (or the request does not
// carry) are preserved, never erased. Codex `user` writes are field-granular `config/value/write`
// paths, a Codex `project` write is a format-preserving edit that keeps the file's comments and
// layout, and the regenerated Claude declaration starts from the observed current one.
type McpServerConfigInput =
  | {
      transport: "stdio";
      command: string; // executable; non-empty, NUL-rejected
      args?: string[];
      env?: Record<string, string>; // write-only values (see above)
      envVars?: string[]; // Codex-only `env_vars` — variable NAMES the server inherits from the environment Codex starts in
      enabled?: boolean; // Codex: native `enabled` field; Claude: maps to the daemon enabled overlay
      required?: boolean; // Codex-only — thread start/resume fails if the server cannot initialize
      startupTimeoutSec?: number; // Codex-only native timeout
      toolTimeoutSec?: number; // Codex-only native timeout
    }
  | {
      transport: "http" | "sse"; // "sse" is Claude-only (Claude-native transport kind)
      url: string; // absolute http(s) URL, taken as typed and passed to the provider write path as typed, a user name or password in it included. That user name and password and the query-string VALUES are write-only credential-equivalent material: accepted, passed on — never round-tripped (the view serves query param NAMES)
      headers?: Record<string, string>; // write-only values (see above)
      bearerTokenEnvVar?: string; // Codex-only `bearer_token_env_var` — the env-var NAME, never the value
      envHttpHeaders?: Record<string, string>; // Codex-only `env_http_headers` — header NAME → env-var NAME (both references, no values; resolved provider-side at connect time)
      oauthScopes?: string[]; // Codex-only `scopes` — OAuth scopes requested for the server's auth flow
      oauthResource?: string; // Codex-only `oauth_resource` — the RFC 8707 resource indicator for the flow
      enabled?: boolean;
      required?: boolean; // Codex-only (as above)
      startupTimeoutSec?: number; // Codex-only (as above)
      toolTimeoutSec?: number; // Codex-only (as above)
    };

// Redacted normalized config view (Spec-024 §Unified Inventory): the read-back of what
// mcp.upsertServer wrote — every non-secret field preserved, secret VALUES structurally absent
// (env/header/query-param NAMES only), so mcp.get supports read/edit workflows without the daemon
// ever serving credential material. command/args are process-visible strings the person authors —
// the same documented residual class as serverName/toolName in the preamble; the URL is NOT in that
// class (an http URL is not a process argument): it serves query-redacted below.
type McpServerConfigView =
  | {
      transport: "stdio";
      command: string;
      args?: string[];
      envVarNames?: string[]; // the env map's KEYS; values never round-trip
      enabled?: boolean;
      required?: boolean; // Codex-only, as on input
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    }
  | {
      transport: "http" | "sse";
      url: string; // QUERY-REDACTED: scheme + host + path only (a user name or password, like the query values, is credential-equivalent and never round-trips)
      urlQueryParamNames?: string[]; // the query string's parameter NAMES when one existed; values never round-trip (the env/header names-not-values discipline)
      headerNames?: string[]; // the header map's KEYS; values never round-trip
      bearerTokenEnvVar?: string; // an env-var NAME (Codex-only), safe to serve
      envHttpHeaders?: Record<string, string>; // Codex-only — header NAME → env-var NAME: a name→name reference map, round-trips verbatim
      oauthScopes?: string[]; // Codex-only — non-secret auth references, round-trip verbatim
      oauthResource?: string; // Codex-only — non-secret auth reference, round-trips verbatim
      enabled?: boolean;
      required?: boolean;
      startupTimeoutSec?: number;
      toolTimeoutSec?: number;
    };

// Per-leg live status (Spec-024 §Unified Inventory): one config binding can back several concurrent
// sessions' connections; the Plan-003 seam keys observations by runtime-binding leg, and the
// inventory preserves that grain instead of overwriting divergent leg states into one scalar.
interface McpServerLegStatus {
  sessionId: SessionId;
  bindingId: string; // the Plan-003 runtime-binding leg key (§Plans 003, 004 And 005 McpServerStatusUpdate) — NOT this section's config binding
  status: McpServerStatus;
  observedAt?: string; // ISO-8601 of this leg's newest observation
}

// Inventory read model (mcp.list / mcp.get): four merged sources per binding — provider-declared
// config, live status (McpServerStatus, §Plans 003, 004 And 005 seam), the binding row, the override
// rows. A DISCRIMINATED PAIR on bindingStoreUnavailable (Spec-024 §Fallback Behavior): the normal arm serves
// all four sources; the degraded arm (binding store unreachable) serves the provider-observed sources
// only, with every store-dependent field STRUCTURALLY ABSENT rather than fabricated (toolOverrides and
// the Claude enabled overlay live in the unreachable store).
// All mutations fail closed while degraded.
type McpServerInventoryEntry = McpServerBindingRef & {
  config: McpServerConfigView; // the redacted normalized declaration (see above)
  status: McpServerStatus; // deterministic aggregate over legs[]: most severe current live-leg status (failed > needs-auth > unknown > starting > connected — a live leg whose observation source is lost reports "unknown": lost observability outranks known-healthy states, never a concrete failure), else newest node-probe observation, else "unknown" — never fabricated
  failedReason?: "commandNotRunnable"; // present only on an entry reading "failed" because, after the background service moved between Windows and a WSL distribution, its command or arguments name a program on the side it left; a bare command name such as npx is looked up on the new side and is not marked. One member on the entry, not a status of its own
  legs?: McpServerLegStatus[]; // per-leg session-feed observations; absent when no live leg exists. Legs are LIVE-session observations with a bounded lifecycle: when a leg's backing runtime binding closes (session end / driver exit), the daemon retires it and recomputes the aggregate — a terminated session's last status never pins `status`
  observedAt?: string; // ISO-8601 of the newest status observation backing `status`
  requiredServer?: boolean; // Codex `required = true` — thread start/resume fails if the server cannot initialize
} & (
    | {
        bindingStoreUnavailable?: never; // the normal (binding-store-available) arm
        enabled: boolean; // provider-declared enabled state composed with the daemon's Claude enabled overlay (the overlay lives on the binding row)
        toolOverrides: McpToolOverride[];
      }
    | {
        bindingStoreUnavailable: true; // degraded read: binding store unreachable — mutations fail closed (Spec-024 §Fallback Behavior)
        enabled?: boolean; // the provider-native enabled field only (Codex); ABSENT for Claude bindings — the daemon enabled overlay lives in the unreachable store, and a fabricated value would be a lie
      }
  );

// At least one facet is REQUIRED — a toolName-only override is meaningless and the canonical DDL
// rejects the all-NULL row, so the Zod mirror refines "enabled, approvalMode, or idempotencyClass
// present" and a facet-less request dies as a typed validation error, never a constraint failure.
interface McpToolOverride {
  toolName: string;
  enabled?: boolean; // absent = inherit provider config (for Codex-materialized facets, "provider config" means the preserved native baseline — a clear restores it; Spec-024 §Tool-Level Overrides)
  approvalMode?: McpApprovalMode; // absent = provider default
  idempotencyClass?: "idempotent" | "compensable"; // absent = the Spec-004 §Tool Metadata manual_reconcile_only floor
}

// Per-facet application grades for override mutations (Spec-024 §Tool-Level Overrides): Codex
// enabled/approvalMode materialize into native config fields (user_config_write) in the file that
// holds the binding — the user file for `user` and `local` bindings (an emulated local binding is a
// user entry), the project's `.codex/config.toml` for a `project` binding; Claude enforces all of
// them at the daemon approval/resolution layer (daemon_enforced, immediate).
// Present keys mirror the facets the request touched (or reverted, on clear).
interface McpToolOverrideApplication {
  enabled?: McpApplicationGrade;
  approvalMode?: McpApplicationGrade;
  idempotencyClass?: "daemon_enforced";
}

// Per-leg live-application outcome (Spec-024 §Configuration Mutation — partial outcomes are typed,
// never masked): a durable-success/live-failure mutation is a SUCCESSFUL response reporting the
// durable grade plus the failing legs — never a post-commit JSON-RPC error inviting an unsafe retry,
// and never a blanket success hiding a live failure.
interface McpLiveApplicationResult {
  sessionId: SessionId;
  bindingId: string; // the Plan-003 runtime-binding leg key
  outcome: "applied" | "failed";
  errorCode?: string; // mcp.* code for a failed leg (e.g. a per-server setMcpServers error)
  detail?: string; // sanitized — never config values or unsanitized paths
}

// ---- Operations (12; JSON-RPC per ADR-009) ----
// Reads:
//   mcp.list      {refresh?: boolean} → {servers: McpServerInventoryEntry[]}
//   mcp.get       McpServerBindingRef → {server: McpServerInventoryEntry}
//   mcp.subscribe {} → AsyncIterable<EventEnvelope> // live-tail of every mcp_governance envelope as appended (sentinel- and session-bound alike; Plan-005 streaming primitive, session.subscribe consumer shape). Gap-free by ORDERING, not by cursor: a (re)connecting client opens mcp.subscribe FIRST, then reads mcp.list — the subscribe acknowledgment precedes the stream's first delivery (the Plan-005 I-005-9 wire-ordering invariant), so registration is live before the snapshot read and an event concurrent with the snapshot arrives on the stream instead of falling between snapshot and subscription (re-observation is harmless — governance envelopes are re-entrant state updates; omission is impossible). History remains the sentinel session's log (Spec-024 §Status Observation and Events)
//   mcp.registrySearch {query: string, cursor?: string} → {servers: McpRegistryServer[], nextCursor?: string} // `Browse servers`: a search of the public MCP Registry (`GET /v0/servers?search=<query>&version=latest` on registry.modelcontextprotocol.io), made by the daemon only when the person types and caching nothing past the page. Each result carries its title or name, description and version, whether it runs as a package (its `runtimeHint` and `runtimeArguments`) or at an address (its `remotes`), and each environment variable's name, description and whether it is required — never a value. A pick fills the add form; the person still adds the server and types every secret
// Non-reads (open to this machine's own client or any linked device, with no policy check; every
// operation except mcp.reconnect carries the MANDATORY clientIdempotencyKey: string —
// requester-generated UUID, durable receipt replay on a retry under the same key, Spec-024
// §Authorization). The governance mutations below finalize their receipt with their store writes and
// emit no governance event; mcp.oauthLogin, mcp.oauthLogout and mcp.reconnect are operational
// commands — oauthLogin is receipted but its durable trace
// is the asynchronous mcp.server_oauth_completed, emitted exactly once per completed sign-in (an
// abandoned sign-in, or one ended by a newer attempt, leaves only its expiring receipt); oauthLogout is receipted and, like
// reconnect, audits through the status transitions it induces; reconnect is unreceipted:
//   mcp.upsertServer      McpServerBindingRef & {clientIdempotencyKey: string, config: McpServerConfigInput} → {server: McpServerInventoryEntry, applied: McpApplicationGrade, liveResults?: McpLiveApplicationResult[]}
//   mcp.removeServer      McpServerBindingRef & {clientIdempotencyKey: string} → {applied: McpApplicationGrade, liveResults?: McpLiveApplicationResult[]} // removing an emulated Codex local server also removes the daemon's row for it; removing any server removes every approval rule over its tools from the provider's file that holds it, in the same transaction
//   mcp.setEnabled        McpServerBindingRef & {clientIdempotencyKey: string, enabled: boolean} → {server: McpServerInventoryEntry, applied: McpApplicationGrade, liveResults?: McpLiveApplicationResult[]}
//   mcp.setToolOverride   McpServerBindingRef & {clientIdempotencyKey: string, override: McpToolOverride} → {server: McpServerInventoryEntry, applied: McpToolOverrideApplication}
//   mcp.clearToolOverride McpServerBindingRef & {clientIdempotencyKey: string, toolName: string} → {server: McpServerInventoryEntry, applied: McpToolOverrideApplication} // grades cover the cleared facets' reversion path
//   mcp.oauthLogin        McpServerBindingRef & {clientIdempotencyKey: string} → {authorizationUrl?: string} // starts the daemon's own sign-in for that server, whatever kind of server it is, and returns the address of the sign-in page for the client to open; a new mcp.oauthLogin on a server whose sign-in is still waiting ends that wait and starts the next attempt; mcp.oauth_flow_failed is LAUNCH-phase only — a failure to start the sign-in (discovery, registration, or the provider's own flow in its throwaway home) — and an async completion failure arrives as mcp.server_oauth_completed outcome: 'failure' on the mcp.subscribe stream, never a late JSON-RPC error (Spec-024 §OAuth Orchestration). Its idempotency receipt persists the acknowledgment with authorizationUrl STRUCTURALLY OMITTED (single-use PKCE-bearing launch material is never durable — Plan-022 I-022-1), so an identical-key retry replays a URL-free acknowledgment: the sign-in already started, completion arrives as the event, and a caller that never received the URL starts a new sign-in under a fresh key
//   mcp.oauthLogout       {serverId: string, clientIdempotencyKey: string} → {servers: McpServerInventoryEntry[]} // `Sign out of this server`. `serverId` is the server's address, not a scope-qualified binding: the daemon holds one sign-in per server, used by both providers and every binding that names it, so the reply lists each of those bindings after the sign-out. It deletes the daemon's refresh token for the server, and its signing key where the server demands proof-of-possession tokens, and ends the access tokens it handed out, so each provider's next call to that server carries no token and the server reads needs-auth in every session on both providers until the next sign-in
//   mcp.reconnect         McpServerBindingRef & {sessionId?: SessionId, bindingId?: string} → {legs: McpServerLegStatus[]} // operational: restarts the binding's live provider leg(s), LEG-ADDRESSABLE — exactly one leg when bindingId is given (with sessionId, both must name the same leg), every live leg of one session when only sessionId is given, every live leg otherwise; per-leg post-reconnect statuses, honest per leg
// Session operations (Spec-024 §A session's own tool servers), in the session.* namespace; none emits a governance event:
// `serverName` is the server's name in the session's own list, the name both providers start the session's servers by; it is not the address `mcp.oauthLogout` takes, and a server run as a local command has none.
//   session.mcpServerList   {sessionId} → a live list of the servers the session was started with, each row the server's name, binding, status with its reason, whether it is on for the session, and whether a switch waits for the next turn — names and statuses only, never a config value
//   session.mcpServerUpdate {sessionId, serverName, enabled} // narrows only: off stops the session offering that server's tools; kept with the session, applied at the next turn and sent again after each resume; a new session starts with every server on
//   session.mcpResourceList {sessionId, serverName} → {serverName, resources, complete} // what a working server offers, for the composer's attachment row; refused for a server that is off or not working
// Scope applicability is per operation (Spec-024 §Configuration Mutation), never a blanket rule.
// Provider-config writes (upsertServer/removeServer/setEnabled) accept every scope on both providers:
// Claude Code writes through `claude mcp add-json <name> <json> --scope <scope>` (a `project` write run from the
// project root, landing in `<project>/.mcp.json`; `local` in Claude Code's per-project entry of its
// user configuration); Codex `user` writes through `config/value/write`; Codex `project` is a
// format-preserving edit of `<project>/.codex/config.toml` written to a temporary file and renamed
// into place only while the file still hashes to what the daemon last read (else
// mcp.config_write_conflict), then read back with `config/read` and reloaded with
// `config/mcpServer/reload`; Codex `local` is emulated as a user entry with `enabled = false`,
// switched on per conversation in each session of that project, its name unique across the user
// file (a clash is refused, naming the project that holds the other one).
// Overrides, oauthLogin and reconnect apply to any binding, and oauthLogout to any server.
// One mcp.registrySearch result, read from the registry's own record. Untrusted data: it fills the add
// form and nothing else, and no value of any environment variable is ever part of it.
interface McpRegistryServer {
  name: string;
  title?: string;
  description: string;
  version: string;
  packages?: Array<{
    registryType: string;
    identifier: string;
    runtimeHint?: string;
    runtimeArguments?: Array<Record<string, unknown>>;
  }>; // runs as a package
  remotes?: Array<{ type: string; url: string }>; // reached at an address
  environmentVariables: Array<{ name: string; description?: string; isRequired: boolean }>;
}

// ---- Event payload mirrors (Spec-005 §MCP Governance) ----
// Every payload embeds the PATH-FREE binding identity via intersection with
// McpServerBindingAuditRef (provider, scope, serverName) — never the raw scopeRef (see the
// audit-ref comment above): these payloads are
// durable rows, and Spec-024 forbids filesystem paths in them.
type McpServerStatusChangedPayload = McpServerBindingAuditRef & {
  previousStatus: McpServerStatus;
  status: McpServerStatus;
  failureReason?: string; // sanitized
  origin: "session_feed" | "node_probe"; // mirrors the per-event session binding: real sessionId on session_feed rows, the daemon-scope sentinel on node_probe rows
  bindingId?: string; // REQUIRED for origin "session_feed" — the Plan-003 runtime-binding leg key (opaque daemon-minted id), attributing the transition to its legs[] entry when one binding backs several legs in the same session; ABSENT for "node_probe" (no leg observed). The Zod mirror enforces the conditionality as a refinement
};
type McpServerOauthCompletedPayload = McpServerBindingAuditRef & {
  outcome: "success" | "failure"; // 'failure' IS the asynchronous completion-failure channel (Spec-024 §OAuth Orchestration — launch failures are errors, completion failures are events)
  failureReason?: string; // sanitized — never tokens, authorization codes, or URLs with embedded secrets
  initiatingSessionId?: SessionId;
};
```

## Plan-023 — Provider Accounts And Credential Homes

Wire surfaces for [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md). The `providerAccount.*` namespace administers this machine's provider accounts: this machine's own client or any linked device may call every verb, and no session may (I-023-1).

Each of the namespace's verbs carries the payload pair named below: the reads `providerAccount.list`, `providerAccount.subscribe` and `providerAccount.usageRead`, and the mutating verbs `providerAccount.register`, `providerAccount.update`, `providerAccount.remove`, `providerAccount.setCurrent`, `providerAccount.probe`, `providerAccount.resetCredentialHome`, `providerAccount.login`, `providerAccount.loginCancel` and `providerAccount.memoryImport`. `providerAccount.subscribe` and `providerAccount.usageRead` are grouped with the reads: they mutate nothing and take the same device gate `providerAccount.list` does, for the same disclosure reason. `providerAccount.probe` is grouped with the mutating verbs for two reasons, and the weaker one is the row write: it writes back the observed health state and its observation timestamp to the probed account's row, and — **atomically with that write** — applies I-023-2's generation rule, which names "a transition of the account's probe result into or out of `authenticated`" as a lifecycle transition. So a probe that observes the same authenticated-ness as the stored row leaves `credentialGeneration` untouched, while one that observes a **crossing** of the authenticated boundary bumps it in the same transaction as the health write. Both directions bump: a repaired credential must end the old attention epoch ([Spec-015 §Provider-limit pacing and durable resumption (SA-39)](../../specs/015-workflow-authoring-and-execution.md#provider-limit-pacing-and-durable-resumption-sa-39) keys on `(accountId, credentialGeneration)`, so parked work resumes against a generation that is genuinely new), and a destroyed one must not leave consumers holding a generation that still reads as usable. The verb mints and removes no account. The load-bearing reason for the gate is that it reaches into a credential home and drives provider-side credential I/O. That is account-administration work, so it takes the device gate — this machine's own client or any linked device, and no session — rather than the laxer read gate.

**The probe verb is not the only writer of the stored pair.** Every validation that actually observes an account's authentication state writes it back under the same rule — the deliberate probe above, the registration-time status invocation (Spec-025 §Non-interactive token registration), and the **background health observer** (Spec-025 §Credential-home health observation), which is the third writer and joins the set rather than replacing it. **The generation-bump authority is deliberately NOT widened with it.** `credentialGeneration` still bumps only on I-023-2's credential-home lifecycle transitions, and a background observation is not one: [Spec-015 §Provider-limit pacing and durable resumption (SA-39)](../../specs/015-workflow-authoring-and-execution.md#provider-limit-pacing-and-durable-resumption-sa-39) keys parked work on `(accountId, credentialGeneration)`, so an observer that bumped on a transient fault would end a parked-work attention epoch for nothing — the precise harm the both-directions bump rule above exists to produce **only** when the boundary is genuinely crossed by an act that changed the home. The observer is constrained in what the DAEMON may do to take its reading, not in what the provider may do inside its own home: the daemon never reads, writes or copies credential material, never speaks a provider token endpoint itself, and never puts a provider into external-authentication mode. What it does is ask a provider its own limits question inside that provider's own per-account home, which on one pinned leg renews that login as a side effect — the provider's own rotation, taken by the provider, under the provider's own re-read-before-refresh guard. That is the keep-alive, and it is safe only because the home is daemon-owned and is never the person's own; a renewal of that kind is NOT a credential-home lifecycle transition and moves no `credentialGeneration`. Anything else would make the stored reading a record of _explicit probes_ rather than of _the last validation_, which is what the readiness derivation reads and what `observedAt` claims, and the row records observations.

**The identifier is opaque everywhere.** `ProviderAccountId` is daemon-minted and immutable. No client, driver, or renderer parses it, decomposes it, or uses it to locate credential material — it selects a credential environment and nothing else. It is deliberately not derived from an email, a provider subject id, or any credential value, because those rotate and an identity that rotates cannot key historical spend.

```ts
type ProviderAccountId = string & { readonly __brand: "ProviderAccountId" };
type BillingMode = "subscription" | "metered" | "unknown"; // `unknown` is the honest-absence arm (Spec-025 §Billing mode) — never rendered as metered

interface ProviderAccount {
  accountId: ProviderAccountId;
  provider: "claude" | "codex";
  credentialGeneration: number; // monotonic; bumps at every credential-home lifecycle transition (I-023-2)
  billingMode: BillingMode;
  // Provider-REPORTED identity, present only where a health observation surfaced it, each member
  // independently optional because a provider may report any subset. User-adjacent PII
  // (Spec-020 §PII Data Map, `provider_accounts` row): a later observation replaces these, and they
  // are never logged, evented, or carried on an error. THIS IS THE WHOLE IDENTITY OF AN ACCOUNT the
  // provider names: the address, the plan as the provider itself names it, and the organization where
  // the plan has one. One email can hold two accounts on different plans, which is why the plan and
  // the organization are part of the identity rather than decoration around a name someone invented.
  observedAccountEmail?: string;
  observedAccountPlan?: string; // the provider's own word for the plan, carried verbatim and never mapped onto a vocabulary of ours; distinct from `billingMode`, which says how the account is paid for rather than which plan it is on
  observedAccountOrgId?: string;
  observedAccountOrgName?: string;
  // Present only on an account added by a pasted token or API key, which the provider names nowhere:
  // the name the person gave it, required at that registration, different from that provider's other
  // account names, and renamed through `providerAccount.update`. No other account carries a typed name.
  displayLabel?: string;
  isDefault: boolean; // exactly one per provider, enforced by a partial unique index (I-023-5); the provider's CURRENT account, which `providerAccount.setCurrent` moves
  healthState: ProviderAccountHealthState;
  // The OTHER HALF of the stored observation pair (`provider_accounts.health_observed_at`, whose
  // table-level CHECK holds the two set and cleared together). Required-shape and nullable on the
  // reading the four members below take: `null` means no observation has ever been recorded for this
  // account. That is exactly the case a bare `healthState` cannot express — a never-observed account
  // and a probe that genuinely could not decide both project `indeterminate`, and only the timestamp
  // separates them: `null` for the first, a time for the second. It rides the ACCOUNT ROW rather than
  // only `ProviderReadiness.observedAt` because readiness is derived per PROVIDER from the resolved
  // account, so every non-default account in a list reply — and every `account_changed` notification,
  // which carries this shape — would otherwise carry a state with no age at all and no surface could
  // apply the freshness test the stored reading exists to support. Carried VERBATIM from the column,
  // never re-derived and never defaulted to `updated_at`: a registry read still spawns no provider
  // process, and an edit to a billing mode must not read as a fresh authentication observation.
  healthObservedAt: string | null;
  // The window-start switch sits UNDER `probeEnabled` rather than beside it: on by default, and
  // inert while `probeEnabled` is false, so an account silenced for the observer spends nothing at a
  // window's reset either. It is its own durable value because the two are separately settable in
  // the direction that matters — the person may keep the limits read running and still decline to
  // spend a turn at every reset (Spec-025 §Credential-home health observation).
  windowStartEnabled: boolean;
  // The four members below are nullable-by-absence rather than defaulted: an unobserved fact is
  // reported as unobserved, never as a value the daemon has not seen. They are required-shape
  // rather than additive-optional, the same reading the readiness member takes.
  observedAuthMode: ProviderAuthMode | null; // = `provider_accounts.observed_auth_mode`; null until observed
  loggedInAt: string | null; // RFC 3339 UTC of the sign-in this credential came from; null where neither a brokered sign-in nor a token registration produced it
  // ESTIMATE, and the wire says so in its name. Mode-dispatched from `loggedInAt` by the provider's
  // published issuance interval for that mode; null whenever `loggedInAt` or `observedAuthMode` is
  // null, because an estimate with no anchor is a fabrication. A renderer MUST present it as an
  // approximation ("about N days after sign-in"), never as a deadline the daemon can vouch for —
  // the interval belongs to the provider's issuance policy, which the daemon cannot verify, and at
  // least one pinned leg's horizon is server-rewritable on any refresh.
  expectedReloginAtEstimate: string | null;
  probeEnabled: boolean; // false = the person silenced the background observer for this account; the deliberate probe verb and spawn validation still write the stored pair
  // When the credential was last seen refreshed; null on a token account, which has no refresh, and
  // until a refresh is observed. The page draws it as an age, never a countdown.
  lastRefreshObservedAt: string | null;
  // Wake this computer for this account's window start (set through `providerAccount.update`).
  wakeForWindowStartEnabled: boolean;
  // The one-time memory import's recorded outcome, which the account row reads in place of the button
  // once it has run; null until then.
  memoryImport:
    | { outcome: "imported"; count: number; importedAt: string }
    | { outcome: "nothingToImport" }
    | null;
}

// The authentication mode the provider's OWN status surface reports for a home — OBSERVED, never
// assumed, and never derived by the daemon from the shape of a credential file. `unknown` is the
// tolerant arm for "observed, and the provider named a mode this build does not recognize": a
// vendor adding a mode must not fail an observation closed, so the union accepts and records it as
// unknown rather than refusing the observation. `oauth_token` is the ADR-026 D2 class and is the
// mode under which a token-mode account is admitted; the token VALUE is not on this wire.
type ProviderAuthMode =
  | "oauth_subscription"
  | "oauth_token"
  | "api_key"
  | "external"
  | "none"
  | "unknown";

// NOTE (ADR-026 D2). Credential material appears on EXACTLY ONE input on this wire surface and on
// NO output: `ProviderAccountRegisterRequest.nonInteractiveToken` below. It is write-only — it is
// on no reply, no event, no error, no notification, no metric, and no log line, and no reply type
// in this section carries a token-shaped member of any name. In sum:
// one credential-accepting input, named above, and zero credential-bearing outputs.
// `ProviderAccount` itself still carries none — tokens for interactively-authenticated accounts
// live in the per-account credential home written by the provider's own tooling, the daemon
// brokers refresh without holding values, and the ADR-026 D2 token is sealed in the operating
// system's keychain rather than in any column or on any payload here.
type ProviderAccountHealthState =
  | "authenticated"
  | "reauth_required"
  | "home_missing"
  | "indeterminate"; // probe could not decide — not authenticated, and never a refusal: a session starts and the provider signs in on its own (I-023-3)

// NOTE: no credential-home path appears on `ProviderAccount`. The one wire member that carries a
// home is `ProviderSignInRemedy.credentialHomePath` below — the sign-in arm alone, the two
// registry-shape arms having no resolved home to name — on the device-authorized readiness reply,
// and it is message text for the person that travels structured. The prohibition it lives under is
// unchanged and is about the READER, not the encoding: the home reaches the person's screen and never
// an event payload, anything the control plane can read, or a log line
// (Spec-025 §Node provider readiness and the sign-in handoff, on message-text-only disclosure).
// On every surface a session user can reach — the relay
// included — `credential_home_path` names a column and nothing else.

// Readiness is the pre-computed answer to the question run admission will ask, derived by the SAME
// resolution the daemon performs at spawn (Spec-025 §Validation at spawn — fail-closed) and served
// from the account row's STORED last-probe result — a list call spawns no provider process, so a
// surface may poll it; `providerAccount.probe` is the deliberate refresh. It AUTHORIZES NOTHING:
// a session starts whatever readiness last reported, and the spawn path re-validates registration
// and the home (I-023-3). Enumerated in full rather
// than aliased off `ProviderAccountHealthState` so a later health arm cannot silently widen this
// client-facing union: it widens ONLY in lockstep with that union, and a new health arm requires an
// explicit readiness arm added here.
type ProviderReadinessState =
  // The first four arms are the resolved account's STORED health state, verbatim. That stored
  // value is the outcome of the last validation — probe reading plus home observation taken at the
  // same moment — so `home_missing` is a recorded observation, never a live stat() at read time.
  | "authenticated" // last validation said so — advisory (I-023-8)
  | "reauth_required" // home was present but held no usable credential
  | "home_missing" // credential home was absent or unreadable when last observed
  | "indeterminate" // probe could not decide, or none taken yet — NOT authenticated, NOT a failure
  | "no_account" // nothing registered for this provider; mirrors `provideraccount.not_registered`
  | "no_default"; // accounts exist, none is default; mirrors `provideraccount.no_default`

interface ProviderReadiness {
  provider: "claude" | "codex";
  state: ProviderReadinessState;
  resolvedAccountId?: ProviderAccountId; // present iff resolution reached exactly one account
  // RFC 3339 UTC of the STORED observation this entry's state was read from. Absent in exactly two
  // cases, both about THIS resolution rather than about the node's probe history: resolution reached
  // no account (`no_account`, `no_default`), so there is no row to have observed — on `no_default`
  // the candidates may well have been probed, and their timestamps are deliberately not summarized
  // into one here, since averaging or picking among them would report an observation of an account
  // this reply did not resolve — or resolution reached an account whose observation pair is still
  // unset. Absence therefore never means "no probe has ever been taken on this node".
  observedAt?: string;
  // Schema-optional, PRODUCER-OBLIGATED: the daemon populates it on every non-authenticated arm and omits it on
  // `authenticated`. Optional at parse because the state alone does not make requiredness
  // expressible to a strict parser without splitting this interface per arm; the obligation is the
  // producer's and is tested per arm. It exists because the spec REQUIRES every non-authenticated
  // surface to display the next action, and no client can compose one — only the daemon knows which
  // account resolution reached and which home it holds. Composed at read time, never stored, so it
  // cannot go stale against the row it describes.
  remedy?: ProviderRemedy;
}

// Guidance for the person that happens to travel structured. The disclosure rule (Spec-025 §Node
// provider readiness and the sign-in handoff) governs it UNCHANGED and binds the READER: these
// values reach the person's screen and NEVER an event payload, anything the control plane can read, a
// log line, or a refusal envelope. `providerAccount.list` takes the SAME device gate as
// the mutating verbs — not the laxer read gate a list verb would otherwise get — and that gate is
// the only reason a daemon-owned path may cross this reply at all (Spec-025 §Authorization Posture;
// enforced and tested by Plan-023 T2.4, the task that makes the reply disclose one). This shape
// must not be reused on any surface reachable by a session user.
//
// A UNION rather than one shape, because the remedy is "the person's next action" and the three
// non-authenticated classes have three different next actions with three different producible
// field sets. A single sign-in shape was unproducible on two of them: `no_account` has no
// credential home to name at all, and `no_default` deliberately resolved to none of several homes,
// so composing either reply would have required inventing a path or arbitrarily picking an account
// — precisely the arbitrary selection I-023-5's single-default rule exists to prevent. The
// discriminant is `kind`, and it is NOT redundant with `state`: `reauth_required`, `home_missing`,
// and `indeterminate` all map to `sign_in`, so the mapping is many-to-one and a client renders off
// `kind` without re-deriving it.
type ProviderRemedy = ProviderRegisterRemedy | ProviderChooseDefaultRemedy | ProviderSignInRemedy;

// `state: "no_account"` — nothing is registered, so there is nothing to sign into yet.
interface ProviderRegisterRemedy {
  kind: "register";
  provider: "claude" | "codex";
}

// `state: "no_default"` — accounts exist and none is default. Resolution reached no account BY
// DESIGN, so the daemon names the candidates and refuses to choose: picking one here would bind a
// run's spend to an account the person never selected.
interface ProviderChooseDefaultRemedy {
  kind: "choose_default";
  candidateAccountIds: ProviderAccountId[]; // at least two — a one-account no-default state is
  // still `no_default`, but the daemon lists whatever exists
  // and never elects one
}

// `state: "reauth_required" | "home_missing" | "indeterminate"` — resolution reached exactly one
// account, so both the account and its home are known and the next action is the vendor's own flow.
interface ProviderSignInRemedy {
  kind: "sign_in";
  accountId: ProviderAccountId; // REQUIRED on this arm: it is the arm where an account resolved
  signInInvocation: string; // the provider's OWN first-party sign-in command, for DISPLAY — the
  // daemon never executes it, and this is not a shell string a client
  // is invited to run on the person's behalf
  credentialHomePath: string; // the home that invocation authenticates INTO; display-only
}

interface ProviderAccountListRequest {
  provider?: "claude" | "codex";
  // Scopes the readiness derivation to ONE account instead of the provider's default. It exists for
  // a single caller: a run refused on the account plane while bound to an account a saved agent
  // definition or a workflow step pinned
  // (Spec-025 §Node provider readiness and the sign-in handoff). Without it the post-refusal remedy
  // would necessarily describe the provider DEFAULT — a different account from the one that failed,
  // whose home and sign-in state may be entirely healthy — and the person would be handed a
  // remedy for something that is not broken. When present, resolution is pinned to this account:
  // the two registry-shape arms cannot occur (an account was named), and the reply's single
  // readiness entry carries that account's stored reading. An unknown or removed id refuses with
  // the already-registered `provideraccount.unknown` rather than silently falling back to the
  // default, which would re-introduce exactly the wrong-account remedy this member removes.
  accountId?: ProviderAccountId;
}
interface ProviderAccountListResponse {
  accounts: ProviderAccount[];
  // The durable quota rows, delivered on the READ because the subscription is a live tail and not a
  // snapshot replay — without this a client opened after a reading, or after a daemon restart, could
  // not reach `provider_account_usage_windows` until another probe or run happened to produce an
  // update. Entries carry the provenance they were OBSERVED under, so a stored window may legitimately
  // carry `source: "run"`; provenance is a property of the reading, never of the transport that
  // delivers it, and a consumer must accept both values here rather than assuming `"probe"`.
  usageWindows: ProviderAccountUsageWindow[];
  // Required, not optional. A reply that could omit readiness would push
  // every client back into deriving it locally, which I-023-8 exists to prevent.
  // Exactly one entry per provider the request selects: never zero, never two. With `accountId`
  // supplied the selection is that account's provider, so the reply still carries exactly one entry
  // — derived against the named account rather than the provider default.
  readiness: ProviderReadiness[];
}

interface ProviderAccountRegisterRequest {
  provider: "claude" | "codex";
  billingMode: BillingMode;
  makeDefault?: boolean;
  // The name the person gives an account the provider names nowhere: REQUIRED with `nonInteractiveToken`
  // on a new registration and on an API-key registration, absent on a sign-in one, and refused when it
  // matches another of that provider's account names.
  displayLabel?: string;
  // RE-SUPPLY, not a second credential-accepting verb. Supplied, this means "replace the sealed
  // token on THIS account" and `provider` must match the stored row; omitted, this is an ordinary
  // registration and the daemon mints a new identity. It exists because the terminal
  // `reauth_required` remedy is to mint a fresh token and re-supply it, and deregister-then-register
  // would daemon-mint a NEW immutable identity — discarding the spend, quota, and attention history
  // keyed to the account the person is trying to repair. A successful replacement bumps
  // `credentialGeneration` and re-runs the registration-time observation. There is still exactly one
  // credential-accepting input: this adds a selector, not a second credential input.
  //
  // NEVER ADMITTED ALONE. `accountId` names a re-supply, and a re-supply with nothing to supply is
  // not a request this verb can serve: it is not a registration (an identity already exists) and not
  // a replacement (no token accompanies it), so admitting it would leave the caller's intent to be
  // guessed by a handler — and the guess a strict parser makes cheap is the wrong one, since the only
  // reading that touches nothing is a silent no-op reported as success. `accountId` present therefore
  // REQUIRES `nonInteractiveToken` present, enforced at the parse boundary and refused against the
  // absent member. The converse is deliberately unconstrained: a token with no `accountId` is the
  // ordinary token-mode registration of a new account, which is the shape this verb was written for.
  accountId?: ProviderAccountId;
  // THE ONE CREDENTIAL-ACCEPTING INPUT ON THIS WIRE (ADR-026 D2; Spec-025 §Non-interactive token
  // registration). Optional: omitted is the ordinary registration, and the account authenticates
  // through `providerAccount.login` or the person's own out-of-band sign-in.
  //
  // WRITE-ONLY, and the rule is absolute in the direction that matters: this value is never
  // returned on this verb's response or any other, never logged, never echoed to a terminal, never
  // rendered, never placed in an error message or a diagnostic dump, and never carried in an
  // argument vector (an argv is readable by any process running as the same user). A transport
  // that logs request bodies MUST redact this member by name.
  //
  // A token the provider's own tooling minted: the daemon never mints, exchanges, refreshes, or
  // derives credential material and never speaks a provider token endpoint.
  //
  // Kept as its own item in the operating system's credential store, verified by
  // write-probe-read-delete, and nowhere else. Every entry opens its store explicitly — the Secret
  // Service on Linux, never the kernel keyring, which a reboot empties; where no Secret Service answers,
  // the daemon keeps its items in one file in its own data folder, readable only by the person (mode
  // `0600`). Where the store cannot take it, registration refuses with `provideraccount.credential_seal_refused`
  // carrying `cause: "locked" | "unavailable"` and nothing is stored anywhere. It is NOT written into
  // the credential home: daemon-owned bytes in provider-owned space are indistinguishable to every
  // later reader, the provider's own tooling included. It reaches the provider only on the
  // invocations ADR-026 D2 enumerates — the registration-time status observation, and each provider
  // process of a run bound to this account — and on Claude Code never in an environment variable: the
  // variable the provider documents for it, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, names a pipe the
  // daemon writes once per start, so no command the model issues can read the token from its
  // process's environment. The project's own probe re-runs that observation when the project moves
  // to a new Claude Code version. A pasted OpenAI API key on a Codex account is kept the same way, in the credential store and
  // the daemon's memory only, never in Codex's plaintext file mode.
  nonInteractiveToken?: string;
}
interface ProviderAccountRegisterResponse {
  account: ProviderAccount;
}

// The billing mode the person declared is correctable in place. This verb exists because the
// alternative — remove and re-register — is barred by the identity model: `accountId` is immutable
// and deliberately not re-derivable, so re-registering to fix a mis-declared billing mode would mint
// a NEW identity and orphan the spend history keyed to the old one. A correctable mistake must not
// cost an account its history. The one name the person authors is a token or API-key account's
// `displayLabel`; every other account's identity is what the provider reports, so there is no other
// name here to correct.
interface ProviderAccountUpdateRequest {
  accountId: ProviderAccountId;
  billingMode?: BillingMode; // omitted = unchanged; this is how `unknown` is resolved to a declared mode
  // Rename. Accepted only on an account that carries a `displayLabel`, and refused when it matches
  // another of that provider's account names. Omitted = unchanged.
  displayLabel?: string;
  // The durable per-account opt-out AC-19 requires. Carried on the update verb rather than as a
  // dedicated verb: it is an ordinary mutable account preference, and a verb of its own would add
  // a verb for a boolean. Omitted = unchanged; the column default is enabled, so
  // silence never silences an observer.
  probeEnabled?: boolean;
  // The window-start switch, carried here for the same reason its sibling is: an ordinary mutable
  // account preference, not a verb. Omitted = unchanged; the column default is enabled. Setting it
  // true while `probeEnabled` is false leaves it inert rather than refusing, because the two are one
  // switch under another on the surface and the parent is what silences both.
  windowStartEnabled?: boolean;
  // Wake this computer for this account's window start. The first account turned on installs the
  // wake helper and the last one turned off uninstalls it; on Windows the service schedules the wake
  // itself and no helper exists. Omitted = unchanged.
  wakeForWindowStartEnabled?: boolean;
}
interface ProviderAccountUpdateResponse {
  account: ProviderAccount;
  // Present when this update moved `wakeForWindowStartEnabled`: whether the wake helper is installed
  // now, or why it could not be.
  wakeHelper?: { state: "installed" } | { state: "notInstalled"; reason: string };
}
// NOT updatable, by omission from the request and enforced on write: `accountId` (immutable
// identity), `provider` (an account does not change vendor), `credentialHomePath` (rebinding a
// registration to a different home would silently re-point historical spend at other credentials),
// and `credentialGeneration` (daemon-owned, bumped only by the lifecycle transitions in I-023-2 —
// never by the person's edit, since a descriptive correction is not a credential event).
// `isDefault` is not updatable here either: it has its own verb, `providerAccount.setCurrent`, whose
// partial-unique-index race semantics this verb must not duplicate.

interface ProviderAccountRemoveRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountRemoveResponse {
  accountId: ProviderAccountId;
  removed: true;
}

// Makes this account its provider's CURRENT account, and that is the whole of the account switch
// (Spec-025 §Moving a session to another account). The current mark is the same mark the registry
// calls the default — one fact, the registry's word and the surface's word — and pressing it does
// two things in one act: new sessions on that provider start on this account, and EVERY RUNNING
// SESSION on that provider that is not PINNED to an account moves to it. Pinned means a saved agent
// definition or a workflow step set to a specific account; those stay where they are pinned.
//
// THE MOVE IS IN PLACE on both providers, at each session's next request: an idle session's next turn
// runs on the new account, and a busy session's model call after the step in flight does — a running
// tool finishes and is never repeated — with no hold, interrupt, copy, resume or `continue`. On Claude
// Code the daemon sends each such session `apply_flag_settings` pointing `CLAUDE_SECURESTORAGE_CONFIG_DIR`
// at the new account's credential store, and the provider re-reads the store at its next request; the
// daemon never reads or copies a Claude credential. On Codex every session that follows the current
// account runs in the one Codex service the daemon keeps for the current account, which runs on tokens
// the daemon hands it, and the switch is one `account/login/start {type: "chatgptAuthTokens"}` on that
// service with the new account's tokens, which the daemon holds only in its own memory and never
// stores, logs, shows or hands to a renderer. Each session's cost splits at the switch's
// acknowledgment: requests before it stay on the old account, requests after it go to the new one.
// Every supported version moves in place, and no version is checked: there is no second way to move a
// session's account. The move lands at the acknowledgment and writes no pending switch, so the
// working line shows no waiting words for it.
//
// Each move settles on its own session with `agent.provider_binding_changed` (§Plan-013),
// `continuity: "in_place"`: one faint collapsed row at the point of the move,
// `Switched to account <name>` (the account as the Providers page lists it), opening to the account
// it came from, the account it went to and the time. A move that fails settles with
// `agent.provider_binding_change_failed`, reason `account_unavailable`: the session stays on the
// account it had — where the new login fails at the next request, the daemon hands the previous
// account back — and the transcript gains one system message naming the switch and the reason.
// Those events are the settlement; this reply is not. A session at a level its new account cannot run
// (`Reviewed` on a Claude Code account whose plan lacks auto mode) moves with the rest and runs at
// `Ask`; it gains one `session.notice` of kind `level_unavailable` naming the level it left, whose
// flow row reads "Reviewed isn't available on this Claude Code account". Nothing is blocked.
//
// NO PER-SESSION SWITCH VERB EXISTS. `agent.configUpdate` carries no account member (§Plan-013): one
// control setting one fact is what stops a session sitting on an account the provider surface says
// it is not on. Nothing here copies a credential or a conversation between homes, and the provider's
// own login in each home is left exactly as it is.
//
// REFUSES IN PLACE where the named account fails the fail-closed spawn validation, or where its last
// limits read showed a dead login (Claude Code's read answering `rate_limits_available: false`): the
// current mark does not move, no session moves, and the refusal carries that account's own remedy.
interface ProviderAccountSetCurrentRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountSetCurrentResponse {
  account: ProviderAccount; // the account now current for its provider
  // The sessions the daemon is moving, each at its next request, so the caller knows the press
  // reached live work rather than only the registry. It is NOT a settlement: each move settles on its
  // own session's timeline. A press that reached no running session carries an empty array, which is
  // a claim that nothing was live rather than an absence of information.
  movingSessions: Array<{
    sessionId: SessionId;
  }>;
}

// Rebuilds this account's credential home from empty so the person can authenticate into it
// again — the remedy the provider-failure runbook issues when a home is absent or husked (present
// but holding no usable credential). It is a credential-home lifecycle transition under I-023-2,
// so it BUMPS `credentialGeneration`; the generation is never reset by it, which is what lets a
// stale consumer still order two readings across the rebuild. Identity survives untouched:
// `accountId` is the same afterward, so the account keeps its spend history. Its stored quota
// readings are kept for the same reason and are NOT cleared — the provider-side allowance kept
// running while the home was empty — but each carries the generation it was observed under, so a
// consumer renders a pre-rebuild reading as stale. The stored health pair is the opposite case:
// the bump invalidates it, which is why `healthState` is returned here.
interface ProviderAccountResetCredentialHomeRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountResetCredentialHomeResponse {
  accountId: ProviderAccountId;
  credentialGeneration: number; // the post-reset generation; strictly greater than the pre-reset value
  healthState: ProviderAccountHealthState; // expected `reauth_required` until the person authenticates
}

// `Check now`: the same limits read the background observer runs, taken at once when the account's
// last read is at least 60 seconds old and otherwise answered with that last read; the 60-second
// floor is the daemon's, so no surface runs a timer of its own.
interface ProviderAccountProbeRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountProbeResponse {
  accountId: ProviderAccountId;
  healthState: ProviderAccountHealthState;
  credentialGeneration: number; // the generation the probe observed; a later bump invalidates this reading
}

// The one-time memory import: copies the person's own ambient memory store — Claude Code's
// `~/.claude/projects/*/memory/`, Codex's `~/.codex/memories/` — into THIS account's credential home,
// once, on the person's press. On Claude Code it also copies the person's own agent notes,
// `~/.claude/agent-memory/<name>/`, into the daemon's one agent-memory folder
// (`~/.ai-sidekicks/agent-memory/<name>/`), never overwriting a file that is there, and counts them
// in the same figure; that folder is shared by every account because an agent's notes belong to the
// agent. The two homes are never joined, no symbolic link is followed out of a source folder, and a
// repeat call answers the recorded outcome. The outcome is also written to the account
// (`ProviderAccount.memoryImport`) and published as `account_changed`.
interface ProviderAccountMemoryImportRequest {
  accountId: ProviderAccountId;
}
type ProviderAccountMemoryImportResponse =
  | { outcome: "imported"; count: number; importedAt: string }
  | { outcome: "nothingToImport" };

// The service's own per-turn usage table, summed: each row names the account that paid for its turn,
// its model, its tokens and its cost in integer micro-dollars. It answers one account's tokens for a
// day or a week and the same figures by day and by model, and a provider's figures summed across its
// accounts. Every figure is the service's own — no provider report of totals, streaks or peak days is
// read — so it never disagrees with the usage windows beside it by counting something different.
type ProviderAccountUsageReadRequest = (
  | { accountId: ProviderAccountId }
  | { provider: "claude" | "codex" }
) & {
  from: string; // RFC 3339 UTC, inclusive
  to: string; // RFC 3339 UTC, exclusive
  groupBy: "day" | "model";
};
interface ProviderAccountUsageReadResponse {
  rows: Array<{
    day?: string; // present when grouped by day: the calendar date on this machine's clock
    modelId?: string; // present when grouped by model
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsdMicros: number;
  }>;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsdMicros: number;
  };
}

// Brokered interactive sign-in (ADR-026 D1; Spec-025 §Brokered interactive sign-in). The daemon
// constructs the invocation, spawns the provider's UNMODIFIED binary with this account's home
// pinned, and reads nothing the flow writes. What returns is what the provider emits for the
// PERSON to act on, plus an opaque daemon-minted attempt id. It is deliberately NOT a shell
// string: `ProviderSignInRemedy.signInInvocation` remains display-only and no client-supplied
// string is ever executed — the daemon authors this invocation itself, which is a different act
// with a different trust story, and the note that reasoned the display-only remedy is
// untouched for the surface it governs.
//
// SHAPE MIRRORS THE PROVIDER'S OWN, deliberately: the pinned Codex login-start returns either an
// authorization URL or a device code with its verification URL, and the pinned Claude flow prints
// a URL and accepts a pasted code. A provider arm emitting neither cannot be brokered and is
// refused `provideraccount.signin_unsupported` rather than spawning a flow the person cannot
// finish. A second start against an account with one in flight is refused
// `provideraccount.signin_in_flight` — at least one pinned provider holds exactly ONE active login
// slot and SILENTLY DROPS the previous attempt, which would strand the person mid-flow on another
// device with no signal that their code had stopped working.
interface ProviderAccountLoginRequest {
  accountId: ProviderAccountId;
}
interface ProviderAccountLoginResponse {
  attemptId: string; // opaque, daemon-minted, single-use; the correlation key for cancel and for completion
  verificationUri: string; // where the person completes the flow — the provider's own URL, verbatim
  userCode?: string; // present on a device-code arm; the person types it at `verificationUri`
  expiresAt?: string; // RFC 3339 UTC, where the provider bounds the attempt; null/absent = the provider published no bound. A whitelisted field (Spec-025 §Brokered interactive sign-in), admitted under the same parse-and-validate rule as the others: parsed to an RFC 3339 instant, required to be in the future and within the provider's documented attempt ceiling, and OMITTED rather than surfaced where it fails either test. It is a bound on an attempt, not provider state — it carries no OAuth, PKCE, or credential field.
}

// Cancellation is a FIRST-CLASS OUTCOME, not an abandonment: a broker that could only be abandoned
// would leave a provider-side login slot occupied until it timed out. `notFound` is the honest arm
// for an attempt that already completed, already canceled, or never existed — it is NOT an error,
// because a client racing a completion should not see a refusal for having lost the race.
interface ProviderAccountLoginCancelRequest {
  attemptId: string;
}
interface ProviderAccountLoginCancelResponse {
  status: "canceled" | "notFound";
}

// Read-shaped live tail of registry changes for this node (Plan-005 streaming primitive, the
// `session.subscribe` consumer shape). It carries a WIRE-ONLY notification and NEVER an
// `EventEnvelope`: the provider-account registry is un-evented by design (Spec-025 §State And Data
// Implications), because an account act on the machine's registry has no session to
// belong to and minting a session event type for it would put node administration into a session's
// audit timeline. So no Spec-005 event type is minted here and the taxonomy census does not move.
//
// This is where a brokered sign-in's completion arrives. Ordering matches `mcp.subscribe`'s: a
// client opens the subscription BEFORE calling `providerAccount.login`, so registration is live
// before the flow starts and a completion concurrent with the call arrives on the stream rather
// than falling between them. Re-observation is harmless — every notification is a re-entrant state
// update, not a delta.
interface ProviderAccountSubscribeRequest {}
type ProviderAccountSubscribeStream = AsyncIterable<ProviderAccountNotification>;

type ProviderAccountNotification =
  | { kind: "account_changed"; account: ProviderAccount } // registered, corrected, default moved, or a stored reading rewritten by ANY of its writers
  | { kind: "account_removed"; accountId: ProviderAccountId }
  // Correlated on `attemptId`. `succeeded` is a report FROM THE PROVIDER that its flow finished —
  // it is NOT itself a reading that the account is authenticated. The daemon takes an ordinary
  // health observation next and publishes the result as `account_changed`; a client that treats
  // this notification as the authentication verdict will render an account as ready that a spawn
  // would refuse. `failureReason` is message text shown to the person and carries NO credential
  // material, no provider error body verbatim, and no home path.
  | {
      kind: "login_completed";
      attemptId: string;
      accountId: ProviderAccountId;
      outcome: "succeeded" | "failed" | "canceled";
      failureReason?: string;
    }
  // The outer `accountId` is the ROUTING key and `window.accountId` is part of the reading itself.
  // Both are carried deliberately — the list reply's `usageWindows` entries carry the same member, so
  // a live update and a snapshot row key alike — and they MUST be EQUAL. A notification whose reading
  // names a different account than its routing key is not a routable update in either direction: a
  // consumer keying off the outer member files the reading under an account it does not describe, and
  // one keying off the inner member ignores the routing the daemon performed. Enforced at the parse
  // boundary rather than left to each consumer to re-check, and refused against `window.accountId`,
  // which is the half that contradicts the envelope it arrived in.
  | {
      kind: "usage_window_updated";
      accountId: ProviderAccountId;
      window: ProviderAccountUsageWindow;
    };

// The newest quota reading for one `(accountId, limitId)` pair — the wire mirror of
// `provider_account_usage_windows` (Spec-025 §Per-limit provider quota).
//
// `limitId` IS THE KEY, and `windowMins` is an attribute of the reading rather than part of its
// identity: the pinned Claude surface publishes several limits at once of which more than one share
// a 10080-minute window, so a `(account, windowMins)` key silently collapses them and the survivor
// depends on arrival order. A reading naming no limit takes the reserved id `default`, so a
// provider publishing one window needs no special case and the single-window shape stays valid as
// the degenerate case.
//
// WHERE EACH LEG'S `limitId` COMES FROM. On the Claude leg the windows are read from the
// `get_usage` reply's `limits[]` list, and a `limitId` is that entry's kind together with the model
// display name where the entry is scoped to a model — one model's weekly window is a different
// limit from another's and from the account-wide weekly window over the same length. The FLAT
// per-model keys beside that list answer null and are NEVER read: a design keyed on them renders an
// empty per-model window for an account with real per-model usage. On the Codex leg the windows are
// the keys of the reply's `rateLimitsByLimitId` map, which are the provider's own metered ids.
//
// `windowMins` IS WHAT NAMES THE WINDOW, and its POSITION in the provider's reply never is. A Codex
// limit id carries a primary and a secondary window and the provider has moved a given window
// between those slots, so a surface that read the primary slot as "the short window" would relabel
// every bar the day that moved. Key on the id; label from the length.
//
// COMPLETENESS RIDES `source`, and the prune rule turns on it. A `probe`-source reading set is the
// account's WHOLE standing and replaces the stored set for that account; a `run`-source reading is
// the provider's own sparse push and is merged into it, pruning no window it does not name. Without
// the distinction one sparse push would delete every window it happened not to mention.
interface ProviderAccountUsageWindow {
  // Which account this window describes. Required, and NOT inferable from position: the read
  // returns one flat array across every registered account, and two accounts of one provider can
  // publish the same `limitId`, so without this a reconnecting client cannot associate a durable
  // window with its account and would be free to render one account's quota under another's name.
  // The live `usage_window_updated` notification already carries it; the snapshot carries the same
  // member so both paths key alike.
  accountId: ProviderAccountId;
  limitId: string; // untrusted provider-adjacent string, `wireFreeFormString`-bounded; NOT a closed union — the provider's limit vocabulary is open and versioned
  windowMins: number;
  label?: string; // the provider's own display label where it publishes one; display-only, never parsed, never a key
  usedPercent: number; // NOT clamped to 100 on the wire: a provider may report over-consumption against a soft limit and clamping would misreport it. Renderers clamp for display.
  resetsAt?: string; // RFC 3339 UTC where the provider supplies it; absent = unknown, never "now" and never "never"
  observedAt: string; // RFC 3339 UTC. THE ORDERING KEY: newest `observedAt` wins per `(accountId, limitId)`, and `source` breaks ONLY exact ties. Ordering by arrival, or by preferring one source, would let a stale reading mask real consumption. It is ALSO the read time the surface renders beside the figure: a percentage with no read time invites a reader to plan against a number that on an idle account will be hours old.
  observedCredentialGeneration: number; // the account's `credentialGeneration` when this reading was taken — the same member `usage.rate_limit_update` carries. A credential-home rebuild does NOT clear stored readings (the provider-side allowance keeps running while the home is empty), so a renderer compares this against `ProviderAccount.credentialGeneration` and renders a behind-generation reading as STALE rather than current. The stored health pair is the opposite case: a bump invalidates it outright.
  source: "probe" | "run"; // the deliberate limits read, or the account-scoped quota event from real traffic. The background observer performs THE SAME limits read on its cadence (Spec-025 §Credential-home health observation), so a reading it took is recorded as `probe`: it is another caller of one read, not another provenance — and so is the turn-end read the daemon sends to a live Claude process, which is the same read asked of a process that already exists. The Codex leg's rolling push with a turn is the `run` value. The two values also differ in COMPLETENESS, which is what the prune rule turns on — a `probe` reading describes the account's whole standing and replaces the stored set, while a `run` reading is the provider's own sparse push and is merged into it, pruning nothing it does not name.
}
```

**Provider readiness.** `providerAccount.list` answers the registry question and the admissibility question in one reply, because a client that had to ask them separately would be free to combine them differently from admission. `readiness` is a **derivation**, not a stored second opinion: resolve the provider's default account, then report that account's stored health verbatim, with the two registry-shape arms standing in where resolution never reaches an account. No client re-derives it from `accounts` — a surface that recomputes readiness from account fields is the defect this member exists to remove, since the recomputed answer is the one nothing enforces. `authenticated` is a statement about the last observation and not a grant: a run bound to an `authenticated`-reading account still refuses at spawn if the home has since been signed out, and `indeterminate` is rendered as undetermined rather than as a sign-in failure.

**Run-start selection.** Which account a run pays from is **resolved by the daemon and never supplied by a client**: the account pinned by the run's saved agent definition or workflow step where one pins, and otherwise the provider's current account. The resolved value rides the driver's session-creation and resume parameter shapes as `providerAccountId` ([Spec-004 §Interfaces And Contracts](../../specs/004-provider-driver-contract-and-capabilities.md#interfaces-and-contracts)) and is stamped server-side as `admittedProviderAccountId` on the run's admission record. No wire request carries an account per session or per run, so there is no per-run override to authorize and a client-supplied stamp is ignored. Resume rebinds to the account the session was last on rather than re-resolving whichever account is current now, so a restart never moves billing. Moving the current account DOES move a live session, in place at its next request (`providerAccount.setCurrent` above): the usage rows before the switch's acknowledgment name the old account and the rows after it the new one, so the receipt's per-paying-account key stays exact and a session that moved mid-way yields two account rows summing to the same total.

**Switching a live session's account is `providerAccount.setCurrent` and nothing else.** A session starts on its provider's current account — the one marked current at the moment the session is minted — and moves when that mark moves: in place at its next request, and a session pinned to an account not at all. The verb's own comment above states the mechanism. `agent.configUpdate` carries no account member (§Plan-013), so there is no per-session account switch and nothing for a client to reconcile between two controls; an account move writes no pending switch, and it settles with the same binding events as every other switch. The console's account word on the provider surface presses this verb; the session inspector's account fact reads which account the session is on and carries no control.

**The one-time memory import is `providerAccount.memoryImport`.** Each account row offers to copy the person's own ambient memory store into THAT account's credential home, once, on a press: after it the row reads how many were copied and when, and an account with nothing to copy settles into saying so and offers the press no more. The two homes are never joined, and the copy is the person's act rather than a background sweep. Its payload pair is `ProviderAccountMemoryImportRequest` / `ProviderAccountMemoryImportResponse` above, and the outcome it records is `ProviderAccount.memoryImport`.

**The provider's own standing rules are `provider.standingRuleList` and `provider.standingRuleRevoke`.** Each provider keeps rules of its own that allow or refuse a command on this machine; they are read from and revoked in the provider's own files, the same files the session inspector's `approval.ruleList` and `approval.ruleRevoke` read for one session, so one rule has one place: the provider's. The `provider` root sits beside `providerAccount`, because a machine-wide page cannot use the `driver.*` reads, which need an active session.

```ts
// provider.standingRuleList — one row per rule, in the provider's own words, read from every account
// home and every attached project: on Codex the `.rules` files under each account home and each
// trusted project's `.codex/rules/` (loaded only once the project is trusted); on Claude Code the
// `permissions` of its user-level, project and project-local settings files. A provider holding none
// answers an empty list, which the page reads as saying so.
interface ProviderStandingRuleListRequest {
  provider?: "claude" | "codex";
}
interface ProviderStandingRuleListResponse {
  rules: Array<{
    ruleId: string; // daemon-minted, stable while the rule's file and text are unchanged
    provider: "claude" | "codex";
    text: string; // the rule as the provider's file spells it
    effect: "allow" | "deny";
    scope:
      | { kind: "accountHome"; accountId: ProviderAccountId }
      | { kind: "project"; projectId: ProjectId };
    sourcePath: string; // the file it came from; display-only data, never a capability
  }>;
}

// provider.standingRuleRevoke — removes the rule where the provider keeps it, and the provider follows
// the change as it does on its own: Claude Code from its next tool call, and Codex in each conversation
// it loads after the change, a loaded Codex conversation keeping the rules it loaded with, which is
// Codex's own behavior. The daemon adds nothing over the provider's rules: no copy, no hash, no check.
interface ProviderStandingRuleRevokeRequest {
  ruleId: string;
}
interface ProviderStandingRuleRevokeResponse {
  ruleId: string;
  revoked: true;
}
```

---

## Plan-024 — Agent Definitions And Peer Invocation

Governed by [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) and, for plugins, [Spec-029](../../specs/029-skills.md). Saved agents are managed through six `agent.*` verbs — `agent.definitionList`, `agent.definitionCreate`, `agent.definitionUpdate`, `agent.definitionDelete`, `agent.definitionExport` and `agent.definitionImport` — plus the live `agent.definitionSubscribe`, and the tool allowlist's catalog read `callbackTool.list`; the `agent.*` verbs register against the Plan-005 `MethodRegistry` when Plan-024 lands, inside the `agent` root Plan-013 registers — the CP-005-2 late-registration pattern. The person's own edits to definitions, export and import included, pass no policy check and no ownership refusal; the definition verbs carry no `sessionId`. A peer-invocation call is an ordinary tool call on the bridge, so it rides the existing `tool_execution` approval category through the approval pipeline at the session's own permission level. No `ApprovalCategory` value is added. Refusals: [error-contracts.md §Agent Definitions](./error-contracts.md#agent-definitions). **No event type is minted**: definition mutation is node-local configuration rather than session history, and every session-visible consequence of a peer invocation is already carried by the existing tool-activity and run-lifecycle events. A definition reaches the person's linked devices like every other screen, and otherwise leaves the machine only in the export files the person writes, with every binding's account left out.

```ts
// A daemon-minted opaque immutable identifier. NEVER the definition's name: the name is a mutable
// human label, and a rename must not orphan an audit row or a stored reference. Same discipline as
// ProviderAccountId (Plan-023) — the identity and the words a person reads are separate axes on purpose.
type AgentDefinitionId = string & { readonly __brand: "AgentDefinitionId" };

// A saved, node-local agent configuration. Configuration, not session state: not events-canonical,
// not replayed, not rebuilt from the event log. Every axis below is one a run already carries, so this
// shape composes existing axes into a reusable named bundle and mints no new configuration dimension.
// One provider binding: which provider runs the agent, on which model, paying from which account, at
// which reasoning effort, and — on a running agent — at which output speed. A definition carries a
// DEFAULT binding and any number of overrides, so one saved agent runs on either provider without a
// second definition — the cross-provider bridge the library is for. The default is one of the bindings
// rather than a fallback beside them: there is no unbound state to resolve from. The same shape is a
// running agent's binding: `agent.configUpdate` moves its members, and the binding events
// (§Plan-013) carry it from and to.
interface AgentProviderBinding {
  driverName: ProviderName; // provider driver key, matching the agent surface's driver axis; a live agent's driver is parsed as a ProviderName where agent.provider_binding_changed writes it
  modelId: string;
  providerAccountId: ProviderAccountId | null; // null = follow the provider's current account — the one marked `Default`, which `providerAccount.setCurrent` moves — resolved AT THE MOMENT THE RUN STARTS and followed when the mark moves. Deliberately not a foreign key: a definition may name an account that is later removed, and that must surface as a typed resolution refusal the person can act on, not as a delete-time cascade that silently rewrites the definition
  effort: string | null; // null = the driver's default. Validated at RESOLUTION against the target model's driver-reported `effortLevels` — never against a hardcoded list, and never at save, because the vocabulary belongs to the model a run actually binds
  outputSpeed?: string; // set on a running agent's binding through agent.configUpdate; a saved definition's bindings leave it absent, because the editor authors no speed
}

interface AgentDefinition {
  definitionId: AgentDefinitionId;
  name: string; // mutable label; unique per origin and scope under full Unicode case folding, arbitrated by the unique
  // index over the stored `name_folded` key (I-024-7), so a provider's own `reviewer` sits beside ours; the
  // service pre-check is a legibility affordance
  description: string; // may be empty; written by the person
  // A glyph key from the console's own icon set. Icon and color are separate fields rather than one theme,
  // so a person can change either without the other. null = the generic agent mark.
  icon: string | null;
  // One step of the console's twelve-step hue wheel. null = no chosen hue, and the card draws the generic mark's own.
  accentHue: string | null;
  // The provider bindings. `overrides` is present on a stored row and may be empty, so a reader never has
  // to tell an empty set from a missing one.
  bindings: {
    default: AgentProviderBinding;
    overrides: AgentProviderBinding[];
  };
  instructions: string; // may be empty; system-prompt content the person writes
  goal: string | null;
  toolAllowlist: string[] | null; // null = the driver's defaults, [] = no tools at all, populated = exactly these. Collapsing null and [] would make "I did not choose" indistinguishable from "I chose nothing"
  // The number of turns this agent may take before it is stopped; null = no cap, and the daemon adds
  // none of its own. One number on both providers although only one enforces it natively: on the leg
  // that publishes no limit the daemon counts the agent's model rounds on the wire, and at the cap its
  // pre-tool hook denies every further call, so the agent reports what it completed and its turn ends.
  // It is not a budget — budgets and their ceilings are
  // [Spec-014 §Budget Policies](../../specs/014-multi-agent-orchestration.md#budget-policies)'s.
  turnCap: number | null;
  // The agent's own hooks, on every origin and both providers, in Claude Code's own shape — the form an
  // agent file's `hooks` key holds, one entry per event, each a list of `{ matcher?, hooks: [handler] }`.
  // null = none. The console's own pause hooks are the daemon's and never appear here.
  hooks: AgentHooks | null;
  // The agent's one memory: "user" = everywhere, in the daemon's own agent-memory folder, which every
  // Claude Code config home links to; "project" = this project, saved with the repository; "local" =
  // this project, on this machine only; null = none. Claude Code reads it natively and the daemon reads
  // it for a Codex run, so either provider running the agent reads and writes the same folder.
  memoryScope: "user" | "project" | "local" | null;
  createdAt: string; // ISO-8601
  updatedAt: string;
}

// Claude Code's own hook value, keyed by event name. Each handler is carried as that provider's hook
// schema spells it and validated against it at save; the editor draws one row per handler.
type AgentHooks = Record<
  string,
  Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>
>;

// The RESOLVED-CONFIGURATION ECHO: every field as actually applied, once a run has started under a
// definition. It rides the response of whichever request started that run — the scratch session a try-it
// starts, the workflow step's own record, and the agent row a name in a composer produces — so a resolved
// binding has exactly ONE home on the wire and no surface reconstructs it by merging its own request with
// a registry row that may already have moved. `instructions` is part of the echo rather than left out of
// it: without it a caller cannot tell which system prompt the run actually received except by re-reading
// the registry, which is the live-view read I-024-2 forbids. The goal is echoed as the definition set it;
// the agent also starts with it as its own goal command, which `session.goal_updated` records. Where the
// definition is bound plural the echo carries the RESOLVED BINDING in place of the folded axes, so a
// reader is told which side of the per-field merge won rather than which axes existed to merge.
type AgentResolvedConfiguration = {
  resolvedFromDefinitionId: AgentDefinitionId;
  resolvedBinding: AgentProviderBinding;
} & Pick<AgentDefinition, "toolAllowlist" | "instructions" | "goal">;

// agent.definitionList — node-local and unfiltered: every definition from the four origins — ours
// (`.ai-sidekicks/agents/`, global or in a project), Claude Code's own agent files, Codex's own, and a
// plugin's, which is read-only — one list serving the library, the composer's Sidekicks group, a
// workflow node's chooser and every label that names an agent. The daemon parses every file itself
// rather than trusting a provider's own load. The request carries no members, declared as an explicit
// empty interface rather than omitted, so every operation in this namespace has both halves of its pair
// and no handler signature special-cases a missing request type (the
// ProviderAccountSubscribeRequest precedent).
interface AgentDefinitionListRequest {}
// One definition as the list serves it: the record, where it lives, and two provider facts, each its
// own field and neither excluding another.
type AgentDefinitionListEntry = AgentDefinition & {
  origin: "ours" | "claude" | "codex" | "plugin";
  pluginName?: string; // present exactly on a plugin's agent
  scope: "global" | "project";
  projectId?: ProjectId; // present exactly when scope is "project"
  sourcePath: string; // the file the record lives in, or for an orphaned record the last path its file was known at; display-only data
  orphaned: boolean; // a provider's file was renamed or deleted outside the app: the record keeps its extras until it is reattached or discarded
  disabledInProvider: boolean; // the provider's own configuration switches the agent off
  loadError: string | null; // its file failed to load: the reason, from the daemon's own parse
  // A definition whose file names a provider this app doesn't run is listed too, its chip reading
  // `<name> · not supported here`. The read carries that name apart from the binding's ProviderName,
  // and starting the definition is refused with `agent.resolution_refused`, reason
  // `provider_unsupported`, until another provider is picked.
};
interface AgentDefinitionListResponse {
  definitions: AgentDefinitionListEntry[];
  // How many workflow definitions bind each definition, folded per reply over the current body of
  // every workflow definition on the node (each `agent`-typed param counted once per workflow) and
  // never stored. Optional as a whole, and absent only when the workflow store could not be read;
  // a listed definition no workflow binds maps to 0 (Spec-026 §Interfaces And Contracts).
  workflowUsage?: Record<AgentDefinitionId, number>;
  // When a session run or a workflow run last resolved each definition, folded per reply from the runs
  // that record their resolved-from definition and never stored. Optional as a whole, and absent only
  // when run history could not be read; a definition never run has no key.
  lastUsedAt?: Record<AgentDefinitionId, string>;
}

// agent.definitionCreate — every axis except name is optional; omitted axes store as the null
// ("inherit / default") state rather than a materialized value, so a definition never silently
// pins today's default forever. The daemon writes our file under the scope's `.ai-sidekicks/agents/`,
// holding every field, and the store row in one operation.
interface AgentDefinitionCreateRequest {
  name: string;
  description?: string;
  icon?: string | null;
  accentHue?: string | null;
  // `overrides` is OPTIONAL on the request and always present on the stored row — the same
  // stored-versus-draft grammar the rest of this surface uses: an author who has not added one submits
  // nothing, and the daemon stores an empty list rather than leaving the member absent.
  bindings: {
    default: AgentProviderBinding;
    overrides?: AgentProviderBinding[];
  };
  instructions?: string;
  goal?: string | null;
  toolAllowlist?: string[] | null;
  turnCap?: number | null;
  hooks?: AgentHooks | null;
  memoryScope?: AgentDefinition["memoryScope"];
  scope?: "global" | "project"; // the editor's Global or project control; omitted = "global"
  projectId?: ProjectId; // required when scope is "project"
}
interface AgentDefinitionCreateResponse {
  definition: AgentDefinitionListEntry;
}

// agent.definitionUpdate — a partial patch. An ABSENT key leaves the stored value alone; an
// explicit null CLEARS it back to the inherit state. That distinction is why the nullable axes are
// `field?: T | null` rather than `field?: T`: without it there is no wire way to say "stop pinning
// this", and the person could set an account or an effort but never unset one. A field the provider's
// own file holds is written into that file in place; a field it cannot hold is written only to our
// record beside it, so a provider's file never gains a key its provider does not read. Refused on a
// plugin's agent, which is read-only.
interface AgentDefinitionUpdateRequest {
  definitionId: AgentDefinitionId;
  name?: string;
  description?: string;
  icon?: string | null;
  accentHue?: string | null;
  // `bindings` patches as a WHOLE-OBJECT REPLACE, not per override: a per-override patch grammar would
  // need stable override identities and a three-way merge, which is more wire than the editor's own
  // save-the-whole-set gesture needs. Absent still leaves the stored bindings alone.
  bindings?: {
    default: AgentProviderBinding;
    overrides?: AgentProviderBinding[];
  };
  instructions?: string;
  goal?: string | null;
  toolAllowlist?: string[] | null;
  turnCap?: number | null;
  hooks?: AgentHooks | null; // a whole-object replace, as `bindings`
  memoryScope?: AgentDefinition["memoryScope"];
  // Reattaches an orphaned record to a provider's file: the token of the file the person picked with
  // `native.showOpenDialog`, which main's relay turns into a path (Spec-021 §Preload Bridge Contract).
  // Accepted only while the record is orphaned.
  reattachFile?: FilePathRef;
}
interface AgentDefinitionUpdateResponse {
  definition: AgentDefinitionListEntry; // the full post-update row, so a client never reconstructs it by merging its own patch
}

// agent.definitionDelete — never refused and never cascading. A session already running this
// agent keeps the configuration it was given, and a workflow node that references it refuses at its
// next run; the caller's own confirmation is where that consequence is named, so the wire carries no
// force flag and no dependency list (Spec-026 §State And Data Implications). On an agent that came
// from a provider's own file, the daemon checks that the path is the provider's agent file it read,
// deletes that file and the record beside it in one act, so the provider loses the agent too. On an
// orphaned record it discards the record.
interface AgentDefinitionDeleteRequest {
  definitionId: AgentDefinitionId;
}
interface AgentDefinitionDeleteResponse {
  deleted: true;
}

// agent.definitionExport — writes the chosen definitions into the folder the person picked with the
// platform's own dialog, one Markdown file per definition: each definition's record, icon, accent,
// hooks and memory scope, and every binding with the account left out. The notes in an agent's memory
// folder are never read into a file. The daemon leaves the accounts out itself and never relies on the
// caller to. The request carries the picked folder's token; main's relay turns it into the path the
// daemon writes, so no path string crosses the bridge (Spec-021 §Preload Bridge Contract). An unknown
// id refuses the whole export; a failed write refuses with `agent.export_write_failed`, carrying the
// operating system's cause.
interface AgentDefinitionExportRequest {
  definitionIds: AgentDefinitionId[]; // one or more
  folder: FilePathRef;
}
interface AgentDefinitionExportResponse {
  exportedCount: number;
}

// agent.definitionImport — reads the definition files in the folder the person picked with the
// platform's own dialog and creates every definition in them in one daemon transaction. It
// only ever creates and never overwrites, suffixes a colliding name as `Duplicate` does (checked
// against the store's unique name index), lands every definition in the global scope, because the
// files carry nothing tied to one machine, and keeps each definition's hooks and memory scope. The
// files carry no account, so an import never binds one. Every other file in the folder is skipped and
// listed once with its reason, as Claude Code treats its own agents folder; no import is refused whole
// for a file that is not a definition.
interface AgentDefinitionImportRequest {
  folder: FilePathRef;
}
interface AgentDefinitionImportResponse {
  definitions: AgentDefinitionListEntry[]; // the created rows, under their final, possibly suffixed, names
  skipped: Array<{ fileName: string; reason: "not_an_agent_definition" }>; // drawn `README.md · not an agent definition`
}

// agent.definitionSubscribe — the whole agent.definitionList reply again each time a definition
// changes: a save, delete or import from any window; a provider's file added, changed or removed on
// disk as the daemon's watch sees it; a plugin landing or leaving. Every open window's library,
// composer group and workflow chooser stay current without re-reading.
interface AgentDefinitionSubscribeRequest {}
type AgentDefinitionSubscribeStream = AsyncIterable<AgentDefinitionListResponse>;

// callbackTool.list — the daemon's callback tools, one of the allowlist picker's three sources beside
// the MCP catalog (`mcp.list`, §Plan-022) and each provider's own built-in tools (the `builtInTools`
// list on `driver.listCapabilities`, §Plan-003). Node-wide, because the editor has no session: a static
// catalog of the registrations in code — the bridge's verbs, the session-messaging tools and the
// workflow tools — whose names the daemon curates and never takes from provider output.
interface CallbackToolListRequest {}
interface CallbackToolListResponse {
  tools: Array<{
    name: string; // the wire name a provider sees
    label?: string; // the words a person reads, the one label the picker and the transcript both draw; absent = the name in sentence case
    description: string;
  }>;
}

// ---- Plugins: each provider's own plugin verbs, over one daemon-owned plugin home per provider ----
// Plugins install into a plugin home the daemon owns, one per provider, never an account home and never
// the person's own home: every `claude plugin` command runs with that folder as `CLAUDE_CONFIG_DIR`,
// and Codex's `plugin/*` and `marketplace/*` verbs are answered by a `codex app-server` the daemon
// starts on that folder while the view is open and stops 60 seconds after it closes. An installed
// plugin's agents and skills are the read-only plugin origin (`plugin · <name>`) of the definition list
// and the skills list. Codex's catalogs shared between people are not listed. Installing or removing
// a plugin raises the daemon's own `plugin.installed` / `plugin.uninstalled` signal, which the origin
// reader, `agent.definitionSubscribe` and the session pack follow; neither is a session event.
type PluginProvider = "claude" | "codex";
// plugin.catalogList — each provider's catalog, read once per opening of the view and held only while
// it is open. The daemon filters by `query`, because neither provider's verb takes one.
interface PluginCatalogListRequest {
  provider: PluginProvider;
  query?: string;
  cursor?: string;
}
interface PluginCatalogListResponse {
  plugins: Array<{
    id: string;
    provider: PluginProvider;
    name: string;
    displayName: string;
    description: string;
    marketplace: string;
    carries: { agents: number; skills: number; mcpServers: number; hooks: number };
    installed: boolean;
    installedInTerminal: boolean; // installed in the person's own terminal, read without writing; `Use in Sidekicks` installs the same plugin here
  }>;
  nextCursor?: string;
}
// plugin.read — what one plugin carries, each item by name and description, and its source.
interface PluginReadRequest {
  provider: PluginProvider;
  id: string;
}
interface PluginReadResponse {
  items: Array<{
    kind: "agent" | "skill" | "mcpServer" | "hook";
    name: string;
    description: string;
  }>;
  source: { marketplace: string; repository?: string; commit?: string }; // repository and commit for a plugin fetched from elsewhere
}
// plugin.install / plugin.uninstall — the provider's own install and uninstall in the daemon's plugin
// home. An install reaches a live session as a saved agent does: on Claude Code by the resume at the
// session's next idle moment, on Codex by forking the lead's conversation.
interface PluginInstallRequest {
  provider: PluginProvider;
  id: string;
}
interface PluginUninstallRequest {
  provider: PluginProvider;
  id: string;
}
interface PluginChangeResponse {
  provider: PluginProvider;
  id: string;
  installed: boolean; // true after plugin.install, false after plugin.uninstall
}
// plugin.installedList — the plugins in the daemon's plugin homes, and those the person installed in
// their own terminal (`installedInTerminal`).
interface PluginInstalledListRequest {
  provider?: PluginProvider;
}
interface PluginInstalledListResponse {
  plugins: PluginCatalogListResponse["plugins"];
}
// plugin.marketplaceAdd / plugin.marketplaceRemove — each provider's official marketplace is present
// without adding it.
interface PluginMarketplaceAddRequest {
  provider: PluginProvider;
  source: string; // a repository address or a folder
}
interface PluginMarketplaceRemoveRequest {
  provider: PluginProvider;
  name: string;
}
interface PluginMarketplaceChangeResponse {
  provider: PluginProvider;
  name: string;
}
// plugin.appList — a Codex plugin's apps, each with its link state on every Codex account, read from
// that account's own Codex service. `connectUrl` opens the app's page in the browser, where the person
// links it while signed in as that account. An API-key account carries no apps.
interface PluginAppListRequest {
  provider: "codex";
  pluginId: string;
}
interface PluginAppListResponse {
  apps: Array<{
    appId: string;
    name: string;
    accounts: Array<{ providerAccountId: ProviderAccountId; linked: boolean; connectUrl: string }>;
  }>;
}

// ---- The peer-invocation bridge: one tool server, six verbs (Plan-024 T4.1) ----
// The daemon serves a session exactly ONE tool server, carrying six verbs — run, message, wait, stop,
// close, list — registered as ordinary SessionCallbackTool entries through the existing callback-tool
// dispatch seam (Spec-004 §Required Behavior). The host is the daemon's own, sits OUTSIDE the Spec-024
// MCP governance model (Spec-024 §Non-Goals), and is never override-governed. The Codex leg reaches the verbs as function-form dynamic tools and the tool server
// itself is the interface there — its own description lists every cross-provider agent by name and
// description, and the lead runs one by name. The Claude leg reaches them through the daemon-hosted ephemeral MCP server,
// where a cross-provider agent is a session-pack entry whose ONLY tools are these six: the lead's own
// tool list never holds them, so the lead reaches the agent through that entry and nothing else.
// All six are registered at spawn UNCONDITIONALLY and adjudicated per invocation, exactly as every
// other daemon-registered tool is: the call rides the `tool_execution` approval category through the
// approval pipeline under the session's own permission level — an asking level raises the same
// approval card any tool call raises, an approval rule can answer it, and a level that never asks
// never asks for this either — and a decline answers `denied` rather than hiding the tool.
// State-gated registration is refused — it would make any change invisible until the
// next spawn, because `callbackTools` rides only CreateSessionParams / ResumeSessionParams and no
// live-registry mutation seam exists, so the person who changed what the session permits mid-session
// would see nothing change until the leg respawned. Per-call adjudication needs no such seam.
// One withholding is inherited rather than invented: while the daemon's approval service — the
// in-process create the callback-tool host waits on — is not running, Spec-004's fail-closed
// availability rule withholds the WHOLE callbackTools registry at spawn, and these go with it.
// A definition's `toolAllowlist` filters this registry like any other tool source (I-024-10): a run
// under a definition whose allowlist is `[]` receives NO bridge verbs, and one naming an explicit set
// receives them only if it names them — an allowlist that did not bind the daemon's own curated tools
// would report a restriction that is not in force.
// Outcomes map onto the EXISTING CallbackToolResult arms; no result arm is added and no code is minted.
// A declined approval or an admission refusal answers `denied` carrying its reason; an unknown target or
// schema-invalid arguments answers `failed`. No invocation is left unanswered.
// EVERY VERB THAT NAMES A TARGET NAMES AN AGENT. `run` names a saved definition; `message`, `wait`,
// `stop` and `close` name an agent already running in this session, by the handle `run` returned; `list`
// names none. `run` may also carry a model and a reasoning effort, as both providers' own spawn calls
// take them. A request naming a provider, an account or a node is REFUSED — the agent's binding names
// them, and the unit an agent addresses is another configured agent, never a vendor — which is why no
// free-form target string and no provider or account member appears in any shape below.
// STATE LIVES IN THE DAEMON, NEVER IN THE TOOL-SERVER PROCESS. The handles, the provider-side thread and
// process identities, and what each agent has produced are the daemon's own, which is why nothing below
// carries a provider-side identifier even though the daemon holds one. A provider restarts a tool server
// under a live session and state held in that process goes with it: measured, the restart lost the
// handles, the next wait answered that no such handle existed, and the agent's whole task was re-run
// from the start — a second billed turn nobody asked for.

// The bridge's address for one running agent, minted by the daemon when `run` admits it and the only
// address the other four verbs take. Opaque and session-scoped, and deliberately NOT a RunId, an
// AgentId, or any provider-side thread or process id: a caller that could name a provider object could
// reach past the daemon that owns it.
type AgentBridgeHandle = string & { readonly __brand: "AgentBridgeHandle" };

// run — start a saved agent and ANSWER AT ONCE with its handle, never blocking until the work is done.
// The daemon resolves the definition, starts that provider's own unit of work under it — a thread on the
// Codex leg, a process on the Claude leg — admits the run through the ordinary orchestration pipeline,
// and links it to the run that reached it, the link recording `reachedBy: "bridge_run"` (§Plan-013's
// ChildRunProvenance); this surface mints no run kind. The daemon shows a bridged agent under the lead
// that reached it and hands the lead its result.
// Admission is evaluated SYNCHRONOUSLY inside the creation call, so the verb can never answer with the
// handle of a run that then died at admission. No admission check bounds how deep the chain runs: an
// agent reached through the bridge may reach another, and that one another, to any depth. Because the daemon owns the started process it reads that agent's output word
// by word in both directions, unlike a provider's own in-session helper seen through its lead.
interface AgentBridgeRunArguments {
  definitionId: AgentDefinitionId; // the saved definition — never a name
  task: string;
  modelId?: string; // this run's model in place of the binding's, resolved as the binding's is
  effort?: string; // this run's reasoning effort in place of the binding's, resolved as the binding's is
  // A JSON Schema the agent's final answer must fit, which `wait` then returns as an object. On Claude
  // Code it is `--json-schema` on the agent's process, which binds every turn of that process, so a later
  // `run` with a different schema or none restarts the process on `--resume` at its next idle moment and
  // the same schema keeps it; on Codex it is `outputSchema` on the conversation's `turn/start`.
  outputSchema?: Record<string, unknown>;
}
interface AgentBridgeRunResult {
  handle: AgentBridgeHandle;
}

// message — send a running agent more words. A message to one that has ALREADY FINISHED continues the
// same conversation with its memory intact rather than opening a second one, so a follow-up costs one
// more turn rather than a whole repeat; the conversation stays open until `close` ends it.
interface AgentBridgeMessageArguments {
  handle: AgentBridgeHandle;
  text: string;
}

// wait — BOUNDED, and it always settles. It returns within 10 seconds whatever the agent's state is
// then — still running, with what the agent has produced so far, or the terminal it reached with its
// output — which is also the longest a steer from the lead waits. A blocking wait would make the agent
// unsteerable by construction — on the Claude leg a helper reads what it is sent only at a tool round,
// so each bounded wait is the round that lets a steer land. A Claude Code agent's run counts as
// finished only when its process has no turn running and no background task left, because a Claude
// Code turn can end while a helper it started still runs.
// A wait outstanding when the agent reaches a terminal state is SETTLED BY THAT TERMINAL. The agent's run
// id does not exist before admission, so the waiter cannot subscribe ahead of it: the waiter MUST
// capture the run-lifecycle stream cursor BEFORE admitting, then subscribe and replay forward from that
// captured cursor, settling from whichever source presents the terminal first and deduping by
// `(runId, runVersion)`. Subscribing merely before the verb returns is insufficient and MUST NOT be
// relied on — a live subscription opened after admission never replays the terminal that landed in
// between, which is the one window this ordering closes.
interface AgentBridgeWaitArguments {
  handle: AgentBridgeHandle;
  // A REQUEST, not a grant: the daemon caps it at 10 seconds and waits the capped figure, never the
  // caller's. The cap and the close rule's 15 seconds live beside the bridge's argument schema in the daemon's
  // agent bridge (`packages/runtime-daemon/src/agents/`), and the handler declares none of its own.
  timeoutSeconds?: number;
}
interface AgentBridgeWaitResult {
  handle: AgentBridgeHandle;
  // Six arms. `running` carries what the agent has produced so far; the five terminals
  // carry the output it produced. `finished_with_nothing` is the honest arm for an agent that reached
  // the end having produced nothing: reporting it as `finished` with empty output would present a
  // non-answer as an answer, and reporting it as `failed` would claim something went wrong.
  state: "running" | "finished" | "finished_with_nothing" | "failed" | "canceled" | "interrupted";
  // The text produced, or — where `run` named an `outputSchema` — the agent's final answer as the
  // object that fits it.
  output: string | Record<string, unknown>;
}

// stop — interrupt what the agent is doing now. The daemon reaches the provider running it directly (an
// interrupt on its Codex thread, an interrupt on its Claude Code process); the handle stays addressable,
// so whoever reached the agent learns the outcome on its next wait.
interface AgentBridgeStopArguments {
  handle: AgentBridgeHandle;
}

// close — end the bridge's hold on the agent: its conversation ends and the handle stops resolving, so a
// later verb naming it answers `failed`. The daemon ALSO closes a run on its own initiative — no
// provider tells a tool server that its caller was stopped, so an agent whose caller has gone would
// otherwise run on, billed, with nobody reading it. The daemon closes a run, and interrupts what it was
// doing, once its caller has had neither a wait in flight nor a turn running for 15 seconds, and at once
// when the caller's process exits, so an abandoned agent is interrupted within 25 seconds. The daemon
// drives every caller's turns, so a lead busy with its own long command, or thinking long between two
// waits, keeps its run.
interface AgentBridgeCloseArguments {
  handle: AgentBridgeHandle;
}

// list — what is running in this session, and the one verb that names no target. Each row carries the
// handle, the definition the agent was run under, the provider running it, and its state, which is what
// the session's own tree draws its mark of which provider is running an agent from. The verb spellings
// are plumbing and never reach a screen: a row says what the agent is doing, not which verb carried it.
interface AgentBridgeListArguments {}
interface AgentBridgeListResult {
  running: Array<{
    handle: AgentBridgeHandle;
    definitionId: AgentDefinitionId;
    driverName: string; // the provider actually running this agent, which need not be the lead's
    state: AgentBridgeWaitResult["state"];
  }>;
}
```

**Why no receipt growth.** A peer-invoked child's spend lands in the account row of the account the target agent ran on, an ordinary row under the provider it ran on. Causation rides the existing `run_links` edge (`parentRunId` + `reachedBy`), not a receipt roll-up, so the causal fact is recorded where it happened, and every provider's rows keep summing to its subtotal and the subtotals to the session total unchanged.

**The definition verbs, with the storage folded under them.** The list's reply carries the binding fold above and each definition's origin facts; create gains the bindings, the icon, the hue, the scope, the hooks and the memory scope; update replaces the bindings and the hooks whole and can reattach an orphaned record; delete removes a provider's own file with the agent; export and import move definitions through a file the person picks. The provider columns fold into ONE bindings column on the definition table, beside nullable columns for the icon and the hue — a stored JSON value rather than a child table, because the corpus's convention carries a bounded list that is always read with its row inline, which the tool allowlist on that same table already does, and a binding is never queried across definitions. A definition from a provider's own file keeps in the store only what that file cannot hold — the icon, the accent and, for a Codex agent, its hooks and memory scope — attached to the file by its name and location, and the name index is unique per origin and scope.

**Two library readings are derived on the list reply.** How many workflows bind a definition is `workflowUsage`, a fold over the workflow definitions on the node, and when a definition was last used is `lastUsedAt`, a fold over the session runs and workflow runs that record their resolved-from definition. Both are computed per reply and never stored, so the card, the library's last-used order and the delete confirmation read figures that are true when they are drawn; where a source cannot be read, its reading is absent rather than zero.

**How a saved agent reaches a session.** The daemon hands every agent to each provider at launch in the session pack, under the `sidekicks` namespace; nothing here is a wire method. On Claude Code each agent rides the `agents` map of the process's `initialize` request under its namespaced name with every field of its record — its tools, model, effort, tool servers, hooks, turn cap and memory, and no permission mode, so every agent runs at the session's level — because Claude Code drops `hooks` and `mcpServers` from a plugin's agent file. That map is fixed for the process's life, so a save reaches a running Claude Code session by a resume at the session's next idle moment — no turn and no background task running — with the new map; several saves before that moment make one restart and one `conversation_reloaded` notice. On Codex a role file carries the agent, and what a role file cannot carry — its hooks, tool servers, sandbox and memory — rides the conversation's `thread/start` configuration, the hooks with their trust records and, for a helper the lead starts, gated on that helper's agent type, each handler kind Codex does not run filled by the daemon's command hook; a save reaches a running Codex session by forking the lead's conversation on the running service.
