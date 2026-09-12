# Runtime Node Model

## Purpose

Define the machine-local execution authority a session runs on — the one machine that executes while the user drives it from any linked device.

## Scope

This document covers `RuntimeNode` ownership, capabilities, health, and its relationship to runs and workspaces.

## Definitions

- `RuntimeNode`: a session-attached execution authority backed by the user's own local daemon or equivalent runtime service.
- `NodeCapability`: a declared execution or tooling capability that the runtime node can provide.
- `NodeHealth`: the node's availability and operational condition.

## What This Is

A runtime node is the machine where a session's work actually happens. It owns provider processes, tool execution, repo access, local persistence, and machine-scoped trust policy.

It is the "one machine executing" half of the product model. A session is bound to exactly one runtime node at a time; the user's devices read that session and send it work, but they execute nothing themselves. The desktop app running on the same hardware is still a device — the hardware is the runtime node, and the two are separate nouns that happen to share a box ([User And Device Model](./user-and-device-model.md)).

## What This Is Not

- A runtime node is not a user.
- A runtime node is not a device. A device executes nothing.
- A runtime node is not a session.
- A runtime node is not a provider driver.
- A runtime node is not a single run.

## Invariants

- Every runtime node belongs to exactly one user — the account holder whose devices drive it. There is no second owner and no other account that can attach one.
- Execution remains local to the runtime node; the control plane does not become the code-execution authority.
- Node health and run state are separate concerns.
- A runtime node may host multiple agents and runs, subject to explicit capacity policy.
- A runtime node must declare capabilities before those capabilities can be scheduled or granted inside a session.

## Relationships To Adjacent Concepts

- `User` owns the runtime node.
- `Agent` instances are bound to a runtime node for execution.
- `Run` instances execute on a runtime node.
- `RepoMount`, `Workspace`, and `Worktree` are local resources made usable by a runtime node.

## State Model

| State         | Meaning                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `registering` | The node is completing attach and capability declaration.                 |
| `online`      | The node is available for scheduling and execution.                       |
| `degraded`    | The node is reachable but some capabilities are unavailable or unhealthy. |
| `offline`     | The node is not currently reachable.                                      |
| `revoked`     | The node is no longer trusted and may not execute in the session.         |

## Example Flows

- Example: The user opens a session on their workstation and a local Claude-capable runtime node attaches. The node registers its capabilities, becomes `online`, and is then eligible for agent attachment.
- Example: A runtime node loses provider connectivity but still has local repo access. The node moves to `degraded`, and scheduling can still target only the healthy capabilities that remain.

## Edge Cases

- A session stays valid when all of the user's runtime nodes are offline; their devices simply report the machine as unreachable and nothing queues on their behalf.
- A runtime node can be `online` even when it is currently hosting no agents.
- A node can be revoked for one session without implying revocation of the user's entire account identity.

## Related Domain Docs

- [User And Device Model](./user-and-device-model.md) — the user who owns the node, and the devices that drive it without executing anything themselves.
- [Trust And Identity](./trust-and-identity.md) — node attachment is authenticated by the user's identity (which must be at least `bound`), but the node's trust envelope is governed by approval policy, not by identity state. Identity is the cryptographic precondition; node trust is a separate layer.

## Related Specs

- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
