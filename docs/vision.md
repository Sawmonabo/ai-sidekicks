# Greenfield Vision

## Table Of Contents

- [Thesis](#thesis)
- [Product Goal](#product-goal)
- [The Remote Control Model](#the-remote-control-model)
- [What Every Device Shows](#what-every-device-shows)
- [What Every Device Can Do](#what-every-device-can-do)
- [Remote Control Invariants](#remote-control-invariants)
- [Core Reframe](#core-reframe)
- [Architectural Position](#architectural-position)
- [Top-Level Architecture](#top-level-architecture)
- [1. Desktop Main Process](#1-desktop-main-process)
- [2. Desktop UI (Desktop Renderer)](#2-desktop-ui-desktop-renderer)
- [3. Local Runtime Daemon](#3-local-runtime-daemon)
- [4. Control Plane](#4-control-plane)
- [5. Session Engine](#5-session-engine)
- [6. Provider Drivers](#6-provider-drivers)
- [7. Git Engine](#7-git-engine)
- [8. Client SDK](#8-client-sdk)
- [Core Domain Model](#core-domain-model)
- [Critical Design Choices](#critical-design-choices)
- [Execution Locality Vs Remote Control](#execution-locality-vs-remote-control)
- [Provider Drivers And The Run Model](#provider-drivers-and-the-run-model)
- [Files Vs Database](#files-vs-database)
- [Agent Chat Vs Workflow Engine](#agent-chat-vs-workflow-engine)
- [Visibility Vs Provider Limits](#visibility-vs-provider-limits)
- [Technology Position](#technology-position)
- [Keep](#keep)
- [Change](#change)
- [Add](#add)
- [Signature Features And Their Correct Implementation](#signature-features-and-their-correct-implementation)
- [1. Remote Control And Linked Devices](#1-remote-control-and-linked-devices)
- [2. Multi-Agent Chat](#2-multi-agent-chat)
- [3. Queue, Steer, Pause, Resume](#3-queue-steer-pause-resume)
- [4. Repo Attach And Gitflow](#4-repo-attach-and-gitflow)
- [5. Visibility](#5-visibility)
- [Suggested Greenfield Stack](#suggested-greenfield-stack)
- [Build Order](#build-order)
- [CLI Delivery Path](#cli-delivery-path)
- [Architecture Cross-References](#architecture-cross-references)
- [Strategic Conclusion](#strategic-conclusion)

## Thesis

This product is an agent operating system for software work.

The architecture must be built on a small set of strong primitives rather than on a loose union of benchmark-product features.

## Product Goal

Build the best environment for:

- agentic orchestrations and workflows
- one user with one agent
- one user with multiple agents
- Codex and Claude support first
- pause, resume, steer, queue, and intervene during execution
- attaching repositories so agents can work with proper Gitflow and clear diffs
- full visibility into what agents are doing, thinking, saying, and calling
- reaching a live session from any of your devices — phone, laptop, second desktop — with everything the desktop can do

This is the defining requirement:

- a session must be reachable from any device the user has linked, with shared state and live history, without breaking the runtime model
- a device must be able to attach to a live session, chat in it, and drive every agent running on the machine that executes the work

That means the session cannot be designed as a window onto one process. The session is the durable object; a device is a view onto it.

## The Remote Control Model

One user, many linked devices, one machine executing. The session is a durable agentic workspace with its conversation and history — never a mirrored screen or a forwarded keyboard. The shared object is the conversation, the activity, and the work product.

A session begins on the machine that executes it. Linking a second device changes where the user is sitting, not the runtime model: the device, linked to the same account, opens the session on the machine that holds it, catches up on session history from that machine, and drives the session through the same typed contracts the desktop uses.

### What Every Device Shows

- the full working conversation — every prompt, agent reply, and typed message
- the actual work product — file changes, diffs, plans, and artifacts as they are produced, rendered in the transcript and reviewable inline
- agent activity as it unfolds — runs starting, commands executing, outputs streaming, subagent fan-outs — identically on every device
- device presence — which of the user's linked devices are online, and whether the executing machine is reachable
- history replay for a device that joins late, backfilled from the executing machine's event log (per-daemon logs are the V1 event-sourcing scope)

### What Every Device Can Do

Every linked device can do everything the desktop can, bounded only by the session's approval policies:

- type into the session — feedback, direction, correction
- steer agents through conversation — redirect mid-task, question plans, queue follow-ups
- queue prompts while an agent is mid-run
- start runs and orchestrations — including multi-agent workflows with autonomous subagent dispatch — on the machine that executes the session, under the user's own provider subscription
- approve or refuse what an agent asks to do, read the diff, and use the terminal

### Remote Control Invariants

- provider-agnostic: agents keep full native capability — orchestration, autonomous subagent dispatch, tool use — regardless of provider; capabilities are normalized where providers match and honestly surfaced where they differ
- credentials never travel: every agent runs on the user's own machine and bills the user's own subscription
- the relay is a courier, not a reader: session content — messages, events, artifacts — is end-to-end encrypted between the user's own devices and their executing machine, so the hosted service never sees readable content (the control plane keeps only each device's connected state and last-seen time, which carry no content)
- agent activation is by addressing: the session's lead answers the person, and any other agent acts when named or dispatched — never by interjecting unbidden
- no screen mirroring, no keyboard forwarding: every surface a device drives is a typed session event, and remote terminal control rides the same E2E channel and exclusive write-lease as a local write

## Core Reframe

The first-class object is not `agent`. It is `session`.

A session contains:

- the user
- devices
- agents
- runs
- workspaces
- approvals
- artifacts

"Two agents talking," "one user chatting with one agent," and "workflow orchestration" must all be different views over the same session and event model.

## Architectural Position

The target system is a distributed runtime with local execution nodes and remote views onto them.

That implies this split:

- local execution must stay local
- the device registry and the relay must live in a hosted or self-hosted control plane, which keeps no session record
- the event model must unify chat, orchestration, git activity, approvals, and interventions
- providers must be adapters into the runtime, not the center of the product

## Top-Level Architecture

### 1. Desktop Main Process

Electron main and preload only:

- windowing
- native dialogs
- notifications
- auto-updates
- daemon supervision

This layer must be thin.

### 2. Desktop UI (Desktop Renderer)

React plus Vite renderer (referred to as "Desktop Renderer" in [Container Architecture](./architecture/container-architecture.md)):

- session views
- orchestration views
- repo and diff views
- approvals
- live device presence
- workflow authoring
- agent and run inspection

Expo is not the right default for a desktop-first product.

### 3. Local Runtime Daemon

Runs on each user machine and owns:

- local provider processes
- git and worktrees
- terminal sessions
- attachments
- repo mounts
- tool execution
- local persistence

This is the machine-local execution authority.

### 4. Control Plane

Hosted or self-hosted service for:

- auth
- the device directory
- each device's connected state and last-seen time, read from its relay connection
- the encrypted relay
- notifications
- shared metadata

It does not need to execute code. It coordinates the user's devices and their runtime nodes.

### 5. Session Engine

The session engine, provider drivers, and git engine are internal responsibilities of the Local Runtime Daemon (see [Container Architecture](./architecture/container-architecture.md)), not standalone containers.

An event-sourced engine where everything important is an event:

- message sent
- run started
- run paused
- run resumed
- run steered
- tool call started
- tool call completed
- approval requested
- approval resolved
- diff produced
- device attached
- device detached

This gives replay, auditability, and determinism.

V1 scopes event-sourcing to per-daemon local event logs — each daemon owns its own authoritative log, and events reach the user's other devices via the relay per [ADR-010](./decisions/010-tokens-passkeys-and-the-remote-channel.md). See [ADR-017: Shared Event-Sourcing Scope](./decisions/017-shared-event-sourcing-scope.md).

### 6. Provider Drivers

Provider integrations must live behind explicit drivers:

- `claude-driver`
- `codex-driver`

A further provider joins only through the provider-admission contract in [Spec-004](./specs/004-provider-driver-contract-and-capabilities.md).

The product should not be architected as wrappers around provider CLIs. The drivers are how a run reaches a provider; the conceptual center is the session and its `Run` state machine.

### 7. Git Engine

The git layer must own:

- repo attach
- clone
- worktree create and remove
- branch strategy
- diff attribution
- PR preparation
- merge policy hooks

The default coding mode must be worktree-first, not direct mutation on the main checkout.

### 8. Client SDK

The CLI and desktop app must share a typed client SDK.

That keeps the daemon honest and prevents the desktop app from becoming the only real client.

## Core Domain Model

The core entities must be:

- `Session`
- `User`
- `RuntimeNode`
- `Agent`
- `Run`
- `QueueItem`
- `Intervention`
- `Approval`
- `RepoMount`
- `Workspace`
- `Worktree`
- `Device`
- `Presence`

If these are modeled cleanly, most major features become straightforward instead of ad hoc.

## Critical Design Choices

### Execution Locality Vs Remote Control

- A purely local runtime is simpler.
- Reaching it from anywhere is harder.
- The right synthesis is local execution plus a device directory, device presence, and an encrypted relay.

### Provider Drivers And The Run Model

- The product owns its `Run` state machine, and each provider driver maps Claude Code or Codex into it through that provider's own features.
- The product builds no first-party agent runtime and no provider marketplace; a later provider is admitted through [Spec-004](./specs/004-provider-driver-contract-and-capabilities.md)'s provider-admission contract.

### Files Vs Database

- JSON files are fine for prototypes.
- This product needs queryable history, projections, replay, and permissions.
- The right local persistence choice is SQLite.

### Agent Chat Vs Workflow Engine

- If separated, the product becomes fragmented.
- The right synthesis is to model both as runs over the same session graph: a workflow's multi-agent step runs a lead and its helpers in the run's session through the same orchestration path a chat uses.

### Visibility Vs Provider Limits

- You will not always get raw chain-of-thought from providers.
- Do not promise unrestricted internal reasoning visibility.
- Instead model reasoning summaries, state transitions, tool intent, and execution traces as first-class concepts.

## Technology Position

### Keep

- TypeScript for daemon, contracts, CLI, and Electron
- React 19 for the renderer
- Electron for the desktop app
- Zod and typed contracts across boundaries

### Change

- Use React plus Vite for the desktop renderer instead of Expo
- Use SQLite as the source of truth for local state
- Use local IPC as the primary desktop and CLI transport
- Treat WebSocket as an adapter, not the center of the design

### Add

Every technology below ships in V1; the feature list is [ADR-015: V1 Feature Scope Definition](./decisions/015-v1-feature-scope-definition.md).

| Technology | Package | Purpose |
| --- | --- | --- |
| PASETO v4 | In-house `packages/crypto-paseto/` on `@noble/curves` + `@noble/ciphers` | Internal auth tokens (replaces JWT); third-party TypeScript PASETO libraries rejected — see [ADR-010 §PASETO v4 Implementation Library](./decisions/010-tokens-passkeys-and-the-remote-channel.md#paseto-v4-implementation-library) |
| WebAuthn | `@simplewebauthn/server` (relying-party verification, control-plane side) | Passkeys: the web client and the phone apps create them and sign in with them, the device-code page signs a machine in with one, and a passkey lets a new phone or browser link itself. The desktop app carries no WebAuthn; the machine signs in to the hosted account by `sidekicks sign-in`'s device code, and each device's own key is kept as [ADR-010 §Identity Key Storage](./decisions/010-tokens-passkeys-and-the-remote-channel.md#identity-key-storage) records. |
| Relay channel | A maintained Noise implementation whose Diffie-Hellman can be supplied from WebCrypto, chosen and recorded in [Plan-028](./plans/028-remote-control.md) Phase 3 | One channel per device and machine on `Noise_KK_25519_ChaChaPoly_SHA256`, with a fresh handshake on every connection and every 10 minutes; the relay forwards ciphertext only ([ADR-010](./decisions/010-tokens-passkeys-and-the-remote-channel.md)). |
| Crypto-shredding cipher | Node.js `crypto` (built-in) | AES-256-GCM for per-user PII column encryption |
| XState v5 | `xstate` | Internal state machine logic — supports ADR-015 V1 Feature 6 (queue, steer, pause, resume) |
| tRPC v11 | `@trpc/server`, `@trpc/client` | Control plane API framework |
| Cedar | `@cedar-policy/cedar-wasm` | Approval policy engine. Policies are written in YAML, compiled to Cedar at the release build and shipped in one signed bundle form: the set built into the service is the first bundle, and a later bundle arrives on the update feed; every bundle passes the same verifier and is evaluated in-process by the resident WASM authorizer, per [ADR-012](./decisions/012-cedar-approval-policy-engine.md). |
| Terminal | `node-pty`, `@xterm/xterm` (own React wrapper — no published wrapper is adopted, per Spec-021 §Console Libraries) | Terminal multiplexing inside Desktop GUI (ADR-015 V1 Feature 15); which of the person's devices may type into a shell is Spec-002's per-shell device control lease |
| Push notifications | `web-push` (Web Push encryption and VAPID headers), `apns2`, FCM's HTTP v1 API through `google-auth-library`, `@hpke/core` with `@hpke/hybridkem-x-wing` | A push to a device with no live connection: the machine decides per device and seals the notice to the device's push key (HPKE with X-Wing; RFC 8291 for Web Push), and the relay adds only the person's own APNs, FCM or VAPID credentials, per [Spec-017 §Cross-Device Delivery](./specs/017-notifications-and-attention-model.md#cross-device-delivery). |
| OpenTelemetry | `@opentelemetry/*` | Observability (traces + metrics) |
| Rate limiting | `rate-limiter-flexible` | Self-hosted rate limiting per [ADR-020](./decisions/020-v1-deployment-model-and-oss-license.md) |
| Rust PTY sidecar | `portable-pty` (wezterm) via child-process sidecar | Windows-primary PTY backend per [ADR-019](./decisions/019-windows-v1-tier-and-pty-sidecar.md); `node-pty` remains the macOS/Linux primary and the Windows fallback |

## Signature Features And Their Correct Implementation

### 1. Remote Control And Linked Devices

This is the highest-value differentiator.

Linking a device must create:

- a device record with its own identity key
- a permission scope
- a relay route to the machine executing the session

A linked device must be able to:

- attach to the live session and read its full history
- chat directly in the same active session
- steer, stop, and approve every run on the executing machine
- read the diff and use the terminal

Revocation must be as easy as linking: removing a device ends its relay route and its session access immediately.

### 2. Multi-Agent Chat

This must not be implemented as raw transcript forwarding between models.

Instead, use run links with:

- budgets
- the per-agent turn limit
- stop conditions
- approvals

### 3. Queue, Steer, Pause, Resume

This must be real runtime behavior, not a UI illusion.

- Queue must be daemon-backed.
- Steer must be modeled as an intervention against an active run.
- Pause must be a runtime state, not just a delay in draining queued messages.
- Resume must continue from persisted run state, not just re-read the thread.

### 4. Repo Attach And Gitflow

A session in a project works in one of two places:

- a worktree of its own
- the checkout the project already has

There is no disposable copy and no read-only place: how much a session may change is its permission level. The system must default to a new worktree for a project session.

### 5. Visibility

The transcript must show:

- message
- tool
- approval
- diff
- subtask
- blocked
- paused
- resumed
- finished

Diff attribution must be per run, with an explicit fallback path only when provider-level attribution is impossible.

## Suggested Greenfield Stack

- Daemon: Node 24.16+, TypeScript
- Renderer: React, Vite
- Desktop app: Electron
- Local DB: SQLite
- Query layer: Kysely or equivalent typed SQL layer
- Logging: pino
- Validation: zod
- IPC: Unix socket on macOS/Linux, named pipe on Windows
- Control plane: Postgres-backed service

## Build Order

1. Build the session and event model.
2. Build the local daemon and SQLite schema.
3. Build the CLI as the first shipped client against the typed client SDK and local daemon contract.
4. Add Codex and Claude drivers with normalized run events.
5. Add repo mounts, worktrees, and diff attribution.
6. Build the Electron desktop app, its main process and its UI, as the second client over the same typed client SDK and daemon contract.
7. Add the control plane for auth, the device directory, and relay.
8. Add workflows and multi-agent orchestration on top of the same session model.

## CLI Delivery Path

- The CLI is the first client delivery track for the product.
- The CLI must prove the typed client SDK, daemon handshake, local IPC, session control, run control, and repo-bound execution flows before desktop-specific UX is treated as the primary path.
- The desktop app is a richer client over the same contracts, not a replacement transport or separate execution path.

## Architecture Cross-References

For details beyond this vision document, see:

- **Authentication and tokens:** [Security Architecture](./architecture/security-architecture.md) (three-tier auth: local socket, PASETO v4 control plane, the Noise relay channel), [ADR-010](./decisions/010-tokens-passkeys-and-the-remote-channel.md)
- **Deployment topologies:** [Deployment Topology](./architecture/deployment-topology.md) (4 topologies: single-device local, the Workers relay, the Compose relay, relay-assisted remote access)
- **Rate limiting:** [Spec-019](./specs/019-rate-limiting-policy.md), [Deployment Topology](./architecture/deployment-topology.md) (CF native binding on the Workers relay, rate-limiter-flexible on the Compose relay)
- **Relay scaling:** [Deployment Topology](./architecture/deployment-topology.md) (one Durable Object for the account; Cloudflare publishes a 1,000 rps per-DO soft cap, and the object's sustained budget is 400 requests a second, 2.5× under it; a pre-launch load test of one account with two machines and three devices validates it)
- **GDPR compliance:** [Spec-020](./specs/020-data-retention-and-gdpr.md) (crypto-shredding, data export, purge lifecycle)

## Strategic Conclusion

If a session must be reachable from every device its owner carries while the work itself keeps running on their own machine, then this system is not just an agent runner.

It is a distributed runtime with local execution nodes and remote views onto them.

Reaching an agent from a phone is not novel on its own: several cloud-hosted agent platforms ship a mobile client. What remains unoccupied is the conjunction this architecture is built around — execution on the user's own machine under their own provider subscription, a phone that can do everything the desktop can rather than a read-only status view, a real policy engine governing steering and dispatch, and an encrypted relay that carries the session without being able to read it. The products with good mobile clients host the session in their own cloud; the products that run on your machine give you no way to reach them from anywhere else. Holding both at once is the position, and every architectural choice in this document exists to hold it.

If the architecture is built around that truth from the beginning, it will establish the correct foundation for a runtime people can actually live in.

If reach is treated as a later add-on, the design will collapse under its own inconsistencies.
