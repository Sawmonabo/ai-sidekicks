# Paseo Comprehensive Feature and Architecture Review

Date: 2026-04-15

Project root: `/home/sabossedgh/dev/external/paseo`

Scope: Full monorepo audit across all 8 workspace packages, official documentation, and the skills directory.

Method:

- Direct code inspection of `packages/server`, `packages/app`, `packages/cli`, `packages/desktop`, `packages/relay`, `packages/website`, `packages/highlight`, `packages/expo-two-way-audio`.
- Consolidation and normalization of 10 prior exploration files (`docs/reference/paseo/implementation-details/00` through `09`).
- Reading of `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `SECURITY.md`, `CLAUDE.md`.
- Deep inspection of session controller, agent manager, provider adapters, services, and skills.

Conventions:

- `user`: directly visible end-user product behavior.
- `daemon`: server-side capability consumed by all clients.
- `cli-only`: feature exposed only through the CLI surface.
- `desktop-only`: feature exclusive to the Electron shell.
- `skill`: capability implemented as a Claude Code skill, not in Paseo's core runtime.

---

## 1. Technology Stack

| Layer                     | Technology                          | Version/Notes                                       |
| ------------------------- | ----------------------------------- | --------------------------------------------------- |
| Runtime                   | Node.js                             | Daemon and CLI runtime                              |
| Language                  | TypeScript                          | `^5.9.3`, strict throughout                         |
| Monorepo                  | npm workspaces                      | 8 packages                                          |
| Server framework          | Express                             | HTTP surface, health/status/download endpoints      |
| WebSocket                 | `ws`                                | Binary-multiplexed protocol for all client comms    |
| Mobile/Web client         | Expo (React Native)                 | Cross-platform: iOS, Android, web, Electron webview |
| Desktop shell             | Electron                            | macOS, Linux, Windows; supervises local daemon      |
| CLI framework             | Commander.js                        | Docker-style command surface                        |
| State management (client) | Zustand                             | Per-session normalized stores                       |
| Query layer (client)      | React Query                         | Provider snapshot queries, async data               |
| Validation                | Zod                                 | All schemas, configs, messages                      |
| Persistence               | File-based JSON                     | Atomic temp+rename writes, no database              |
| Formatting                | Biome                               | `^2.4.8`                                            |
| Testing                   | Vitest                              | Unit, integration, E2E tests                        |
| Relay encryption          | ECDH + XSalsa20-Poly1305 (NaCl box) | End-to-end encrypted channel                        |
| MCP SDK                   | `@modelcontextprotocol/sdk`         | Agent MCP server, Streamable HTTP transport         |
| Claude integration        | `@anthropic-ai/claude-agent-sdk`    | SDK wrapping spawned Claude Code process            |
| Codex integration         | JSON-RPC over stdio                 | `codex app-server` child process                    |
| OpenCode integration      | `@opencode-ai/sdk/v2/client`        | SDK against local `opencode serve` process          |
| ACP integration           | `@agentclientprotocol/sdk`          | NDJSON over stdio for Copilot, Pi, custom ACP       |
| Syntax highlighting       | Lezer                               | `packages/highlight`                                |
| Native audio              | Expo modules                        | `packages/expo-two-way-audio`                       |

---

## 2. Architecture Overview

Paseo is a daemon-first system for monitoring and controlling local AI coding agents. The architecture enforces a strict separation: one daemon process owns the entire control plane, and all clients (mobile app, CLI, desktop shell) are projections over daemon state.

### Topology

```
Clients (App/CLI/Desktop)  -->  WebSocket  -->  Daemon (Node.js)  -->  Agent Processes
                                                     |
                                          +---------+---------+
                                          |         |         |
                                       Claude    Codex    OpenCode
                                       (SDK)    (JSON-RPC)  (SDK)
                                                  |
                                          Copilot, Pi (ACP/stdio)
```

### Key architectural decisions

1. **Daemon owns all state.** Agent lifecycle, timelines, permissions, workspaces, chat, loops, schedules, terminals, and speech readiness are daemon-managed. Clients are subscribers, not owners.

2. **Single WebSocket protocol.** All clients speak the same binary-multiplexed protocol. Terminal I/O and agent streaming share the connection via `BinaryMuxFrame` (1-byte channel + 1-byte flags + payload).

3. **Provider normalization.** The daemon never exposes provider-specific behavior to the session layer. Every provider is adapted to `AgentClient`/`AgentSession` interfaces, and `AgentManager` operates exclusively on those abstractions.

4. **File-based persistence.** All durable state is JSON files under `$PASEO_HOME` (~/.paseo). No database. Atomic writes via temp+rename. Forward compatibility via optional fields with defaults.

5. **Multi-host client.** The Expo app treats host selection as first-class. It can manage multiple daemons simultaneously, with per-host session providers, adaptive connection probing, and independent agent directories.

### Data flow for an agent run

1. Client sends `CreateAgentRequestMessage` (prompt, cwd, provider, model, mode).
2. Session routes to `AgentManager.create()`.
3. AgentManager creates `ManagedAgent`, initializes provider session via the normalized `AgentClient`.
4. Provider runs the agent, emitting `AgentStreamEvent` items.
5. Events append to the agent timeline, broadcast to all subscribed clients.
6. Tool calls are normalized to `ToolCallDetail` (shell, read, edit, write, search, fetch, etc.).
7. Permission requests flow: agent -> daemon -> client -> user decision -> daemon -> agent.

Evidence: `packages/server/src/server/bootstrap.ts`, `packages/server/src/server/session.ts`, `packages/server/src/server/agent/agent-manager.ts`, `docs/ARCHITECTURE.md`.

---

## 3. Complete Feature Inventory

### 3.1 Agent Lifecycle

| Feature                                               | Surface | Evidence                                       |
| ----------------------------------------------------- | ------- | ---------------------------------------------- |
| Create agent with provider, model, mode, cwd, prompt  | user    | `session.ts` case `create_agent_request`       |
| Resume agent from persistence handle                  | user    | `session.ts` case `resume_agent_request`       |
| Refresh agent (reload without resending)              | user    | `session.ts` case `refresh_agent_request`      |
| Cancel/interrupt running agent                        | user    | `session.ts` case `cancel_agent_request`       |
| Archive agent (soft-delete)                           | user    | `session.ts` case `archive_agent_request`      |
| Delete agent (hard-delete)                            | user    | `session.ts` case `delete_agent_request`       |
| Send follow-up message to running agent               | user    | `session.ts` case `send_agent_message_request` |
| Wait for agent finish (permission/idle/error/timeout) | user    | `session.ts` case `wait_for_finish_request`    |
| Agent attention tracking (finished/error/permission)  | daemon  | `agent-manager.ts` `emitState()`               |
| Clear agent attention                                 | user    | `session.ts` case `clear_agent_attention`      |
| Update agent title/labels                             | user    | `session.ts` case `update_agent_request`       |
| Close items (bulk agent close)                        | user    | `session.ts` case `close_items_request`        |
| Foreground run replacement (abort + restart)          | daemon  | `agent-manager.ts` `replaceAgentRun()`         |
| Structured output schema for agent responses          | user    | `agent-response-loop.ts`                       |
| Agent metadata generation (auto-title)                | daemon  | `agent-metadata-generator.ts`                  |
| Automatic provisional title from first prompt line    | daemon  | `session.ts` `deriveInitialAgentTitle()`       |
| Up to 200 timeline items per agent in memory          | daemon  | `docs/ARCHITECTURE.md`                         |
| Epoch-based timeline with sequence cursors            | daemon  | `agent-manager.ts` `fetchTimeline()`           |

### 3.2 Agent Directory and Fetch

| Feature                                                             | Surface | Evidence                                          |
| ------------------------------------------------------------------- | ------- | ------------------------------------------------- |
| Fetch agents with label/status filter, pagination, sorting          | user    | `session.ts` `handleFetchAgents()`                |
| Live agent updates subscription                                     | user    | `session.ts` agent updates subscription bootstrap |
| Fetch workspaces with status bucketing, pagination, filtering       | user    | `session.ts` `handleFetchWorkspacesRequest()`     |
| Live workspace updates subscription                                 | user    | `session.ts` workspace update subscription        |
| Timeline fetch with cursor, direction, projected mode               | user    | `session.ts` `handleFetchAgentTimelineRequest()`  |
| Timeline projection (assistant-chunk and tool-lifecycle collapsing) | daemon  | `timeline-projection.ts`                          |
| Activity curation (summary text from timeline items)                | daemon  | `activity-curator.ts`                             |

### 3.3 Provider System

| Feature                                                              | Surface | Evidence                                      |
| -------------------------------------------------------------------- | ------- | --------------------------------------------- |
| Claude provider via Anthropic Agent SDK                              | daemon  | `providers/claude-agent.ts`                   |
| Codex provider via app-server JSON-RPC subprocess                    | daemon  | `providers/codex-app-server-agent.ts`         |
| OpenCode provider via SDK against local opencode serve               | daemon  | `providers/opencode-agent.ts`                 |
| Copilot provider via ACP over stdio                                  | daemon  | `providers/copilot-acp-agent.ts`              |
| Pi provider via ACP over stdio                                       | daemon  | `providers/pi-acp-agent.ts`                   |
| Generic ACP providers via custom command                             | daemon  | `providers/generic-acp-agent.ts`              |
| Provider manifest (labels, descriptions, modes, voice defaults)      | daemon  | `provider-manifest.ts`                        |
| Provider registry with runtime settings, derived providers, wrapping | daemon  | `provider-registry.ts`                        |
| Provider snapshot queries and live updates                           | user    | `session.ts` `get_providers_snapshot_request` |
| Provider diagnostic surface (command, version, model-fetch)          | user    | `session.ts` `provider_diagnostic_request`    |
| List provider models                                                 | user    | `session.ts` `list_provider_models_request`   |
| List provider modes (including dynamic from ACP)                     | user    | `session.ts` `list_provider_modes_request`    |
| List provider features (toggle/select)                               | user    | `session.ts` `list_provider_features_request` |
| Provider launch config overrides (command, env, profiles)            | daemon  | `provider-launch-config.ts`                   |
| Mode mapping across providers (Claude <-> Codex)                     | daemon  | `mcp-server.ts` `mapModeAcrossProviders()`    |
| Custom provider via `extends: "acp"` + command in config             | daemon  | `provider-registry.ts` derived providers      |

### 3.4 Mode and Model Controls

| Feature                                         | Surface | Evidence                                       |
| ----------------------------------------------- | ------- | ---------------------------------------------- |
| Set agent mode at runtime                       | user    | `session.ts` case `set_agent_mode_request`     |
| Set agent model at runtime                      | user    | `session.ts` case `set_agent_model_request`    |
| Set agent thinking/reasoning option at runtime  | user    | `session.ts` case `set_agent_thinking_request` |
| Set agent feature toggle/select at runtime      | user    | `session.ts` case `set_agent_feature_request`  |
| Codex synthetic features (fast_mode, plan_mode) | daemon  | `codex-feature-definitions.ts`                 |
| Pi thinking-option remapping from ACP modes     | daemon  | `pi-acp-agent.ts`                              |

### 3.5 Permissions

| Feature                                               | Surface  | Evidence                                      |
| ----------------------------------------------------- | -------- | --------------------------------------------- |
| Agent permission request forwarding to client         | user     | `agent-manager.ts` permission dispatch        |
| Agent permission response (allow/deny/allow-session)  | user     | `session.ts` case `agent_permission_response` |
| Copilot autopilot auto-approval policy                | daemon   | `acp-agent.ts`                                |
| CLI permit commands (ls/allow/deny)                   | cli-only | `commands/permit/`                            |
| Voice permission policy (auto-allow for voice agents) | daemon   | `voice-permission-policy.ts`                  |

### 3.6 Git and Workspace

| Feature                                                         | Surface | Evidence                                             |
| --------------------------------------------------------------- | ------- | ---------------------------------------------------- |
| Workspace git snapshot (branch, dirty, ahead/behind, diff stat) | daemon  | `workspace-git-service.ts`                           |
| Git status subscription with filesystem watch + debounce        | daemon  | `workspace-git-service.ts`                           |
| Background git fetch (180s interval)                            | daemon  | `workspace-git-service.ts`                           |
| GitHub PR status integration (url, title, state, merged)        | daemon  | `workspace-git-service.ts` `getPullRequestStatus()`  |
| Checkout status request                                         | user    | `session.ts` case `checkout_status_request`          |
| Branch validation                                               | user    | `session.ts` case `validate_branch_request`          |
| Branch suggestions                                              | user    | `session.ts` case `branch_suggestions_request`       |
| Checkout switch branch                                          | user    | `session.ts` case `checkout_switch_branch_request`   |
| Stash save/pop/list                                             | user    | `session.ts` cases `stash_save/pop/list_request`     |
| Commit changes                                                  | user    | `session.ts` case `checkout_commit_request`          |
| Merge to base branch                                            | user    | `session.ts` case `checkout_merge_request`           |
| Merge from base branch                                          | user    | `session.ts` case `checkout_merge_from_base_request` |
| Pull current branch                                             | user    | `session.ts` case `checkout_pull_request`            |
| Push current branch                                             | user    | `session.ts` case `checkout_push_request`            |
| Create pull request                                             | user    | `session.ts` case `checkout_pr_create_request`       |
| PR status check                                                 | user    | `session.ts` case `checkout_pr_status_request`       |
| Checkout diff subscription (live diff updates)                  | user    | `session.ts` case `subscribe_checkout_diff_request`  |
| Project and workspace registries (file-backed)                  | daemon  | `workspace-registry.ts`                              |
| Project kind detection (git/non_git)                            | daemon  | `workspace-registry-model.ts`                        |
| Project icon resolution                                         | user    | `session.ts` case `project_icon_request`             |
| Workspace archiving                                             | user    | `session.ts` case `archive_workspace_request`        |
| Stale workspace detection                                       | daemon  | `workspace-registry-model.ts`                        |

### 3.7 Worktrees

| Feature                                                        | Surface      | Evidence                                           |
| -------------------------------------------------------------- | ------------ | -------------------------------------------------- |
| Create Paseo-managed worktree                                  | user         | `session.ts` case `create_paseo_worktree_request`  |
| List Paseo worktrees                                           | user         | `session.ts` case `paseo_worktree_list_request`    |
| Archive Paseo worktree (close agents, kill terminals, cleanup) | user         | `session.ts` case `paseo_worktree_archive_request` |
| Worktree setup commands (create, checkout, branch)             | daemon       | `worktree-bootstrap.ts`, `worktree-session.ts`     |
| Worktree path computation and slug validation                  | daemon       | `utils/worktree.ts`                                |
| Worktree runtime env resolution                                | daemon       | `utils/worktree.ts`                                |
| CLI worktree flag on `paseo run`                               | cli-only     | `commands/agent/run.ts`                            |
| Worktree detection for dev Electron isolation                  | desktop-only | `packages/desktop/src/main.ts`                     |

### 3.8 Terminals

| Feature                                              | Surface | Evidence                                                    |
| ---------------------------------------------------- | ------- | ----------------------------------------------------------- |
| Daemon-managed terminals (keyed by cwd)              | daemon  | `terminal/terminal-manager.ts`                              |
| Create terminal                                      | user    | `session.ts` case `create_terminal_request`                 |
| Subscribe/unsubscribe to terminal output             | user    | `session.ts` cases `subscribe/unsubscribe_terminal_request` |
| Terminal input forwarding                            | user    | `session.ts` case `terminal_input`                          |
| Kill terminal                                        | user    | `session.ts` case `kill_terminal_request`                   |
| Capture terminal lines (snapshot)                    | user    | `session.ts` case `capture_terminal_request`                |
| List terminals                                       | user    | `session.ts` case `list_terminals_request`                  |
| Terminal list subscription                           | user    | `session.ts` case `subscribe_terminals_request`             |
| Binary-multiplexed terminal streaming over WebSocket | daemon  | `shared/terminal-stream-protocol.ts`                        |
| Inherited environment per root cwd                   | daemon  | `terminal-manager.ts`                                       |
| MCP-exposed terminal operations (create, type, read) | daemon  | `mcp-server.ts`                                             |

### 3.9 Chat (Agent-to-Agent Coordination)

| Feature                                          | Surface | Evidence                              |
| ------------------------------------------------ | ------- | ------------------------------------- |
| Create chat room                                 | user    | `session.ts` case `chat/create`       |
| List chat rooms                                  | user    | `session.ts` case `chat/list`         |
| Inspect chat room                                | user    | `session.ts` case `chat/inspect`      |
| Delete chat room                                 | user    | `session.ts` case `chat/delete`       |
| Post message to room                             | user    | `session.ts` case `chat/post`         |
| Read messages (with limit, since, author filter) | user    | `session.ts` case `chat/read`         |
| Wait for new messages (blocking with timeout)    | user    | `session.ts` case `chat/wait`         |
| @agentId mention parsing and notification        | daemon  | `chat-service.ts`, `chat-mentions.ts` |
| @everyone broadcast to all non-archived agents   | daemon  | `chat-mentions.ts`                    |
| File-backed persistence (rooms.json)             | daemon  | `chat/chat-service.ts`                |

### 3.10 Loops (Worker/Verifier Orchestration)

| Feature                                                   | Surface | Evidence                         |
| --------------------------------------------------------- | ------- | -------------------------------- |
| Run loop (worker prompt + verification)                   | user    | `session.ts` case `loop/run`     |
| List loops                                                | user    | `session.ts` case `loop/list`    |
| Inspect loop (details + iteration history)                | user    | `session.ts` case `loop/inspect` |
| View loop logs                                            | user    | `session.ts` case `loop/logs`    |
| Stop running loop                                         | user    | `session.ts` case `loop/stop`    |
| Worker/verifier agent creation per iteration              | daemon  | `loop-service.ts`                |
| Shell-based verify checks (exit code validation)          | daemon  | `loop-service.ts`                |
| LLM-based verification prompt                             | daemon  | `loop-service.ts`                |
| Configurable sleep between iterations                     | daemon  | `loop-service.ts`                |
| Max iterations and max time limits                        | daemon  | `loop-service.ts`                |
| Per-provider worker and verifier model selection          | daemon  | `loop-service.ts`                |
| Archive option for iteration agents                       | daemon  | `loop-service.ts`                |
| Structured iteration logs (seq, timestamp, source, level) | daemon  | `loop-service.ts`                |
| Recovery of interrupted loops on daemon restart           | daemon  | `loop-service.ts`                |
| File-backed persistence (loops.json)                      | daemon  | `$PASEO_HOME/loops/loops.json`   |

### 3.11 Schedules (Cron/Interval Automation)

| Feature                                           | Surface | Evidence                             |
| ------------------------------------------------- | ------- | ------------------------------------ |
| Create schedule (cron or interval cadence)        | user    | `session.ts` case `schedule/create`  |
| List schedules                                    | user    | `session.ts` case `schedule/list`    |
| Inspect schedule                                  | user    | `session.ts` case `schedule/inspect` |
| View schedule logs                                | user    | `session.ts` case `schedule/logs`    |
| Pause schedule                                    | user    | `session.ts` case `schedule/pause`   |
| Resume schedule                                   | user    | `session.ts` case `schedule/resume`  |
| Delete schedule                                   | user    | `session.ts` case `schedule/delete`  |
| Target existing agent or create new agent per run | daemon  | `schedule/service.ts`                |
| Max runs limit                                    | daemon  | `schedule/service.ts`                |
| Expiration time                                   | daemon  | `schedule/service.ts`                |
| Run history with output/error tracking            | daemon  | `schedule/types.ts`                  |
| Recovery of interrupted runs on restart           | daemon  | `schedule/service.ts`                |
| 1-second tick loop for schedule checking          | daemon  | `schedule/service.ts`                |
| File-backed persistence (per-schedule JSON)       | daemon  | `$PASEO_HOME/schedules/`             |

### 3.12 MCP (Model Context Protocol)

| Feature                                                        | Surface | Evidence                                   |
| -------------------------------------------------------------- | ------- | ------------------------------------------ |
| Agent MCP server (agent-to-agent control)                      | daemon  | `agent/mcp-server.ts`                      |
| Agent management MCP server (voice assistant LLM)              | daemon  | `agent/agent-management-mcp.ts`            |
| MCP tools: create_agent, wait_for_agent, send_agent_prompt     | daemon  | `mcp-server.ts`                            |
| MCP tools: get_agent_status, list_agents, cancel_agent         | daemon  | `mcp-server.ts`                            |
| MCP tools: get_agent_activity, set_agent_mode                  | daemon  | `mcp-server.ts`                            |
| MCP tools: list_pending_permissions, respond_to_permission     | daemon  | `mcp-server.ts`                            |
| MCP tools: terminal operations (create, type, read, list)      | daemon  | `mcp-server.ts`                            |
| MCP tools: schedule management (create, list, inspect, delete) | daemon  | `mcp-server.ts`                            |
| MCP tools: worktree management (create, list, archive)         | daemon  | `mcp-server.ts`                            |
| MCP tools: provider listing and model queries                  | daemon  | `mcp-server.ts`                            |
| Caller agent context inheritance (cwd, mode, model)            | daemon  | `mcp-server.ts` `resolveCallerAgent()`     |
| Mode mapping across providers for child agents                 | daemon  | `mcp-server.ts` `mapModeAcrossProviders()` |
| Streamable HTTP transport for MCP                              | daemon  | `bootstrap.ts` MCP routing                 |
| MCP injection into agent sessions (configurable)               | daemon  | `daemon-config-store.ts`                   |

### 3.13 Voice and Speech

| Feature                                                   | Surface | Evidence                               |
| --------------------------------------------------------- | ------- | -------------------------------------- |
| Text-to-speech (TTS) management                           | daemon  | `agent/tts-manager.ts`                 |
| Speech-to-text (STT) management                           | daemon  | `agent/stt-manager.ts`                 |
| Dictation stream (start/chunk/finish/cancel)              | user    | `session.ts` dictation*stream*\* cases |
| Voice mode toggle                                         | user    | `session.ts` case `set_voice_mode`     |
| Voice turn controller                                     | daemon  | `voice/voice-turn-controller.ts`       |
| Speech readiness snapshots (realtime, dictation, overall) | daemon  | `speech/speech-runtime.ts`             |
| Local speech provider support                             | daemon  | `speech/providers/local/`              |
| OpenAI speech provider support                            | daemon  | `speech/providers/openai/`             |
| Provider reconciliation and model download                | daemon  | `speech/speech-runtime.ts`             |
| Audio playback confirmation                               | user    | `session.ts` case `audio_played`       |
| Voice audio chunk streaming                               | user    | `session.ts` case `voice_audio_chunk`  |
| PCM16 resampling                                          | daemon  | `agent/pcm16-resampler.ts`             |
| Per-provider voice defaults (Claude, Codex, OpenCode)     | daemon  | `provider-manifest.ts` voice config    |
| Voice permission auto-approval policy                     | daemon  | `voice-permission-policy.ts`           |
| Two-way native audio bridge (Expo)                        | user    | `packages/expo-two-way-audio`          |

### 3.14 File Explorer and Editor Integration

| Feature                                              | Surface | Evidence                                           |
| ---------------------------------------------------- | ------- | -------------------------------------------------- |
| File explorer directory listing                      | user    | `session.ts` case `file_explorer_request`          |
| File reading through explorer                        | daemon  | `file-explorer/service.ts`                         |
| File download via token-based endpoint               | user    | `session.ts` case `file_download_token_request`    |
| List available editors                               | user    | `session.ts` case `list_available_editors_request` |
| Open file/project in editor                          | user    | `session.ts` case `open_in_editor_request`         |
| Open project request                                 | user    | `session.ts` case `open_project_request`           |
| Directory suggestions (home dirs, workspace entries) | user    | `session.ts` case `directory_suggestions_request`  |

### 3.15 CLI Command Surface

| Feature                                                               | Surface  | Evidence                    |
| --------------------------------------------------------------------- | -------- | --------------------------- |
| `paseo ls` (list agents, global/local, filter, sort)                  | cli-only | `commands/agent/ls.ts`      |
| `paseo run` (create + optional wait, detach, worktree, output-schema) | cli-only | `commands/agent/run.ts`     |
| `paseo attach` (stream agent output)                                  | cli-only | `commands/agent/attach.ts`  |
| `paseo logs` (agent timeline, follow, tail, filter)                   | cli-only | `commands/agent/logs.ts`    |
| `paseo stop` (interrupt agent)                                        | cli-only | `commands/agent/stop.ts`    |
| `paseo delete` (hard-delete agent)                                    | cli-only | `commands/agent/delete.ts`  |
| `paseo send` (follow-up message, with image support)                  | cli-only | `commands/agent/send.ts`    |
| `paseo inspect` (agent detail)                                        | cli-only | `commands/agent/inspect.ts` |
| `paseo wait` (block for agent finish)                                 | cli-only | `commands/agent/wait.ts`    |
| `paseo archive` (soft-delete, force option)                           | cli-only | `commands/agent/archive.ts` |
| `paseo daemon start/stop/restart/status/pair`                         | cli-only | `commands/daemon/`          |
| `paseo chat create/ls/inspect/delete/post/read/wait`                  | cli-only | `commands/chat/`            |
| `paseo terminal ls/create/attach`                                     | cli-only | `commands/terminal/`        |
| `paseo loop run/ls/inspect/logs/stop`                                 | cli-only | `commands/loop/`            |
| `paseo schedule create/ls/inspect/logs/pause/resume/delete`           | cli-only | `commands/schedule/`        |
| `paseo permit ls/allow/deny`                                          | cli-only | `commands/permit/`          |
| `paseo provider ls/models`                                            | cli-only | `commands/provider/`        |
| `paseo speech` commands                                               | cli-only | `commands/speech/`          |
| `paseo worktree ls/archive`                                           | cli-only | `commands/worktree/`        |
| `paseo onboard`                                                       | cli-only | `commands/onboard.ts`       |
| Output formats: table, json, yaml, quiet (IDs only)                   | cli-only | `output/`                   |

### 3.16 Desktop (Electron)

| Feature                                                     | Surface      | Evidence                                         |
| ----------------------------------------------------------- | ------------ | ------------------------------------------------ |
| Local daemon supervision (start, restart, version mismatch) | desktop-only | `packages/desktop/src/daemon/daemon-manager.ts`  |
| Custom `paseo://` protocol registration                     | desktop-only | `packages/desktop/src/main.ts`                   |
| Single-instance lock                                        | desktop-only | `packages/desktop/src/main.ts`                   |
| Dev worktree isolation (separate userData)                  | desktop-only | `packages/desktop/src/main.ts`                   |
| Login shell environment inheritance                         | desktop-only | `packages/desktop/src/login-shell-env.ts`        |
| Local transport (in-process daemon communication)           | desktop-only | `packages/desktop/src/daemon/local-transport.ts` |
| Desktop IPC: file dialogs, notifications, openers, menu     | desktop-only | `packages/desktop/src/features/`                 |
| Pairing offer flow for relay setup                          | desktop-only | `packages/desktop/src/daemon/daemon-manager.ts`  |
| Open-project routing from deep links                        | desktop-only | `packages/desktop/src/open-project-routing.ts`   |

### 3.17 Relay and Remote Access

| Feature                                                    | Surface | Evidence                                                                                  |
| ---------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| End-to-end encrypted relay channel                         | daemon  | `packages/relay/src/encrypted-channel.ts`                                                 |
| ECDH key exchange + XSalsa20-Poly1305 encryption           | daemon  | `packages/relay/src/crypto.ts`                                                            |
| Daemon keypair persistence (mode 0600)                     | daemon  | `packages/server/src/server/daemon-keypair.ts`                                            |
| Client-side and daemon-side channel creation               | daemon  | `packages/relay/src/encrypted-channel.ts`                                                 |
| Relay transport with control ping/pong and stale detection | daemon  | `packages/server/src/server/relay-transport.ts`                                           |
| QR code pairing (transfers daemon public key)              | user    | `packages/server/src/server/pairing-qr.ts`, `packages/server/src/server/pairing-offer.ts` |
| Connection offer encoding                                  | daemon  | `packages/server/src/server/connection-offer.ts`                                          |
| Handshake retry logic                                      | daemon  | `packages/relay/src/encrypted-channel.ts`                                                 |

### 3.18 Skills (Claude Code Skills)

| Feature                                                      | Surface | Evidence                            |
| ------------------------------------------------------------ | ------- | ----------------------------------- |
| `paseo` (CLI reference skill for managed agents)             | skill   | `skills/paseo/SKILL.md`             |
| `paseo-orchestrate` (end-to-end implementation orchestrator) | skill   | `skills/paseo-orchestrate/SKILL.md` |
| `paseo-handoff` (context-rich handoff to another agent)      | skill   | `skills/paseo-handoff/SKILL.md`     |
| `paseo-chat` (chat room coordination between agents)         | skill   | `skills/paseo-chat/SKILL.md`        |
| `paseo-loop` (iterative worker/verifier loop setup)          | skill   | `skills/paseo-loop/SKILL.md`        |
| `paseo-committee` (dual high-reasoning agent planning)       | skill   | `skills/paseo-committee/SKILL.md`   |

### 3.19 App Client Features

| Feature                                                                             | Surface | Evidence                                                             |
| ----------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------- |
| Multi-host management with per-host sessions                                        | user    | `packages/app/src/runtime/host-runtime.ts`                           |
| Adaptive connection probing (direct + relay, latency threshold)                     | user    | `packages/app/src/runtime/host-runtime.ts` `ConnectionProbeState`    |
| Agent directory hydration with pagination                                           | user    | `packages/app/src/runtime/host-runtime.ts` `refreshAgentDirectory()` |
| Host-aware routing (`/h/:serverId/...`)                                             | user    | `packages/app/src/utils/host-routes.ts`                              |
| Draft agent creation screen with form state preservation                            | user    | `packages/app/src/screens/agent/draft-agent-screen.tsx`              |
| Form state priority: explicit > stored prefs > provider defaults                    | user    | `app/src/hooks/use-agent-form-state.ts`                              |
| Provider snapshot query and live subscription                                       | user    | `app/src/hooks/use-providers-snapshot.ts`                            |
| Session stream reducers (epoch/sequence gating, gap recovery)                       | user    | `app/src/contexts/session-stream-reducers.ts`                        |
| Normalized stream items (user_message, assistant_message, thought, tool_call, etc.) | user    | `app/src/types/stream.ts`                                            |
| Cross-platform workspace screen (split panes, tabs, terminals)                      | user    | `app/src/screens/workspace/workspace-screen.tsx`                     |
| Agent stream view with platform-adaptive rendering                                  | user    | `app/src/components/agent-stream-view.tsx`                           |
| Settings screen (hosts, providers, diagnostics, pairing, daemon)                    | user    | `app/src/screens/settings-screen.tsx`                                |
| Left sidebar with host picker and project list                                      | user    | `app/src/components/left-sidebar.tsx`                                |
| Push notification registration and delivery                                         | user    | `session.ts` case `register_push_token`                              |
| Keyboard shortcuts and command center                                               | user    | `app/src/app/_layout.tsx`                                            |
| Client-side draft persistence (AsyncStorage)                                        | user    | `app` draft store                                                    |
| Attachment store (IndexedDB for web)                                                | user    | `docs/DATA_MODEL.md`                                                 |

---

## 4. Signature Feature Analysis

### 4.1 Mid-Session Invites and Shared Runtime Contribution

**What Paseo implements:**

- Multiple WebSocket clients can connect to the same daemon simultaneously and observe the same `AgentManager` state. The daemon broadcasts `agent_update` and `agent_stream` events to all subscribed sessions.
  - Evidence: `packages/server/src/server/agent/agent-manager.ts` subscriber model; `packages/server/src/server/websocket-server.ts` multi-session handling.
- The Expo app supports managing multiple daemon hosts from one client.
  - Evidence: `packages/app/src/runtime/host-runtime.ts`.
- The MCP surface allows agents to create child agents, enabling a form of agent-contributed work within a session.
  - Evidence: `packages/server/src/server/agent/mcp-server.ts`.

**What Paseo does NOT implement:**

- No user identity model. There are no user accounts, roles, or identities. The daemon trusts any client that can reach the socket.
- No invite mechanism. There is no way for one user to invite another to join a live session.
- No "bring your own agent" to someone else's session. Agent creation is local to each daemon.
- The relay is single-user remote access (one daemon, one paired device), not multi-user collaboration.
- No concept of a session as a collaborative space that multiple users join simultaneously.

**Rating: Absent** for invites and shared contribution. **Partial** for shared observation (multiple clients can observe the same daemon, but there is no user-level collaboration model).

### 4.2 Multi-User and Multi-Agent Chat

**What Paseo implements:**

- `FileBackedChatService` provides persistent chat rooms with messages, `@agentId` mentions, `@everyone` broadcasts, reply-to threading, and blocking `waitForMessages()`.
  - Evidence: `packages/server/src/server/chat/chat-service.ts`, `packages/server/src/server/chat/chat-mentions.ts`.
- Full CLI surface for chat: `paseo chat create/ls/inspect/delete/post/read/wait`.
  - Evidence: `packages/cli/src/commands/chat/`.
- The `paseo-chat` skill teaches agents how to use chat rooms for async coordination.
  - Evidence: `skills/paseo-chat/SKILL.md`.
- The `paseo-orchestrate` skill uses chat and MCP tools to coordinate multi-agent teams with role-specialized agents (researchers, planners, implementers, auditors).
  - Evidence: `skills/paseo-orchestrate/SKILL.md`.

**What Paseo does NOT implement:**

- No human user participants in chat. Chat is agent-to-agent; humans interact through the session/CLI, not through chat rooms.
- No roles or role-based permissions in chat rooms.
- No turn policy (who speaks when).
- No budget policy (cost controls per participant).
- No stop conditions on conversations.
- No moderation system.
- No rich message types beyond text with mentions.

**Rating: Partial.** Agent-to-agent chat rooms with mentions and persistence exist and are functional. The multi-user, policy, and moderation dimensions required by ai-sidekicks are absent.

### 4.3 Queue, Steer, Pause, Resume

**What Paseo implements:**

- **Resume from persisted state:** Agents can be resumed from `PersistenceHandle` across daemon restarts. This works for Claude (session ID), Codex (thread ID), OpenCode (session ID), and ACP (session ID).
  - Evidence: `packages/server/src/server/agent/agent-manager.ts` `resumeAgentFromPersistence()`.
- **Schedule pause/resume:** Schedules have explicit `pause` and `resume` lifecycle states.
  - Evidence: `packages/server/src/server/schedule/service.ts`.
- **Interrupt (stop):** Running agents can be interrupted via `cancel_agent_request`.
  - Evidence: `packages/server/src/server/session.ts`.
- **Follow-up messages:** `send_agent_message_request` can send new prompts to idle agents.
  - Evidence: `packages/server/src/server/session.ts`.
- **Loop stop:** Running loops can be stopped, which cancels active worker/verifier agents.
  - Evidence: `packages/server/src/server/loop-service.ts`.

**What Paseo does NOT implement:**

- No formal message queue. Agents are created and run immediately; there is no queued backlog of work items.
- No steer-as-intervention. There is no way to redirect a running agent mid-turn without interrupting and restarting. `send` works on idle agents, not running ones.
- No pause-and-freeze for agents. Agents can be interrupted (stopped) but not suspended in a way that preserves exact in-progress state for later continuation. The "resume" capability works at the session level (starting a new turn on an existing session), not at the mid-turn level.
- No daemon-backed work queue with priority, ordering, or capacity management.

**Rating: Partial.** Session persistence and resume are real and work across providers. Schedule pause/resume exists. But a proper queue, steer-as-intervention, and mid-turn pause are absent.

### 4.4 Repo Attach and Git Flow

**What Paseo implements:**

- **Workspace git service** with live filesystem watching, debounced refresh, and subscription model covering branch, dirty state, ahead/behind counts, and diff stats.
  - Evidence: `packages/server/src/server/workspace-git-service.ts`.
- **Full git operation surface:** checkout/switch branch, stash (save/pop/list), commit, merge (to/from base), pull, push, PR create, PR status.
  - Evidence: `packages/server/src/server/session.ts` (14 checkout/git-related RPC cases).
- **Worktree management:** Create, list, and archive Paseo-managed git worktrees with slug validation, branch creation, and cleanup (close agents, kill terminals).
  - Evidence: `packages/server/src/server/worktree-session.ts`, `packages/server/src/server/worktree-bootstrap.ts`, `packages/server/src/utils/worktree.ts`.
- **Checkout diff subscription:** Live diff updates streamed to the client.
  - Evidence: `packages/server/src/server/checkout-diff-manager.ts`.
- **Branch suggestions** for the agent creation flow.
  - Evidence: `packages/server/src/server/session.ts` case `branch_suggestions_request`.
- **GitHub PR integration** (PR status, create PR).
  - Evidence: `workspace-git-service.ts`, `utils/checkout-git.ts`.
- **Project and workspace registries** with project kind detection (git/non_git), workspace kind (local_checkout/worktree/directory).
  - Evidence: `packages/server/src/server/workspace-registry.ts`, `workspace-registry-model.ts`.
- **CLI worktree support** on `paseo run --worktree`.
  - Evidence: `packages/cli/src/commands/agent/run.ts`.

**What Paseo does NOT implement:**

- No diff attribution. There is no tracking of which agent changed which lines or files. Diffs are workspace-level, not agent-level.
- No formal branch strategy beyond worktrees. The user decides branch naming; there is no enforced convention.
- No PR review workflow (review comments, approval gates, merge rules) -- only PR creation and status checking.

**Rating: Complete** for basic git flow and worktree management. The diff-attribution gap and lack of automated branch strategy are noted but do not diminish the functional completeness of the git integration.

### 4.5 Visibility

**What Paseo implements:**

- **Real-time timeline streaming** over WebSocket with epoch-based sequencing, gap detection, and canonical catch-up.
  - Evidence: `packages/server/src/server/agent/agent-manager.ts`, `packages/app/src/contexts/session-stream-reducers.ts`.
- **Rich tool call detail types:** shell (command + output + exit code), read (file + content), edit (file + diff), write (file + content), search (query + results), fetch (URL + response), worktree_setup (commands + log), sub_agent (actions + log), plan (text), plain_text, unknown.
  - Evidence: `packages/server/src/server/agent/agent-sdk-types.ts` `ToolCallDetail`.
- **Normalized stream items** on the client: user_message, assistant_message, thought, tool_call, todo_list, activity_log, compaction.
  - Evidence: `packages/app/src/types/stream.ts`.
- **Permission flow visibility:** Permission requests stream to all subscribed clients with full detail.
  - Evidence: `agent-manager.ts` permission dispatch, `session.ts` permission forwarding.
- **Attention tracking:** Agents flag attention for finished, error, or permission states; clients receive these transitions.
  - Evidence: `agent-manager.ts` `emitState()`, `agent-attention-policy.ts`.
- **Activity curation:** Summarized text output from timeline items for compact views.
  - Evidence: `packages/server/src/server/agent/activity-curator.ts`.
- **Timeline projection** with assistant-chunk and tool-lifecycle collapsing for transport efficiency.
  - Evidence: `packages/server/src/server/agent/timeline-projection.ts`.
- **Push notifications** for agent attention events.
  - Evidence: `packages/server/src/server/push/push-service.ts`, `packages/server/src/server/agent-attention-policy.ts`.
- **Agent lifecycle state machine:** initializing -> idle -> running -> idle (or error -> closed), with all transitions visible.
  - Evidence: `docs/ARCHITECTURE.md`, `shared/agent-lifecycle.ts`.
- **Loop and schedule logs** with structured entries (seq, timestamp, source, level).
  - Evidence: `loop-service.ts`, `schedule/types.ts`.

**What Paseo does NOT implement:**

- No formal subtask or handoff tracking in the event model. Sub-agent spawning is visible as a `sub_agent` tool call detail, but there is no first-class subtask tree or handoff event type in the timeline.
- No state transition timeline (a dedicated view of lifecycle transitions over time). Transitions are embedded in the stream but not surfaced as a separate first-class timeline.

**Rating: Complete** for live timeline, tool detail, and permission visibility. The sub-task and state-transition gaps are minor given the richness of the existing event model.

---

## 5. Provider Normalization Model

### Architecture

The provider subsystem has three layers:

1. **Manifest** (`provider-manifest.ts`): Static catalog of built-in providers (Claude, Codex, Copilot, OpenCode, Pi) with labels, descriptions, default modes, UI mode metadata, and voice defaults.

2. **Registry** (`provider-registry.ts`): Dynamic assembly layer that maps provider IDs to concrete client factories, merges runtime settings and config overrides, supports derived providers (custom providers that extend a built-in), and wraps sessions/clients to preserve outer provider identity.

3. **Adapters** (individual provider files): Each adapter translates provider-native APIs into the shared `AgentClient`/`AgentSession` contract defined in `agent-sdk-types.ts`.

### Supported Providers

| Provider   | Transport                                         | Key Characteristics                                                     |
| ---------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| Claude     | Anthropic Agent SDK spawning Claude Code process  | Dynamic modes, MCP, reasoning, persistence, slash commands              |
| Codex      | JSON-RPC to `codex app-server` subprocess         | MCP, reasoning, persistence, synthetic features (fast_mode, plan_mode)  |
| OpenCode   | SDK against shared local `opencode serve` process | Dynamic modes, MCP, model/thinking mutation, mode discovery             |
| Copilot    | ACP over stdio (`copilot --acp`)                  | Dynamic modes, autopilot auto-approval, ACP plan/tool normalization     |
| Pi         | ACP over stdio (`pi-acp`)                         | Thinking-option remapping, model-label cleanup, tool-kind normalization |
| Custom ACP | ACP over stdio (user-specified command)           | Generic ACP adapter; extends via `extends: "acp"` in config             |

### Normalized capabilities

Every provider advertises via `AgentCapabilityFlags`:

- `supportsStreaming`
- `supportsSessionPersistence`
- `supportsDynamicModes`
- `supportsMcpServers`
- `supportsReasoningStream`
- `supportsToolInvocations`

### What is normalized across all providers

- MCP server config (stdio, HTTP, SSE) into provider-native formats
- Prompts (text or text+image) into provider-native input shapes
- Tool activity into shared `ToolCallDetail` variants
- Permission flows into shared `AgentPermissionRequest`/`AgentPermissionResponse`
- Persistence handles into shared `AgentPersistenceHandle`
- Models, modes, and thinking options into shared selection interfaces
- Stream events into shared `AgentStreamEvent` union

Evidence: `packages/server/src/server/agent/agent-sdk-types.ts`, `packages/server/src/server/agent/provider-registry.ts`, individual adapter files in `packages/server/src/server/agent/providers/`.

---

## 6. Persistence and Data Model

### Storage root

All daemon state lives under `$PASEO_HOME` (defaults to `~/.paseo`).

### Directory layout

```
$PASEO_HOME/
  config.json                           # Daemon configuration (PersistedConfigSchema)
  daemon-keypair.json                   # Relay ECDH keypair (mode 0600)
  daemon.log                            # Daemon trace logs
  agents/{project-dir}/{agentId}.json   # One file per agent
  schedules/{scheduleId}.json           # One file per schedule
  chat/rooms.json                       # All rooms + messages
  loops/loops.json                      # All loop records
  projects/projects.json                # Project registry
  projects/workspaces.json              # Workspace registry
  push-tokens.json                      # Expo push notification tokens
```

### Agent record

One JSON file per agent, grouped by project directory. Fields include: id, provider, cwd, timestamps, title, labels, lastStatus, lastModeId, config (serializable), runtimeInfo, features, persistence handle, attention state, internal flag, and archivedAt.

### Write strategy

All writes use atomic temp-file-plus-rename. No database. Schemas use Zod validation with optional fields and defaults for forward compatibility. `AgentStorage` queues writes per agent ID to prevent concurrent corruption.

### Client-side storage

- Draft store: `AsyncStorage` key `paseo-drafts` (version 2).
- Attachment bytes: `IndexedDB` database `paseo-attachment-bytes` (web only).
- Host profiles and daemon registry: `AsyncStorage`.

Evidence: `docs/DATA_MODEL.md`, `packages/server/src/server/agent/agent-storage.ts`, `packages/server/src/server/workspace-registry.ts`, `packages/server/src/server/persisted-config.ts`.

---

## 7. Real-Time and Visibility Architecture

### Event model

The daemon streams events to clients through the WebSocket protocol. Key message types:

- `agent_update`: Agent state changed (status, title, labels, attention).
- `agent_stream`: New timeline event from a running agent (contains `AgentStreamEvent`).
- `workspace_update`: Workspace state changed (git status, PR status).
- `agent_permission_request`: Agent needs user approval.
- `status`: Server info updates.
- `activity_log`: Activity summary updates.
- `audio_output`: Voice/speech output chunks.

### Timeline model

- **Append-only** with epochs (each run starts a new epoch).
- **Sequence-based** with `seq`, `epoch`, `minSeq`, `maxSeq`, `nextSeq` for cursor pagination.
- **Gap detection**: Both daemon and client detect gaps in sequence delivery and trigger canonical catch-up fetches.
- **Projection modes**: Raw timeline rows can be projected with assistant-chunk merging and tool-lifecycle collapsing.
- **Client reducers**: `processTimelineResponse()` decides between full replacement and incremental append. `processAgentStreamEvent()` gates events by epoch and sequence.

### Streaming architecture

- Mobile clients only receive high-frequency stream events for the focused agent, with a grace period for backgrounded agents (bandwidth optimization).
- Binary multiplexing: Terminal I/O and agent streams share the WebSocket via `BinaryMuxFrame`.
- The client maintains head (live/optimistic) and tail (canonical/authoritative) timeline views that are stitched at render time.

### Push notifications

- Expo push tokens registered via `register_push_token`.
- Attention-policy module computes whether to notify the client or send a push.
- Notifications include agent attention payloads (finished, error, permission).

Evidence: `packages/server/src/server/agent/agent-manager.ts`, `packages/app/src/contexts/session-stream-reducers.ts`, `packages/app/src/types/stream.ts`, `packages/server/src/server/agent-attention-policy.ts`, `packages/server/src/server/push/push-service.ts`.

---

## 8. Security and Remote Access

### Trust model

- **Local daemon:** Trusted by socket reachability (same as Docker). No authentication token. Default bind: `127.0.0.1:6767`.
- **Remote access:** Only supported through the relay. The relay is treated as untrusted.
- **Agent authentication:** Paseo does not manage API keys. Each provider handles its own credentials. Agents run in the user's process context.

### Relay encryption

- Daemon generates a persistent ECDH keypair stored at `$PASEO_HOME/daemon-keypair.json` (mode 0600).
- Pairing (QR code or link) transfers the daemon's public key to the client.
- ECDH key exchange derives a shared secret.
- All messages encrypted with XSalsa20-Poly1305 (NaCl box).
- Each session derives fresh keys; the relay sees only IP addresses, timing, message sizes, and session IDs.
- Handshake retry logic with 1-second interval and up to 200 pending sends buffer.

### Defense in depth

- Host header validation (Vite-style allowlist) for DNS rebinding protection.
- CORS origin checks with configured allowlist.
- `WebSocket` server validates `Host` and `Origin` headers on connection.
- Hello timeout on WebSocket connections before session creation.

### Known limitation

Within a live relay session, replay protection is not yet implemented. The protocol uses random nonces but does not track nonce reuse or message counters.

Evidence: `SECURITY.md`, `packages/relay/src/encrypted-channel.ts`, `packages/server/src/server/daemon-keypair.ts`, `packages/server/src/server/allowed-hosts.ts`, `packages/server/src/server/relay-transport.ts`.

---

## 9. Automation Features

### Loops

The `LoopService` implements daemon-persisted worker/verifier orchestration:

- Each iteration creates a worker agent, runs it to completion, then verifies via shell checks (exit code) and/or an LLM verifier agent.
- Configurable sleep, max iterations, max time, per-provider model selection for worker vs verifier.
- Structured iteration logs with monotonic sequence numbers.
- Recovery on daemon restart (interrupted loops marked as stopped).
- Archive option for preserving iteration agent history.

Evidence: `packages/server/src/server/loop-service.ts`.

### Schedules

The `ScheduleService` provides cron and interval scheduling:

- `every` (interval in ms) and `cron` (expression) cadence types.
- Targets: send prompt to existing agent or create new agent from embedded config.
- Max runs limit and expiration time.
- Pause/resume lifecycle.
- Run history with output, error, and timing.
- Recovery on restart (stale `nextRunAt` values advanced, interrupted runs recorded).

Evidence: `packages/server/src/server/schedule/service.ts`.

### Skills (orchestration patterns)

The skills directory provides Claude Code skills that implement sophisticated multi-agent patterns on top of the MCP and CLI surface:

- **paseo-orchestrate**: Full TDD implementation orchestrator with triage, research, planning, implementation, verification, cleanup, and delivery phases. Deploys role-specialized agents (researchers, planners, impl, auditors, refactorers, QA). Uses heartbeat schedules for self-monitoring. Supports worktree mode.
- **paseo-committee**: Dual high-reasoning agent (Opus + GPT-5.4) planning with adversarial synthesis.
- **paseo-handoff**: Context-rich task handoff to another agent with structured briefing.
- **paseo-loop**: Guided setup of worker/verifier loops.
- **paseo-chat**: Agent-to-agent chat room coordination.

These skills are not runtime code -- they are Claude Code skill definitions that agents can load. They represent a significant orchestration layer that exists on top of, but is not embedded in, the Paseo daemon.

Evidence: `skills/paseo-orchestrate/SKILL.md`, `skills/paseo-committee/SKILL.md`, `skills/paseo-handoff/SKILL.md`, `skills/paseo-loop/SKILL.md`, `skills/paseo-chat/SKILL.md`.

### MCP for agent-to-agent control

The daemon MCP server enables agents to manage other agents:

- Create child agents with caller context inheritance (cwd, mode, model).
- Wait for agent completion with timeout.
- Send follow-up prompts.
- Query agent status and activity.
- Manage permissions programmatically.
- Create and manage schedules.
- Manage worktrees.
- Operate terminals.

Evidence: `packages/server/src/server/agent/mcp-server.ts`, `packages/server/src/server/agent/agent-management-mcp.ts`.

---

## 10. Strengths

1. **Daemon-first architecture with real service isolation.** The daemon owns all state, and clients are projections. This means agent sessions survive client disconnects, terminals persist across app launches, and schedules run headless. The architecture is proven correct by the fact that CLI, app, and desktop all consume the same daemon without reimplementing agent management.

2. **Provider normalization is deep and principled.** Five providers (Claude, Codex, OpenCode, Copilot, Pi) plus a generic ACP adapter are normalized to a shared contract. The normalization covers not just session lifecycle but also MCP config, prompts, tool activity, permissions, persistence, models, modes, and thinking options. Custom providers can be added via config alone (`extends: "acp"` + command).

3. **Git integration is first-class and comprehensive.** Live workspace git snapshots with filesystem watching, full checkout operations (branch, stash, commit, merge, pull, push, PR), worktree management, diff subscription, and GitHub PR status. This is one of the most complete git integration surfaces in any coding agent tool.

4. **Real-time visibility is production-grade.** Epoch/sequence-based timeline streaming with gap detection and canonical catch-up. Rich tool call detail types cover every common agent action. The client-side stream consistency model (head/tail split, reducers, projection) handles real-world failure modes.

5. **Automation surface is unusually rich.** Daemon-backed loops with worker/verifier cycles, cron/interval schedules with pause/resume, and an MCP surface that allows agents to orchestrate other agents. The skills layer on top implements sophisticated multi-agent patterns (orchestrate, committee, handoff).

6. **Cross-platform client with multi-host support.** The Expo app supports iOS, Android, web, and Electron from one codebase. Multi-host management with adaptive connection probing and relay fallback is a first-class architectural concern, not an afterthought.

7. **Security model is explicit and honest.** The relay threat model is documented and the encryption is real (ECDH + NaCl box). The local trust boundary (socket reachability) is acknowledged rather than hidden behind false security theater.

8. **Backward compatibility discipline.** WebSocket schemas are treated as a compatibility boundary (old mobile clients must parse newer daemons). Explicit version gates and compatibility filtering are embedded in the session controller.

---

## 11. Limitations and Gaps

1. **No user identity or multi-user collaboration model.** The daemon has no concept of users, roles, or access control. Anyone who can reach the socket has full control. This makes shared-session collaboration impossible without external access management.

2. **No formal message queue.** Agent creation is immediate; there is no queued backlog, priority ordering, or capacity management. For workloads that need controlled concurrency or scheduling priority, this is a structural gap.

3. **No steer-as-intervention.** Running agents cannot be redirected mid-turn. The only option is interrupt (stop) and restart. `send` works on idle agents. This limits fine-grained human control during long-running agent operations.

4. **No agent pause/freeze.** Agents can be interrupted or resumed (from persistence handles at the session level), but there is no suspend-and-resume that preserves exact mid-turn state. This is a meaningful gap for long operations where the user wants to pause and later continue from the exact same point.

5. **No diff attribution.** There is no tracking of which agent changed which files or lines. In multi-agent scenarios, understanding who made what change requires manual git inspection.

6. **Chat is agent-only.** The chat system has no human participants, no roles, no turn policy, no budget controls, and no moderation. It is designed for agent-to-agent coordination, not for human-multi-user collaboration.

7. **Skills are not runtime.** The orchestration skills (orchestrate, committee, handoff) are Claude Code skill definitions, not daemon-embedded capabilities. They depend on the Claude Code runtime being the agent provider and cannot be invoked by non-Claude agents or through the UI.

8. **No in-session replay protection on relay.** Within a live relay session, there is no nonce tracking or message counter to prevent replay attacks. Documented as a known limitation in `SECURITY.md`.

9. **Single-daemon scope.** While the app supports multiple hosts, there is no federation or cross-daemon coordination. Each daemon is an independent island.

10. **File-based persistence limitations.** All state is JSON files with no query capability, no transactions, and no concurrent-writer safety beyond per-key queue ordering. This works at single-user scale but would need rethinking for shared or high-throughput scenarios.

11. **No formal branch strategy.** Worktrees are supported but branch naming, merge policy, and PR workflow automation are left to the user or skill layer. There is no daemon-enforced convention.

12. **No cost/budget tracking.** While `AgentUsage` includes `totalCostUsd`, there is no budget enforcement, alerting, or aggregation across agents or sessions.
