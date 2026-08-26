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

This 4-state enum is the canonical `AgentState` adopted verbatim by the Plan-016 contract surface (Tier-6 audit, A-016-2). V1 wire mapping: `agent.attach` lands the agent in `ready` (or `configured` when its named default node is not currently attached); `agent.detach` → `disabled`; re-attach → `ready`; `archived` is registered in the contract enum but no V1 wire mutation reaches it. Only a `ready` agent can take a run (`agent.not_ready` otherwise). The agent persona (`name`, `driverName`, `modelId`, `defaultNodeId?`, `config?`, `providerAccountId?`, `effort?`, `executionPostureMode?`, `toolAllowlist?`, `instructions?`, `goal?`) is durable via `agent.*` events — the `providerAccountId?` / `effort?` pair added 2026-08-26 (D-016-26) and the four resolved-definition axes added 2026-08-26 (CP-030-7), each named rather than counted so this enumeration stops tracking a position that moves; all six outside `config` because surfaces beyond the driver read them; and `driverName`, `providerAccountId`, `modelId`, and `effort` are mutable axes of `agent.configUpdate` applied at the next boundary the axis permits, not facts fixed at attach ([Spec-016 §Same-Agent Provider Switch](../specs/016-multi-agent-channels-and-orchestration.md#same-agent-provider-switch)) ([Spec-006 §Channel and Agent Lifecycle](../specs/006-session-event-taxonomy-and-audit-log.md#channel-and-agent-lifecycle-session_lifecycle)).

Channel lifecycle:

| State | Meaning |
| --- | --- |
| `active` | The channel accepts new communication and run output. |
| `muted` | The channel remains valid but is intentionally suppressed from normal attention surfaces. |
| `archived` | The channel remains historical only. |

Transitions (Tier-6 audit, D-016-12): `active` ↔ `muted` via `channel.mute` / `channel.unmute`; `active` or `muted` → `archived` via `channel.archive` (terminal). Run admission targeting an `archived` channel is refused (`channel.inactive`); a `muted` channel still accepts runs and output — mute suppresses attention surfaces, not execution. The bootstrap `main` channel is projected from the session itself (`deriveMainChannelId`, CP-002-7), never has a stored row or `channel.created` event, and is not mutable by the lifecycle verbs.

Run lifecycle is defined in `run-state-machine.md`. Parent-child run links carry one of three caller-declared link types — `spawn`, `delegate`, `handoff` ([Spec-016 §Interfaces And Contracts](../specs/016-multi-agent-channels-and-orchestration.md#interfaces-and-contracts), D-016-17) — and V1 nesting is depth-1.

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
