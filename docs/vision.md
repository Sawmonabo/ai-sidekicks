# Greenfield Vision

## Table Of Contents

- [Thesis](#thesis)
- [Product Goal](#product-goal)
- [The Collaboration Model](#the-collaboration-model)
- [What Every Participant Sees](#what-every-participant-sees)
- [What Every Participant Can Do](#what-every-participant-can-do)
- [How A Collaborator's Work Reaches The Repo](#how-a-collaborators-work-reaches-the-repo)
- [Collaboration Invariants](#collaboration-invariants)
- [Core Reframe](#core-reframe)
- [Architectural Position](#architectural-position)
- [Top-Level Architecture](#top-level-architecture)
- [1. Desktop Shell](#1-desktop-shell)
- [2. Desktop UI (Desktop Renderer)](#2-desktop-ui-desktop-renderer)
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
- [Add](#add)
- [Add Later If Needed](#add-later-if-needed)
- [Signature Features And Their Correct Implementation](#signature-features-and-their-correct-implementation)
- [1. Mid-Session Invites And Shared Runtime Contribution](#1-mid-session-invites-and-shared-runtime-contribution)
- [2. Multi-User And Multi-Agent Chat](#2-multi-user-and-multi-agent-chat)
- [3. Queue, Steer, Pause, Resume](#3-queue-steer-pause-resume)
- [4. Repo Attach And Gitflow](#4-repo-attach-and-gitflow)
- [5. Visibility](#5-visibility)
- [Suggested Greenfield Stack](#suggested-greenfield-stack)
- [Build Order](#build-order)
- [CLI Delivery Path](#cli-delivery-path)
- [Architecture Cross-References](#architecture-cross-references)
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

## The Collaboration Model

The collaboration experience is a shared agentic workspace: closer to a group chat with channels, presence, and history than to screen sharing. Humans and agents are both members of the room. The shared object is the conversation, the activity, and the work product — never a mirrored screen or a forwarded keyboard.

A session begins as one person working with their agents exactly as they would in a single-user CLI. Inviting a collaborator changes the audience, not the runtime model: the invitee joins from their own machine with their own account, catches up on the session history their peers backfill to them, and participates through the same typed contracts.

### What Every Participant Sees

- the full working conversation in every channel they are a member of — every prompt, agent reply, and human message
- the actual work product — file changes, diffs, plans, and artifacts as they are produced, rendered in the timeline and reviewable inline
- agent activity as it unfolds — runs starting, commands executing, outputs streaming, subagent fan-outs — with visibility symmetric for participants sharing the same role and channel membership
- presence — who is online, who is active, and who is currently typing (a typing indicator, not keystroke mirroring)
- history replay for late joiners, backfilled from their peers' local event logs (per-daemon logs are the V1 event-sourcing scope)

### What Every Participant Can Do

Capabilities scale with membership role — viewer, collaborator, runtime contributor (§1. Mid-Session Invites And Shared Runtime Contribution) — and with the session's approval policies:

- type into the shared channels — feedback, discussion, direction
- steer agents in the session through conversation — redirect mid-task, question plans, queue follow-ups; steering an agent owned by another participant is granted by that owner's approval policy, never by membership alone
- queue prompts while an agent is mid-run
- start runs and orchestrations in the session — including multi-agent workflows with autonomous subagent dispatch — using their own agents on their own machine and their own provider subscription
- keep humans-only side channels and direct messages whose content agents are never given as context

### How A Collaborator's Work Reaches The Repo

Three paths, none of which involve another person's keyboard:

1. **Steer the host's agents.** Where the machine owner's approval policy grants it, a collaborator's message directs an agent running on the repo-owner's machine, which edits that owner's checkout — the machine owner stays in control of what executes, and membership alone never authorizes execution on someone else's machine.
2. **Run their own agents on their own clone.** Changes converge through git — branches, worktrees, and PRs — never through two writers mutating the same working copy blind.
3. **Approval-gated dispatch onto another participant's machine.** A task is aimed at the machine where the work needs to happen, and that machine's owner approves before anything runs.

### Collaboration Invariants

- provider-agnostic: agents keep full native capability — orchestration, autonomous subagent dispatch, tool use — regardless of provider; capabilities are normalized where providers match and honestly surfaced where they differ
- credentials never travel: every agent runs on its owner's machine and bills its owner's subscription
- message audience is structural: session content — messages, events, artifacts — is end-to-end encrypted per recipient, so a machine outside the audience never receives readable content (presence signals ride the control plane as non-content metadata), and each daemon scopes which channels its agents are given as context — audience is a runtime-enforced contract, not etiquette
- agent activation is by addressing: agents act when mentioned or dispatched — never by interjecting into human-to-human exchanges
- no screen mirroring, no keyboard forwarding: shared surfaces are typed session events, and any future remote terminal control rides the same E2E channel and exclusive write-lease as local writes

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

V1 scopes event-sourcing to per-daemon local event logs — each daemon owns its own authoritative log, and cross-participant events are delivered via the relay per [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md) and appended to each receiving daemon's local log. Cross-participant audit is federated across daemons; a shared session event log is a V1.1 candidate gated on MLS group encryption. See [ADR-017: Shared Event-Sourcing Scope](./decisions/017-shared-event-sourcing-scope.md).

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
- React 19 for the renderer (pinned `~19.2.5` for auto security uptake; minors require explicit review)
- Electron for the desktop shell
- Zod and typed contracts across boundaries

### Change

- Use React plus Vite for the desktop renderer instead of Expo
- Use SQLite as the source of truth for local state
- Use local IPC as the primary desktop and CLI transport
- Treat WebSocket as an adapter, not the center of the design

### Add

Column rules: the `V1/V1.1/V2` column annotates each technology against the release scope defined in [ADR-015: V1 Feature Scope Definition](./decisions/015-v1-feature-scope-definition.md). `V1` = shipped in V1; `V1.1` = deferred to V1.1; `V1 (desktop)` = V1 scope but gated on the desktop client launch (CLI ships without it). MLS is the notable V1.1 deferral (Cedar WASM evaluation ships resident at V1 per the 2026-07-02 ADR-012 amendment; V1.1 adds only runtime policy-bundle loading). For the authoritative V1 / V1.1 / V2 feature list (not library list), see ADR-015 directly.

| Technology | Package | V1/V1.1/V2 | Purpose |
| --- | --- | --- | --- |
| PASETO v4 | In-house `packages/crypto-paseto/` ([Plan-025](./plans/025-self-hostable-node-relay.md)) on `@noble/curves` + `@noble/ciphers` | V1 | Internal auth tokens (replaces JWT); third-party TypeScript PASETO libraries rejected — see [ADR-010 §PASETO v4 Implementation Library](./decisions/010-paseto-webauthn-mls-auth.md#paseto-v4-implementation-library) |
| WebAuthn | `@simplewebauthn/server`, `@simplewebauthn/browser` | V1 (desktop) | Primary authentication at desktop launch. CLI ships without WebAuthn via Device Authorization Grant (RFC 8628) per [ADR-010 §Positive](./decisions/010-paseto-webauthn-mls-auth.md#positive); desktop client adds passkey/WebAuthn PRF ceremony for Ed25519 identity key derivation per [ADR-010 §CLI Identity Key Storage](./decisions/010-paseto-webauthn-mls-auth.md#cli-identity-key-storage). Desktop is V1 Feature 15 per ADR-015. |
| Relay E2EE (V1 primary) | `@noble/curves`, `@noble/ciphers`, `@noble/hashes` | V1 | Pairwise X25519 ECDH + XChaCha20-Poly1305 AEAD + HKDF-SHA256 for relay-mediated session encryption per [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md). `@noble/curves` audited by Cure53, Kudelski Security, and Trail of Bits; `@noble/ciphers` audited by Cure53. |
| Relay E2EE (V1.1+ upgrade) | MLS (RFC 9420) via an audited implementation (OpenMLS, mls-rs, or post-audit TypeScript implementation) | V1.1 | Post-compromise security and O(log N) group rekeying, gated on audit / interop / soak criteria in [ADR-010](./decisions/010-paseto-webauthn-mls-auth.md). ADR-015 V1.1 Feature #1. |
| Crypto-shredding cipher | Node.js `crypto` (built-in) | V1 | AES-256-GCM for per-participant PII column encryption |
| XState v5 | `xstate` | V1 | Internal state machine logic — supports ADR-015 V1 Feature 6 (queue, steer, pause, resume) |
| tRPC v11 | `@trpc/server`, `@trpc/client` | V1 | Control plane API framework |
| CASL | `@casl/ability` | V1 | RBAC authorization — supports ADR-015 V1 Feature 3 (membership roles and permissions) |
| Cedar | `@cedar-policy/cedar-wasm` | V1 | Approval policy engine. V1 compiles YAML policy definitions to Cedar at build time and evaluates in-process with the resident signature-verified WASM authorizer; V1.1 adds runtime policy-bundle loading per [ADR-012](./decisions/012-cedar-approval-policy-engine.md) (2026-07-02 amendment — loading only, not WASM arrival). |
| Yjs Awareness | `y-protocols` | V1 | Presence CRDT — supports ADR-015 V1 Feature 12 (presence) |
| Terminal | `node-pty`, `@xterm/xterm` (own React wrapper — no published wrapper is adopted, per Spec-023 §Console Libraries) | V1 | Terminal multiplexing inside Desktop GUI (ADR-015 V1 Feature 15); the desktop `terminal` pane is lease-gated over Spec-003's shared-terminal write lease |
| Push notifications | `@pushforge/builder` | V2 | Cross-device notifications via FCM/APNs. V1 delivers notifications to currently-connected devices via SSE only; V2 adds push delivery per [Spec-019 §Cross-Device Delivery](./specs/019-notifications-and-attention-model.md#cross-device-delivery). Not listed in ADR-015 V1 or V1.1; defaults to V2 per [ADR-015 §V2 (Out of Scope for the V1 Horizon)](./decisions/015-v1-feature-scope-definition.md#v2-out-of-scope-for-the-v1-horizon). |
| OpenTelemetry | `@opentelemetry/*` | V1 | Observability (traces + metrics) |
| Agent Trace | In-tree TypeScript reference implementation (no official npm package) | V1 | AI code attribution via the [cursor/agent-trace](https://github.com/cursor/agent-trace) RFC v0.1.0 draft, pinned at commit [`2754f077`](https://github.com/cursor/agent-trace/tree/2754f077f3e50c1fb5088183f5c9362077cc8ca1) (latest `main` as of 2026-04-19; no git tags or releases exist — pin by commit SHA, not version tag). We emit trace records against the in-tree reference implementation (`index.ts` + `schemas.ts` in the repo); the unofficial community npm package `agent-trace` (by `attharrva15`, `github.com/Atharva-Kanherkar/agent-trace`) is unrelated to Cursor and **must not be used**. Supports V1 gitflow PR and diff attribution per [Spec-011](./specs/011-gitflow-pr-and-diff-attribution.md) (a cross-cutting V1 spec; ADR-015 Feature 11 is "Local daemon with CLI" / Spec-007, not this spec). |
| Rate limiting | `rate-limiter-flexible` | V1 | Self-hosted rate limiting per [ADR-020](./decisions/020-v1-deployment-model-and-oss-license.md) (self-host path is V1) |
| Rust PTY sidecar | `portable-pty` (wezterm) via child-process sidecar | V1 | Windows-primary PTY backend per [ADR-019](./decisions/019-windows-v1-tier-and-pty-sidecar.md); `node-pty` remains the macOS/Linux primary and the Windows fallback |

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
- **Relay scaling:** [Deployment Topology](./architecture/deployment-topology.md) (relay DO sharding; Cloudflare publishes a 1,000 rps per-DO soft cap and no per-DO WebSocket connection cap — our 25-connections-per-data-DO target plus batched WebSocket messages as design baseline keep realistic rps/DO near 400 rps, inside CF's 200–500 rps 'complex op' guidance with ~2.5× headroom vs the soft cap; 50-participant pre-launch load test validates both the events/sec/connection assumption and the ~6:1 batching ratio)
- **GDPR compliance:** [Spec-022](./specs/022-data-retention-and-gdpr.md) (crypto-shredding, data export, purge lifecycle)

## Strategic Conclusion

If mid-session human invites and multi-runtime agent collaboration are essential, then this system is not just an agent runner.

It is a collaborative distributed runtime with local execution nodes.

Shared live agent sessions are not novel on their own: by mid-2026, several cloud-hosted agent platforms ship a form of "invite a colleague into my running session". What remains unoccupied is the conjunction this architecture is built around — local execution on each participant's own machine, real multiplayer with N agents from N owners in one session, a real policy engine governing steering and dispatch rather than all-or-nothing sharing, and one unified human-and-agent timeline. The products that ship multiplayer today host the session in their own cloud; the products that run genuinely locally ship no multiplayer. Holding both at once is the position, and every architectural choice in this document exists to hold it.

If the architecture is built around that truth from the beginning, it will establish the correct foundation for a category-defining collaborative software runtime.

If collaboration is treated as a later add-on, the design will collapse under its own inconsistencies.
