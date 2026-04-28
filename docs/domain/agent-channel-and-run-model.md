# Agent Channel And Run Model

## Purpose

Define the core execution and communication primitives used inside a session.

## Scope

This document covers `Agent`, `Channel`, and `Run`, and the relationships among them.

## Definitions

- `Agent`: a configured execution persona bound to a runtime node.
- `Channel`: a session-local communication stream for participants and agents.
- `Run`: a single execution episode performed by one agent.

## What This Is

This model explains how agents exist between runs, how communication surfaces are segmented, and how execution is represented as discrete runs rather than as unbounded thread state.

## What This Is Not

- An agent is not a provider thread id.
- A run is not the same thing as an agent.
- A channel is not the same thing as a session.
- A channel is not a substitute for provenance between runs.

## Invariants

- Every run belongs to exactly one session and exactly one agent.
- An agent can perform many runs over time.
- Every run must publish to at least one channel.
- Channel membership and run ownership are separate concerns.
- Parent-child or peer relationships between runs must be explicit when orchestration is involved.

## Relationships To Adjacent Concepts

- `Agent` executes on a `RuntimeNode`.
- `Run` uses `RepoMount`, `Workspace`, and `Worktree` context when the task is code-bearing.
- `Participant` and `Agent` both contribute messages or events into `Channel` history.
- `QueueItem` can produce a future `Run`.
- `Artifact` and `Approval` are outputs or gate records associated with a `Run`.

## Lifecycle

Agent lifecycle:

| State        | Meaning                                                      |
| ------------ | ------------------------------------------------------------ |
| `configured` | The agent definition exists but is not yet active on a node. |
| `ready`      | The agent is attached to a runtime node and can start runs.  |
| `disabled`   | The agent exists but cannot currently run.                   |
| `archived`   | The agent remains in history but is not used for new runs.   |

Channel lifecycle:

| State | Meaning |
| --- | --- |
| `active` | The channel accepts new communication and run output. |
| `muted` | The channel remains valid but is intentionally suppressed from normal attention surfaces. |
| `archived` | The channel remains historical only. |

Run lifecycle is defined in `run-state-machine.md`.

## Example Flows

- Example: A session contains a `planning` channel and an `implementation` channel. The same agent can author in both channels over time, but each execution episode is a distinct run.
- Example: An orchestrator agent creates a child reviewer run. The reviewer run remains linked to the parent run while publishing output into a review channel.

## Edge Cases

- An agent can exist in `ready` state with no current active run.
- A channel can remain `active` even when it has no current runs if participants continue discussing next steps.
- A run can publish status to one channel while depositing artifacts that are visible from the wider session.

## Related Specs

- [Shared Session Core](../specs/001-shared-session-core.md)
- [Multi Agent Channels And Orchestration](../specs/016-multi-agent-channels-and-orchestration.md)
- [Workflow Authoring And Execution](../specs/017-workflow-authoring-and-execution.md)

## Related ADRs

- [Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
