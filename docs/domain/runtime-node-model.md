# Runtime Node Model

## Purpose

Define the machine-local execution authority that participants contribute to a session.

## Scope

This document covers `RuntimeNode` ownership, capabilities, health, and its relationship to runs and workspaces.

## Definitions

- `RuntimeNode`: a session-attached execution authority backed by a participant-controlled local daemon or equivalent runtime service.
- `NodeCapability`: a declared execution or tooling capability that the runtime node can provide.
- `NodeHealth`: the node's availability and operational condition.

## What This Is

A runtime node is the bridge between shared collaboration state and local execution. It owns provider processes, tool execution, repo access, local persistence, and machine-scoped trust policy.

## What This Is Not

- A runtime node is not a participant.
- A runtime node is not a session.
- A runtime node is not a provider driver.
- A runtime node is not a single run.

## Invariants

- Every runtime node has exactly one owning participant.
- Execution remains local to the runtime node; the shared control plane does not become the code-execution authority.
- Node health and run state are separate concerns.
- A runtime node may host multiple agents and runs, subject to explicit capacity policy.
- A runtime node must declare capabilities before those capabilities can be scheduled or granted inside a session.

## Relationships To Adjacent Concepts

- `Participant` owns the runtime node.
- `Agent` instances are bound to a runtime node for execution.
- `Run` instances execute on a runtime node.
- `RepoMount`, `Workspace`, and `Worktree` are local resources made usable by a runtime node.
- `Membership` controls whether a participant is allowed to attach a runtime node to a session.

## State Model

| State         | Meaning                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| `registering` | The node is completing join and capability declaration.                   |
| `online`      | The node is available for scheduling and execution.                       |
| `degraded`    | The node is reachable but some capabilities are unavailable or unhealthy. |
| `offline`     | The node is not currently reachable.                                      |
| `revoked`     | The node is no longer trusted or allowed to participate in the session.   |

## Example Flows

- Example: A participant joins an active session and contributes a local Claude-capable runtime node. The node registers its capabilities, becomes `online`, and is then eligible for agent attachment.
- Example: A runtime node loses provider connectivity but still has local repo access. The node moves to `degraded`, and scheduling can still target only the healthy capabilities that remain.

## Edge Cases

- A participant may remain an active session member when all of their runtime nodes are offline.
- A runtime node can be `online` even when it is currently hosting no agents.
- A node can be revoked for one session without implying revocation of the participant's entire account identity.

## Related Domain Docs

- [Trust And Identity](./trust-and-identity.md) — node attachment is authenticated by the participant's identity (which must be at least `bound`), but the node's trust envelope is governed by approval policy, not by identity state. Identity is the cryptographic precondition; node trust is a separate layer.

## Related Specs

- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)

## Related ADRs

- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
