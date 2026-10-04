# User And Device Model

## Purpose

Define the three nouns Remote Control turns on — the user, the device, and the runtime node — and how a session relates to each.

## Scope

Account identity, device identity and lifecycle, the executing machine, and session ownership. It does not cover the relay, the wire, or any screen.

## Definitions

| Term | What it is | On screen |
| --- | --- | --- |
| **User** | The account holder. One per account. | "you", "your account" |
| **Device** | A phone or a browser linked to that account to reach its sessions. | **Devices** |
| **Runtime node** | A machine: a computer whose background service runs sessions. The desktop app on that computer acts with the machine's own key. | The machine's name; `This machine` on the machine itself; **Machines** |
| **Session owner** | The user a session belongs to. | — |

## What This Is

One user, many devices, one executing machine per session.

A **user** is the identity everything else hangs off. There is one, and every device and every runtime node in the picture belongs to that one account.

A **device** is a client. It reads the transcript, sends, steers, stops, approves, drives agents, views the diff, and uses the terminal — and it does none of that itself. It asks the runtime node to. A device has its own identity key, minted on the device and kept there, which is what lets the log record not just that the account acted but which device acted.

A **runtime node** is the machine where the work happens: provider processes, the working tree, the shell. A person may have any number of machines. A session runs on exactly one of them, the one it was started on, for its whole life. The desktop app on that computer acts with the machine's own key, so the computer is one machine under one name, never a machine and a device.

## What This Is Not

- A device is not a runtime node. A device executes nothing.
- A runtime node is not a user. It is owned by one.
- A device is not a second account. Every device is the same user.
- Presence is not a list of anyone else. A device's `Connected now` says only whether that one of the user's own devices holds a relay connection this moment, and nothing about anybody else.

## Invariants

- A session has exactly one owner, and that owner is a user.
- A session runs on exactly one runtime node, the one it was started on, for its whole life.
- Every device belongs to exactly one user.
- Every runtime node belongs to exactly one user.
- A device's secret identity key never leaves the device.
- A revoked device authenticates nothing further, and the events it already sent stay in the log, recorded as sent from that device.
- A key is trusted only through the account's statement chain, which every machine verifies itself. The control plane's own view of who may use the relay is for spam and cost only; a machine's refusal in the handshake is what protects the sessions.
- Every linked device reads and acts on everything. There is no per-device permission and no view-only device; a device that should not act is revoked.

## Session Ownership

Ownership is derived, not declared. One account owns the machine, so the owner of every session on it is that account's user. Nothing is stored or checked per session: an event records the device it came from, never a person, and the control plane keeps no session record, so there is no second copy to keep in step. Ownership does not move.

## Relationships To Adjacent Concepts

- **User → device.** One user, many devices. The link is a `device.linked` statement on the account's statement chain, signed by a device or machine the chain already trusts and carrying the device's public identity key.
- **User → runtime node.** One user, any number of machines. The first machine opens the account's statement chain with a `runtimenode.added` statement it signs itself; every later machine joins by linking, which records its `runtimenode.added` signed by the device or machine that links it. The machine's registration names the owning user.
- **Session → user.** Exactly one owner.
- **Session → runtime node.** Exactly one machine, for the session's whole life.
- **Device → runtime node.** No ownership edge at all. A device trusts every machine the chain trusts, holds one encrypted channel to each machine it can reach, and opens a session by asking each machine whether it holds it.

## Lifecycle

A device moves through three states and does not come back:

`linked → active → revoked`

- **Linked.** A device or machine the account already trusts has signed a `device.linked` statement for the device's public identity key, after the same six digits were confirmed on both screens. The device has a name and a card on the Devices page.
- **Active.** The device is reachable and driving. Its card reads `Connected now` while it holds a relay connection this moment, and `Last seen <when>`, the end of its last one, otherwise — a statement about reachability read from the relay connection itself, with no heartbeat, and not about the lifecycle state.
- **Revoked.** A `device.revoked` statement ends the device's key at that point in the chain: any connection it held is closed, every machine refuses a statement the key signs afterward from the time it hears of it, and what the key signed before stands, so every device it linked stays linked, its card reading `Linked from <device>, which you revoked. Revoke it if that device was lost.` An ended key is never trusted again, so the same key never links again. The card moves to the `Revoked` group, where `Forget` removes it. A device that comes back links again as a new device with a new key.

## Example Flows

- `Example: A user starts a session on their laptop. The laptop's account is the user's, so the user owns the session, and the laptop's daemon holds it. The laptop is the runtime node, and its desktop app acts with the laptop's own key, so the laptop is one machine card and never also a device.`
- `Example: The user links their phone. The phone mints an identity key, the laptop signs a device.linked statement for its public half, and the phone appears under Devices on the laptop's Settings › Devices. It opens the same session and drives it — the work still runs on the laptop.`
- `Example: The phone is lost. From the laptop the user revokes it. The phone's key stops resolving and its connection closes; the messages it sent yesterday are still in the transcript, recorded as sent from the phone.`

## Edge Cases

- **The runtime node is offline.** Devices report the machine as unreachable. Nothing queues on their behalf.
- **The last device is revoked from itself.** The account keeps its sessions and its runtime nodes; a new device links with a passkey, or from a machine's own Devices page.
- **A device is offline for a long time.** It is still linked and still active; only its card's `Last seen <when>` says how long.

## Related Specs

- [Spec-027: Remote Control](../specs/027-remote-control.md)
- [Spec-002: Machine Registration](../specs/002-machine-registration.md)
