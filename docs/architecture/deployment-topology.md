# Deployment Topology

## Purpose

Describe the supported deployment shapes for clients, runtime nodes, and the collaboration control plane.

## Scope

This document covers `local-only`, collaborative, hosted, and self-hosted topology variants.

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
| `Single-Participant Local` | Desktop or CLI plus one local daemon operating in `local-only` continuity. No shared control-plane dependency for basic single-user execution. |
| `Collaborative Hosted Control Plane` | Multiple local daemons connect to one hosted control plane for invites, presence, relay, and shared metadata. |
| `Collaborative Self-Hosted Control Plane` | Same architecture as hosted, but the control plane is self-managed by the deploying organization. |
| `Relay-Assisted Remote Access` | A client or node reaches the shared session through relay coordination without moving execution into the control plane. |

## Data Flow

1. `local-only` mode keeps execution and immediately usable session continuity on one participant-owned machine except for external provider calls.
2. Collaborative mode adds control-plane metadata exchange and relay coordination.
3. Self-hosted mode preserves the same logical split but changes operational ownership.
4. Relay-assisted mode changes transport path only; execution remains local to the node.

## Trust Boundaries

- No supported topology moves arbitrary code execution into the shared control plane.
- Relay-assisted access changes connectivity, not execution authority.
- Self-hosting changes operator ownership, not the logical security model.

## Rate Limiting By Deployment

Rate limiting uses a deployment-aware abstraction with identical limits across all topologies:

| Deployment | Edge Layer | Application Layer |
| --- | --- | --- |
| `Collaborative Hosted Control Plane` (Cloudflare) | CF Workers native `rate_limit` binding (zero latency) | Sliding window counters in Durable Objects |
| `Collaborative Self-Hosted Control Plane` | `rate-limiter-flexible` with Postgres backend | `rate-limiter-flexible` with Postgres backend |
| `Single-Participant Local` | No rate limiting (trusted by socket reachability) | No rate limiting |

The rate limiting interface is identical regardless of deployment. Implementation swaps via configuration. Self-hosted deployments use `rate-limiter-flexible` (Postgres/Redis/in-memory backends) to achieve the same semantics as the Cloudflare native binding.

## Relay Scaling Strategy

The relay uses Cloudflare Durable Objects with a sharding strategy to handle high-participant sessions:

- **Control DO** manages session membership, connection assignments, and routes new connections to data DOs.
- **Data DOs** handle encrypted message fan-out. Each data DO handles at most 25 WebSocket connections.
- When participant count exceeds the per-DO connection cap (default: 25), the control DO spawns additional data DOs and distributes connections across them.
- This follows the v2 protocol pattern (control socket + per-connection data sockets) from the relay protocol design.

Expected throughput envelope per data DO: 25 connections × 100 events/sec × MLS encrypt = ~2,500 writes/sec — within Durable Object limits.

**Pre-launch requirement:** Load test spike with 50 participants × 10 concurrent runs × streaming events must pass before V1 production launch.

## Failure Modes

- `local-only` mode lacks collaborative features when no control plane is available.
- Collaborative mode degrades to partial `local-only` continuity when the control plane is unavailable.
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
