# Container Architecture

## Purpose

Define the major runtime containers and the ownership boundary between them.

## Scope

This document covers the deployable or logically isolated containers that make up the product.

## Context

The system is split so that a user's devices can reach a session from anywhere while execution stays on the machine that holds the repo. That split requires explicit containers rather than one monolith that tries to do all work from one trust zone.

## Responsibilities

- keep local execution separate from remote coordination
- keep presentation separate from execution
- keep transport, persistence, and orchestration responsibilities explicit

## Component Boundaries

| Container | Responsibility |
| --- | --- |
| `Desktop Shell` | Windowing, native dialogs, updater flow, daemon supervision, preload bridge. |
| `Desktop Renderer` | Session UI, orchestration UI, diff and artifact views, approvals, linked devices, and workflow authoring. |
| `CLI Client` | Scriptable client surface over the same client SDK and daemon contract. |
| `Local Runtime Daemon` | Session engine, provider drivers, git engine, terminal and tool execution, local persistence, replay, and local policy enforcement. |
| `Control Plane` | Identity, device registry, device and node liveness, relay, notifications, and session metadata. |
| `Local Event Store And Projection Store` | Durable node-local record of run events, receipts, projections, and recovery state. |
| `Shared Metadata Store` | Durable control-plane record of the device registry, liveness history, session directory metadata, and cross-node coordination state. |

## Canonical Implementation Topology

The canonical monorepo layout for implementation is:

| Repo Area | Ownership |
| --- | --- |
| `packages/contracts/` | Shared protocol contracts, schema definitions, and cross-container types. |
| `packages/client-sdk/` | Typed client SDK used by desktop renderer and CLI. |
| `packages/runtime-daemon/` | Local Runtime Daemon implementation and local execution services. |
| `packages/control-plane/` | Control Plane services and device-to-node coordination logic. |
| `apps/desktop/` | Desktop application package. Main process under `src/main/`, preload bridge under `src/preload/`, renderer UI under `src/renderer/` per the electron-vite zero-config convention ([electron-vite Development guide](https://electron-vite.org/guide/dev) — Project Structure conventions for sibling `main` / `preload` / `renderer` directories under `src/`). |
| `apps/cli/` | CLI client implementation over the shared client SDK. |

- Implementation plans may target submodules beneath these roots.
- If the repo shape changes materially, update this architecture doc before treating path-specific plans as canonical.

## Client Delivery Sequence

- `apps/cli/` is the first shipped client path over `packages/client-sdk/` and the typed daemon contract.
- `apps/desktop/` is the second client path and must reuse the same client SDK and daemon semantics rather than introducing a separate local control surface.
- When a daemon capability is new, the contract and CLI path are the canonical proving ground before renderer-specific UX layers are treated as complete.

## Data Flow

1. Renderer and CLI call the client SDK.
2. The client SDK talks to the local daemon for execution state and to the control plane for device registration, session directory reads, and relay connectivity.
3. The local daemon writes to local persistence and emits live updates.
4. The control plane writes to shared metadata and emits device-registry, liveness, relay, and notification updates.
5. Renderers merge the two read surfaces into one session experience.

## Transport Protocols

- The control plane uses tRPC v11 for request-response and SSE subscriptions, plus WebSocket (JSON-RPC 2.0) for bidirectional device channels (device and node liveness). Relay traffic is outside this JSON-RPC subset: relay negotiation rides tRPC request-response and the relay WSS connection speaks binary wire frames — ciphertext envelopes and broker control frames alike. Session-timeline and run-output event streams stay on tRPC SSE (2026-07-02 ADR-009/ADR-014 correction).
- The local daemon uses JSON-RPC 2.0 with LSP-style Content-Length framing over Unix domain socket (named pipe on Windows).

## Trust Boundaries

- `Desktop Renderer` is untrusted compared with `Desktop Shell` and `Local Runtime Daemon`.
- `Local Runtime Daemon` is trusted for local execution only.
- `Control Plane` is trusted for device-to-node coordination but not for code execution on the user's machines.

## Failure Modes

- Renderer remains open while daemon disconnects and must fall back to reconnect or degraded read-only state.
- Control-plane outage leaves execution on the machine available but blocks device linking, liveness updates, and runtime-node discovery from remote devices.
- Local event store corruption prevents replay until recovery tooling repairs or restores it.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)

## Related Specs

- [Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md)
- [Persistence Recovery And Replay](../specs/013-persistence-recovery-and-replay.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)
- [tRPC Control Plane API](../decisions/014-trpc-control-plane-api.md)
