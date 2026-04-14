# Repo Exploration: Server Providers And Normalization

## Table of Contents
- [Role](#role)
- [Manifest And Registry Layer](#manifest-and-registry-layer)
- [Identity Wrapping And Compatibility](#identity-wrapping-and-compatibility)
- [Claude Adapter](#claude-adapter)
- [Codex Adapter](#codex-adapter)
- [OpenCode Adapter](#opencode-adapter)
- [ACP Family And Custom Providers](#acp-family-and-custom-providers)
- [Architectural Pattern](#architectural-pattern)
- [Sources](#sources)

## Role
The daemon does not talk to Claude Code, Codex, OpenCode, Copilot, Pi, and custom ACP providers directly from the session layer. It talks to a normalized `AgentClient` and `AgentSession` contract, and the provider subsystem is what makes that possible.[S1][S2]

## Manifest And Registry Layer
`provider-manifest.ts` is the static catalog. It defines the built-in provider IDs, labels, descriptions, default modes, and UI-facing mode metadata for Claude, Codex, Copilot, OpenCode, and Pi.[S1]

`provider-registry.ts` is the dynamic assembly layer. It maps provider IDs to concrete client factories, merges runtime settings with provider overrides, supports profile-defined model lists, enables or disables providers, and creates derived providers that either extend a built-in provider or declare a custom ACP command.[S2]

That means provider identity is partly static and partly runtime-configured. The manifest says what a provider is supposed to look like, while the registry decides which concrete client should exist in this daemon process and under what launch settings.[S1][S2]

## Identity Wrapping And Compatibility
The registry does more than construct clients. It also wraps sessions and clients when a derived provider reuses another provider's implementation. `wrapSessionProvider()` and `wrapClientProvider()` remap provider IDs onto runtime info, persistence handles, stream events, model definitions, and persisted-agent descriptors so the rest of the daemon sees the outer provider ID instead of the inner implementation ID.[S2]

That wrapper behavior is what allows custom providers to behave like first-class providers without forking the entire protocol surface. A derived provider can still create a Codex or Claude session internally while the rest of Paseo consistently sees the custom provider identity.[S2]

## Claude Adapter
`ClaudeAgentClient` is structurally straightforward. It validates that the requested config is for `claude`, constructs new or resumed `ClaudeAgentSession` instances, lists models through the Claude model catalog, scans persisted Claude sessions from `~/.claude/projects`, and exposes a diagnostic surface that checks command availability, version, and model-fetch status.[S3]

Architecturally, Claude shows the simplest provider shape in the repo: native provider session creation plus filesystem-backed discovery of previously persisted sessions.[S3]

## Codex Adapter
`CodexAppServerAgentClient` treats Codex as an app-server subprocess. It resolves the launch prefix, spawns `codex app-server`, then creates or resumes a `CodexAppServerAgentSession` over that child process connection.[S4]

It also uses the app server as a discovery API. `listPersistedAgents()` enumerates threads, reads preview and timeline state, and maps each thread into Paseo's persisted-agent descriptor model. `listModels()` queries `model/list`, reconciles configured defaults, and normalizes Codex reasoning-effort metadata into the shared model and thinking-option shape expected by the UI.[S4]

That makes Codex an example of protocol translation: Paseo is not embedding Codex behavior directly, it is translating Codex's own app-server API into the daemon's agent contract.[S4]

## OpenCode Adapter
OpenCode is handled through a singleton process manager. `OpenCodeServerManager` starts `opencode serve --port ...`, waits for the server to announce that it is listening, keeps the chosen port alive, and shuts the process down on exit signals.[S5]

`OpenCodeAgentClient` then creates or resumes sessions against that local HTTP server, enforces explicit timeouts for session creation and provider discovery, filters model lists down to connected upstream providers, caches context-window metadata, and falls back to default modes when dynamic mode discovery is unavailable.[S5]

This design is different from Codex in one important way: the daemon reuses a shared OpenCode server process instead of spawning a fresh server for each session or query.[S5][S2]

## ACP Family And Custom Providers
`ACPAgentClient` is the generic adapter for the ACP family. It can probe available models and modes from ACP session state or config options, create new sessions, resume existing sessions from persisted metadata, and apply provider-specific transformers for models, tool snapshots, or thinking-option writes.[S6]

The deeper ACP session logic is where normalization becomes visible. The adapter maps ACP plans into todo timeline items, converts ACP tool snapshots into Paseo tool-call detail variants, reconstructs shell, read, edit, fetch, and search tool outputs, and turns ACP permission prompts into the daemon's `AgentPermissionRequest` shape. It also has provider-specific policy hooks such as Copilot autopilot auto-approval behavior.[S7]

In the registry layer, custom ACP providers are created by pointing a provider override at `extends: "acp"` plus a command, which is why third-party ACP-compatible agents can plug into Paseo without needing a bespoke adapter file first.[S2][S6]

## Architectural Pattern
Across all of these adapters, the pattern is stable:

1. The manifest defines stable provider identity and default UI metadata.[S1]
2. The registry decides which concrete client exists and whether it is wrapped or derived.[S2]
3. The adapter translates provider-native session and discovery APIs into shared models for sessions, persistence, timelines, models, modes, and permissions.[S3][S4][S5][S6][S7]

That normalization layer is the reason the app, CLI, schedules, loops, and daemon session RPCs can treat "provider" as data rather than writing provider-specific branches everywhere else in the codebase.[S2]

## Sources
- [S1] `packages/server/src/server/agent/provider-manifest.ts#L17-L203`, built-in provider definitions, labels, and mode metadata.
- [S2] `packages/server/src/server/agent/provider-registry.ts#L1-L473`, client factories, override merging, derived providers, identity wrapping, and registry construction.
- [S3] `packages/server/src/server/agent/providers/claude-agent.ts#L1051-L1185`, Claude client session creation, resume flow, model listing, persisted session discovery, and diagnostics.
- [S4] `packages/server/src/server/agent/providers/codex-app-server-agent.ts#L3992-L4170`, Codex app-server spawn, session creation and resumption, persisted thread discovery, and model normalization.
- [S5] `packages/server/src/server/agent/providers/opencode-agent.ts#L577-L900`, OpenCode server lifecycle, shared server manager, session creation and resume, model discovery, and mode discovery.
- [S6] `packages/server/src/server/agent/providers/acp-agent.ts#L205-L430`, ACP model and mode derivation plus generic ACP client create and resume behavior.
- [S7] `packages/server/src/server/agent/providers/acp-agent.ts#L1820-L2070`, ACP timeline, tool-call, and permission-request normalization.
