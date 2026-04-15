# Forge Comprehensive Feature and Architecture Review

Date: 2026-04-14

Project root: `/home/sabossedgh/dev/forge`

Scope: Deep architectural review of the full monorepo, focusing on internals the prior audit was thin on: orchestration engine, persistence/event-sourcing, provider driver model, collaboration model, real-time events, and visibility system.

---

## 1. Technology Stack

| Layer | Technology | Version/Details |
|---|---|---|
| Language | TypeScript | `^5.7.3` |
| Runtime | Node.js / Bun | `node ^24.13.1`, `bun ^1.3.9` |
| Framework (effect system) | Effect | `4.0.0-beta.43` (pervasive: DI, streams, schema, SQL, HTTP, RPC) |
| Web framework | Vite + React | React SPA via TanStack Router |
| HTTP/WS server | `effect/unstable/http` | Built-in HTTP server with `HttpRouter`, `HttpServer` |
| RPC | `effect/unstable/rpc` | `RpcServer` + `RpcSerialization` over WebSocket |
| Database | SQLite | WAL mode, `@effect/sql-sqlite-bun` or Node fallback |
| Desktop shell | Electron | With preload bridge, tray, auto-updater |
| Build system | Turbo (monorepo) + tsdown | Workspaces: `apps/*`, `packages/*` |
| Linter/formatter | oxlint / oxfmt | Rust-based tooling |
| Testing | Vitest + `@effect/vitest` | |
| Observability | OTLP (traces/metrics) + local NDJSON traces | |
| Marketing | Astro | Static site at `apps/marketing` |
| Package manager | Bun | `bun@1.3.9` |

Key dependency: The codebase uses **Effect** as a universal runtime -- not just for error handling, but for dependency injection (Layer/Service), schema validation, SQL queries, HTTP routing, RPC transport, streaming, PubSub, queues, metrics, and tracing. This is the most architecturally distinctive choice in the stack.

Evidence: `package.json`, `apps/server/src/server.ts`, `apps/server/src/persistence/Layers/Sqlite.ts`

---

## 2. Architecture Overview

### System Topology

```
[Desktop (Electron)]  <-->  [Server (Node/Bun)]  <-->  [Provider CLIs]
       |                          |                     (Codex, Claude)
[Web (React SPA)]     <-->  [WS RPC Layer]
                              |
                       [SQLite (forge.db)]
                       [Event Store + Projections]
```

### Deployment Model

Three runtime modes configured via `ServerConfig.mode`:

1. **`web`** -- Standalone server with browser UI. Auto-bootstraps project from CWD. Opens browser.
2. **`desktop`** -- Launched by Electron. Loopback-only. Communicates via preload bridge or WS.
3. **`daemon`** -- Headless background process. JSON-RPC over Unix socket. Desktop or CLI can connect.

Evidence: `apps/server/src/config.ts` (`RuntimeMode`), `apps/server/src/cli.ts`

### Data Flow

1. Client (web/desktop/CLI) sends orchestration commands over WS RPC or daemon socket.
2. Commands enter a serialized `Queue<CommandEnvelope>` in the `OrchestrationEngine`.
3. The `decider` validates invariants against the in-memory `ReadModel` and produces events.
4. Events are atomically written to SQLite (`orchestration_events`) and projected in the same transaction.
5. Events are published via `PubSub` to all subscribers (reactors, WS push, checkpoint, workflow).
6. Provider reactors translate orchestration commands into provider session actions.
7. Provider runtime events flow back through `ProviderRuntimeIngestion` into orchestration commands.

This is a **command-sourced, event-projected** architecture (not pure event-sourcing -- the source of truth is the ordered event log, but commands are processed against an in-memory read model, not event replay).

Evidence: `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`, `apps/server/src/orchestration/decider.ts`, `apps/server/src/orchestration/projector.ts`

---

## 3. Complete Feature Inventory

### 3.1 Orchestration Engine

- **Command/Event architecture**: Commands validated by `decider.ts` against in-memory `OrchestrationReadModel`. Events produced atomically (may produce multiple events per command). Serialized processing via unbounded `Queue`. | `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- **Aggregate kinds**: `project`, `thread`, `channel`, `request` | `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:58-98`
- **Idempotent dispatch**: Command receipts stored per `commandId` with `accepted`/`rejected` status. Duplicate commands return existing result. | `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts`
- **Read model reconciliation**: On dispatch failure, read model is reconciled from persisted events to prevent drift. | `OrchestrationEngine.ts:120-138`
- **Event streaming**: `PubSub.unbounded<OrchestrationEvent>` with ordered replay+live merge for catch-up subscribers. | `orderedReplayAndLiveStream.ts`
- **Projection pipeline**: Events projected into SQLite tables via `ProjectionPipeline` within the same transaction. | `Layers/ProjectionPipeline.ts`

### 3.2 Session Lifecycle

- **Session statuses**: `created`, `running`, `needs-attention`, `paused`, `completed`, `failed`, `cancelled` | `packages/contracts/src/orchestration/readModels.ts:29-37`
- **Session types**: `agent`, `workflow`, `chat` | `packages/contracts/src/orchestration/types.ts:21`
- **Session commands**: `thread.create`, `thread.pause`, `thread.resume`, `thread.cancel`, `thread.restart`, `thread.recover`, `thread.send-turn`, `thread.restart-turn`, `thread.correct`, `thread.promote` | `packages/contracts/src/orchestration/commands.ts`
- **Turn lifecycle**: `thread.turn.start` -> `thread.turn-start-requested` -> `thread.turn-started` -> `thread.turn-completed` / interrupted | Events in `events.ts`
- **Interaction modes**: `default`, `plan`, `design` | `types.ts:40`
- **Runtime modes**: `approval-required`, `full-access` | `types.ts:35`

### 3.3 Workflow Engine

- **Workflow definition**: Named, multi-phase, with `builtIn` and `projectId` scoping. Phases: `single-agent`, `multi-agent`, `automated`, `human`. | `packages/contracts/src/workflow.ts`
- **Phase gates**: `auto-continue`, `quality-checks`, `human-approval`, `done`. Failure behavior: `retry`, `go-back-to`, `stop`. Max retries configurable. | `workflow.ts:26-66`
- **Quality checks**: Command-based checks with timeout, required flag, pass/fail results. | `workflow.ts:186-190`
- **Deliberation config**: Multi-agent phases with 2+ participants, per-participant prompts and models, configurable max turns. | `workflow.ts:112-122`
- **Agent output modes**: `schema`, `channel`, `conversation`. Schema outputs support structured JSON. | `workflow.ts:20-103`
- **On-completion config**: `autoCommit`, `autoPush`, `createPr`. | `workflow.ts:147-152`
- **Bootstrap config**: Pre-workflow setup command with timeout. | `workflow.ts:192-196`
- **Input chaining**: Phases can reference outputs from previous phases via `inputFrom`. | `workflow.ts:124-131`
- **Project-level config**: `ForgeProjectConfig` defines project-scoped `qualityChecks` and `bootstrap` config, independent of workflow definitions. Quality checks and bootstrap commands can be configured at the project level, not just per-workflow. | `workflow.ts:198-203`
- **Workflow reactor**: Listens for `thread.created`, `thread.phase-completed`, `thread.bootstrap-completed`, `thread.bootstrap-skipped`, `request.resolved` to drive phase transitions. | `Layers/WorkflowReactor.ts`
- **Workflow engine**: Resolves thread/project/workflow context, dispatches `thread.start-phase`, runs quality checks, opens gate requests, handles retry/skip/go-back logic. | `workflow/Layers/WorkflowEngine.ts`

### 3.4 Channel System

- **Channel types**: `guidance`, `deliberation`, `review`, `system` | `packages/contracts/src/channel.ts:12`
- **Channel statuses**: `open`, `concluded`, `closed` | `channel.ts:15`
- **Channel participants**: `human`, `agent`, `system` | `channel.ts:18`
- **Channel messages**: Sequenced, attributed to participant, persisted in `channel_messages` table. | `persistence/Migrations/021_ChannelTables.ts`
- **Channel reads**: Per-thread read position tracking. | `channel_reads` table
- **Deliberation state**: Ping-pong strategy, turn counting, conclusion proposals, stall detection with nudges, max turns enforcement. | `channel.ts:44-93`
- **Deliberation engine**: Manages state, computes next speaker, detects stalls, formats nudges, handles conclusion proposals. | `channel/Layers/DeliberationEngine.ts`
- **Channel reactor**: Reacts to `channel.message-posted`, `channel.conclusion-proposed`, `channel.concluded`. Manages deliberation flow. | `orchestration/Layers/ChannelReactor.ts`

### 3.5 Discussion System

- **Discussion definition**: Named, global or project-scoped, 2+ participants with roles, descriptions, models, system prompts, max turns. | `packages/contracts/src/discussion.ts`
- **Shared chat architecture**: Parent thread spawns child threads per participant. Each child gets an MCP server with `post_to_chat` tool. Messages relayed to parent and peers. | `orchestration/Layers/DiscussionReactor.ts`
- **System prompt injection**: Each child agent gets role-specific system prompt describing shared chat protocol. | `DiscussionReactor.ts:76-88`
- **Message relay**: Parent messages delivered to all children. Child messages posted to parent (with attribution) and relayed to peer children. | `DiscussionReactor.ts:168-287`
- **Shared chat bridge**: HTTP bridge with token auth for MCP tool calls. | `discussion/sharedChatBridge.ts`
- **Discussion registry**: File-system based registry resolving managed and global discussions. | `discussion/Layers/DiscussionRegistry.ts`

### 3.6 Interactive Request System

- **Request types**: `approval`, `user-input`, `permission`, `mcp-elicitation`, `gate`, `bootstrap-failed`, `correction-needed`, `design-option` | `packages/contracts/src/interactiveRequest.ts:12-20`
- **Request lifecycle**: `pending` -> `resolved` or `stale` | `interactiveRequest.ts:24`
- **Approval requests**: Tool name, input, suggestions. Decisions: `accept`, `acceptForSession`, `decline`, `cancel`. | `interactiveRequest.ts:27-41`
- **Permission requests**: File system read/write paths, network toggle. Grant scope: `turn` or `session`. | `interactiveRequest.ts:69-106`
- **MCP elicitation**: Form-based or URL-based. Actions: `accept`, `decline`, `cancel`. | `interactiveRequest.ts:108-155`
- **Gate requests**: Phase-run gate with quality check results and human approve/reject/correct. | `interactiveRequest.ts:157-170`
- **Bootstrap-failed requests**: Retry, skip, or fail actions. | `interactiveRequest.ts:172-183`
- **Design option requests**: Multiple design options with artifacts, user chooses one. | `interactiveRequest.ts:197-215`

### 3.7 Provider Driver Model

- **Provider kinds**: `codex`, `claudeAgent` | `packages/contracts/src/providerSchemas.ts:5`
- **Provider registry**: Aggregates health, auth, version, model snapshots per provider. Streams updates to UI. | `provider/Layers/ProviderRegistry.ts`
- **Provider service**: Unified session management -- `start`, `sendTurn`, `interruptTurn`, `respondToInteractiveRequest`, `stopSession`, `listSessions`, `forkSession`, `rollbackConversation`. Validates inputs, enforces enablement, persists runtime bindings. | `provider/Layers/ProviderService.ts`
- **Provider adapter pattern**: `ProviderAdapterRegistry` routes to `CodexAdapter` or `ClaudeAdapter`. Each adapter implements the provider-specific protocol. | `provider/Layers/ProviderAdapterRegistry.ts`
- **Provider session directory**: In-memory directory of active sessions with runtime binding metadata. | `provider/Layers/ProviderSessionDirectory.ts`
- **Codex adapter**: Wraps `codex app-server` JSON-RPC. Supports session start/resume, collaboration modes (plan/default), MCP server injection, system prompt injection, model switching, rollback, fork. | `provider/Layers/CodexAdapter.ts`, `codexAppServerManager.ts`
- **Claude adapter**: Wraps Claude SDK. Supports SDK sessions, MCP registration, model switching, rollback, fork. Subscription-aware capability adjustment. | `provider/Layers/ClaudeAdapter.ts`
- **Runtime event stream**: Providers emit normalized `ProviderRuntimeEvent` stream. Events ingested by `ProviderRuntimeIngestion` reactor and mapped to orchestration commands. | `provider/Services/ProviderService.ts`, `orchestration/Layers/ProviderRuntimeIngestion.ts`
- **Event NDJSON logging**: All provider events written to NDJSON log file. | `provider/Layers/EventNdjsonLogger.ts`

### 3.8 Git Integration

- **Git core operations**: Status, diff, pull, branch listing/creation/checkout, worktree create/remove, repo init. | `git/Layers/GitCore.ts`
- **Git manager**: Stacked actions (commit, push, PR, composites), commit review, branch management, PR resolution/prep. | `git/Layers/GitManager.ts`
- **GitHub CLI**: PR creation, listing, resolution via `gh` CLI. | `git/Layers/GitHubCli.ts`
- **Text generation for git**: AI-generated commit messages and PR descriptions via Codex or Claude. | `git/Layers/RoutingTextGeneration.ts`, `git/Prompts.ts`
- **Worktree management**: Thread-level worktree isolation, branch prefix conventions, bootstrap scripts on worktree creation. | Via `packages/shared/src/threadWorkspace.ts`
- **Diff attribution**: Per-turn agent diffs with source classification (`native_turn_diff`, `derived_tool_results`) and coverage levels (`complete`, `partial`, `unavailable`). | `types.ts:234-245`

### 3.9 Design Mode

- **Design preview**: HTML artifacts in sandboxed iframe, viewport width switching, multi-artifact navigation. | `apps/web/src/components/DesignPreviewPanel.tsx`
- **Design MCP server**: Exposes design tools to agents for artifact rendering. | `design/designMcpServer.ts`
- **Artifact storage**: Server-side artifact persistence. | `design/artifactStorage.ts`
- **Screenshot service**: Screenshot capture for design artifacts. | `design/screenshotService.ts`
- **Design bridge**: HTTP bridge for design artifact serving with token auth. | `design/designBridge.ts`
- **Design reactor**: Listens for design events and manages design session flow. | `design/DesignModeReactor.ts`

### 3.10 Daemon Mode

- **Daemon singleton**: PID-file based single-instance enforcement with stale-state cleanup. | `daemon/Layers/DaemonService.ts`
- **JSON-RPC socket**: Protocol-versioned Unix socket with `daemon.ping`, `daemon.stop`, session/thread/workflow/discussion/channel CRUD RPCs. | `daemon/protocol.ts`, `daemon/Layers/SocketTransport.ts`
- **CLI client**: `forge daemon start|stop|restart|status|clean`. Session commands: create, list, status, send-turn, correct, approve/reject gates, pause/resume/cancel, tail transcripts, subscribe events. | `daemon/cliClient.ts`, `apps/server/src/cli.ts`
- **Notification reactor**: Desktop notifications for sessions needing attention, completion, deliberation completion with deep links. | `daemon/Layers/NotificationReactor.ts`

### 3.11 Persistence

- **SQLite with WAL mode**: `forge.db` in state directory. Bun or Node SQLite backends. | `persistence/Layers/Sqlite.ts`
- **34 migrations**: Progressive schema evolution from base event store through channels, interactive requests, workflows, agent diffs, thread extensions. | `persistence/Migrations/001_*` through `034_*`
- **Event store**: `orchestration_events` table with sequence, event_id, aggregate_kind, stream_id, stream_version, event_type, payload_json, metadata_json. Indexed by stream version, command_id, correlation_id. | `001_OrchestrationEvents.ts`
- **Command receipts**: `orchestration_command_receipts` table for idempotent dispatch. | `002_OrchestrationCommandReceipts.ts`
- **Projection tables**: `projection_projects`, `projection_threads`, `projection_thread_messages`, `projection_thread_activities`, `projection_thread_sessions`, `projection_turns`, `projection_pending_approvals`, `projection_state`. | `005_Projections.ts`
- **Workflow tables**: `workflows`, `phase_runs`. | `020_WorkflowTables.ts`
- **Channel tables**: `channels`, `channel_messages`, `channel_reads`, `tool_call_results`. | `021_ChannelTables.ts`
- **Interactive requests table**: `interactive_requests` with type, status, payload, resolution. | `024_InteractiveRequests.ts`
- **Provider session runtime**: Persisted runtime bindings for session recovery. | `004_ProviderSessionRuntime.ts`
- **Checkpoint diff blobs**: Binary diff storage. | `003_CheckpointDiffBlobs.ts`
- **Agent diffs**: Per-turn agent diff persistence with attribution. | `031_ProjectionAgentDiffs.ts`
- **Phase outputs**: Structured phase output storage. | `023_PhaseOutputTables.ts`

### 3.12 Observability

- **Local trace files**: Always-on NDJSON trace capture with configurable rotation. | `observability/LocalFileTracer.ts`
- **OTLP export**: Optional traces and metrics export when configured. | `observability/Layers/Observability.ts`
- **RPC instrumentation**: Span metadata + per-method duration/outcome metrics. | `observability/RpcInstrumentation.ts`
- **Debug logging**: `FORGE_DEBUG` topic-based NDJSON output. | `debug.ts`
- **Analytics**: Anonymous user identification, platform/version metadata. | `telemetry/Layers/AnalyticsService.ts`

---

## 4. Signature Feature Analysis

### 4.1 Mid-Session Invites and Shared Runtime Contribution

**What Forge implements:**
- Discussions spawn child threads per participant, each running independently with their own provider session. Parent thread aggregates contributions via `post_to_chat` MCP tool. | `orchestration/Layers/DiscussionReactor.ts`
- Child threads can use different models/providers (per-role model overrides). | `composerDraftStore.ts`, `DiscussionRolesPicker.tsx`
- Messages relayed between parent and all children, with attribution. | `DiscussionReactor.ts:168-287`
- Workflow phases can spawn multiple child sessions (multi-agent deliberation). | `workflow/Layers/WorkflowEngine.ts`

**What Forge does NOT implement:**
- No mid-session invites. All participants must be defined upfront in the discussion definition. Once a discussion starts, the participant roster is fixed.
- No concept of external users "joining" a live session. The system is single-user. There is no authentication model for multiple users, no user identity beyond a single anonymous telemetry ID.
- No "bring your own agent" -- agents are limited to the two built-in providers (Codex, Claude). External agent protocols are not supported.
- No shared workspace or simultaneous contribution to the same thread/file. Each child thread works independently.

**Rating: Partial** -- Multi-agent discussions exist but are pre-configured, single-user, and closed-roster. True mid-session invites and collaborative contribution are absent.

### 4.2 Multi-User and Multi-Agent Chat

**What Forge implements:**
- **Channels** with types (`guidance`, `deliberation`, `review`, `system`), participant types (`human`, `agent`, `system`), sequenced messages, read tracking. | `packages/contracts/src/channel.ts`
- **Deliberation engine**: Ping-pong turn strategy, configurable max turns, stall detection with nudge delivery, conclusion proposals (PROPOSE_CONCLUSION protocol), auto-conclusion. | `channel/Layers/DeliberationEngine.ts`, `channel.ts:44-93`
- **Discussions**: Named multi-participant flows with roles, per-role system prompts, per-role model selection. | `packages/contracts/src/discussion.ts`
- **Discussion role model overrides**: Per-participant model selection in draft state. | `composerDraftStore.ts`
- **Max turns as a stop condition**: Configurable per discussion and per workflow deliberation. | `discussion.ts:6`, `workflow.ts:17`

**What Forge does NOT implement:**
- No multi-human-user support. Channels support `human`, `agent`, `system` participant types, but there is only one human (the local user). There is no authentication, authorization, or multi-user identity model.
- No budget policy (token/cost limits per agent or session). Rate limits are shown but not enforceable as budget caps.
- No turn policy beyond simple ping-pong and max turns. No configurable turn ordering, priority, or arbitration.
- No moderation system. No content filtering, no flagging, no approval of agent-to-agent messages.
- No role-based access control. All participants in a discussion have equal access.

**Rating: Partial** -- Multi-agent chat with roles and turn management exists. Multi-user support is absent. Budget policy, sophisticated turn policy, and moderation are absent.

### 4.3 Queue, Steer, Pause, Resume

**What Forge implements:**
- **Pause/Resume**: First-class commands (`thread.pause`, `thread.resume`) with corresponding session statuses (`paused`). CLI supports `forge session pause/resume`. | `commands.ts:171-185`, `readModels.ts:33`
- **Cancel**: `thread.cancel` command with optional reason. | `commands.ts:195-202`
- **Restart**: `thread.restart` command, optionally from a specific phase. | `commands.ts:204-210`
- **Interrupt**: `thread.turn.interrupt` for stopping a running turn. | `commands.ts:279-285`
- **Steer/Correct**: `thread.correct` command delivers correction content to a running session. | `commands.ts:336-343`
- **Daemon-backed persistence**: Sessions survive server restarts via persisted runtime bindings and startup reconciliation. Stale sessions detected and repaired on boot. | `orchestration/Layers/StartupReconciliation.ts`, `persistence/Layers/ProviderSessionRuntime.ts`
- **Session recovery**: `thread.recover` command for recovering crashed sessions. | `commands.ts:187-193`
- **Checkpoint/revert**: `thread.checkpoint.revert` can roll back to a previous turn count. | `commands.ts:297-303`

**What Forge does NOT implement:**
- No real task queue. The orchestration engine processes commands serially via an unbounded in-process queue, but this is not a distributed or persistent job queue. There is no priority, ordering guarantees across sessions, or worker pool.
- No configurable queueing policy (FIFO, priority, fairness).
- Steer is implemented as a correction injection (`thread.correct`), not as a full runtime intervention that can redirect workflow execution, change phase order, or modify in-progress plans.
- Pause/resume appear to be session-level states, but the actual provider-side pause behavior depends on the provider adapter implementation.

**Additional primitives relevant to queuing:**
- **Thread dependencies**: `thread.add-dependency` and `thread.remove-dependency` commands, with corresponding `thread.dependency-added`, `thread.dependency-removed`, and `thread.dependencies-satisfied` events. This provides a primitive ordering mechanism between threads. | `commands.ts:526-542`, `events.ts:646-648`
- **Thread promotion**: `thread.promote` command can promote a thread into a different workflow context. | `commands.ts:514-524`
- **Daemon CLI as headless queue surface**: The daemon socket and CLI expose `forge session create`, `forge session send-turn`, `forge session pause`, `forge session resume`, etc. This is the closest Forge has to a programmatic queue management interface. | `daemon/cliClient.ts`, `cli.ts`

**Rating: Partial** -- Pause, resume, cancel, interrupt, basic correction/steer, thread dependencies, and headless daemon CLI exist. Real queuing with priority, fairness, and deep steering (redirect workflows, change priorities) are absent.

### 4.4 Repo Attach and Git Flow

**What Forge implements:**
- **Project-level repo binding**: Each project has a `workspaceRoot` path. Multiple projects can be open simultaneously. | `types.ts:109-119`
- **Worktree support**: Threads can spawn in isolated git worktrees (`local` or `worktree` spawn modes). Configurable branch prefix. Bootstrap scripts run on worktree creation. Worktree create/remove via WS API. | `types.ts:38-39`, `git/Layers/GitManager.ts`
- **Branch management**: Full branch listing with pagination/virtualization, local/remote checkout, create-branch, PR checkout from `#123`/URL/`gh pr checkout`. | `BranchToolbarBranchSelector.tsx`
- **Stacked git actions**: Composite commit+push+PR operations with progress reporting. | `git.ts:8-14`, `git/Layers/GitManager.ts`
- **Commit review**: Pre-commit UI with file include/exclude, message editing, new-branch creation. | `GitActionsControl.tsx`
- **Diff attribution**: Per-turn agent diffs with source tracking (`native_turn_diff`, `derived_tool_results`) and coverage levels. Workspace-wide diffs also available. | `types.ts:234-255`
- **PR prep**: AI-generated commit messages and PR descriptions via provider text generation. | `git/Layers/RoutingTextGeneration.ts`, `git/Prompts.ts`
- **Default-branch guardrails**: Confirmation dialog before actions on default branch. | `GitActionsControl.tsx`
- **Diff viewer**: Agent-attributed diffs vs full-workspace diffs, stacked vs split rendering, word wrap, per-turn or all-turns, file tree with stats. | `DiffPanel.tsx`, `DiffPanelBody.tsx`

**What Forge does NOT implement:**
- No multi-repo attach. Each project maps to exactly one workspace root. Cross-repo operations require separate projects.
- No branch strategy configuration (trunk-based, gitflow, etc.). Branch management is manual.
- No automatic diff attribution across multiple agent turns in a merged view. Each turn's diff is separate.
- No conflict resolution tooling. If worktrees diverge, git conflicts must be resolved outside Forge.

**Rating: Complete** -- This is Forge's strongest signature feature. Worktree isolation, branch management, diff attribution, commit/push/PR flow, and AI-generated git text are all implemented and exposed.

### 4.5 Visibility

**What Forge implements:**
- **Live timeline**: Thread history projected into messages, tool activity, summaries, plans, inline diffs, command outputs, and subagent groups with virtualization for large histories. | `MessagesTimeline.tsx`, `MessagesTimeline.logic.ts`, `session-logic/index.ts`
- **Thread activities**: Structured activity records with tone (`info`, `tool`, `approval`, `error`), kind, summary, payload, and turn association. | `types.ts:257-275`
- **Session state tracking**: Real-time session status (`idle`, `starting`, `running`, `ready`, `interrupted`, `stopped`, `error`). Turn state (`running`, `interrupted`, `completed`, `error`). | `types.ts:166-175`, `types.ts:277-283`
- **Background task tray**: Collapsible tray for long-running commands and subagents with running/completed/error state, elapsed time, output expansion. | `ComposerBackgroundTaskTray.tsx`
- **Subagent activity feed**: Parent threads can fetch and render child provider thread work logs on demand. | `LazySubagentEntries.tsx`
- **Workflow timeline**: Phase runs, iterations, child-session counts, outputs, transition states with auto-expansion. | `WorkflowTimeline.tsx`
- **Context-window meter**: Usage percent, tokens, auto-compaction hints. | `ContextWindowMeter.tsx`
- **Rate-limit meter**: Provider usage with threshold coloring and reset timing. | `RateLimitsMeter.tsx`
- **Event streaming**: Server pushes orchestration events, terminal events, provider events, workflow events, channel events, rate-limit events, settings changes over WS. | `ws.ts`
- **Event replay**: Client can bootstrap from snapshot and replay events for recovery. | `orchestrationRecovery.ts`
- **Changed-files tree**: Message-level diff summaries with directory/file trees and diff stats. | `ChangedFilesTree.tsx`

**What Forge does NOT implement:**
- No unified timeline view across multiple sessions/threads. Each thread has its own timeline.
- No approval audit trail UI (approvals are tracked in `projection_pending_approvals` but not surfaced as a timeline).
- No handoff tracking between sessions (e.g., when a workflow spawns child sessions, the parent does not show a detailed handoff timeline).
- No state-transition visualization (e.g., a session state machine diagram or transition log).

**Rating: Complete** -- Forge has comprehensive real-time visibility for individual sessions with live streaming, activity timelines, diffs, subagent feeds, and workflow phase tracking. Cross-session visibility is the main gap.

---

## 5. Provider Driver Model

### Architecture

```
ProviderService (unified API)
  -> ProviderAdapterRegistry (routes by provider kind)
    -> CodexAdapter (Codex app-server JSON-RPC)
    -> ClaudeAdapter (Claude SDK)
  -> ProviderSessionDirectory (in-memory active sessions)
  -> PubSub<ProviderRuntimeEvent> (event stream)
```

### ProviderService API

Unified operations across providers:
- `startSession(input: ProviderSessionStartInput)`
- `sendTurn(input: ProviderSendTurnInput)`
- `interruptTurn(input: ProviderInterruptTurnInput)`
- `respondToInteractiveRequest(input: ProviderRespondToInteractiveRequestInput)`
- `stopSession(input: ProviderStopSessionInput)`
- `listSessions()`
- `forkSession()`
- `rollbackConversation()`

Evidence: `provider/Layers/ProviderService.ts`

### Codex Integration

- Uses `codex app-server` subprocess (JSON-RPC over stdio).
- Managed by `codexAppServerManager.ts`.
- Supports collaboration mode switching (plan/default) via developer instructions injection.
- Supports dynamic MCP server injection for tools like `post_to_chat`.
- Model switching, rollback, fork supported.
- Runtime events mapped through `codex/mapToRuntimeEvents.ts`.

Evidence: `provider/Layers/CodexAdapter.ts`, `codexAppServerManager.ts`, `provider/codexCollaborationMode.ts`

### Claude Integration

- Uses Claude SDK (`@anthropic-ai/claude-code`).
- Session lifecycle managed through SDK message streaming.
- MCP server registration for tool injection.
- Subscription-aware capability adjustment (respects plan limits).
- Model switching, rollback, fork supported.
- Message building and SDK parsing in `provider/Layers/claude/`.

Evidence: `provider/Layers/ClaudeAdapter.ts`, `provider/Layers/claude/sessionLifecycle.ts`

### Runtime Event Normalization

Provider-specific events are normalized into a common `ProviderRuntimeEvent` stream with types:
- `session_state_changed`, `thread_state_changed`, `turn_state_changed`
- `content_stream_started`, `content_stream_delta`, `content_stream_ended`
- `item_status_changed`, `approval_requested`, `permission_requested`
- `user_input_requested`, `mcp_elicitation_requested`
- `plan_updated`, `task_status_changed`, `agent_diff_available`
- `session_exit`, `error`

Evidence: `packages/contracts/src/providerRuntime.ts`

---

## 6. Persistence and State Model

### Event Store

The `orchestration_events` table is the canonical event log:

```sql
CREATE TABLE orchestration_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  aggregate_kind TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  command_id TEXT,
  causation_event_id TEXT,
  correlation_id TEXT,
  actor_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
```

Indexed by `(aggregate_kind, stream_id, stream_version)` for stream-level ordering and `(command_id)` for idempotency.

### Projection Model

Events are projected into normalized relational tables:
- `projection_projects` -- Project metadata
- `projection_threads` -- Thread state including latest turn, branch, worktree, workflow, discussion, role
- `projection_thread_messages` -- Messages with role, text, streaming flag, turn association
- `projection_thread_activities` -- Structured activity log (tool invocations, approvals, errors)
- `projection_thread_sessions` -- Provider session binding (status, provider name, active turn)
- `projection_turns` -- Turn lifecycle (requested/started/completed, checkpoint state)
- `projection_pending_approvals` -- Approval requests (largely superseded by `interactive_requests`)
- `projection_state` -- Projector cursor tracking
- `workflows` -- Workflow definitions with phases JSON
- `phase_runs` -- Phase run lifecycle (status, gate results, quality checks, deliberation state)
- `channels` -- Channel state
- `channel_messages` -- Sequenced channel messages
- `channel_reads` -- Per-thread read positions
- `interactive_requests` -- All interactive request types with payload/resolution JSON
- `tool_call_results` -- MCP tool call result caching
- `projection_agent_diffs` -- Per-turn agent diff data
- `phase_outputs` -- Structured phase output storage

### Recovery

- **Startup reconciliation**: On boot, detects stale sessions (status `running`/`starting` without live provider), stale turns, stale phase runs, open channels, pending approvals, and stale interactive requests. Dispatches corrective commands. | `orchestration/Layers/StartupReconciliation.ts`
- **Provider session runtime persistence**: Runtime bindings (provider kind, session ID, thread ID, model, runtime mode) persisted in `provider_session_runtime` for recovery. | `persistence/Layers/ProviderSessionRuntime.ts`
- **Projection snapshot**: Read model reconstructed from projection tables on startup, not from event replay (projection tables are the hot cache). | `orchestration/Layers/ProjectionSnapshotQuery.ts`

Evidence: All files in `apps/server/src/persistence/Migrations/` and `apps/server/src/persistence/Layers/`

---

## 7. Real-Time and Visibility Architecture

### Event System

The server maintains a `PubSub.unbounded<OrchestrationEvent>()` in the orchestration engine. Each consumer gets an independent subscription:

1. **WS push**: Events transformed by `sanitizeForgeEventForTransport` and streamed to connected clients.
2. **ProviderRuntimeIngestion**: Translates provider runtime events into orchestration commands.
3. **CheckpointReactor**: Captures checkpoints on turn completion.
4. **WorkflowReactor**: Drives workflow phase transitions.
5. **ChannelReactor**: Manages deliberation state machine.
6. **DiscussionReactor**: Relays messages between parent and child threads.
7. **BootstrapReactor**: Manages worktree bootstrap scripts.
8. **DesignModeReactor**: Manages design artifact lifecycle.

### WS Push Streams

The WS server pushes multiple event streams:

- **Orchestration events**: Full event stream with catch-up replay from sequence.
- **Workflow push**: Phase starts/completions, gate requests, child sessions.
- **Channel push**: Channel messages, conclusions, closes.
- **Terminal events**: Terminal output, subprocess state.
- **Provider snapshots**: Health, auth, version, model changes.
- **Settings changes**: Server settings updates.
- **Rate limit snapshots**: Provider usage limits.
- **Lifecycle events**: Welcome, ready with bootstrap context.
- **Git action progress**: Stacked action phase/hook progress.

### Timeline Projection (Client-Side)

The client projects orchestration events into a renderable timeline:
- Messages (user, assistant, system) with streaming state
- Tool activities with tone and summary
- Inline diffs with file change details
- Background task tray items
- Subagent groups with lazy activity feeds
- Plan cards with step statuses
- Checkpoint/revert actions

Evidence: `apps/web/src/session-logic/index.ts`, `apps/web/src/components/chat/MessagesTimeline.logic.ts`

---

## 8. Collaboration Model

### What Exists

Forge's "collaboration" is exclusively **multi-agent collaboration orchestrated by a single human user**:

1. **Discussions**: Pre-defined multi-agent conversations where agents with different roles communicate through a shared parent chat. Agents post via MCP tool calls, messages are relayed to peers. The human user can read the shared chat and send messages.

2. **Workflow deliberation phases**: Multi-agent phases where 2+ agents debate in a structured ping-pong format via channels, with configurable max turns and conclusion detection.

3. **Child thread spawning**: A parent thread can have multiple child threads (one per discussion participant, or spawned by workflow phases), each with its own provider session.

### What Does Not Exist

- **No multi-human-user support whatsoever.** The system assumes a single human operator. There is:
  - No user authentication or identity model
  - No user sessions or login
  - No concurrent human participants
  - No user-to-user messaging
  - No shared workspace with concurrent human access
  - No access control or permissions model for humans
  
- **No mid-session invites.** Participant rosters are fixed at discussion/workflow creation time.

- **No external agent integration.** Only Codex and Claude are supported as provider kinds. There is no agent protocol, plugin system, or adapter interface for third-party agents.

- **No concept of "bringing your own agent."** A user cannot connect their own agent instance to a running session.

Evidence: Absence of any authentication, user identity, or multi-user constructs in `packages/contracts/src/`, `apps/server/src/ws.ts`, `apps/server/src/config.ts`

---

## 9. Strengths

1. **Rigorous event architecture.** The command/event model with idempotent dispatch, command receipts, in-transaction projection, and startup reconciliation is production-grade. This is not a toy event system.

2. **Effect-based composition.** The pervasive use of Effect for DI, error handling, streaming, metrics, and SQL means the entire server is a composition of typed, testable service layers. Every service boundary is explicit.

3. **Git and diff integration.** The worktree isolation, per-turn diff attribution, stacked git actions, and AI-generated git text represent the most complete coding-agent git integration in the audit.

4. **Provider abstraction quality.** The `ProviderService` -> `ProviderAdapterRegistry` -> adapter pattern cleanly separates protocol-specific concerns. Adding a new provider would require writing one adapter file, not touching orchestration.

5. **Workflow engine depth.** Multi-phase workflows with quality checks, human gates, retry logic, deliberation, input chaining, and completion actions (auto-commit, auto-push, create-PR) form a real production workflow system.

6. **Persistence model.** 34 migrations, proper projection tables, provider session runtime persistence, and startup reconciliation demonstrate a mature persistence strategy.

7. **Real-time visibility.** Live event streaming with catch-up replay, structured activity timelines, background task tray, subagent feeds, and workflow timeline provide comprehensive observability.

8. **Desktop integration.** WSL support, native editor launching, daemon lifecycle management, and auto-updates show attention to the desktop development workflow.

---

## 10. Limitations and Gaps

### Critical Gaps (relative to ai-sidekicks signature features)

1. **No multi-user support.** This is the largest gap. Forge is fundamentally single-user. There is no authentication, no user identity, no concurrent human participants, no shared sessions. Every "collaboration" feature is multi-agent within a single user's context.

2. **No mid-session invites.** Discussion participants and workflow agents are defined at creation time. You cannot add participants to a running conversation.

3. **No external agent protocol.** Only Codex and Claude are supported. No MCP agent protocol, no OpenAI Agents API integration, no adapter interface for arbitrary LLM backends. The "provider adapter" pattern could support this, but only two implementations exist.

4. **No real task queue.** Commands are processed serially in a single-process unbounded queue. No distributed queue, no priority, no fairness, no worker pool, no queue depth management.

5. **No budget policy.** Rate limits are displayed but not enforceable. There is no per-agent or per-session token/cost budget.

6. **No moderation.** No content filtering, no flagging, no approval gates on agent-to-agent messages.

### Architectural Limitations

7. **Single-process architecture.** The server is a single Node/Bun process. SQLite is the only storage. There is no horizontal scaling path, no replication, no distributed coordination.

8. **In-memory read model.** The orchestration read model lives in memory and is reconstructed from projection tables on startup. This works for single-user but would not scale to large numbers of concurrent sessions.

9. **Provider coupling.** Despite the adapter pattern, the providers are deeply integrated (Codex app-server subprocess management, Claude SDK direct usage). Provider sessions are tied to the server process lifetime.

### Incomplete Surfaces

10. **Workflow deletion partially implemented.** Component props exist but the editor flow is not wired. | `WorkflowEditor.parts.tsx`

11. **Background tray ownership unresolved.** Some timeline/tray ownership helpers are effectively no-ops. | `session-logic/utils.ts`

12. **Codex subagent fan-out lossy.** Only the first matched child subagent group is attached to a parent spawn row. | `session-logic/subagentGrouping.ts`

13. **Discussion project scoping implicit.** Influenced by sidebar filter state rather than explicit picker. | `DiscussionEditor.tsx`

14. **Design export error handling.** Relies on console logging in places rather than user-visible failure UI. | `DesignPreviewPanel.tsx`

### Documentation and Operability

15. **No multi-environment deployment docs.** The system assumes local development/single-machine deployment.

16. **No schema documentation.** The SQLite schema is defined entirely in migration files with no ERD or documentation.
