# Session Model

## Purpose

Define `Session` as the primary domain object and the durable collaborative boundary for all product activity.

## Scope

This document defines what a session contains, how it behaves, and how it relates to adjacent concepts.

## Definitions

- `Session`: the top-level collaborative container for runtime, membership, communication, and work state.
- `SessionState`: the lifecycle state of the session itself, not the state of any specific run.
- `local-only`: an operating constraint where a session remains usable on one participant-owned local runtime node without current shared control-plane coordination.

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
- A session does not become a different root object when it is operating in `local-only` continuity.

## Invariants

- Every core collaboration and runtime record belongs to exactly one session.
- Session identity remains stable across reconnects, client restarts, and transport changes.
- A session may host multiple active channels and multiple active runs at the same time.
- A session may outlive the presence of any currently connected client.
- Joining a live session must attach to the existing session; it must not clone or fork the session by default.
- `local-only` continuity must not create a second session identity or a separate session type.

## Relationships To Adjacent Concepts

- `Participant` and `Membership` describe who belongs in the session.
- `RuntimeNode` describes what execution authority is attached to the session.
- `Channel` describes where communication occurs inside the session.
- `Agent` and `Run` describe who executes work and which execution episode is in progress.
- `RepoMount`, `Workspace`, and `Worktree` describe the code-bearing surfaces used by runs inside the session.
- `local-only` describes a continuity constraint on session use; it does not replace shared-session semantics as the root model.

## State Model

| State             | Meaning                                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provisioning`    | The session exists but its initial membership, storage, or control-plane metadata is not yet ready.                                                                  |
| `active`          | The session is usable for membership, communication, and execution.                                                                                                  |
| `archived`        | The session is retained for history and replay but no longer accepts normal active work.                                                                             |
| `closed`          | The session has been intentionally terminated and is not resumable without explicit restoration.                                                                     |
| `purge_requested` | A participant or admin has requested data purge. The session is locked against further modification while purge processing is pending.                               |
| `purged`          | Event payloads containing PII have been destroyed via crypto-shredding. Audit stubs (timestamps, event types, non-PII metadata) are retained. Purge is irreversible. |

Allowed transitions:

- `provisioning -> active`
- `active -> archived`
- `active -> closed`
- `archived -> active`
- `archived -> closed`
- `closed -> purge_requested`
- `archived -> purge_requested`
- `purge_requested -> purged`

## Local-Only Reconciliation

Sessions started in `local-only` continuity are domain-identical to shared sessions — only connectivity is partial. Reconciliation to the shared control plane MUST preserve session identity and history:

1. **Session IDs are daemon-assigned UUID v7** per [RFC 9562](https://www.rfc-editor.org/rfc/rfc9562.html) (Standards Track, May 2024). UUID v7 is lexicographically sortable by creation timestamp, so sessions remain orderable even when reconciliation is delayed by minutes, hours, or days. Postgres 18 exposes native `uuidv7()` and `uuid_extract_timestamp()` that reverse-validate any daemon-generated ID.
2. **The daemon generates the session ID for daemon-originated sessions.** Such sessions are fully functional with zero control-plane contact; the ID is preserved unchanged across later reconciliation. The `sessions` schema's `gen_random_uuid()` default exists only for rare control-plane-originated rows (e.g., admin-provisioned sessions that have no daemon origin); it is not the normal production path.
3. **First reconciliation executes the `provisioning -> active` transition** once the shared-Postgres row is written. The daemon presents the session ID and the control plane performs an idempotent upsert: `INSERT INTO sessions (id, ...) VALUES (...) ON CONFLICT (id) DO UPDATE SET updated_at = sessions.updated_at RETURNING *`. The `DO UPDATE` clause (not `DO NOTHING`) guarantees `RETURNING *` yields a row on every attempt so the daemon detects retries after a crash without silent data loss.
4. **Owner identity is bound at the first authenticated RPC.** Until then, the session is attributable to the daemon machine but not to a global participant identity. The first PASETO v4 token received on any session RPC (token format and issuance flows defined in [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)) seeds the `session_memberships` owner row in a trust-on-first-use binding; subsequent tokens MUST match the bound owner. The TOFU-seeding rule itself is established by this invariant — ADR-010 is cited for the underlying token material, not for the seeding rule.
5. **Reconciliation is never destructive.** A reconnecting daemon never re-assigns a session ID. Unknown IDs cause shared-row creation; known IDs resolve to the existing row via the upsert no-op.

State-machine precedent for the `provisioning -> active` split: Kubernetes Pod (`Pending -> Running`) and Amazon ECS (`PROVISIONING -> PENDING -> ACTIVATING -> RUNNING`) both treat creation-time resource allocation as a distinct pre-ready phase from steady-state operation.

## Example Flows

- Example: A user creates a new session around a repository, invites a reviewer, attaches a runtime node, and starts an implementation run. All later messages, approvals, diffs, and artifacts remain inside that same session.
- Example: A participant reconnects after a transport failure. The session remains `active`, and the participant reattaches to the existing session timeline instead of creating a second session.
- Example: A single participant starts work while shared collaboration services are unavailable. The session remains the same domain object in `local-only` continuity and may later reconnect to shared coordination if product rules allow it.

## Edge Cases

- A session can be `active` even when it has no runtime nodes attached yet.
- A session can have no repository mounts and still be valid for planning, discussion, or review-only activity.
- A session may be archived with unresolved historical approvals or failed runs; archival does not rewrite history.
- A session may temporarily remain usable only in `local-only` continuity during control-plane outage; that does not imply a different lifecycle model.

## Related Domain Docs

- [Trust And Identity](./trust-and-identity.md) — session-end is the trigger for ephemeral X25519 zeroization (per [security-architecture.md §V1 Relay Encryption](../architecture/security-architecture.md)) and for the rotate-on-shred path of the daemon master key when participant crypto-shred fires. Session lifecycle and trust-state lifecycle interact at this boundary.

## Related Specs

- [Shared Session Core](../specs/001-shared-session-core.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)
- [Data Retention And GDPR Compliance](../specs/022-data-retention-and-gdpr.md)

## Related ADRs

- [Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
- [Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
