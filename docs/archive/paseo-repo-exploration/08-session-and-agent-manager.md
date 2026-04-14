# Repo Exploration: Session And Agent Manager

## Table of Contents
- [Role Split](#role-split)
- [Session As The Per-Client Controller](#session-as-the-per-client-controller)
- [Session RPC Surface And Compatibility Gates](#session-rpc-surface-and-compatibility-gates)
- [Session Projections For Agents And Workspaces](#session-projections-for-agents-and-workspaces)
- [AgentManager As The Shared Runtime Core](#agentmanager-as-the-shared-runtime-core)
- [Run Orchestration And Wait Semantics](#run-orchestration-and-wait-semantics)
- [Timeline Sequencing And Stream Reduction](#timeline-sequencing-and-stream-reduction)
- [Attention Persistence And Cleanup](#attention-persistence-and-cleanup)
- [How These Two Classes Fit Together](#how-these-two-classes-fit-together)
- [Sources](#sources)

## Role Split
`session.ts` and `agent-manager.ts` are the two most important implementation files in the daemon. `Session` is the per-client facade: it knows about app version compatibility, RPC request and response schemas, client activity, terminal binary streams, voice and dictation state, workspace and provider projections, and transport-facing error handling. `AgentManager` is the shared in-memory core: it owns live agent sessions, run state, permissions, timeline rows, and the normalized lifecycle model that every client sees.[S1][S2]

That distinction matters. If `Session` did not exist, every transport connection would have to know about agents, workspaces, schedules, providers, voice, and terminals directly. If `AgentManager` did not exist, each session would have its own conflicting view of agent state instead of sharing a single daemon truth.[S1][S2]

## Session As The Per-Client Controller
The constructor for `Session` shows its real job. It receives every daemon subsystem it might need, builds a session-scoped provider registry, initializes TTS, STT, dictation, optional MCP access, subscribes to agent events, and optionally subscribes to provider-snapshot and terminal-change streams.[S1]

It also keeps client-scoped state that should not live globally: app version, activity heartbeat, focused agent, inflight request counts, terminal stream slot assignments, voice-mode state, audio buffers, and subscription bootstrapping state for `fetch_agents` and `fetch_workspaces` live updates.[S1]

This is why a `Session` is more than a message switch. It is the daemon-side runtime for one connected client, including bandwidth shaping and compatibility behavior that varies by client version or device type.[S1]

## Session RPC Surface And Compatibility Gates
`handleMessage()` is the main RPC dispatcher. It increments inflight counters, logs inbound message type and size, runs a large switch over every daemon message category, and converts thrown handler errors into `rpc_error` responses when a request ID exists.[S4]

The switch is broad because the daemon API is broad. Agent lifecycle, timeline fetches, workspaces, git and worktree flows, editor integration, provider discovery, diagnostics, voice and dictation, terminals, chat, schedules, loops, daemon config, restart and shutdown intents, and heartbeats all route through the same session controller.[S4]

Compatibility rules are embedded here, not delegated to the app. `Session` gates provider visibility for older mobile clients that only understand legacy provider enums, filters editor IDs for older clients, and preserves both legacy provider-list RPCs and the newer provider-snapshot flow in parallel.[S1][S6]

The session is also where client-specific stream throttling lives. In `subscribeToAgentEvents()`, mobile clients only receive high-frequency stream events for the focused agent, with a short grace period while backgrounded. That keeps the wire protocol stable while letting the server tune event delivery by client context.[S1]

## Session Projections For Agents And Workspaces
`Session` does not just pass raw `AgentManager` objects through. It projects them into transport payloads. `buildAgentPayload()` merges live state with persisted title and archive metadata, while `buildStoredAgentPayload()` synthesizes a client-visible snapshot for agents that are not currently loaded into memory.[S2]

The fetch APIs are effectively projection engines. `handleFetchAgents()` builds a live-plus-persisted view, supports label and status filtering, cursor-based pagination, server-side sorting, optional live subscription bootstrapping, and compatibility filtering for old clients.[S6]

`handleFetchWorkspacesRequest()` does the same for workspaces: it builds descriptor maps from project and workspace registries plus git runtime snapshots, calculates a workspace status bucket from resident agent state, paginates and filters the results, and then optionally keeps the client subscribed to later workspace updates.[S7]

Timeline fetch is another projection layer. `handleFetchAgentTimelineRequest()` loads the agent on demand, calls `AgentManager.fetchTimeline()` using canonical rows and epoch plus sequence cursors, then optionally reprojects those rows into the transport-facing "projected" timeline shape with assistant-chunk and tool-lifecycle collapsing rules.[S8]

## AgentManager As The Shared Runtime Core
`AgentManager` starts with a normalized daemon-owned agent model. It tracks registered provider clients, active agents, pending foreground runs, subscribers, background persistence tasks, previous lifecycle statuses, and optional registry-backed persistence.[S2]

Its `ManagedAgent` type is intentionally richer than a provider session. A managed agent stores config, capabilities, runtime info, available modes, pending permissions, buffered permission resolutions, timeline items plus canonical timeline rows, a timeline epoch and next sequence number, attention state, labels, persistence handles, and whether the agent is internal or user-facing.[S2]

This model is why the rest of the daemon can ask high-level questions like "does this agent need attention?" or "fetch the timeline after cursor X" without caring how Claude, Codex, or OpenCode represent those ideas internally.[S2]

## Run Orchestration And Wait Semantics
Creation and resumption both end in the same place. `createAgent()` normalizes config, injects the daemon MCP server when enabled, verifies provider availability, creates a provider session, and hands it to `registerSession()`. `resumeAgentFromPersistence()` rebuilds config from persistence metadata, resumes the provider session, and also hands it to `registerSession()`.[S2]

`registerSession()` is the real activation path. It allocates the managed-agent record, restores preserved timeline or timestamps when reloading, refreshes runtime info and session state, persists a snapshot, emits initializing and idle state transitions, and only then attaches the session event subscription.[S3]

Foreground execution is handled by `streamAgent()`. It rejects overlapping foreground runs, creates a pending-run token, calls `session.startTurn()`, marks the agent as running, and exposes an async generator backed by per-turn waiters so callers can consume a run as a stream of normalized `AgentStreamEvent` values.[S2]

Replacement is explicit. `replaceAgentRun()` marks the current run for replacement, cancels it, and then starts a fresh stream once the old run has actually settled. That prevents stale pending-run entries from causing false "already has an active run" errors.[S2]

The wait APIs are designed around daemon truth rather than client polling. `waitForAgentRunStart()` blocks until the manager has observed a real start condition, and `waitForAgentEvent()` waits for a permission request or terminal state while handling abort races and synchronous subscription callbacks carefully.[S2]

`Session` turns those primitives into RPC behavior. `handleSendAgentMessageRequest()` resolves an identifier, ensures the agent is loaded, records the user message, starts the agent stream, and waits for start confirmation before acknowledging success. `handleWaitForFinish()` uses `waitForAgentEvent()` to produce "permission", "idle", "error", or "timeout" responses together with the latest projected agent snapshot.[S8]

## Timeline Sequencing And Stream Reduction
`AgentManager` keeps two timeline views at once: `timeline`, which is the item list, and `timelineRows`, which add canonical `seq` and timestamp metadata. `fetchTimeline()` uses those rows plus `epoch`, `minSeq`, `maxSeq`, and `nextSeq` to support tail, before, and after windows while detecting stale cursors and gaps.[S2]

Incoming provider events flow through `dispatchSessionEvent()` and then `handleStreamEvent()`. That reducer updates runtime info on thread start, records timeline items, suppresses duplicate foreground `user_message` echoes, clears permissions on failure or cancellation, tracks usage, emits synthetic system-error assistant messages, and finalizes lifecycle when a turn reaches a terminal event.[S3]

This is the core normalization boundary inside the daemon. Provider sessions emit provider-native events; `AgentManager` turns them into the lifecycle, timeline, permission, and attention semantics that the rest of the daemon and all clients consume.[S3]

## Attention Persistence And Cleanup
`emitState()` does more than broadcast. It synchronizes features from the underlying session, checks lifecycle transitions against `previousStatuses`, and turns those transitions into unread-style attention edges such as "finished", "error", or "permission". Background persistence of those state changes is queued so the daemon can survive restarts without losing important agent status.[S3]

Archiving and deletion are split across the two classes. `AgentManager.archiveAgent()` persists and closes a live agent; `Session` decides how that should appear to the connected client, updates subscription state, and can also archive or delete stored-only agents that are not live in memory.[S5]

Cleanup is similarly layered. `AgentManager.flush()` drains background persistence tasks, while `Session.cleanup()` tears down agent and provider subscriptions, aborts inflight operations, clears audio and voice state, cleans up TTS or STT and dictation managers, closes the MCP client, disables voice mode, and detaches terminal subscriptions.[S9][S10]

## How These Two Classes Fit Together
The interaction pattern is stable:

1. `Session` owns transport-facing concerns: request parsing, compatibility, client activity, and projection into response payloads.[S1][S4]
2. `Session` delegates live agent operations to `AgentManager`: create, resume, refresh, run, cancel, fetch timeline, wait, mutate mode or model, and clear attention.[S5][S8]
3. `AgentManager` owns the authoritative runtime model: sessions, timelines, permissions, lifecycle transitions, and attention tracking.[S2][S3]
4. `AgentManager` emits normalized events back out, and `Session` filters, reshapes, or throttles them for a specific client.[S1][S3]

This pairing is the real daemon control plane: `Session` is the client-specific controller, and `AgentManager` is the shared runtime kernel beneath it.[S1][S2]

## Sources
- [S1] `packages/server/src/server/session.ts#L1-L1160`, session options, client-version compatibility gates, constructor wiring, per-client state, MCP init, and agent-event forwarding.
- [S2] `packages/server/src/server/agent/agent-manager.ts#L1-L1905`, managed-agent model, metrics, timeline fetch, creation, resume, reload, run orchestration, wait semantics, permission response, and cancellation.
- [S3] `packages/server/src/server/agent/agent-manager.ts#L1902-L2629`, session-event dispatch, stream-event reduction, timeline row management, attention tracking, persistence, and config normalization.
- [S4] `packages/server/src/server/session.ts#L1646-L2095`, main message dispatcher, RPC error emission, and message-type routing.
- [S5] `packages/server/src/server/session.ts#L2095-L3393`, agent delete or archive flows, create or resume or refresh handlers, provider discovery RPCs, and lifecycle-affecting request handlers.
- [S6] `packages/server/src/server/session.ts#L4940-L5448`, live plus persisted agent projections, sorting, cursor pagination, and `fetch_agents` subscription bootstrap.
- [S7] `packages/server/src/server/session.ts#L5448-L6235`, workspace descriptor building, git-runtime projection, filtering, cursor pagination, and `fetch_workspaces` live-update bootstrap.
- [S8] `packages/server/src/server/session.ts#L6411-L6905`, timeline fetch projection, send-agent-message flow, and wait-for-finish RPC behavior.
- [S9] `packages/server/src/server/session.ts#L7438-L7488`, session cleanup, manager teardown, voice shutdown, and MCP close.
- [S10] `packages/server/src/server/session.ts#L3907-L3995` and `packages/server/src/server/session.ts#L8310-L8425`, client heartbeat tracking plus binary terminal stream handling.
