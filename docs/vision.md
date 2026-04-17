# Greenfield Vision

## Table Of Contents

- [Thesis](#thesis)
- [Product Goal](#product-goal)
- [Core Reframe](#core-reframe)
- [Architectural Position](#architectural-position)
- [Top-Level Architecture](#top-level-architecture)
- [1. Desktop Shell](#1-desktop-shell)
- [2. Desktop UI](#2-desktop-ui)
- [3. Local Runtime Daemon](#3-local-runtime-daemon)
- [4. Collaboration Control Plane](#4-collaboration-control-plane)
- [5. Session Engine](#5-session-engine)
- [6. Provider Drivers](#6-provider-drivers)
- [7. Git Engine](#7-git-engine)
- [8. Client SDK](#8-client-sdk)
- [Non-Negotiable Domain Model](#non-negotiable-domain-model)
- [Critical Design Choices](#critical-design-choices)
- [Local-First Vs Collaboration](#local-first-vs-collaboration)
- [Wrapper Integrations Vs First-Party Runtime](#wrapper-integrations-vs-first-party-runtime)
- [Files Vs Database](#files-vs-database)
- [Agent Chat Vs Workflow Engine](#agent-chat-vs-workflow-engine)
- [Visibility Vs Provider Limits](#visibility-vs-provider-limits)
- [Technology Position](#technology-position)
- [Keep](#keep)
- [Change](#change)
- [Add Later If Needed](#add-later-if-needed)
- [Signature Features And Their Correct Implementation](#signature-features-and-their-correct-implementation)
- [1. Mid-Session Invites And Shared Runtime Contribution](#1-mid-session-invites-and-shared-runtime-contribution)
- [2. Multi-User And Multi-Agent Chat](#2-multi-user-and-multi-agent-chat)
- [3. Queue, Steer, Pause, Resume](#3-queue-steer-pause-resume)
- [4. Repo Attach And Gitflow](#4-repo-attach-and-gitflow)
- [5. Visibility](#5-visibility)
- [Suggested Greenfield Stack](#suggested-greenfield-stack)
- [Build Order](#build-order)
- [Strategic Conclusion](#strategic-conclusion)

## Thesis

This product is a collaborative agent operating system for software work.

The architecture must be built on a small set of strong primitives rather than on a loose union of benchmark-product features.

## Product Goal

Build the best environment for:

- agentic orchestrations and workflows
- one user with one agent
- one user with multiple agents
- multiple users with multiple agents
- Codex and Claude support first
- pause, resume, steer, queue, and intervene during execution
- attaching repositories so agents can work with proper Gitflow and clear diffs
- full visibility into what agents are doing, thinking, saying, and calling
- inviting another human into an existing or new session so they can participate directly or bring their own agents

This is the defining requirement:

- a session must support mid-session invites, shared presence, shared state, and shared contribution without breaking the runtime model
- a participant must be able to join a live session, chat directly in that session, and attach one or more agents from their own local machine into that same session

That means the system cannot be designed as a single-user local daemon with collaboration added later. Collaboration must exist in the core domain model from day one.

## Core Reframe

The first-class object is not `agent`. It is `session`.

A session contains:

- participants
- runtime nodes
- channels
- agents
- runs
- repo mounts
- approvals
- artifacts
- invites
- presence

"Two agents talking," "one user chatting with one agent," and "workflow orchestration" must all be different views over the same session and event model.

## Architectural Position

The target system is a collaborative distributed runtime with local execution nodes.

That implies this split:

- local execution must stay local
- collaboration metadata must live in a shared control plane
- the event model must unify chat, orchestration, git activity, approvals, and interventions
- providers must be adapters into the runtime, not the center of the product

## Top-Level Architecture

### 1. Desktop Shell

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
- live presence
- invites
- workflow authoring
- agent and run inspection

Expo is not the right default for a desktop-first product.

### 3. Local Runtime Daemon

Runs on each participant machine and owns:

- local provider processes
- git and worktrees
- terminal sessions
- attachments
- repo mounts
- tool execution
- local persistence

This is the machine-local execution authority.

### 4. Collaboration Control Plane

Hosted or self-hosted service for:

- auth
- invites
- presence
- membership
- relay
- notifications
- shared metadata

It does not need to execute code. It coordinates people and runtime nodes.

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
- invite accepted
- participant joined
- participant left

This gives replay, auditability, determinism, and better collaboration semantics.

### 6. Provider Drivers

Provider integrations must live behind explicit drivers:

- `claude-driver`
- `codex-driver`
- later `native-runtime-driver`

The product should not be architected as wrappers around provider CLIs. That can be the initial implementation path, but not the conceptual center.

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

## Non-Negotiable Domain Model

The core entities must be:

- `Session`
- `Participant`
- `RuntimeNode`
- `Channel`
- `Agent`
- `Run`
- `QueueItem`
- `Intervention`
- `Approval`
- `RepoMount`
- `Workspace`
- `Worktree`
- `DiffArtifact`
- `Invite`
- `Presence`

If these are modeled cleanly, most major features become straightforward instead of ad hoc.

## Critical Design Choices

### Local-First Vs Collaboration

- Pure local is simpler.
- Collaboration is harder.
- The right synthesis is local execution plus shared membership, presence, and relay.

### Wrapper Integrations Vs First-Party Runtime

- Provider wrappers get to market faster.
- A first-party runtime creates real leverage later.
- The right synthesis is to design around your own `Run` state machine now, even if v1 uses Codex and Claude adapters.

### Files Vs Database

- JSON files are fine for prototypes.
- This product needs queryable history, invites, projections, replay, and permissions.
- The right local persistence choice is SQLite.

### Agent Chat Vs Workflow Engine

- If separated, the product becomes fragmented.
- The right synthesis is to model both as channels over the same session graph.

### Visibility Vs Provider Limits

- You will not always get raw chain-of-thought from providers.
- Do not promise unrestricted internal reasoning visibility.
- Instead model reasoning summaries, state transitions, tool intent, and execution traces as first-class concepts.

## Technology Position

### Keep

- TypeScript for daemon, contracts, CLI, and Electron
- React for the renderer
- Electron for the desktop shell
- Zod and typed contracts across boundaries

### Change

- Use React plus Vite for the desktop renderer instead of Expo
- Use SQLite as the source of truth for local state
- Use local IPC as the primary desktop and CLI transport
- Treat WebSocket as an adapter, not the center of the design

### Add

| Technology | Package | Purpose |
| --- | --- | --- |
| PASETO v4 | `paseto-ts` | Internal auth tokens (replaces JWT) |
| WebAuthn | `@simplewebauthn/server`, `@simplewebauthn/browser` | Primary authentication (desktop) |
| MLS (RFC 9420) | `ts-mls` | Relay E2E encryption |
| Crypto primitives (MLS fallback) | `@noble/curves`, `@noble/ciphers` | X25519, XChaCha20-Poly1305 for MLS fallback if `ts-mls` proves immature |
| Crypto-shredding cipher | Node.js `crypto` (built-in) | AES-256-GCM for per-participant PII column encryption |
| XState v5 | `xstate` | Internal state machine logic |
| tRPC v11 | `@trpc/server`, `@trpc/client` | Control plane API framework |
| CASL | `@casl/ability` | RBAC authorization |
| Cedar | `@cedarpolicy/cedar-wasm` | Approval policy engine (V1.1) |
| Yjs Awareness | `y-protocols` | Presence CRDT |
| Terminal | `node-pty`, `xterm.js`, `react-xtermjs` | Terminal multiplexing |
| Push notifications | `@pushforge/builder` | Cross-device notifications (V1.1) |
| OpenTelemetry | `@opentelemetry/*` | Observability (traces + metrics) |
| Agent Trace | Agent Trace spec | AI code attribution |
| Rate limiting | `rate-limiter-flexible` | Self-hosted rate limiting |
| Rust PTY sidecar | `portable-pty` (wezterm) via child-process sidecar | Windows-primary PTY backend per [ADR-019](./decisions/019-windows-v1-tier-and-pty-sidecar.md); `node-pty` remains the macOS/Linux primary and the Windows fallback |

### Add Later If Needed

- a first-party native runtime for deeper control than provider wrappers allow (see §Build Order step 9)

## Signature Features And Their Correct Implementation

### 1. Mid-Session Invites And Shared Runtime Contribution

This is the highest-value differentiator.

An invite must create:

- an invite token
- a membership record
- a permission scope
- a presence session
- a runtime-node linkage when the invitee joins with their own local runtime and agents

A joining participant must be able to:

- enter the live session as a human participant
- chat directly in the same active session
- attach one or more agents from their own local machine
- contribute local context and tools through those attached agents

The system must also support explicit permissioned join modes:

- viewer
- collaborator
- runtime contributor

People and machines must both be first-class participants in a session.

### 2. Multi-User And Multi-Agent Chat

This must not be implemented as raw transcript forwarding between models.

Instead, use channels with:

- participant roles
- turn policy
- budget policy
- stop conditions
- moderation and approval hooks

### 3. Queue, Steer, Pause, Resume

This must be real runtime behavior, not a UI illusion.

- Queue must be daemon-backed.
- Steer must be modeled as an intervention against an active run.
- Pause must be a runtime state, not just a delay in draining queued messages.
- Resume must continue from persisted run state, not just re-read the thread.

### 4. Repo Attach And Gitflow

Every run must bind to a repo mount and execution mode:

- read-only
- branch
- worktree
- ephemeral clone

The system must default to worktree mode for coding tasks.

### 5. Visibility

The timeline must show:

- message
- tool
- approval
- diff
- subtask
- handoff
- blocked
- paused
- resumed
- finished

Diff attribution must be per run, with an explicit fallback path only when provider-level attribution is impossible.

## Suggested Greenfield Stack

- Daemon: Node 22+, TypeScript
- Renderer: React, Vite
- Desktop shell: Electron
- Local DB: SQLite
- Query layer: Kysely or equivalent typed SQL layer
- Logging: pino
- Validation: zod
- IPC: Unix socket on macOS/Linux, named pipe on Windows
- Remote collaboration control plane: Postgres-backed service

## Build Order

1. Build the session and event model.
2. Build the local daemon and SQLite schema.
3. Build the CLI as the first shipped client against the typed client SDK and local daemon contract.
4. Add Codex and Claude drivers with normalized run events.
5. Add repo mounts, worktrees, and diff attribution.
6. Build the Electron shell and desktop UI as the second client over the same typed client SDK and daemon contract.
7. Add the collaboration control plane for auth, invites, presence, and relay.
8. Add workflows and multi-participant discussion orchestration on top of the same session model.
9. Add a first-party native runtime later for deeper control than provider wrappers allow.

## CLI Delivery Path

- The CLI is the first client delivery track for the product.
- The CLI must prove the typed client SDK, daemon handshake, local IPC, session control, run control, and repo-bound execution flows before desktop-specific UX is treated as the primary path.
- The desktop app is a richer client over the same contracts, not a replacement transport or separate execution path.

## Architecture Cross-References

For details beyond this vision document, see:

- **Authentication and tokens:** [Security Architecture](./architecture/security-architecture.md) (three-tier auth: local socket, PASETO v4 control plane, MLS relay), [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md)
- **Deployment topologies:** [Deployment Topology](./architecture/deployment-topology.md) (4 topologies: single-participant, collaborative hosted, collaborative self-hosted, relay-assisted)
- **Rate limiting:** [Spec-021](./specs/021-rate-limiting-policy.md), [Deployment Topology](./architecture/deployment-topology.md) (CF native hosted, rate-limiter-flexible self-hosted)
- **Relay scaling:** [Deployment Topology](./architecture/deployment-topology.md) (relay DO sharding, 25 connections per data DO, 50-participant pre-launch load test)
- **GDPR compliance:** [Spec-022](./specs/022-data-retention-and-gdpr.md) (crypto-shredding, data export, purge lifecycle)

## Strategic Conclusion

If mid-session human invites and multi-runtime agent collaboration are essential, then this system is not just an agent runner.

It is a collaborative distributed runtime with local execution nodes.

If the architecture is built around that truth from the beginning, it will establish the correct foundation for a category-defining collaborative software runtime.

If collaboration is treated as a later add-on, the design will collapse under its own inconsistencies.
