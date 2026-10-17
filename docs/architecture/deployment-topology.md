# Deployment Topology

## Purpose

Describe the supported deployment shapes for clients, machines, and the control plane.

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
| `Workers Relay` | The person's own control plane and relay on Cloudflare Workers and Durable Objects, deployed in their own Cloudflare account, holding the device and machine registry and the account's statement chain and relaying every channel that does not go direct. It serves that one person and no one else, per [ADR-019](../decisions/019-v1-deployment-model-and-oss-license.md). |
| `Compose Relay` | The same control plane and relay on the person's own server: `sidekicks-control-plane`'s native program and Caddy from one `docker-compose.yml`, with the account's data in a SQLite file the program writes ([§Account Storage](#account-storage)), per [ADR-019](../decisions/019-v1-deployment-model-and-oss-license.md). It serves the same features as the Workers relay, and it alone gives shared ports in the web client an address. Secure-defaults posture for this topology is normative per [Spec-023: Self-Host Secure Defaults](../specs/023-self-host-secure-defaults.md) with its hands-on companion at [Operations › Self-Host Secure Defaults](../operations/self-host-secure-defaults.md) (Spec-023 Acceptance Criterion). |
| `Relay-Assisted Remote Access` | A device reaches the person's machines over one channel per device and machine, straight across the network wherever the two can reach each other and through the person's relay otherwise, without moving execution into the control plane. The relay connection stays open either way: it carries reachability, presence, the direct path's setup and the fallback. |

## Data Flow

1. `local-only` mode keeps execution and immediately usable session continuity on one user-owned machine except for external provider calls.
2. Remote-control mode adds control-plane metadata exchange and relay coordination so the user's other devices can drive the session.
3. Self-hosted mode preserves the same logical split but changes operational ownership.
4. Relay-assisted mode changes transport path only; execution remains local to the machine. A device's channel moves onto a direct path wherever the network allows and back to the relay when the path is lost, losing, repeating and reordering nothing ([Spec-027 §The direct path](../specs/027-remote-control.md#the-direct-path)).

## Trust Boundaries

- No supported topology moves arbitrary code execution into the shared control plane.
- Relay-assisted access changes connectivity, not execution authority.
- Self-hosting changes who runs the relay, not the logical security model.
- The direct path changes the carrier, not the trust: the same sealed channel and the same handshake against the account's statement chain run on it as on the relay.

## Rate Limiting By Deployment

The relay counts requests on its sign-in routes only — sign-in, token refresh and device linking — and answers a caller over the limit with 429 and a `Retry-After` ([Spec-019](../specs/019-rate-limiting-policy.md)). No route a credential reaches is counted, and neither is the channel.

| Deployment | Where the sign-in routes are counted |
| --- | --- |
| `Workers Relay` (Cloudflare) | The per-identity `RateLimitIdentityDurableObject`, one global count per source address whichever edge location serves it ([Plan-018 D-018-1](../plans/018-rate-limiting-policy.md#design-decisions)) |
| `Compose Relay` | The relay process's memory ([Plan-018 D-018-2](../plans/018-rate-limiting-policy.md#design-decisions)) |
| `Single-Device Local` | Nowhere: the daemon is reached through its socket only |

Both relays enforce the same limit through the same interface, chosen by deployment configuration. A counter error fails that one request like any backend error. Nothing is banned and nothing escalates.

## Relay Scaling Strategy

The relay serves one person: their machines and the devices they link. Each machine and each device holds one connection to it, with at most one live connection per machine key and, on each machine's forwarding object, one per device key, and every channel joins one device to one machine ([Spec-027 §The encryption envelope](../specs/027-remote-control.md#the-encryption-envelope)). The relay forwards sealed frames and reads none of them. A channel on the direct path sends the relay nothing but its connection's keepalive and its rekey.

**Cloudflare Durable Object platform limits:**

- An individual DO has a **soft limit of 1,000 requests/sec**; exceeding it returns an `overloaded` error to the caller ([DO limits][do-limits]).
- There is **no published cap on concurrent WebSocket connections per DO** — Cloudflare states DOs "can act as WebSocket servers that connect thousands of clients per instance" ([DO WebSockets best practices][do-ws]).
- Each DO is single-threaded; horizontal scale is achieved by spawning more objects ([DO limits][do-limits]).
- CF's own guidance pegs practical throughput at ~500–1,000 rps for simple operations and ~200–500 rps for complex operations that involve transformation plus storage writes ([Rules of Durable Objects][do-rules]).

**Workers relay: one account object, and one forwarding object per machine.** A Durable Object is created near the first request that names it and does not move ([DO data location][do-location]), so one object for everything would sit near the first machine that signed in, and a phone would reach a second machine across the country through it.

- **The account object** holds the account's data ([§Account Storage](#account-storage)) and records each machine's current forwarding object, which the negotiation reply hands to a device. Connects, closes and the two-places flag report back to it, and a revocation fans out from it to every machine's forwarding object.
- **Each machine's forwarding object** terminates that machine's connection and every device connection to it, and forwards each frame from its sender to the other end of that frame's channel. That machine's own relay connection creates it, so it sits near the machine with no location hint. Its name is the machine id and a region key from Cloudflare's `request.cf.continent`: a laptop that reconnects from another continent gets a new object there, and devices still on the old one are closed with a moved code and reconnect.
- **While the direct path carries a channel,** both ends of its relay connection exchange a fixed keepalive text pair every 15 seconds, outside the frame codec, which the object answers without waking (`setWebSocketAutoResponse`, whose strings are at most 2,048 characters); the 45-second reachability rule reads that answer's timestamp (`getWebSocketAutoResponseTimestamp`), since a protocol ping leaves no record.

A person's machines and devices are a handful of connections, so connection count is never the budget; throughput is:

| Input | Value | Source |
| --- | --- | --- |
| Device-sent frames | Bounded by each channel's backpressure; no quota | [Plan-025](../plans/025-remote-control.md) Phase 3 |
| Machine-sent frames | Bounded by each channel's backpressure; no quota | [Plan-025](../plans/025-remote-control.md) Phase 3 |
| Sustained budget for each forwarding object | 400 requests a second, 2.5× under the 1,000 rps soft cap | Intentional: CF guidance places complex operations in the 200–500 rps band ([Rules of DO][do-rules]) |

Frames either way, agent output and Preview's live picture included, are the term no quota fixes, so they are measured rather than assumed.

**Compose relay.** One native process, `sidekicks-control-plane`'s self-host program, holds every connection under the same backpressure and counts sign-in routes in its own memory.

**Decision triggers for changing the layout.** Re-evaluate when either is true:

1. The measured sustained rate on a machine's forwarding object exceeds 400 requests a second.
2. Cloudflare raises or lowers the per-DO rps soft cap ([monitor DO changelog][do-changelog]).

**Pre-launch requirement:** before the first release that carries Remote Control, a load test on the Workers relay must pass. The test is one account with two machines and three devices; each machine streams agent output and Preview's live picture to a device, and each device sends as fast as its channel's backpressure allows. Every channel stays on the relay for the test. It measures each forwarding object's sustained requests a second and each channel's frames a second each way, and it passes when each object stays under 400 requests a second.

[do-limits]: https://developers.cloudflare.com/durable-objects/platform/limits/
[do-ws]: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
[do-rules]: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
[do-changelog]: https://developers.cloudflare.com/changelog/product/durable-objects/
[do-location]: https://developers.cloudflare.com/durable-objects/reference/data-location/

## Relay Cost And Delay

Measured on a Rust relay object built on `worker` 0.8.7. These are the figures every other doc links to.

- **Hibernation.** A Rust Durable Object hibernates. After 15 seconds or more with its sockets idle, every wake ran in a new wasm instance, its memory back at its starting 1.2 MB; the isolate's peak memory was 22.9 MB of the 128 MB limit. A wake adds about 27 ms to a frame's round trip at the median.
- **Cost per frame.** Processor time per incoming message is 351 µs at the median and 1.5 ms at p99. A minute of screencast (15 frames of 64 KiB a second, each acknowledged) bills 0.120 GB-s. One object awake all month uses 331,776 GB-s.
- **Delay.** A 100 B frame's round trip from a device to the object and back to another device was 130 ms at the median, from Miami to an object in Newark; the distance is most of it.

## Failure Modes

- `local-only` mode cannot be reached from the user's other devices when no control plane is available.
- Remote-control mode degrades to partial `local-only` continuity when the control plane is unavailable: work at the machine continues, remote devices report it unreachable.
- Relay-assisted connectivity fails even though local daemons remain healthy.
- A direct path does not form, because the routers allow no pair or the operating system's local-network prompt was refused: the channel stays on the relay and works as before.
- A direct path is lost: the device is back on the relay within 5 seconds, every stream resuming through the reconnect recovery.
- The relay connection drops while a direct path is open, as in an internet outage at home: the channel stays on the direct path and its sessions keep running, while a new connection waits for the relay.

## Horizontal Scaling Strategy

**Control plane and relay:** one person's relay needs no horizontal scale. The Compose relay is one native process beside Caddy, and its durable state lives in the account's SQLite file, which that process alone writes ([§Account Storage](#account-storage)). The Workers relay scales on Cloudflare as §Relay Scaling Strategy lays out.

**Local daemon:** runs on each of the user's machines, any number of them. No scaling needed — it is per-machine by design. Each session has exactly one owning machine and is never silently migrated; a new session starts on the machine in view, and a device finds a session by asking each machine it can reach ([Spec-027 §One user, many devices, any number of machines](../specs/027-remote-control.md#one-user-many-devices-any-number-of-machines)).

## Account Storage

The hosted account's data (the account, its sign-in state, the device and machine registry and the statement chain) lives in SQLite inside the relay, in the one schema [Hosted Account Schema](./schemas/hosted-account-schema.md) gives; no outside database runs on either relay.

- **Workers relay:** the account object, the one Durable Object named `account` in the relay's namespace, keeps it in its own SQLite storage; the forwarding objects hold no account rows. Only that object's code reads or writes it, apart from Cloudflare's Data Studio, which the [deletion runbook's](../operations/hosted-account-deletion-runbook.md) break-glass edit uses, and a series of its writes with no await between them commits together. The object's storage keeps 30 days of point-in-time recovery.
- **Compose relay:** a SQLite file on the server's disk, opened and written by the relay's one process alone. Its backup reads the database through SQLite while the relay runs, never as a plain copy of a file under a live writer, by the mechanism the Compose deployment names ([Plan-025](../plans/025-remote-control.md) Phase 8).

## Capacity Targets

| Metric | V1 Target |
| --- | --- |
| Accounts per relay | 1, the person's own |
| Relay connections | One per machine and one per linked device, at most one live connection per machine key and, on each machine's forwarding object, one per device key |
| Workers relay objects | One account object, and one forwarding object per machine per continent it has connected from |
| Direct paths | At most one per device and machine, wherever the network allows one |

## Infrastructure Requirements

The workload is one person, their machines and their devices, on one relay. The relay row below is the budget for the Compose relay's process: the relay's build measures against it and records the baseline. The Workers relay's figures are under [§Relay Cost And Delay](#relay-cost-and-delay).

| Component                  | CPU      | Memory | Disk                      |
| -------------------------- | -------- | ------ | ------------------------- |
| Relay (per process)        | 1 vCPU   | 256 MB | The account's SQLite file |
| Local daemon (per machine) | 0.5 vCPU | 256 MB | 1 GB (SQLite + artifacts) |

The Compose relay's server takes TCP 443 and 80 for Caddy, UDP and TCP 53 for the subzone it answers, and UDP 3478 for the STUN it answers for the direct path. The Workers relay opens nothing of the person's own; it hands out `stun.cloudflare.com:3478`.

### Local Daemon Memory Instrumentation And Budget

The 256 MB local daemon budget above is an operating target for one user's sessions on a developer workstation — a handful of concurrent runs, one working tree, and the relay connection that serves that user's other devices — not a hard ceiling. Budget violations MUST be observable, so that a budget raise or a deeper change is decided from the numbers.

**Instrumentation requirement.** The daemon reads its own resident set size (RSS) and reports it in `daemon.status.read`, which Settings › Runtime and `sidekicks daemon status` show with the time the reading was taken ([Spec-018 §Interfaces And Contracts](../specs/018-observability-and-failure-recovery.md#interfaces-and-contracts)). RSS is the authoritative figure for process footprint: it counts SQLite's page cache, the terminals' buffers and every other allocation, where an allocator's own statistics can miss some.

**Measurement.** Footprint and RSS on macOS, the service counted apart from Claude Code, Codex, Chromium and terminals: idle, with four sessions while all four stream, and two minutes after. Comparable compiled services idle at 25–33 MB; that is the reason the service is written in Rust, not a promised figure; a tighter target than the 256 MB budget is set from the service's first measurement under this workload.

**Flat over time.** The same four-session run, idle again after streaming, returns to its idle figure, and nothing in the service keeps an unbounded queue or cache.

**The direct path.** With no device on a direct path the service holds nothing for it: no UDP socket, router mapping or mDNS thread. Each direct peer costs the service at most 512 KiB idle and 2 MiB with its buffers full, one task and no thread, and a 1 MB a second live picture over the direct path at most 20 ms of the service's processor a second; a page with one direct channel streaming adds at most 8 MB. These are first settings, measured once by the direct path's unit ([Plan-025](../plans/025-remote-control.md) Phase 9).

### Budgets On A Windows Computer

**Workload 1:** the service idle for 10 minutes, one app window open, no session, and no work in a WSL 2 distribution.

- **The daemon:** the 256 MB operating target above.
- **WSL:** no WSL server, no `wsl.exe`, and the WSL virtual machine stopped. Where work that runs at all times lives in a distribution (the five-minute account reads of a provider installed only there, or the terminal Codex service switched on there), that computer's idle is Workload 2 without the session.

**Workload 2:** one session in a WSL 2 distribution idle between turns, one terminal open.

- **The WSL server:** 25 MB resident or less at idle. Proposed; it opens no store, index or scheduler, but it is the whole daemon program holding a PTY host, inotify and three local endpoints, and its baseline is measured on a Windows machine before the WSL phase lands.
- **The attached `wsl.exe`:** measured on a Windows machine before the WSL phase lands.
- **The channel's buffers:** bounded by the channel's `h2` settings on each end, every writer sending through the stream's granted capacity, with a 1 MiB stream window and a 16 MiB connection window, a ceiling on each end and never a resident figure at idle.
- **The WSL virtual machine:** runs only while a distribution has work, and stops about 60 seconds after its last distribution stops, which happens about 15 seconds after the WSL server's idle exit 10 minutes after its last work. Its working set with only this work, read before and two minutes after WSL reclaims idle cache toward about 128 MB, is measured on a Windows machine and stated here. The person's `.wslconfig` is never edited. It is not part of the Runtime figure, which counts the service's own processes — the daemon's process tree on Windows plus, for each running WSL server, its `wsl.exe` and its process tree read inside the distribution — because the virtual machine's working set holds other distributions and the person's own WSL work, and it is never drawn on screen.
- **A Codex account with sessions in the distribution** runs its own Codex service there: about 40 MB with one client, plus 17 MB per conversation.

**Workload 3:** one session in a distribution mid-turn streaming, a 50 MB diff read, and a Preview page with hot reload. A small call adds at most 1 ms at the median over the same call to a Windows session (proposed); a 50 MB read through the channel is at least as fast as reading the same file from Windows over `\\wsl.localhost`; a terminal flood keeps the channel open. No session works on another place's disk, so nothing reads across the Windows–WSL file bridge for a session's work.

## Container and Packaging

**Control plane:** Docker container, multi-stage build, Alpine-based.

**Relay:** Docker container, same base image.

**Local daemon:** `sidekicks-daemon`, a signed native binary, beside the `sidekicks` command line. The Linux runtime is `sidekicks-daemon` and `sidekicks` for glibc and musl on x64 and arm64, each archive with its SHA-256, so an Alpine machine or distribution runs it; the musl `sidekicks-daemon` is the dynamic build with `libgcc_s.so.1` and `libpdfium.so` beside it, and the musl `sidekicks` is one static program, since it loads no PDFium. Each Windows installer carries the Linux runtime archives for its architecture, glibc and musl, with their SHA-256, so a WSL 2 distribution's WSL server runs the bytes a Linux user downloads and the first session there works offline. Distributed through GitHub Releases, as a direct download and inside the desktop app's installers, never on npm ([§CI/CD and Release](#cicd-and-release)).

**Desktop app:** Electron app bundling the daemon. The daemon is the person's own background service on every platform, spawned detached or run by the operating system's service manager, never a child of the desktop app. A quit flushes and leaves the service, every run and every shell running; only Runtime's `Stop` and `Restart` end work ([Spec-006](../specs/006-local-ipc-and-daemon-control.md)).

**Background service on a Windows computer:** the service is the native daemon on every Windows computer, with or without WSL, one service per computer, started at logon by a per-user task with Task Scheduler as its parent. Windows clients reach it through one per-user named pipe, and it does key custody, keep-awake, the wake timer and banners in its own process through `sidekicks-platforms`. A session whose project folder is inside a WSL 2 distribution runs there through the WSL server, the `wsl` mode of the Linux `sidekicks-daemon` program, which the daemon starts in that distribution while it has work with one attached `wsl.exe`, inside a Job that lets Windows programs started through interop outlive it, and reaches over one HTTP/2 channel on that `wsl.exe`'s standard input and output; the WSL server exits 10 minutes after its distribution's last work ends ([ADR-039](../decisions/039-sessions-in-wsl-2-distributions.md), [Spec-006 §The service on a Windows computer](../specs/006-local-ipc-and-daemon-control.md#the-service-on-a-windows-computer)).

**CLI:** `sidekicks`, a signed native binary shipped beside the daemon, connecting to the local daemon.

## CI/CD and Release

**Build orchestration:** monorepo with Turborepo over Cargo and pnpm.

**CI:** GitHub Actions — lint, typecheck, test and build, for the Rust crates and the TypeScript packages, on every PR.

**CD:** none run by the project. The person deploys their own relay: the Workers relay into their own Cloudflare account, the Compose relay with its `docker-compose.yml` on their own server ([ADR-019](../decisions/019-v1-deployment-model-and-oss-license.md)).

**Local artifacts:** the desktop app's installers and the daemon's and command line's signed native binaries, built on a release tag by the release workflow, `.github/workflows/release.yml`, which [Plan-020](../plans/020-desktop-app-and-renderer.md) T-020r-6-4 creates, and published to GitHub Releases. Nothing publishes to npm ([ADR-022 §Axis 3](../decisions/022-v1-ci-cd-and-release-automation.md#axis-3--release-automation)).

**Versioning:** semver for packages.

## Related Domain Docs

- [Session Model](../domain/session-model.md)
- [Machine Model](../domain/machine-model.md)
- [User And Device Model](../domain/user-and-device-model.md)

## Related Specs

- [Machine Registration](../specs/002-machine-registration.md)
- [Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md)
- [Remote Control](../specs/027-remote-control.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
- [V1 Deployment Model and OSS License](../decisions/019-v1-deployment-model-and-oss-license.md)
- [Machine Identity Key Custody](../decisions/020-cli-identity-key-storage-custody.md)
- [Sessions In WSL 2 Distributions](../decisions/039-sessions-in-wsl-2-distributions.md)
