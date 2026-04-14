# Session Model

## Purpose

Define `Session` as the primary domain object and the durable collaborative boundary for all product activity.

## Scope

This document defines what a session contains, how it behaves, and how it relates to adjacent concepts.

## Definitions

- `Session`: the top-level collaborative container for runtime, membership, communication, and work state.
- `SessionState`: the lifecycle state of the session itself, not the state of any specific run.

## What This Is

A session is the durable container that holds:

- participants and memberships
- runtime nodes
- channels
- agents
- runs
- queue items and interventions
- repo mounts and workspaces
- approvals and artifacts
- invites and presence records

## What This Is Not

- A session is not a provider thread.
- A session is not a UI tab or screen route.
- A session is not a single repository or workspace.
- A session is not a single run.

## Invariants

- Every core collaboration and runtime record belongs to exactly one session.
- Session identity remains stable across reconnects, client restarts, and transport changes.
- A session may host multiple active channels and multiple active runs at the same time.
- A session may outlive the presence of any currently connected client.
- Joining a live session must attach to the existing session; it must not clone or fork the session by default.

## Relationships To Adjacent Concepts

- `Participant` and `Membership` describe who belongs in the session.
- `RuntimeNode` describes what execution authority is attached to the session.
- `Channel` describes where communication occurs inside the session.
- `Agent` and `Run` describe who executes work and which execution episode is in progress.
- `RepoMount`, `Workspace`, and `Worktree` describe the code-bearing surfaces used by runs inside the session.

## State Model

| State | Meaning |
| --- | --- |
| `provisioning` | The session exists but its initial membership, storage, or control-plane metadata is not yet ready. |
| `active` | The session is usable for membership, communication, and execution. |
| `archived` | The session is retained for history and replay but no longer accepts normal active work. |
| `closed` | The session has been intentionally terminated and is not resumable without explicit restoration. |

Allowed transitions:

- `provisioning -> active`
- `active -> archived`
- `active -> closed`
- `archived -> active`
- `archived -> closed`

## Example Flows

- Example: A user creates a new session around a repository, invites a reviewer, attaches a runtime node, and starts an implementation run. All later messages, approvals, diffs, and artifacts remain inside that same session.
- Example: A participant reconnects after a transport failure. The session remains `active`, and the participant reattaches to the existing session timeline instead of creating a second session.

## Edge Cases

- A session can be `active` even when it has no runtime nodes attached yet.
- A session can have no repository mounts and still be valid for planning, discussion, or review-only activity.
- A session may be archived with unresolved historical approvals or failed runs; archival does not rewrite history.

## Related Specs

- [Shared Session Core](../specs/001-shared-session-core.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)

## Related ADRs

- [Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
