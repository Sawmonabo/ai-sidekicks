# Repo Exploration: Server Daemon

## Table of Contents
- [Role](#role)
- [Bootstrap Path](#bootstrap-path)
- [Protocol And Session Layer](#protocol-and-session-layer)
- [Agent Lifecycle And Providers](#agent-lifecycle-and-providers)
- [Supporting Services](#supporting-services)
- [How To Read This Package](#how-to-read-this-package)
- [Sources](#sources)

## Role
`packages/server` is the system kernel. It owns daemon startup, transport, session handling, provider integration, persistence, and the long-running services that make Paseo feel stateful across app launches and client reconnects.[S1][S2]

## Bootstrap Path
The executable entrypoint in `packages/server/src/server/index.ts` does only a small number of critical things: resolve `PASEO_HOME`, load persisted config, create the root logger, acquire the PID lock when unsupervised, build the daemon, start it, and manage restart or shutdown intents delivered either by signals or by client requests.[S1]

The real composition root is `packages/server/src/server/bootstrap.ts`. That file parses the listen target, creates the Express app, applies host-allowlist and CORS checks, mounts health and status endpoints, and adds the download-token backed file download endpoint.[S2]

After the HTTP surface is in place, bootstrap assembles the runtime graph: `AgentStorage`, `FileBackedProjectRegistry`, `FileBackedWorkspaceRegistry`, `FileBackedChatService`, `AgentManager`, `providerRegistry`, `TerminalManager`, `WorkspaceGitServiceImpl`, `LoopService`, `ScheduleService`, MCP routing, and speech services. Only after those pieces are wired does the daemon start listening and expose the final bound listen target.[S2]

That structure matters architecturally: almost every server subsystem is injected once here and then threaded into the WebSocket server and session layer rather than being discovered dynamically later.[S2][S3]

## Protocol And Session Layer
The protocol contract lives in `packages/server/src/shared/messages.ts`. That file defines the stream-event union, the agent snapshot schema, and the request schemas for key directory fetches such as `fetch_agents_request` and `fetch_workspaces_request`. Because older mobile clients must continue to parse newer daemons, these schemas are a compatibility boundary, not just a typing convenience.[S4][S5]

`packages/server/src/server/websocket-server.ts` owns connection admission. Its constructor requires the server-wide dependencies, builds a provider snapshot manager, validates host and origin on `/ws`, installs the hello timeout, and creates a `Session` only after the client has completed the initial handshake.[S3]

`packages/server/src/server/session.ts` is the main RPC controller. The `handleMessage` switch covers agent creation and resumption, timeline fetches, workspace fetches, worktree operations, git and PR flows, file explorer access, terminal creation and streaming, provider snapshot queries, chat RPCs, schedule RPCs, loop RPCs, speech and dictation flows, and daemon restart/shutdown requests.[S6]

The same file also contains explicit compatibility gates for older app versions, which is consistent with the repo rule that message schemas must remain backward-compatible for older mobile clients talking to newer daemons.[S6]

## Agent Lifecycle And Providers
`AgentManager` is the in-memory state machine for managed agents. It tracks registered clients, active agents, pending foreground runs, timeline windows, pending permissions, previous statuses, and session subscriptions.[S7]

The high-value methods are:

| Method | What it does |
|---|---|
| `subscribe()` | Replays or streams agent state to listeners, optionally scoped per agent.[S7] |
| `fetchTimeline()` | Projects timeline windows with cursor, epoch, and gap handling.[S7] |
| `createAgent()` | Injects the MCP server when enabled, normalizes config, creates the provider session, and registers it as a managed agent.[S7] |
| `waitForAgentRunStart()` and `waitForAgentEvent()` | Block on state transitions, foreground turns, and permission requests without losing abortability.[S8] |
| `registerSession()` and `subscribeToSession()` | Turn provider sessions into managed agents and attach stream event dispatch to the shared lifecycle machinery.[S8] |

Provider identity and default mode metadata live in `provider-manifest.ts`, where built-in providers such as Claude, Codex, Copilot, OpenCode, and Pi are declared with labels, descriptions, and UI-facing modes.[S9]

Provider construction and aliasing live in `provider-registry.ts`. That file maps provider IDs to concrete clients, merges runtime settings and custom overrides, supports derived providers, and wraps inner sessions so that stream events and persistence handles preserve the outer provider identity.[S10]

## Supporting Services
The daemon is more than an agent multiplexer. A few supporting services are central to the product:

| Service | Why it matters |
|---|---|
| `WorkspaceGitServiceImpl` | Watches repositories, builds workspace git snapshots, and surfaces PR state and diff stats to the UI.[S11] |
| `FileBackedChatService` | Persists room/message chat state and supports mention-style workflows from the daemon side.[S2][S6] |
| `LoopService` | Runs orchestrated worker/verifier loops that are persisted outside a single UI session.[S2] |
| `ScheduleService` | Persists cron/every schedules and can target existing agents or create new ones on demand.[S2][S12] |
| `TerminalManager` | Exposes terminals as first-class daemon resources instead of client-local subprocesses.[S2][S6] |

The overall pattern is consistent across the package: stateful things live server-side, and clients are projections over that state rather than owners of it.[S2][S6]

## How To Read This Package
Read the package in this order:

1. `packages/server/src/server/index.ts` for process lifecycle.[S1]
2. `packages/server/src/server/bootstrap.ts` for service composition.[S2]
3. `packages/server/src/server/websocket-server.ts` and `packages/server/src/shared/messages.ts` for transport and protocol.[S3][S4]
4. `packages/server/src/server/session.ts` for the request dispatch surface.[S6]
5. `packages/server/src/server/agent/agent-manager.ts`, `packages/server/src/server/agent/provider-manifest.ts`, and `packages/server/src/server/agent/provider-registry.ts` for the core agent abstraction.[S7][S8][S9][S10]

## Sources
- [S1] `packages/server/src/server/index.ts#L18-L205`, daemon process lifecycle, PID locking, and graceful shutdown.
- [S2] `packages/server/src/server/bootstrap.ts#L198-L620`, service composition, HTTP endpoints, MCP mount, and startup.
- [S3] `packages/server/src/server/websocket-server.ts#L344-L752`, connection validation, provider snapshot manager, and session construction.
- [S4] `packages/server/src/shared/messages.ts#L465-L723`, stream payloads, agent snapshots, and request schemas.
- [S5] `docs/ARCHITECTURE.md#L113-L177`, protocol and data-flow overview.
- [S6] `packages/server/src/server/session.ts#L1618-L2095`, main session RPC dispatcher and compatibility-sensitive request handling.
- [S7] `packages/server/src/server/agent/agent-manager.ts#L325-L860`, agent registry, subscription, timeline fetching, and session creation.
- [S8] `packages/server/src/server/agent/agent-manager.ts#L1349-L1900`, waiting, cancellation, registration, and session stream subscription.
- [S9] `packages/server/src/server/agent/provider-manifest.ts#L17-L203`, built-in provider definitions and mode metadata.
- [S10] `packages/server/src/server/agent/provider-registry.ts#L64-L90` and `packages/server/src/server/agent/provider-registry.ts#L224-L466`, provider factories, wrapper behavior, and registry/client construction.
- [S11] `packages/server/src/server/workspace-git-service.ts#L1-L220`, git snapshot model and subscription/watch API.
- [S12] `docs/DATA_MODEL.md#L169-L214`, schedule persistence model that the daemon-side schedule service implements.
