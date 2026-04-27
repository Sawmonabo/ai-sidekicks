# Forge Comprehensive Feature and Architecture Review

Date: 2026-04-14

Project root: `/home/sabossedgh/dev/external/forge`

Scope: Deep architectural review of the full monorepo, covering orchestration engine, persistence/event-sourcing, provider driver model, collaboration model, real-time events, and visibility system. Appendix A contains the full user-facing feature audit with per-feature evidence trails.

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
- **CLI client**: `forge daemon start|stop|restart|status|clean`. Session commands: create, list, status, send-turn, correct, approve/reject gates, pause/resume/cancel, tail transcripts, subscribe events. | `apps/server/src/daemon/cliClient.ts`, `apps/server/src/cli.ts`
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
- **Daemon CLI as headless queue surface**: The daemon socket and CLI expose `forge session create`, `forge session send-turn`, `forge session pause`, `forge session resume`, etc. This is the closest Forge has to a programmatic queue management interface. | `apps/server/src/daemon/cliClient.ts`, `apps/server/src/cli.ts`

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

---

## Appendix A. User-Facing Feature Audit

> Merged from `forge-feature-audit-report.md` (2026-04-14). This appendix provides the complete user-facing product surface inventory with per-feature evidence trails. Sections 1–12 above cover technical architecture internals; this appendix covers the same product from the user/operator perspective.

Original scope: repo-wide static audit of `apps/web`, `apps/server`, `apps/desktop`, `apps/marketing`, `packages/contracts`, and `packages/shared`.

Conventions:
- `user`: directly visible end-user product behavior.
- `operator`: setup/admin/debug/maintainer capability.
- `internal`: implemented platform capability or latent surface not always exposed in the primary UI.
- `conditional`: feature exists but is gated by platform, runtime mode, provider state, or route/query state.

### A.0 Plain-Language Summary

#### What This App Is

Forge is a desktop/web workspace for doing software work with coding agents. It combines:

- chat with agents
- project/thread organization
- workflow automation
- code review and diff tools
- terminal and git operations
- and a backend that keeps long-running agent sessions alive

#### Project And Conversation Management

- Multiple projects: You can add more than one codebase/workspace and switch between them in the sidebar.
  Example: keep your frontend repo and backend repo in the same app and jump between them.
- Multiple threads per project: Each project can have many separate conversations.
  Example: one thread for `fix login bug`, another for `add billing page`, another for `release checklist`.
- Thread organization: Threads can be pinned, archived, renamed, forked, marked unread, and sorted.
  Example: pin your main implementation thread, archive old debugging threads, fork a thread before trying a risky idea.
- Project organization: Projects can be sorted automatically or manually.
  Example: keep your most important repo at the top even if it was not updated most recently.

#### Chatting With Coding Agents

- Normal agent chat: You can talk to an AI agent about your code and get streamed responses while it works.
  Example: `Find why session resume fails after reconnect and fix it.`
- Provider and model selection: The app supports choosing which agent/provider to use, mainly Codex and Claude right now.
  Example: use Codex for code editing, then switch to Claude for a second opinion.
- Saved draft state: If you leave a thread and come back later, your unfinished prompt and settings are still there.
  Example: start writing a long request, switch threads, then return without losing it.
- Path mentions and smart input: The composer understands things like file/path mentions and command-style inputs.
  Example: mention a specific file so the agent focuses on `apps/server/src/ws.ts`.

#### Different Working Modes

- Chat mode: regular back-and-forth coding help.
  Example: `Explain this function and patch the bug.`
- Plan mode: the agent focuses on producing a plan before implementation.
  Example: `Design a migration strategy for moving provider state into SQLite.`
- Design mode: the app can show generated design artifacts or previews tied to the thread.
  Example: ask for a UI redesign and review visual output inside the app.

#### Human Control, Safety, And Approval

- Command/file approvals: The app can stop and ask for approval before risky actions.
  Example: the agent wants to run a shell command or modify files, and you must approve first.
- Permission grants: You can grant access to folders or network capabilities for a turn or a whole session.
  Example: allow reading one repo folder for this request only, or allow network for the whole session.
- User-input prompts: The app can pause and ask you a structured question when the workflow needs a decision.
  Example: `Which environment should I target: staging or production?`
- MCP/tool elicitation: Some tools can ask you to open a URL, fill a form, or provide structured input.
  Example: a tool asks you to authenticate or paste a JSON config value.

#### Workflow And Collaboration Features

- Saved workflows: You can define reusable multi-step agent workflows instead of relying only on ad hoc prompts.
  Example: create a workflow for `analyze issue -> make plan -> implement -> summarize`.
- Discussions: The app supports managed multi-participant discussion flows, not just one agent talking to one user.
  Example: simulate `architect`, `reviewer`, and `implementer` roles discussing a change.
- Per-role model choices: Different participants in a discussion can use different models.
  Example: a stronger model for architecture, a cheaper one for implementation.

#### Coding Workflow Tools Around The Chat

- Git integration: The app exposes repo actions like branch/worktree-related operations and git-aware views.
  Example: create a worktree for a feature branch and keep it tied to a specific thread.
- Diff review: You can inspect code diffs inside the app rather than leaving for another tool.
  Example: review what the agent changed before accepting it.
- Project scripts: The UI can surface and run repo-level scripts.
  Example: trigger lint/typecheck/build tasks from the thread workspace.
- Open in editor/file manager: The app can jump from the thread to your local editor or project folder.
  Example: open the current workspace in VS Code or Cursor.
- Terminal integration: Terminal activity can be attached to the thread context.
  Example: include recent terminal output in the next prompt so the agent can reason about a failure.

#### Long-Running Agent Runtime

- Persistent sessions: The backend is built to keep agent sessions alive and recover from reconnects/restarts.
  Example: close the UI, reopen it, and resume the same thread instead of starting over.
- Event/timeline tracking: The system records what happened during an agent run.
  Example: see phases like planning, waiting for approval, generating output, or running subtasks.
- Background task visibility: The app can show background agent/subagent work rather than only the final reply.
  Example: see that a subagent is exploring one file while the main agent continues elsewhere.

#### Desktop App Features

- Electron desktop shell: There is a native desktop app, not just a browser UI.
  Example: use native dialogs, tray behavior, updater flows, and local integration.
- Local daemon connection: The desktop app can connect to a local backend process.
  Example: launch Forge on your machine and have it manage the server for you.
- WSL support: On Windows, it can connect to a Forge/backend running inside WSL.
  Example: keep code in Ubuntu/WSL but use a Windows desktop UI.
- Auto-updates: The desktop app has built-in update/download/install flows.
  Example: get notified that a new version is ready and install it from the app.

#### Internal Platform Features

- WebSocket API: The frontend and backend communicate over a structured realtime protocol.
  Example: agent events, terminal updates, approvals, and settings changes stream live.
- Persistence layer: The server stores projects, threads, messages, workflows, approvals, and other runtime state.
  Example: your thread list and conversation history survive restarts.
- Observability/logging: The app includes tracing/logging/debug infrastructure.
  Example: operators can diagnose why a provider session crashed or stalled.

#### Important Caveat

- Some features exist in code but may not be fully wired into the UI yet.
  Example: parts of workflow deletion and some background-task ownership behavior look unfinished.
- Some features are conditional.
  Example: WSL-specific setup only appears on Windows desktop, and some provider/model controls only appear when that model supports them.

### A.1 App Shell, Navigation, And Settings

- Sidebar application shell | user | Main UI is a left-sidebar workbench with resizable, width-persistent layout, off-canvas behavior on smaller screens, and desktop menu routing into Settings. | evidence: `apps/web/src/components/AppSidebarLayout.tsx`, `apps/web/src/main.tsx`
- Branded sidebar and footer nav | user | Sidebar brand links back to chat, shows stage/version context, and footer navigation exposes `Agent Modes` and `Settings`. | evidence: `apps/web/src/components/sidebar/SidebarBrand.tsx`, `apps/web/src/components/sidebar/SidebarFooterNav.tsx`
- Empty-thread landing state | user | Root chat surface shows a dedicated empty state until a thread is selected or created. | evidence: `apps/web/src/routes/_chat.index.tsx`
- Root connectivity and failure shells | user | App can show connecting state, desktop-only connection setup, daemon/app version mismatch, and fatal router error details with reload/retry actions. | evidence: `apps/web/src/routes/__root.tsx`, `apps/web/src/components/ConnectionSetup.tsx`
- Bootstrap navigation restore | user | Server welcome payload can auto-expand a bootstrap project and route the app directly into a designated thread. | evidence: `apps/web/src/routes/__root.tsx`, `packages/contracts/src/server.ts`
- Desktop connection setup | user | Electron setup flow supports WSL and external-server connection modes, connection testing, distro discovery, Forge binary verification, and saved connection config. | evidence: `apps/web/src/components/ConnectionSetup.tsx`, `apps/desktop/src/connectionConfig.ts`
- Project creation and dedupe | user | Sidebar can add projects from path or folder picker, dedupe by `cwd`, and auto-create an initial thread for a new project. | evidence: `apps/web/src/components/sidebar/useSidebarInteractions.ts`
- Project sorting | user | Projects can be sorted by updated time, created time, or manual drag order. | evidence: `apps/web/src/components/Sidebar.tsx`, `apps/web/src/components/sidebar/SidebarProjectsSection.tsx`, `packages/contracts/src/settings.ts`
- Thread sorting | user | Threads can be sorted by updated time or created time. | evidence: `apps/web/src/components/Sidebar.tsx`, `packages/contracts/src/settings.ts`
- Project-tree persistence | user | Expanded/collapsed project state and manual ordering are stored locally and migrated from legacy keys. | evidence: `apps/web/src/uiStateStore.ts`
- Project sections and thread tree | user | Projects show pinned and unpinned threads, expandable child-thread trees, and `Show more` truncation for long lists. | evidence: `apps/web/src/components/sidebar/useSidebarData.ts`, `apps/web/src/components/sidebar/SidebarProjectItem.tsx`, `apps/web/src/components/sidebar/SidebarThreadRow.tsx`
- Project status rollups | user | Project rows aggregate hidden-thread and collapsed-state status indicators. | evidence: `apps/web/src/components/sidebar/useSidebarData.ts`, `apps/web/src/components/sidebar/SidebarProjectItem.tsx`
- Rich thread rows | user | Thread rows surface status, unread state, provider/model/role metadata, fork ancestry, PR state, running terminal state, design-mode markers, timestamps, pinning, and archive actions. | evidence: `apps/web/src/storeSidebar.ts`, `apps/web/src/components/sidebar/SidebarThreadRow.tsx`
- Thread context menus | user | Per-thread actions include rename, fork, mark unread, copy workspace path, copy thread id, archive, and delete. | evidence: `apps/web/src/components/sidebar/useSidebarInteractions.ts`
- Multi-select thread handling | user | Sidebar supports Cmd/Ctrl toggle selection, Shift range selection, bulk context-menu actions, Escape clear, and outside-click clear. | evidence: `apps/web/src/threadSelectionStore.ts`, `apps/web/src/components/sidebar/useSidebarInteractions.ts`, `apps/web/src/routes/_chat.tsx`
- Keyboard thread navigation | user | Keybindings support previous/next thread, jump-to-numbered thread hints, and new-thread creation shortcuts. | evidence: `apps/web/src/components/sidebar/useSidebarInteractions.ts`, `packages/contracts/src/keybindings.ts`
- Settings shell | user | `/settings` routes into General and Archive sections, with browser and Electron-specific header variants and back navigation. | evidence: `apps/web/src/routes/settings.tsx`, `apps/web/src/components/settings/SettingsSidebarNav.tsx`
- General client settings | user | UI exposes theme, timestamp format, diff word wrap, assistant streaming, archive/delete confirmations, default thread environment mode, worktree branch prefix, and git text-generation model settings. | evidence: `apps/web/src/components/settings/SettingsPanels.tsx`, `packages/contracts/src/settings.ts`
- Provider administration | operator | Settings can enable/disable providers, edit binary paths and `CODEX_HOME`, refresh health/auth snapshots, inspect provider versions, and manage custom models. | evidence: `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/server/src/provider/Layers/ProviderRegistry.ts`, `apps/server/src/provider/Layers/CodexProvider.ts`, `apps/server/src/provider/Layers/ClaudeProvider.ts`
- Diagnostics and config paths | operator | Settings surfaces `settings.json`, `keybindings.json`, logs directory, observability config, and appearance validation issues, with open-in-editor support. | evidence: `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/chat/OpenInPicker.tsx`
- Keybindings hot reload feedback | operator | Invalid or updated keybindings configs produce toast feedback and direct-open actions. | evidence: `apps/web/src/routes/__root.tsx`, `apps/server/src/keybindings.ts`
- Desktop update surfaces | user | Settings and sidebar expose app version, updater state, download/install controls, and Apple Silicon translation warnings. | evidence: `apps/web/src/components/settings/SettingsPanels.tsx`, `apps/web/src/components/sidebar/SidebarUpdatePill.tsx`, `apps/web/src/components/sidebar/SidebarDesktopUpdateBanner.tsx`, `apps/desktop/src/updateMachine.ts`
- Archived thread management | user | Archived threads are grouped by project and support inline unarchive and delete from the Archive settings view. | evidence: `apps/web/src/routes/settings.archived.tsx`, `apps/web/src/components/settings/SettingsPanels.tsx`

### A.2 Chat, Composer, And Session Runtime

- Chat thread workbench | user | Active chat route can mount the main chat view plus either an inline/sidebar diff panel or design preview panel, with mobile sheet fallbacks. | evidence: `apps/web/src/routes/_chat.$threadId.tsx`
- Composer slash commands | user | Composer recognizes `/plan`, `/default`, `/design`, and `/model`, plus `@path` mentions and inline terminal-context tokens. | evidence: `apps/web/src/composer-logic.ts`
- Persistent composer drafts | user | Per-thread drafts retain prompt text, attachments, images, terminal contexts, provider/model picks, runtime mode, workflow/discussion targeting, and worktree context, with sticky model memory and migration support. | evidence: `apps/web/src/composerDraftStore.ts`
- Mention and path search menu | user | Composer autocomplete supports workspace path suggestions, slash commands, and model suggestions with keyboard-highlight control. | evidence: `apps/web/src/components/chat/ComposerCommandMenu.tsx`, `apps/server/src/ws.ts`
- Interaction-mode switching | user | Composer can switch between Chat, Plan, and Design modes. | evidence: `apps/web/src/components/chat/CompactComposerControlsMenu.tsx`, `packages/contracts/src/orchestration/events.ts`
- Runtime-access switching | user | Composer can toggle between supervised (`approval-required`) and `full-access` runtime modes. | evidence: `apps/web/src/components/chat/CompactComposerControlsMenu.tsx`, `packages/contracts/src/providerSchemas.ts`
- Unified model/workflow/discussion picker | user | A single trigger can represent either direct model selection, a workflow selection, or a discussion selection, and choosing one clears conflicting thread context. | evidence: `apps/web/src/components/chat/UnifiedThreadPicker.tsx`, `apps/web/src/stores/workflowStore.ts`, `apps/web/src/stores/discussionStore.ts`
- Discussion role model overrides | user | Managed discussions can store per-participant model overrides in draft-thread state. | evidence: `apps/web/src/components/chat/DiscussionRolesPicker.tsx`, `apps/web/src/composerDraftStore.ts`
- Provider/model picker | user | Model picker supports Codex and Claude provider/model menus, disables unavailable providers, and shows coming-soon placeholders for future providers. | evidence: `apps/web/src/components/chat/ProviderModelPicker.tsx`
- Provider status warning banner | user | Active thread can show warning/error provider health banners when a provider is degraded or unavailable. | evidence: `apps/web/src/components/chat/ProviderStatusBanner.tsx`
- Model traits controls | user | Provider-specific traits include reasoning effort, thinking toggle, fast mode, context window options, and prompt-controlled ultrathink handling. | evidence: `apps/web/src/components/chat/TraitsPicker.tsx`, `packages/shared/src/model.ts`
- Chat header actions | user | Header exposes project scripts, open-in-editor/file-manager, git actions, terminal toggle, diff toggle, and design-preview toggle. | evidence: `apps/web/src/components/chat/ChatHeader.tsx`
- Open-in-editor picker | user | Workspace can open in Cursor, Trae, VS Code, VS Code Insiders, VSCodium, Zed, Antigravity, IntelliJ, or the system file manager, with a preferred-editor shortcut. | evidence: `apps/web/src/components/chat/OpenInPicker.tsx`, `packages/contracts/src/editor.ts`
- Primary composer actions | user | Send button adapts to running/connecting/busy state, pending-question flow, and plan follow-up actions (`Refine`, `Implement`, `Implement in a new thread`). | evidence: `apps/web/src/components/chat/ComposerPrimaryActions.tsx`
- Pending approval UX | user | Composer surfaces pending command/file-read/file-change approvals and approval counts. | evidence: `apps/web/src/components/chat/ComposerPendingApprovalPanel.tsx`
- Permission-request UX | user | Fine-grained permission requests can be granted per turn or per session, with selectable read/write paths and network toggle. | evidence: `apps/web/src/components/chat/ComposerPendingPermissionPanel.tsx`
- MCP elicitation UX | user | MCP requests support URL opening, structured form answers, raw JSON/text responses, and accept/decline/cancel resolution. | evidence: `apps/web/src/components/chat/ComposerPendingMcpElicitationPanel.tsx`
- Pending user-input wizard | user | Interactive user-input prompts render as numbered multi-step cards with option choices, auto-advance, and digit-key shortcuts. | evidence: `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`, `apps/web/src/pendingUserInput.ts`
- Terminal context chips | user | Composer can attach terminal snapshots as inline chips, including expiration handling and tooltip previews. | evidence: `apps/web/src/components/chat/ComposerPendingTerminalContexts.tsx`, `apps/web/src/lib/terminalContext.ts`
- Plan follow-up banner | user | When a plan is ready, composer shows a dedicated banner and follow-up action state. | evidence: `apps/web/src/components/chat/ComposerPlanFollowUpBanner.tsx`
- Context-window meter | user | Composer shows context-window usage percent/tokens, total processed tokens, and auto-compaction hints. | evidence: `apps/web/src/components/chat/ContextWindowMeter.tsx`, `apps/web/src/lib/contextWindow.ts`
- Rate-limit meter | user | UI shows provider usage ceilings with threshold coloring and reset timing for primary and secondary windows. | evidence: `apps/web/src/components/chat/RateLimitsMeter.tsx`, `packages/contracts/src/server.ts`
- Thread error banner | user | Thread-local error conditions display as dismissible inline alerts. | evidence: `apps/web/src/components/chat/ThreadErrorBanner.tsx`
- Live timeline rendering | user | Thread history is projected into messages, tool activity, summaries, plans, inline diffs, command outputs, and subagent groups with virtualization for large histories. | evidence: `apps/web/src/components/chat/MessagesTimeline.tsx`, `apps/web/src/components/chat/MessagesTimeline.logic.ts`, `apps/web/src/session-logic/index.ts`
- Inline terminal context parsing | user | User messages can embed structured terminal-context references and have them re-rendered as concise context chips/labels. | evidence: `apps/web/src/components/chat/userMessageTerminalContexts.ts`, `apps/web/src/lib/terminalContext.ts`
- Revert and diff entry actions | user | Timeline can open per-turn diffs, expand inline diff previews, and trigger revert actions tied to checkpoint turn counts. | evidence: `apps/web/src/components/chat/MessagesTimeline.tsx`, `apps/web/src/session-logic/approvals.ts`
- Command output viewer | user | Tool output panels auto-stick to bottom, support copy, and can render notices plus bounded-height output. | evidence: `apps/web/src/components/chat/CommandOutputPanel.tsx`, `apps/web/src/components/chat/LazyCommandOutput.tsx`
- Lazy subagent activity feed | user | Parent threads can fetch, poll, and render child-provider-thread work logs on demand, with omitted-entry counts and background-task debugging support. | evidence: `apps/web/src/components/chat/LazySubagentEntries.tsx`, `apps/server/src/ws.ts`
- Background task tray | user | Composer shows a collapsible background tray for long-running commands and subagents, with running/completed/error state, elapsed time, output expansion, and subagent entries. | evidence: `apps/web/src/components/chat/ComposerBackgroundTaskTray.tsx`, `apps/web/src/session-logic/backgroundSignals.ts`
- Summary generation | user | Threads can request model-driven summaries, remember a sticky summary model, and render summary cards with model badge and copy support. | evidence: `apps/web/src/components/chat/SummarizeButton.tsx`, `apps/web/src/components/chat/SummaryCard.tsx`
- Changed-files tree | user | Message-level diff summaries can render directory/file trees with diff stats and click-through into turn diffs. | evidence: `apps/web/src/components/chat/ChangedFilesTree.tsx`
- Native bridge and WS RPC fallback | internal | Client prefers desktop-native APIs when present and otherwise falls back to WS RPC, with reconnect, resubscription, and event replay support. | evidence: `apps/web/src/nativeApi.ts`, `apps/web/src/wsNativeApi.ts`, `apps/web/src/wsTransport.ts`, `apps/web/src/wsRpcClient.ts`
- Session recovery and replay | internal | Client can bootstrap from snapshot, replay orchestration events, and coalesce streamed message events to recover after reconnects. | evidence: `apps/web/src/routes/__root.tsx`, `apps/web/src/orchestrationRecovery.ts`, `apps/web/src/orchestrationEventBatch.ts`, `apps/web/src/orchestrationEventEffects.ts`, `apps/server/src/ws.ts`
- Terminal drawer persistence | user | Terminal UI persists per-thread open state, panel height, splits, active group, running-subprocess state, and a capped event buffer with orphan cleanup. | evidence: `apps/web/src/terminalStateStore.ts`, `apps/web/src/terminalActivity.ts`

### A.3 Workflows, Discussions, Plans, And Human Gates

- Agent Modes surface | user | `/agent-modes` routes into workflow and discussion authoring. | evidence: `apps/web/src/routes/agent-modes.tsx`, `apps/web/src/routes/agent-modes.workflows.*`, `apps/web/src/routes/agent-modes.discussions.*`
- Workflow library | user | Workflow editor sidebar lists built-in, global, and project-scoped workflows with scope badges and phase previews. | evidence: `apps/web/src/components/WorkflowEditor.parts.tsx`
- Workflow authoring | user | Workflows support name, description, global/project scope, create, update, validation, and built-in read-only cloning. | evidence: `apps/web/src/components/WorkflowEditor.tsx`
- Workflow phase strip | user | Phases can be added, removed, reordered, and selected from a horizontal strip. | evidence: `apps/web/src/components/WorkflowEditor.tsx`, `apps/web/src/components/PhaseCard.parts.tsx`
- Phase execution modes | user | Each phase supports single-agent, multi-agent deliberation, automated, and human modes. | evidence: `apps/web/src/components/PhaseCard.parts.tsx`, `packages/contracts/src/workflow.ts`
- Agent prompt/model controls | user | Single-agent phases support prompt-template selection, custom prompt editing, and auto vs override model choice. | evidence: `apps/web/src/components/PhaseCard.fields.tsx`
- Deliberation controls | user | Multi-agent phases expose Advocate and Interrogator definitions with separate prompts, models, and max turns. | evidence: `apps/web/src/components/PhaseCard.parts.tsx`, `packages/contracts/src/workflow.ts`
- Gate and quality-check controls | user | Phases can define post-phase gates, failure behavior, retry targets, max retries, and per-phase quality checks. | evidence: `apps/web/src/components/PhaseCard.gate.tsx`, `packages/contracts/src/workflow.ts`
- Workflow timeline | user | Runtime workflow view shows phase runs, iterations, child-session counts, outputs, transition states, and auto-expansion behavior. | evidence: `apps/web/src/components/WorkflowTimeline.tsx`, `apps/web/src/components/WorkflowTimeline.logic.ts`
- Workflow output modes | user | Phase outputs can render as conversation markdown, channel transcripts, or schema outputs with structured JSON drill-down. | evidence: `apps/web/src/components/WorkflowTimeline.parts.tsx`
- Child-session transcripts | user | Expanded phases can show attached child sessions with role/provider metadata and transcripts. | evidence: `apps/web/src/components/WorkflowTimeline.tsx`
- Human approval gate UI | user | Waiting-human phases surface approval summaries, quality-check results, correction text, and approve/correct/reject actions. | evidence: `apps/web/src/components/GateApproval.tsx`, `apps/web/src/components/WorkflowTimeline.tsx`
- Auto-jump to child sessions | user | Workflow UI can automatically navigate into newly spawned child threads during bootstrap or handoff. | evidence: `apps/web/src/components/WorkflowTimeline.tsx`
- Discussion library | user | Discussions can be filtered by all projects or a specific project, show scope badges and participant roles, and mark shadowed definitions. | evidence: `apps/web/src/components/DiscussionEditor.tsx`
- Discussion authoring | user | Discussions support create/update/delete, global vs project scope, description, participant management, role descriptions, provider/model selection, system prompts, and max turns. | evidence: `apps/web/src/components/DiscussionEditor.tsx`, `apps/web/src/components/DiscussionEditor.logic.ts`, `packages/contracts/src/discussion.ts`
- Proposed plan sidebar | user | Active plans show explanation, step statuses, timestamps, and expandable markdown. | evidence: `apps/web/src/components/PlanSidebar.tsx`
- Plan export and handoff | user | Proposed plans can be copied, downloaded, saved into the workspace, and transformed into implementation prompts, titles, and filenames. | evidence: `apps/web/src/components/PlanSidebar.tsx`, `apps/web/src/proposedPlan.ts`

### A.4 Git, Worktrees, Diffs, Design, And Project Scripts

- Project scripts launcher | user | Each project can define runnable scripts with a preferred primary action, dropdown launcher, shortcuts, icon picker, edit dialog, and delete confirmation. | evidence: `apps/web/src/components/ProjectScriptsControl.tsx`, `apps/web/src/components/ProjectScriptsControl.parts.tsx`
- Worktree bootstrap scripts | user | Project scripts can be marked `run automatically on worktree creation`. | evidence: `apps/web/src/components/ProjectScriptsControl.tsx`, `packages/contracts/src/orchestration/types.ts`
- Git quick action menu | user | Header git control adapts to repo state and exposes init, commit, push, PR creation/opening, and composite stacked actions. | evidence: `apps/web/src/components/GitActionsControl.tsx`, `packages/contracts/src/git.ts`
- Commit review dialog | user | Pre-commit UI can review changed files, include/exclude files, open files in editor, enter message text, and commit on a new branch. | evidence: `apps/web/src/components/GitActionsControl.tsx`
- Git guardrails | user | Default-branch actions can be intercepted with confirmation and progress toasts stay scoped to the initiating thread. | evidence: `apps/web/src/components/GitActionsControl.tsx`, `apps/web/src/components/GitActionsControl.browser.tsx`
- Branch/worktree toolbar | user | Threads can switch between local and new-worktree environments, specify worktree branch names, and show an attached `Worktree` badge. | evidence: `apps/web/src/components/BranchToolbar.tsx`
- Branch selector | user | Searchable branch picker supports infinite loading, virtualization, local/remote checkout, create-branch, existing-worktree reuse, and PR checkout parsing from `#123`, GitHub URLs, or `gh pr checkout ...`. | evidence: `apps/web/src/components/BranchToolbarBranchSelector.tsx`, `apps/web/src/pullRequestReference.ts`
- Route-addressable diff state | user | Diff open state, mode, selected turn, selected file, and design-panel state are encoded in route search params. | evidence: `apps/web/src/diffRouteSearch.ts`, `apps/web/src/routes/_chat.$threadId.tsx`
- Diff modes | user | Diff UI supports agent-attributed diffs vs full-workspace diffs, stacked vs split rendering, word wrap, and manual refresh of non-live workspace diffs. | evidence: `apps/web/src/components/DiffPanel.tsx`
- Diff browsing | user | Diffs can auto-scroll to selected files, show turn-selection chips including `All turns`, virtualize large file lists, and open changed files in the preferred editor. | evidence: `apps/web/src/components/DiffPanel.tsx`, `apps/web/src/components/DiffPanelBody.tsx`
- Diff fallbacks | user | Agent diffs can fall back to workspace snapshots when attribution coverage is unavailable, and huge patches can defer rendering behind a user-triggered action. | evidence: `apps/web/src/components/DiffPanel.logic.ts`, `apps/web/src/components/DiffPanelBody.tsx`
- Compact diff rendering | user | Inline/compact diff cards support stacked and split previews, overflow clamping, summary headers, and raw fallback notices. | evidence: `apps/web/src/components/diff/`
- Design preview | user | Design threads can render HTML artifacts in a sandboxed iframe, switch among multiple artifacts, and preview mobile/tablet/desktop viewport widths. | evidence: `apps/web/src/components/DesignPreviewPanel.tsx`
- Design option resolution | user | When design mode returns multiple options, user can choose an option in-panel and the panel auto-opens when artifacts/options first arrive. | evidence: `apps/web/src/components/DesignPreviewPanel.tsx`, `apps/web/src/routes/_chat.$threadId.tsx`
- Design export to thread | user | Selected design artifacts can be exported into a new thread with artifact and screenshot references. | evidence: `apps/web/src/components/DesignPreviewPanel.tsx`

### A.5 Server Runtime, WS API, Providers, And Terminals

- Runtime modes and startup | operator | `forge` supports `web`, `desktop`, and `daemon` modes, derives config from flags/env/bootstrap-FD, and composes HTTP, WS, provider, terminal, orchestration, and persistence layers. | evidence: `apps/server/src/cli.ts`, `apps/server/src/server.ts`
- Daemon lifecycle CLI | operator | CLI can start, stop, restart, inspect, and clean daemon-managed worktree directories. | evidence: `apps/server/src/cli.ts`
- Daemon session control CLI | operator | CLI can create/list/status sessions, send turns/corrections, approve/reject gates, retry/skip bootstrap, intervene in channels, pause/resume/cancel, answer requests, tail transcripts, and subscribe to event streams. | evidence: `apps/server/src/cli.ts`
- HTTP server surfaces | user | Server exposes `/health`, static client serving, dev-server redirect mode, safe attachment routes, project favicon routes, and design/shared-chat bridge endpoints. | evidence: `apps/server/src/http.ts`
- WS orchestration API | user | `/ws` exposes orchestration snapshot reads, command output, subagent feeds, event replay, thread diffs, full-thread diffs, and agent diffs. | evidence: `apps/server/src/ws.ts`, `packages/contracts/src/orchestration/rpcSchemas.ts`
- WS workflow/discussion/channel API | user | WS exposes transcript reads, child-session reads, request resolution, channel reads, phase outputs, workflow CRUD, discussion CRUD, and live workflow/channel push subscriptions. | evidence: `apps/server/src/ws.ts`
- WS config/settings API | operator | WS can fetch and patch server settings, upsert keybindings, refresh provider snapshots, and subscribe to provider/settings/rate-limit/lifecycle streams. | evidence: `apps/server/src/ws.ts`, `packages/contracts/src/server.ts`
- Workspace and editor API | user | WS can search project entries, guarded-write files inside workspace roots, and open editors/file managers. | evidence: `apps/server/src/ws.ts`, `packages/contracts/src/project.ts`
- Git API | user | WS exposes git status, working-tree diff, pull, stacked-action progress, PR resolution/prep, branch listing/creation/checkout, worktree create/remove, and repo init. | evidence: `apps/server/src/ws.ts`, `packages/contracts/src/git.ts`
- Terminal API | user | WS supports open/write/resize/clear/restart/close terminal sessions, event subscription, history persistence, multiple terminal ids per thread, and running-subprocess state. | evidence: `apps/server/src/ws.ts`, `apps/server/src/terminal/Layers/Manager.ts`, `packages/contracts/src/terminal.ts`
- Lifecycle startup events | user | Server emits `welcome` and `ready` lifecycle streams, including optional bootstrap project/thread ids. | evidence: `apps/server/src/serverRuntimeStartup.ts`, `apps/server/src/serverLifecycleEvents.ts`, `packages/contracts/src/server.ts`
- Auto-bootstrap from current cwd | user | Startup can create a project and first thread from the current working directory when appropriate. | evidence: `apps/server/src/cli.ts`, `apps/server/src/serverRuntimeStartup.ts`
- Server settings service | operator | Settings are sparse JSON with defaults, file-watch reload, validation, and fallback provider/model logic for text generation. | evidence: `apps/server/src/serverSettings.ts`, `packages/contracts/src/settings.ts`
- Keybindings service | operator | Keybindings have defaults, JSON validation, startup backfill, atomic upserts, and watch-driven live updates. | evidence: `apps/server/src/keybindings.ts`, `packages/contracts/src/keybindings.ts`
- Provider registry | operator | Registry aggregates Codex and Claude provider health/auth/version/model snapshots and streams updates into the UI. | evidence: `apps/server/src/provider/Layers/ProviderRegistry.ts`
- Provider session orchestration | internal | Provider service validates inputs, enforces enablement, persists runtime bindings, recovers sessions from persisted state, and supports start/send/interrupt/respond/stop/list/fork/rollback. | evidence: `apps/server/src/provider/Layers/ProviderService.ts`, `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
- Codex provider runtime | user | Codex integration includes CLI version/auth probing, model capabilities, `codex app-server` session start/resume, turn send/interrupt, model switching, rollback, fork, MCP server injection, and system-prompt injection. | evidence: `apps/server/src/provider/Layers/CodexProvider.ts`, `apps/server/src/provider/Layers/CodexAdapter.ts`, `apps/server/src/codexAppServerManager.ts`
- Claude provider runtime | user | Claude integration includes CLI/auth probing, subscription-aware capability adjustments, SDK-backed sessions, MCP registration, model switching, rollback, and fork. | evidence: `apps/server/src/provider/Layers/ClaudeProvider.ts`, `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- Attachment and image handling | user | Server normalizes attachment ids/extensions, stores attachments, and infers image MIME information. | evidence: `apps/server/src/attachmentStore.ts`, `apps/server/src/imageMime.ts`
- Editor launch service | user | Server can discover editors and launch them, including WSL-aware Windows editor bridging and file-manager support. | evidence: `apps/server/src/open.ts`, `packages/contracts/src/editor.ts`

### A.6 Orchestration, Daemon, Persistence, Observability, And Workspace Services

- Bootstrap envelope intake | internal | Server can read bootstrap JSON from an arbitrary inherited file descriptor with timeout and cross-platform fd duplication logic. | evidence: `apps/server/src/bootstrap.ts`
- Daemon singleton lifecycle | operator | Daemon mode enforces single-instance ownership, trusted socket/manifest validation, stale-state cleanup, and graceful/forced shutdown. | evidence: `apps/server/src/daemon/Layers/DaemonService.ts`, `packages/shared/src/daemon.ts`
- Daemon JSON-RPC socket | operator | Daemon exposes a protocol-versioned JSON-RPC socket with `daemon.ping`, `daemon.stop`, and higher-level session/thread/workflow/discussion/channel RPC. | evidence: `apps/server/src/daemon/protocol.ts`, `apps/server/src/daemon/Layers/SocketTransport.ts`
- Notification reactor | user | Daemon can emit desktop notifications for sessions needing attention, session completion, and deliberation completion with deep links. | evidence: `apps/server/src/daemon/Layers/NotificationReactor.ts`, `apps/server/src/daemon/Layers/NotificationDispatch.ts`
- Structured debug logging | operator | `FORGE_DEBUG` drives topic-based NDJSON debug output mirrored to stderr. | evidence: `apps/server/src/debug.ts`
- Observability pipeline | operator | Local trace files are always written and OTLP traces/metrics can be exported when configured. | evidence: `apps/server/src/observability/Layers/Observability.ts`, `apps/server/src/observability/LocalFileTracer.ts`, `apps/server/src/observability/TraceSink.ts`
- RPC instrumentation | operator | RPC calls record span metadata plus per-method duration/outcome metrics. | evidence: `apps/server/src/observability/RpcInstrumentation.ts`
- Analytics hooks | operator | Anonymous analytics identify users from hashed provider identity or persisted anonymous id and attach platform/version metadata. | evidence: `apps/server/src/telemetry/Identify.ts`, `apps/server/src/telemetry/Layers/AnalyticsService.ts`
- SQLite + migrations | internal | Runtime selects Bun or Node SQLite backends, enables WAL/foreign keys, and auto-runs migrations. | evidence: `apps/server/src/persistence/Layers/Sqlite.ts`, `apps/server/src/persistence/Migrations.ts`, `apps/server/src/persistence/NodeSqliteClient.ts`
- Event store and command receipts | internal | Ordered orchestration events and command receipts are persisted for replay, dedupe, and recovery. | evidence: `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`, `apps/server/src/persistence/Layers/OrchestrationCommandReceipts.ts`
- Projection model | internal | Server persists projects, threads, messages, activities, turns, checkpoints, workflows, phase runs, phase outputs, channels, pending approvals, pending requests, and agent diffs. | evidence: `apps/server/src/persistence/Services/*`, `apps/server/src/persistence/Migrations/*`
- Recovery and reconciliation | internal | Stored provider runtime bindings, projector cursors, and pending-turn/request state support startup reconciliation after restarts. | evidence: `apps/server/src/persistence/Layers/ProviderSessionRuntime.ts`, `apps/server/src/orchestration/Layers/StartupReconciliation.ts`
- Workspace search and guarded file writes | user | Workspace layer normalizes roots, blocks traversal/absolute escape, writes files relative to workspace, and offers cached git-aware or filesystem fallback entry search. | evidence: `apps/server/src/workspace/Layers/WorkspacePaths.ts`, `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts`, `apps/server/src/workspace/Layers/WorkspaceEntries.ts`
- Process execution safeguards | internal | Shared subprocess runner enforces timeout, output limits, stdin piping, truncation behavior, and platform-specific cleanup. | evidence: `apps/server/src/processRunner.ts`

### A.7 Desktop Shell, Native Bridge, And Distribution

- Electron desktop bridge | user | Renderer gets a native bridge for folder picking, confirms, theme setting, context menus, external links, update state/actions, connection management, WSL discovery, and open-in-editor. | evidence: `apps/desktop/src/preload.ts`, `packages/contracts/src/ipc.ts`
- Local vs WSL vs external connection modes | user | Desktop app can connect to a locally managed daemon, a Forge instance inside WSL, or an arbitrary external WS server. | evidence: `apps/desktop/src/connectionConfig.ts`, `apps/desktop/src/main.ts`
- Protocol-handler and single-instance behavior | user | Desktop app registers `forge://` handling and coordinates second-instance/open-url routing. | evidence: `apps/desktop/src/daemonLifecycle.ts`, `apps/desktop/src/main.ts`
- Managed daemon launch | user | Desktop can spawn and supervise a detached local daemon, detect an existing daemon, and reconnect after connection changes. | evidence: `apps/desktop/src/daemonLifecycle.ts`, `apps/desktop/src/main.ts`
- WSL integration | user | Windows desktop can enumerate WSL distros, verify a Forge binary inside a distro, resolve WSL home, translate Linux paths to UNC, and launch the backend through `wsl.exe`. | evidence: `apps/desktop/src/wsl.ts`, `apps/desktop/src/daemonLifecycle.ts`, `apps/desktop/src/main.ts`
- WSL editor launch | user | In WSL mode, desktop can detect Windows editor CLIs and open Linux paths in Windows editors/file manager with line/column support. | evidence: `apps/desktop/src/editorLaunch.ts`
- Native folder picking and confirmations | user | Desktop IPC supports folder selection, confirm dialogs, safe external URL opening, and native context menus. | evidence: `apps/desktop/src/main.ts`, `apps/desktop/src/preload.ts`
- Desktop tray and status | user | Desktop maintains a tray icon/menu reflecting daemon status and common actions. | evidence: `apps/desktop/src/main.ts`
- Auto-update system | user | Desktop supports update checks, download/install, feed configuration, startup polling, progress broadcasting, and packaged-build eligibility rules. | evidence: `apps/desktop/src/main.ts`, `apps/desktop/src/updateMachine.ts`, `apps/desktop/src/updateState.ts`
- Desktop logging | operator | Packaged desktop build captures stdout/stderr into rotating logs and records desktop lifecycle metadata. | evidence: `apps/desktop/src/main.ts`, `packages/shared/src/logging.ts`
- Marketing landing page | user | Marketing site shows hero download CTA, screenshot, and platform-detected asset selection. | evidence: `apps/marketing/src/pages/index.astro`, `apps/marketing/src/lib/releases.ts`
- Download page | user | Download page lists platform-specific installers, latest release tag, changelog link, and fallback to GitHub Releases. | evidence: `apps/marketing/src/pages/download.astro`, `apps/marketing/src/lib/releases.ts`

### A.8 Hidden, Conditional, And Gated Behavior

- Desktop connection setup only appears when running in Electron and no desktop WS URL has been configured. | evidence: `apps/web/src/routes/__root.tsx`
- WSL setup is Windows/Electron-specific and depends on available distros plus a resolvable Forge binary inside WSL. | evidence: `apps/web/src/components/ConnectionSetup.tsx`, `apps/desktop/src/wsl.ts`
- External-server connect is gated on a successful connection test before the UI enables a full connect/save flow. | evidence: `apps/web/src/components/ConnectionSetup.tsx`, `apps/desktop/src/main.ts`
- Add-project behavior differs by platform: Electron can browse for folders, while non-Electron/web falls back to typed path entry. | evidence: `apps/web/src/components/sidebar/useSidebarInteractions.ts`
- Manual project drag-reordering is only active when project sort order is `manual`. | evidence: `apps/web/src/components/Sidebar.tsx`
- Traits menu only appears when the selected model exposes effort/thinking/context-window controls. | evidence: `apps/web/src/components/chat/TraitsPicker.tsx`
- Workflow/discussion targeting menus only appear when a draft thread exists and matching workflow/discussion data is available. | evidence: `apps/web/src/components/chat/UnifiedThreadPicker.tsx`
- Discussion role picker is hidden when the selected discussion has no participants. | evidence: `apps/web/src/components/chat/DiscussionRolesPicker.tsx`
- Workflow built-ins are viewable but not directly editable; they must be cloned before saving. | evidence: `apps/web/src/components/WorkflowEditor.tsx`
- Discussion `Shadowed` status is conditional on managed/effective discussion resolution. | evidence: `apps/web/src/components/DiscussionEditor.tsx`
- Branch selector behavior changes in worktree mode: branch choice can become base-branch selection instead of immediate checkout. | evidence: `apps/web/src/components/BranchToolbarBranchSelector.tsx`
- `diffTurnId` and `diffFilePath` only remain meaningful in agent-diff mode; workspace mode strips them. | evidence: `apps/web/src/diffRouteSearch.ts`
- Huge diffs deliberately defer rich rendering until the user requests it. | evidence: `apps/web/src/components/DiffPanelBody.tsx`
- Design preview only appears in design interaction mode and auto-opens once artifacts or pending choices first arrive. | evidence: `apps/web/src/routes/_chat.$threadId.tsx`, `apps/web/src/components/chat/ChatHeader.tsx`
- Save-plan-to-workspace requires both a workspace root and a live native API connection. | evidence: `apps/web/src/components/PlanSidebar.tsx`
- Direct summary dispatch remains disabled until the user has chosen a sticky summary model. | evidence: `apps/web/src/components/chat/SummarizeButton.tsx`
- Provider availability is conditional on enablement, binary discovery, auth status, provider-specific probes, and subscription/model capability detection. | evidence: `apps/server/src/provider/Layers/CodexProvider.ts`, `apps/server/src/provider/Layers/ClaudeProvider.ts`
- Provider session recovery depends on persisted runtime bindings and usually a stored resume cursor; missing state does not silently recreate sessions. | evidence: `apps/server/src/provider/Layers/ProviderService.ts`
- Terminal spawn environment strips `FORGE_*`, `VITE_*`, and selected port env vars before launching shells. | evidence: `apps/server/src/terminal/Layers/Manager.ts`
- Terminal history persists across reopen/restart unless explicitly deleted. | evidence: `apps/server/src/terminal/Layers/Manager.ts`
- `/ws` and bridge endpoints only require auth if `config.authToken` is set; otherwise they run unauthenticated. | evidence: `apps/server/src/ws.ts`, `apps/server/src/http.ts`
- `web` mode defaults `autoBootstrapProjectFromCwd=true`; `desktop` and `daemon` pin loopback/no-browser defaults differently. | evidence: `apps/server/src/cli.ts`
- OTLP export is conditional on configured URLs, while local trace-file capture is always constructed. | evidence: `apps/server/src/observability/Layers/Observability.ts`
- Auto-update is only enabled in packaged production builds, and Linux auto-update requires AppImage packaging. | evidence: `apps/desktop/src/updateState.ts`

### A.9 Latent, Incomplete, Or Ambiguous Surfaces

- Workflow deletion looks partially implemented in component props but is not wired into the current editor flow. | evidence: `apps/web/src/components/WorkflowEditor.parts.tsx`, `apps/web/src/components/WorkflowEditor.tsx`
- Workflow scope selection is implicit: project-scoped workflows auto-bind to the first project rather than exposing a full explicit picker. | evidence: `apps/web/src/components/WorkflowEditor.tsx`
- Discussion project scoping for new items is influenced by sidebar filter state rather than a dedicated project picker. | evidence: `apps/web/src/components/DiscussionEditor.tsx`
- Workflow-picker logic distinguishes `discussion` vs `workflow` items via deliberation, but that split is not obviously exposed as a dedicated user-facing picker surface in the audited files. | evidence: `apps/web/src/components/WorkflowPicker.logic.ts`
- Some persistence tables exist without clearly exposed runtime services in this repo slice, including raw checkpoint diff blobs and several phase/session provenance tables. | evidence: `apps/server/src/persistence/Migrations/003_CheckpointDiffBlobs.ts`, `apps/server/src/persistence/Migrations/021_ChannelTables.ts`, `apps/server/src/persistence/Migrations/023_PhaseOutputTables.ts`
- `sessionType.ts` includes a `chat` session type while the audited CLI create path only surfaced `agent` and `workflow`; the primary `chat` creation entrypoint appears to be elsewhere in the stack. | evidence: `apps/server/src/sessionType.ts`, `apps/server/src/cli.ts`
- Codex dynamic tool plumbing exists in `codexAppServerManager`, but the exact exposed product flow is not self-contained in the audited provider slice. | evidence: `apps/server/src/codexAppServerManager.ts`
- Shared-chat/design bridge tokens are clearly consumed by HTTP routes, but token issuance/cleanup are managed out-of-band from the routes themselves. | evidence: `apps/server/src/http.ts`, `apps/server/src/design/designBridge.ts`, `apps/server/src/discussion/sharedChatBridge.ts`
- Design export and selection error handling leans on console logging in places rather than consistently surfacing user-visible failure UI. | evidence: `apps/web/src/components/DesignPreviewPanel.tsx`
- Background tray ownership is partly unresolved: some timeline/tray ownership helpers are effectively no-ops, which suggests unfinished inline-vs-tray separation. | evidence: `apps/web/src/session-logic/utils.ts`, `apps/web/src/session-logic/timeline.ts`
- Codex subagent fan-out is lossy in at least one path: only the first matched child subagent group is attached to a parent spawn row. | evidence: `apps/web/src/session-logic/subagentGrouping.ts`

### A.10 Bottom Line

Forge is already much broader than a basic chat wrapper. The current product surface spans:
- Multi-provider coding-agent sessions with live streaming, approvals, permission negotiation, MCP elicitation, summaries, and subagent/background-task visibility.
- Full workflow and discussion authoring plus runtime workflow timelines and human approval gates.
- Git/worktree orchestration, route-addressable diff review, design-mode artifact preview/export, and project script automation.
- A real server platform with daemon mode, event sourcing/projections, terminal multiplexing, provider recovery, observability, analytics, and guarded workspace APIs.
- A desktop shell with managed daemon lifecycle, WSL bridging, native editor integration, updater flows, and a separate marketing/download surface.
