# ADR-008: Default Transports And Relay Boundaries

| Field         | Value                    |
| ------------- | ------------------------ |
| **Status**    | `accepted`               |
| **Type**      | `Type 1 (two-way door)`  |
| **Domain**    | `Transport Architecture` |
| **Date**      | `2026-04-14`             |
| **Author(s)** | `Codex`                  |
| **Reviewers** | `Accepted 2026-04-15`    |

## Context

The system needs one default local client-to-daemon transport and one coherent position on when relay is used to reach a session from another of the user's devices.

## Problem Statement

What should be the default local transport boundary, and how should relay fit into remote access?

### Trigger

The IPC and control-plane specs require a concrete transport stance before implementation plans and operations docs can be written.

## Decision

We will use OS-local IPC for client-to-daemon communication on the machine itself. Every other device reaches the machine over its own sealed channel through the person's own relay: one Noise channel per device and machine, which carries every method the local transport serves and every event stream, while the relay sees only ids, the channel profile, frame sizes and times. The control plane's authenticated network transport serves its own work only: sign-in, the account's statement chain, device linking, machine registration, and the push notices each machine has already sealed. The relay is never an execution path.

## Alternatives Considered

### Option A: OS-Local IPC + Relay For Every Other Device (Chosen)

- **What:** Use local sockets or pipes on the machine itself, a sealed channel through the person's own relay for every other device, and network control-plane APIs for account and registration work.
- **Steel man:** Best aligns transport choice with trust boundary and deployment shape.
- **Weaknesses:** Requires multiple transport implementations and clear fallback behavior.

### Option B: Loopback Network For All Local And Remote Paths (Rejected)

- **What:** Use loopback HTTP or WebSocket even for local client-daemon traffic.
- **Steel man:** Simpler transport stack and easier browser compatibility.
- **Why rejected:** Weaker local boundary and poorer fit for desktop-supervised daemon control.

### Option C: Relay Only As A Fallback (Rejected)

- **What:** Reach the machine directly where the network allows, and use the relay only when topology requires it.
- **Steel man:** No relay hop when the device and the machine can reach each other directly.
- **Why rejected:** The machine keeps one outbound connection to the relay, so it needs no address a device can reach, and reachability and the one-connection-per-key rule are both read in one place. A second, direct path would be a second place to secure and a second reachability fact, while the channel's end-to-end sealing already keeps the relay from reading any session.

## Reversibility Assessment

- **Reversal cost:** Moderate. Transport clients, daemon endpoints, and operations guidance would need revision.
- **Blast radius:** Desktop main process, CLI, daemon startup, relay flows, and security assumptions.
- **Migration path:** Add new transports in parallel, migrate client SDK defaults, then retire old defaults.
- **Point of no return:** After the client SDK, daemon supervisor, and operations docs all assume the chosen default transports.

## Consequences

### Positive

- Stronger local security posture for daemon control
- Clearer distinction between local execution transport and remote-access transport

### Negative (accepted trade-offs)

- More transport code paths to test
- Browser-only local clients are less natural than with loopback-first design

### Unknowns

- None. Every device other than the machine itself reaches it through the relay.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `specs/006-local-ipc-and-daemon-control.md` | Canonical spec | Local daemon control should default to OS-local IPC | [specs/006-local-ipc-and-daemon-control.md](../specs/006-local-ipc-and-daemon-control.md) |
| `architecture/security-architecture.md` | Canonical architecture doc | The relay path is treated as less trusted than direct local transport | [architecture/security-architecture.md](../architecture/security-architecture.md) |

### Related Domain Docs

- [User And Device Model](../domain/user-and-device-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)

### Related Architecture Docs

- [Daemon Architecture](../architecture/daemon.md)
- [Control Plane Architecture](../architecture/control-plane.md)
- [Deployment Topology](../architecture/deployment-topology.md)

### Related Specs

- [Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md)
- [Hosted Account And Identity](../specs/016-hosted-account-and-identity.md)
- [Remote Control](../specs/027-remote-control.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [Device Trust and Permission Model](./007-device-trust-and-permission-model.md)
