# AI Sidekicks

```text
      o
     .-.
  .--┴-┴--.
  | O   O |   >> An agentic coding runtime for you and your sidekicks.
  | ||||| |   >> Your accounts, any device.
  '--___--'
```

AI Sidekicks is an agentic coding desktop runtime: you and your AI sidekicks (Claude Code, Codex) build software in live sessions — steerable agents, agents that delegate to other agents, approval-gated dispatch, git-worktree flow, and Remote Control from any of your linked devices. Every agent works under your own provider account. A sidekick is what the app calls an agent on screen; the code and the docs say agent.

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
- Have one sidekick hand work to another
- Pause an agent mid-run, steer its direction, then resume — without losing state
- Get real approval gates before agents install packages, run migrations, or push code
- Walk away from the desk and pick the same run back up on another device

AI Sidekicks exists to solve these problems. It treats **the session** — not the agent — as the first-class primitive, and builds orchestration, approvals, and git flow into the runtime from day one.

---

## Core Concept

The first-class object is not `agent`. It is **`session`**.

A session contains the user, agents, runs, repo mounts, approvals, artifacts, and an event log. "Two agents talking," "one user chatting with one agent," and "workflow orchestration" are all different views over the same session and event model.

```text
                    ┌──────────────────────────────────┐
                    │           SESSION                │
                    │                                  │
                    │   User         ←  You            │
                    │   Agents       ←  Claude, Codex  │
                    │   Runs         ←  Active work    │
                    │   Repo Mounts  ←  Git repos      │
                    │   Approvals    ←  Safety gates   │
                    │   Artifacts    ←  Diffs, files   │
                    │   Events       ←  Audit log      │
                    │                                  │
                    └──────────────────────────────────┘
```

You open a session from any linked device and chat directly in it. A session has one main agent; other agents take part when the main agent delegates to them or when you name one in the composer. The work itself executes on a runtime node — a machine of yours that holds the repo and runs the provider processes.

---

## Key Features

### Multi-Agent Sessions

Start a session and let as many sidekicks take part as the work needs — Claude and Codex together, each on your own provider account, with credentials that never leave the machine. Sidekicks hand work to each other, and run under one set of approval policies. Session content — messages, events, artifacts — is end-to-end encrypted in transit between your devices and your runtime node: the relay never sees plaintext.

### Queue, Steer, Pause, Resume

Real runtime control — not UI illusions. The queue is daemon-backed. Steer is modeled as an intervention against an active run. Pause is a runtime state with persisted context. Resume continues from where the agent left off.

### Approval Gates

7 categories of approval gates (tool execution, file write, network access, destructive git, plan approval, workflow gate, and human step contribution) ensure agents never take unsupervised action on anything that matters. Approve, deny, or make a rule the provider keeps.

### Worktree-First Git Flow

A session in a project works in one of two places: a worktree of its own, or the checkout the project already has. The default is **a new worktree** — agents work on an isolated branch, produce attributed diffs, and prepare PRs without touching your main checkout. How much a session may change is its permission level, not the place it works.

### Visibility and Replay

Every message, tool call, approval, diff, and state transition is recorded as it happens. Any session replays from its event log.

### Provider Drivers

AI agents run behind explicit driver adapters — `claude-driver` and `codex-driver` ship in V1. The product is not a wrapper around a single provider CLI; it's a runtime that normalizes agent behavior across providers.

### Remote Control

Any device you have linked drives the same session with full parity — read the run, steer it, answer an approval — while the work keeps running where it started. The control plane handles auth, your device directory, and the encrypted relay; it never executes code. A session on the machine that owns it works offline.

---

## Architecture

```text
┌──────────────────┐     ┌──────────────────┐
│   Desktop App    │     │       CLI        │
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

**Desktop App** — Electron. Its main process is a thin layer for windowing, native dialogs, notifications, and daemon supervision; the React renderer draws every screen over the same typed SDK.

**CLI** — First client delivery track. Proves the typed SDK and IPC contract before the desktop UI ships.

**Local Runtime Daemon** — Machine-local execution authority. Owns provider processes, git worktrees, terminal sessions, tool execution, and local persistence (SQLite).

**Control Plane** — Hosted or self-hosted service for auth (PASETO v4 + WebAuthn), the device directory, device presence (Yjs Awareness CRDT), the E2E-encrypted relay between your devices and your runtime node, and shared metadata (Postgres).

### CLI-First

The CLI (`sidekicks`) is the first client delivery track — it proves the typed SDK and IPC contract before the desktop UI ships.

A short alias `sk` installs alongside it; if an unrelated `sk` is already on your `PATH` (Homebrew ships one), `PATH` order alone decides which runs — check with `which -a sk`, and use `sidekicks` when you need certainty.

---

## Technology Stack

| Layer | Technology |
| --- | --- |
| Language | TypeScript (daemon, CLI, desktop, contracts) |
| Desktop App | Electron |
| Desktop UI | React + Vite |
| Local Database | SQLite (WAL mode) |
| Shared Database | Postgres |
| Auth | PASETO v4 (access + refresh), WebAuthn, DPoP |
| Relay Encryption | Noise `Noise_KK_25519_ChaChaPoly_SHA256`, one channel per device and machine |
| State Machines | XState v5 |
| API Framework | tRPC v11 |
| IPC | Unix socket (macOS/Linux), named pipe (Windows) |
| Validation | Zod |
| Authorization | Cedar (policy-based) per [ADR-012](docs/decisions/012-cedar-approval-policy-engine.md) |
| Device Presence | Yjs Awareness protocol |
| Observability | OpenTelemetry |

---

## V1 Scope

V1 ships 21 core features across CLI and Desktop GUI per [ADR-014: V1 Feature Scope Definition](docs/decisions/014-v1-feature-scope-definition.md).

| # | Feature | Description |
| --- | --- | --- |
| 1 | Session creation | Foundational session primitive; any of your linked devices can drive a session you own |
| 2 | Machine registration | The machine that runs your sessions registers once with the control plane and is reached through the relay |
| 3 | Single-agent runs | Claude and Codex via provider drivers |
| 4 | Queue, steer, pause, resume | Real runtime control and interventions |
| 5 | Approval gates | 7 categories of human-in-the-loop safety |
| 6 | Repo attach | Bind sessions to git repositories |
| 7 | Worktree execution | Isolated branches per agent run |
| 8 | Session transcript | Event-sourced session history, replayable |
| 9 | Local daemon + CLI | First client over the typed SDK |
| 10 | Event audit log | Event-sourced persistence backbone |
| 11 | Artifacts | Diffs, files, and attachments; a session's artifacts stay on the machine that runs it, and every linked device reads them through Remote Control |
| 12 | Desktop GUI | Electron main process + React/Vite renderer over the same typed SDK |
| 13 | Multi-agent orchestration | A session's lead agent runs helper agents as child runs inside the session; agents coordinate through run linkage, the session transcript, artifact references and approvals, per [Spec-014](docs/specs/014-multi-agent-orchestration.md) |
| 14 | Workflow authoring and execution | Full workflow engine with a visual node-graph builder, session/project/shared definition scopes, chat-invoked start (the `/workflow` command root, whose verbs the `/` list shows and completes, and the agent's `workflow_*` tools, `workflow_run` among them, per [ADR-025](docs/decisions/025-chat-invoked-workflow-start.md)), and a park-and-recovery surface — a phase parked on a provider usage limit or a human wait is readable from one run-read and acted on through authorized run-cancel and run-resume operations, the resume carrying the audited definition re-pin — per [Spec-015](docs/specs/015-workflow-authoring-and-execution.md), [ADR-024](docs/decisions/024-visual-node-graph-workflow-authoring.md) |
| 15 | MCP server configuration and governance | Server-config CRUD, status/health probing, server OAuth per [Spec-024](docs/specs/024-mcp-server-configuration-and-governance.md) + [Plan-022](docs/plans/022-mcp-server-configuration-and-governance.md) |
| 16 | Undo to an earlier message | Put back the conversation and the files, the conversation alone, or the files alone, as one request with one reported result; the conversation goes back through the provider's own cut and the files through the daemon's checkpoints, and every undo is recorded forward, so the log never truncates |
| 17 | Session goals | `/goal` gives one agent a condition to work toward until it is met, cleared or stopped unmet; a session is never named by its goal |
| 18 | Session callback tools | Daemon-registered tools exposed into every run, Cedar-governed |
| 19 | Execution postures and sandbox profiles | Per-run sandbox posture as an authorization input, provider-uniform presets |
| 20 | Voice (`/voice`) | Dictation into the composer on a Claude Code session; Codex's own realtime voice call on a Codex session |
| 21 | Remote Control | Drive any session from any of your linked devices with full parity per [Spec-027](docs/specs/027-remote-control.md) + [Plan-025](docs/plans/025-remote-control.md) |

---

## Build Order

Phases still to build, and the order between them, live in [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md). What has shipped is `git log --oneline --grep 'Plan-'`.

---

## Project Status

Code execution is under way. What is left to build, and the order between the pieces, is [`docs/architecture/cross-plan-dependencies.md`](docs/architecture/cross-plan-dependencies.md). [Plan-021](docs/plans/021-rust-pty-sidecar.md) Phases 4-5 wait on hardware and certificate procurement.

---

## Documentation

| Area | Path | Description |
| --- | --- | --- |
| Vision | [`docs/vision.md`](docs/vision.md) | Product thesis and architectural position |
| Specs | [`docs/specs/`](docs/specs/) | Feature specifications |
| Plans | [`docs/plans/`](docs/plans/) | Implementation plans |
| Architecture | [`docs/architecture/`](docs/architecture/) | Schemas, contracts, security, deployment |
| Domain Models | [`docs/domain/`](docs/domain/) | State machines, glossary, entity models |
| ADRs | [`docs/decisions/`](docs/decisions/) | Architectural decision records |
| Operations | [`docs/operations/`](docs/operations/) | Runbooks, SLOs, on-call routing |
| V1 Scope | [`docs/architecture/v1-feature-scope.md`](docs/architecture/v1-feature-scope.md) | What V1 ships and what is out of scope |
| Build Order | `docs/architecture/cross-plan-dependencies.md` | The unit order: what is left to build and what each unit waits on |
| Contributing | [`CONTRIBUTING.md`](CONTRIBUTING.md) | Branch naming, commit format, PR workflow |

---

## License

AI Sidekicks is licensed under the [Apache License, Version 2.0](./LICENSE) — see [ADR-019](docs/decisions/019-v1-deployment-model-and-oss-license.md) for the deployment-model and license commitment.
