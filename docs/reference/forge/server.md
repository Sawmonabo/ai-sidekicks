# Forge Server — Exhaustive Feature and Implementation Inventory

> Source-code exploration of `/home/sabossedgh/dev/external/forge/apps/server/src/`.
> Paths shown in the source tree below are relative to `apps/server/src/` in the Forge checkout.
> Generated: 2026-04-14

---

## 1. Directory Structure

```
src/
  __test__/                          # Test helpers (ids, waitFor)
  attachmentPaths.ts                 # Attachment path normalization
  attachmentStore.ts / .test.ts      # Attachment persistence by ID
  bin.ts                             # Binary entrypoint
  bootstrap.ts / .test.ts            # Bootstrap envelope reader (file-descriptor secrets)
  channel/
    Errors.ts
    Layers/
      ChannelService.ts / .test.ts
      CodexChannelInjection.ts / .test.ts
      DeliberationEngine.ts / .test.ts
      McpChannelServer.ts / .test.ts
    Services/
      ChannelService.ts
      DeliberationEngine.ts
    Utils.ts
  checkpointing/
    Diffs.ts / .test.ts
    Errors.ts
    Layers/
      CheckpointDiffQuery.ts / .test.ts
      CheckpointStore.ts / .test.ts
    Services/
      CheckpointDiffQuery.ts
      CheckpointStore.ts
  cli.ts / .test.ts / cli-config.test.ts
  codexAppServerManager.ts / .test.ts
  config.ts / .test.ts
  daemon/
    cliClient.ts                     # CLI-side daemon client helpers
    Errors.ts
    Layers/
      DaemonService.ts               # Singleton lifecycle, lock, PID, socket
      NotificationDispatch.ts        # OS-native notification dispatch
      NotificationReactor.ts         # Event-driven notification triggers
      Runtime.ts                     # Daemon runtime orchestration
      SocketTransport.ts             # JSON-RPC Unix socket server
    protocol.ts                      # Protocol version constants
    Services/
      DaemonRuntime.ts
      DaemonService.ts
      NotificationDispatch.ts
      NotificationReactor.ts
      SocketTransport.ts
  debug.ts / .test.ts
  design/
    artifactStorage.ts               # HTML artifact persistence
    designBridge.ts                   # Design bridge HTTP callback
    DesignModeReactor.ts / .test.ts   # Orchestration reactor for design events
    designMcpProcess.ts / .test.ts    # Stdio MCP server subprocess
    designMcpServer.ts               # MCP server implementation
    designSystemPrompt.ts            # Design mode system prompt
    screenshotService.ts             # Headless screenshot capture
  discussion/
    Errors.ts
    Layers/
      DiscussionRegistry.ts / .test.ts
    Services/
      DiscussionRegistry.ts
    sharedChatBridge.ts / .test.ts   # HTTP bridge for shared chat
    sharedChatMcpProcess.ts / .test.ts
    sharedChatMcpServer.ts / .test.ts
  git/
    Layers/
      GitCore.ts                     # Low-level git command execution
      GitHubCli.ts                   # `gh` CLI integration
      GitManager.ts                  # High-level stacked workflow actions
      RoutingTextGeneration.ts       # LLM-assisted commit message generation
    remoteRefs.ts                    # Remote ref parsing
    Services/
      GitCore.ts
      GitHubCli.ts
      GitManager.ts
      RoutingTextGeneration.ts
  http.ts                            # HTTP route definitions
  imageMime.ts / .test.ts            # Image MIME detection
  keybindings.ts / .test.ts          # Keybinding configuration service
  mcp/
    cliEntrypoint.ts
    mcpHelpers.ts
  observability/
    Attributes.ts
    Layers/
      Observability.ts               # Tracer + metrics + logger composition
    LocalFileTracer.ts               # Rotating NDJSON file tracer
    Metrics.ts                       # Counter/timer metric definitions
    RpcInstrumentation.ts            # Span wrappers for RPC methods
  open.ts / .test.ts                 # Editor launch service
  orchestration/
    commandInlineDiffArtifacts.ts / .test.ts
    commandInvariants.ts / .test.ts  # Command precondition guards
    decider.ts                       # Event-sourcing decider (command -> events)
    decider.*.test.ts
    Errors.ts
    Layers/
      AgentDiffQuery.ts / .test.ts
      BootstrapReactor.ts / .test.ts
      ChannelReactor.ts / .test.ts
      CheckpointReactor.ts / .test.ts
      DiscussionReactor.ts / .test.ts
      OrchestrationEngine.ts / .test.ts
      OrchestrationReactor.ts / .test.ts
      ProjectionPipeline.ts / .test.ts
      ProjectionSnapshotQuery.ts / .test.ts
      ProviderCommandReactor.ts / .test.ts
      ProviderRuntimeIngestion.ts / .test.ts
      RuntimeReceiptBus.ts
      StartupReconciliation.ts / .test.ts
      WorkflowReactor.ts / .test.ts
      runtimeIngestion/
        activityMapping.ts
        helpers.ts
        testHarness.ts
    Normalizer.ts                    # Command normalization
    orderedReplayAndLiveStream.ts / .test.ts
    projector.ts / .test.ts          # Event-sourcing projector (events -> read model)
    Schemas.ts
    Services/
      AgentDiffQuery.ts
      BootstrapReactor.ts
      ChannelReactor.ts
      CheckpointReactor.ts
      DesignModeReactor.ts
      DiscussionReactor.ts
      OrchestrationEngine.ts
      OrchestrationReactor.ts
      ProjectionPipeline.ts
      ProjectionSnapshotQuery.ts
      ProviderCommandReactor.ts
      ProviderRuntimeIngestion.ts
      RuntimeReceiptBus.ts
      StartupReconciliation.ts
      WorkflowReactor.ts
    threadActivityTransport.ts / .test.ts
    toolDiffArtifacts.ts / .test.ts
    toolDiffPaths.ts / .test.ts
  os-jank.ts / .test.ts             # PATH fixup for macOS
  persistence/
    Errors.ts
    Layers/ (all projection repositories + SQLite + event store)
    Migrations/ (001-034, see section 7)
    Migrations.ts                    # Migration runner
    NodeSqliteClient.ts / .test.ts
    Services/ (all projection repository contracts)
  processRunner.ts / .test.ts       # Subprocess execution with timeout/guards
  productIdentity.test.ts
  project/
    Layers/
      ProjectFaviconResolver.ts
    Services/
      ProjectFaviconResolver.ts
  provider/
    adapterUtils.ts
    claudeOAuthCredential.ts
    Errors.ts
    Layers/
      claude/                        # Claude adapter internals
        sessionLifecycle.ts
        streamHandlers.ts
        types.ts
      codex/                         # Codex adapter internals
        mapToRuntimeEvents.ts
        types.ts
      ClaudeAdapter.ts
      CodexAdapter.ts
      EventNdjsonLogger.ts
      ProviderAdapterRegistry.ts
      ProviderRegistry.ts
      ProviderService.ts
      ProviderSessionDirectory.ts
    pendingMcpServers.ts
    rateLimitNormalizer.ts
    Services/
      ClaudeAdapter.ts
      CodexAdapter.ts
      ProviderAdapterRegistry.ts
      ProviderRegistry.ts
      ProviderService.ts
      ProviderSessionDirectory.ts
  server.ts                          # Layer composition and startup
  serverLifecycleEvents.ts / .test.ts
  serverLogger.ts
  serverRuntimeStartup.ts / .test.ts
  serverSettings.ts / .test.ts
  sessionType.ts / .test.ts
  telemetry/
    Layers/
      AnalyticsService.ts
    Services/
      AnalyticsService.ts
  terminal/
    Layers/
      BunPTY.ts                      # Bun PTY adapter
      Manager.ts                     # Terminal session manager
      NodePTY.ts                     # Node.js PTY adapter
    Services/
      Manager.ts
      PTY.ts
  workflow/
    builtins/
      Builtins.test.ts
    Errors.ts
    Layers/
      InputResolver.ts / .test.ts
      PromptResolver.ts / .test.ts
      QualityCheckRunner.ts / .test.ts
      WorkflowEngine.ts / .test.ts
      WorkflowRegistry.ts / .test.ts
    prompts/
      Prompts.test.ts
    Services/
      PromptResolver.ts
      QualityCheckRunner.ts
      WorkflowEngine.ts
      WorkflowRegistry.ts
  workspace/
    Layers/
      WorkspaceEntries.ts
      WorkspaceFileSystem.ts
      WorkspacePaths.ts
    Services/
      WorkspaceEntries.ts
      WorkspaceFileSystem.ts
      WorkspacePaths.ts
  ws.ts                              # WebSocket RPC API surface
```

---

## 2. Runtime Modes and Startup

### 2.1 Runtime Modes

Defined in `config.ts` as `Schema.Literals(["web", "desktop", "daemon"])`.

| Mode | Default Host | Auto Browser | Auth Token | Description |
|------|-------------|-------------|-----------|-------------|
| `web` | `undefined` (0.0.0.0) | Yes | From config | Standard web server mode |
| `desktop` | `127.0.0.1` | No | From config | Electron/desktop integration |
| `daemon` | `127.0.0.1` | No | Auto-generated (random 32-byte hex) | Background singleton process |

### 2.2 CLI Commands (`apps/server/src/cli.ts`)

**Root command**: `forge [flags]` -- starts the server.

**Flags**: `--mode`, `--port`, `--host`, `--base-dir`, `--dev-url`, `--no-browser`, `--auth-token`, `--bootstrap-fd`, `--auto-bootstrap-project-from-cwd`, `--log-websocket-events`.

**Environment variables**: `FORGE_MODE`, `FORGE_PORT`, `FORGE_HOST`, `FORGE_HOME`, `FORGE_AUTH_TOKEN`, `FORGE_NO_BROWSER`, `FORGE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD`, `FORGE_LOG_WS_EVENTS`, `VITE_DEV_SERVER_URL`, `FORGE_LOG_LEVEL`, `FORGE_TRACE_FILE`, `FORGE_TRACE_MIN_LEVEL`, `FORGE_TRACE_TIMING_ENABLED`, `FORGE_TRACE_MAX_BYTES`, `FORGE_TRACE_MAX_FILES`, `FORGE_TRACE_BATCH_WINDOW_MS`, `FORGE_OTLP_TRACES_URL`, `FORGE_OTLP_METRICS_URL`, `FORGE_OTLP_EXPORT_INTERVAL_MS`, `FORGE_OTLP_SERVICE_NAME`, `FORGE_BOOTSTRAP_FD`.

**Precedence**: CLI flag > environment variable > bootstrap envelope > defaults.

**Subcommands (daemon client)**:
- `forge list` -- list sessions from running daemon
- `forge status [session-id]` -- show daemon/session status
- `forge create <title> --project <path> [--model <provider:model>] [--type agent|workflow] [--workflow <name>]`
- `forge correct <session-id> <message>`
- `forge approve <session-id> [--phase-run-id]`
- `forge reject <session-id> [reason] [--phase-run-id]`
- `forge bootstrap-retry <session-id>`
- `forge bootstrap-skip <session-id>`
- `forge intervene <channel-id> <message> [--role]`
- `forge pause <session-id>`
- `forge resume <session-id>`
- `forge cancel <session-id> [--reason]`
- `forge answer <request-id> --input <text>`
- `forge watch [--once] [--interval-ms]`
- `forge logs <session-id> [--once] [--interval-ms]`
- `forge events [--max-events] [--once]`
- `forge cleanup` -- remove empty worktree directories
- `forge daemon start|stop|status|restart`
- `forge shared-chat-mcp` -- internal stdio MCP server for shared chat
- `forge design-mcp` -- internal stdio MCP server for design mode

### 2.3 Bootstrap Envelope (`bootstrap.ts`)

Reads one-time secrets from a file descriptor (`--bootstrap-fd` or `FORGE_BOOTSTRAP_FD`). Schema includes: `mode`, `port`, `host`, `forgeHome`, `devUrl`, `noBrowser`, `authToken`, `autoBootstrapProjectFromCwd`, `logWebSocketEvents`, `otlpTracesUrl`, `otlpMetricsUrl`.

### 2.4 Server Composition (`apps/server/src/server.ts`)

Built with Effect layers. Startup sequence:

1. Platform detection (Bun vs. Node) for HTTP server and PTY adapter
2. Persistence layer (SQLite) initialized
3. Projection repositories layer initialized
4. Orchestration engine layer (event store + command receipts + projection pipeline + snapshot query)
5. Provider layer (Codex adapter + Claude adapter + adapter registry + provider service + session directory)
6. Git layer (GitCore + GitHubCli + RoutingTextGeneration + GitManager)
7. Terminal layer (TerminalManager + PTY adapter)
8. Workspace layer (WorkspacePaths + WorkspaceEntries + WorkspaceFileSystem)
9. Checkpointing layer (CheckpointStore + CheckpointDiffQuery + AgentDiffQuery)
10. Orchestration reactor pipeline (ProviderRuntimeIngestion + DiscussionReactor + DesignModeReactor + ProviderCommandReactor + CheckpointReactor + BootstrapReactor + WorkflowReactor + ChannelReactor)
11. Startup reconciliation
12. Server runtime startup (orchestration reactor start + reconciliation + keybindings + settings + analytics + open + lifecycle events)
13. HTTP routes served
14. In daemon mode: daemon runtime wraps the HTTP server launch with socket transport and notification reactor

### 2.5 Server Runtime Startup (`serverRuntimeStartup.ts`)

Implements a command gate pattern:
- `awaitCommandReady` -- blocks until orchestration is ready
- `markHttpListening` -- signals HTTP server is up
- `enqueueCommand` -- queues commands during startup, executes after ready

Records a startup heartbeat to analytics with thread/project counts.

### 2.6 Lifecycle Events (`serverLifecycleEvents.ts`)

Publishes lifecycle events to clients via `subscribeServerLifecycle` stream. Events have monotonic sequence numbers.

---

## 3. WebSocket API Surface (`ws.ts`)

Protocol: Effect RPC over WebSocket at `/ws` endpoint. Token authentication via `?token=` query parameter when `authToken` is configured.

### 3.1 Orchestration RPC Methods

| Method Key | Type | Description |
|-----------|------|-------------|
| `ORCHESTRATION_WS_METHODS.getSnapshot` | Request/Response | Load full orchestration read model (sanitized for transport) |
| `ORCHESTRATION_WS_METHODS.getCommandOutput` | Request/Response | Load command output for a specific activity ID |
| `ORCHESTRATION_WS_METHODS.getSubagentActivityFeed` | Request/Response | Load subagent activity feed with debug logging |
| `ORCHESTRATION_WS_METHODS.dispatchCommand` | Request/Response | Normalize and dispatch an orchestration command |
| `ORCHESTRATION_WS_METHODS.getTurnDiff` | Request/Response | Get checkpoint diff for a specific turn |
| `ORCHESTRATION_WS_METHODS.getFullThreadDiff` | Request/Response | Get full thread cumulative diff |
| `ORCHESTRATION_WS_METHODS.getTurnAgentDiff` | Request/Response | Get agent-reported diff for a turn |
| `ORCHESTRATION_WS_METHODS.getFullThreadAgentDiff` | Request/Response | Get full thread agent-reported diff |
| `ORCHESTRATION_WS_METHODS.replayEvents` | Request/Response | Replay domain events from a sequence number |

### 3.2 Session / Thread Methods

| Method Key | Type | Description |
|-----------|------|-------------|
| `WS_METHODS.threadGetTranscript` | Request/Response | Load paginated transcript for a thread |
| `WS_METHODS.threadGetChildren` | Request/Response | Load child session summaries |
| `WS_METHODS.sessionGetTranscript` | Request/Response | Alias: load transcript by session ID |
| `WS_METHODS.sessionGetChildren` | Request/Response | Alias: load children by session ID |
| `WS_METHODS.requestResolve` | Request/Response | Resolve an interactive request |

### 3.3 Channel Methods

| Method Key | Type | Description |
|-----------|------|-------------|
| `WS_METHODS.channelGetMessages` | Request/Response | Load channel messages with pagination |
| `WS_METHODS.channelGetChannel` | Request/Response | Load a single channel |

### 3.4 Workflow Methods

| Method Key | Type | Description |
|-----------|------|-------------|
| `WS_METHODS.phaseRunList` | Request/Response | List phase runs for a thread |
| `WS_METHODS.phaseRunGet` | Request/Response | Get a specific phase run |
| `WS_METHODS.phaseOutputGet` | Request/Response | Get a specific phase output |
| `WS_METHODS.workflowList` | Request/Response | List all workflows |
| `WS_METHODS.workflowGet` | Request/Response | Get a specific workflow |
| `WS_METHODS.workflowCreate` | Request/Response | Create/upsert a workflow |
| `WS_METHODS.workflowUpdate` | Request/Response | Update/upsert a workflow |

### 3.5 Discussion Methods

| Method Key | Type | Description |
|-----------|------|-------------|
| `WS_METHODS.discussionList` | Request/Response | List discussions |
| `WS_METHODS.discussionGet` | Request/Response | Get a discussion by name |
| `WS_METHODS.discussionListManaged` | Request/Response | List managed discussions with effective flag |
| `WS_METHODS.discussionGetManaged` | Request/Response | Get a managed discussion by name + scope |
| `WS_METHODS.discussionCreate` | Request/Response | Create a discussion |
| `WS_METHODS.discussionUpdate` | Request/Response | Update a discussion |
| `WS_METHODS.discussionDelete` | Request/Response | Delete a discussion |

### 3.6 Subscription Streams

| Method Key | Type | Description |
|-----------|------|-------------|
| `WS_METHODS.subscribeOrchestrationDomainEvents` | Stream | Live orchestration domain events from a sequence |
| `WS_METHODS.subscribeWorkflowEvents` | Stream | All workflow push events (phase, gate, bootstrap, quality-check) |
| `WS_METHODS.subscribeChannelMessages` | Stream | All channel push events (message, conclusion, status) |
| `WS_METHODS.subscribeWorkflowPhase` | Stream | Filtered: workflow.phase events only |
| `WS_METHODS.subscribeWorkflowQualityChecks` | Stream | Filtered: workflow.quality-check events only |
| `WS_METHODS.subscribeWorkflowBootstrap` | Stream | Filtered: workflow.bootstrap events only |
| `WS_METHODS.subscribeWorkflowGate` | Stream | Filtered: workflow.gate events only |
| `WS_METHODS.subscribeChannelMessage` | Stream | Filtered: channel.message events only |
| `WS_METHODS.subscribeTerminalEvents` | Stream | Terminal output/exit/status events |
| `WS_METHODS.subscribeServerConfig` | Stream | Server config changes (keybindings, providers, settings, rate limits) |
| `WS_METHODS.subscribeServerLifecycle` | Stream | Server lifecycle events |

### 3.7 Server Config Methods

| Method Key | Type | Description |
|-----------|------|-------------|
| `WS_METHODS.serverGetConfig` | Request/Response | Load full server config (cwd, keybindings, providers, editors, observability, settings) |
| `WS_METHODS.serverRefreshProviders` | Request/Response | Refresh and return provider list |
| `WS_METHODS.serverUpsertKeybinding` | Request/Response | Upsert a keybinding rule |
| `WS_METHODS.serverGetSettings` | Request/Response | Get current settings |
| `WS_METHODS.serverUpdateSettings` | Request/Response | Apply a settings patch |

### 3.8 Workspace Methods

| Method Key | Type | Description |
|-----------|------|-------------|
| `WS_METHODS.projectsSearchEntries` | Request/Response | Search workspace file entries |
| `WS_METHODS.projectsWriteFile` | Request/Response | Write a file within project root |
| `WS_METHODS.shellOpenInEditor` | Request/Response | Open file in editor |

### 3.9 Git Methods

| Method Key | Type | Description |
|-----------|------|-------------|
| `WS_METHODS.gitStatus` | Request/Response | Git status + upstream + PR metadata |
| `WS_METHODS.gitWorkingTreeDiff` | Request/Response | Working tree diff |
| `WS_METHODS.gitPull` | Request/Response | Pull current branch |
| `WS_METHODS.gitRunStackedAction` | Stream | Stacked git action (commit/push/PR) with progress events |
| `WS_METHODS.gitResolvePullRequest` | Request/Response | Resolve PR by URL/number |
| `WS_METHODS.gitPreparePullRequestThread` | Request/Response | Prepare thread workspace from PR |
| `WS_METHODS.gitListBranches` | Request/Response | List branches |
| `WS_METHODS.gitCreateWorktree` | Request/Response | Create git worktree |
| `WS_METHODS.gitRemoveWorktree` | Request/Response | Remove git worktree |
| `WS_METHODS.gitCreateBranch` | Request/Response | Create branch |
| `WS_METHODS.gitCheckout` | Request/Response | Checkout branch |
| `WS_METHODS.gitInit` | Request/Response | Initialize git repo |

### 3.10 Terminal Methods

| Method Key | Type | Description |
|-----------|------|-------------|
| `WS_METHODS.terminalOpen` | Request/Response | Open a terminal session |
| `WS_METHODS.terminalWrite` | Request/Response | Write to terminal stdin |
| `WS_METHODS.terminalResize` | Request/Response | Resize terminal |
| `WS_METHODS.terminalClear` | Request/Response | Clear terminal history |
| `WS_METHODS.terminalRestart` | Request/Response | Restart terminal session |
| `WS_METHODS.terminalClose` | Request/Response | Close terminal session |

### 3.11 Push Event Types

**Workflow push events** (`WorkflowPushEvent`):
- `workflow.phase` (started, completed, failed, skipped)
- `workflow.gate` (waiting-human, evaluating, passed, failed)
- `workflow.quality-check` (running, passed, failed)
- `workflow.bootstrap` (started, completed, failed, skipped)

**Channel push events** (`ChannelPushEvent`):
- `channel.message` (new message posted)
- `channel.conclusion` (conclusion proposed)
- `channel.status` (concluded, closed)

**Rate limits**: Normalized from Codex and Claude providers, streamed via `subscribeServerConfig`.

---

## 4. HTTP API Surface (`http.ts`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (`{"status": "ok"}`) |
| `GET` | `/attachments/*` | Serve attachment files (by ID or relative path). Immutable cache headers. |
| `GET` | `/api/project-favicon` | Resolve project favicon by `?cwd=` param. SVG fallback. |
| `POST` | `/api/internal/shared-chat-bridge` | Shared chat bridge. Bearer auth. JSON body: `{token, message}`. |
| `POST` | `/api/internal/design-bridge` | Design bridge. Bearer auth. JSON body: `{token, action}`. |
| `GET` | `/api/internal/design/artifacts/<threadId>/<artifactId>.html` | Serve design artifact HTML |
| `GET` | `/api/internal/design/artifact-list/<threadId>` | List design artifacts for a thread |
| `POST` | `/api/internal/design/artifacts/<threadId>/<artifactId>/screenshot` | Capture artifact screenshot |
| `GET` | `/ws` | WebSocket upgrade endpoint (RPC) |
| `GET` | `*` | Static file serving or dev URL redirect |

---

## 5. Orchestration Engine

### 5.1 Architecture: Event Sourcing

The orchestration layer uses a classic event-sourcing pattern built with Effect:

- **Decider** (`decider.ts`): Pure function `decideOrchestrationCommand(command, readModel) -> events[]`. Validates command invariants against the current read model, then produces domain events. No side effects.
- **Projector** (`projector.ts`): Pure function `projectEvent(readModel, event) -> readModel`. Folds each event into the in-memory read model.
- **Engine** (`OrchestrationEngine.ts`): Serialized command processor. Enqueues commands, runs them one-at-a-time through the decider, persists events to the event store, updates the in-memory read model via the projector, publishes events on a PubSub. Maintains command receipts for idempotency.

### 5.2 Aggregate Kinds

- `project` -- workspace project lifecycle
- `thread` -- session/thread lifecycle
- `channel` -- deliberation channel lifecycle
- `request` -- interactive request lifecycle

### 5.3 Command Types (from decider.ts)

**Project commands:**
- `project.create`
- `project.meta.update` (title, workspaceRoot, defaultModelSelection, scripts)
- `project.delete`

**Thread (session) commands:**
- `thread.create` -- with optional workflow, discussion, parent, role, branch, worktree
- `thread.fork` -- fork from an existing thread
- `thread.send-turn` -- user message
- `thread.correct` -- mid-session correction
- `thread.pause`
- `thread.resume`
- `thread.cancel`
- `thread.archive`
- `thread.unarchive`
- `thread.pin`
- `thread.unpin`
- `thread.promote` -- promote sub-thread

**Workflow thread commands:**
- `thread.start-phase`
- `thread.complete-phase`
- `thread.fail-phase`
- `thread.skip-phase`
- `thread.edit-phase-output`
- `thread.quality-check-start`
- `thread.quality-check-complete`
- `thread.bootstrap-started`
- `thread.bootstrap-completed`
- `thread.bootstrap-failed`
- `thread.bootstrap-skipped`
- `thread.add-link`
- `thread.remove-link`
- `thread.add-dependency`
- `thread.remove-dependency`

**Channel commands:**
- `channel.create`
- `channel.post-message`
- `channel.read-messages`
- `channel.conclude`
- `channel.mark-concluded`
- `channel.close`

**Interactive request commands:**
- `request.open`
- `request.resolve` (with decision: approve/reject, or answers, or action: retry/skip)
- `request.mark-stale`

**Design commands:**
- `thread.design.artifact-rendered`
- `thread.design.options-presented`
- `thread.design.option-chosen`

### 5.4 Orchestration Reactors (`OrchestrationReactor.ts`)

Start order matters. Each reactor subscribes to orchestration events and produces side effects or new commands:

1. **ProviderRuntimeIngestion** -- Bridges provider session runtime events into orchestration domain events. Maps Codex/Claude runtime events to turn lifecycle, tool usage, checkpoints, rate limits.
2. **DiscussionReactor** -- Intercepts turn-start-requested events for discussion container threads. Must start before ProviderCommandReactor.
3. **DesignModeReactor** -- Handles design artifact rendering and option events.
4. **ProviderCommandReactor** -- Translates orchestration commands into provider service calls (start session, send turn, interrupt, stop). Handles branch creation, worktree setup. Interacts with RoutingTextGeneration for commit message generation.
5. **CheckpointReactor** -- Creates git checkpoints (stash-based) after turns complete. Manages checkpoint diffs.
6. **BootstrapReactor** -- Runs project bootstrap scripts before first turn.
7. **WorkflowReactor** -- Drives workflow phase progression: evaluates gates, starts phases, handles quality checks.
8. **ChannelReactor** -- Manages deliberation channel lifecycle, message routing, conclusion detection.

### 5.5 Startup Reconciliation (`StartupReconciliation.ts`)

On server restart, detects and repairs stale state:
- Stale sessions (still marked running/starting) -- dispatches stop/error commands
- Stale turns (still in-progress) -- marks as failed
- Stale phase runs (active but owning thread is dead) -- marks as failed
- Open channels (orphaned) -- closes them
- Stale pending approvals -- resolves them
- Stale interactive requests -- marks as stale

### 5.6 Projection Pipeline (`ProjectionPipeline.ts`)

Subscribes to the event store and projects events into the SQL projection tables in near-real-time.

### 5.7 Projection Snapshot Query (`ProjectionSnapshotQuery.ts`)

Builds the full `OrchestrationReadModel` from projection tables. Used by the WS API and daemon socket API. Includes:
- All projects (active, with scripts and default model)
- All threads (with messages, turns, sessions, activities, channel info, workflow state)
- All pending requests
- All channels
- Phase runs
- Snapshot sequence number

---

## 6. Provider Architecture

### 6.1 Provider Registry (`ProviderRegistry.ts`)

Detects available providers by checking for:
- Codex CLI binary existence
- Claude API key / OAuth credential availability

Exposes `getProviders` and `streamChanges` for live provider status updates.

### 6.2 Provider Service (`ProviderService.ts`)

Cross-provider orchestration layer. Routes calls to provider adapters through `ProviderAdapterRegistry` and `ProviderSessionDirectory`.

**Operations:**
- `startSession(input)` -- validates input, resolves adapter, starts session, persists runtime binding
- `sendTurn(input)` -- validates, routes to adapter
- `interruptTurn(input)` -- interrupt current turn
- `respondToInteractiveRequest(input)` -- approval, user-input, permission, mcp-elicitation
- `rollbackConversation(input)` -- roll back N turns
- `stopSession(input)` -- stop a session
- `listSessions()` -- list active sessions
- `streamEvents` -- unified provider event stream

Logs canonical events to NDJSON file. Tracks analytics for sessions and turns.

### 6.3 Provider Session Directory (`ProviderSessionDirectory.ts`)

Maps `threadId -> ProviderRuntimeBinding`. Persisted in `provider_session_runtime` table. Tracks:
- Provider name and adapter key
- Runtime mode (`full-access`, etc.)
- Status (starting, running, stopped, error)
- Resume cursor (for session recovery)
- Runtime payload (model, cwd, last error, active turn)

### 6.4 Provider Adapter Registry (`ProviderAdapterRegistry.ts`)

Holds references to Codex and Claude adapters. Routes by adapter key.

### 6.5 Codex Adapter (`CodexAdapter.ts`)

Wraps `CodexAppServerManager` behind the adapter contract:
- Starts Codex CLI as child process with app-server protocol
- Configures binary path, home path, model, service tier (fast mode), runtime mode
- Injects MCP server config for discussion channels via `configOverrides.mcp_servers`
- Maps native Codex events to `ProviderRuntimeEvent` via `mapToRuntimeEvents.ts`
- Supports `startSession`, `sendTurn`, `interruptTurn`, `stopSession`, `listSessions`, `hasSession`, `stopAll`

### 6.6 Claude Adapter (`ClaudeAdapter.ts`)

Uses `@anthropic-ai/claude-agent-sdk` `query()` function:
- OAuth token resolution via `claudeOAuthCredential.ts`
- Session lifecycle: `startSession`, `sendTurn`, `interruptTurn`, `readThread`, `rollbackThread`, `forkThread`, `respondToRequest`, `stopSession`, `listSessions`, `hasSession`, `stopAll`
- Registers MCP servers for discussion channels via `registerPendingMcpServer`
- Capabilities: `sessionModelSwitch: "in-session"` (can switch models within a session)
- Default model: `claude-opus-4-6`

### 6.7 MCP Channel Integration

- `McpChannelServer.ts` -- MCP server that bridges discussion channels to provider sessions
- `CodexChannelInjection.ts` -- Injects channel MCP server config into Codex adapter before child sessions start
- Codex: injected as `mcp_servers` config override
- Claude: registered via `registerPendingMcpServer`

### 6.8 Rate Limit Normalization (`rateLimitNormalizer.ts`)

Normalizes rate limit data from both Codex and Claude providers into a unified `RateLimitsSnapshot` format for client consumption.

---

## 7. Persistence Layer

### 7.1 SQLite Setup (`Layers/Sqlite.ts`)

Uses Effect SQL client with `node:sqlite` (or Bun SQLite). Database path from config (`forge.db`). Runs migrations on startup via `Migrations.ts`.

### 7.2 Migrations (001-034)

34 migrations total. Core tables and their evolution:

#### `orchestration_events` (001)
| Column | Type | Description |
|--------|------|-------------|
| `sequence` | INTEGER PK AUTOINCREMENT | Global ordering |
| `event_id` | TEXT UNIQUE | Domain event ID |
| `aggregate_kind` | TEXT | project / thread / channel / request |
| `stream_id` | TEXT | Aggregate instance ID |
| `stream_version` | INTEGER | Per-stream version |
| `event_type` | TEXT | Domain event type |
| `occurred_at` | TEXT | ISO timestamp |
| `command_id` | TEXT | Originating command |
| `causation_event_id` | TEXT | Event that caused this event |
| `correlation_id` | TEXT | Correlation chain |
| `actor_kind` | TEXT | Actor type |
| `payload_json` | TEXT | Event payload |
| `metadata_json` | TEXT | Event metadata |

Indexes: stream_version (unique), stream_sequence, command_id, correlation_id.

#### `orchestration_command_receipts` (002)
| Column | Type |
|--------|------|
| `command_id` | TEXT PK |
| `aggregate_kind` | TEXT |
| `aggregate_id` | TEXT |
| `accepted_at` | TEXT |
| `result_sequence` | INTEGER |
| `status` | TEXT |
| `error` | TEXT |

#### `checkpoint_diff_blobs` (003)
| Column | Type |
|--------|------|
| `thread_id` | TEXT |
| `from_turn_count` | INTEGER |
| `to_turn_count` | INTEGER |
| `diff` | TEXT |
| `created_at` | TEXT |

PK: (thread_id, from_turn_count, to_turn_count)

#### `provider_session_runtime` (004, 006, 009)
| Column | Type |
|--------|------|
| `thread_id` | TEXT PK |
| `provider_name` | TEXT |
| `adapter_key` | TEXT |
| `runtime_mode` | TEXT (default 'full-access') |
| `status` | TEXT |
| `last_seen_at` | TEXT |
| `resume_cursor_json` | TEXT |
| `runtime_payload_json` | TEXT |

#### `projection_projects` (005)
| Column | Type |
|--------|------|
| `project_id` | TEXT PK |
| `title` | TEXT |
| `workspace_root` | TEXT |
| `default_model` | TEXT |
| `scripts_json` | TEXT |
| `created_at` | TEXT |
| `updated_at` | TEXT |
| `deleted_at` | TEXT |

#### `projection_threads` (005, 006-034 cumulative)
| Column | Type | Migration |
|--------|------|-----------|
| `thread_id` | TEXT PK | 005 |
| `project_id` | TEXT | 005 |
| `title` | TEXT | 005 |
| `model` -> `model_selection_json` | TEXT | 005, 016 |
| `branch` | TEXT | 005 |
| `worktree_path` | TEXT | 005 |
| `latest_turn_id` | TEXT | 005 |
| `created_at` | TEXT | 005 |
| `updated_at` | TEXT | 005 |
| `deleted_at` | TEXT | 005 |
| `runtime_mode` | TEXT | 010, 011 |
| `interaction_mode` | TEXT | 012 |
| `parent_thread_id` | TEXT | 022 |
| `phase_run_id` | TEXT | 022 |
| `workflow_id` | TEXT | 022 |
| `workflow_snapshot_json` | TEXT | 022 |
| `current_phase_id` | TEXT | 022 |
| `discussion_id` | TEXT | 022 (originally pattern_id, renamed 028) |
| `role` | TEXT | 022 |
| `deliberation_state_json` | TEXT | 022 |
| `bootstrap_status` | TEXT | 022 |
| `completed_at` | TEXT | 022 |
| `transcript_archived` | INTEGER | 022 |
| `archived_at` | TEXT | 017 |
| `spawn_branch` | TEXT | 029 |
| `spawn_worktree_path` | TEXT | 029 |
| `forked_from_thread_id` | TEXT | 033 |
| `pinned_at` | TEXT | 034 |

#### `projection_thread_messages` (005, 007, 027)
| Column | Type |
|--------|------|
| `message_id` | TEXT PK |
| `thread_id` | TEXT |
| `turn_id` | TEXT |
| `role` | TEXT |
| `text` | TEXT |
| `is_streaming` | INTEGER |
| `attachments` | TEXT (added 007) |
| `attribution_json` | TEXT (added 027) |
| `created_at` | TEXT |
| `updated_at` | TEXT |

#### `projection_thread_activities` (005, 008)
| Column | Type |
|--------|------|
| `activity_id` | TEXT PK |
| `thread_id` | TEXT |
| `turn_id` | TEXT |
| `tone` | TEXT |
| `kind` | TEXT |
| `summary` | TEXT |
| `payload_json` | TEXT |
| `sequence` | INTEGER (added 008) |
| `created_at` | TEXT |

#### `projection_thread_sessions` (005, 006)
| Column | Type |
|--------|------|
| `thread_id` | TEXT PK |
| `status` | TEXT |
| `provider_name` | TEXT |
| `provider_session_id` | TEXT |
| `provider_thread_id` | TEXT |
| `active_turn_id` | TEXT |
| `last_error` | TEXT |
| `runtime_mode` | TEXT (added 006) |
| `error_count` | INTEGER (added 006) |
| `updated_at` | TEXT |

#### `projection_turns` (005, 015)
| Column | Type |
|--------|------|
| `row_id` | INTEGER PK AUTOINCREMENT |
| `thread_id` | TEXT |
| `turn_id` | TEXT |
| `pending_message_id` | TEXT |
| `assistant_message_id` | TEXT |
| `state` | TEXT |
| `requested_at` | TEXT |
| `started_at` | TEXT |
| `completed_at` | TEXT |
| `checkpoint_turn_count` | INTEGER |
| `checkpoint_ref` | TEXT |
| `checkpoint_status` | TEXT |
| `checkpoint_files_json` | TEXT |
| `source_proposed_plan_id` | TEXT (added 015) |

#### `projection_pending_approvals` (005)
| Column | Type |
|--------|------|
| `request_id` | TEXT PK |
| `thread_id` | TEXT |
| `turn_id` | TEXT |
| `status` | TEXT |
| `decision` | TEXT |
| `created_at` | TEXT |
| `resolved_at` | TEXT |

#### `projection_state` (005)
| Column | Type |
|--------|------|
| `projector` | TEXT PK |
| `last_applied_sequence` | INTEGER |
| `updated_at` | TEXT |

#### `projection_thread_proposed_plans` (013, 014)
| Column | Type |
|--------|------|
| `plan_id` | TEXT PK |
| `thread_id` | TEXT |
| `summary` | TEXT |
| `implementation` | TEXT (added 014) |
| `created_at` | TEXT |

#### `workflows` (020, 025, 026)
| Column | Type |
|--------|------|
| `workflow_id` | TEXT PK |
| `name` | TEXT |
| `description` | TEXT |
| `phases_json` | TEXT |
| `built_in` | INTEGER |
| `on_completion_json` | TEXT (added 025) |
| `project_id` | TEXT (added 026) |
| `created_at` | TEXT |
| `updated_at` | TEXT |

#### `phase_runs` (020)
| Column | Type |
|--------|------|
| `phase_run_id` | TEXT PK |
| `thread_id` | TEXT |
| `workflow_id` | TEXT |
| `phase_id` | TEXT |
| `phase_name` | TEXT |
| `phase_type` | TEXT |
| `sandbox_mode` | TEXT |
| `iteration` | INTEGER |
| `status` | TEXT |
| `gate_result_json` | TEXT |
| `quality_checks_json` | TEXT |
| `deliberation_state_json` | TEXT |
| `started_at` | TEXT |
| `completed_at` | TEXT |

#### `channels` (021)
| Column | Type |
|--------|------|
| `channel_id` | TEXT PK |
| `thread_id` | TEXT |
| `phase_run_id` | TEXT |
| `type` | TEXT |
| `status` | TEXT |
| `created_at` | TEXT |
| `updated_at` | TEXT |

#### `channel_messages` (021)
| Column | Type |
|--------|------|
| `message_id` | TEXT PK |
| `channel_id` | TEXT |
| `sequence` | INTEGER |
| `from_type` | TEXT |
| `from_id` | TEXT |
| `from_role` | TEXT |
| `content` | TEXT |
| `metadata_json` | TEXT |
| `created_at` | TEXT |
| `deleted_at` | TEXT |

#### `channel_reads` (021)
| Column | Type |
|--------|------|
| `channel_id` | TEXT PK (composite) |
| `thread_id` | TEXT PK (composite) |
| `last_read_sequence` | INTEGER |
| `updated_at` | TEXT |

#### `tool_call_results` (021)
| Column | Type |
|--------|------|
| `provider` | TEXT PK (composite) |
| `thread_id` | TEXT PK (composite) |
| `call_id` | TEXT PK (composite) |
| `tool_name` | TEXT |
| `result_json` | TEXT |
| `created_at` | TEXT |

#### `interactive_requests` (024)
| Column | Type |
|--------|------|
| `request_id` | TEXT PK |
| `thread_id` | TEXT |
| `child_thread_id` | TEXT |
| `phase_run_id` | TEXT |
| `type` | TEXT |
| `status` | TEXT |
| `payload_json` | TEXT |
| `resolved_with_json` | TEXT |
| `created_at` | TEXT |
| `resolved_at` | TEXT |
| `stale_reason` | TEXT |

#### `phase_outputs` (023)
| Column | Type |
|--------|------|
| `phase_run_id` | TEXT PK (composite) |
| `output_key` | TEXT PK (composite) |
| `content` | TEXT |
| `source_type` | TEXT |
| `source_id` | TEXT |
| `metadata_json` | TEXT |
| `created_at` | TEXT |
| `updated_at` | TEXT |

#### `session_synthesis` (023)
| Column | Type |
|--------|------|
| `session_id` | TEXT PK |
| `content` | TEXT |
| `generated_by_session_id` | TEXT |
| `created_at` | TEXT |
| `updated_at` | TEXT |

#### `session_dependencies` (023)
| Column | Type |
|--------|------|
| `session_id` | TEXT PK (composite) |
| `depends_on_session_id` | TEXT PK (composite) |
| `created_at` | TEXT |

#### `session_links` (023)
| Column | Type |
|--------|------|
| `link_id` | TEXT PK |
| `session_id` | TEXT |
| `linked_session_id` | TEXT |
| `link_type` | TEXT |
| `external_id` | TEXT |
| `external_url` | TEXT |
| `external_status` | TEXT |
| `metadata_json` | TEXT |
| `created_at` | TEXT |
| `updated_at` | TEXT |

#### `phase_run_provenance` (023)
| Column | Type |
|--------|------|
| `phase_run_id` | TEXT PK |
| `prompt_template_id` | TEXT |
| `prompt_template_source` | TEXT |
| `prompt_template_hash` | TEXT |
| `prompt_context_hash` | TEXT |
| `model_used` | TEXT |
| `knowledge_snapshot_ids` | TEXT |
| `created_at` | TEXT |

#### `phase_run_outcomes` (023)
| Column | Type |
|--------|------|
| `phase_run_id` | TEXT PK |
| `outcome_json` | TEXT |
| `created_at` | TEXT |

#### `project_knowledge` (023)
| Column | Type |
|--------|------|
| `knowledge_id` | TEXT PK |
| `project_id` | TEXT |
| `kind` | TEXT |
| `content` | TEXT |
| `source_type` | TEXT |
| `source_session_id` | TEXT |
| `confidence` | TEXT (default 'suggested') |
| `created_at` | TEXT |
| `updated_at` | TEXT |

#### `attention_signals` (023)
| Column | Type |
|--------|------|
| `signal_id` | TEXT PK |
| `project_id` | TEXT |
| `session_id` | TEXT |
| `kind` | TEXT |
| `severity` | TEXT (default 'info') |
| `status` | TEXT (default 'active') |
| `title` | TEXT |
| `summary` | TEXT |
| `source_type` | TEXT |
| `source_id` | TEXT |
| `snoozed_until` | TEXT |
| `resolved_at` | TEXT |
| `created_at` | TEXT |
| `updated_at` | TEXT |

#### `projection_agent_diffs` (031, 032)
| Column | Type |
|--------|------|
| `thread_id` | TEXT PK (composite) |
| `turn_id` | TEXT PK (composite) |
| `diff` | TEXT |
| `files_json` | TEXT |
| `source` | TEXT |
| `coverage` | TEXT |
| `assistant_message_id` | TEXT (added 032) |
| `completed_at` | TEXT |

### 7.3 Event Store (`OrchestrationEventStore.ts`)

Appends events to `orchestration_events` table. Reads from a sequence number. Enforces stream version uniqueness for optimistic concurrency.

### 7.4 Command Receipts (`OrchestrationCommandReceipts.ts`)

Stores command processing results for idempotency. If a command is replayed with the same ID, the stored receipt is returned.

### 7.5 Projection Repositories

One repository per projection table, each providing typed CRUD operations:
- `ProjectionProjectRepository` -- projects
- `ProjectionThreadRepository` -- threads
- `ProjectionThreadMessageRepository` -- messages
- `ProjectionThreadSessionRepository` -- thread-session runtime state
- `ProjectionTurnRepository` -- turns
- `ProjectionWorkflowRepository` -- workflows
- `ProjectionPhaseRunRepository` -- phase runs
- `ProjectionPhaseOutputRepository` -- phase outputs
- `ProjectionChannelRepository` -- channels
- `ProjectionChannelMessageRepository` -- channel messages
- `ProjectionChannelReadRepository` -- channel read cursors
- `ProjectionInteractiveRequestRepository` -- interactive requests
- `ProjectionAgentDiffRepository` -- agent-reported diffs
- `ProviderSessionRuntimeRepository` -- provider session runtime bindings
- `ProjectionPendingApprovalRepository` -- legacy pending approvals
- `ProjectionStateRepository` -- projector watermarks
- `ProjectionThreadActivityRepository` -- thread activities
- `ProjectionThreadProposedPlanRepository` -- proposed plans
- `ProjectionCheckpointRepository` -- checkpoint metadata

---

## 8. Daemon Mode

### 8.1 Daemon Service (`DaemonService.ts`)

Singleton process lifecycle management:
- File-based lock (`forge.lock`) using a child process helper that holds stdin open
- PID file (`forge.pid`)
- Daemon info manifest (`daemon.json`) -- contains `socketPath`, `wsPort`, `wsToken`, `startedAt`, `pid`, `daemonProtocolVersion`, `daemonVersion`
- Unix domain socket (`forge.sock`) with `0o600` permissions
- Trusted manifest validation (ownership, permissions, socket stat checks)

**Operations:**
- `start(input)` -- acquires lock, checks for existing daemon, writes PID/manifest, binds socket
- `stop()` -- graceful shutdown with configurable timeout (default 30s)
- `getDaemonPaths()`

### 8.2 Socket Transport (`SocketTransport.ts`)

JSON-RPC 2.0 over Unix domain socket. Line-delimited JSON. Max request size: 1MB.

**Protocol versioning**: `DAEMON_SOCKET_PROTOCOL_VERSION` enforced on every request except `daemon.ping`. Clients must send `forgeProtocolVersion` field.

**Daemon Socket RPC Methods:**

| Method | Description |
|--------|-------------|
| `daemon.ping` | Health check, returns status/pid/uptime |
| `daemon.stop` | Request graceful daemon shutdown |
| `session.list` | List all top-level sessions with status |
| `session.get` | Get detailed session summary |
| `session.create` | Create session (resolves project, optionally creates project, resolves workflow) |
| `session.correct` | Send correction (or user turn for standalone agents) |
| `session.pause` | Pause a running session |
| `session.resume` | Resume a paused session |
| `session.cancel` | Cancel a session |
| `session.sendTurn` | Send a user turn with optional attachments |
| `session.getTranscript` | Get paginated transcript |
| `session.getChildren` | Get child session summaries |
| `thread.create` | Create thread with full params (projectId/workspaceRoot/parentThreadId, model, workflow, discussion, role, etc.) |
| `thread.correct` | Queue thread correction |
| `thread.pause` | Pause thread |
| `thread.resume` | Resume thread |
| `thread.cancel` | Cancel thread |
| `thread.archive` | Archive thread |
| `thread.unarchive` | Unarchive thread |
| `thread.sendTurn` | Send turn to thread |
| `thread.getTranscript` | Get thread transcript |
| `thread.getChildren` | Get thread children |
| `gate.approve` | Approve pending gate |
| `gate.reject` | Reject pending gate (with optional reason/correction) |
| `bootstrap.retry` | Retry failed bootstrap |
| `bootstrap.skip` | Skip failed bootstrap |
| `events.subscribe` | Long-poll for orchestration events (with cursor, timeout, limit) |
| `request.resolve` | Resolve interactive request with arbitrary resolution |
| `channel.getMessages` | Get channel messages |
| `channel.getChannel` | Get channel details |
| `channel.intervene` | Post human intervention message to channel |
| `phaseOutput.update` | Edit a phase output |
| `workflow.list` | List workflows |
| `workflow.get` | Get workflow details |
| `discussion.list` | List discussions |
| `discussion.get` | Get discussion |
| `discussion.listManaged` | List managed discussions |
| `discussion.getManaged` | Get managed discussion |
| `discussion.create` | Create discussion |
| `discussion.update` | Update discussion |
| `discussion.delete` | Delete discussion |

### 8.3 Daemon Runtime (`Runtime.ts`)

Wraps the HTTP server launch in daemon lifecycle:
1. Starts daemon service (lock + PID + manifest + socket)
2. Starts notification reactor
3. Forks HTTP server
4. Races shutdown signal vs. server exit
5. On shutdown: stops all active provider sessions, drains notification reactor

### 8.4 Notification System

**NotificationReactor** (`NotificationReactor.ts`):
Subscribes to orchestration events and fires OS-native notifications for:
- `request.opened` -- "Needs attention" notification (approval, user-input, permission, mcp-elicitation, gate, bootstrap-failed, correction-needed, design-option)
- `thread.completed` -- "Session completed" notification
- `channel.concluded` -- "Deliberation concluded" notification

Only fires for top-level threads (no child/sub-agent notifications).

**NotificationDispatch** (`NotificationDispatch.ts`):
Dispatches to platform-native notification backends:
- macOS: `terminal-notifier` (preferred), `osascript` (fallback)
- Linux: `notify-send`
- Deep-links via `forge://session/<sessionId>`

Notification preferences per trigger type from settings:
- `sessionNeedsAttention`
- `sessionCompleted`
- `deliberationConcluded`

---

## 9. Terminal Service

### 9.1 Terminal Manager (`terminal/Layers/Manager.ts`)

Full PTY terminal management per thread:
- **Shell resolution**: Platform-aware (SHELL env on Unix, ComSpec on Windows)
- **Session state**: thread ID, terminal ID, cwd, status, PID, history buffer, exit code/signal, cols/rows, subprocess detection
- **PTY adapters**: `BunPTY` (Bun runtime) or `NodePTY` (Node.js with node-pty)

**Operations:**
- `open(input)` -- start PTY process, subscribe to data/exit events, restore history
- `write(input)` -- write to terminal stdin
- `resize(input)` -- resize PTY dimensions
- `clear(input)` -- clear terminal history
- `restart(input)` -- kill current process, restart PTY
- `close(input)` -- close terminal, cleanup process, persist history
- `subscribe(callback)` -- subscribe to terminal events

**History persistence**: Debounced writes to `{terminalLogsDir}/{threadId}/{terminalId}.log`. Configurable line limit (default 5000 lines).

**Subprocess detection**: Checks for running child processes of the terminal PID. Uses `pgrep` on Unix, `powershell` on Windows.

**Terminal events** (`TerminalEvent`):
- Terminal output data
- Terminal exit (code + signal)
- Terminal status changes

**Defaults**: 120 cols x 30 rows. Environment variable blocklist (PORT, ELECTRON_RENDERER_PORT, ELECTRON_RUN_AS_NODE).

**Metrics**: `forge_terminal_sessions_total`, `forge_terminal_restarts_total`.

---

## 10. Workspace Service

### 10.1 WorkspacePaths (`workspace/Layers/WorkspacePaths.ts`)

- `normalizeWorkspaceRoot(path)` -- resolves `~`, validates directory exists
- `resolveRelativePathWithinRoot(input)` -- safely resolves relative path, prevents path traversal

### 10.2 WorkspaceEntries (`workspace/Services/WorkspaceEntries.ts`)

File entry search within a workspace root.

### 10.3 WorkspaceFileSystem (`workspace/Services/WorkspaceFileSystem.ts`)

Sandboxed file system operations (write file within project root). Validates paths stay within workspace root.

---

## 11. Observability

### 11.1 Tracing (`observability/Layers/Observability.ts`)

Dual-mode tracing:
1. **Local file tracer** (`LocalFileTracer.ts`) -- rotating NDJSON file at `{logsDir}/server.trace.ndjson`. Configurable max bytes (default 10MB), max files (default 10), batch window (default 200ms).
2. **OTLP tracer** -- optional, sends to configured `FORGE_OTLP_TRACES_URL`. Uses Effect OTLP integration.

Trace configuration:
- `traceMinLevel` (default Info)
- `traceTimingEnabled` (default true)
- Service name: configurable (default `forge-server`)
- Service attributes: `service.runtime=forge-server`, `service.mode={web|desktop|daemon}`

### 11.2 Metrics (`observability/Metrics.ts`)

| Metric | Type | Description |
|--------|------|-------------|
| `forge_rpc_requests_total` | Counter | Total WS RPC requests |
| `forge_rpc_request_duration` | Timer | RPC request handling duration |
| `forge_orchestration_commands_total` | Counter | Total orchestration commands |
| `forge_orchestration_command_duration` | Timer | Command dispatch duration |
| `forge_orchestration_command_ack_duration` | Timer | Time from dispatch to first committed event |
| `forge_orchestration_events_processed_total` | Counter | Events processed by reactors |
| `forge_provider_sessions_total` | Counter | Provider session lifecycle operations |
| `forge_provider_turns_total` | Counter | Provider turn lifecycle operations |
| `forge_provider_turn_duration` | Timer | Provider turn request duration |
| `forge_provider_runtime_events_total` | Counter | Canonical provider runtime events |
| `forge_git_commands_total` | Counter | Git commands executed |
| `forge_git_command_duration` | Timer | Git command duration |
| `forge_terminal_sessions_total` | Counter | Terminal sessions started |
| `forge_terminal_restarts_total` | Counter | Terminal restarts |

OTLP metrics export: optional, configured via `FORGE_OTLP_METRICS_URL`.

### 11.3 RPC Instrumentation (`observability/RpcInstrumentation.ts`)

Wraps every RPC method in a span with attributes:
- `rpc.method` -- method name
- `rpc.aggregate` -- aggregate category (orchestration, session, server, git, terminal, workspace, workflow, channel, discussion, request)

Three wrapper variants:
- `observeRpcEffect` -- for request/response methods
- `observeRpcStream` -- for streaming methods
- `observeRpcStreamEffect` -- for streaming methods that need an initial effect

### 11.4 Debug Logging (`debug.ts`)

Conditional debug logging controlled by `FORGE_DEBUG` environment variable. Supports topic-based filtering (e.g., `FORGE_DEBUG=background,ws`). Writes structured JSON records to `{logsDir}/debug.ndjson`.

### 11.5 Server Logger (`serverLogger.ts`)

Structured logging with Effect logger integration.

---

## 12. Session Types and Lifecycle

### 12.1 Session Types (`sessionType.ts`)

Three session types derived from thread metadata:
- `agent` -- standalone or sub-agent (no workflow, no discussion at root level)
- `workflow` -- root thread with a `workflowId`
- `chat` -- root thread with a `discussionId`

`isStandaloneAgentSession` -- true when the thread has no parent, no phase run, no workflow, no discussion, and no role.

### 12.2 Session Status

Derived from thread state + runtime status + pending requests:
- `created` -- thread exists, no session
- `running` -- session starting or running
- `paused` -- session interrupted
- `needs-attention` -- has pending interactive request
- `completed` -- thread completed
- `failed` -- session error or turn error
- `cancelled` -- session stopped

### 12.3 Interactive Request Types

Requests that pause execution and require human input:
- `approval` -- tool call approval
- `user-input` -- questions requiring answers
- `permission` -- additional permission grants
- `mcp-elicitation` -- MCP server requesting input
- `gate` -- workflow human-approval or quality-check gate
- `bootstrap-failed` -- bootstrap script failure requiring retry/skip
- `correction-needed` -- session requesting correction
- `design-option` -- design options ready for review

### 12.4 Workflow Execution

**WorkflowEngine** (`workflow/Services/WorkflowEngine.ts`):
- `startWorkflow(threadId, workflow)` -- initialize workflow for a thread
- `advancePhase(threadId, gateResultOverride?)` -- advance to next phase
- `evaluateGate(threadId, phaseRunId, gate)` -- evaluate a phase gate

**WorkflowRegistry** (`workflow/Services/WorkflowRegistry.ts`):
Stores and queries workflow definitions. Supports built-in and custom workflows.

**PromptResolver** -- resolves prompt templates for workflow phases.

**QualityCheckRunner** -- runs quality check scripts for gate evaluation.

### 12.5 Discussion Execution

**DiscussionRegistry** (`discussion/Services/DiscussionRegistry.ts`):
Manages discussion definitions (participants with roles, scope: global or project). Supports:
- `queryAll`, `queryByName`
- `queryManagedAll`, `queryManagedByName` (managed = includes effective resolution)
- `create`, `update`, `delete`

**DiscussionReactor** (`orchestration/Layers/DiscussionReactor.ts`):
Intercepts turn-start-requested events for discussion container threads.

### 12.6 Channel Management

**ChannelService** (`channel/Services/ChannelService.ts`):
- `createChannel(input)` -- create deliberation channel for a thread
- `postMessage(input)` -- post message to channel
- `getMessages(input)` -- retrieve messages with pagination
- `getUnreadCount`, `getCursor`, `advanceCursor` -- read tracking

**DeliberationEngine** (`channel/Services/DeliberationEngine.ts`):
Multi-agent deliberation protocol:
- `initialize(channelId, maxTurns)` -- set up deliberation state
- `getState(channelId)` -- current deliberation state
- `recordPost(channelId, participantThreadId)` -- record a participant post
- `recordConclusionProposal(channelId, participantThreadId, summary)` -- record conclusion
- `recover(channelId)` -- recover from stale deliberation state

Returns `DeliberationTransition` with: state, participant IDs, next speaker, should-conclude flag, forced conclusion flag, optional nudge, optional reinjection.

---

## 13. Git Operations

### 13.1 GitCore (`git/Layers/GitCore.ts`)

Low-level git command execution with:
- Configurable timeout (default 30s)
- Output size limits (default 1MB, with truncation marker)
- Progress streaming
- stdin support
- Scope-aware caching for upstream status refresh

**Operations:**
- `workingTreeDiff(cwd)` -- working tree diff
- `pullCurrentBranch(cwd)` -- git pull
- `listBranches(input)` -- list local/remote branches (default limit 100)
- `createWorktree(input)` -- create git worktree
- `removeWorktree(input)` -- remove worktree
- `createBranch(input)` -- create branch
- `checkoutBranch(input)` -- checkout branch (scoped)
- `initRepo(input)` -- initialize git repo

### 13.2 GitManager (`git/Services/GitManager.ts`)

High-level stacked workflow orchestration:
- `status(input)` -- Git status + upstream tracking + open PR metadata
- `resolvePullRequest(input)` -- Resolve PR by URL/number
- `preparePullRequestThread(input)` -- Prepare workspace from PR (local or worktree mode)
- `runStackedAction(input, options)` -- Stacked git actions with progress events:
  - `commit` -- stage and commit
  - `push` -- push to remote
  - `create_pr` -- create pull request
  - `commit_push` -- commit then push
  - `commit_push_pr` -- commit, push, then create PR

### 13.3 GitHubCli (`git/Layers/GitHubCli.ts`)

Wraps the `gh` CLI for:
- PR creation
- PR resolution (by URL/number)
- PR metadata queries

### 13.4 RoutingTextGeneration (`git/Layers/RoutingTextGeneration.ts`)

LLM-assisted text generation for git operations (e.g., commit message generation). Routes to available provider based on server settings.

---

## 14. Design Mode

### 14.1 Design Bridge (`design/designBridge.ts`)

HTTP callback bridge between design mode sessions and the server. Token-authenticated. Actions are dispatched via `invokeDesignBridge`.

### 14.2 Design Mode Reactor (`design/DesignModeReactor.ts`)

Orchestration reactor that handles:
- `thread.design.artifact-rendered` -- artifact HTML persistence
- `thread.design.options-presented` -- design option presentation
- `thread.design.option-chosen` -- design option selection

### 14.3 Artifact Storage (`design/artifactStorage.ts`)

Persists HTML design artifacts to `{artifactsDir}/{threadId}/{artifactId}.html`. Supports listing artifacts filtered by kind.

### 14.4 Screenshot Service (`design/screenshotService.ts`)

Headless screenshot capture of HTML artifacts.

### 14.5 Design MCP Server (`design/designMcpServer.ts`)

Stdio MCP server providing design tools to provider sessions. Launched via `forge design-mcp` CLI command.

---

## 15. Shared Chat / Discussion Bridge

### 15.1 Shared Chat Bridge (`discussion/sharedChatBridge.ts`)

HTTP bridge (`/api/internal/shared-chat-bridge`) for shared discussion sessions. Token-based routing.

### 15.2 Shared Chat MCP Server (`discussion/sharedChatMcpServer.ts`)

Stdio MCP server for shared chat discussion tools. Launched via `forge shared-chat-mcp` CLI command.

---

## 16. Attachment Handling

### 16.1 Attachment Store (`attachmentStore.ts`)

Resolves attachment file paths by ID or relative path within `{attachmentsDir}`.

### 16.2 Attachment Paths (`attachmentPaths.ts`)

Path normalization for attachment route prefix (`/attachments/`). Prevents path traversal.

### 16.3 Image MIME (`imageMime.ts`)

Detects image MIME types for attachment serving.

---

## 17. Configuration Services

### 17.1 Server Settings (`apps/server/src/serverSettings.ts`)

Settings service with file watching:
- Settings file at `{stateDir}/settings.json`
- `getSettings`, `getSettingsState` (includes validation issues)
- `updateSettings(patch)` -- applies partial patch
- `streamStateChanges` -- live settings change stream

Settings include provider configuration (Codex binary path, home path; Claude settings), notification preferences, observability settings.

### 17.2 Keybindings (`keybindings.ts`)

Keybinding configuration service:
- Config file at `{stateDir}/keybindings.json`
- `loadConfigState` -- load keybindings with validation issues
- `upsertKeybindingRule(rule)` -- add/update a keybinding
- `streamChanges` -- live keybinding change stream

---

## 18. Telemetry

### 18.1 Analytics Service (`telemetry/Layers/AnalyticsService.ts`)

Anonymous analytics recording:
- Anonymous ID persisted at `{stateDir}/telemetry/anonymous-id`
- `record(event, properties)` -- record analytics event
- Used for startup heartbeat, session lifecycle events

---

## 19. Process Runner (`processRunner.ts`)

Subprocess execution with safeguards:
- Timeout enforcement
- Output capture
- Platform-aware process management

Used by terminal manager, bootstrap reactor, quality check runner, and git operations.

---

## 20. Checkpointing

### 20.1 Checkpoint Store (`checkpointing/Layers/CheckpointStore.ts`)

Git-based checkpointing:
- Creates checkpoint refs (git stash) after turns complete
- Tracks checkpoint turn count and ref

### 20.2 Checkpoint Diff Query (`checkpointing/Layers/CheckpointDiffQuery.ts`)

Computes diffs between checkpoints:
- `getTurnDiff(input)` -- diff for a specific turn
- `getFullThreadDiff(input)` -- cumulative diff across all turns

Caches diffs in `checkpoint_diff_blobs` table.

### 20.3 Agent Diff Query (`orchestration/Layers/AgentDiffQuery.ts`)

Queries agent-reported diffs (as opposed to checkpoint-based diffs):
- `getTurnAgentDiff(input)` -- agent-reported diff for a turn
- `getFullThreadAgentDiff(input)` -- full thread agent-reported diff

---

## 21. Project Favicon (`project/Layers/ProjectFaviconResolver.ts`)

Resolves project favicons from workspace root. Falls back to a generic folder SVG icon.
