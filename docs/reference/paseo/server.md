# Paseo Server/Daemon -- Exhaustive Source Code Exploration

> Generated from direct source reading of `/home/sabossedgh/dev/external/paseo/packages/server/src/`.
> Paths shown in the source tree below are relative to `packages/server/src/` in the Paseo checkout.

---

## 1. Directory Structure

```
src/
  client/                          # Daemon client SDK (transport layer for apps connecting to daemon)
    daemon-client-relay-e2ee-transport.ts
    daemon-client-transport-types.ts
    daemon-client-transport-utils.ts
    daemon-client-transport.ts
    daemon-client-websocket-transport.ts
    daemon-client.ts

  poc-commands/                    # Proof-of-concept command output investigation
    commands-poc.test.ts
    investigate-command-output.ts
    run-poc.ts

  server/                          # Main daemon implementation
    agent/                         # Agent management subsystem
      activity-curator.ts          # Curates agent timeline into human-readable summaries
      agent-management-mcp.ts      # Voice/UI-oriented MCP server for managing agents
      agent-manager.ts             # Core agent lifecycle manager
      agent-metadata-generator.ts  # Generates agent metadata (titles, summaries) via LLM
      agent-projections.ts         # Transforms ManagedAgent -> wire payloads
      agent-response-loop.ts       # Structured agent response generation with fallback
      agent-sdk-types.ts           # Canonical type definitions for the agent abstraction
      agent-storage.ts             # File-backed agent record persistence
      agent-title-limits.ts        # Title length constants
      audio-utils.ts               # Audio utility functions
      dictation-debug.ts           # Debug helpers for dictation
      llm-openai.ts                # OpenAI LLM integration for voice
      mcp-server.ts                # Agent-to-agent MCP server (30 tools)
      mcp-shared.ts                # Shared MCP utilities
      model-resolver.ts            # Model resolution logic
      orchestrator.ts              # DEPRECATED - refactored into session.ts
      orchestrator-instructions.ts # System prompts for orchestrator mode
      pcm16-resampler.ts           # PCM audio resampling
      provider-launch-config.ts    # Provider command/env override configuration
      provider-manifest.ts         # Static provider definitions (claude, codex, copilot, opencode, pi)
      provider-registry.ts         # Dynamic provider registry with override/extension support
      provider-snapshot-manager.ts # Caches and refreshes provider model/mode catalogs
      recordings-debug.ts          # Debug recordings management
      stt-debug.ts                 # Speech-to-text debug
      stt-manager.ts               # Speech-to-text manager for voice sessions
      timeline-append.ts           # Helpers for appending to agent timelines
      timeline-projection.ts       # Timeline windowing and projection
      tool-name-normalization.ts   # Normalizes tool names across providers
      tts-debug.ts                 # Text-to-speech debug
      tts-manager.ts               # Text-to-speech manager for voice sessions
      wait-for-agent-tracker.ts    # Tracks wait-for-agent operations (MCP abort handling)
      providers/                   # Individual provider implementations
        acp-agent.ts               # Base ACP (Agent Client Protocol) client
        claude-agent.ts            # Claude provider (Anthropic SDK)
        codex-app-server-agent.ts  # Codex provider (OpenAI app-server protocol)
        copilot-acp-agent.ts       # GitHub Copilot via ACP
        generic-acp-agent.ts       # Generic ACP provider for custom agents
        opencode-agent.ts          # OpenCode provider (@opencode-ai/sdk)
        pi-acp-agent.ts            # Pi provider via ACP
        diagnostic-utils.ts        # Provider diagnostic formatting
        tool-call-detail-primitives.ts
        tool-call-mapper-utils.ts
        codex-feature-definitions.ts
        codex-rollout-timeline.ts
        test-utils/                # Test helpers
        claude/                    # Claude-specific modules
          claude-models.ts         # Claude model catalog
          partial-json.ts          # Partial JSON parsing for streaming
          sidechain-tracker.ts     # Sub-agent sidechain tracking
          task-notification-tool-call.ts
          tool-call-detail-parser.ts
          tool-call-mapper.ts
        codex/                     # Codex-specific modules
          tool-call-detail-parser.ts
          tool-call-mapper.ts
        opencode/                  # OpenCode-specific modules
          tool-call-detail-parser.ts
          tool-call-mapper.ts

    chat/                          # Inter-agent chat service
      chat-mentions.ts             # @mention parsing and notification
      chat-rpc-schemas.ts          # Chat RPC request/response schemas
      chat-service.ts              # FileBackedChatService implementation
      chat-types.ts                # ChatRoom, ChatMessage types

    schedule/                      # Cron-like scheduling service
      cron.ts                      # Cron expression parser
      rpc-schemas.ts               # Schedule RPC schemas
      service.ts                   # ScheduleService implementation
      store.ts                     # File-backed schedule persistence
      types.ts                     # Schedule types (cadence, target, run records)

    speech/                        # Speech/audio subsystem
      audio.ts                     # Audio utilities
      provider-resolver.ts         # Lazy provider resolution
      speech-config-resolver.ts    # Config resolution for speech providers
      speech-provider.ts           # SpeechToTextProvider / TextToSpeechProvider interfaces
      speech-runtime.ts            # SpeechService lifecycle, readiness monitoring
      speech-types.ts              # RequestedSpeechProviders type
      turn-detection-provider.ts   # VAD turn detection interface
      providers/
        local/                     # Local (on-device) speech
          config.ts
          models.ts                # Model catalog and download specs
          runtime.ts               # Initialize local STT/TTS/VAD
          pocket/
            pocket-tts-onnx.ts     # PocketTTS ONNX provider
          sherpa/                   # Sherpa-ONNX speech engine
            model-catalog.ts
            model-downloader.ts
            sherpa-offline-recognizer.ts
            sherpa-online-recognizer.ts
            sherpa-onnx-loader.ts
            sherpa-onnx-node-loader.ts
            sherpa-parakeet-realtime-session.ts
            sherpa-parakeet-stt.ts
            sherpa-realtime-session.ts
            sherpa-runtime-env.ts
            sherpa-stt.ts
            sherpa-tts.ts
            silero-vad-provider.ts   # Silero VAD (Voice Activity Detection)
            silero-vad-session.ts
            assets/silero_vad.onnx   # Bundled VAD model
        openai/                      # OpenAI speech providers
          config.ts
          realtime-transcription-session.ts
          runtime.ts
          stt.ts                     # OpenAI Whisper STT
          tts.ts                     # OpenAI TTS

    dictation/                     # Streaming dictation
      dictation-stream-manager.ts  # Manages dictation streams with debounce/finalization

    file-download/                 # Token-based file downloads
      token-store.ts               # DownloadTokenStore (time-limited tokens)

    file-explorer/                 # File browser service
      service.ts                   # listDirectoryEntries, readExplorerFile, getDownloadableFileInfo

    push/                          # Push notification service
      push-service.ts              # Expo push notification sender
      token-store.ts               # PushTokenStore (client push token management)

    voice/                         # Voice turn management
      fixed-duration-pcm-ring-buffer.ts
      voice-turn-controller.ts     # Voice turn detection and flow control

    loop/                          # Loop RPC schemas
      rpc-schemas.ts

    utils/
      diff-highlighter.ts          # Diff highlighting utilities

    daemon-e2e/                    # End-to-end daemon tests (50+ test files)
    test-utils/                    # Test utilities

    # Core daemon files
    index.ts                       # Daemon entrypoint (main function)
    bootstrap.ts                   # Composition root (createPaseoDaemon)
    websocket-server.ts            # WebSocket gateway (VoiceAssistantWebSocketServer)
    session.ts                     # Per-client session controller (~5000+ lines)
    messages.ts                    # Re-exports shared messages + server-side serialization
    config.ts                      # loadConfig - resolves daemon configuration
    persisted-config.ts            # Config file read/write (config.json)
    daemon-config-store.ts         # DaemonConfigStore - live mutable config with change events
    pid-lock.ts                    # PID lock management (paseo.pid)
    server-id.ts                   # Persistent server ID
    daemon-keypair.ts              # E2EE keypair management (daemon-keypair.json)
    daemon-version.ts              # Daemon version resolution
    paseo-home.ts                  # Resolve PASEO_HOME directory
    logger.ts                      # Pino logger setup
    connection-offer.ts            # Connection offer for remote access
    relay-transport.ts             # Relay WebSocket transport (E2EE tunneling)
    allowed-hosts.ts               # Vite-style host allowlist / DNS rebinding protection
    persistence-hooks.ts           # Agent-storage persistence event wiring
    loop-service.ts                # LoopService - iterative prompt execution
    workspace-registry.ts          # FileBackedProjectRegistry, FileBackedWorkspaceRegistry
    workspace-registry-bootstrap.ts # Registry initialization from agent storage
    workspace-registry-model.ts    # Workspace/project derivation logic
    workspace-git-service.ts       # WorkspaceGitServiceImpl - live git status watching
    checkout-diff-manager.ts       # CheckoutDiffManager - file-watching diff subscriptions
    checkout-git-utils.ts          # Git utility helpers
    worktree-bootstrap.ts          # Git worktree creation and setup
    worktree-session.ts            # Worktree session helpers
    editor-targets.ts              # IDE/editor launch targets
    pairing-offer.ts               # Pairing QR code generation
    pairing-qr.ts                  # QR code encoding
    voice-config.ts                # Voice mode system prompts
    voice-permission-policy.ts     # Which permissions auto-approve in voice mode
    voice-types.ts                 # VoiceSpeakHandler, VoiceCallerContext
    agent-attention-policy.ts      # Client notification / push decision logic
    client-message-id.ts           # Deduplication of client message IDs
    json-utils.ts                  # JSON sanitization
    path-utils.ts                  # Path expansion and resolution
    package-version.ts             # Package version reading
    types.ts                       # Shared server types
    exports.ts                     # Public API exports

  shared/                          # Shared between server and client
    messages.ts                    # Complete message schema (WSInboundMessage, WSOutboundMessage, session messages)
    agent-lifecycle.ts             # AgentLifecycleStatus enum
    agent-attention-notification.ts # Attention notification payload builders
    connection-offer.ts            # ConnectionOffer schema
    daemon-endpoints.ts            # Relay WebSocket URL builder
    literal-union.ts               # TypeScript utility type
    path-utils.ts                  # Shared path utilities
    terminal-key-input.ts          # Terminal key input mapping
    terminal-stream-protocol.ts    # Binary terminal stream framing protocol
    tool-call-display.ts           # Tool call display formatting

  tasks/                           # Task management subsystem
    cli.ts                         # Task CLI
    execution-order.ts             # Topological sort for task dependencies
    task-store.ts                  # Markdown-file-backed task store
    types.ts                       # Task, TaskStore interfaces

  terminal/                        # Terminal management
    terminal-manager.ts            # TerminalManager factory
    terminal.ts                    # PTY terminal session (node-pty + xterm headless)

  utils/                           # General utilities
    checkout-git.ts                # Git operations (diff, commit, merge, PR, push, pull)
    directory-suggestions.ts       # Directory autocomplete
    executable.ts                  # Executable path resolution
    path.ts                        # Path utilities (expandTilde)
    project-icon.ts                # Project icon resolution
    run-git-command.ts             # Git command runner
    spawn.ts                       # Process spawning utilities
    tool-call-parsers.ts           # Tool call parsing
    worktree.ts                    # Git worktree management
    worktree-metadata.ts           # Worktree metadata
```

---

## 2. Daemon Lifecycle

### Entrypoint (`index.ts`)

1. **Configuration**: `resolvePaseoHome()` -> `loadPersistedConfig()` -> `loadConfig()`. Merges env vars, persisted config (`config.json`), and CLI flags.
2. **PID Lock**: `acquirePidLock(paseoHome)` writes `paseo.pid` with PID, timestamp, hostname, uid, listen address. Checks for stale locks (dead PIDs). Supports `PASEO_SUPERVISED=1` mode where a supervisor process manages the lifecycle.
3. **Bootstrap**: `createPaseoDaemon(config, logger)` constructs all services.
4. **Start**: `daemon.start()` begins HTTP listening, initializes relay transport, speech service.
5. **PID Update**: After binding, updates `paseo.pid` with the resolved listen address.
6. **Signal Handling**: SIGTERM/SIGINT trigger graceful shutdown with 10s force-exit timeout.
7. **Crash Handling**: `uncaughtException` and `unhandledRejection` cause immediate exit.

### Shutdown Sequence

1. Close all active agents (`closeAllAgents`)
2. Flush agent manager state
3. Detach agent storage persistence hooks
4. Flush agent storage to disk
5. Shutdown provider processes
6. Kill all terminals
7. Stop speech service
8. Stop schedule service ticker
9. Stop relay transport
10. Close WebSocket server (cleanup all sessions)
11. Close HTTP server
12. Clean up Unix socket file (if applicable)
13. Release PID lock

### Restart Support

Both shutdown and restart intents can be triggered via WebSocket RPC. In supervised mode (`PASEO_SUPERVISED=1`), lifecycle messages (`paseo:shutdown`, `paseo:restart`) are sent to the parent process via IPC. The parent supervisor can then restart the daemon.

---

## 3. Bootstrap Composition

`createPaseoDaemon()` constructs the full service graph:

| Service | Type | Description |
|---------|------|-------------|
| `DaemonConfigStore` | Mutable config | Live config with change events, persisted to `config.json` |
| `serverId` | String | Persistent server identifier (stored in `PASEO_HOME`) |
| `daemonKeyPair` | E2EE KeyPair | X25519 keypair for relay E2EE (stored in `daemon-keypair.json`) |
| `DownloadTokenStore` | Token store | Time-limited tokens for file downloads (default 60s TTL) |
| `AgentStorage` | Persistence | File-backed agent record storage (`PASEO_HOME/agents/`) |
| `FileBackedProjectRegistry` | Registry | Project records (`PASEO_HOME/projects/projects.json`) |
| `FileBackedWorkspaceRegistry` | Registry | Workspace records (`PASEO_HOME/projects/workspaces.json`) |
| `FileBackedChatService` | Chat | Chat rooms and messages (`PASEO_HOME/chat/rooms.json`) |
| `AgentManager` | Core | Agent lifecycle management, provider client registry |
| `providerRegistry` | Registry | Provider definitions with model/mode fetching |
| `TerminalManager` | Terminal | PTY terminal session management |
| `WorkspaceGitServiceImpl` | Git | Live git status watching with FS watchers and periodic fetch |
| `CheckoutDiffManager` | Git | File-watching diff subscriptions for checkout views |
| `LoopService` | Automation | Iterative prompt loops with verification |
| `ScheduleService` | Automation | Cron-like schedule execution |
| `SpeechService` | Voice | STT/TTS/VAD with local (Sherpa-ONNX) and OpenAI providers |
| Express `app` | HTTP | REST endpoints + static file serving |
| `VoiceAssistantWebSocketServer` | WebSocket | Primary client gateway |
| `RelayTransport` | Networking | E2EE tunneling through relay.paseo.sh |
| `PushTokenStore` + `PushService` | Push | Expo push notification management |

### Wiring Highlights

- `AgentManager` receives all provider clients via `createAllClients()`, which instantiates `ClaudeAgentClient`, `CodexAppServerAgentClient`, `CopilotACPAgentClient`, `OpenCodeAgentClient`, `PiACPAgentClient`.
- Provider overrides from `config.json` can: replace provider commands, inject env vars, define custom providers extending builtins or ACP, configure profile-specific model lists, and enable/disable providers.
- `AgentStorage` persistence is wired via `attachAgentStoragePersistence()` which hooks into `AgentManager` events.
- MCP server is mounted at `/mcp/agents` with Streamable HTTP transport, creating per-session MCP servers with caller agent context.
- Speech service starts after HTTP listening to avoid blocking startup with synchronous model loading.

---

## 4. WebSocket Protocol

### Transport

- Path: `/ws`
- Protocol version: `1`
- Origin validation against configured allowlist + same-origin detection
- Host validation using Vite-style allowlist (DNS rebinding protection)
- Hello handshake: client must send `WSHelloMessage` within 15s with `clientId`, `protocolVersion`, optional `appVersion`
- Session resumption: if a matching `clientId` exists, the socket is attached to the existing session
- Multi-socket per session: a session can have multiple WebSocket connections (e.g., relay + direct)
- External sockets via relay transport can be attached with E2EE metadata

### Close Codes

| Code | Meaning |
|------|---------|
| 4001 | Hello timeout (no hello within 15s) |
| 4002 | Invalid hello |
| 4003 | Incompatible protocol version |

### Session Messages (Complete RPC Surface)

#### Agent CRUD
- `create_agent_request` -> creates agent with provider, cwd, mode, model, features, MCP servers, system prompt
- `resume_agent_request` -> resumes agent from persistence handle
- `refresh_agent_request` -> refreshes agent state
- `fetch_agent_request` / `fetch_agents_request` -> queries agent(s) with filtering, sorting, pagination
- `delete_agent_request` -> permanently deletes agent and storage
- `archive_agent_request` -> soft-deletes agent
- `update_agent_request` -> updates agent title/labels
- `close_items_request` -> bulk close agents/terminals

#### Agent Interaction
- `send_agent_message_request` -> sends user message (text or content blocks including images)
- `wait_for_finish_request` -> waits for agent to reach idle/permission/error state
- `cancel_agent_request` -> interrupts running agent
- `agent_permission_response` -> responds to permission request (allow/deny)
- `clear_agent_attention` -> clears attention state
- `set_agent_mode_request` -> changes session mode
- `set_agent_model_request` -> changes model
- `set_agent_thinking_request` -> changes thinking option
- `set_agent_feature_request` -> toggles feature flags

#### Agent Timeline
- `fetch_agent_timeline_request` -> fetches timeline window with cursor-based pagination (tail/before/after)

#### Voice / Audio
- `set_voice_mode` -> enables/disables voice mode on an agent
- `voice_audio_chunk` -> binary audio data for STT
- `abort_request` -> aborts voice transcription
- `audio_played` -> client confirms audio playback complete
- `dictation_stream_start/chunk/finish/cancel` -> streaming dictation lifecycle

#### Terminal Management
- `list_terminals_request`
- `subscribe_terminals_request` / `unsubscribe_terminals_request`
- `create_terminal_request`
- `subscribe_terminal_request` / `unsubscribe_terminal_request`
- `terminal_input` (input, resize, mouse)
- `kill_terminal_request`
- `capture_terminal_request`

#### Git / Checkout Operations
- `checkout_status_request` -> full git status snapshot
- `validate_branch_request` -> validate branch name
- `branch_suggestions_request` -> autocomplete branch names
- `subscribe_checkout_diff_request` / `unsubscribe_checkout_diff_request`
- `checkout_switch_branch_request`
- `stash_save_request` / `stash_pop_request` / `stash_list_request`
- `checkout_commit_request` -> commit changes
- `checkout_merge_request` -> merge to base branch
- `checkout_merge_from_base_request` -> merge from base into current
- `checkout_pull_request` / `checkout_push_request`
- `checkout_pr_create_request` / `checkout_pr_status_request`
- `paseo_worktree_list_request` / `create_paseo_worktree_request` / `paseo_worktree_archive_request`

#### Workspace Management
- `fetch_workspaces_request` -> paginated workspace query
- `open_project_request` -> open/upsert project and workspace
- `archive_workspace_request`
- `directory_suggestions_request` -> directory autocomplete

#### File Explorer
- `file_explorer_request` -> list directory or read file
- `project_icon_request` -> resolve project icon
- `file_download_token_request` -> generate download token

#### Provider Discovery
- `list_available_providers_request` -> all registered providers
- `list_provider_models_request` -> models for a provider
- `list_provider_modes_request` -> modes for a provider
- `list_provider_features_request` -> features for a provider
- `get_providers_snapshot_request` -> cached provider snapshot
- `refresh_providers_snapshot_request` -> force refresh
- `provider_diagnostic_request` -> diagnostic info (binary path, version, availability)

#### Chat Service
- `chat/create` -> create chat room
- `chat/list` -> list rooms
- `chat/inspect` -> room details
- `chat/delete` -> delete room
- `chat/post` -> post message (with @mentions triggering agent prompts)
- `chat/read` -> read messages with filtering
- `chat/wait` -> long-poll for new messages

#### Schedule Service
- `schedule/create` -> create recurring schedule
- `schedule/list` / `schedule/inspect` / `schedule/logs`
- `schedule/pause` / `schedule/resume` / `schedule/delete`

#### Loop Service
- `loop/run` -> start iterative loop
- `loop/list` / `loop/inspect` / `loop/logs`
- `loop/stop`

#### IDE Integration
- `list_available_editors_request` -> list IDE targets (VS Code, Cursor, etc.)
- `open_in_editor_request` -> open file/directory in editor

#### Daemon Management
- `get_daemon_config_request` / `set_daemon_config_request`
- `restart_server_request` / `shutdown_server_request`
- `list_commands_request` -> list available slash commands for an agent
- `register_push_token` -> register Expo push token
- `client_heartbeat` / `ping` -> keepalive

### Server-Pushed Messages

- `agent_update` -> agent state changes (with subscription filtering)
- `workspace_update` -> workspace state changes
- `agent_stream` -> real-time agent stream events (timeline items, turn events, permissions)
- `agent_status` -> lifecycle status changes
- `agent_permission_request` / `agent_permission_resolved`
- `agent_deleted` / `agent_archived`
- `providers_snapshot_update` -> provider catalog refresh
- `terminals_changed` -> terminal list changes
- `checkout_diff_update` -> git diff changes
- `status` -> server info status payload (including capabilities)
- `pong` -> keepalive response
- `rpc_error` -> request error
- Audio: `audio_output`, `transcription_result`, `voice_input_state`
- Dictation: `dictation_stream_ack`, `dictation_stream_partial`, `dictation_stream_final`, `dictation_stream_finish_accepted`, `dictation_stream_error`
- Terminal: binary frames via `TerminalStreamProtocol` (snapshot, data, resize, exit opcodes)

---

## 5. Provider Architecture

### Abstraction Layer

Every provider implements the `AgentClient` interface:

```typescript
interface AgentClient {
  provider: AgentProvider;                           // string identifier
  capabilities: AgentCapabilityFlags;
  createSession(config, launchContext): Promise<AgentSession>;
  resumeSession(handle, overrides, launchContext): Promise<AgentSession>;
  listModels(options?): Promise<AgentModelDefinition[]>;
  listModes?(options?): Promise<AgentMode[]>;
  listPersistedAgents?(options?): Promise<PersistedAgentDescriptor[]>;
  isAvailable(): Promise<boolean>;
  getDiagnostic?(): Promise<string>;
}
```

And `AgentSession`:

```typescript
interface AgentSession {
  provider: AgentProvider;
  id: string;
  capabilities: AgentCapabilityFlags;
  features?: AgentFeature[];
  run(prompt, options?): Promise<AgentRunResult>;
  startTurn(prompt, options?): Promise<string>;   // non-blocking turn start
  subscribe(callback): () => void;                 // stream events
  streamHistory(): AsyncIterable<AgentStreamEvent>; // replay history
  getRuntimeInfo(): Promise<AgentRuntimeInfo>;
  getAvailableModes(): AgentMode[];
  getCurrentMode(): string | null;
  setMode(modeId): Promise<void>;
  setModel?(modelId): Promise<void>;
  setThinkingOption?(optionId): Promise<void>;
  setFeature?(featureId, value): Promise<void>;
  getPendingPermissions(): AgentPermissionRequest[];
  respondToPermission(requestId, response): Promise<void>;
  describePersistence(): AgentPersistenceHandle | null;
  interrupt(): void;
  close(): Promise<void>;
  listCommands?(): AgentSlashCommand[];
}
```

### Capability Flags

```typescript
type AgentCapabilityFlags = {
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsDynamicModes: boolean;
  supportsMcpServers: boolean;
  supportsReasoningStream: boolean;
  supportsToolInvocations: boolean;
};
```

### Registered Providers

| Provider | ID | Transport | SDK | Capabilities |
|----------|-----|-----------|-----|-------------|
| **Claude** | `claude` | Subprocess (`claude` CLI via `@anthropic-ai/claude-agent-sdk`) | `query()` API | All capabilities |
| **Codex** | `codex` | Subprocess (`codex` CLI, app-server JSON-RPC over stdio) | Custom JSON-RPC | All capabilities |
| **Copilot** | `copilot` | Subprocess via ACP (`@agentclientprotocol/sdk`) | ACP ndJSON stream | All capabilities |
| **OpenCode** | `opencode` | Subprocess (`opencode` server) + TCP client (`@opencode-ai/sdk`) | HTTP/SSE client | All capabilities |
| **Pi** | `pi` | Subprocess via ACP (bundled `pi-acp`) | ACP ndJSON stream | All capabilities |
| **Generic ACP** | custom ID | Subprocess via ACP (user-configured command) | ACP ndJSON stream | Varies |

### Provider Registry

`buildProviderRegistry()` constructs the full registry:

1. **Builtin providers**: instantiated with static definitions from `provider-manifest.ts`
2. **Provider overrides** (from `config.json` `agents.providers`): can modify label, description, command, env, model list, enable/disable
3. **Derived providers**: custom provider IDs that `extends` a builtin or `"acp"`. Require a `label` and `extends` field. ACP extensions require a `command`.
4. **Wrapped clients**: derived providers wrap the base client with provider ID mapping (stream events, persistence handles, models all get remapped)

### Transport Details

**Claude**: Spawns `claude` CLI via `@anthropic-ai/claude-agent-sdk`'s `query()` function. Supports:
- Permission modes: default, acceptEdits, plan, bypassPermissions
- MCP server injection (stdio, HTTP, SSE configs)
- Session persistence via resume tokens
- Sidechain tracking (sub-agent tool calls)
- Model catalog: fetched from `claude --list-models`

**Codex**: Spawns `codex --app-server` with JSON-RPC over stdin/stdout:
- Rollout events parsed from stream
- Thread-based persistence (thread IDs)
- Modes: auto, full-access
- Feature flags: fast mode, plan mode
- Image attachment support via temp directories

**OpenCode**: Manages a singleton `opencode` server process per daemon:
- `OpenCodeServerManager` spawns server, discovers TCP port
- Client connects via `@opencode-ai/sdk` HTTP client
- Dynamic modes fetched from server
- Model list with timeout protection

**ACP (Copilot, Pi, Generic)**: Subprocess spawned per session:
- ndJSON stream protocol (`@agentclientprotocol/sdk`)
- Initialize handshake with capabilities negotiation
- Session modes, config options, permission requests
- Terminal operations (create, kill, output, wait for exit)

### Normalization

Each provider has dedicated tool-call mappers that normalize provider-specific tool calls into canonical `ToolCallDetail` types:
- `shell` (command execution)
- `read` (file reading)
- `edit` (file editing with diffs)
- `write` (file writing)
- `search` (grep, glob, web search)
- `fetch` (URL fetching)
- `worktree_setup`
- `sub_agent`
- `plan` / `plain_text` / `unknown`

---

## 6. Agent Manager

### Lifecycle State Machine

```
                  +--> running --+--> idle
                  |     ^   |    |
initializing ---> idle  |   +--> error
                  |     |        |
                  +-----+--------+--> closed
```

States:
- **initializing**: session created, not yet ready
- **idle**: session active, awaiting user input
- **running**: actively processing a turn (foreground or autonomous)
- **error**: session encountered an error
- **closed**: session terminated, no live session object

### ManagedAgent

Key properties per agent:
- `id`, `provider`, `cwd`, `config`, `capabilities`
- `session: AgentSession | null` (null when closed)
- `lifecycle` / `activeForegroundTurnId`
- `availableModes`, `currentModeId`, `features`
- `pendingPermissions`, `bufferedPermissionResolutions`, `inFlightPermissionResponses`
- `timeline` / `timelineRows` / `timelineEpoch` / `timelineNextSeq`
- `persistence: AgentPersistenceHandle | null`
- `lastUsage: AgentUsage`, `lastError`
- `attention: AttentionState` (requiresAttention, reason, timestamp)
- `foregroundTurnWaiters` (for wait-for-finish semantics)
- `labels: Record<string, string>` (user-defined, e.g., `{ surface: "workspace" }`)
- `internal: boolean` (hidden from listings, no notifications)

### Agent Operations

- **createAgent**: registers provider client, creates session, subscribes to stream events, sets initial mode
- **resumeAgent**: restores from `AgentPersistenceHandle` (provider + sessionId + nativeHandle)
- **sendMessage**: starts a foreground turn with prompt input (text or content blocks)
- **cancelAgent**: calls `session.interrupt()`
- **closeAgent**: calls `session.close()`, transitions to `closed`
- **setAgentMode/Model/ThinkingOption/Feature**: delegates to session methods
- **respondToPermission**: forwards allow/deny to session with deduplication
- **waitForAgent**: returns when agent reaches idle/permission/error (with abort signal)
- **waitForAgentStart**: returns when agent transitions from initializing

### Stream Event Processing

The agent manager subscribes to each session and processes events:
- `turn_started` -> lifecycle transitions to `running`
- `turn_completed` -> lifecycle transitions to `idle`, fires attention callback
- `turn_failed` -> lifecycle transitions to `error`
- `turn_canceled` -> lifecycle transitions to `idle`
- `timeline` -> appends items to agent timeline
- `permission_requested` -> adds to pending permissions map
- `permission_resolved` -> removes from pending, buffers for clients
- `thread_started` -> marks history as primed

### Attention System

When an agent finishes, errors, or requests permission, the attention callback fires. The `agent-attention-policy.ts` computes:
- `shouldNotifyClient`: based on client heartbeat recency
- `shouldSendPush`: based on push token availability and attention state

This drives both WebSocket notifications and Expo push notifications.

### Timeline

Each agent maintains a timeline of `AgentTimelineItem` entries:
- `user_message`, `assistant_message`, `reasoning`
- `tool_call` (with typed `ToolCallDetail`)
- `todo` (checklist items)
- `error`, `compaction`

Timeline supports:
- Cursor-based pagination (epoch + seq)
- Windowed fetch (tail, before, after)
- Projection modes for display

---

## 7. Chat Service

### Implementation

`FileBackedChatService` persists to `PASEO_HOME/chat/rooms.json`:

- **Rooms**: id, name, purpose, timestamps
- **Messages**: id, roomId, authorAgentId, body, replyToMessageId, mentionAgentIds, createdAt
- **@mentions**: parsed from message body using `@agentId` pattern; triggers agent prompts via `notifyChatMentions()`
- **Long-polling**: `chat/wait` supports blocking reads with timeout

### RPC Methods

| Method | Description |
|--------|-------------|
| `chat/create` | Create named room with optional purpose |
| `chat/list` | List all rooms (sorted by updatedAt) |
| `chat/inspect` | Room details including message count |
| `chat/delete` | Delete room and all messages |
| `chat/post` | Post message with author, optional replyTo |
| `chat/read` | Read messages with limit, since, author filter |
| `chat/wait` | Long-poll for new messages after a given message ID |

---

## 8. Automation Services

### Loop Service

`LoopService` implements iterative prompt execution with verification:

**Lifecycle**: running -> succeeded | failed | stopped

**Configuration**:
- `prompt`: the task to execute each iteration
- `cwd`, `provider`, `model`: agent configuration
- `workerProvider/workerModel`: separate provider for worker agents
- `verifierProvider/verifierModel`: separate provider for verification
- `verifyPrompt`: LLM-based verification prompt
- `verifyChecks`: shell commands to run as verification
- `sleepMs`: delay between iterations
- `maxIterations`, `maxTimeMs`: limits
- `archive`: whether to archive worker agents after iteration

**Iteration Flow**:
1. Create worker agent with the prompt
2. Wait for worker to complete
3. Run verify checks (shell commands, capture stdout/stderr, check exit code)
4. Run verify prompt (structured LLM response with passed/reason)
5. If verification passes -> succeeded; if fails -> next iteration
6. Archive worker agent if configured

**Persistence**: Stored in `PASEO_HOME/loops.json` with full iteration records and logs.

### Schedule Service

`ScheduleService` implements cron-like recurring agent execution:

**Cadence Types**:
- `every`: fixed interval in milliseconds
- `cron`: standard 5-field cron expression (minute, hour, dayOfMonth, month, dayOfWeek)

**Target Types**:
- `agent`: send prompt to existing agent
- `new-agent`: create new agent with full config (provider, cwd, mode, model, etc.)

**Lifecycle**: active -> paused / completed

**Features**:
- `maxRuns`: auto-complete after N runs
- `expiresAt`: auto-complete at timestamp
- Pause/resume with nextRunAt recalculation
- Run logs with per-run agentId, output, error, timing
- Recovery of interrupted runs on daemon restart

**Persistence**: `ScheduleStore` writes individual schedule files to `PASEO_HOME/schedules/`.

**Tick Loop**: 1-second interval checks for due schedules, executes by creating/prompting agents.

---

## 9. MCP Integration

### Agent MCP Server (`/mcp/agents`)

Mounted as HTTP endpoint using `StreamableHTTPServerTransport`. Each session gets its own MCP server instance with optional `callerAgentId` context.

**30 Registered Tools**:

| Tool | Description |
|------|-------------|
| `speak` | Voice TTS output (agent-scoped only) |
| `create_agent` | Create and optionally run a new agent |
| `wait_for_agent` | Wait for agent completion/permission |
| `send_agent_prompt` | Send message to existing agent |
| `get_agent_status` | Get agent snapshot |
| `list_agents` | List all agents |
| `cancel_agent` | Interrupt running agent |
| `archive_agent` | Soft-delete agent |
| `kill_agent` | Force close agent |
| `update_agent` | Update agent title/labels |
| `list_terminals` | List terminal sessions |
| `create_terminal` | Create new PTY terminal |
| `kill_terminal` | Kill terminal session |
| `capture_terminal` | Capture terminal output lines |
| `send_terminal_keys` | Send keystrokes to terminal |
| `create_schedule` | Create recurring schedule |
| `list_schedules` | List all schedules |
| `inspect_schedule` | Get schedule details |
| `pause_schedule` | Pause schedule |
| `resume_schedule` | Resume schedule |
| `delete_schedule` | Delete schedule |
| `list_providers` | List available providers |
| `list_models` | List models for a provider |
| `list_worktrees` | List Paseo-managed worktrees |
| `create_worktree` | Create git worktree |
| `archive_worktree` | Delete git worktree |
| `get_agent_activity` | Curated timeline summary |
| `set_agent_mode` | Switch agent mode |
| `list_pending_permissions` | All pending permissions across agents |
| `respond_to_permission` | Approve/deny a permission |

### Agent Management MCP (`agent-management-mcp.ts`)

A separate in-process MCP server for UI/voice assistant LLM use, with tools: `create_agent`, `wait_for_agent`, `send_agent_prompt`, `get_agent_status`, `list_agents`, `cancel_agent`, `kill_agent`, `get_agent_activity`, `set_agent_mode`, `list_pending_permissions`, `respond_to_permission`.

### MCP Injection

When `mcp.injectIntoAgents` is enabled (runtime-configurable), agents receive the daemon's MCP server URL as an MCP server configuration. This allows agents to spawn sub-agents, manage terminals, create schedules, etc.

### Cross-Provider Mode Mapping

When a child agent is spawned with a different provider than its parent, modes are mapped:
- Claude `plan` <-> Codex `read-only`
- Claude `default`/`acceptEdits` <-> Codex `auto`
- Claude `bypassPermissions` <-> Codex `full-access`

---

## 10. Terminal Service

### Architecture

`TerminalManager` (factory pattern) manages PTY sessions per `cwd`:

- Uses `node-pty` for platform-native pseudo-terminal spawning
- Uses `@xterm/headless` for server-side terminal emulation (state tracking without rendering)
- Terminals grouped by `cwd`

### Features

- **Create**: spawns shell in specified cwd with optional name and environment variables
- **Input**: text input, resize, mouse events
- **Output**: real-time output data stream
- **State**: full terminal state (buffer, cursor position, cell-level content)
- **Capture**: extract text lines from terminal buffer (with optional strip-ansi)
- **Kill**: terminate PTY process
- **CWD env inheritance**: `registerCwdEnv()` sets default env vars for all terminals under a cwd prefix

### Binary Stream Protocol

Terminal data is transmitted as binary frames (not JSON) for efficiency:
- Opcodes: `snapshot`, `data`, `resize`, `exit`
- Each frame prefixed with opcode + slot number
- Up to 256 concurrent terminal stream slots per session

---

## 11. Git/Workspace Service

### WorkspaceGitServiceImpl

Provides live git status watching per workspace:

**Snapshot Data**:
```typescript
{
  cwd: string;
  git: {
    isGit: boolean;
    repoRoot: string | null;
    mainRepoRoot: string | null;
    currentBranch: string | null;
    remoteUrl: string | null;
    isPaseoOwnedWorktree: boolean;
    isDirty: boolean | null;
    aheadBehind: { ahead, behind } | null;
    diffStat: { additions, deletions } | null;
  };
  github: {
    featuresEnabled: boolean;
    pullRequest: { url, title, state, baseRefName, headRefName, isMerged } | null;
    error | null;
    refreshedAt | null;
  };
}
```

**Mechanisms**:
- FS watchers on `.git` directories for change detection
- Debounced refresh (500ms)
- Background git fetch every 3 minutes per repo
- GitHub PR status via `gh` CLI
- Working tree watches with fallback polling (5s)

### Workspace Registry

**Projects**: identified by root path, kind (git/non_git), display name
**Workspaces**: identified by cwd, linked to project, kind (local_checkout/worktree/directory)
- Bootstrap populates registries from existing agent storage records
- Stale workspace detection and cleanup

### CheckoutDiffManager

Subscribable diff watching:
- Compares current working tree against a base (branch, commit, or HEAD)
- Uses FS watchers with 150ms debounce
- Computes unified diffs on change
- Fingerprint-based deduplication (only emits when diff actually changes)

### Git Operations (via `checkout-git.ts`)

Full git operation suite:
- `getCheckoutStatus` / `getCheckoutDiff`
- `listBranchSuggestions`
- `commitChanges` / `mergeToBase` / `mergeFromBase`
- `pullCurrentBranch` / `pushCurrentBranch`
- `createPullRequest` (via `gh pr create`)

### Worktree Management

- `createAgentWorktree` / `deletePaseoWorktree` / `listPaseoWorktrees`
- Paseo-managed worktrees stored under `.paseo-worktrees/` in the repo root
- Async bootstrap: creates worktree, switches branch, registers workspace

---

## 12. Persistence Model

### File Layout

```
PASEO_HOME/
  config.json              # Persisted daemon configuration
  paseo.pid                # PID lock file
  server-id.txt            # Persistent server identifier
  daemon-keypair.json      # E2EE keypair (mode 0600)
  agents/                  # Agent records (one JSON file per agent)
    <provider>/<agent-id>.json
  projects/
    projects.json           # Project registry
    workspaces.json         # Workspace registry
  chat/
    rooms.json              # Chat rooms and messages
  schedules/
    <schedule-id>.json      # Individual schedule files
  loops.json                # All loop records
  push-tokens.json          # Expo push tokens
  daemon.log                # Log file (with rotation)
```

### Agent Record Schema

```typescript
{
  id: string;                    // UUID
  provider: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  lastUserMessageAt?: string;
  title?: string;
  labels: Record<string, string>;
  lastStatus: AgentLifecycleStatus;
  lastModeId?: string;
  config?: {                     // Serializable subset of session config
    title, modeId, model, thinkingOptionId, featureValues, extra, systemPrompt, mcpServers
  };
  runtimeInfo?: {
    provider, sessionId, model, thinkingOptionId, modeId, extra
  };
  features?: AgentFeature[];
  persistence?: {                // Resume handle
    provider, sessionId, nativeHandle?, metadata?
  };
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission";
  attentionTimestamp?: string;
  internal?: boolean;
  archivedAt?: string;           // Soft-delete timestamp
}
```

### Write Strategy

- Atomic writes: write to temp file, then rename
- Serialized per-agent write queue (pending writes map)
- Delete guard: prevents writes during deletion
- Path migration: records move between provider directories on provider change

---

## 13. Configuration

### Persisted Config (`config.json`)

```typescript
{
  version: 1,
  daemon: {
    listen: "127.0.0.1:6767",
    allowedHosts: true | string[],
    mcp: { enabled: boolean, injectIntoAgents: boolean },
    cors: { allowedOrigins: string[] },
    relay: { enabled: boolean, endpoint: string, publicEndpoint: string },
  },
  app: { baseUrl: string },
  providers: {
    openai: { apiKey?: string },
    local: { modelsDir?: string },
  },
  agents: {
    providers: {
      // Per-provider overrides
      claude: { command?, env?, label?, description?, models?, enabled? },
      codex: { ... },
      // Custom providers
      "my-agent": { extends: "claude", command: [...], label: "My Agent", ... },
      "my-acp": { extends: "acp", command: [...], label: "My ACP", ... },
    },
  },
  features: {
    dictation: { enabled?, stt: { provider?, model?, confidenceThreshold? } },
    voiceMode: {
      enabled?,
      llm: { provider?, model? },
      stt: { provider?, model? },
      turnDetection: { provider? },
      tts: { provider?, model?, voice?, speakerId?, speed? },
    },
  },
  log: {
    level?, format?,
    console: { level?, format? },
    file: { level?, path?, rotate: { maxSize?, maxFiles? } },
  },
}
```

### Mutable Runtime Config

`DaemonConfigStore` manages runtime-configurable settings:
- Currently: `mcp.injectIntoAgents` (boolean)
- Change events propagated to all WebSocket sessions
- Persisted immediately to `config.json`

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `PASEO_LISTEN` | Listen address (host:port, unix socket path) |
| `PASEO_CORS_ORIGINS` | Comma-separated CORS origins |
| `PASEO_ALLOWED_HOSTS` | Host allowlist |
| `PASEO_RELAY_ENABLED` | Enable relay transport |
| `PASEO_RELAY_ENDPOINT` | Relay server address |
| `PASEO_RELAY_PUBLIC_ENDPOINT` | Public relay address |
| `PASEO_APP_BASE_URL` | App base URL |
| `PASEO_VOICE_LLM_PROVIDER` | Voice LLM provider override |
| `PASEO_PRIMARY_LAN_IP` | Override LAN IP detection |
| `PASEO_SUPERVISED` | Supervised mode (IPC with parent) |
| `PASEO_DESKTOP_MANAGED` | Desktop app managed mode |
| `PORT` | Fallback port |
| `MCP_DEBUG` | Enable MCP request logging |

---

## 14. Security

### Host Validation

Vite-style allowlist for DNS rebinding protection:
- Default allowed: `localhost`, `*.localhost`, all IP addresses
- Configurable via `daemon.allowedHosts` in config or `PASEO_ALLOWED_HOSTS` env
- `true` means accept all hosts
- Applied to both HTTP requests and WebSocket upgrades

### Origin Validation

- Configured CORS origins + auto-derived localhost variants
- `paseo://app` always allowed (desktop Electron app)
- WebSocket upgrade validates origin before accepting

### E2EE Relay Transport

- Daemon generates X25519 keypair on first start (stored in `daemon-keypair.json`, mode 0600)
- Relay connections encrypted using `@getpaseo/relay/e2ee` library
- Connection offers encode server ID + public key for client pairing
- Control channel: sync, connected/disconnected signals, keepalive pings
- Data channels: per-connection WebSocket tunnels through relay

### PID Lock

- Prevents multiple daemon instances in the same PASEO_HOME
- Stale lock detection via `process.kill(pid, 0)`
- Exclusive file creation (`wx` flag) to prevent races

### File Permissions

- Keypair file written with `mode: 0600` (owner read/write only)
- No other special file permission handling

---

## 15. Speech/Audio

### Architecture

`SpeechService` orchestrates multiple speech providers:

**Provider Types**:
- **Local** (Sherpa-ONNX): On-device STT (Parakeet), TTS (Sherpa/Pocket), VAD (Silero)
- **OpenAI**: Cloud STT (Whisper), TTS (OpenAI TTS API), Realtime transcription

**Speech Roles**:
- `dictationStt`: Speech-to-text for dictation (text input mode)
- `voiceStt`: Speech-to-text for voice conversations
- `voiceTts`: Text-to-speech for voice responses
- `voiceTurnDetection`: Voice Activity Detection for turn-taking

### Local Speech (Sherpa-ONNX)

- Models downloaded on demand to configurable directory
- Model catalog includes:
  - STT: `parakeet` (offline recognizer), `parakeet-realtime` (streaming)
  - TTS: `sherpa-tts`, `pocket-tts-onnx`
  - VAD: Silero VAD (bundled ONNX model)
- Download progress monitoring with readiness state machine
- PCM16 audio at 16kHz mono

### OpenAI Speech

- Whisper API for transcription
- OpenAI TTS API with voice selection (alloy, echo, fable, onyx, nova, shimmer)
- Realtime transcription sessions

### Voice Session Flow

1. Client sends `set_voice_mode` to enable voice on an agent
2. Voice mode injects system prompt for conversational behavior
3. Audio chunks arrive as binary WebSocket frames
4. `STTManager` handles transcription (local or OpenAI)
5. `VoiceTurnController` manages turn detection (silence detection, interruption)
6. Transcribed text sent as agent message
7. Agent response streamed; `TTSManager` converts to audio
8. Audio output sent back as binary frames
9. Client confirms playback via `audio_played`

### Dictation

Separate from voice mode -- provides real-time transcription for text input:
- `DictationStreamManager` handles streaming audio chunks
- Partial transcriptions emitted during speech
- Final transcription on silence timeout
- Configurable final timeout (`dictationFinalTimeoutMs`)

### Readiness Monitoring

- 3-second polling interval checks provider availability
- States: ready, disabled, model_download_in_progress, models_missing, etc.
- Readiness changes broadcast to all connected clients as `ServerCapabilities`

---

## 16. Task Management (Experimental)

The `tasks/` directory contains a markdown-file-backed task management system:

- Tasks stored as individual markdown files
- Fields: id, title, status (draft/open/in_progress/done/failed), deps, parentId, body, acceptanceCriteria, notes, assignee, priority
- `TaskStore` interface supports: list, get, create, update, delete, dependency management, status transitions
- `execution-order.ts`: topological sort for task dependency resolution
- Appears to be an experimental/POC feature (has CLI in `tasks/cli.ts`)

---

## 17. Client SDK

The `client/` directory provides a TypeScript SDK for connecting to the daemon:

- `DaemonClient`: high-level client with RPC methods
- `DaemonClientTransport`: abstract transport layer
- `DaemonClientWebSocketTransport`: WebSocket transport implementation
- `DaemonClientRelayE2EETransport`: E2EE relay transport
- Type-safe message sending/receiving matching the shared message schema
