# ADR-008: Default Transports And Relay Boundaries

| Field | Value |
| -------------- | ------------------------------------------------------------------------ |
| **Status** | `proposed` |
| **Type** | `Type 1 (two-way door)` |
| **Domain** | `Transport Architecture` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Reviewers** | `Pending assignment` |

## Context

The system needs one default local client-to-daemon transport and one coherent position on when relay is used for shared sessions.

## Problem Statement

What should be the default local transport boundary, and how should relay fit into remote collaboration?

### Trigger

The IPC and control-plane specs require a concrete transport stance before implementation plans and operations docs can be written.

## Decision

We will default to OS-local IPC for client-to-daemon communication, use authenticated network control-plane transport for shared coordination, and treat relay as a secondary connectivity mechanism rather than as the default execution path.

## Alternatives Considered

### Option A: OS-Local IPC + Control Plane + Secondary Relay (Chosen)

- **What:** Use local sockets or pipes by default, network control-plane APIs for shared metadata, and relay only when topology requires it.
- **Steel man:** Best aligns transport choice with trust boundary and deployment shape.
- **Weaknesses:** Requires multiple transport implementations and clear fallback behavior.

### Option B: Loopback Network For All Local And Remote Paths (Rejected)

- **What:** Use loopback HTTP or WebSocket even for local client-daemon traffic.
- **Steel man:** Simpler transport stack and easier browser compatibility.
- **Why rejected:** Weaker local boundary and poorer fit for desktop-supervised daemon control.

### Option C: Relay-First Shared Connectivity (Rejected)

- **What:** Route most collaborative connectivity through relay by default.
- **Steel man:** Consistent connectivity story across many networks.
- **Why rejected:** Overuses relay and blurs the boundary between normal control-plane coordination and remote fallback connectivity.

## Reversibility Assessment

- **Reversal cost:** Moderate. Transport clients, daemon endpoints, and operations guidance would need revision.
- **Blast radius:** Desktop shell, CLI, daemon startup, relay flows, and security assumptions.
- **Migration path:** Add new transports in parallel, migrate client SDK defaults, then retire old defaults.
- **Point of no return:** After the client SDK, daemon supervisor, and operations docs all assume the chosen default transports.

## Consequences

### Positive

- Stronger local security posture for daemon control
- Clearer distinction between local execution transport and remote collaboration transport

### Negative (accepted trade-offs)

- More transport code paths to test
- Browser-only local clients are less natural than with loopback-first design

### Unknowns

- How often relay will be necessary in typical collaborative deployments

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
|--------|------|-------------|--------------|
| `specs/007-local-ipc-and-daemon-control.md` | Canonical spec | Local daemon control should default to OS-local IPC | [specs/007-local-ipc-and-daemon-control.md](../specs/007-local-ipc-and-daemon-control.md) |
| `specs/008-control-plane-relay-and-session-join.md` | Canonical spec | Session join and relay are separate concerns, and relay is a shared-session connectivity aid rather than execution authority | [specs/008-control-plane-relay-and-session-join.md](../specs/008-control-plane-relay-and-session-join.md) |
| `architecture/security-architecture.md` | Canonical architecture doc | The relay path is treated as less trusted than direct local transport | [architecture/security-architecture.md](../architecture/security-architecture.md) |

### Related Domain Docs

- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)

### Related Architecture Docs

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Deployment Topology](../architecture/deployment-topology.md)

### Related Specs

- [Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)
- [Identity And Participant State](../specs/018-identity-and-participant-state.md)

### Related ADRs

- [Local Execution Shared Control Plane](./002-local-execution-shared-control-plane.md)
- [Collaboration Trust And Permission Model](./007-collaboration-trust-and-permission-model.md)

## Decision Log

| Date | Event | Notes |
|------|-------|-------|
| 2026-04-14 | Proposed | Initial draft |
| 2026-04-14 | Re-baselined | Reviewer assignment and template-complete acceptance remain incomplete |
