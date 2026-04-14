# Glossary

## Purpose

Define the stable vocabulary for the greenfield product so later specs, ADRs, and implementation plans use one meaning for each core term.

## Scope

This glossary covers the primary domain terms from `vision.md` and the canonical domain foundation.

## Definitions

| Term | Definition |
| --- | --- |
| `Session` | The primary collaborative container for participants, runtime nodes, channels, agents, runs, queue items, repo mounts, artifacts, approvals, and invites. |
| `Participant` | A session-scoped human actor with stable identity inside a session. |
| `Membership` | The durable grant that allows a participant to belong to a session with specific roles and capabilities. |
| `Presence` | The ephemeral connectivity and activity state for a participant or runtime node. |
| `Invite` | A session-scoped request that can grant future membership when accepted. |
| `RuntimeNode` | A machine-local execution authority contributed to a session by a participant. |
| `Channel` | A communication surface inside a session where participants and agents exchange messages or coordination events. |
| `Agent` | A configured execution persona bound to a runtime node and used to perform runs. |
| `Run` | A single execution episode performed by one agent inside one session. |
| `QueueItem` | A persisted unit of deferred work awaiting admission into the run engine. |
| `Intervention` | An auditable control action that changes, redirects, pauses, resumes, or cancels active or queued work. |
| `RepoMount` | A repository attached to a session as a source of work and artifacts. |
| `Workspace` | An execution context rooted at a directory or repository checkout and bound to a session. |
| `Worktree` | An isolated checkout derived from a repository and typically used as the default write target for coding runs. |
| `Artifact` | An immutable output or record produced by a run, a participant, or the system. |
| `DiffArtifact` | An artifact that captures the change between two repository or workspace states. |
| `Approval` | A durable decision record that resolves a gated request. |

## What This Is

This glossary is the authoritative term index for canonical product documentation.

## What This Is Not

This glossary is not a substitute for the detailed domain docs. Each term is defined briefly here and expanded in its own document.

## Invariants

- Each term must have one canonical meaning across the documentation set.
- Later specs must reuse glossary terms instead of inventing near-synonyms for the same concept.
- If a new term overlaps an existing term, the distinction must be documented before the new term is used normatively.

## Relationships To Adjacent Concepts

- `Session` is the top-level container.
- `Participant`, `RuntimeNode`, `Channel`, `Agent`, `Run`, `QueueItem`, `RepoMount`, `Artifact`, `Approval`, `Invite`, and `Presence` are all session-scoped concepts.
- `Membership` governs what a `Participant` can do in a `Session`.
- `Worktree` is a specialized repository execution surface inside a `Workspace`; it is not a synonym for `Workspace`.
- `Run` is an execution episode, while `Agent` is the reusable configured actor that performs runs.

## Lifecycle

The glossary is versioned through canonical doc updates. A term becomes stable only when its dedicated domain doc exists and uses the same meaning as the glossary entry.

## Example Flows

- Example: A participant accepts an invite, gains membership in a session, contributes a runtime node, and starts an agent run in a worktree-bound workspace.
- Example: A queued follow-up becomes a `QueueItem`, an operator issues an `Intervention` to reprioritize it, and the resulting run publishes a `DiffArtifact` that later requires an `Approval`.

## Edge Cases

- A participant may have active presence in a session without contributing a runtime node.
- A session may exist without active runs.
- A workspace may exist without a git worktree if the execution root is a plain directory, but a coding workspace defaults to worktree-backed behavior when the repo supports it.

## Related Specs

- [Shared Session Core](../specs/001-shared-session-core.md)
- [Runtime Node Attach](../specs/003-runtime-node-attach.md)
- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Repo Attachment And Workspace Binding](../specs/009-repo-attachment-and-workspace-binding.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)

## Related ADRs

- [Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
