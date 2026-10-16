# Agent And Run Model

## Purpose

Define the core execution primitives used inside a session, the agent and the run, and how agents in one session reach each other.

## Scope

This document covers `Agent` and `Run`, and the relationships between them.

## Definitions

- `Agent`: a lasting identity in a session — the lead, or a helper keyed by its handle — bound to a provider (its driver, model, effort and account), running on the machine that runs the session, with many runs over time.
- `Conversation`: the provider's own ongoing exchange with one agent (a Claude Code session, a Codex thread), idle between turns and never completed.
- `Run`: one stretch of one agent's work, started by a send or a launch, ending once in `completed`, `failed` or `stopped`; an `interrupted` or `paused` run is not over, and a send continues it.
- `Turn`: the provider's own unit, and a run holds one or more ([Run State Machine](run-state-machine.md)).

## What This Is

This model explains how agents exist between runs, how agents in one session reach each other through the session itself, and how execution is represented as discrete runs rather than as unbounded thread state.

## What This Is Not

- An agent is not a provider thread id: the provider's thread or session is the agent's conversation.
- A run is not the same thing as an agent.
- An agent reaching another agent of the same session is not a direct run-to-run message: it goes through persisted run links, the session transcript, artifact references or approvals.

## Invariants

- Every run belongs to exactly one session and exactly one agent.
- An agent can perform many runs over time.
- Every run publishes into its session's one transcript.
- Parent-child or peer relationships between runs must be explicit when orchestration is involved.

## Relationships To Adjacent Concepts

- `Agent` executes on the machine that runs its session (`RuntimeNode`).
- `Run` uses `RepoMount`, `Workspace`, and `Worktree` context when the task is code-bearing.
- `User` and `Agent` both contribute messages or events into the `Session` transcript.
- `QueueItem` can produce a future `Run`.
- `Artifact` and `Approval` are outputs or gate records associated with a `Run`.

## Lifecycle

An agent keeps no lifecycle state of its own: it is in its session or it is not, it is idle before its first run, and what it is doing is its newest run's state. A send to an agent whose run has ended starts its next run on the same conversation, where the provider takes one; a provider's own helper keeps its identity across its runs by the handle the daemon mints once from the provider's own helper id, which is the whole of its identity, and its card shows its newest run ([Run State Machine](run-state-machine.md)). There is no attach or detach verb: a session's main agent is the one it starts with, and every other agent in the session arrives because that one delegated to it or because the person named one from the composer's `/` list in a message to the main agent, each recorded by the daemon on the session's own agent tree index as it starts; a provider's own subagent has no persona record of its own, only that handle ([Spec-014 §Interfaces And Contracts](../specs/014-multi-agent-orchestration.md#interfaces-and-contracts)). The agent persona (`name`, `driverName`, `modelId`, `config?`, `providerAccountId?`, `effort?`, `toolAllowlist?`, `instructions?`, `goal?`) is durable from the record of the agent's own start — `session.created` for the session's main agent, the `run.queued` of the run that starts any other — and the provider-binding events settle each later switch of its binding — `providerAccountId`, `effort`, and the axes an agent definition resolves into, `toolAllowlist` and `instructions` (Plan-024), sit outside `config` because code beyond the driver reads them; and `driverName`, `modelId`, and `effort` are mutable axes of `agent.configUpdate`, which carries no account, applied at the next boundary the axis permits, not facts fixed when the run started ([Spec-014 §Same-Agent Provider Switch](../specs/014-multi-agent-orchestration.md#same-agent-provider-switch)) ([Spec-005 §Agent Lifecycle](../specs/005-session-event-taxonomy-and-audit-log.md#agent-lifecycle-session_lifecycle)).

Run lifecycle is defined in `run-state-machine.md`. A child run's link to its parent records how the child was reached, `reachedBy`: `provider_subagent` (the provider's own subagent), `bridge_run` (a bridge `agent_run` call) or `workflow_step` (a workflow's `agent.run` step) ([Spec-014 §Interfaces And Contracts](../specs/014-multi-agent-orchestration.md#interfaces-and-contracts), D-013-12). The provider driver writes the `provider_subagent` link when the provider reports its own subagent starting and stopping. The record is internal: the screen shows the agent tree, each child's provider and model, and `via <agent>`, never how a child was reached — and the runtime adds no nesting limit of its own: a child run may create child runs of its own, and those may create their own. How deep agents may nest is the provider's own limit under the person's own provider settings, a provider's refusal is shown in its own words, and the session's spend limit, each run's token limit and every approval and visibility rule bind at every level ([Spec-014 §Default Behavior](../specs/014-multi-agent-orchestration.md#default-behavior)).

## Example Flows

- Example: A person asks the main agent to plan a change and then build it. The same agent does both over time in the session, and each execution episode is a distinct run.
- Example: An orchestrator agent creates a child reviewer run through a bridge `agent_run` call. The reviewer run stays linked to the parent run, recorded as reached by that call, and shows as a row in the parent's transcript where it was dispatched, a row in the session's agent list, and its own child view.

## Edge Cases

- An agent can be in its session with no current active run.

## Related Specs

- [Session Core](../specs/001-session-core.md)
- [Multi-Agent Orchestration](../specs/014-multi-agent-orchestration.md)
- [Workflow Authoring And Execution](../specs/015-workflow-authoring-and-execution.md)

## Related ADRs

- [Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
