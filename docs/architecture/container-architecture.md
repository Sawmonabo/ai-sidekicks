# Container Architecture

## Purpose

Define the major runtime containers and the ownership boundary between them.

## Scope

This document covers the deployable or logically isolated containers that make up the product.

## Context

The system is split so that collaboration can be shared while execution remains local. That split requires explicit containers rather than one monolith that tries to do all work from one trust zone.

## Responsibilities

- keep local execution separate from shared coordination
- keep presentation separate from execution
- keep transport, persistence, and orchestration responsibilities explicit

## Component Boundaries

| Container | Responsibility |
| --- | --- |
| `Desktop Shell` | Windowing, native dialogs, updater flow, daemon supervision, preload bridge. |
| `Desktop Renderer` | Session UI, orchestration UI, diff and artifact views, approvals, invite flows, and workflow authoring. |
| `CLI Client` | Scriptable client surface over the same client SDK and daemon contract. |
| `Local Runtime Daemon` | Session engine, provider drivers, git engine, terminal and tool execution, local persistence, replay, and local policy enforcement. |
| `Collaboration Control Plane` | Identity, invite, membership, presence, relay, notifications, and shared session metadata. |
| `Local Event Store And Projection Store` | Durable node-local record of run events, receipts, projections, and recovery state. |
| `Shared Metadata Store` | Durable shared record of memberships, invites, presence history, session directory metadata, and cross-node coordination state. |

## Canonical Implementation Topology

The canonical monorepo layout for implementation is:

| Repo Area | Ownership |
| --- | --- |
| `packages/contracts/` | Shared protocol contracts, schema definitions, and cross-container types. |
| `packages/client-sdk/` | Typed client SDK used by desktop renderer and CLI. |
| `packages/runtime-daemon/` | Local Runtime Daemon implementation and local execution services. |
| `packages/control-plane/` | Collaboration Control Plane services and shared-session coordination logic. |
| `apps/desktop/shell/` | Desktop shell or Electron main-process code. |
| `apps/desktop/renderer/` | Desktop renderer UI and session-facing application surfaces. |
| `apps/cli/` | CLI client implementation over the shared client SDK. |

- Implementation plans may target submodules beneath these roots.
- If the repo shape changes materially, update this architecture doc before treating path-specific plans as canonical.

## Client Delivery Sequence

- `apps/cli/` is the first shipped client path over `packages/client-sdk/` and the typed daemon contract.
- `apps/desktop/shell/` and `apps/desktop/renderer/` are the second client path and must reuse the same client SDK and daemon semantics rather than introducing a separate local control surface.
- When a daemon capability is new, the contract and CLI path are the canonical proving ground before renderer-specific UX layers are treated as complete.

## Data Flow

1. Renderer and CLI call the client SDK.
2. The client SDK talks to the local daemon for execution state and to the control plane for shared coordination state.
3. The local daemon writes to local persistence and emits live updates.
4. The control plane writes to shared metadata and emits membership, invite, relay, and notification updates.
5. Renderers merge the two read surfaces into one session experience.

## Trust Boundaries

- `Desktop Renderer` is untrusted compared with `Desktop Shell` and `Local Runtime Daemon`.
- `Local Runtime Daemon` is trusted for local execution only.
- `Collaboration Control Plane` is trusted for shared coordination but not for code execution on participant machines.

## Failure Modes

- Renderer remains open while daemon disconnects and must fall back to reconnect or degraded read-only state.
- Control-plane outage leaves local execution available but blocks new invites, shared presence updates, or runtime-node discovery across participants.
- Local event store corruption prevents replay until recovery tooling repairs or restores it.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)

## Related Specs

- [Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)
