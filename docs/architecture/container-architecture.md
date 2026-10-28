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
| `Desktop Main Process` | Windowing, native dialogs, updater flow, daemon supervision, preload bridge, and the client helper process it starts, which holds the daemon connection. |
| `Desktop Renderer` | Session UI, orchestration UI, diff and artifact views, approvals, linked devices, and workflow authoring. |
| `CLI Client` | Scriptable client surface over the same daemon client (`sidekicks-client`) and daemon contract. |
| `Local Runtime Daemon` | Session engine, provider drivers, git engine, terminal and tool execution, local persistence, rebuild, and local policy enforcement. |
| `Control Plane` | The person's own control plane and relay: identity, the account's statement chain, the device and machine registry, machine registration, the relay between each device and each machine, delivery of push notices each machine has already sealed, and the web client. It keeps no session record. |
| `Local Event Store And Projection Store` | Durable machine-local record of run events, receipts, projections, and recovery state. |
| `Hosted Account Store` | Durable control-plane record of the account, the statement chain, the device registry and each machine's registration, in SQLite inside the relay: the account object's own Durable Object storage on the Workers relay, a SQLite file on the Compose relay ([Deployment Topology §Account Storage](./deployment-topology.md#account-storage)). |

## Implementation Topology

The monorepo layout for implementation is:

| Repo Area | Ownership |
| --- | --- |
| `crates/sidekicks-contracts/` | Shared protocol contracts: the Rust types (serde shapes, garde checks) every cross-container type comes from, the method table and the frame codec. |
| `packages/contracts/` | The TypeScript types and Ajv validators generated from `crates/sidekicks-contracts`, committed and never edited, beside the hand-written pieces a schema cannot carry. |
| `crates/sidekicks-client/` | The typed daemon client the CLI links and the desktop loads through its addon crate, `crates/sidekicks-client-addon/`, whose Node-API package is `packages/client-sdk/`, in the client helper process. |
| `crates/sidekicks-daemon/` | The Local Runtime Daemon's program over its library crates: the start, the IPC handlers, orchestration, Remote Control and observability. |
| `crates/`, the daemon's library crates (`sidekicks-std` up to `sidekicks-recovery`) | The Local Runtime Daemon's execution services, one crate per concern beneath the program, from shared primitives and the store up through providers, sessions, approvals, the run queue and recovery; [crates/AGENTS.md](../../crates/AGENTS.md) gives their order. |
| `crates/sidekicks-control-plane/` | Control Plane services: the statement chain, device linking, machine registration and the relay. |
| `apps/desktop/` | Desktop application package. Main process under `src/main/`, preload bridge under `src/preload/`, desktop-only contracts the three processes share under `src/shared/`, and the renderer under `src/renderer/`, with its code rooted at `src/renderer/src/`, per the electron-vite zero-config convention ([electron-vite Development guide](https://electron-vite.org/guide/dev) — Project Structure conventions for sibling `main` / `preload` / `renderer` directories under `src/`). [Desktop Architecture](./desktop.md) gives the folders inside each. |
| `crates/sidekicks-cli/` | CLI client implementation over `crates/sidekicks-client/`, a crate [Plan-005](../plans/005-local-ipc-and-daemon-control.md) creates, whose program is `sidekicks`. |

- Implementation plans may target submodules beneath these roots.

## Client Delivery Sequence

- `crates/sidekicks-cli/`, which [Plan-005](../plans/005-local-ipc-and-daemon-control.md) creates, will be the first shipped client path over `crates/sidekicks-client/` and the typed daemon contract.
- `apps/desktop/` is the second client path and must reuse the same daemon client, through `packages/client-sdk/`, and daemon semantics rather than introducing a separate local control surface.
- When a daemon capability is new, the contract and CLI path are the canonical proving ground before renderer-specific UX layers are treated as complete.

## Data Flow

1. The CLI and the desktop app's client helper call the daemon client. The renderer's daemon and control-plane calls travel over a `MessagePort` that main hands the page through the preload, to the client helper, which checks each against its method allowlist and params check, carries it on its own daemon connection, whose `connection.initialize` presented the session token or, on macOS, was admitted by the helper's code signature, and returns only the sanitized reply. Main's own daemon calls reach the helper over `parentPort`, through the same allowlist, and main keeps the file tokens. Neither main nor the renderer holds the session token, and the renderer is not a daemon client.
2. The daemon client talks to the local daemon for execution state. The control plane is reached for sign-in, device linking, the statement chain and the relay.
3. The local daemon writes to local persistence and emits live updates.
4. The control plane writes to shared metadata and relays each device's channel to each machine wherever the channel does not go straight across the network; push notices reach it already sealed by the machine.
5. Renderers draw the sessions and their screens from the daemon of the machine in view: through the client helper's port and local IPC on that machine, and over the device's channel from anywhere else.

## Transport Protocols

- The control plane serves HTTP routes on `axum` on `worker`, one POST per procedure with a JSON body and a refusal answered `{code, category, message}`, and its own streams as Server-Sent Events: sign-in, token refresh, device linking, the statement chain, a machine's registration and sealed push notices. The relay's WSS connection carries sealed Noise messages, each belonging to one Noise channel between one device and one machine and holding frames of the one frame codec; inside that channel the device drives the machine through its method proxy. Wherever the device and the machine can reach each other, a WebRTC data channel straight between them carries the same sealed messages, set up inside the channel itself, `str0m` on the machine and `RTCPeerConnection` on a page. Neither the relay nor the networks under the direct path read a method or a byte of a session, so session transcripts and run output travel only inside those channels ([ADR-009](../decisions/009-json-rpc-ipc-wire-format.md), [ADR-013](../decisions/013-control-plane-api.md)).
- The local daemon uses JSON-RPC 2.0 messages in one frame codec with a 10-byte header, the same on the local socket and inside each Noise message, carrying binary attachments beside the JSON, over a Unix domain socket (named pipe on Windows).

## Trust Boundaries

- `Desktop Renderer` is untrusted compared with `Desktop Main Process` and `Local Runtime Daemon`.
- `Local Runtime Daemon` is trusted for local execution only.
- `Control Plane` is trusted to keep the statement chain available and to relay frames, but not to decide which keys are trusted, which every machine checks against the chain itself, and not for code execution on the user's machines.

## Failure Modes

- Renderer remains open while the daemon disconnects; the working line says so once, with `Retry`, while the client helper reconnects, and nothing else changes. Only a daemon outside the app's version range makes the renderer read-only.
- Control-plane outage leaves execution on the machine available but blocks device linking and every new remote connection to the machine; a channel already on a direct path keeps working.
- Local event store corruption prevents rebuild until recovery tooling repairs or restores it.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Machine Model](../domain/machine-model.md)
- [Repo Workspace Worktree Model](../domain/repo-workspace-worktree-model.md)

## Related Specs

- [Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md)
- [Persistence And Recovery](../specs/013-persistence-and-recovery.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [SQLite Local State And Hosted Account](../decisions/004-sqlite-local-state-and-hosted-account.md)
- [Control Plane API](../decisions/013-control-plane-api.md)
