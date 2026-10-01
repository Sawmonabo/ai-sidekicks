# Runtime Node Model

## Purpose

Define the machine-local execution authority a session runs on — the one machine that executes while the user drives it from any linked device.

## Scope

This document covers `RuntimeNode` ownership, registration, reachability, and its relationship to runs and workspaces.

## Definitions

- `RuntimeNode`: the backend's name for a machine, a computer whose background service (the local daemon) runs sessions. On screen it is the machine's name, and `This machine` on the machine itself.
- Reachability: whether the person's other devices can reach the machine now. It is `Reachable` while the machine's relay connection is up, and `Not reachable` once 45 seconds pass without a frame on it.

## What This Is

A runtime node is the machine where a session's work actually happens. It owns provider processes, tool execution, repo access, and local persistence. It carries no trust level of its own: trust is given per project, never per machine.

It is the "one machine executing" half of the product model. A session runs on exactly one runtime node, the one it was started on, for its whole life, and a person may have any number of machines, each running its own sessions. The user's devices read a session and send it work, but they execute nothing themselves. The desktop app on a computer that runs the service acts with that machine's own key, so the computer is one machine under one name, never a machine and a device ([User And Device Model](./user-and-device-model.md)).

## What This Is Not

- A runtime node is not a user.
- A runtime node is not a device. A device executes nothing.
- A runtime node is not a session.
- A runtime node is not a provider driver.
- A runtime node is not a single run.

## Invariants

- Every runtime node belongs to exactly one user — the account holder whose devices drive it. There is no second owner, and no other account can register it or reach it.
- Execution remains local to the runtime node; the control plane does not become the code-execution authority.
- Machine reachability and run state are separate concerns.
- A runtime node may host multiple agents and runs; what it admits is decided by the memory gate, which starts work while the machine has the memory for it.
- A runtime node is registered with the control plane under its own id and its owning user, never under a session. The service mints that id and the machine's Ed25519 identity key at its first start; the key is kept as its own item in the machine's credential store and never leaves the machine, and it is minted again only when a removed machine is linked again.

## Relationships To Adjacent Concepts

- `User` owns the runtime node.
- A `Session` runs on exactly one runtime node, the one it was started on.
- `Agent` instances are bound to a runtime node for execution.
- `Run` instances execute on a runtime node.
- `RepoMount`, `Workspace`, and `Worktree` are local resources made usable by a runtime node.

## State Model

| State | Meaning |
| --- | --- |
| `reachable` | The machine's connection to the relay is up. Its card reads `Reachable`. |
| `not reachable` | 45 seconds have passed without a frame on the machine's relay connection. Its card reads `Not reachable · last seen <when>`. |

Reachability is read from the machine's relay connection and from nothing else, and nothing about it is written to a session's log. The machine card also shows the service version, and the version range decides whether another device drives the machine or only reads it: each app accepts its own service version and the one before it.

## Example Flows

- Example: The user installs the app on their workstation. At its first start the service mints the machine's id and identity key and reads the computer's own friendly name; at its first connection to the control plane it registers under that id and the user's account, and the user's other devices see it as `Reachable`. Every session started there runs there.
- Example: A runtime node loses provider connectivity but still has local repo access. The machine stays `Reachable`; the failure is reported for that provider and the runs that use it, not as a state of the machine.

## Edge Cases

- A session stays valid while its machine is not reachable; the user's devices show the machine as `Not reachable · last seen <when>`, and nothing queues on their behalf.
- A runtime node can be reachable even when it is currently hosting no agents.
- Removing a machine on the Devices page stops the user's devices reaching it; its sessions stay on it, and it comes back only by linking again, as a new computer joins. Linked again, it first mints a new identity key under its same machine id, and its new `runtimenode.added` moves every device's pin for that id; its store, sessions and id stay. Removing a machine does not touch the account.

## Related Domain Docs

- [User And Device Model](./user-and-device-model.md) — the user who owns the node, and the devices that drive it without executing anything themselves.
- [Trust And Identity](./trust-and-identity.md) — a machine joins the account through the account's statement chain: the first machine opens the chain with a `runtimenode.added` statement it signs itself, and every later machine joins by linking, which records its `runtimenode.added` signed by the device or machine that links it. That is the whole of a machine's identity. What its agents may do is decided by the session's permission level, remembered rules, and the trust given per project and per tool server, never by the machine.

## Related Specs

- [Machine Registration](../specs/002-runtime-node-attach.md)
- [Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md)
- [Remote Control](../specs/028-remote-control.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
