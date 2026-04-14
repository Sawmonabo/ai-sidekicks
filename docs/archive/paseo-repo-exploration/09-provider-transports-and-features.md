# Repo Exploration: Provider Transports And Features

## Table of Contents
- [Common Contract](#common-contract)
- [Launch Overrides And Provider Selection](#launch-overrides-and-provider-selection)
- [Claude: SDK Over A Spawned Claude Code Process](#claude-sdk-over-a-spawned-claude-code-process)
- [Codex: Local App-Server Over JSON-RPC](#codex-local-app-server-over-json-rpc)
- [OpenCode: Local Server Plus OpenCode SDK Client](#opencode-local-server-plus-opencode-sdk-client)
- [ACP Family: Stdio Protocol Clients](#acp-family-stdio-protocol-clients)
- [Capabilities Features And Functionality](#capabilities-features-and-functionality)
- [Normalization Layer](#normalization-layer)
- [How Agent Management Stays Provider-Agnostic](#how-agent-management-stays-provider-agnostic)
- [Sources](#sources)

## Common Contract
Paseo does not let `Session` or `AgentManager` talk to Claude, Codex, OpenCode, Copilot, or Pi directly. Every provider is adapted to the same `AgentClient` and `AgentSession` interfaces in `agent-sdk-types.ts`. Those interfaces define the common lifecycle: create or resume a session, start a turn, stream history, expose runtime info, list models and modes, manage pending permissions, persist a handle, interrupt, close, and optionally expose slash commands or mutable model, thinking, and feature settings.[S1]

The capability flags are also normalized there. Every provider advertises whether it supports streaming, session persistence, dynamic modes, MCP servers, reasoning streams, and tool invocations, so the rest of the daemon can reason about features without branching on provider name first.[S1]

## Launch Overrides And Provider Selection
Provider execution is configurable before any session exists. `provider-launch-config.ts` defines runtime command overrides, environment overrides, and richer provider override profiles, while `provider-registry.ts` merges those settings into built-in and derived provider entries.[S2][S3]

That means two things are true at once:

1. The repo ships built-in provider adapters for Claude, Codex, OpenCode, Copilot, and Pi.[S3]
2. The actual command, environment, label, description, enabled state, and even static model list can be overridden from config without changing the daemon code.[S2][S3]

## Claude: SDK Over A Spawned Claude Code Process
Claude is the only provider here that is primarily implemented through a vendor SDK inside Paseo itself. `claude-agent.ts` imports `query` and related types from `@anthropic-ai/claude-agent-sdk`, then injects a custom `spawnClaudeCodeProcess` implementation into the SDK options.[S4]

That custom spawn hook is important: Paseo is not calling Anthropic's HTTP API directly. It is using the Claude agent SDK, and the SDK in turn launches the Claude Code process. Paseo intercepts the process spawn so it can apply runtime command overrides, sanitize environment variables, avoid shell mangling on Windows, and pass through launch-scoped environment variables like the daemon-assigned agent ID.[S4]

At the session layer, `ClaudeAgentSession` manages foreground turns, interruption, pending permissions, history replay, mode changes, model changes, thinking effort changes, and slash commands through the SDK-backed query object. `listCommands()` ultimately calls `supportedCommands()` on the SDK query, and persistence is represented as a Claude session ID plus stored config metadata.[S5]

So the correct summary for Claude is: Paseo uses the Claude agent SDK, but that SDK itself is driving a spawned Claude Code process rather than Paseo speaking a raw network API directly.[S4][S5]

## Codex: Local App-Server Over JSON-RPC
Codex is not integrated through a generic OpenAI REST client. Paseo spawns `codex app-server` as a child process, then talks to it over line-delimited JSON-RPC using `CodexAppServerClient`.[S6]

The transport class handles request IDs, timeouts, notifications, request handlers, stderr buffering, and child-process exit propagation. That is a local process protocol, not a direct HTTP API from Paseo to OpenAI.[S6]

`CodexAppServerAgentSession` then builds on top of that app-server protocol. It initializes the app-server session, starts or resumes threads, resolves default model and reasoning effort, maps common MCP config into Codex's `mcp_servers` config shape, starts turns with approval and sandbox policy derived from Paseo mode presets, and persists the Codex thread ID as the session handle.[S7]

Discovery also happens through that app server. Model listing comes from `model/list`, persisted agents come from `thread/list` plus `thread/read`, and commands or skills come from app-server methods like `skills/list` and `collaborationMode/list`.[S7][S8]

So the correct summary for Codex is: Paseo drives a local Codex app-server subprocess over JSON-RPC. The Codex app-server is the thing that owns the upstream API integration, not Paseo itself.[S6][S7][S8]

## OpenCode: Local Server Plus OpenCode SDK Client
OpenCode is different again. Paseo starts a shared local `opencode serve` process through `OpenCodeServerManager`, then talks to that server using the typed `@opencode-ai/sdk/v2/client` client library.[S9][S10]

This is neither a one-shot CLI wrapper nor a raw custom HTTP client. Paseo spawns the local OpenCode server once, waits for it to announce that it is listening, and then creates SDK clients pointed at that local base URL for session creation, model discovery, mode discovery, prompting, and MCP registration.[S9][S10]

`OpenCodeAgentSession` manages a persistent session ID, configures MCP servers lazily through `client.mcp.add()` and `client.mcp.connect()`, streams OpenCode events, suppresses duplicate streamed part echoes, tracks running tool calls, and normalizes OpenCode's event structure into the shared timeline and permission model.[S11]

So the correct summary for OpenCode is: Paseo uses the OpenCode SDK against a local OpenCode server process that Paseo starts and supervises.[S9][S10][S11]

## ACP Family: Stdio Protocol Clients
Copilot, Pi, and generic custom ACP providers all go through the same ACP adapter. `acp-agent.ts` imports `ClientSideConnection` and the ACP types from `@agentclientprotocol/sdk`, spawns the target process with stdio pipes, wraps those pipes in an NDJSON transport, and speaks the ACP protocol over that stream.[S12][S13]

For new sessions, Paseo sends `newSession`; for persisted sessions it tries `loadSession` or `unstable_resumeSession`; and it maps the shared MCP schema into ACP's MCP server shape before sending it over the wire.[S12][S13]

The concrete built-ins are thin wrappers:

- Copilot extends `ACPAgentClient` with the command `copilot --acp`, a specific mode list, and Copilot capability flags.[S14]
- Pi extends `ACPAgentClient` with the `pi-acp` command plus Pi-specific transformers for models, tool kinds, and thinking-option handling.[S15]
- Generic ACP providers are just custom commands wired into the same ACP adapter through `GenericACPAgentClient`.[S16]

So the correct summary for Copilot, Pi, and custom ACP providers is: Paseo is not using a provider-specific SDK or web API. It is acting as an ACP client over stdio to a spawned ACP-compatible process.[S12][S13][S14][S15][S16]

## Capabilities Features And Functionality
The normalization layer exposes common capability flags, but providers still differ in the knobs they implement.[S1]

Claude advertises dynamic modes, MCP support, reasoning streams, tool calls, session persistence, and slash commands. Its session object supports mode switching, model switching, thinking-effort switching, permission handling, and history replay through the Claude SDK-backed query object.[S4][S5]

Codex also advertises MCP support, reasoning streams, tool calls, and persistence, but not dynamic modes in the same sense. Instead it exposes a smaller stable mode surface plus synthetic feature toggles like `fast_mode` and `plan_mode`, which Paseo computes in `codex-feature-definitions.ts` based on the selected model and available collaboration modes.[S7][S17]

OpenCode advertises dynamic modes and MCP support. Its session caches discovered modes, supports model and thinking-option mutation, streams rich tool activity, and configures MCP servers directly through the OpenCode SDK's MCP endpoints.[S9][S11]

ACP providers are the most variable, so the ACP adapter contains fallback logic. If the provider exposes dedicated mode or model RPCs, Paseo uses them. If not, it falls back to ACP config options with categories like `mode`, `model`, and `thought_level`. This is how Paseo still exposes uniform model and thinking controls even when ACP agents differ in how they surface them.[S12][S18]

Pi is the clearest example of provider-specific feature normalization: its ACP implementation reports thinking levels as modes, so Paseo transforms those modes into a shared `thought_level` select option and exposes them as thinking choices instead of normal execution modes.[S15]

## Normalization Layer
The important architectural fact is not just that there are multiple adapters. It is that each adapter translates provider-native concepts into a shared internal grammar.[S1][S3]

Examples:

- Common MCP config is normalized from one schema into Claude SDK MCP config, Codex `mcp_servers`, OpenCode MCP add/connect calls, or ACP MCP records.[S1][S7][S11][S13]
- Prompts are normalized from text or text-plus-image blocks into the provider's native input shape.[S1][S7][S13]
- Provider-native tool activity becomes shared `ToolCallDetail` and timeline items through provider-specific mappers.[S1][S11][S13][S15]
- Provider-native permission flows become shared `AgentPermissionRequest` and `AgentPermissionResponse` objects.[S1][S5][S13]
- Persisted session identity becomes a shared `AgentPersistenceHandle` regardless of whether the backend uses a Claude session ID, a Codex thread ID, an OpenCode session ID, or an ACP session ID.[S1][S5][S7][S11][S13]

That normalization is why the daemon can archive, resume, schedule, loop, and render all of these providers through the same `AgentManager` and `Session` machinery.[S18]

## How Agent Management Stays Provider-Agnostic
`AgentManager` is where these provider clients finally converge. It only depends on `AgentClient` and `AgentSession`; creation, resume, run, cancel, fetch timeline, wait for state, and permission handling all operate on that normalized interface rather than on provider-specific classes.[S18]

That means "how Paseo manages agents" is the same answer across providers:

1. `provider-registry.ts` chooses the right adapter and wraps it if necessary.[S3]
2. `AgentManager` asks that adapter to create or resume an `AgentSession`.[S18]
3. Provider events are reduced into shared lifecycle, timeline, permission, and attention semantics.[S18]
4. `Session` projects that shared state to the app, CLI, and desktop clients.[S19]

So the daemon is provider-aware at the edge, but provider-agnostic in the core management layer.[S3][S18][S19]

## Sources
- [S1] `packages/server/src/server/agent/agent-sdk-types.ts#L1-L518`, common provider, session, capability, feature, prompt, timeline, permission, and persistence interfaces.
- [S2] `packages/server/src/server/agent/provider-launch-config.ts#L1-L191`, command and env overrides, provider override schema, and launch-prefix resolution.
- [S3] `packages/server/src/server/agent/provider-registry.ts#L1-L473`, built-in and derived provider assembly, identity wrapping, and client creation.
- [S4] `packages/server/src/server/agent/providers/claude-agent.ts#L1-L340`, Claude SDK integration, custom spawn hook, runtime env application, and capability setup.
- [S5] `packages/server/src/server/agent/providers/claude-agent.ts#L1450-L1815`, Claude turn start, interruption, history replay, mode or model or thinking control, permissions, persistence, and slash commands.
- [S6] `packages/server/src/server/agent/providers/codex-app-server-agent.ts#L558-L690`, Codex app-server JSON-RPC transport over the child-process stdio stream.
- [S7] `packages/server/src/server/agent/providers/codex-app-server-agent.ts#L2468-L3395`, Codex session connect, feature exposure, MCP config mapping, thread creation, turn start, model or thinking mutation, persistence, and interruption.
- [S8] `packages/server/src/server/agent/providers/codex-app-server-agent.ts#L3992-L4170`, Codex client spawn, create or resume flow, persisted thread listing, and model discovery.
- [S9] `packages/server/src/server/agent/providers/opencode-agent.ts#L1-L220`, OpenCode SDK imports, local-server assumptions, MCP config mapping, and capability setup.
- [S10] `packages/server/src/server/agent/providers/opencode-agent.ts#L577-L900`, OpenCode shared server manager, session creation and resume, model discovery, and mode discovery.
- [S11] `packages/server/src/server/agent/providers/opencode-agent.ts#L1320-L2065`, OpenCode session state, event streaming, model or thinking mutation, persistence, commands, and MCP add/connect behavior.
- [S12] `packages/server/src/server/agent/providers/acp-agent.ts#L1-L260`, ACP protocol imports, capability defaults, prompt normalization, model and mode derivation, and MCP normalization helpers.
- [S13] `packages/server/src/server/agent/providers/acp-agent.ts#L484-L735` and `packages/server/src/server/agent/providers/acp-agent.ts#L1318-L1415`, ACP process spawning, NDJSON transport, protocol initialize, new or resume session flows, and session-state application.
- [S14] `packages/server/src/server/agent/providers/copilot-acp-agent.ts#L1-L114`, Copilot ACP command, modes, and capabilities.
- [S15] `packages/server/src/server/agent/providers/pi-acp-agent.ts#L1-L406`, Pi ACP wrapper, model-label cleanup, tool-kind fixes, and thinking-option remapping.
- [S16] `packages/server/src/server/agent/providers/generic-acp-agent.ts#L1-L46`, generic ACP provider command wrapping.
- [S17] `packages/server/src/server/agent/providers/codex-feature-definitions.ts#L1-L61`, Codex synthetic feature toggles and model-gated fast mode.
- [S18] `packages/server/src/server/agent/agent-manager.ts#L739-L2629`, provider-agnostic create or resume, run, wait, cancel, timeline, permission, and event-reduction behavior.
- [S19] `packages/server/src/server/session.ts#L2943-L3393` and `packages/server/src/server/session.ts#L6411-L6905`, create or resume RPCs, provider discovery RPCs, send-message handling, and wait-for-finish projection.
