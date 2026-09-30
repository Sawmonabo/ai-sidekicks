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
| `Workers Relay` | The person's own control plane and relay on Cloudflare Workers and Durable Objects, deployed in their own Cloudflare account, holding the device and machine registry and the account's statement chain and relaying their channels. It serves that one person and no one else, per [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md). |
| `Compose Relay` | The same control plane and relay on the person's own server: Node, Caddy and Postgres from one `docker-compose.yml`, per [ADR-020](../decisions/020-v1-deployment-model-and-oss-license.md). It serves the same features as the Workers relay, and it alone gives shared ports in the web client an address. Secure-defaults posture for this topology is normative per [Spec-024: Self-Host Secure Defaults](../specs/024-self-host-secure-defaults.md) with its hands-on companion at [Operations › Self-Host Secure Defaults](../operations/self-host-secure-defaults.md) (Spec-024 Acceptance Criterion). |
| `Relay-Assisted Remote Access` | A device reaches the person's machines through their relay, one channel per device and machine, without moving execution into the control plane. |

## Data Flow

1. `local-only` mode keeps execution and immediately usable session continuity on one user-owned machine except for external provider calls.
2. Remote-control mode adds control-plane metadata exchange and relay coordination so the user's other devices can drive the session.
3. Self-hosted mode preserves the same logical split but changes operational ownership.
4. Relay-assisted mode changes transport path only; execution remains local to the node.

## Trust Boundaries

- No supported topology moves arbitrary code execution into the shared control plane.
- Relay-assisted access changes connectivity, not execution authority.
- Self-hosting changes who runs the relay, not the logical security model.

## Rate Limiting By Deployment

Rate limiting uses a deployment-aware abstraction with identical limits across all topologies:

| Deployment | Edge Layer | Application Layer |
| --- | --- | --- |
| `Workers Relay` (Cloudflare) | CF Workers native `rate_limit` binding (sliding-window counters, zero added latency) | Per-identity `RateLimitIdentityDO` Durable Object — authoritative window state, consulted on every check (eager-DO, [Plan-019 D-019-3](../plans/019-rate-limiting-policy.md)) |
| `Compose Relay` | `rate-limiter-flexible` with Postgres backend | `rate-limiter-flexible` with Postgres backend |
| `Single-Device Local` | No rate limiting (trusted by socket reachability) | No rate limiting |

The rate limiting interface is identical regardless of deployment. Implementation swaps via configuration (`AIS_RATELIMIT_BACKEND`). The Compose relay uses `rate-limiter-flexible` (Postgres backend) to achieve the same semantics as the Cloudflare native binding; both run the same one-stage admission, the sliding-window counter (Plan-019 I-019-1): a trip is refused with the window's `Retry-After`, and a device over its frame quota gets one refusal frame and a 60-second pause. Nothing is banned and nothing escalates.

## Relay Scaling Strategy

The relay serves one person: their machines and the devices they link. Each machine and each device holds one connection to it, with at most one live connection per key, and every channel joins one device to one machine ([Spec-028 §The encryption envelope](../specs/028-remote-control.md#the-encryption-envelope)). The relay forwards sealed frames and reads none of them.

**Cloudflare Durable Object platform limits (verified 2026-04-19):**

- An individual DO has a **soft limit of 1,000 requests/sec**; exceeding it returns an `overloaded` error to the caller ([DO limits][do-limits]).
- There is **no published cap on concurrent WebSocket connections per DO** — Cloudflare states DOs "can act as WebSocket servers that connect thousands of clients per instance" ([DO WebSockets best practices][do-ws]).
- Each DO is single-threaded; horizontal scale is achieved by spawning more objects ([DO limits][do-limits]).
- CF's own guidance pegs practical throughput at ~500–1,000 rps for simple operations and ~200–500 rps for complex operations that involve transformation plus storage writes ([Rules of Durable Objects][do-rules]).

**Workers relay: one Durable Object for the account.** It terminates every connection, each machine's and each device's, and forwards each frame from its sender to the other end of that frame's channel. A person's machines and devices are a handful of connections, so connection count is never the budget; throughput is:

| Input | Value | Source |
| --- | --- | --- |
| Device-sent frames | At most 6,000 a minute (100 a second) per device, held by the relay's per-device quota | [Plan-028](../plans/028-remote-control.md) Phase 3 |
| Machine-sent frames | Bounded by each channel's backpressure; no quota | [Plan-028](../plans/028-remote-control.md) Phase 3 |
| Sustained budget for the object | 400 requests a second, 2.5× under the 1,000 rps soft cap | Intentional: CF guidance places complex operations in the 200–500 rps band ([Rules of DO][do-rules]) |

Machine-sent traffic, meaning agent output and Preview's live picture, is the term no quota fixes, so it is measured rather than assumed.

**Compose relay.** One Node process holds every connection under the same quota and backpressure.

**Decision triggers for changing the layout.** Re-evaluate when either is true:

1. The measured sustained rate on the account's object exceeds 400 requests a second.
2. Cloudflare raises or lowers the per-DO rps soft cap ([monitor DO changelog][do-changelog]).

**Pre-launch requirement:** before the first release that carries Remote Control, a load test on the Workers relay must pass. The test is one account with two machines and three devices; each machine streams agent output and Preview's live picture to a device, and each device sends at its full frame quota. It measures the object's sustained requests a second and each channel's machine-sent frames a second, and it passes when the object stays under 400 requests a second.

[do-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
[do-ws]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[do-rules]: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
[do-changelog]: https://developers.cloudflare.com/changelog/product/durable-objects/

## Failure Modes

- `local-only` mode cannot be reached from the user's other devices when no control plane is available.
- Remote-control mode degrades to partial `local-only` continuity when the control plane is unavailable: work at the machine continues, remote devices report it unreachable.
- Relay-assisted connectivity fails even though local daemons remain healthy.

## Horizontal Scaling Strategy

**Control plane and relay:** one person's relay needs no horizontal scale. The Compose relay is one Node process beside Caddy and Postgres, and its durable state lives in Postgres; the relay holds only live connections. The Workers relay scales on Cloudflare as §Relay Scaling Strategy lays out.

**Local daemon:** runs on each of the user's machines, any number of them. No scaling needed — it is per-machine by design. Each session has exactly one owning machine and is never silently migrated; a new session starts on the machine in view, and a device finds a session by asking each machine it can reach ([Spec-028 §One user, many devices, any number of machines](../specs/028-remote-control.md#one-user-many-devices-any-number-of-machines)).

## Postgres Strategy

**V1:** single Postgres instance with connection pooling (PgBouncer or built-in pool).

**Connection pool sizing:** 10 connections, one pool for the Compose relay's one process.

**Backup:** automated daily snapshots + WAL archiving for point-in-time recovery.

## Capacity Targets

| Metric | V1 Target |
| --- | --- |
| Accounts per relay | 1, the person's own |
| Relay connections | One per machine and one per linked device, at most one live connection per key |
| Device-sent frames | 6,000 a minute per device |
| Session event log size | 100,000 events/session lifetime |

## Infrastructure Requirements

The workload is one person, their machines and their devices, on one relay. The Postgres and relay rows below are the budget for it: the relay's build measures against them and records the baseline.

| Component                  | CPU      | Memory | Disk                      |
| -------------------------- | -------- | ------ | ------------------------- |
| Postgres                   | 1 vCPU   | 1 GB   | 10 GB SSD                 |
| Relay (per process)        | 1 vCPU   | 256 MB | —                         |
| Local daemon (per machine) | 0.5 vCPU | 256 MB | 1 GB (SQLite + artifacts) |

### Local Daemon Memory Instrumentation And Budget Triggers

The 256 MB local daemon budget above is an operating target derived from one user's session sizing on a developer workstation — a handful of concurrent runs, one working tree, and the relay connection that serves that user's other devices — not a hard ceiling. Budget violations MUST be observable, so that a budget raise or a deeper change is decided from the numbers.

**Instrumentation requirement.** The daemon MUST expose `process_resident_memory_bytes` via the default Prometheus `prom-client` collector ([default metrics](https://github.com/siimon/prom-client#default-metrics)). RSS (resident set size) is the authoritative metric for process footprint — distinct from V8 heap-used, which excludes native allocations from SQLite page cache, `node-pty` file descriptors, and `@noble/*` cryptographic buffers. Alert fires when RSS exceeds **80% of the budget (≥ 205 MB)** sustained for ≥ 5 minutes. Sustained (not instantaneous) reduces false positives from transient build-step allocations. The 80% threshold and 5-minute window are design choices, not external standards.

**Decision trigger.** If real workloads consistently breach the 256 MB budget, **raise the budget to 384–512 MB before considering a runtime change.** Rationale: a budget raise is reversible and low-blast-radius (documentation + alert-threshold update); changing the runtime (e.g., replacing Node.js with a different language) carries much larger implementation cost and is reserved for breaches that persist after a budget raise. "Consistently breach" is defined as ≥ 20% of operating daemons observed over a rolling 7-day window exceeding 256 MB; these thresholds are internal and will be revisited once real deployment telemetry is available.

### Budgets On A Windows Computer

Workload: the service idle for 10 minutes, one app window open, no session.

- **The daemon:** the 256 MB operating target above, the same inside a WSL 2 distribution.
- **The service's Windows half:** 15 MB private working set or less at idle, the same on native Windows where it runs as the daemon's child. Proposed; the baseline is measured on a Windows machine before the WSL phase lands.
- **The channel's buffers:** bounded by the channel's settings, a 128 MB session-memory ceiling on each end, which is never a resident figure at idle.
- **The attached `wsl.exe`, and the channel's latency and throughput against a native pipe:** measured on a Windows machine before the WSL phase lands.
- **The WSL virtual machine:** kept running for the service's whole life. Its memory cap defaults to half of RAM, with `autoMemoryReclaim` at `dropCache`, and the person's `.wslconfig` is never edited. Its idle cost with only the service running is measured on a Windows machine and stated here; it is not part of the Runtime figure, which counts the service's own processes (the daemon's process tree inside the distribution, plus the Windows half and its `wsl.exe` on Windows), because the VM's working set holds other distributions and the person's own WSL work.
- **A folder on the other side's disk** (`/mnt/c` from Linux, `\\wsl.localhost` from Windows) is slower, because every file operation crosses 9P; its cost is measured before the WSL phase lands.

## Container and Packaging

**Control plane:** Docker container, multi-stage build, Alpine-based.

**Relay:** Docker container, same base image.

**Local daemon:** the standalone Node.js bundle — the Node runtime, the JavaScript, the SQLite and `node-pty` native modules, and the CLI, with the native modules beside the runtime as plain files. `vercel/pkg` was considered and is not used: it is archived, and it packs files into the executable where the native modules must stay plain files. The Linux runtime ships for glibc and for musl, so an Alpine machine or distribution runs it; the musl builds use the Node.js project's unofficial-builds binaries, because the bundle cannot carry Alpine's own system `nodejs` package. Each Windows installer carries the Linux runtime archives for its architecture, glibc and musl, with their SHA-256, so a WSL 2 distribution runs the bytes a Linux user downloads and its first start works offline. Distributed via: npm package, Homebrew formula, direct download.

**Desktop app:** Electron app bundling the daemon. The daemon is the person's own background service on every platform, spawned detached or run by the operating system's service manager, never a child of the desktop app. A quit flushes and leaves the service, every run and every shell running; only Runtime's `Stop` and `Restart` end work ([Spec-006](../specs/006-local-ipc-and-daemon-control.md)).

**Background service on a Windows computer:** the service runs on the side where Claude Code and Codex are installed, Windows or one WSL 2 distribution, one service per computer. In a distribution it is the daemon plus the service's Windows half, a small native Windows program started at logon by a per-user task; the Windows half keeps one attached `wsl.exe` running the daemon for the service's whole life, inside a Job that lets Windows programs started through interop outlive it. Windows clients reach the daemon through one per-user named pipe, the same on both kinds of Windows computer, carried to a daemon in a distribution as streams of one HTTP/2 channel over that `wsl.exe`'s standard input and output. Key custody stays on Windows for both sides. On native Windows the same Windows half runs as the daemon's child, so every Windows-only job has one implementation ([ADR-041](../decisions/041-the-service-on-wsl-2.md), [Spec-006 §The service on a Windows computer](../specs/006-local-ipc-and-daemon-control.md#the-service-on-a-windows-computer)).

**CLI:** npm-distributed package that connects to the local daemon.

## CI/CD and Release

**Build orchestration:** monorepo with Turborepo.

**CI:** GitHub Actions — lint, typecheck, test, build on every PR.

**CD:** control plane and relay deployed via container registry push + rolling update.

**Local artifacts:** daemon, CLI, and desktop app built on release tag and published to npm / GitHub Releases.

**Versioning:** semver for packages; control-plane API versioned via tRPC router namespacing.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Runtime Node Model](../domain/runtime-node-model.md)
- [User And Device Model](../domain/user-and-device-model.md)

## Related Specs

- [Machine Registration](../specs/002-runtime-node-attach.md)
- [Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md)
- [Remote Control](../specs/028-remote-control.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
- [V1 Deployment Model and OSS License](../decisions/020-v1-deployment-model-and-oss-license.md)
- [Machine Identity Key Custody](../decisions/021-cli-identity-key-storage-custody.md)
- [The Service On WSL 2](../decisions/041-the-service-on-wsl-2.md)
