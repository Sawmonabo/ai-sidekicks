# Deployment Topology

## Purpose

Describe the supported deployment shapes for clients, runtime nodes, and the collaboration control plane.

## Scope

This document covers local-only, collaborative, hosted, and self-hosted topology variants.

## Context

The product must support local execution by default while also supporting shared sessions across participants and organizations.

## Responsibilities

- define which components can run locally versus remotely
- describe the minimum supported topology for collaboration
- constrain unsupported or discouraged deployment shapes

## Component Boundaries

Supported topologies:

| Topology | Boundary Summary |
| --- | --- |
| `Single-Participant Local` | Desktop or CLI plus one local daemon. No shared control-plane dependency for basic single-user execution. |
| `Collaborative Hosted Control Plane` | Multiple local daemons connect to one hosted control plane for invites, presence, relay, and shared metadata. |
| `Collaborative Self-Hosted Control Plane` | Same architecture as hosted, but the control plane is self-managed by the deploying organization. |
| `Relay-Assisted Remote Access` | A client or node reaches the shared session through relay coordination without moving execution into the control plane. |

## Data Flow

1. Local-only mode keeps execution and metadata on one machine except for external provider calls.
2. Collaborative mode adds control-plane metadata exchange and relay coordination.
3. Self-hosted mode preserves the same logical split but changes operational ownership.
4. Relay-assisted mode changes transport path only; execution remains local to the node.

## Trust Boundaries

- No supported topology moves arbitrary code execution into the shared control plane.
- Relay-assisted access changes connectivity, not execution authority.
- Self-hosting changes operator ownership, not the logical security model.

## Failure Modes

- Local-only mode loses collaboration features when no control plane is available.
- Collaborative mode degrades to partial local-only behavior when the control plane is unavailable.
- Relay-assisted connectivity fails even though local daemons remain healthy.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)

## Related Specs

- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
