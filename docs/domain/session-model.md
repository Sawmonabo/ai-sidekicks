# Session Model

## Purpose

Define `Session` as the primary domain object and the durable boundary for all product activity.

## Scope

This document defines what a session contains, how it behaves, and how it relates to adjacent concepts.

## Definitions

- `Session`: the top-level container for runtime, communication, and work state, owned by one user.
- `SessionState`: the lifecycle state of the session itself, not the state of any specific run.
- `local-only`: a connectivity state in which a session stays fully usable on the machine that runs it while that machine has no relay connection; the user's other devices reach the same session again once the connection is back.

## What This Is

A session is the durable container that holds:

- agents
- runs
- queue items and interventions
- the workspace it is bound to
- approvals and artifacts

## What This Is Not

- A session is not a provider thread.
- A session is not a UI tab or screen route.
- A session is not a single repository or workspace.
- A session is not a single run.
- A session does not become a different root object when it is operating in `local-only` continuity.

## Invariants

- Every core runtime and communication record belongs to exactly one session.
- Session identity remains stable across reconnects, client restarts, and transport changes.
- A session runs on the one machine it was started on for its whole life. Nothing moves it, copies it, or sends its work to another machine.
- A session may host multiple active runs at the same time.
- A session may outlive the presence of any currently connected client.
- Opening a live session from another of the user's devices opens the existing session on the machine that holds it; it never clones or forks the session.
- `local-only` continuity must not create a second session identity or a separate session type.

## Relationships To Adjacent Concepts

- [User And Device Model](./user-and-device-model.md) describes who owns the session and which devices drive it.
- `RuntimeNode` is the machine that runs the session. A session has exactly one, fixed when the session starts.
- `Agent` and `Run` describe who executes work and which execution episode is in progress.
- `RepoMount`, `Workspace`, and `Worktree` describe the code-bearing execution contexts used by runs inside the session.
- `local-only` describes a connectivity state of the one session; it is not a second root model and not a second kind of session.

## State Model

| State | Meaning |
| --- | --- |
| `provisioning` | The session exists but its initial storage on the machine that runs it is not yet ready. |
| `active` | The session is usable for communication and execution. |
| `archived` | The session is retained for history and replay but no longer accepts normal active work. |
| `closed` | The session has been intentionally terminated and is not resumable without explicit restoration. |
| `purge_requested` | The person has pressed `Delete old data` and the session is among those it removes. The session is locked against further modification while purge processing is pending. |
| `purged` | The session's rows have been deleted with SQLite's `secure_delete` on, so the freed pages hold nothing readable, and the write-ahead log has been checkpointed with `TRUNCATE` once the delete committed. Audit stubs (timestamps, event types, non-PII metadata) are retained. Purge is irreversible. |

Allowed transitions:

- `provisioning -> active`
- `active -> archived`
- `active -> closed`
- `archived -> active`
- `archived -> closed`
- `closed -> purge_requested`
- `archived -> purge_requested`
- `purge_requested -> purged`

## Session Identity And Local-Only Continuity

Every session is created and held by the daemon of the machine that runs it; the control plane keeps no session record. `local-only` continuity is therefore a connectivity state of that same session, not a mode it has to leave or reconcile:

1. **Session IDs are daemon-assigned UUID v7** per [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html) (Standards Track, May 2024). UUID v7 is lexicographically sortable by creation timestamp, so sessions stay orderable by when they were created.
2. **The daemon generates every session ID.** A session is fully functional with no control-plane contact, and its ID never changes.
3. **`provisioning -> active` happens on the machine.** It runs once the session's initial storage on its machine is ready, and never waits on the control plane.
4. **The owner is derived, not stored.** The owner is the actor on the session's first event ([User And Device Model §Session Ownership](./user-and-device-model.md#session-ownership)); one account owns the machine, so the owner is that account's user.
5. **Reaching the session from another device changes nothing about it.** While the machine has no relay connection the session is in `local-only` continuity; once the connection is up, the user's other devices open the same session on its machine. Nothing is promoted, copied or re-created.

State-machine precedent for the `provisioning -> active` split: Kubernetes Pod (`Pending -> Running`) and Amazon ECS (`PROVISIONING -> PENDING -> ACTIVATING -> RUNNING`) both treat creation-time resource allocation as a distinct pre-ready phase from steady-state operation.

## Example Flows

- Example: A user creates a new session around a repository on one of their machines and starts an implementation run. All later messages, approvals, diffs, and artifacts remain inside that same session, on that machine.
- Example: A device reconnects after a transport failure. The session remains `active`, and the device reopens the existing session instead of creating a second one.
- Example: A user starts work while their machine has no relay connection. The session is the same domain object in `local-only` continuity, fully usable on that machine, and the user's other devices open it once the connection is back.

## Edge Cases

- A session can have no repository mounts and still be valid for planning, discussion, or review-only activity.
- A session may be archived with unresolved historical approvals or failed runs; archival does not rewrite history.
- A session may temporarily remain usable only in `local-only` continuity during control-plane outage; that does not imply a different lifecycle model.

## Related Domain Docs

- [Trust And Identity](./trust-and-identity.md) — a session owns no key: its rows sit in the daemon's database as plain text, and a purge deletes them with SQLite's `secure_delete` on, with a `TRUNCATE` checkpoint after commit. No session event rotates a key. The encryption between a device and a machine is not a session's: one Noise channel joins a device and a machine and carries every session on that machine, with a fresh handshake on every connection and every 10 minutes on a long one and the old keys erased ([security-architecture.md §Relay Authentication And Encryption](../architecture/security-architecture.md#relay-authentication-and-encryption)). A channel's keys belong to a connection, not a session, so no key is tied to a session's end.

## Related Specs

- [Session Core](../specs/001-session-core.md)
- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Data Retention And GDPR Compliance](../specs/020-data-retention-and-gdpr.md)

## Related ADRs

- [Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
