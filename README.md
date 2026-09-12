# AI Sidekicks

```text
      o
     .-.
  .--┴-┴--.
  | O   O |   >> An agentic coding runtime for you and your sidekicks.
  | ||||| |   >> Your machine, your subscription, any device.
  '--___--'
```

AI Sidekicks is an agentic coding desktop runtime: you and your AI sidekicks (Claude Code, Codex) build software in live sessions — steerable agents, sidekick-to-sidekick channels, approval-gated dispatch, git-worktree flow, and Remote Control from any of your linked devices. Every agent runs on your machine, on your own provider subscription.

<p align="center">
  <img src="assets/hero/desktop-app-hero.png" alt="AI Sidekicks Desktop App" width="100%" />
</p>

---

## Table of Contents

- [Why AI Sidekicks](#why-ai-sidekicks)
- [Core Concept](#core-concept)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [V1 Scope](#v1-scope)
- [Build Order](#build-order)
- [Project Status](#project-status)
- [Documentation](#documentation)
- [License](#license)

---

## Why AI Sidekicks

Today's AI coding tools are single-agent and tied to one terminal. You run one agent at a time, on one machine, against your checkout. There's no way to:

- Run Claude and Codex side-by-side on the same task with coordinated git flow
- Have one sidekick hand work to another and watch the handoff resolve
- Pause an agent mid-run, steer its direction, then resume — without losing state
- Get real approval gates before agents install packages, run migrations, or push code
- Walk away from the desk and pick the same run back up on another device

AI Sidekicks exists to solve these problems. It treats **the session** — not the agent — as the first-class primitive, and builds orchestration, approvals, and git flow into the runtime from day one.

---

## Core Concept

The first-class object is not `agent`. It is **`session`**.

A session contains the user, agents, runs, channels, repo mounts, approvals, artifacts, and an event log. "Two agents talking," "one user chatting with one agent," and "workflow orchestration" are all different views over the same session and event model.

```text
                    ┌──────────────────────────────────┐
                    │           SESSION                │
                    │                                  │
                    │   User         ←  You            │
                    │   Agents       ←  Claude, Codex  │
                    │   Channels     ←  Chat, Workflow │
                    │   Runs         ←  Active work    │
                    │   Repo Mounts  ←  Git repos      │
                    │   Approvals    ←  Safety gates   │
                    │   Artifacts    ←  Diffs, files   │
                    │   Events       ←  Audit log      │
                    │                                  │
                    └──────────────────────────────────┘
```

You open a session from any linked device, chat directly in it, and attach one or more agents. The work itself always executes on a runtime node — a machine of yours that holds the repo and runs the provider processes.

---

## Key Features

### Multi-Agent Sessions

Start a session and attach as many sidekicks as the work needs — Claude and Codex together, each on your own provider subscription, with credentials that never leave the machine. Sidekicks coordinate over channels, hand work to each other, and run under one set of approval policies. Session content — messages, events, artifacts — is end-to-end encrypted in transit between your devices and your runtime node: the relay never sees plaintext.

### Queue, Steer, Pause, Resume

Real runtime control — not UI illusions. The queue is daemon-backed. Steer is modeled as an intervention against an active run. Pause is a runtime state with persisted context. Resume continues from where the agent left off.

### Approval Gates

9 categories of approval gates (tool execution, file write, network access, destructive git, user input, plan approval, MCP elicitation, workflow gate, and human phase contribution) ensure agents never take unsupervised action on anything that matters. Approve, deny, or set remembered rules.

### Worktree-First Git Flow

Every coding run binds to a repo mount and execution mode: read-only, branch, worktree, or ephemeral clone. The default is **worktree** — agents work on isolated branches, produce attributed diffs, and prepare PRs without touching your main checkout.

### Visibility and Replay

Every message, tool call, approval, diff, state transition, and handoff is recorded as it happens. Any session replays from its event log.

### Provider Drivers

AI agents run behind explicit driver adapters — `claude-driver` and `codex-driver` ship in V1. The product is not a wrapper around a single provider CLI; it's a runtime that normalizes agent behavior across providers.

### Remote Control

Agent execution stays on your machine. Any device you have linked drives the same session with full parity — read the run, steer it, answer an approval — while the work keeps running where it started. The control plane handles auth, your device directory, and the encrypted relay; it never executes code. A session on the machine that owns it works offline.

---

## Architecture

```text
┌──────────────────┐     ┌──────────────────┐
│   Desktop Shell  │     │       CLI        │
│   (Electron)     │     │   (sidekicks)    │
└────────┬─────────┘     └────────┬─────────┘
         │         Typed SDK      │
         └────────────┬───────────┘
                      │ IPC (Unix socket / named pipe)
              ┌───────┴────────┐
              │  Local Runtime │
              │    Daemon      │
              │                │
              │  ┌──────────┐  │
              │  │ Session  │  │
              │  │ Engine   │  │
              │  ├──────────┤  │
              │  │ Provider │  │    ┌────────────────────┐
              │  │ Drivers  │──┼───►│ Claude / Codex API │
              │  ├──────────┤  │    └────────────────────┘
              │  │   Git    │  │
              │  │ Engine   │  │
              │  ├──────────┤  │
              │  │ SQLite   │  │
              │  └──────────┘  │
              └───────┬────────┘
                      │ tRPC + WebSocket
           ┌──────────┴──────────┐
           │    Control Plane    │
           │  (Auth, Devices,    │
           │   Relay)            │
           │                     │
           │  ┌──────────────┐   │
           │  │  Postgres    │   │
           │  └──────────────┘   │
           └─────────────────────┘
```

**Desktop Shell** — Electron main process. Thin layer for windowing, native dialogs, notifications, and daemon supervision.

**CLI** — First client delivery track. Proves the typed SDK and IPC contract before the desktop UI ships.

**Local Runtime Daemon** — Machine-local execution authority. Owns provider processes, git worktrees, terminal sessions, tool execution, and local persistence (SQLite).

**Control Plane** — Hosted or self-hosted service for auth (PASETO v4 + WebAuthn), the device directory, device presence (Yjs Awareness CRDT), the E2E-encrypted relay between your devices and your runtime node, and shared metadata (Postgres).

### CLI-First

The CLI (`sidekicks`) is the first client delivery track — it proves the typed SDK and IPC contract before the desktop UI ships.

A short alias `sk` installs alongside it; if an unrelated `sk` is already on your `PATH` (Homebrew ships one), `PATH` order alone decides which runs — check with `which -a sk`, and use `sidekicks` when you need certainty.

<p align="center">
  <img src="assets/hero/cli-terminal-hero.png" alt="AI Sidekicks CLI" width="720" />
</p>

---

## Technology Stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript (daemon, CLI, desktop, contracts) |
| Desktop Shell | Electron |
| Desktop UI | React + Vite |
| Local Database | SQLite (WAL mode, 59 tables) |
| Shared Database | Postgres (25 tables) |
| Auth | PASETO v4 (access + refresh), WebAuthn, DPoP |
| Relay Encryption | X25519 + XChaCha20-Poly1305 (V1), MLS RFC 9420 (V2) |
| State Machines | XState v5 |
| API Framework | tRPC v11 |
| IPC | Unix socket (macOS/Linux), named pipe (Windows) |
| Validation | Zod |
| Authorization | Cedar (policy-based) per [ADR-012](docs/decisions/012-cedar-approval-policy-engine.md) |
| Device Presence | Yjs Awareness protocol |
| Observability | OpenTelemetry |

---

## V1 Scope

V1 ships 21 core features across CLI and Desktop GUI per [ADR-015: V1 Feature Scope Definition](docs/decisions/015-v1-feature-scope-definition.md).

| # | Feature | Description |
| --- | --- | --- |
| 1 | Session creation and join | Foundational session primitive; a linked device joins a session you already own |
| 4 | Runtime node attach | Your own machines contribute local compute |
| 5 | Single-agent runs | Claude and Codex via provider drivers |
| 6 | Queue, steer, pause, resume | Real runtime control and interventions |
| 7 | Approval gates | 9 categories of human-in-the-loop safety |
| 8 | Repo attach | Bind sessions to git repositories |
| 9 | Worktree execution | Isolated branches per agent run |
| 10 | Session timeline | Event-sourced session history, replayable |
| 11 | Local daemon + CLI | First client over the typed SDK |
| 13 | Event audit log | Event-sourced persistence backbone |
| 14 | Artifacts (local + relayed) | Diffs, files, and attachments; an artifact stays fetchable from a linked device while the publishing runtime node is offline via an eager relay pin of E2EE ciphertext, up to the artifact's retention TTL |
| 15 | Desktop GUI | Electron shell + React/Vite renderer over the same typed SDK |
| 16 | Multi-agent channels | Sidekick-to-sidekick coordination primitives per [Spec-016](docs/specs/016-multi-agent-channels-and-orchestration.md) |
| 17 | Workflow authoring and execution | Full workflow engine with a visual node-graph builder, session/project/shared definition scopes, chat-invoked start (the intercepted `/workflow start` command, the composer affordance, and the `workflow_start` callback tool per [ADR-027](docs/decisions/027-chat-invoked-workflow-start.md)), and a park-and-recovery surface — a phase parked on a provider usage limit or a human wait is readable from one run-read and acted on through authorized run-cancel and run-resume operations, the resume carrying the audited definition re-pin — per [Spec-017](docs/specs/017-workflow-authoring-and-execution.md), [ADR-026](docs/decisions/026-visual-node-graph-workflow-authoring.md) |
| 18 | MCP server configuration and governance | Server-config CRUD, operator-managed trusted-server store, status/health probing, server OAuth per [Spec-028](docs/specs/028-mcp-server-configuration-and-governance.md) + [Plan-028](docs/plans/028-mcp-server-configuration-and-governance.md) (landed 2026-07-22 via campaign B18; audit-cleared 2026-08-12 via Plan-028's targeted readiness audit, and promoted `approved` 2026-08-14 by its §Rollout Order step-2 promotion — code dispatches in tier order per Plan-028 §Preconditions) |
| 19 | Session time-travel | Run rollback as a version-guarded intervention + forward `run.rolled_back` event (log never truncates) — governing amendments in-tree (B2 merged via #205, B1 merged via #173; Spec-004 + Spec-006 re-promoted `approved` 2026-07-18 via the W1.5 gate), and durable file restoration needed the B21→B23 turn-snapshot leg gated before Plan-004 Phase 3 (Codex rollback reverts conversation only) — the B23 leg shipped 2026-08-09 via PR #303, so that gate is met and rollback dispatch — Plan-004's Phase-3B explicit-label supplement since the round-1 re-home — rides tier order plus its precondition legs — and the user-visible superseded-turn timeline rendering rides the Spec-013/Plan-013 CP-004-13 consumer leg (flipped `review` 2026-07-20; restored `approved` 2026-08-10 by the Tier-8 plan-readiness audit; built at Plan-013's Tier-8 dispatch) |
| 20 | Session goals | Per-session structured goal with set/clear RPC and goal events — governing amendments in-tree (B6 landed 2026-07-06; B1 merged via #173) — specs re-promoted `approved` 2026-07-18 (W1.5 gate cleared) |
| 21 | Session callback tools | Daemon-registered tools exposed into every run, Cedar-governed — governing amendments in-tree (B3 merged 2026-07-05; B20 merged via #175) — specs re-promoted `approved` 2026-07-18 (W1.5 gate cleared) |
| 22 | Execution postures and sandbox profiles | Per-run sandbox posture as an authorization input, provider-uniform presets — governing amendments in-tree (B20 merged via #175; B3 merged 2026-07-05) — specs re-promoted `approved` 2026-07-18 (W1.5 gate cleared) |
| 23 | Realtime voice channels | Reserved and capability-gated on upstream Codex realtime-flag stabilization — governing amendments in-tree (B6 landed 2026-07-06; B1 merged via #173) — specs re-promoted `approved` 2026-07-18 (W1.5 gate cleared) |
| 24 | Remote Control | Drive any session from any of your linked devices with full parity per [Spec-031](docs/specs/031-remote-control.md) + [Plan-031](docs/plans/031-remote-control.md) |

**V1.1 additions:** MLS relay E2EE, plus the criterion-gated sub-feature commitments named in ADR-015 (workflow BIND channel reuse; `human`-phase default timeout; automated GDPR erasure endpoint; direct-first artifact fetch).

---

## Build Order

Implementation follows the tiered dependency graph defined in `docs/architecture/cross-plan-dependencies.md`. [Plan-001](docs/plans/001-shared-session-core.md) Shared Session Core is `completed`; every other plan is `approved`.

```
Tier 1  ► Plan-001  Shared Session Core
         Plan-024  Rust PTY Sidecar
Tier 3  ► Plan-003  Runtime Node Attach
Tier 4  ► Plan-005  Provider Driver Contract
         Plan-006  Event Taxonomy and Audit Log
         Plan-007  Local IPC and Daemon Control
Tier 5  ► Plan-004  Queue, Steer, Pause, Resume
         Plan-018  Identity and Participant State
         Plan-022  Data Retention and GDPR
Tier 6  ► Plan-009  Repo Attachment and Workspace Binding
         Plan-010  Worktree Lifecycle
         Plan-012  Approvals and Permissions
         Plan-016  Multi-Agent Channels
         Plan-021  Rate Limiting Policy
         Plan-029  Provider Accounts and Credential Homes
Tier 7  ► Plan-011  Git Flow, PR, Diff Attribution
         Plan-014  Artifacts, Files, Attachments
         Plan-015  Persistence, Recovery, Replay
         Plan-028  MCP Server Configuration and Governance
Tier 8  ► Plan-013  Live Timeline and Visibility
         Plan-017  Workflow Authoring and Execution
         Plan-019  Notifications and Attention
         Plan-020  Observability and Failure Recovery
         Plan-023  Desktop Shell and Renderer
Tier 9  ► Plan-026  First-Run Three-Way-Choice Onboarding
Tier 10 ► Plan-031  Remote Control
Tier 11 ► Plan-027  Cross-Node Dispatch and Approval
```

Each tier's prerequisites are the prior tier's completion. See `docs/architecture/cross-plan-dependencies.md` for the forward phase DAG.

---

## Project Status

**Phase:** code execution is under way through Tier 4. Every plan has cleared its implementation-readiness audit, so a plan's code dispatches on tier order and its own `§Preconditions`. [Plan-024](docs/plans/024-rust-pty-sidecar.md) Phases 4-5 (CI cross-compile, signing, and the measurement substrate) are the one hard-blocked lane, waiting on hardware and certificate procurement.

Current documentation corpus:

- **28 V1 implementation plans** with step-by-step build instructions; [Plan-001](docs/plans/001-shared-session-core.md) is `completed` and the other 27 are `approved`
- **29 specifications** covering every feature and cross-cutting concern, all `approved`
- **12 domain models** (run state machine, intervention model, user and device model, workflow model, etc.)
- **15 architecture documents** (schemas, contracts, security, deployment, dependencies)
- **12 operations runbooks** (CLI commands, SLOs, on-call routing, self-host secure defaults)
- **28 accepted ADRs** recording key design decisions (ADR-013 reserved-skipped; no ADR is `proposed`)

---

## Documentation

| Area | Path | Description |
| --- | --- | --- |
| Vision | [`docs/vision.md`](docs/vision.md) | Product thesis and architectural position |
| Specs | [`docs/specs/`](docs/specs/) | Feature specifications (the census above is the authoritative list) |
| Plans | [`docs/plans/`](docs/plans/) | Implementation plans (the census above is the authoritative list) |
| Architecture | [`docs/architecture/`](docs/architecture/) | Schemas, contracts, security, deployment |
| Domain Models | [`docs/domain/`](docs/domain/) | State machines, glossary, entity models |
| ADRs | [`docs/decisions/`](docs/decisions/) | Architectural decision records |
| Operations | [`docs/operations/`](docs/operations/) | Runbooks, SLOs, on-call routing |
| V1 Scope | [`docs/architecture/v1-feature-scope.md`](docs/architecture/v1-feature-scope.md) | What ships in V1 vs V2 |
| Build Order | `docs/architecture/cross-plan-dependencies.md` | Forward phase DAG and dispatch groups |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) | Branch naming, commit format, PR workflow |

---

## License

AI Sidekicks is licensed under the [Apache License, Version 2.0](./LICENSE) — see [ADR-020](docs/decisions/020-v1-deployment-model-and-oss-license.md) for the deployment-model and license commitment.
