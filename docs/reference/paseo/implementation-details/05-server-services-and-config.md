# Repo Exploration: Server Services And Config

## Table of Contents

- [Role](#role)
- [Config Resolution And Startup Defaults](#config-resolution-and-startup-defaults)
- [Trust Boundaries And Connectivity](#trust-boundaries-and-connectivity)
- [File-Backed Persistence Layer](#file-backed-persistence-layer)
- [Automation And Background Services](#automation-and-background-services)
- [Interactive Runtime Services](#interactive-runtime-services)
- [How To Read These Modules](#how-to-read-these-modules)
- [Sources](#sources)

## Role

These modules are the part of `packages/server` that makes Paseo durable and stateful. The daemon bootstrap path creates them once, then the session and agent layers project their state outward to clients. That is why schedules survive reconnects, loops survive app restarts as persisted records, agent history can be resumed, and voice or terminal readiness can be queried as daemon state instead of UI-local state.[S1][S8][S9]

## Config Resolution And Startup Defaults

`config.ts` is the effective configuration resolver. It merges CLI overrides, environment variables, and `config.json`, then computes the daemon listen address, relay settings, app base URL, CORS allowlist, MCP flags, speech settings, and provider runtime overrides in one pass.[S1]

`persisted-config.ts` defines what `config.json` is allowed to contain. The schema preserves backward compatibility, keeps legacy log fields, validates custom provider overrides, migrates older provider-launch entries, strips deprecated local speech fields, and initializes a default config file if none exists.[S2]

That split is deliberate: `persisted-config.ts` answers "what can be stored," while `config.ts` answers "what should the daemon actually do right now." In practice, that keeps environment-based operational overrides separate from the user-facing persisted config model.[S1][S2]

## Trust Boundaries And Connectivity

`allowed-hosts.ts` implements a Vite-style host allowlist for raw `Host` headers. `localhost`, `*.localhost`, and direct IPs are always allowed by default, while explicit host patterns extend that set rather than replacing it.[S3]

`daemon-keypair.ts` persists the daemon relay identity under `$PASEO_HOME/daemon-keypair.json`. On startup the daemon either imports the existing keypair or generates and saves a new one with mode `0600`, which matches the security model described in `SECURITY.md`: relay connectivity is anchored in daemon-held keys, not in trust of the relay itself.[S4][S13]

## File-Backed Persistence Layer

Most durable state is stored as JSON rather than in a database. `AgentStorage` writes one file per agent, queues writes per agent ID, tracks path migrations, preserves archive state across snapshot flushes, and keeps persistence handles that let the daemon resume provider-backed sessions after restart.[S5]

Projects and workspaces are simpler. `workspace-registry.ts` persists arrays of project and workspace records, validates them with Zod, and writes through a temp-file-plus-rename path so the registry file is updated atomically.[S6]

Chat is also daemon-owned. `chat-service.ts` keeps `rooms.json`, parses `@agentId` mentions, supports reads and writes by room name or ID, and exposes waiter-style `waitForMessages()` behavior so clients can block for new chat messages without inventing their own polling protocol.[S7]

The common architectural pattern is consistent: the server owns canonical state and persists it locally, while clients see snapshots or subscriptions of that state through the session protocol.[S5][S6][S7]

## Automation And Background Services

`LoopService` is the most orchestration-heavy subsystem in this layer. It persists loop records under `$PASEO_HOME/loops`, recovers interrupted loops as stopped on daemon restart, creates worker and verifier agent runs, executes shell-based verify checks, stores structured iteration logs, and can stop active worker or verifier runs through `AgentManager` when cancellation is requested.[S8]

`ScheduleService` is the cron-like counterpart. It stores schedules under `$PASEO_HOME/schedules`, wakes on a one-second tick, recovers interrupted runs, advances stale `nextRunAt` values after restart, and can either resume an existing persisted agent or create a new agent from embedded session config before sending the scheduled prompt.[S9][S14]

These two services show an important product boundary: durable automation belongs in the daemon, not in the mobile app or desktop shell. If it lived in the UI, the feature would disappear when the user closed the client.[S8][S9]

## Interactive Runtime Services

`createTerminalManager()` turns terminals into daemon resources keyed by absolute `cwd`. It keeps a directory-to-terminal index, registers inherited environment variables by root working directory, and emits list-change notifications whenever sessions are created or exit.[S10]

`speech-runtime.ts` is a provider-reconciliation service, not just a thin wrapper around OpenAI or local speech libraries. It resolves requested providers from config, initializes local and OpenAI-backed services, computes readiness snapshots for realtime voice, dictation, and the overall voice feature, monitors missing local models, and can kick off background model downloads before publishing updated readiness to subscribers.[S11]

Together with the agent storage and schedule services, these modules explain why the daemon feels like a long-lived control plane rather than a transport server. Terminals, speech readiness, scheduled runs, loop iterations, chat rooms, and workspace registries are all first-class daemon state.[S5][S8][S9][S10][S11]

## How To Read These Modules

Read these files in this order:

1. `config.ts` and `persisted-config.ts` for the effective and stored daemon configuration models.[S1][S2]
2. `allowed-hosts.ts` and `daemon-keypair.ts` for trust and relay identity setup.[S3][S4]
3. `agent-storage.ts`, `workspace-registry.ts`, and `chat-service.ts` for the durable state model.[S5][S6][S7]
4. `loop-service.ts` and `schedule/service.ts` for long-running automation.[S8][S9]
5. `terminal-manager.ts` and `speech-runtime.ts` for interactive subsystems that the UI consumes as daemon services.[S10][S11]

## Sources

- [S1] `packages/server/src/server/config.ts#L1-L203`, effective config resolution, env and persisted merge order, speech config resolution, and provider override extraction.
- [S2] `packages/server/src/server/persisted-config.ts#L1-L416`, persisted config schema, legacy migration, defaults, validation, and save/load behavior.
- [S3] `packages/server/src/server/allowed-hosts.ts#L1-L97`, host-header parsing and default allowlist semantics.
- [S4] `packages/server/src/server/daemon-keypair.ts#L1-L67`, daemon relay keypair load or generation and persisted storage.
- [S5] `packages/server/src/server/agent/agent-storage.ts#L1-L364`, stored agent schema, per-agent persistence, archive preservation, and atomic writes.
- [S6] `packages/server/src/server/workspace-registry.ts#L1-L229`, file-backed project and workspace registries with atomic persist behavior.
- [S7] `packages/server/src/server/chat/chat-service.ts#L1-L453`, room storage, mention parsing, message persistence, waiter logic, and room/message lookup behavior.
- [S8] `packages/server/src/server/loop-service.ts#L1-L884`, loop record model, recovery behavior, worker and verifier orchestration, verify checks, and persisted logs.
- [S9] `packages/server/src/server/schedule/service.ts#L1-L498`, schedule lifecycle, tick loop, recovery, existing-agent resume, and scheduled agent execution.
- [S10] `packages/server/src/terminal/terminal-manager.ts#L1-L199`, terminal indexing, inherited environment resolution, and terminal list subscriptions.
- [S11] `packages/server/src/server/speech/speech-runtime.ts#L1-L716`, provider reconciliation, readiness snapshots, monitor loop, and background local-model download behavior.
- [S12] `packages/server/src/server/bootstrap.ts#L198-L620`, composition root that wires these services into the daemon.
- [S13] `SECURITY.md#L7-L62`, relay threat model and daemon-held trust anchors.
- [S14] `docs/DATA_MODEL.md#L169-L214`, persisted schedule data model mirrored by the schedule service.
