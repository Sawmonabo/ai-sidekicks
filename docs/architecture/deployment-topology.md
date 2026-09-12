# Deployment Topology

## Purpose

Describe the supported deployment shapes for clients, runtime nodes, and the control plane.

## Scope

This document covers `local-only`, remote-control, hosted, and self-hosted topology variants.

## Context

The product must support local execution by default while also letting a user's other devices reach the machine a session runs on.

## Responsibilities

- define which components can run locally versus remotely
- describe the minimum supported topology for remote control
- constrain unsupported or discouraged deployment shapes

## Component Boundaries

Supported topologies:

| Topology | Boundary Summary |
| --- | --- |
| `Single-Device Local` | Desktop or CLI plus one local daemon on the same machine, operating in `local-only` continuity. No control-plane dependency. |
| `Hosted Control Plane` | A user's devices and machines connect to one hosted control plane for the device registry, liveness, relay, and session metadata. Project-operated hosted offering per [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md). |
| `Self-Hosted Control Plane` | Same architecture as hosted, but the control plane is self-managed by the deploying user or organization. The free OSS deployment path per [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md); ships the same 21-feature V1 surface as hosted. Secure-defaults posture for this topology is normative per [Spec-024: Self-Host Secure Defaults](../specs/024-self-host-secure-defaults.md) with operator-facing companion at [Operations › Self-Host Secure Defaults](../operations/self-host-secure-defaults.md) (Spec-024 Acceptance Criterion). |
| `Relay-Assisted Remote Access` | A device or node reaches the session through relay coordination without moving execution into the control plane. |

## Data Flow

1. `local-only` mode keeps execution and immediately usable session continuity on one user-owned machine except for external provider calls.
2. Remote-control mode adds control-plane metadata exchange and relay coordination so the user's other devices can drive the session.
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
| `Hosted Control Plane` (Cloudflare) | CF Workers native `rate_limit` binding (sliding-window counters, zero added latency) | Per-identity `RateLimitEscalationDO` Durable Object — escalation-block authority + authoritative window state, consulted on every check (eager-DO, [Plan-019 D-019-3](../plans/019-rate-limiting-policy.md#ratified-design-decisions-tier-5-audit)) |
| `Self-Hosted Control Plane` | `rate-limiter-flexible` with Postgres backend | `rate-limiter-flexible` with Postgres backend + `rate_limit_escalations` table |
| `Single-Device Local` | No rate limiting (trusted by socket reachability) | No rate limiting |

The rate limiting interface is identical regardless of deployment. Implementation swaps via configuration (`AIS_RATELIMIT_BACKEND`). Self-hosted deployments use `rate-limiter-flexible` (Postgres backend in V1) to achieve the same semantics as the Cloudflare native binding; both compose the same admission pipeline (admin ban → escalation block → sliding-window counter, Plan-019 I-019-1).

## Relay Scaling Strategy

The relay uses Cloudflare Durable Objects, one object per session.

**Cloudflare Durable Object platform limits (verified 2026-04-19):**

- An individual DO has a **soft limit of 1,000 requests/sec**; exceeding it returns an `overloaded` error to the caller ([DO limits][do-limits]).
- There is **no published cap on concurrent WebSocket connections per DO** — Cloudflare states DOs "can act as WebSocket servers that connect thousands of clients per instance" ([DO WebSockets best practices][do-ws]).
- Each DO is single-threaded; horizontal scale is achieved by spawning more objects ([DO limits][do-limits]).
- CF's own guidance pegs practical throughput at ~500–1,000 rps for simple operations and ~200–500 rps for complex operations that involve transformation plus storage writes ([Rules of Durable Objects][do-rules]).

**Design choice: one DO per session, no sharding.** A session's connections are one user's own endpoints — the runtime node the session is bound to, plus whichever of that user's linked devices currently have it open. That population is single-digit by construction, so the connection count per session is an order of magnitude below anything a shard factor would need to relieve, and the control-DO / data-DO split a larger-N model would require is not built at all. The budget to respect is throughput, not connection count:

| Input | Value | Source |
| --- | --- | --- |
| Events/sec/connection (p95, streaming agent output + MLS control frames) | ~100 | AI Sidekicks load-model assumption — **unverified in CF docs**; must be validated in pre-launch load test |
| MLS encrypt + storage write cost per event | ~1 DO request | Spec-005 relay data-path |
| Safety headroom vs. 1,000 rps soft cap | 2.5× | Intentional — CF guidance places complex ops in the 200–500 rps band ([Rules of DO][do-rules]) |

Envelope (batching is a design baseline, not a future enhancement), budgeted against a deliberately generous **10 concurrent connections per session** — well above the runtime node plus two or three devices a real session carries: **10 conns × 100 events/sec of raw traffic ÷ ~6 events per batched DO request ≈ 170 rps/DO**. That operating point sits below CF's 200–500 rps "complex op" band and leaves ~6× headroom vs the 1,000 rps overloaded-error threshold. Without batching the same raw envelope would yield ~1,000 rps/DO, which sits exactly at the soft cap — so **batched WebSocket messages are assumed at design time**, enabled by the 2025-10-31 raise of WebSocket message size from 1 MiB to 32 MiB ([DO changelog][do-changelog]). The 100 events/sec/connection figure and the ~6:1 batching ratio are internal load-model assumptions — CF does not publish a per-connection event-rate model or a batching-ratio model.

**Routing:** one DO per session terminates every connection for that session — the runtime node's and each connected device's — and fans encrypted frames out across them. There is no routing tier, because there is nothing to route between.

**Decision triggers for reintroducing a sharding tier.** Re-evaluate when any of the following is true:

1. Measured p95 events/sec/connection exceeds ~200 (the headroom above is being burned by per-connection volume rather than by connection count).
2. Sessions routinely carry more than ~10 concurrent connections — many linked devices open at once, or a later feature that attaches more than one runtime node to a live session.
3. Cloudflare raises or lowers the per-DO rps soft cap ([monitor DO changelog][do-changelog]).
4. Batching is lost or the ~6:1 batching ratio drops materially. The un-batched envelope lands at the 1,000 rps soft cap with no margin, so a batching regression is a launch blocker pending root-cause fix.
5. MLS encrypt cost per event materially changes (e.g., Spec-005 revision, new ciphersuite).

**Pre-launch requirement:** a load-test spike of 1,000 concurrent sessions — each one runtime node plus three connected devices, running 10 concurrent runs of streaming events — must pass, and must measure actual events/sec/connection to validate the 100 events/sec assumption, before V1 production launch.

[do-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
[do-ws]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[do-rules]: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
[do-changelog]: https://developers.cloudflare.com/changelog/product/durable-objects/

## Failure Modes

- `local-only` mode cannot be reached from the user's other devices when no control plane is available.
- Remote-control mode degrades to partial `local-only` continuity when the control plane is unavailable: work at the machine continues, remote devices report it unreachable.
- Relay-assisted connectivity fails even though local daemons remain healthy.

## Horizontal Scaling Strategy

**Control plane:** stateless Node.js processes behind a load balancer. Session affinity is not required because all state lives in Postgres or the artifact-relay blob store (digest-addressed object storage per [Spec-012 §Cross-Node Artifact Relay (V1)](../specs/012-artifacts-files-and-attachments.md#cross-node-artifact-relay-v1)) — neither is process-local. Scale horizontally by adding processes.

**Relay:** stateless WebSocket proxies for the message path — E2EE frames (pairwise X25519 + XChaCha20-Poly1305 in V1 per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)) mean the relay processes hold no session state. The artifact relay's pinned ciphertext is durable state, but it lives in the shared blob store (object storage), not in proxy processes — blob reachability follows the shared store, not instance affinity. Scale by adding relay instances with DNS-based routing.

**Local daemon:** runs on each of the user's machines. No scaling needed — it is per-machine by design.

## Postgres Strategy

**V1:** single Postgres instance with connection pooling (PgBouncer or built-in pool).

**V1.1:** read replicas for query-heavy operations (event queries, session directory lookups).

**Connection pool sizing:** 10 connections per control-plane process, max 100 total.

**Backup:** automated daily snapshots + WAL archiving for point-in-time recovery — with one carve-out for `artifact_relay_recipients` wrapped-CEK rows: because PITR/WAL archiving is database-wide (rows cannot be excluded), either the backup/PITR retention window is bounded at or below the erasure SLA (≤ the 30 d relay-TTL ceiling), or the wrapped-CEK envelopes are stored under a separately-destroyable KEK so restored backups yield unusable ciphertext (the `Spec-020 §Daemon Master Key` custody precedent) — so a GDPR erasure cannot be resurrected from backup ([Spec-012 §State And Data Implications](../specs/012-artifacts-files-and-attachments.md#state-and-data-implications); the matching exclusion note sits on the table in [shared-postgres-schema.md §Artifact Relay Blob Store](./schemas/shared-postgres-schema.md#artifact-relay-blob-store-plan-012)).

## Capacity Targets

| Metric | V1 Target |
| --- | --- |
| Concurrent sessions | 1,000 |
| Connected devices per session | 5 (configurable) |
| Total users | 5,000 |
| Events per second (write) | 500 |
| Events per second (read) | 2,000 |
| Relay connections | 2,000 concurrent |
| Session event log size | 100,000 events/session lifetime (50,000 active before compaction per Spec-005) |
| Artifact relay storage | 10 GB per node default (`node_relay_storage_max`, operator-tunable); retention tiers ≤ 30 d per [Spec-012](../specs/012-artifacts-files-and-attachments.md#size-quota-retention-normative-defaults-operator-tunable) |

## Infrastructure Requirements

| Component | CPU | Memory | Disk |
| --- | --- | --- | --- |
| Control plane (per process) | 1 vCPU | 512 MB | — |
| Postgres | 4 vCPU | 8 GB | 100 GB SSD |
| Relay (per process) | 1 vCPU | 256 MB | — (artifact blob store: object storage sized by `node_relay_storage_max`, default 10 GB/node, per Spec-012) |
| Local daemon (per machine) | 0.5 vCPU | 256 MB | 1 GB (SQLite + artifacts) |

### Local Daemon Memory Instrumentation And Budget Triggers

The 256 MB local daemon budget above is an operating target derived from one user's session sizing on a developer workstation — a handful of concurrent runs, one working tree, and the relay connection that serves that user's other devices — not a hard ceiling. Budget violations MUST be observable so that operators and product owners can decide between a budget raise and a deeper change.

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
- [User And Device Model](../domain/user-and-device-model.md)

## Related Specs

- [Runtime Node Attach](../specs/002-runtime-node-attach.md)
- [Remote Control](../specs/028-remote-control.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
- [V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
