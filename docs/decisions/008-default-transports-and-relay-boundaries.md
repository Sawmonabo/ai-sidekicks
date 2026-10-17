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

The system needs one default local client-to-daemon transport and one coherent position on how another of the user's devices reaches a session: straight across the network, through the relay, or both.

## Problem Statement

What should be the default local transport boundary, and how should the relay fit into remote access?

### Trigger

The IPC and control-plane specs require a concrete transport stance before implementation plans and operations docs can be written.

## Decision

We will use OS-local IPC for client-to-daemon communication on the machine itself. Every other device reaches the machine over its own sealed channel: one Noise channel per device and machine, which carries every method the local transport serves and every event stream. The channel rides one of two carriers, and the same bytes ride either:

- **The direct path,** a WebRTC data channel straight between the device and the machine wherever the two can reach each other: on the home network always, and away from home where both routers allow it. The device's browser or web view opens it through `RTCPeerConnection`, and the machine through `str0m`; a desktop app on another computer reaches the machine through its own service, service to service.
- **The person's own relay** otherwise, which sees only ids, the channel profile, frame sizes and times.

The device always opens on the relay, and that connection stays open while its app is open: it carries reachability, presence, the direct path's setup, which travels inside the sealed channel, and the fallback. A connection moves onto the direct path with a cut-over frame and back to the relay through the reconnect recovery, losing, repeating and reordering nothing, and nothing on any screen says which carrier is in use ([Spec-027 §The direct path](../specs/027-remote-control.md#the-direct-path)). There is no TURN server: the relay is the fallback. The control plane's authenticated network transport serves its own work only: sign-in, the account's statement chain, device linking, machine registration, and the push notices each machine has already sealed. Neither carrier is an execution path.

## Alternatives Considered

### Option A: OS-Local IPC + A Direct Path, With The Relay As The Fallback (Chosen)

- **What:** Use local sockets or pipes on the machine itself; for every other device, one sealed channel carried straight across the network where the device and the machine can reach each other and through the person's own relay otherwise; and network control-plane APIs for account and registration work.
- **Steel man:** A frame between a phone and a computer on the same Wi-Fi never travels to the relay's region and back, while the machine still needs no address a device can reach in advance: the setup rides the relay connection inside the sealed channel, so the machine never advertises itself on the network. Reachability, presence and the one-connection-per-key rule stay facts of the one relay connection, so the direct path adds no second answer to whether a machine can be reached. The trust decision is still the one `KK` handshake against the account's statement chain on both carriers, and the only new surface is a UDP socket, open only while a device is on the direct path, that answers nothing but an ICE check carrying the password exchanged inside the sealed channel.
- **Weaknesses:** Two carriers to test, a cut-over that must lose nothing, a WebRTC library on the machine whose DTLS layer has had no outside audit, and operating-system prompts for the local network on macOS, Windows and, once Chrome ships its checks, the web client at home.

### Option B: Loopback Network For All Local And Remote Paths (Rejected)

- **What:** Use loopback HTTP or WebSocket even for local client-daemon traffic.
- **Steel man:** Simpler transport stack and easier browser compatibility.
- **Why rejected:** Weaker local boundary and poorer fit for desktop-supervised daemon control.

### Option C: Relay For Every Other Device (Rejected)

- **What:** Carry every channel through the person's own relay, with no direct path.
- **Steel man:** One carrier, one place every frame passes, no UDP socket on the machine and no operating-system prompt for the local network.
- **Why rejected:** A phone on the same Wi-Fi as the machine would send every frame to the relay's region and back: a 100-byte frame's round trip through a Workers relay object was measured at 130.1 ms at the median ([Deployment Topology §Relay Cost And Delay](../architecture/deployment-topology.md#relay-cost-and-delay)), where the same Wi-Fi's direct path targets 10 ms. The direct path keeps reachability on the relay connection and the trust decision in the one handshake, so it costs no second reachability fact and no second trust record.

A direct path with no relay, with a TURN server where no direct pair forms, is [ADR-019 Option E](./019-v1-deployment-model-and-oss-license.md#option-e-peer-to-peer-with-stunturn-and-no-relay-rejected), rejected there.

## Reversibility Assessment

- **Reversal cost:** Moderate. Transport clients, daemon endpoints, and operations guidance would need revision.
- **Blast radius:** Desktop main process, CLI, daemon startup, relay flows, the direct path's peer and its cut-over, and security assumptions.
- **Point of no return:** After the client SDK, daemon supervisor, and operations docs all assume the chosen default transports.

## Consequences

### Positive

- Stronger local security posture for daemon control
- Clearer distinction between local execution transport and remote-access transport
- A device near the machine reaches it without the relay's round trip, with nothing to turn on

### Negative (accepted trade-offs)

- More transport code paths to test
- Browser-only local clients are less natural than with loopback-first design
- The machine opens a UDP socket per direct peer and, while a device is away from home, asks its router for a port mapping

### Unknowns

- Whether the iPhone app's web view needs the Local Network permission for WebRTC; the iPhone app's probe decides.
- When Chrome turns on its Local Network Access checks for WebRTC; until then the web client at home asks nothing, and after it Chrome's own prompt appears once per site.
- How often a direct path forms away from home with STUN and a router's port mapping alone; the direct path's NAT matrix measures it.

## References

### Research Conducted

| Source | Type | Key Finding | URL/Location |
| --- | --- | --- | --- |
| `specs/006-local-ipc-and-daemon-control.md` | Canonical spec | Local daemon control should default to OS-local IPC | [specs/006-local-ipc-and-daemon-control.md](../specs/006-local-ipc-and-daemon-control.md) |
| `architecture/security-architecture.md` | Canonical architecture doc | Both remote carriers are treated as less trusted than local IPC | [architecture/security-architecture.md](../architecture/security-architecture.md) |
| RFC 8827 §6.5, RFC 8831 §6.1 | Standard | Every WebRTC data channel is secured by DTLS, which cannot be turned off; the sealed channel runs inside it | <https://www.rfc-editor.org/rfc/rfc8827>, <https://www.rfc-editor.org/rfc/rfc8831> |
| RFC 8445 §5.3 | Standard | ICE's password carries at least 128 random bits, so the machine's socket answers only a check that carries it | <https://www.rfc-editor.org/rfc/rfc8445> |

### Related Domain Docs

- [User And Device Model](../domain/user-and-device-model.md)
- [Machine Model](../domain/machine-model.md)

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
