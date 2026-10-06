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
| `Desktop Main Process` | Windowing, native dialogs, updater flow, daemon supervision, preload bridge. |
| `Desktop Renderer` | Session UI, orchestration UI, diff and artifact views, approvals, linked devices, and workflow authoring. |
| `CLI Client` | Scriptable client surface over the same client SDK and daemon contract. |
| `Local Runtime Daemon` | Session engine, provider drivers, git engine, terminal and tool execution, local persistence, rebuild, and local policy enforcement. |
| `Control Plane` | The person's own control plane and relay: identity, the account's statement chain, the device and machine registry, machine registration, the relay between each device and each machine, delivery of push notices each machine has already sealed, and the web client. It keeps no session record. |
| `Local Event Store And Projection Store` | Durable node-local record of run events, receipts, projections, and recovery state. |
| `Shared Metadata Store` | Durable control-plane record of the account, the statement chain, the device registry and each machine's registration. |

## Implementation Topology

The monorepo layout for implementation is:

| Repo Area | Ownership |
| --- | --- |
| `packages/contracts/` | Shared protocol contracts, schema definitions, and cross-container types. |
| `packages/client-sdk/` | Typed client SDK used by the desktop app's main process and the CLI. |
| `packages/runtime-daemon/` | Local Runtime Daemon implementation and local execution services. |
| `packages/control-plane/` | Control Plane services: the statement chain, device linking, machine registration and the relay. |
| `apps/desktop/` | Desktop application package. Main process under `src/main/`, preload bridge under `src/preload/`, desktop-only contracts the three processes share under `src/shared/`, and the renderer under `src/renderer/`, with its code rooted at `src/renderer/src/`, per the electron-vite zero-config convention ([electron-vite Development guide](https://electron-vite.org/guide/dev) — Project Structure conventions for sibling `main` / `preload` / `renderer` directories under `src/`). [Desktop Architecture](./desktop.md) gives the folders inside each. |
| `apps/cli/` | CLI client implementation over the shared client SDK, a workspace [Plan-005](../plans/005-local-ipc-and-daemon-control.md) creates. |

- Implementation plans may target submodules beneath these roots.

## Client Delivery Sequence

- `apps/cli/`, which [Plan-005](../plans/005-local-ipc-and-daemon-control.md) creates, will be the first shipped client path over `packages/client-sdk/` and the typed daemon contract.
- `apps/desktop/` is the second client path and must reuse the same client SDK and daemon semantics rather than introducing a separate local control surface.
- When a daemon capability is new, the contract and CLI path are the canonical proving ground before renderer-specific UX layers are treated as complete.

## Data Flow

1. The CLI and the desktop app's main process call the client SDK; the desktop renderer calls through the preload bridge, which the main process answers.
2. The client SDK talks to the local daemon for execution state. The control plane is reached for sign-in, device linking, the statement chain and the relay.
3. The local daemon writes to local persistence and emits live updates.
4. The control plane writes to shared metadata and relays each device's channel to each machine; push notices reach it already sealed by the machine.
5. Renderers draw the sessions and their screens from the daemon of the machine in view: through the main process and local IPC on that machine, and over the device's channel from anywhere else.

## Transport Protocols

- The control plane uses tRPC v11 for request-response and SSE subscriptions: sign-in, token refresh, device linking, the statement chain, a machine's registration and sealed push notices. The relay's WSS connection speaks binary wire frames, each belonging to one Noise channel between one device and one machine; inside that channel the device drives the machine through its method proxy. The relay reads no method and no byte of a session, so session transcripts and run output travel only inside those channels ([ADR-009](../decisions/009-json-rpc-ipc-wire-format.md), [ADR-013](../decisions/013-trpc-control-plane-api.md)).
- The local daemon uses JSON-RPC 2.0 with LSP-style Content-Length framing over Unix domain socket (named pipe on Windows).

## Trust Boundaries

- `Desktop Renderer` is untrusted compared with `Desktop Main Process` and `Local Runtime Daemon`.
- `Local Runtime Daemon` is trusted for local execution only.
- `Control Plane` is trusted to keep the statement chain available and to relay frames, but not to decide which keys are trusted, which every machine checks against the chain itself, and not for code execution on the user's machines.

## Failure Modes

- Renderer remains open while the daemon disconnects; the working line says so once, with `Retry`, while the main process reconnects, and nothing else changes. Only a daemon outside the app's version range makes the renderer read-only.
- Control-plane outage leaves execution on the machine available but blocks device linking and every remote device's reach to the machine.
- Local event store corruption prevents rebuild until recovery tooling repairs or restores it.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)

## Related Specs

- [Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md)
- [Persistence And Recovery](../specs/013-persistence-and-recovery.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)
- [tRPC Control Plane API](../decisions/013-trpc-control-plane-api.md)
