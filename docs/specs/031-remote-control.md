# Spec-031: Remote Control

| Field                   | Value                                                      |
| ----------------------- | ---------------------------------------------------------- |
| **Status**              | `draft`                                                    |
| **NNN**                 | `031`                                                      |
| **Slug**                | `remote-control`                                           |
| **Date**                | `2026-09-11`                                               |
| **Author(s)**           | `Sawmon Abo`                                               |
| **Implementation Plan** | [Plan-031: Remote Control](../plans/031-remote-control.md) |

## Purpose

One user, many linked devices, one machine executing; any device can do everything the desktop can, including read the timeline, send, steer, stop, approve, drive sidekicks, view the diff, and use the terminal. No other people.

## Scope

Remote Control covers the whole path from a device that is not the executing machine to the session running on that machine, and the parity bar that path must meet. A device gets all of:

- read the live timeline and session history
- send a message
- steer a run in flight
- stop a run
- answer an approval
- attach, configure, and drive sidekicks
- view the diff
- open and use the terminal

The mechanism is device linking, an encrypted relay through the control plane, a method proxy from the device to the runtime node, and per-device attestation of what a device did.

## Non-Goals

- **Other people in a session.** A session belongs to one user. Remote Control adds devices, not people, and nothing here admits a second account to a session.
- **A second executing machine per session.** One session executes on one runtime node. Sending work to a different machine is cross-node dispatch, owned by [Plan-027](../plans/027-cross-node-dispatch-and-approval.md).
- **Frontend.** The screens named below are the contract the frontend will build against. No screen work belongs to this spec; Plan-031 Phase 7 owns it and starts only after the phases under it have merged.

## Required Behavior

### One user, N devices, one host machine

A session has exactly one owner, and that owner is the user. Every device is a client of that same account — a phone, a laptop app, a second desktop. Devices do not execute anything; they drive the one runtime node the session is bound to, which is the machine the work actually runs on. The desktop app sitting beside the runtime node is itself a device; it is not privileged over a phone, and the runtime node is a separate noun from the device that happens to share its hardware.

### Device registration and revocation

A device is linked once. Linking mints the device's own identity key, registers its public half against the user, and gives the device a name that the user can change later. Every linked device appears in one list, with its name, what kind of device it is, when it was linked, and when it was last seen. Any non-revoked device can revoke any other, including itself, and revocation is immediate: the revoked device's key stops authenticating and any relay connection it holds is closed. A revoked device cannot re-link on the same key; it links again as a new device.

### Parity by construction

The client SDK swaps its local pipe for the relay. Every surface already speaks the SDK, so a device gets parity because the transport underneath changed, not because each screen was re-implemented for remote use. The consequence is the bar: a method that works over the local pipe and not over the relay is a defect in the transport, never a feature a device does not have. Parity is proven by running one suite against both transports rather than by enumerating screens.

### The encryption envelope

Traffic is end-to-end encrypted between the user's devices and the user's machine. The control plane carries ciphertext and forwards it; it does not hold the keys, cannot read a frame, and stores no plaintext. Each endpoint holds a long-term identity key and posts a signed per-session ephemeral public key; each pair of endpoints derives a pairwise key from those, and every frame is sealed to exactly one recipient and rejected if it replays an earlier sequence number.

Relay access expires. Negotiation hands a device a relay endpoint and a short-lived connect token bound to that one session, so a token replayed against another session fails cryptographically rather than by a check a verifier could skip. The relay is a live forwarder, not a mailbox: it holds a frame only for as long as the connection carrying it, and nothing survives both endpoints disconnecting.

### Host offline

When the runtime node is unreachable, a device says so plainly — the machine is offline — rather than appearing to work. Nothing is queued on the control plane beyond the envelope's expiry, so there is no backlog to drain when the machine returns and no illusion that a message sent into a dark session will be delivered later. What the device already holds stays readable; anything that needs the machine refuses with an unreachable result and is retried by the user once the machine is back.

## Interfaces And Contracts

Described here, not schematized; the shapes belong to Plan-031.

- **A device registry.** One durable row per linked device: its id, its name, its kind, when it was linked, when it was last seen, its public identity key, and whether it has been revoked. The registry is the single answer to "which devices can act as me".
- **`device.*` methods.** `device.list`, `device.link`, `device.rename`, `device.revoke`. Reachable from any non-revoked device, and from the CLI.
- **An in-session connected-devices banner.** A small in-session surface naming the devices currently connected to this session, so it is never a surprise that a second screen is watching or driving.
- **The Settings → Linked Devices screen.** The registry rendered: list, rename, revoke, and link a new device.

## Fallback Behavior

- The runtime node is unreachable: the device reports the machine as offline, reads stay available from what the device already has, and writes refuse rather than queue.
- The relay is unreachable but the device is the desktop app on the same machine: it uses the local pipe and keeps working.
- A device's connection drops: its liveness degrades from online through reconnecting to offline, and it re-derives session keys on reconnect.
- A device has been revoked: its next call takes a terminal refusal, not a retry loop, and its screen says it was revoked.

## Open Questions

- Where a device's identity key is stored on a phone, and what protects it there.
- Whether a device name is local to the device or synced across the account.
- Whether there is a ceiling on how many devices one account may link at once.
- What a device shows for a session whose runtime node has been offline long enough that its own cached history is stale.

## References

- [Spec-003: Runtime Node Attach](003-runtime-node-attach.md) — how a machine binds to a session.
- [Spec-018: Identity Keys](018-identity-and-user-state.md) — identity-key custody and registration.
- [Plan-027: Cross-Node Dispatch And Approval](../plans/027-cross-node-dispatch-and-approval.md) — the consumer of the relay this spec defines.
- [Plan-031: Remote Control](../plans/031-remote-control.md) — the implementation plan for this spec.
