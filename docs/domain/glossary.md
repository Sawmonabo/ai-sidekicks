# Glossary

## Purpose

Define the stable vocabulary for the greenfield product so later specs, ADRs, and implementation plans use one meaning for each core term.

## Scope

This glossary covers the primary domain terms from `vision.md` and the canonical domain foundation.

## Definitions

| Term | Definition |
| --- | --- |
| `Session` | The primary container for runtime nodes, channels, agents, runs, queue items, repo mounts, artifacts, and approvals, owned by one user. |
| `User` | The account holder — the single human actor a session belongs to, with one stable identity across every device they connect from. |
| `Device` | A connected client of that account — a phone, a laptop app, a second desktop. Shown on screen as **Linked Devices**. Defined in [User And Device Model](./user-and-device-model.md). |
| `Presence` | The ephemeral liveness of one of the user's own devices or runtime nodes — which of them are currently reachable. It is never a roster of other people. |
| `RuntimeNode` | The machine that executes a session's work, owned by the user. |
| `Channel` | A communication surface inside a session where the user and agents, or agents and other agents, exchange messages or coordination events. |
| `Agent` | A configured execution persona bound to a runtime node and used to perform runs. |
| `Run` | A single execution episode performed by one agent inside one session. |
| `RuntimeBinding` | An association between a `Run` and a specific provider driver instance. Fields: `driver_name`, `contract_version`, `resume_handle`, `runtime_metadata`. Persists recovery handles so a run can be resumed after interruption. Created by Plan-005 (provider driver contract), extended by Plan-015 for recovery. Stored in the `runtime_bindings` SQLite table. See [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) and [Spec-015](../specs/015-persistence-recovery-and-replay.md). |
| `QueueItem` | A persisted unit of deferred work awaiting admission into the run engine. |
| `Intervention` | An auditable control action that changes, redirects, pauses, resumes, or cancels active or queued work. |
| `RepoMount` | A repository attached to a session as a source of work and artifacts. |
| `Workspace` | An execution context rooted at a directory or repository checkout and bound to a session. |
| `Worktree` | An isolated checkout derived from a repository and typically used as the default write target for coding runs. |
| `ExecutionMode` | The repo-bound run setup choice that determines whether execution is `read-only`, `branch`, `worktree`, or `ephemeral clone`. |
| `Artifact` | An immutable output or record produced by a run, a user, or the system. |
| `DiffArtifact` | An artifact that captures the change between two repository or workspace states. |
| `Approval` | A durable decision record that resolves a gated request. |
| `Workflow` | A reusable, versioned execution template that structures multi-phase work inside a session. |
| `WorkflowDefinition` | The named, durable definition record describing a workflow's reusable sequence of phases. Scoped to a session or channel. |
| `WorkflowVersion` | An immutable snapshot of a `WorkflowDefinition`'s phase structure at a point in time. |
| `WorkflowRun` | A single execution instance of a specific `WorkflowVersion` within a session. |
| `PhaseDefinition` | The static configuration inside a `WorkflowVersion` that describes one step in the workflow. |
| `Gate` | A checkpoint between workflow phases that must resolve before the next phase can start. |
| `local-only` | A visibility or operating constraint meaning the relevant session continuity, execution path, or artifact remains usable on the user's own local runtime node without requiring current control-plane reachability. `local-only` is not a separate domain object or an alternate session model. |

## What This Is

This glossary is the authoritative term index for canonical product documentation.

## What This Is Not

This glossary is not a substitute for the detailed domain docs. Each term is defined briefly here and expanded in its own document.

## Invariants

- Each term must have one canonical meaning across the documentation set.
- Later specs must reuse glossary terms instead of inventing near-synonyms for the same concept.
- If a new term overlaps an existing term, the distinction must be documented before the new term is used normatively.
- Canonical prose spelling is `local-only`; do not introduce `local_only` unless a later API or wire contract explicitly defines that literal.

## Relationships To Adjacent Concepts

- `Session` is the top-level container.
- `RuntimeNode`, `Channel`, `Agent`, `Run`, `QueueItem`, `RepoMount`, `Artifact`, and `Approval` are all session-scoped concepts. `User`, `Device`, and `Presence` are account-scoped and appear inside a session by reference.
- `Worktree` is a specialized repository execution surface inside a `Workspace`; it is not a synonym for `Workspace`.
- `ExecutionMode` determines how a `Run` uses a repo-bound `Workspace`.
- `Run` is an execution episode, while `Agent` is the reusable configured actor that performs runs.
- `RuntimeBinding` ties a `Run` to a specific provider driver instance and carries the recovery handles needed for persistence and replay.
- `Workflow` is a reusable execution template. `WorkflowDefinition` records the template; `WorkflowVersion` is an immutable snapshot; `WorkflowRun` is an execution instance inside a `Session`.
- `PhaseDefinition` is one step inside a `WorkflowVersion`; a `Gate` is the checkpoint between phases that must resolve before the next phase can start.
- `local-only` may describe session continuity, execution scope, or artifact visibility, but it does not define a second kind of `Session`.

## Lifecycle

The glossary is versioned through canonical doc updates. A term becomes stable only when its dedicated domain doc exists and uses the same meaning as the glossary entry.

## Example Flows

- Example: The user opens a session from a linked device, the session binds to a runtime node, and an agent run starts in a worktree-bound workspace.
- Example: A queued follow-up becomes a `QueueItem`, an operator issues an `Intervention` to reprioritize it, and the resulting run publishes a `DiffArtifact` that later requires an `Approval`.

## Edge Cases

- A device may be live in a session before any runtime node is attached to it.
- A session may exist without active runs.
- A workspace may exist without a git worktree if the execution root is a plain directory, but a coding workspace defaults to worktree-backed behavior when the repo supports it.

## Related Specs

- [Shared Session Core](../specs/001-shared-session-core.md)
- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md)
- [Provider Driver Contract And Capabilities](../specs/005-provider-driver-contract-and-capabilities.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Workflow Authoring And Execution](../specs/017-workflow-authoring-and-execution.md)

## Related ADRs

- [Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
