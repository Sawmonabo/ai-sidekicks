# Spec-007: Local IPC And Daemon Control

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `007` |
| **Slug** | `local-ipc-and-daemon-control` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md), [Runtime Node Model](../domain/runtime-node-model.md) |
| **Implementation Plan** | `TBD` |

## Purpose

Define the typed local control surface used by the desktop renderer and CLI to communicate with the local daemon.

## Scope

This spec covers transport choice, version negotiation, request and stream semantics, and daemon supervision controls.

## Non-Goals

- Remote relay transport
- Provider-driver internal protocols
- UI rendering behavior

## Domain Dependencies

- [Runtime Node Model](../domain/runtime-node-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)

## Required Behavior

- The desktop renderer and CLI must use one shared typed client SDK.
- The local daemon must expose a typed request-response and subscription contract for session, run, repo, artifact, settings, and daemon lifecycle operations.
- The default local IPC transport must be OS-local:
  - Unix domain socket on Unix-like platforms
  - named pipe on Windows
- The system may expose a loopback fallback transport only when OS-local transport is unavailable or a non-desktop client requires it.
- Local IPC must support protocol version negotiation before mutating operations are accepted.
- The desktop shell must be able to start, stop, supervise, and reconnect to the daemon.

## Default Behavior

- Desktop app default is auto-connect to the local daemon through OS-local IPC.
- If the daemon is not running, the desktop shell may auto-start it before the renderer gives up.
- CLI default is connect to the same typed local daemon contract rather than reimplement daemon logic inline.

## Fallback Behavior

- If OS-local transport is unavailable, the client SDK may fall back to loopback transport with explicit authentication and version checks.
- If version negotiation fails, read-only compatibility may continue, but mutating operations must be blocked until versions are compatible.
- If the daemon cannot be started automatically, the client must return actionable status instead of hanging.

## Interfaces And Contracts

- `DaemonHello` and `DaemonHelloAck` must perform version negotiation.
- `DaemonStatusRead`, `DaemonStart`, `DaemonStop`, and `DaemonRestart` must exist for supervised environments.
- `LocalSubscription` must support replay-capable event streams where appropriate.
- The typed client SDK must expose the same semantic surface to renderer and CLI callers.

## State And Data Implications

- Client cache must not become the daemon's state store.
- Daemon supervision state may be shell-local, but daemon runtime truth remains in daemon-owned persistence and projections.
- Version compatibility decisions must be visible to clients and logs.

## Example Flows

- `Example: The desktop renderer starts while the daemon is not running. The shell launches the daemon, negotiates protocol version, and then the renderer attaches through the typed client SDK.`
- `Example: The CLI requests a run-state subscription through the same client SDK and receives canonical updates without duplicating daemon logic.`

## Implementation Notes

- Keep IPC semantics typed and narrow. Avoid renderer-driven arbitrary shell escape hatches.
- Local IPC choice is a security boundary, not merely a performance choice.
- Loopback fallback must be visibly second-class compared with OS-local transport.

## Pitfalls To Avoid

- Giving renderer code direct untyped native execution access
- Allowing silent version skew for mutating operations
- Reimplementing daemon state transitions in the CLI

## Acceptance Criteria

- [ ] Renderer and CLI share one typed daemon client surface.
- [ ] The daemon can be started, pinged, and subscribed to through local IPC.
- [ ] Version mismatch blocks unsafe mutation while keeping status visibility available.

## ADR Triggers

- If the system chooses a different default local transport boundary, create or update `../decisions/008-default-transports-and-relay-boundaries.md`.

## Open Questions

- Whether browser-only clients are supported through loopback transport in the first release or desktop and CLI remain the only first-class local clients.

## References

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Desktop App](../architecture/component-architecture-desktop-app.md)
