# Glossary

## Purpose

Define the stable vocabulary for the greenfield product so later specs, ADRs, and implementation plans use one meaning for each core term.

## Scope

This glossary covers the primary domain terms from `vision.md` and the canonical domain foundation.

## Definitions

| Term | Definition |
| --- | --- |
| `Session` | The primary container for agents, runs, queue items, workspaces, artifacts, and approvals, owned by one user and run by one machine for its whole life. |
| `User` | The account holder — the single human actor a session belongs to, with one stable identity across every device they connect from. |
| `Device` | A connected client of that account — a phone, a laptop app, a second desktop. Listed on screen on the **Devices** page of Settings. Defined in [User And Device Model](./user-and-device-model.md). |
| `Presence` | The ephemeral liveness of one of the user's own devices or runtime nodes — which of them are currently reachable. It is never a roster of other people. |
| `RuntimeNode` | The machine that executes a session's work, owned by the user. |
| `Agent` | A configured execution persona inside a session, used to perform runs. Code and docs say agent for the concept; "sidekick" is the brand and the word a person reads on screen. |
| `AgentDefinition` | A saved, reusable agent configuration the Sidekicks destination lists; a run started under one keeps the configuration it was resolved for. |
| `Run` | A single execution episode performed by one agent inside one session. |
| `RuntimeBinding` | An association between a `Run` and a specific provider driver instance. Fields: `driver_name`, `contract_version`, `resume_handle`, `runtime_metadata`. Persists recovery handles so a run can be resumed after interruption. Created by Plan-003 (provider driver contract), extended by Plan-012 for recovery. Stored in the `runtime_bindings` SQLite table. See [Spec-004](../specs/004-provider-driver-contract-and-capabilities.md) and [Spec-013](../specs/013-persistence-recovery-and-replay.md). |
| `QueueItem` | A persisted unit of deferred work awaiting admission into the run engine. |
| `Intervention` | An auditable control action that changes, redirects, pauses, resumes, or cancels active or queued work. |
| `RepoMount` | A git repository attached to the machine as a project's folder, once per machine; every session of that project binds to it. A chat's managed workspace is a mount too, owned by its one chat. |
| `Workspace` | A session's execution context, rooted at one checkout: the project's checkout, a worktree the daemon made, or a chat's managed workspace. |
| `Worktree` | An isolated checkout derived from a repository and typically used as the default write target for coding runs. |
| `ExecutionMode` | Where a session's runs work: `bound-root`, the root already bound to its workspace (the project's checkout, or a chat's managed workspace), or `provisioned-worktree`, a worktree the daemon's worktree lifecycle made or reused. There is no disposable copy and no read-only place: how much a session may change is its permission level, not its execution mode. |
| `Artifact` | An immutable output or record produced by a run, a user, or the system. |
| `Approval` | A durable decision record that resolves a gated request. |
| `Workflow` | A reusable, versioned execution template that structures multi-step work inside a session. |
| `WorkflowDefinition` | The named, durable record of one workflow: the document an author wrote and the chain of immutable versions of it. Scoped `session`, `project` or `shared`. |
| `WorkflowVersion` | An immutable snapshot of a `WorkflowDefinition`'s document body at a point in time, addressed by that body's content hash. |
| `WorkflowRun` | A single execution instance of a specific `WorkflowVersion` within a session. |
| `WorkflowDocument` | The authored body of a workflow: one JSON document holding exactly one trigger node, the rest of the graph as nodes, and the edges between them. Every kind the runtime offers is a node, and nothing is compiled into a second shape when the document is saved. |
| `WorkflowStep` | The runtime record of one attempt of one node, keyed by the run, the node and the attempt number, carrying that attempt's status, timings, input, output and log. |
| `Gate` | A point where a workflow run waits for the person: a `human.approval` step, or a chain's question before it starts more runs. The answer is recorded in `workflow_gate_resolutions`, and the run goes on or stops by it. |
| `local-only` | An operating constraint meaning the relevant session continuity or execution path remains usable on the user's own local runtime node without requiring current control-plane reachability. `local-only` is not a separate domain object or an alternate session model. |
| `Transcript` | The session's own record of its conversation, written by the daemon and drawn on screen in order: messages, tool calls, approvals and replies. There is no replay surface over it: scrollback is scrollback, and a person scrolls it. |
| `Conversation file` | The provider's own on-disk record of a session's conversation, kept under the credential home it runs in (Claude Code writes `projects/<project folder>/<session id>.jsonl`). An account switch copies this one file into the new account's home and resumes it there through the provider's own resume; nothing is re-sent as text. |
| `Memory files` | The instruction files a provider reads from its home and the project at a session's start: `CLAUDE.md` and the memory folder on Claude Code, `AGENTS.md` on Codex. `providerAccount.memoryImport` copies the person's ambient store of them into a named account's home once. |

## What This Is

This glossary is the term index for the product documentation.

## What This Is Not

This glossary is not a substitute for the detailed domain docs. Each term is defined briefly here and expanded in its own document.

## Invariants

- Each term must have one canonical meaning across the documentation set.
- A spec uses the glossary's term for a concept, never a near-synonym.
- A new term that overlaps an existing one says how the two differ.
- Canonical prose spelling is `local-only`; do not introduce `local_only` unless a later API or wire contract explicitly defines that literal.

## Relationships To Adjacent Concepts

- `Session` is the top-level container.
- `Agent`, `Run`, `QueueItem`, `Workspace`, `Artifact`, and `Approval` are all session-scoped concepts. `User`, `Device`, and `RuntimeNode` are account-scoped, and a `RepoMount` belongs to its machine; each appears inside a session by reference.
- `Worktree` is a specialized repository execution root inside a `Workspace`; it is not a synonym for `Workspace`.
- `ExecutionMode` determines how a `Run` uses a repo-bound `Workspace`.
- `Run` is an execution episode and `Agent` is the live actor inside a session that performs it; `AgentDefinition` is the saved, reusable configuration an `Agent` is resolved from.
- `RuntimeBinding` ties a `Run` to a specific provider driver instance and carries the recovery handles needed for persistence and replay.
- `Workflow` is a reusable execution template. `WorkflowDefinition` records the template; `WorkflowVersion` is an immutable snapshot; `WorkflowRun` is an execution instance inside a `Session`.
- `WorkflowDocument` is the body a `WorkflowVersion` snapshots, and each of its nodes is one step a run executes; a `WorkflowStep` records one attempt of one node; a `Gate` is a `human.approval` step or a chain's question, and the run waits on it until the person answers.
- `local-only` may describe session continuity or execution scope, but it does not define a second kind of `Session`.

## Lifecycle

The glossary changes with the domain docs: each entry carries the same meaning as the term's own domain doc.

## Example Flows

- Example: The user opens a session from a linked device on the machine that runs it, and an agent run starts in the session's worktree.
- Example: A queued follow-up becomes a `QueueItem`; when its run starts, the user steers it with an `Intervention`, and a tool call the run makes waits on an `Approval`.

## Edge Cases

- A session may exist without active runs.
- A workspace may exist without a worktree when its session runs `bound-root` in the project's checkout or a chat's managed workspace; a new project session starts in a worktree of its own.

## Related Specs

- [Session Core](../specs/001-session-core.md)
- [Machine Registration](../specs/002-machine-registration.md)
- [Queue Steer Pause Resume](../specs/003-queue-steer-pause-resume.md)
- [Repo Attachment And Workspace Binding](../specs/007-repo-attachment-and-workspace-binding.md)
- [Provider Driver Contract And Capabilities](../specs/004-provider-driver-contract-and-capabilities.md)
- [Approvals Permissions And Trust Boundaries](../specs/010-approvals-permissions-and-trust-boundaries.md)
- [Persistence Recovery And Replay](../specs/013-persistence-recovery-and-replay.md)
- [Workflow Authoring And Execution](../specs/015-workflow-authoring-and-execution.md)

## Related ADRs

- [Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
