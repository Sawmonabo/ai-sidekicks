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

## Horizontal Scaling Strategy

**Control plane:** stateless Node.js processes behind a load balancer. Session affinity is not required because all state lives in Postgres. Scale horizontally by adding processes.

**Relay:** stateless WebSocket proxies. MLS encryption means the relay holds no session state. Scale by adding relay instances with DNS-based routing.

**Local daemon:** runs on each participant's machine. No scaling needed — it is per-machine by design.

## Postgres Strategy

**V1:** single Postgres instance with connection pooling (PgBouncer or built-in pool).

**V1.1:** read replicas for query-heavy operations (event queries, session directory lookups).

**Connection pool sizing:** 10 connections per control-plane process, max 100 total.

**Backup:** automated daily snapshots + WAL archiving for point-in-time recovery.

## Capacity Targets

| Metric | V1 Target |
| --- | --- |
| Concurrent sessions | 1,000 |
| Participants per session | 10 (configurable) |
| Total participants | 5,000 |
| Events per second (write) | 500 |
| Events per second (read) | 2,000 |
| Relay connections | 2,000 concurrent |
| Session event log size | 100,000 events/session lifetime (50,000 active before compaction per Spec-006) |

## Infrastructure Requirements

| Component | CPU | Memory | Disk |
| --- | --- | --- | --- |
| Control plane (per process) | 1 vCPU | 512 MB | — |
| Postgres | 4 vCPU | 8 GB | 100 GB SSD |
| Relay (per process) | 1 vCPU | 256 MB | — |
| Local daemon (per machine) | 0.5 vCPU | 256 MB | 1 GB (SQLite + artifacts) |

## Container and Packaging

**Control plane:** Docker container, multi-stage build, Alpine-based.

**Relay:** Docker container, same base image.

**Local daemon:** native binary (pkg or standalone Node.js bundle). Distributed via: npm package, Homebrew formula, direct download.

**Desktop shell:** Electron app bundling the daemon. The daemon starts as a child process of the desktop shell.

**CLI:** npm-distributed package that connects to the local daemon.

## CI/CD and Release

**Build orchestration:** monorepo with Turborepo.

**CI:** GitHub Actions — lint, typecheck, test, build on every PR.

**CD:** control plane and relay deployed via container registry push + rolling update.

**Local artifacts:** daemon, CLI, and desktop shell built on release tag and published to npm / GitHub Releases.

**Versioning:** semver for packages; control-plane API versioned via tRPC router namespacing.

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
