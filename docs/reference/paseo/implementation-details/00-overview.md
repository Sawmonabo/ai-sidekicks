# Repo Exploration: Overview

## Table of Contents
- [Scope](#scope)
- [Repo Shape](#repo-shape)
- [System Topology](#system-topology)
- [End-To-End Runtime Flow](#end-to-end-runtime-flow)
- [Persistence And Security Model](#persistence-and-security-model)
- [Recommended Reading Order](#recommended-reading-order)
- [Sources](#sources)

## Scope
This walkthrough explains the repo through the way the system actually runs: one daemon process owns the control plane, and the app, CLI, desktop shell, and relay all either connect to it or package it.[S1][S2][S5]

## Repo Shape
The root workspace declares eight packages: `server`, `app`, `cli`, `desktop`, `relay`, `website`, `highlight`, and `expo-two-way-audio`. The root scripts reinforce that organization: `build:daemon` builds the server-side publishing units, `build:desktop` builds the Electron wrapper plus the web app, and `cli` runs the workspace-local CLI entrypoint.[S1]

The architecture doc matches that layout. `packages/server` is the daemon, `packages/app` is the shared mobile/web UI, `packages/cli` is the command-line surface, `packages/desktop` is the Electron shell, and `packages/relay` is the encrypted bridge used for remote access.[S2]

## System Topology
Paseo is daemon-first. Clients talk to the daemon over a shared WebSocket protocol, either directly or through the relay path. The daemon then owns agent lifecycle, timeline streaming, MCP exposure, storage, and auxiliary services such as terminals, chat, schedules, loops, and speech.[S2][S5][S6]

At the package level, the important split is:

| Layer | Primary package | Why it exists |
|---|---|---|
| Control plane | `packages/server` | Owns agent processes, protocol, persistence, and runtime services.[S2][S5][S6] |
| Interactive client | `packages/app` | Renders the cross-platform UI and maintains live host/session state.[S2][S7][S8] |
| Scriptable client | `packages/cli` | Exposes the same daemon operations as terminal commands.[S1][S9] |
| Managed shell | `packages/desktop` | Runs the app in Electron and supervises a local daemon.[S2][S10] |
| Remote transport | `packages/relay` | Adds end-to-end encrypted relay connectivity without changing the control plane.[S2][S4][S11] |

## End-To-End Runtime Flow
The top-level daemon entrypoint loads persisted config, creates a logger, acquires the PID lock, constructs the daemon, starts listening, and coordinates shutdown or restart intents.[S5]

Inside bootstrap, the daemon composes an Express app, HTTP server, agent storage, project/workspace registries, chat service, `AgentManager`, provider registry, terminal manager, workspace git service, loop service, schedule service, MCP routing, and speech services before it starts listening.[S6]

Once the server is live, the WebSocket server becomes the main session gateway. It validates `Host` and `Origin`, enforces a hello timeout, and builds a `Session` object that receives every runtime dependency needed to answer client RPCs.[S12]

On the client side, the app shell creates host runtimes and per-host `SessionProvider` instances, then routes the landing page to the first online host or to `/welcome` if none are connected.[S7][S8]

## Persistence And Security Model
Persistence is deliberately file-based. The data model doc defines `$PASEO_HOME` as the root for `config.json`, per-agent files, per-schedule files, chat state, loop state, project/workspace registries, and push-token storage. The server code mirrors that: bootstrap instantiates file-backed stores instead of a database layer.[S3][S6]

The security model is equally explicit. The local daemon is trusted by socket reachability, not by a second auth token, and the supported remote path is the relay. The relay is treated as untrusted; pairing transfers the daemon public key, then the client and daemon establish an end-to-end encrypted channel before commands are accepted.[S4][S11]

## Recommended Reading Order
1. Read `docs/ARCHITECTURE.md` for the global design contract.[S2]
2. Read [01 Server Daemon](./01-server-daemon.md) next, because every other package is downstream of the daemon.[S5][S6]
3. Expand the daemon view with [05 Server Services And Config](./05-server-services-and-config.md), [06 Server Providers And Normalization](./06-server-providers-and-normalization.md), [08 Session And Agent Manager](./08-session-and-agent-manager.md), and [09 Provider Transports And Features](./09-provider-transports-and-features.md), because those files explain how persistence, automation, provider adapters, the per-client controller, the shared agent runtime, and the concrete provider transport layers are actually implemented.[S5][S6]
4. Then read [02 App Client](./02-app-client.md) followed by [07 App State UI And Routing](./07-app-state-ui-and-routing.md) to see how the rich client resolves hosts, routes, drafts, and live stream state on top of the daemon contract.[S7][S8]
5. Finish with [03 CLI And Desktop](./03-cli-and-desktop.md) and [04 Relay And Support Packages](./04-relay-and-support-packages.md) for the alternate client surfaces and supporting libraries.[S9][S10][S11]

## Sources
- [S1] `package.json#L1-L105`, workspace layout and root script topology.
- [S2] `docs/ARCHITECTURE.md#L3-L192`, system overview, package roles, protocol summary, and deployment models.
- [S3] `docs/DATA_MODEL.md#L3-L214`, persistence layout, agent records, daemon config, and schedule storage.
- [S4] `SECURITY.md#L7-L62`, trust boundaries, relay model, and DNS rebinding protection.
- [S5] `packages/server/src/server/index.ts#L18-L205`, daemon entrypoint and lifecycle handling.
- [S6] `packages/server/src/server/bootstrap.ts#L198-L620`, daemon composition root and startup path.
- [S7] `packages/app/src/app/_layout.tsx#L1-L239`, app shell providers and per-host session wiring.
- [S8] `packages/app/src/app/index.tsx#L1-L56`, root route selection for online hosts versus welcome.
- [S9] `packages/cli/src/cli.ts#L1-L163`, CLI surface area and top-level command registration.
- [S10] `packages/desktop/src/main.ts#L1-L260`, Electron shell initialization and window lifecycle.
- [S11] `packages/relay/src/encrypted-channel.ts#L1-L260`, encrypted relay channel handshake and transport wrapper.
- [S12] `packages/server/src/server/websocket-server.ts#L344-L752`, WebSocket validation, hello handling, and session construction.
