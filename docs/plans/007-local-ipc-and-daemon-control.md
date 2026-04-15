# Plan-007: Local IPC And Daemon Control

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `007` |
| **Slug** | `local-ipc-and-daemon-control` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-007: Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md) |
| **Required ADRs** | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md) |

## Goal

Implement the typed local daemon control surface shared by the desktop renderer and CLI, including daemon supervision and protocol negotiation.

## Scope

This plan covers OS-local IPC transport, version negotiation, daemon lifecycle commands, shared client SDK implementation, and the first-class CLI delivery path.

## Non-Goals

- Relay or remote transport
- Provider-driver internal transports
- Browser-only local client support

## Preconditions

- [x] Paired spec is approved
- [ ] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/daemon/`
- `packages/client-sdk/src/daemonClient.ts`
- `packages/runtime-daemon/src/ipc/local-ipc-gateway.ts`
- `packages/runtime-daemon/src/ipc/protocol-negotiation.ts`
- `apps/desktop/shell/src/daemon-supervision/`
- `apps/desktop/renderer/src/daemon-status/`
- `apps/cli/src/`

## Data And Storage Changes

- Persist daemon version-compatibility diagnostics and reconnect metadata only where needed for actionable client status.
- No new shared control-plane storage is required for the local IPC contract itself.

## API And Transport Changes

- Add `DaemonHello`, `DaemonHelloAck`, `DaemonStatusRead`, `DaemonStart`, `DaemonStop`, `DaemonRestart`, and shared subscription primitives to the typed client SDK.
- Implement OS-local socket or pipe transport as the default client path, with explicit loopback fallback hooks.

## CLI Delivery Track

- The first shipped client for the typed daemon contract is `apps/cli/`.
- CLI delivery must cover daemon handshake, lifecycle status, session read or create or join, and run-state subscription over the shared client SDK.
- Desktop shell supervision and renderer status surfaces follow on the same stabilized daemon contract rather than defining a second local client path.

## Implementation Steps

1. Define daemon handshake, lifecycle, and subscription contracts in shared packages.
2. Implement OS-local IPC gateway and protocol-version negotiation in the Local Runtime Daemon.
3. Implement the CLI on top of the same client SDK and daemon contract rather than embedding daemon logic directly.
4. Implement desktop-shell daemon supervision and actionable startup or reconnect status surfaces on the same stabilized contract.

## Parallelization Notes

- IPC contract work and shell supervision scaffolding can proceed in parallel once handshake semantics are fixed.
- CLI work can begin as soon as the shared client SDK contract is stable and should finish before renderer-specific daemon control surfaces.

## Test And Verification Plan

- Handshake and version-negotiation compatibility tests
- Transport tests for Unix socket, named pipe, and gated loopback fallback behavior
- Manual verification that desktop renderer and CLI reach the same daemon semantics through the same typed SDK

## Rollout Order

1. Land shared daemon contracts and SDK surface
2. Ship the first CLI against the same local daemon contract
3. Enable desktop-shell supervision and daemon status reads

## Rollback Or Fallback

- Disable auto-start and loopback fallback features while preserving typed status reads if transport rollout regresses.

## Risks And Blockers

- Browser-only client support remains unresolved and may pressure the transport boundary too early
- Version-skew handling must preserve safe read access without opening unsafe mutation paths
- CLI coverage can become nominal instead of canonical if new daemon features are allowed to ship renderer-first

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
