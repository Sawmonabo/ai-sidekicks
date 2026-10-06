# API Payload Contracts

Typed payload definitions for all named interfaces across all specs. Each contract specifies request shape, response shape, and error shapes using TypeScript/Zod notation.

**Usage:** Implementation agents translate these definitions into Zod schemas in `packages/contracts/src/` when the shape crosses a boundary between independently built surfaces — the daemon, the desktop app, the CLI, the control plane, the relay, and the phone and web clients — or is a wire enum or schema. A shape this file marks daemon-internal or in-process lives in `packages/runtime-daemon`, and one only the control plane uses lives in the control plane's package; this file documents them beside the wire so a reader sees the whole seam. The organization by plan follows the build order recorded in [cross-plan-dependencies.md](../cross-plan-dependencies.md).

**Schema reference:** Column types and constraints are in [Local SQLite Schema](../schemas/local-sqlite-schema.md) and [Shared Postgres Schema](../schemas/shared-postgres-schema.md).

## Contracts By Area

The shapes are kept in one file per area, below. They and this index are one document: "this file" and "this document" in any of them mean all of them.

- [Session Payload Contracts](./session-payloads.md) — Plan-001: sessions, their reads and verbs, and the session method names
- [Remote Control Payload Contracts](./remote-control-payloads.md) — Plan-025: the control plane's bootstrap, machine registration, devices, the statement chain, push, terminal control and the relay
- [Local IPC Payload Contracts](./local-ipc-payloads.md) — Plan-005: the daemon's JSON-RPC method names, handshake, request ids and daemon control
- [Provider Driver Payload Contracts](./provider-driver-payloads.md) — Plan-003: the driver interface and the parameters and results of its operations
- [Provider Driver Capability Payload Contracts](./provider-driver-capability-payloads.md) — Plan-003: what a driver declares and reports: its session handle, models, modes, posture, callback tools, tool-server status, subagents, capabilities and tool metadata
- [Running Command Payload Contracts](./running-command-payloads.md) — the commands an agent started
- [Voice Payload Contracts](./voice-payloads.md) — dictation and spoken calls
- [Session Event Payload Contracts](./session-event-payloads.md) — Plan-004: the event envelope and the log reads
- [Run Control Payload Contracts](./run-control-payloads.md) — Plan-002: queue, steer, pause, resume and undo
- [Hosted Account Payload Contracts](./hosted-account-payloads.md) — Plan-015: the hosted account, its WebAuthn ceremonies and routes
- [Repo Payload Contracts](./repo-payloads.md) — Plan-006: repo attachment and workspace binding
- [Worktree Payload Contracts](./worktree-payloads.md) — Plan-007: worktree lifecycle and execution modes
- [Approval Payload Contracts](./approval-payloads.md) — Plan-009: approvals, permissions and trust boundaries
- [Gitflow Payload Contracts](./gitflow-payloads.md) — Plan-008: branches, diffs, pull requests and review
- [Artifact Payload Contracts](./artifact-payloads.md) — Plan-011: artifacts, files and attachments
- [Persistence Payload Contracts](./persistence-payloads.md) — Plan-012: persistence and recovery
- [Transcript Payload Contracts](./transcript-payloads.md) — Plan-010: transcript and reasoning reads
- [Attention Payload Contracts](./attention-payloads.md) — Plan-016: notifications and the attention model
- [Page-Host Payload Contracts](./page-host-payloads.md) — the Preview pane and the Browser page
- [Settings Payload Contracts](./settings-payloads.md) — which surface each Settings page reads and writes through
- [Orchestration Payload Contracts](./orchestration-payloads.md) — Plan-013: multi-agent orchestration
- [Workflow Payload Contracts](./workflow-payloads.md) — Plan-014: the workflow operations, events and method names
- [Workflow Document Payload Contracts](./workflow-document-payloads.md) — Plan-014: the node-graph document an author writes and a version stores
- [Workflow Builder And Runs Payload Contracts](./workflow-builder-and-runs-payloads.md) — Plan-014: the builder, the node catalog, the runs surface and workflow secrets
- [Rate Limit And Retention Payload Contracts](./rate-limit-and-retention-payloads.md) — Spec-019 rate limiting and Spec-020 data retention, export and deletion
- [MCP Governance Payload Contracts](./mcp-governance-payloads.md) — Plan-022: tool-server configuration and governance
- [Provider Account Payload Contracts](./provider-account-payloads.md) — Plan-023: provider accounts and credential homes
- [Agent Definition Payload Contracts](./agent-definition-payloads.md) — Plan-024: agent definitions and peer invocation

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

- `MethodRegistry` interface — `packages/contracts/src/jsonrpc/registry.ts`
- `LocalSubscriptionProducer<T>` streaming primitive — `packages/contracts/src/jsonrpc/streaming.ts` (the client-side consumer shape is `LocalSubscriptionConsumer<T>` at `packages/client-sdk/src/transport/subscription-consumer.ts`)
- `SecureDefaults` config + effective-settings — `packages/runtime-daemon/src/bootstrap/secure-defaults.ts`
- LSP-style streaming method-name taxonomy (`$/subscription/notify`, `$/subscription/end`, `$/subscription/cancel`) — `packages/contracts/src/jsonrpc/streaming.ts`
- `SessionEvent` discriminated-union schema — `packages/contracts/src/event/session.ts`
- The daemon's method and event map — the `DaemonMethod` union, the method-to-params and method-to-result maps (`DaemonParams`, `DaemonResult`) and the `DaemonEvent` union with its event-to-payload map (`DaemonEventPayload`), built from the contracts' own method descriptors — `packages/contracts/src/daemon/method-map.ts`. The preload bridge's `daemon.call` and `daemon.subscribe` are typed by it, and the renderer's daemon client takes its types from it rather than restating them.

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
type WorktreeId = string & { readonly __brand: "WorktreeId" }; // BranchContextId: worktree-payloads.md §Plan-007
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
// identical in error-contracts.md §Rate Limiting and packages/contracts/src/rate-limiter.ts, which
// Plan-018 T18.1-1 creates)
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
  // a child ended by a stop that reached several agents: final on Claude Code, resumable by a send
  // on Codex
  | "stopped"
  | "failed";
// A state the run does not leave on its own. A send into an `interrupted` run returns it to `running`
// with everything it knew, and so does a send into a `stopped` child on Codex
// ([Run State Machine §Definitions](../../domain/run-state-machine.md#definitions)).
type TerminalRunState = "completed" | "interrupted" | "stopped" | "failed";
type BlockingRunState = "waiting_for_approval" | "waiting_for_input" | "paused";
type RunFailureCategory =
  | "provider failure"
  | "transport failure"
  | "local persistence failure"
  | "projection failure"
  | "refused"; // the provider's safety check refused a turn and no other model could take it (Spec-005 §Run Lifecycle)

type QueueItemState = "queued" | "admitted" | "superseded" | "canceled" | "not_delivered";
type InterventionType = "steer" | "interrupt" | "faster_model_retry"; // Spec-003 §Required Behavior and Spec-004 §Required Behavior; ApplyInterventionParams (Plan-003 T1.8) carries the first two, and the daemon carries out `faster_model_retry` itself. Undo is `session.restore`, never an intervention
type InterventionState = "requested" | "accepted" | "applied" | "rejected" | "degraded" | "expired";

type ApprovalCategory =
  | "tool_execution"
  | "file_write"
  | "network_access"
  | "destructive_git"
  | "plan_approval"
  | "gate";
type ApprovalDecision = "approved" | "rejected";
type ApprovalState = "pending" | "approved" | "rejected" | "canceled";

// The five permission levels, most careful to least, in the one vocabulary every surface that names a
// level uses ([Spec-010 §Required Behavior](../../specs/010-approvals-permissions-and-trust-boundaries.md#required-behavior)).
// Only the first three ever raise an approval; at `sandboxed` and `yolo` the daemon answers every ask
// itself under the level's own posture. Plan is deliberately NOT a member: planning is a session's own
// mode, not a permission level, and the level still governs what a plan may read. A provider's own mode
// name never appears here — each level is one of that provider's own modes underneath, and the realized
// sandbox-and-network composition is `ExecutionPosture` in provider-driver-capability-payloads.md.
type PermissionLevel = "readonly" | "ask" | "reviewed" | "sandboxed" | "yolo";

// Where a session's work runs. `bound-root` works in the root already bound to the workspace — the
// project's own checkout, or a chat's managed workspace — and makes nothing; `provisioned-worktree`
// works in a new worktree the daemon's worktree lifecycle made for it. A session moves into another
// tree only through `session.setWorkingFolder`.
type ExecutionMode = "bound-root" | "provisioned-worktree";
// `preparing` covers both modes while the root is made ready (`repo.executionRootPrepare`); it is a
// different fact from the session state `provisioning` and never appears on screen.
type WorkspaceState = "preparing" | "ready" | "stale" | "archived";
type WorktreeState = "creating" | "ready" | "dirty" | "merged" | "retired" | "failed";
type RepoMountState = "attached" | "detached" | "archived"; // VcsType + RepoMountHealth: repo-payloads.md §Plan-006

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
  | "output_speed"; // declares a user-settable provider-side output-speed mode; BOTH pinned drivers declare it; detectionSource is PROBED on Claude Code, from the fast-mode state its `initialize` reply reports before any turn, and STATIC on Codex, where reading a returned tier as a speed tier is a judgment (Spec-004 §The output-speed axis). Claude realizes the axis through its own fast-output setting, `apply_flag_settings {fastMode}`, sent after every spawn and before a run that changes it; Codex realizes it through the person-settable `serviceTier` member — present in the default, non-field-gated generation — carried on thread establishment (`thread/start`), resume (`thread/resume`), fork (`thread/fork`) and each `turn/start`, against the speed tiers its model catalog publishes (`Model.serviceTiers`, `defaultServiceTier`, each tier `{ id, name, description }`, with a `Fast` tier carried in upstream source), behind the provider's own `features.fast_mode` gate and surfaced to the person as the composer's `Fast` / `Standard` control and the `/fast` word
// The executable union
// (packages/contracts/src/provider/driver/capabilities.ts) must export every member above, so no member is
// declarable in doc only. The shipped assertValidCapabilityFlags rejects
// any snapshot whose key count differs, so the union, the validator, the
// driver_capabilities.capability_flag CHECK in the one local schema and the conformance tests
// change together as ONE change or not at all.
```

---

## The Session Screen's Reads, By Region

An index, not a second contract: each region of the session screen, what it needs, and the operations that answer it, named as the session screen's design names them. It exists because the screen's regions cut across every plan section of the area files, and a builder reading one section cannot see that one region is served by several of them. The operations not built yet, with their members and owners, are listed in [§Operations Not Yet Built](#operations-not-yet-built); this table only names them.

| Region | What it needs | What answers it |
| --- | --- | --- |
| The sessions list and the palette | Every session grouped by shape, each with its name or first message, its state, its pin and mute marks and the exchange line while it trades messages; the project headers; a session's seen dot; a search across every session; the acts on a row | `session.list`, served live; `repo.projectList`, served live, for the project headers; `attention.seenUpdate` for the seen dot; `session.search`; `session.create`, `session.rename`, `session.pin`, `session.unpin`, `session.mute`, `session.unmute`, `session.archive`, `session.reactivate`, `session.close`, `session.convert` and `session.fork` for the acts |
| Session | Its id, name, shape, state, mute and goal; its project, worktree and base; the pending worktree move; its elapsed time and its ahead count; the unsent draft and the staged files; the spend rows by account; the snapshot count | `session.read` for the session's own facts — its shape, its mute, the pending move, the draft and the staged files among them — and `session.subscribe` for every change after it; `session.setWorkingFolder` to move it; `session.restart` for a provider process that ended; `repo.mountRead` and `repo.worktreeStatusRead` for the project, the worktree, the base and the ahead count; `orchestration.costReceiptRead`'s per-account axis for the spend rows; `session.snapshotList` for the snapshot count |
| The composer | The draft and its staged files, pictures, marks and resources; the `/` list; the `@` file search; the model, effort, speed, level, mode, goal and auto-compact controls and the context figure; the tool-servers list with its switches; the side question, `/review` and `/reload` | `session.draftUpdate`, `session.attachmentAdd` and `session.attachmentRemove`, with `preview.marksSend` for the marks chip; `session.providerCommandsSubscribe` for the `/` list; `session.fileSearch`; `session.mcpResourceList` for a server's resources; `session.mcpServerList` and `session.mcpServerUpdate` for the tool-servers list; `agent.configUpdate` for the model, effort, speed or provider, never the account, which is `providerAccount.setCurrent`; `session.permissionLevelUpdate`, `session.modeUpdate`, `session.goalUpdate`, `session.goalClear`, `session.autoCompactUpdate` and `session.contextSubscribe`; `session.sideQuestionAsk`, `session.reviewStart` and `session.definitionsReload`; `driver.listModes`, `driver.listModels`, `driver.listCapabilities` and `driver.compactContext` for what the provider offers and its compaction |
| The inspector | The session's memory, hooks, the rules in force, its artifacts, its cost and budget, and its snapshots | `session.memoryRead` and `session.autoMemoryUpdate`; `session.hookList`; `approval.ruleList` and `approval.ruleRevoke`; `artifact.list` and `artifact.read`; `orchestration.costReceiptRead` and `orchestration.budgetRead`; `session.maxStepsUpdate`, `session.spendLimitUpdate` and `session.tokensPerRunUpdate`; `session.snapshotList` |
| Undo | The dry run's files, lines and skipped files, the commands still running and the agents that would stop; the undo itself, in one of its three ways or to a named snapshot | `session.restorePreview`, then `session.restore` |
| Turns | The person's turns, the agent's prose, its reasoning, and the state-changing rows the console itself appends; a row's large body; a patch a call did not carry; the paths a reply names that open a file; the find box over history not yet loaded; code colors | `transcript.read`, and live rows on `session.subscribe`; `transcript.reasoningSurfaceRead`; `transcript.bodyRead`; `transcript.patchRead`; `transcript.pathResolve`; `transcript.search`; `highlight.read` |
| Tool runs | The verb, its target, its duration or live elapsed, a result summary, diff hunks, a failure mark, a held mark; a block by the provider's own reviewer, with its reason line and whether it can be allowed once | The same transcript rows, with the `approval.reviewer_denied` and `approval.denial_overridden` records on the blocked call's row; `command.list` for the ones still running |
| Child agents | Each child's id and parent, its model and, where it was a peer call, the agent that was asked (`via`), its state, activity, tools, tokens, spend and timer, its own rows and its stream; a child's steer, interrupt and pause, and the stop of a whole subtree | `orchestration.childRunLinkRead` and `agent.list` for the tree and its facts; `transcript.childRunExpand` for a child's rows; `run.subscribeState` for state; `run.childSteer`, `run.childInterrupt`, `run.childPauseSet` and `run.childrenStop` for the controls. The daemon's own paths call `orchestration.runCreate`; no region does |
| The pending messages and the run's controls | The messages waiting for the agent, their order and their edits, the lead's and each child's; the interrupt, the pause and its continue; the answer to a restart's mismatch | `run.subscribeQueue` and `run.queueList`; `run.queueCreate`, with `replacesQueueItemId` for an edit; `run.queueCancel` and `run.queueReorder`, each taking a child as well; `run.intervene` for the interrupt; `run.pause` and `run.resume`; `run.recoveryResolve` |
| Approvals, plans and questions | One pending request with its title, its summary, the child that raised it, and its answers; `Allow once` on an action the provider's own reviewer blocked at `Reviewed`; the plan card and its verdict; the question card and its answers | `approval.projectionRead`, answered by `approval.resolve`; `approval.denialOverride` for `Allow once`; `plan.resolve`; `question.resolve`. The daemon raises an approval request itself from a provider's callback, so no region calls `approval.requestCreate` |
| Worktrees | The per-project list with ahead, behind, dirtiness and occupancy; the root branch and the branches to cut from; the progress of the setup steps; removing a worktree, and the removed ones kept to put back | `repo.worktreeStatusRead`, whose worktree rows carry the candidate facts; `repo.branchList`; `repo.executionRootPrepare`, with `carryUncommitted`; `repo.worktreeSetupSubscribe` and `repo.worktreeSetupRetry`; `repo.worktreeRetire`; `repo.removedWorktreeList`, `repo.worktreeRestore` and `repo.removedWorktreeDelete` |
| Projects | Attaching a folder, from this machine or from another device; a converted chat's place in its project; cloning from an address, its progress, its questions and its large files | `repo.attach`; `repo.folderList` for another device's folder list; `repo.workspaceBind`; `repo.mountRead`; `repo.cloneFolderRead`, `repo.clone`, `repo.cloneSubscribe`, `repo.cloneAnswer`, `repo.cloneCancel` and `repo.largeFilesPull` |
| Review | The scope tabs, the base list, the files with their hunks, a file outside the diff, the commits, the pull-request form and state, its checks, logs and threads, the held notes, and staleness; the ship acts and their commands | `gitflow.branchContextRead` for the branch and what the pull-request form opens with; `repo.branchList` for the base list, in the one order both base lists share; `gitflow.diffRead` for the diff and the branch scope's commits; `repo.fileRead` for a file or a folded gap; `gitflow.gitActionPreview`, `gitflow.gitActionExecute` and `gitflow.gitActionSubscribe` for the ship acts; `gitflow.commitMessageGenerate` and `gitflow.changeRequestTextGenerate`; `gitflow.changeRequestSubscribe` for the request, its checks and its threads; `gitflow.reviewerList` and `gitflow.labelList`; `gitflow.reviewSubmit`, `gitflow.threadResolve` and `gitflow.threadReply`; `gitflow.checkLogRead`; `session.reviewNoteAdd`, `session.reviewNoteUpdate`, `session.reviewNoteRemove` and `session.reviewNoteList` for the held notes; `repo.workingTreeSubscribe` for the tree-staleness signal behind the reload |
| Terminal | The session's shells and their order; per-shell output; each shell's control lease | `pty.list`, served live; `pty.open`, `pty.close` and `pty.reorder`; `pty.outputSubscribe` for each shell's bytes; `pty.write` and `pty.resize` from the device holding the shell; `session.setTerminalFlowControl` for each watching connection's behind state; `session.takeControl` with the `pty.control_changed` broadcast, all keyed per shell. A device reads its own id from the connection handshake's reply, so it tells its own hold from another device's and from an agent run's |
| Commands | The running commands in the order they started — the command as the agent ran it, when it started, and the transcript row each belongs to; its output as it prints; its ending with a result and a duration; stopping it, moving it to the background, typing into it | `command.list`, served live, carrying the `command.output` frames, and the stored `command.ended` record; `command.stop`, `command.background` and `command.write` |
| Preview | The open pages with each one's address, title, icon, load state, zoom and whether its history has somewhere to go; the discovered dev servers; the machine the page runs on; the live picture on another device; the staged marks | `preview.pageList`, served live; `preview.pageOpen`, `preview.pageClose`, `preview.pageActivate`, `preview.pageReorder`, `preview.navigate` and `preview.zoom`; `preview.devServerList`, served live; `preview.screencastSubscribe` on another device; the staged marks live in the composer store until `preview.marksSend` sends them. The browser's saved-site verbs and the page host's own traffic are in [§Page-Host Method Registry](./page-host-payloads.md#page-host-method-registry) |
| Cloud tasks | The session's tasks sent to a provider's cloud, each one's last reported state and attempts, a ready attempt's diff, and bringing one back | `cloud.taskStart`; `cloud.taskList`, served live; `cloud.taskRead`; `cloud.taskDiffRead`; `cloud.taskApply`; the event `cloud.task_updated` |
| Voice | Dictation into the draft; a spoken call with the agent; the voices offered; which session voice is on in | `voice.dictationStart`, `voice.dictationWrite`, `voice.dictationStop` and `voice.dictationSubscribe`; `voice.callStart`, `voice.callStop` and `voice.callSubscribe`; `voice.voiceList`; `voice.stateUpdate` and `voice.stateSubscribe` |
| The working line | What the agent is doing, or Codex's own sentence while it holds a turn for a safety check; the elapsed clock, the tokens received this turn, the turn's state word, its task list, the warnings count and its list, and the connection state | `run.subscribeState` for the state and the activity, and for Codex's sentence (`run.safety_buffering_updated`); `turn.usage` for the tokens; `turn.tasks` for the list; the `session.notice` records of kind `provider_warning` for the warnings; the `daemon.status` topic on `daemon.subscribe` for the connection state |
| The bell and the notifications list | The count of what is waiting, one line per moment, and the moment a banner speaks for | `attention.projectionRead`, served live: the whole projection, then every change. Main settles each banner it posts with `attention.bannerSettle`; no region calls it |
| The service | Whether the background service answers, its liveness, and the flush before a quit | `daemon.status.read`; `daemon.ping`, main's liveness check; `daemon.flush` before a quit, which never stops the service; the boot card's `Retry` is the bridge's `daemon.requestStart()` |
| The preload bridge | How the renderer reaches the daemon, the machine and its own windows | `daemon.call` and `daemon.subscribe`; `native.copyToClipboard({text, html?})`, which writes the markdown and, on an agent's reply, its formatted flavor beside it in one clipboard write (main's `clipboard.write`); `native.revealInFileExplorer`, `native.showOpenDialog`, `native.getDroppedFileRef`, `native.savePastedImage`, `native.showSaveDialog`, `native.openExternal`, `native.openInEditor` and `native.openInTerminal`, each file operation taking or returning a `FilePathRef` token that main's relay turns into a path; `window.setAppearance`, `window.subscribeAppearance`, `window.setMinimumSize` and `window.subscribeToNavigationRequest` |

---

## Operations Not Yet Built

Every desktop ↔ backend operation below has its name, its owning spec and its owning plan, and none has a handler yet. A method's request and response schemas land in `packages/contracts` with the unit that builds it, and its row leaves this table when its handler ships. Where an area file already documents a method's payload, that section is the payload's home; this table is only the list of what is still to build. The members are the ones the design states; a method carried on the relay reaches the daemon the same way as one sent from the desktop app.

### `account.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `account.delete` | `sidekicks delete-account`: every refresh-token family revoked, then the hosted account's rows deleted in one transaction | [Spec-020](../../specs/020-data-retention-export-and-deletion.md) | [Plan-015](../../plans/015-hosted-account-and-identity.md) Phase 5 T5.5 |
| `account.export` | The hosted account's own records, for `Export all data`'s `hosted-account.json` | [Spec-020](../../specs/020-data-retention-export-and-deletion.md) | [Plan-015](../../plans/015-hosted-account-and-identity.md) Phase 5 T5.5 |
| `account.nameUpdate` | Change the caller's own display name; the request names no user | [Spec-016](../../specs/016-hosted-account-and-identity.md) | [Plan-015](../../plans/015-hosted-account-and-identity.md) Phase 4 T4.4 |
| `account.read` | The hosted account's id and display name, with no device presence | [Spec-016](../../specs/016-hosted-account-and-identity.md) | [Plan-015](../../plans/015-hosted-account-and-identity.md) Phase 4 T4.4 |

### `agent.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `agent.configUpdate`, settling with `agent.provider_binding_changed` or `agent.provider_binding_change_failed` | Switch a running agent's binding: model, effort or speed settles in place; a pick under the other provider switches provider at the run's end | [Spec-014 §Same-Agent Provider Switch](../../specs/014-multi-agent-orchestration.md#same-agent-provider-switch) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.1, T3.8, T2.8, T1.4 |
| `agent.definitionCreate` | Save a new definition (`New sidekick`, `Duplicate`) with `bindings`, `scope`, `icon`, `accentHue`, `turnCap`, `hooks` and `memoryScope` | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T2.2 |
| `agent.definitionDelete` | Delete a definition; discard an orphaned record | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T2.2 |
| `agent.definitionExport`, writing into the folder the dialog picked | Export one or many definitions, one Markdown file per definition, the account left out | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) Phase 2 T2.2 |
| `agent.definitionImport`, reading the folder the dialog picked | Import the folder's definition files: creates only, never overwrites, suffixes a colliding name, skips and lists every file that is not a definition | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) Phase 2 T2.2 |
| `agent.definitionList`, with reply members `workflowUsage` and **`lastUsedAt`** | Read the agent registry: every definition from every origin, the plugin origin read-only, `plugin · <name>`, from the daemon's plugin homes, each with `origin`, `scope`, `sourcePath`, `orphaned`, `disabledInProvider` (the provider has it switched off) and `loadError` (it failed to load, with the reason), each its own field and not one exclusive state, plus the agent's own `hooks` and `memoryScope` on every origin, `workflowUsage` and `lastUsedAt` (both derived per reply). A definition whose file names a provider this app doesn't run is listed: that binding carries `driverName` null and the name as `unsupportedProviderName`, both members always present; its provider chip reads `<name> · not supported here`. The agent card draws the orphaned state: set apart, the extras the record still holds, the last known path, `Reattach…` and `Discard`. One read serves the library, the composer's Sidekicks group, the workflow node's chooser and the pane's name/icon/color labels. | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T2.2 |
| `agent.definitionUpdate` | Save edits: rename, replace `bindings` whole, every core field; also reattach an orphaned record to a file. Refused with `agent.update_refused`, reason `plugin_read_only` (a plugin's agent) or `not_orphaned` (a reattach naming a record that is not orphaned) | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T2.2 |
| `agent.list` (a live list: the list, then each change, like `session.list`) | The session's agents, the lead and every child: binding, state, resolved-from definition, which provider runs it | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.1, T3.2 |
| `agent.definitionSubscribe` | Follow the agent registry: the whole `agent.definitionList` reply again each time a definition changes (a save, delete or import from any window; a provider's file added, changed or removed on disk; a plugin landing or leaving), so every open window's library, composer group and workflow chooser stay current | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) Phase 2 T2.2 |

### `approval.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `approval.projectionRead` | The pending asks for the approval card | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.2, T3.3 |
| `approval.resolve` | Answer an ask | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.1, T2.3 |
| `approval.ruleList` | The rules in force on the session | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.5 |
| `approval.ruleRevoke` | Revoke a rule | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.5, T3.4 |
| `approval.denialOverride {sessionId, denialId}`, recording `approval.denial_overridden`; the block itself is recorded as `approval.reviewer_denied {sessionId, runId, agentId, denialId, eventId, reason, overridable}` | `Allow once` on an action the provider's own reviewer blocked at `Reviewed`: the agent is told it may try that one action again, the row then reads `Allowed once` on every screen, and a press on a block already allowed is answered with the settled row | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.12; the provider leg in [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.33 |

### `artifact.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `artifact.list` | The session's artifacts | [Spec-012](../../specs/012-artifacts-files-and-attachments.md) | [Plan-011](../../plans/011-artifacts-files-and-attachments.md) T11.11 |
| `artifact.read {artifactId, version?, includePayload?, range?}` | One artifact's content, whole or one byte window at a time | [Spec-012](../../specs/012-artifacts-files-and-attachments.md) | [Plan-011](../../plans/011-artifacts-files-and-attachments.md) T11.1, T11.6 |

### `attention.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `attention.deliveryRead {}` → `{webAddress: {saved, host?, lastOutcome}, emailDigest: {passwordSaved, lastOutcome}}`, `lastOutcome` being `{at, result: delivered \| refused \| unreachable \| timedOut \| signInRefused \| notEncrypted \| notAnAddress, httpStatus?, undelivered}` or `null`; `attention.deliveryTest {channel: webAddress \| emailDigest}` → `{outcome}`; refusals `attention.delivery_store_unavailable` (`cause: locked \| unavailable`) and `attention.delivery_not_configured` (`missing: address \| password`) | What each delivery channel last did, and a test send for each | [Spec-017](../../specs/017-notifications-and-attention-model.md) | [Plan-016](../../plans/016-notifications-and-attention-model.md) T1.3, T3.3 |
| `attention.mailPasswordSave {password}` → `{}` and `attention.mailPasswordRemove {}` → `{}`; the digest's settings (`sendTo`, `mailServer?`, `port?`, `userName?`, `after: hour \| fourHours \| day`, default `day`) are keys in the machine settings file, which the service writes; `digested_at` on each attention entry | The email digest: `Email me what I have not seen`, at most one email per `After` period through the person's own mail account, its password kept as its own item in the operating system's credential store | [Spec-017 §Cross-Device Delivery](../../specs/017-notifications-and-attention-model.md#cross-device-delivery) | [Plan-016](../../plans/016-notifications-and-attention-model.md) T1.3, T3.5 |
| `attention.projectionRead`, served live: the whole projection, then every change; `attention.bannerSettle {entryId, state}`, main-only, a no-op once the entry is past `pending` | The bell's count and its list, one stable id per moment; main mirrors the count to the app icon and posts and withdraws the OS notification from the same projection, and while no main is connected the daemon's attention service starts the app windowless to post it | [Spec-017](../../specs/017-notifications-and-attention-model.md) | [Plan-016](../../plans/016-notifications-and-attention-model.md) T2.4, T1.2 |
| one entry on `attention.projectionRead` with trigger `workflow_notify`, its `momentId` from the run, node and execution index and its `stepId`, posted by main | The Notify node posts a notification | [Spec-017](../../specs/017-notifications-and-attention-model.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.18 |
| `attention.seenUpdate` {sessionId} | Mark a session seen (its done dot filled or hollow) | [Spec-017](../../specs/017-notifications-and-attention-model.md) | [Plan-016](../../plans/016-notifications-and-attention-model.md) T1.3, T2.4 |
| `attention.webAddressSave {address}` → `{host?, signingSecret?}`, `attention.webAddressSecretRotate {}` → `{signingSecret}`, `attention.webAddressRemove {}` → `{}`; the channel's switch and kinds are keys in the machine settings file, which the service writes; `webAddressState` (`pending \| delivered \| undelivered`) and `webAddressAttemptCount` on each attention entry, both present exactly when the entry is sent to a web address | The web address: `Send to a web address`, one signed message per moment of the kinds picked for it, the address and its signing secret each kept as its own item in the operating system's credential store | [Spec-017 §Cross-Device Delivery](../../specs/017-notifications-and-attention-model.md#cross-device-delivery) | [Plan-016](../../plans/016-notifications-and-attention-model.md) T1.3, T3.4 |

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
| event `cloud.task_updated` | A task's reported state changed | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31 |
| `cloud.taskApply {taskId, attempt?}` | Bring a task back | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31 |
| `cloud.taskDiffRead {taskId, attempt?}` | A ready Codex attempt's diff | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31 |
| `cloud.taskList {sessionId}` (live) | The session's cloud work, each a `CloudWork`: a `CloudTask` (`kind: task`, with attempts, `pending`, `ready`, `applied` or `error` with the provider's own message) or a `CloudSession` (`kind: session`, `submitted` for its whole life, with its `url` on the provider's site) | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31 |
| `cloud.taskRead {taskId}` | One task's last reported state and attempts | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31 |
| `cloud.taskStart {sessionId, prompt, environment?, attempts?}` → `{taskId}` | Send a message to the provider's cloud as a new cloud task. Refused with `cloud.unavailable`, reason `provider_sign_in_required`, `provider_subscription_required` or `github_remote_required`, with the session's `provider` | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.31 |

### `command.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `command.background` | `Move to background` | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.28 |
| `command.list` (subscription) | The running commands | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.28 |
| `command.stop` | Stop a running command; `Stop all commands` sends it once per command | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.28 |
| `command.write {sessionId, commandId, text?, endOfInput?}` | Typed input to a command that is waiting for it, and `End input` | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.28 |

### `controlPlane.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `controlPlane.call {procedure, input}`, on the service's local socket, answered with that procedure's output | The window's control-plane calls, which main forwards: the service holds every control-plane credential, attaches the hosted account's access token and signs each request's DPoP proof, so neither main nor the page holds one. `procedure` is one of the control-plane procedures the desktop's screens call (`device.list`, `device.linkStart`, `device.linkRedeem`, `device.link`, `device.linkCancel`, `device.rename`, `device.revoke`, `device.forget`, `device.statementList`, `device.pushAddressSet`, `runtimenode.rename` and `runtimenode.remove`); relay negotiation and any other procedure is refused under the code its contract registers | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-025](../../plans/025-remote-control.md) Phase 3 |

### `daemon.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `daemon.backupRead` → the last run, the folder, the total size, and each backup with its time, its size and the app version that wrote it | Read the backups: the last run, the folder, the total size and the list | [Spec-013 §Backup Policy](../../specs/013-persistence-and-recovery.md#backup-policy) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-13 |
| `daemon.backupStart`; events `backup.completed`, `backup.failed` and `backup.restored` on the daemon's sentinel session | `Back up now`, and the daily backup | [Spec-013 §Backup Policy](../../specs/013-persistence-and-recovery.md#backup-policy) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-13 |
| `daemon.configRead` | Read the machine-wide service settings: listener port, `Stop a run after`, `Ask me after one start leads to` as `workflowChainAskAfterRuns`, 25, 100, 500 or 2,000 runs or `null` for `Never ask`, `Max steps per turn`, `Spend limit`, `Tokens per run`, tool memory cap, the package cache limit, traces, raw provider messages | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-10 |
| `daemon.configUpdate` | Change one of those settings | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-10 |
| `daemon.crashList` → `reports`, newest first | Read the crash reports this machine keeps, for `sidekicks crash list` and a linked device | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-14 |
| `daemon.dataErase {}` | `Erase all data`: remove everything the app keeps on this machine, and the app's credential-store items | [Spec-020](../../specs/020-data-retention-export-and-deletion.md) | [Plan-019](../../plans/019-data-retention-export-and-deletion.md) T19.2.2 |
| `daemon.dataExport {destination}` → `{jobId}`; `daemon.dataExportSubscribe {jobId}`, acknowledged with the subscription and emitting `DataExportProgress` (`running {sessionsExported, sessionsTotal}` \| `completed {path, totalBytes}` \| `failed {message}`) | `Export all data`: everything this machine keeps for the person, as a readable folder | [Spec-020](../../specs/020-data-retention-export-and-deletion.md) | [Plan-019](../../plans/019-data-retention-export-and-deletion.md) T19.2.1 |
| `daemon.machineSettingsRead` | Read the machine's settings file; `machineSettings.read()` carries it | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-2-8, [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-11 |
| `daemon.machineSettingsUpdate {change}` → the file as written | Write a change to the machine's settings file; the service is the file's one writer, and `machineSettings.write(change)` hands the change here | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-2-8, [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-11 |
| `daemon.packageCacheClear {cache: bun \| uv \| all}` | Clear one package cache or both | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.14 |
| `daemon.packageCacheRead` | Read what each package cache holds: bun's, `uv`'s, and the time each was read | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.14 |
| `daemon.restart` | Restart the service | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-2, T-005r-1-4, T-005r-1-5 |
| `daemon.retentionPurge` | `Delete old data` | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md), [Spec-020](../../specs/020-data-retention-export-and-deletion.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-9 |
| `daemon.retentionRead` | Read the two retention bounds, `Keep sessions for` and `Keep diagnostic logs for`, and the counts `Delete old data` would remove | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md), [Spec-020 §Retention Policy](../../specs/020-data-retention-export-and-deletion.md#retention-policy) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-9 |
| `daemon.retentionUpdate` | Change a retention bound | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md), [Spec-020](../../specs/020-data-retention-export-and-deletion.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) Phase R1 T-005r-1-9 |
| `daemon.status.read` | The service's facts: its process as the system knows it (its id, the boot it runs in and the system's own record of its start), by which a client that found it running ends it and never a process that reused the id, version, start time, processor and memory with the time each was read, each `null` when its reading failed at that call, `recovery` (healthy, rebuilding, degraded or blocked), and `secretsFile`, the path of the file secrets are kept in, present only on Linux with no Secret Service and on a Mac while its secrets are in `secrets.json`, from the approved logged-out service's takeover until `sidekicks daemon uninstall` moves them back, including after that service is turned off in Login Items & Extensions, and never while the service waits for approval. `Check again` calls it again. | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-1, T-005r-1-3, T-005r-1-5 |
| `daemon.stop` | Stop the service (the confirm counts the Codex sessions typed in a terminal) | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-2, T-005r-1-4, T-005r-1-5 |
| `daemon.machineSettingsSubscribe` | Each written change to the machine's settings file, the first delivery being the current file; `machineSettings.subscribe()` carries it | [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-2-8, [Plan-005](../../plans/005-local-ipc-and-daemon-control.md) T-005r-1-11 |

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
| `driver.subscribeEvents {runId}` | Follow one run's driver activity as a stream of driver events | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T4.1, T4.4 |

### `git.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| event `git.settled`, cause `committed \| pushed \| pulled \| pull_request_opened \| review_posted` (`pulled {branch, commitId}`, `review_posted {requestNumber, verdict}`) | Durable record of a commit, a push, a pull, a pull request opened or a review posted | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-004](../../plans/004-session-event-taxonomy-and-audit-log.md) T1.12, [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.2, T8.4, T8.9 |

### `gitflow.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `gitflow.branchContextRead` | Branch and ship facts: uncommitted count, ahead/behind, pushed, open change request, pending merge/rebase/bisect with the command that ends it, default branch, the hosting service's name and its request word, pull request or merge request, whether the branch never left this machine, and everything the change-request form opens with | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.1 |
| `gitflow.changeRequestSubscribe {sessionId, depth: summary \| full}` | Live read of the open change request: state, can-merge, review decision, threads, checks | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.8 |
| `gitflow.changeRequestTextGenerate` | Generate change-request title and body | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.5 |
| `gitflow.checkLogRead` | A failing check's raw log | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.8 |
| `gitflow.commitMessageGenerate` | Generate a commit message | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.5 |
| `gitflow.diffRead` | Review's diff: Changes, Branch or Pull request scope against a base, the last two with their commits and narrowable to one commit; file kind words, binary, untracked, one whole patch per path | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.3 |
| `gitflow.gitActionExecute` | Ship acts: commit, push, pull, open change request (base, draft, reviewers, labels); retry from the failed command | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.3 |
| `gitflow.gitActionPreview {sessionId, act, formValues}` → `{commands}` | Show the exact commands an act will run, before the press | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.4 |
| `gitflow.gitActionSubscribe` | Per-command progress of a running ship act | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.4 |
| `gitflow.hostAdd {host}` | Add a host (checked; refused in place, nothing saved) | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) Phase 4 T8.7 |
| `gitflow.hostList` | List self-hosted git hosts | [Spec-009 §Git Hosting Adapter](../../specs/009-gitflow-pr-and-diff-attribution.md#git-hosting-adapter) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) Phase 4 T8.7 |
| `gitflow.hostRemove` | Remove a host | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) Phase 4 T8.7 |
| `gitflow.labelList` | Label candidates | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.8 |
| `gitflow.reviewSubmit` | Submit a review with a verdict | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.9 |
| `gitflow.reviewerList` | Reviewer candidates | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.8 |
| `gitflow.threadReply` | Reply on a thread | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.8 |
| `gitflow.threadResolve` | Resolve a thread | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.8 |

### `highlight.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `highlight.read` | Syntax color spans the daemon computes once per file and caches; every surface paints the spans it is handed | [Desktop App Implementation Notes §Console Libraries](../desktop-implementation-notes.md#console-libraries), [ADR-033](../../decisions/033-one-syntax-colorer-in-the-daemon.md) | [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-5-4 |

### `mcp.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `mcp.clearToolOverride` | Clear one facet of a per-tool override | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.4.3 |
| `mcp.get` | Read one server | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.2.4 |
| `mcp.list` | List MCP servers | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.2.4 |
| a `mcp.list` and `mcp.get` server entry reading `failed` carries `failedReason: commandNotRunnable` | A tool server whose command cannot run after a move | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.2.4 |
| `mcp.oauthLogin` | Sign in to a server (returns the sign-in URL; the app opens it) | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.5.1, T22.5.2 |
| `mcp.oauthLogout {serverId}` | Sign out of a server: delete the service's refresh token, and its signing key for a server that demands proof-of-possession tokens, and refuse every access token it handed out | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) Phase 5 T22.5.11 |
| `mcp.reconnect` | Reconnect a server | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.5.4 |
| `mcp.registrySearch {query, cursor?}` → `{servers: [...], nextCursor?}` | Search the public MCP Registry and fill `Add a server` from a result | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) Phase 3 T22.3.12 |
| `mcp.removeServer` | Remove a server | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.3.1, T22.3.4 |
| `mcp.setEnabled` | Turn a server on or off | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.3.3 |
| `mcp.setToolOverride` | Set a per-tool override | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.4.3 |
| `mcp.subscribe` | Follow server state | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.2.10 |
| `mcp.upsertServer` | Add or edit a server | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) T22.3.1, T22.3.4 |

### `orchestration.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `orchestration.budgetRead` | Per-agent spend, routed up the parent chain | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.4, T3.2 |
| `orchestration.childRunLinkRead` | The agent tree at every depth and each child's head (model, effort, via, tokens, spend, start time, ancestry); the badge's live, total and waiting figures | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.3, T3.2 |
| `orchestration.costReceiptRead` | The session's spend by provider and account | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.9, T2.12 |
| `orchestration.runCreate` | Admit a run under an agent | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.1, T2.2 |

### `plan.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `plan.resolve {planId, verdict, fresh?: {driverName, level}}` | Answer the plan card: keep, build, or build in a fresh session on the provider and level the person picked | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.10 |

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
| `presence.read {}` | Read the devices connected to this machine: each one's `deviceId`, `deviceType`, and whether an app window is in front on it (`appVisible`). It carries no liveness state and no last-seen time: a device is listed while it holds a connection to this machine, and a device card's `Connected now` and `Last seen` are `device.list`'s alone, read from the relay connection | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 5 |
| `presence.subscribe {}` | Follow the devices connected to this machine as they come and go | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 5 |
| `presence.heartbeat`, carrying `PresenceHeartbeat` (`deviceId`, `deviceType` and `appVisible`, and no session id) | A device tells the machine whether an app window is in front on it, a locked or sleeping screen counting as not in front, when that changes and otherwise every 15 seconds; the machine keeps the last one per device | [Spec-027](../../specs/027-remote-control.md) | [Plan-025](../../plans/025-remote-control.md) Phases 4 and 5 |

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
| `provider.list` | Provider status and the provider's own knobs. The status is `installed {rawVersion, parsedVersion?}`, `notInstalled` or `indeterminate`: `rawVersion` is the version as the command printed it, `parsedVersion` is present only where it parses, and a provider whose version does not parse still runs | [Spec-025 §Interfaces And Contracts](../../specs/025-provider-accounts-and-credential-homes.md#interfaces-and-contracts), [Spec-004 §Provider Parameter Vocabularies](../../specs/004-provider-driver-contract-and-capabilities.md#provider-parameter-vocabularies) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.4 |
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
| `providerAccount.remove` | Remove an account (refused with `provideraccount.account_in_use` while a run bound to it is live, naming those sessions) | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T2.3 |
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
| `pty.outputSubscribe` | A shell's live output: its scrollback at its last size, then followed live | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |
| `pty.reorder` | Reorder shell tabs; the order is held by the daemon | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |
| `pty.resize` | Resize a shell: only the device holding it sets its rows and columns | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |
| `pty.write` | Type into a shell; gated by the lease | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-8 |

### `question.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| the session's own question card, `question.asked` carrying the wait's `waitId`, answered by `question.resolve` | Wait-for-chat-reply: the person's answer resumes the step | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T3.3 |
| `question.resolve` | Answer an agent's question | [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T3.10 |

### `relay.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `relay.repin {spkiHash}` | `sidekicks relay repin --force`: accept the relay's new key after a refused pin; refused, changing nothing, when the hash does not match the key the relay presents | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md) | [Plan-025](../../plans/025-remote-control.md) Phase 3 |

### `repo.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `repo.attach` refused as `repo.folder_unreachable` | A folder picked in another distribution | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.1, T1.2, T2.3 |
| `repo.attach` | Attach a project folder (new-session picker, Settings › Projects) | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.1, T1.2, T2.3 |
| `repo.branchList` | Ordered branch list for both base pickers, with ↑/↓ figures and the tree holding each branch | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.7 |
| `repo.clone {url, parentFolder?, projectId?}` → `{projectId}`, a finished clone ending with the project in the live `repo.projectList` | Clone a repository from the address or path the person typed, which goes to git as typed; the session is minted at once and the finished folder attaches as `Open folder…` attaches one. Refused before anything is fetched with `repo.clone_refused`, reason `destination_not_empty` | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T2.2, T2.3 |
| `repo.cloneAnswer {projectId, questionId, answer}` | Answer git's question during a clone: a user name, a password or token, a key's passphrase, or whether to trust a host's key | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.8 |
| `repo.cloneCancel {projectId}` | Cancel a clone | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.8 |
| `repo.cloneFolderRead {}` → `{folder, source: setting \| lastProject \| home}` | Where a clone goes, and where that folder came from | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.8 |
| `repo.cloneSubscribe {projectId}` | The clone card's live state | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.8 |
| `repo.detach` | Delete a project, from Projects' `Delete` or Runtime's `Remove` on the project's folder (sessions and folder stay) | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md), [Spec-002](../../specs/002-machine-registration.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.5, T1.2, T2.3 |
| `repo.executionRootPrepare` (+ `carryUncommitted`) | New worktree from a base, optionally carrying uncommitted work | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.3, T1.2, T2.3 |
| `repo.fileRead` | Read a working-tree file not in the diff, and the lines inside a collapsed gap | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.3 |
| `repo.folderList {path?, filter?, showHidden?}` → the folder in view and every entry in it, each with its path, and `more: true` when the filter would narrow more; the service may page the entries or load them incrementally, and no folder is unreachable | The machine's folders, listed in place for another device | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.9 |
| `repo.largeFilesPull {projectId}` | Get the large files a clone left as placeholders when Git LFS was not installed | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.8 |
| `repo.mountList` | Every folder the service can reach, each with what is using it | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.2 |
| `repo.mountRead` | One mount's facts: its origin (`attached`, a project's folder; `managed`, a chat's workspace; `worktree`, a worktree the app made, under its project) and what uses it | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.2, T1.2, T2.3 |
| `repo.mountReattach {repoMountId}` → `{repoMountId}`, the new mount | The lost-folder banner's `Re-attach` on a mount reading `identity_mismatch` whose folder is still a git repository: ends that mount and attaches the folder fresh under the same project record, keeping the project's sessions and their workspaces. Refused with `repo.reattach_refused`, reason `identity_matches`; `repo.root_resolution_failed`, reason `not_a_repository`; `repo.already_attached`, drawn `Could not re-attach: <folder> is already attached to <project>`; or `repo.reattach_conflict` while an agent runs anywhere in the project, drawn `Could not re-attach while <agent> is running. Stop the run first.` | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.11 |
| event `repo.mount_health_changed {repoMountId, health}` | A mount's health as the re-probe changes it, on the stream of every session on that mount; with `repo.mountRead`'s health, the session's lost-folder banner | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md), [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.10 |
| `repo.projectArchive` | Archive a project | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.7 |
| `repo.projectBranchPatternUpdate {projectId, pattern \| null}` | Set or clear a project's own branch-name pattern (`Every project`'s pattern is a key in the machine's settings file, written through `daemon.machineSettingsUpdate`) | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.7 |
| `repo.projectEnvironmentUpdate` | Save a project's own environment rows (the machine-wide rows go through `daemon.machineSettingsUpdate`) | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.7 |
| `repo.projectList` | List projects (name, folder, session count, and the running / waiting / done tally of its sessions, counted by the daemon and never by the renderer), live | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.7 |
| `repo.projectList` and `repo.mountList` rows carry `onOtherSideDisk: boolean` | A project or worktree folder on the other side's disk | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.2, T3.7 |
| `repo.projectReactivate` | Unarchive a project | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.7 |
| `repo.projectRename` | Rename a project | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.7 |
| `repo.projectSetupUpdate` | Save a project's worktree setup steps | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md), [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) Phase 3 T3.7 |
| `repo.removedWorktreeDelete {removedWorktreeId}` | Delete a kept worktree now | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.9 |
| `repo.removedWorktreeList {projectId?}` → rows `{removedWorktreeId, projectId, name, branch, headCommit, removedAt, sizeBytes, sizeReadAt}` | The kept worktrees, for Runtime | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.9 |
| `repo.workingTreeSubscribe` | Tree-staleness signal from the watch on the working folder (watch or slow-tick mode) | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.10 |
| `repo.workspaceBind` (+ `executionMode`) | Bind a session to its project and where it works — a worktree of its own, or the checkout the project already has — on convert; a new session binds in `session.create`'s own step | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.1, T1.3, T2.4 |
| `repo.worktreeRestore {removedWorktreeId}` → `{outcome: restored, worktreeId, path, branch, onNewBranch}` or `{outcome: refused, refusal}`, `refusal` being `project_not_attached`, `repository_missing {path}` or `name_taken {name}` | Put a kept worktree back | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.9 |
| `repo.worktreeRetire {worktreeId, discard}` | Remove a worktree, from the switcher or from Runtime's `Remove` on an app-made worktree | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.4, T1.2, T2.2 |
| `repo.worktreeSetupRetry` | Retry setup from the failed step | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.10 |
| `repo.worktreeSetupSubscribe` | Setup progress per step, surviving leaving the session | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.10 |
| `repo.worktreeStatusRead` (keyed by project) | Worktree switcher list: repo-root row plus each worktree with base, ahead/behind, dirty count, occupying sessions, `countsAsOf`; project-wide | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.4, T1.2, T2.4 |

### `run.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `run.childInterrupt` {targetRunId, childHandle, expectedRunVersion, clientIdempotencyKey, deliverFirst?} | Interrupt one named child; with `deliverFirst`, a pending row's `Send now` | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T3.12 |
| `run.childPauseSet` {targetRunId, childHandle, paused, expectedRunVersion, clientIdempotencyKey} | Pause one named child, and continue it (the toggle's two presses) | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T3.12 |
| `run.childSteer` {targetRunId, childHandle, content, expectedRunVersion, clientIdempotencyKey}; `run.queueList`, `run.subscribeQueue`, `run.queueCancel` and `run.queueReorder` take `childHandle` too | Steer one named child: its box, onto the child's own queue held by the daemon, with pending rows taking the lead's four actions: reorder, `Edit`, `Remove` and `Send now` | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.1, T2.3 |
| `run.childrenStop` {runId} | Stop every running child at every depth (`Stop all running`, and the child half of `Interrupt everything`, whose lead half is `run.intervene`) | [Spec-003](../../specs/003-queue-steer-pause-resume.md), [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T3.12 |
| `run.intervene` {type: "interrupt"} | `Interrupt` the lead (Escape or the word): pending messages go as the next turn, and a live exchange ends on both sides | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.2, T2.4; [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) |
| `run.pause` | `Pause` | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.6, T3.3 |
| `run.queueCancel` | Remove a pending message | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.1, T2.3 |
| `run.queueCreate`, with `replacesQueueItemId` for an edit | Send: one Send to the lead; the skills picked from the `/` and `$` list, each by its name and folder; pending rows; `Retry`; `Edit` replaces a queued item in place in one call, the old item reading `superseded`, and is refused once the agent has taken the message; reorder is `run.queueReorder` | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.1, T2.1 |
| `run.queueCreate` with an addressee member `to` | The person writes to another session with `@name` from the composer | [Spec-003](../../specs/003-queue-steer-pause-resume.md), [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.1, T2.1 |
| `run.queueList` | The pending messages | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.1 |
| `run.queueReorder {sessionId, childHandle?, queueItemIds}` | Reorder the waiting messages: one daemon-held order over the items still waiting, on the lead's queue or a child's | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T2.9 |
| `run.recoveryResolve {runId, choice: keep_provider \| undo_to_agreed \| continue_provider \| hand_over}`, event `run.recovery_resolved` | After a restart, settle a mismatch between the session's record and the provider's: a read-only surplus is added with no question, and any other asks with two named choices | [Spec-013](../../specs/013-persistence-and-recovery.md) | [Plan-012](../../plans/012-persistence-and-recovery.md) T12.5 |
| event `run.recovery_steps_added` {sessionId, runId, count, provider} | After a restart, a part of the provider's own record that the service never wrote down, and that only read, was added to the transcript as the provider recorded it, and the session continued; drawn as one faint row | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-012](../../plans/012-persistence-and-recovery.md) T12.5 |
| `run.refusalChoiceResolve {runId, choice: retry_fallback \| edit_prompt}`, events `run.refusal_choice_requested {sessionId, runId, refusedModel, fallbackModel, sentence?, safetyCategory?, retractedMessageIds?}` and `run.refusal_choice_resolved {sessionId, runId, choice: retry_fallback \| edit_prompt \| canceled, deviceId?}` | Claude Code's retry-or-edit choice when its safety check refuses a turn and names a fallback model: `Edit message` then `Retry on <fallback model>` on the `Refused` row, the run `waiting_for_input` until the first answer; an `Interrupt`, or a message sent while it waits, answers `canceled`, and the retracted messages leave the flow on the answer. A second or late answer is refused with `run.invalid_transition` (409), and the device that answered second closes its row with no error | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md), [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md), [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.37; [Plan-010](../../plans/010-transcript-and-reasoning.md) T4.17 |
| `run.usageCreditsChoiceResolve {runId, choice: switch_default \| consent}`, events `run.usage_credits_choice_requested {sessionId, runId, modelName, overagesEnabled, balanceCents?, currency?, fallbackModel?}` and `run.usage_credits_choice_resolved {sessionId, runId, choice: switch_default \| consent \| interrupted \| unanswered, deviceId?}` | Claude Code's switch-or-credits choice when a Fable turn needs usage credits: `Switch to <model>` and, only while usage credits are on, `Continue on usage credits` on one row under Claude Code's own title, the run `waiting_for_input` until the first answer; an `Interrupt` or an undo interrupts the turn and answers nothing (`interrupted`), and a message sent while it waits is settled by Claude Code itself (`unanswered`). A second or late answer is refused with `run.invalid_transition` (409), and the device that answered second closes its row with no error | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md), [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md), [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.39; [Plan-010](../../plans/010-transcript-and-reasoning.md) T4.18 |
| `run.resume` | The second press of `Pause`, which continues | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.6, T3.4 |
| event `run.safety_buffering_updated` {sessionId, runId, turnId, active, fasterModel?}, relayed live on `run.subscribeState` and never kept | Codex's own sentence in the working line's action words while Codex holds a turn for a safety check; no flow row | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) |
| `run.subscribeQueue` | The queue stream | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T2.10 |
| `run.subscribeState` | The run-state stream: state slot, activity, the row dots | [Spec-003](../../specs/003-queue-steer-pause-resume.md) | [Plan-002](../../plans/002-queue-steer-pause-resume.md) T1.3, T2.10 |

### `session.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| event `session.advisor_changed` | A Claude Code session's own advisor changed by `/advisor` in that session; every Claude Code process started for it reads the new value | [Spec-001](../../specs/001-session-core.md), [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.27 |
| `session.archive`, event `session.archived` | Archive a session; its provider process stays as it was, and sleeps when idle as any session's does | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.5 |
| `session.attachmentAdd` | Stage a file: copied to the daemon at staging time and kept outside the checkout; also stages an MCP resource (Preview's marks chip is `preview.marksSend`'s) | [Spec-001](../../specs/001-session-core.md), [Spec-012](../../specs/012-artifacts-files-and-attachments.md) | [Plan-011](../../plans/011-artifacts-files-and-attachments.md) T11.10 |
| `session.attachmentCover {attachmentId, boxes: [{x, y, width, height}]}` → the new attachment | Cover part of a staged picture before Send | [Spec-012](../../specs/012-artifacts-files-and-attachments.md) | [Plan-011](../../plans/011-artifacts-files-and-attachments.md) T11.9 |
| `session.attachmentRemove` | Unstage a file with a chip's `×` | [Spec-012](../../specs/012-artifacts-files-and-attachments.md) | [Plan-011](../../plans/011-artifacts-files-and-attachments.md) T11.10 |
| `session.autoCompactUpdate` | This session's own auto-compact point (slider, `/autocompact`) | [Spec-011 §Context Window and Compaction](../../specs/011-transcript-and-reasoning.md#context-window-and-compaction) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T3.8 |
| `session.autoMemoryUpdate` | The `Auto memory` switch | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md), [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.30; [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-5-4 |
| event `session.branch_changed` | A branch changed outside the app is written back to the session | [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.10 |
| `session.close`, event `session.closed` | Close a session; its provider leg ends with it (on Codex its commands and conversations, the account's service keeping on), and the session sits in the `Archived` group, dimmed, with `Closed` where `Unarchive` would be, readable and searchable until `Delete old data` purges it and counts it in its confirm | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.5 |
| `session.contextSubscribe` | What fills the context: one read feeds the ring and the inspector's section | [Spec-011 §Context Window and Compaction](../../specs/011-transcript-and-reasoning.md#context-window-and-compaction) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T3.7 |
| `session.convert` {sessionId, repo path}, event `session.converted` | Convert a chat to a project: attach, copy the files in, skip paths the repo already has, keep the workspace, send the agent a note | [Spec-001 §Required Behavior](../../specs/001-session-core.md#required-behavior) | [Plan-001](../../plans/001-session-core.md) T6.7; [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.6 |
| `session.create` with `leadDefinitionId` and **`scratch: true`** → `resolvedConfiguration`; session record member **`scratchForDefinitionId`** | Try it, step 1: start the scratch session (no repo) whose lead is the definition, and get the resolved-binding echo. Reuse the open one if it exists. | [Spec-001](../../specs/001-session-core.md), [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3; [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) Phase 3 |
| A step of `session.create`, and of `session.fork` for a chat, done by the daemon's managed-workspace service | Create the chat's git-initialized managed workspace at `<home>/.ai-sidekicks/workspaces/<session-id>` and register it as a mount with a managed origin | [Spec-001](../../specs/001-session-core.md), [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3; [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) |
| `session.create` | Create a session with the lead's model and effort and, in a project, a `binding` naming the project and where it works (a worktree of its own or the project's checkout, `executionMode`: `provisioned-worktree` or `bound-root`), bound in the same step; a chat's managed workspace is made and registered as a mount in the same step; the created record names the lead | [Spec-001 §Interfaces And Contracts](../../specs/001-session-core.md#interfaces-and-contracts) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3 |
| `session.definitionsReload` | `/reload`: refresh agent and skill definitions by hand | [Spec-026](../../specs/026-agent-definitions-and-peer-invocation.md) | [Plan-024](../../plans/024-agent-definitions-and-peer-invocation.md) T3.6; [Plan-026](../../plans/026-skills.md) Phase 3 |
| `session.fileSearch` {query} | `@` file search in the working folder | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.9 |
| `session.fork`; the parent is recorded on the new `session.created` | Fork a session from a message anchor (a chat fork gets its own managed workspace) | [Spec-001 §Required Behavior](../../specs/001-session-core.md#required-behavior) | [Plan-001](../../plans/001-session-core.md) T2.2, T3.3 |
| `session.goalClear`, event `session.goal_cleared` | `/goal clear` | [Spec-014 §Session Goals](../../specs/014-multi-agent-orchestration.md#session-goals) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.1, T2.6, T1.2 |
| `session.goalUpdate` | `/goal <condition>` sets or replaces the goal | [Spec-014 §Session Goals](../../specs/014-multi-agent-orchestration.md#session-goals) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.1, T2.6, T1.2 |
| `session.groupCreate {sessionId, name}` → `{groupId}`, `session.groupMove {sessionId, groupId \| null}`, `session.groupRename {groupId, name}`, `session.groupUngroup {groupId}`; `groupId` on `session.create` | The person's session groups: `New group…`, `Move to group` and a drag in and out, `Rename group…`, `Ungroup`, `New session in group` | [Spec-001 §Groups, Links And Tags](../../specs/001-session-core.md#groups-links-and-tags) | [Plan-001](../../plans/001-session-core.md) T6.15 |
| `session.hookList` | Inspector `Hooks` section, `{sessionId, provider, kind}` discriminated on `kind`, with `provider` as data: `loadedHooks` carries `folders`, each a `ProviderHookSource`: the hooks (`SessionProviderHook`) a provider reports it loaded, per folder with that folder's errors and warnings (Codex `hooks/list {cwds}`); `hookFiles` carries `files`, the files a provider that reports none reads hooks from (Claude Code). The daemon's own hooks are never listed | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md), [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.30; [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-5-4 |
| `session.import` | Start an import | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.6 |
| `session.importPreview` | Count the projects an import would attach before it runs | [Spec-025 §Interfaces And Contracts](../../specs/025-provider-accounts-and-credential-homes.md#interfaces-and-contracts) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.6 |
| `session.importStop` | Stop an import | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.6 |
| `session.importSubscribe` | Follow an import's progress | [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) Phase 4 T4.6 |
| `session.linkAdd {sessionId, targetSessionId}`, `session.linkRemove {sessionId, targetSessionId}` | `Link a session…` and `Unlink` on the inspector's `Related` section; only a `related` link is removed | [Spec-001 §Groups, Links And Tags](../../specs/001-session-core.md#groups-links-and-tags) | [Plan-001](../../plans/001-session-core.md) T6.15 |
| `session.list` | The sessions list: rows grouped by shape, each a title and a state, with archived and closed sessions in the `Archived` group; live. Each entry carries `activity` (`running`, `waiting`, `done`, `failed` or `idle`) and `activityRenewedAt`: the daemon republishes a quiet run's entry every 15 s, and a reader treats a `running` or `waiting` reading older than 45 s as `idle` and never ages a `failed` one | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.2 |
| `session.maxStepsUpdate` | This session's own `Max steps per turn` override | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.11, T3.1 |
| `session.spendLimitUpdate` | This session's own `Spend limit` | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.4, T3.1 |
| `session.tokensPerRunUpdate` | This session's own `Tokens per run` | [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T2.4, T3.1 |
| `session.mcpResourceList {sessionId, serverName}` → `{serverName, resources, complete}` | A server's resources for `Attach a resource…`; the pick stages through `session.attachmentAdd` | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) Phase 5 T22.5.12 |
| `session.mcpServerList {sessionId}` (a live list) | This session's tool servers, live, grouped by state | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) Phase 5 T22.5.12 |
| `session.mcpServerUpdate {sessionId, serverName, enabled}` | A per-session on/off switch for one server | [Spec-024](../../specs/024-mcp-server-configuration-and-governance.md) | [Plan-022](../../plans/022-mcp-server-configuration-and-governance.md) Phase 5 T22.5.12 |
| `session.memoryRead` | Inspector `Memory` section: the memory paths and the account's own store | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md), [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.30; [Plan-020](../../plans/020-desktop-app-and-renderer.md) T-020r-5-4 |
| `session.modeUpdate {sessionId, mode: build \| plan}` | The Build or Plan mode chip | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md), [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.27 |
| `session.mute {sessionId}` and `session.unmute {sessionId}` → `{}`, events `session.muted {sessionId, at}` and `session.unmuted {sessionId, at}`; `muted` on `session.list` and `session.read` entries | Mute and unmute a session's notifications; held by the daemon, seen by every device | [Spec-017](../../specs/017-notifications-and-attention-model.md), [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3; [Plan-016](../../plans/016-notifications-and-attention-model.md) |
| event `session.notice` of kind `fast_output_unavailable` {sessionId, kind, reason?} | One flow row: fast output is not on for a turn that asked for it; the speed control reads `Standard` | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md), [Spec-021](../../specs/021-desktop-app-and-renderer.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.21 |
| event `session.notice` of kind `level_unavailable` {sessionId, kind, level} | One flow row, `Reviewed isn't available on this Claude Code account`, on a session an account switch moved to `Ask` | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md), [Spec-025](../../specs/025-provider-accounts-and-credential-homes.md) | [Plan-023](../../plans/023-provider-accounts-and-credential-homes.md) T3.3 |
| event `session.notice` of kind `provider_missing` {sessionId, kind, provider, placeHasNeitherProvider} | One flow row naming the missing provider, opening Settings › Providers on its section, or `Choose where Claude Code and Codex are installed` opening the place row | [Spec-001 §Fallback Behavior](../../specs/001-session-core.md#fallback-behavior) | [Plan-001](../../plans/001-session-core.md) T6.17 |
| event `session.notice` of kind `provider_updated` {sessionId, kind, provider, fromVersion, toVersion} | The banner under the header, `Restart the session` beside it; no flow row | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md), [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.43 |
| event `session.notice` of kind `provider_warning` {sessionId, kind, source: warning \| deprecation, text, details?} | The working line's `⚠ N warnings` word and its list, in Codex's own words; no flow row | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) |
| `session.overviewRead {afterRevision}` → `{revision, sessions: [{id, title?, provider, state, agents: [{name, provider, state}]}], remoteControl: {state: on \| off}}` | The terminal pane's held read: every session with its agents and Remote Control's state, answered once the sessions list or any session's agent list moves past `afterRevision`, or after 10 s with nothing changed; `title` is absent while a session is untitled, and the next read sends `revision` back as `afterRevision` | [Spec-001](../../specs/001-session-core.md), [ADR-035](../../decisions/035-claude-code-mods-are-an-optional-terminal-bridge.md) | [Plan-001](../../plans/001-session-core.md) T6.14 |
| `session.permissionLevelUpdate {sessionId, level: readonly \| ask \| reviewed \| sandboxed \| yolo}` → `{sessionId, level}` | The permission level chip | [Spec-010](../../specs/010-approvals-permissions-and-trust-boundaries.md) | [Plan-009](../../plans/009-approvals-permissions-and-trust-boundaries.md) T3.11 |
| `session.pin` and `session.unpin`, events `session.pinned` and `session.unpinned` | Pin and unpin a session inside its group, pin order kept; held by the daemon | [Spec-001 §Required Behavior](../../specs/001-session-core.md#required-behavior) | [Plan-001](../../plans/001-session-core.md) T6.6 |
| `session.providerCommandsSubscribe` | The live `/` list: the process's slash commands plus each working server's prompts | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T4.9 |
| `session.relatedList {sessionId}` (a live list) | The inspector's `Related` section: the linked sessions, highest relevance first | [Spec-001 §Groups, Links And Tags](../../specs/001-session-core.md#groups-links-and-tags) | [Plan-001](../../plans/001-session-core.md) T6.15 |
| `session.reactivate`, event `session.reactivated` | Unarchive a session; a closed session offers no `Unarchive` | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.5 |
| Field `shape: "chat" \| "project"` on the session record, read through `session.read` and `session.list` | The durable shape column: chat or project | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3 |
| The `shape: "chat"` field on `session.read`; no read of its own | The strip's `Session workspace` label | [Spec-007](../../specs/007-repo-attachment-and-workspace-binding.md) | [Plan-006](../../plans/006-repo-attachment-and-workspace-binding.md) T3.6 |
| `session.read` | One session's facts: title, shape, state, project, worktree, base, elapsed time, ahead count, snapshot count, pending folder move, address, draft and staged files, lead binding | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T2.1, T3.3 |
| `session.rename`, event `session.renamed` | Rename a session | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.4 |
| `session.restart` | Restart a provider process that ended, or restart after a provider update | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.29 |
| `session.restore`; result `requested`, `restored`, per-part `conversation` and `files` failures, and `reason`; a `resend` member makes Edit and resend one call, and a call carrying `resend` takes the scope `conversation-and-files`, and `includeAlsoChanged: boolean`, false unless the ask's include line was pressed, puts back the dry run's `alsoChangedBy` paths too | Undo: conversation and files, conversation only, or files only | [Spec-013](../../specs/013-persistence-and-recovery.md) | [Plan-012](../../plans/012-persistence-and-recovery.md) T12.7 |
| `session.restorePreview` {sessionId, target: a message's cursor or a snapshot id, scope} | Undo's dry run: files, lines, skipped files with reasons, the lines on what is not put back, the running commands, the commands that ran uncovered, which agents would stop and whether they can resume | [Spec-013](../../specs/013-persistence-and-recovery.md) | [Plan-012](../../plans/012-persistence-and-recovery.md) T12.7 |
| `session.reviewNoteAdd` | Add a held review note | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.9 |
| `session.reviewNoteList` | The session's notes, live, each with `stranded` computed against the current diff | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.9 |
| `session.reviewNoteRemove` | Discard a note | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.9 |
| `session.reviewNoteUpdate` | Edit a note | [Spec-009](../../specs/009-gitflow-pr-and-diff-attribution.md) | [Plan-008](../../plans/008-gitflow-pr-and-diff-attribution.md) T8.9 |
| `session.reviewStart` {target: working tree, staged, or branch} | `/review [target]` | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.27 |
| `session.search` | Search across sessions | [Spec-001](../../specs/001-session-core.md) | [Plan-001](../../plans/001-session-core.md) T6.9 |
| `session.setTerminalFlowControl` {sessionId, terminalId, paused} | Flow control to the shell's process, per shell and per watching connection | [Spec-002](../../specs/002-machine-registration.md) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-7 |
| `session.setWorkingFolder` | Move the working folder; re-targeting the current folder is the cancel; the pending intent sits on the session row | [Spec-001](../../specs/001-session-core.md), [Spec-008](../../specs/008-worktree-lifecycle-and-execution-modes.md) | [Plan-001](../../plans/001-session-core.md) T6.10; [Plan-007](../../plans/007-worktree-lifecycle-and-execution-modes.md) T3.1 |
| `session.sideQuestionAsk {sessionId, question}` → `{sideQuestionId}` | `/btw`: a side question on a throwaway copy | [Spec-011](../../specs/011-transcript-and-reasoning.md), [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.27 |
| `session.snapshotList` | List snapshots in the inspector | [Spec-013](../../specs/013-persistence-and-recovery.md) | [Plan-012](../../plans/012-persistence-and-recovery.md) T12.6 |
| `session.takeControl` {sessionId, terminalId, force?}, event `pty.control_changed` (with `holderRunId`) | Take one shell's lease, ordinary or forced; there is no release | [Spec-002 §Required Behavior](../../specs/002-machine-registration.md#required-behavior) | [Plan-021](../../plans/021-rust-pty-sidecar.md) T-021-3B-3 |
| `session.tagAdd {sessionId, tag}`, `session.tagRemove {sessionId, tag}`, `session.tagList {}` → `{tags}` | The `Tags` line on the inspector's Identity: `Add tag`, which suggests the tags in use, and a chip's remove; a tag with a space is refused | [Spec-001 §Groups, Links And Tags](../../specs/001-session-core.md#groups-links-and-tags) | [Plan-001](../../plans/001-session-core.md) T6.15 |
| `session.terminalProviderSessionList {}` | Name the provider sessions typed in a terminal that are inside a provider's shared service, each a `TerminalProviderSession` with `provider` as data, working, idle or not reachable | [Spec-006](../../specs/006-local-ipc-and-daemon-control.md), [Spec-014](../../specs/014-multi-agent-orchestration.md) | [Plan-013](../../plans/013-multi-agent-orchestration.md) T3.2 |

### `skill.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `skill.availabilityUpdate` | Set a skill's switch on each provider, written through that provider's own per-session off switch; a skill may be off everywhere | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phases 2, 6 |
| `skill.callFormRead {name, scope?, projectId?, skillId?}` → `{callForms, collision}`, `collision` being `{skillId, scope, folderPath, callForms}` or `null` | The name a typed skill of ours would be called by on each provider, and the other folder of ours it collides with, one global and one project, with what that folder is called by once this one is saved; read while the name is typed, derived by the session pack's own code; it refuses only a request its schema refuses, a name that is empty or too long, or a `projectId` present without the project scope or missing on it | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phases 3, 5 |
| `skill.create` | Create a skill folder under `.ai-sidekicks/skills`, global or project, name folded, collision suffixed, on both providers; a name another folder of ours already packs under at the other place is not refused: the screen warns of it from `skill.callFormRead` while the name is typed, and the one save writes | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 2 |
| `skill.fileRead` | Read one file's body | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 5 |
| `skill.list` | List every skill folder across every origin, the read-only plugin origin `plugin · <name>` among them: its id (`skillId`, kept through a rename made in the app, the folder's address `#/skills/<id>`), origin, scope, folder path, front-matter name and description, the file list (path, size, readable or not), availability, icon, call form per provider, and the facts it shares with `agent.definitionList` under the same spellings: `orphaned`, `disabledInProvider`, `loadError`. The skill row draws the orphaned state: set apart, the extras the record still holds, the last known path, `Reattach…` and `Discard` | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phases 1, 3, 4, 6 |
| `skill.recordDiscard` | Discard an orphaned skill record | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 2 |
| `skill.recordReattach` | Reattach an orphaned skill record (availability and icon) to a folder picked with the platform's chooser, taking its token, accepted only while the record is orphaned | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 2 |
| `skill.scan` | The widening scan over every file in the folder: each file that names another provider's tools, the tool names as words, and for each tool what will happen instead on the target provider, in words; stores nothing | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phases 2, 6 |
| `skill.subscribe` | Follow the skill list: the whole `skill.list` reply again each time a save from any window or the daemon's watch over the origins changes it, so the Skills screen and the composer's Skills group stay current | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 2 |
| `skill.update` | Save a folder whole (front matter, bodies, files added, renamed or removed, icon), for ours and for a provider's own folder in place; a new name renames a folder of ours, refused as `skill.name_taken` (`folderPath`) when another folder of ours holds it in the same place; a name another folder of ours already packs under at the other place, one global and one project, is not refused: the screen warns of it from `skill.callFormRead` while the name is typed, and the one save writes | [Spec-029](../../specs/029-skills.md) | [Plan-026](../../plans/026-skills.md) Phase 2 |

### `transcript.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `transcript.bodyRead` {sessionId, rowId} | A row's large body or whole output, read only when its control is pressed | [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T3.4 |
| `transcript.childRunExpand` | A child's rows, fetched on demand, including a finished child's stored record | [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T1.4, T3.1 |
| `transcript.patchRead` {sessionId, toolCallId} | Every patch a call did not carry, in one read | [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T3.5 |
| `transcript.pathResolve` {sessionId, paths} | Which paths a reply's prose names are real files inside the session's workspace, each with the line and column the reply named, so only those draw as links; `{paths: [{path, file: {path, line?, column?} \| null}]}`, refusing an unknown session `session.not_found` | [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T3.11 |
| `transcript.read` | Read the transcript | [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T1.4, T2.4 |
| `transcript.reasoningSurfaceRead` | The reasoning surface | [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T1.4, T1.3, T3.2 |
| `transcript.search` | Search one session's unloaded history | [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T3.6 |

### `turn.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `turn.tasks` (subscription) | The turn's task list | [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T3.9 |
| `turn.usage` (subscription) | Tokens received this turn | [Spec-011](../../specs/011-transcript-and-reasoning.md) | [Plan-010](../../plans/010-transcript-and-reasoning.md) T3.9 |

### `voice.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `voice.callStart {sessionId, offerSdp}` → `{answerSdp}`, sent at the first Space in a Codex session; Codex `thread/realtime/start {threadId, transport: {type: "webrtc", sdp}, version: "v3", outputModality: "audio", voice, initialItems, clientManagedHandoffs: true, includeStartupContext: false}` and its `thread/realtime/sdp`, `voice` read from the machine settings file and `initialItems` the session's earlier spoken exchange, oldest dropped first to fit 128 items and 8,192 estimated tokens | Start a Codex call | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `voice.callStop`; Codex `thread/realtime/stop` | End a Codex call | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `voice.callSubscribe`; from Codex's `thread/realtime/*` notifications, routed by `threadId` | A call's events | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `voice.dictationStart {sessionId}` | Start dictation on a Claude Code session | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `voice.dictationStop {cancel}` | End or drop the recording | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `voice.dictationSubscribe` | The words in progress and settled, and a refusal | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `voice.dictationWrite` (16 kHz 16-bit mono, 100 ms frames) | The recording's audio | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `voice.stateUpdate {sessionId \| null}` → `{sessionId \| null}`; `voice.stateSubscribe`, live, the first delivery the current state | Which session voice is on in | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |
| `voice.voiceList`; Codex `thread/realtime/listVoices` (its `v1` list and `defaultV1`); the pick is written through the machine settings verb, never into Codex's configuration | The voices Codex offers | [Spec-004](../../specs/004-provider-driver-contract-and-capabilities.md) | [Plan-003](../../plans/003-provider-driver-contract-and-capabilities.md) T3.32 |

### `workflow.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| `workflow.definitionCreate` | Save a new workflow; also Duplicate | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.2, T1.5, T1.6 |
| `workflow.definitionDelete` | Delete a workflow (soft) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.9 |
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
| `workflow.layoutSet` | Save the canvas layout without a new version | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.7 |
| `workflow.tagsSet {definitionId, tags}` | Save the workflow's tags from the builder header without a new version; the Workflows tab row and its tag filter read them | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.27 |
| `workflow.permissionLevelUpdate` | Set the workflow's own permission level from the builder's level pill | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.7 |
| `workflow.nodeExecute` with scope `"node"` or `"fromHere"` | Run this node, and Run from here | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.9 |
| `workflow.pinDataSet` | Pin or unpin a node's test data: inspector, step panel Pin, Copy this run into the builder | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.7 |
| the `workflow.results_posted` and `workflow.step_*` events, drawn as transcript row kind `workflow_run` | The progress row, then the results row, in the session that asked | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.3, T5.7 |
| `workflow.resultsPost` | Pull a run's results into this session | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.11 |
| `workflow.runAttentionList` | The runs-needing-you section and Next waiting (N) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.16 |
| `workflow.runCancel` | Cancel a run | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.20, T5.22 |
| `workflow.runDelete` | Delete one run | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.14 |
| `workflow.runKeepSet` | Mark a run Keep, so deleting old runs leaves it | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.14 |
| `workflow.runList` | List runs (table, count, latest run for `results <name>`) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.5 |
| `workflow.runRead` | Read one run and its steps | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.22 |
| `workflow.runRerun` | Re-run on a run's page: a new run of that run's own version with its input and mode | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.8 |
| `workflow.runResume` | Resume a parked run | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.21, T5.22 |
| `workflow.runRetry` | Retry from a step | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.8 |
| `workflow.runStart` | Start a run: Run now in two places through the Run now panel, `/workflow run` | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.9 |
| `workflow.runsDelete` | Delete runs older than a date; Keep runs and waiting runs are untouched | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.14 |
| `workflow.runsDeletePreview` | Count what `Delete runs older than…` would remove, before it runs | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.14 |
| `workflow.runsPauseSet` | Pause new runs | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.10 |
| `workflow.secretCreate {scope, scopeRef, name, secretValue}` → `{secretId, scope, scopeRef, name}` | Create a workflow secret from the Credential chooser's `New secret` | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.11 |
| `workflow.secretDelete {secretId}` | `Delete` a secret | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.11 |
| `workflow.secretList {}` → `{secrets: [{secretId, scope, scopeRef, name}]}` | List the secrets the chooser offers: the shared ones and each project's, by name | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.11 |
| `workflow.secretReplace {secretId, secretValue}` → `{secretId}` | `Replace value` on a secret | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.11 |
| `workflow.stepRead` | Read a step's input, output or log (step panel, inspector data panels) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.7 |
| `workflow.stepTabArtifactCreate` | Store what one step-panel tab holds as an artifact (`Open as artifact`) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T2.7 |
| `workflow.subscribe` | Live updates: runs, steps, schedules, the start hold | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.12 |
| `workflow.versionChainRead` | Version history (Versions panel list, the pinned-version chip) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.10 |
| `workflow.versionDiffRead` | Structural difference between two versions (panel count, canvas highlight, old and new params) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.10 |
| `workflow.versionRead` | Read one saved version (Versions panel, run graph) | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T1.2 |
| `workflow.webhookListenerRead` | Webhook listener state: port, and whether it is listening or the port is taken | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.17 |
| `workflow.webhookTokenRotate` | Create or rotate a workflow's webhook token; the token is shown once | [Spec-015](../../specs/015-workflow-authoring-and-execution.md) | [Plan-014](../../plans/014-workflow-authoring-and-execution.md) T5.17 |

### `worktree.*`

| Method and members | What it serves | Spec | Plan |
| --- | --- | --- | --- |
| events `worktree.created`, `worktree.retired`, `session.swept_to_repo_root` | Worktree lifecycle records and the per-session sweep | [Spec-005](../../specs/005-session-event-taxonomy-and-audit-log.md) | [Plan-004](../../plans/004-session-event-taxonomy-and-audit-log.md) T1.2 |
