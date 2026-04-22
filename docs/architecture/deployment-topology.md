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
| `Collaborative Hosted Control Plane` | Multiple local daemons connect to one hosted control plane for invites, presence, relay, and shared metadata. Project-operated hosted offering per [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md). |
| `Collaborative Self-Hosted Control Plane` | Same architecture as hosted, but the control plane is self-managed by the deploying organization. The free OSS deployment path per [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md); ships the same 16-feature V1 surface as hosted. Secure-defaults posture for this topology is normative per [Spec-027: Self-Host Secure Defaults](../specs/027-self-host-secure-defaults.md) with operator-facing companion at [Operations › Self-Host Secure Defaults](../operations/self-host-secure-defaults.md) (Spec-027 Acceptance Criterion). |
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

The relay uses Cloudflare Durable Objects with a sharding strategy to handle high-participant sessions.

**Cloudflare Durable Object platform limits (verified 2026-04-19):**

- An individual DO has a **soft limit of 1,000 requests/sec**; exceeding it returns an `overloaded` error to the caller ([DO limits][do-limits]).
- There is **no published cap on concurrent WebSocket connections per DO** — Cloudflare states DOs "can act as WebSocket servers that connect thousands of clients per instance" ([DO WebSockets best practices][do-ws]).
- Each DO is single-threaded; horizontal scale is achieved by spawning more objects ([DO limits][do-limits]).
- CF's own guidance pegs practical throughput at ~500–1,000 rps for simple operations and ~200–500 rps for complex operations that involve transformation plus storage writes ([Rules of Durable Objects][do-rules]).

**Design choice: 25 WebSocket connections per data DO.** This is *our* target, not a platform cap. It derives from the per-DO throughput envelope we need to stay inside, not from any Cloudflare connection ceiling:

| Input | Value | Source |
| --- | --- | --- |
| Events/sec/connection (p95, streaming agent output + MLS control frames) | ~100 | AI Sidekicks load-model assumption — **unverified in CF docs**; must be validated in pre-launch load test |
| MLS encrypt + storage write cost per event | ~1 DO request | Spec-006 relay data-path |
| Safety headroom vs. 1,000 rps soft cap | 2.5× | Intentional — CF guidance places complex ops in the 200–500 rps band ([Rules of DO][do-rules]) |

Envelope (batching is a design baseline, not a future enhancement): **25 conns × 100 events/sec of raw client traffic ÷ ~6 events per batched DO request ≈ 400 rps/DO** of DO-request throughput per data DO. The 400 rps operating point sits inside CF's 200–500 rps "complex op" band and leaves ~2.5× headroom vs the 1,000 rps overloaded-error threshold. Without batching the same raw envelope would yield ~2,500 rps/DO, which would breach the 1,000 rps soft cap — so **batched WebSocket messages are assumed at design time**, enabled by the 2025-10-31 raise of WebSocket message size from 1 MiB to 32 MiB ([DO changelog][do-changelog]). The 100 events/sec/connection figure and the ~6:1 batching ratio are internal load-model assumptions — CF does not publish a per-connection event-rate model or a batching-ratio model.

**Routing:**

- **Control DO** manages session membership, connection assignments, and routes new connections to data DOs.
- **Data DOs** handle encrypted message fan-out. The 25-connection target is a tunable shard factor, not a ceiling imposed by Cloudflare.
- When participant count exceeds the per-DO target, the control DO spawns additional data DOs and distributes connections across them.
- Follows the v2 protocol pattern (control socket + per-connection data sockets) from the relay protocol design.

**Decision triggers for re-tuning the 25-connection shard factor.** Re-evaluate when any of the following is true:

1. Measured p95 events/sec/connection drops below ~40 (we have 2.5× slack — raise the shard factor toward ~60 connections/DO).
2. Measured p95 events/sec/connection exceeds ~200 (we are burning our headroom — drop the shard factor toward ~10 connections/DO).
3. Cloudflare raises the per-DO rps soft cap above 1,000 ([monitor DO changelog][do-changelog]).
4. Batching is lost or the ~6:1 batching ratio drops materially. Because the un-batched envelope (2,500 rps/DO) exceeds the 1,000 rps soft cap, a batching regression forces an emergency reduction of the shard factor toward ~10 connections/DO pending root-cause fix.
5. MLS encrypt cost per event materially changes (e.g., Spec-006 revision, new ciphersuite).

**Pre-launch requirement:** Load test spike with 50 participants × 10 concurrent runs × streaming events must pass, and must measure actual events/sec/connection to validate the 100 events/sec assumption, before V1 production launch.

[do-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
[do-ws]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[do-rules]: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
[do-changelog]: https://developers.cloudflare.com/changelog/product/durable-objects/

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

### Local Daemon Memory Instrumentation And Budget Triggers

The 256 MB local daemon budget above is an operating target derived from small-team collaboration sizing, not a hard ceiling. Budget violations MUST be observable so that operators and product owners can decide between a budget raise and a deeper change.

**Instrumentation requirement.** The daemon MUST expose `process_resident_memory_bytes` via the default Prometheus `prom-client` collector ([default metrics](https://github.com/siimon/prom-client#default-metrics)). RSS (resident set size) is the authoritative metric for process footprint — distinct from V8 heap-used, which excludes native allocations from SQLite page cache, `node-pty` file descriptors, and `@noble/*` cryptographic buffers. Alert fires when RSS exceeds **80% of the budget (≥ 205 MB)** sustained for ≥ 5 minutes. Sustained (not instantaneous) reduces false positives from transient build-step allocations. The 80% threshold and 5-minute window are design choices, not external standards.

**Decision trigger.** If real workloads consistently breach the 256 MB budget, **raise the budget to 384–512 MB before considering a runtime change.** Rationale: a budget raise is reversible and low-blast-radius (documentation + alert-threshold update); changing the runtime (e.g., replacing Node.js with a different language) carries much larger implementation cost and is reserved for breaches that persist after a budget raise. "Consistently breach" is defined as ≥ 20% of operating daemons observed over a rolling 7-day window exceeding 256 MB; these thresholds are internal and will be revisited once real deployment telemetry is available.

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
- [V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
