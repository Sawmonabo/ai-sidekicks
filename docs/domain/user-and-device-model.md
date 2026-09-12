# User And Device Model

## Purpose

Define the three nouns Remote Control turns on — the user, the device, and the runtime node — and how a session relates to each.

## Scope

Account identity, device identity and lifecycle, the executing machine, and session ownership. It does not cover the relay, the wire, or any screen.

## Definitions

| Term | What it is | On screen |
| --- | --- | --- |
| **User** | The account holder. One per account. | "you", "your account" |
| **Device** | A connected client of that account — a phone, a laptop app, a second desktop. | **Linked Devices** |
| **Runtime node** | The machine that executes the session. | "this machine" |
| **Session owner** | The user a session belongs to. | — |

## What This Is

One user, many devices, one executing machine per session.

A **user** is the identity everything else hangs off. There is one, and every device and every runtime node in the picture belongs to that one account.

A **device** is a client. It reads the timeline, sends, steers, stops, approves, drives sidekicks, views the diff, and uses the terminal — and it does none of that itself. It asks the runtime node to. A device has its own identity key, minted on the device and kept there, which is what lets the log record not just that the account acted but which device acted.

A **runtime node** is the machine where the work happens: provider processes, the working tree, the shell. A session is bound to exactly one at a time. The desktop app running on that same hardware is still a device; the hardware is still the runtime node. They are two nouns that happen to share a box.

## What This Is Not

- A device is not a runtime node. A device executes nothing.
- A runtime node is not a user. It is owned by one.
- A device is not a second account. Every device is the same user.
- Device liveness is not a roster of anyone else. It says which of the user's own devices are currently reachable, and nothing about anybody else.

## Invariants

- A session has exactly one owner, and that owner is a user.
- A session is bound to at most one runtime node at a time.
- Every device belongs to exactly one user.
- Every runtime node belongs to exactly one user.
- A device's secret identity key never leaves the device.
- A revoked device authenticates nothing further, and the events it already signed stay verifiable.

## Session Ownership

Ownership is derived, not declared. On the daemon, the owner of a session is the actor on that session's first event — whoever started it owns it. On the control plane the same fact is stored directly on the session row, as `sessions.owner_user_id`, so a directory read answers "whose session is this" without replaying anything.

The two are one fact in two places: the daemon derives it from the log it already holds, and the control plane records it because it holds no log to derive it from. Nothing else confers ownership, and ownership does not move.

## Relationships To Adjacent Concepts

- **User → device.** One user, many devices. The link is the registry row, keyed by device id and carrying the device's public identity key.
- **User → runtime node.** One user, one or more machines. A machine attaches to a session; the attachment names the owning user.
- **Session → user.** Exactly one owner.
- **Session → runtime node.** Exactly one binding at a time.
- **Device → runtime node.** No ownership edge at all. A device reaches a runtime node only through the session both are attached to.

## Lifecycle

A device moves through three states and does not come back:

`linked → active → revoked`

- **Linked.** The device has been paired with the account and its public identity key is registered. It has a name and a row in the registry.
- **Active.** The device is reachable and driving. Its per-device liveness reads `online`, and degrades through `reconnecting` to `offline` when heartbeats stop — which is a statement about reachability, not about the lifecycle state.
- **Revoked.** The device's key no longer resolves, any connection it held is closed, and it cannot re-link on the same key. A device that comes back links again as a new device with a new row.

## Example Flows

- `Example: A user starts a session on their laptop. The first event's actor makes that user the owner; the control plane stores the same user on the session row. The laptop is the runtime node and also carries a device.`
- `Example: The user links their phone. The phone mints an identity key, registers its public half, and appears in Linked Devices. It opens the same session and drives it — the work still runs on the laptop.`
- `Example: The phone is lost. From the laptop the user revokes it. The phone's key stops resolving and its connection closes; the messages it sent yesterday are still in the timeline and still verify.`

## Edge Cases

- **The runtime node is offline.** Devices report the machine as unreachable. Nothing queues on their behalf.
- **The last device is revoked from itself.** The account keeps its sessions and its runtime nodes; a new device links from scratch.
- **A device is offline for a long time.** It is still linked and still active; only its liveness reading says offline.

## Related Specs

- [Spec-031: Remote Control](../specs/031-remote-control.md)
- [Spec-003: Runtime Node Attach](../specs/003-runtime-node-attach.md)
