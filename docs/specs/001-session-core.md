# Spec-001: Session Core

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `001` |
| **Slug** | `session-core` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Glossary](../domain/glossary.md), [Session Model](../domain/session-model.md), [User And Device Model](../domain/user-and-device-model.md), [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md), [System Context](../architecture/system-context.md), [Container Architecture](../architecture/container-architecture.md) |
| **Implementation Plan** | [Plan-001: Session Core](../plans/001-session-core.md) |

## Purpose

Define the minimum shared-session contract that all user, device, and agent behavior must build on.

## Scope

This spec covers session identity, default session structure, session creation, join, and attachment semantics.

## Non-Goals

- Detailed runtime-node attach protocol
- Detailed run state or queue semantics

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [User And Device Model](../domain/user-and-device-model.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)

## Architectural Dependencies

- [System Context](../architecture/system-context.md)
- [Container Architecture](../architecture/container-architecture.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [ADR-001: Session Is The Primary Domain Object](../decisions/001-session-is-the-primary-domain-object.md)
- [ADR-002: Local Execution Shared Control Plane](../decisions/002-local-execution-shared-control-plane.md)
- [ADR-032: Two Session Shapes](../decisions/032-two-session-shapes.md)

## Required Behavior

- The system must treat `Session` as the primary session container.
- Every user, runtime node, channel, agent, run, queue item, artifact, and approval must reference exactly one session id.
- Creating a session must produce a durable session record before any run starts.
- Joining an existing session must attach to the same session id and existing timeline; it must not silently fork the session.
- A session must support concurrent devices, channels, and runs.
- Session identity must remain stable across reconnect, client restart, and transport changes.
- The Local Runtime Daemon must own execution state while the Control Plane owns shared coordination state.
- **Two session shapes, and no third.** A session is either a chat or a project ([ADR-032: Two Session Shapes](../decisions/032-two-session-shapes.md)). The shape is decided by what the session is bound to, never by a mode flag, and it is a durable column on the session record rather than something inferred from a path prefix. A chat session is bound to a daemon-owned, git-initialized managed workspace, one per session, kept under the daemon's own state directory at `<home>/.ai-sidekicks/workspaces/<session-id>` and registered as a mount whose origin is marked managed. A project session is bound to a repository the user attached, and a project is defined against that mount's origin rather than against a folder existing on disk: attaching a folder that is already a project opens the project it already is, and the daemon refuses to mint a second project record for the same origin, so no path through the product can create a duplicate.
- **A chat becomes a project in place.** Converting a chat to a project copies the managed workspace's files into the attached repository, and from then on the session is a project session: the same session id, the same timeline, the same history. Nothing beyond that copy is migrated and nothing is auto-merged, and the managed workspace and its own history are kept rather than deleted. The conversion changes the session's binding; it never mints a second session. **It never overwrites a file the repository already has:** such a file is not copied, it stays in the kept managed workspace, and the one act row the conversion appends to the session's timeline names what was not copied, so nothing is quietly replaced and nothing is quietly lost.
- **A managed workspace at end of life.** A chat's managed workspace is deleted whole when its session is purged, retained when the session is archived, and excluded from the archive sweep. Provable destruction of its contents is never claimed.
- **Forking a session.** A fork mints a new session of the same shape from a message anchor in the parent. The new session carries the transcript prefix up to and including that message, with live timers settled and streams stopped in the copy, and the parent is recorded on the new session's own creation record rather than as a second record beside it. A chat fork stays a chat and binds a managed workspace of its own; a project fork lands on a new worktree taken off the parent's current worktree at its current commit. The session's posture — its permission level, its model and its effort — and its tool configuration carry over. The parent is untouched: a fork never changes the parent's session id, its timeline or its runs.

## Default Behavior

- A newly created session starts in `provisioning` state and transitions to `active` once initial storage and control-plane metadata are ready. See [Session Model](../domain/session-model.md) for the full lifecycle including `archived`, `closed`, `purge_requested`, and `purged` states (see [Spec-020](../specs/020-data-retention-and-gdpr.md) for GDPR states).
- A newly created session belongs to the user who created it and defaults to one `main` channel.
- If the creator has a healthy local runtime node available, the client may offer immediate node attach after session creation.

## Fallback Behavior

- If the control plane is unavailable during session creation, the system may create a `local-only` session projection that can later be promoted once the control plane is reachable.
- If a client reconnects after missing live updates, it must restore from the canonical snapshot and replay surface rather than trusting client cache.

## Resource Limits

| Resource                         | Default Limit | Enforcement Point             |
| -------------------------------- | ------------- | ----------------------------- |
| Channels per session             | 20            | Daemon (on channel create)    |
| Concurrent runs per session      | 5             | Daemon (on run admit)         |
| Agents per session               | 10            | Daemon (on agent attach)      |
| Concurrent child runs per parent | 3             | Daemon (on child spawn)       |
| Queue depth per session          | 100           | Daemon (on queue item create) |

### Limit Enforcement

- Each limit check returns a standard error: `{code: "resource.limit_exceeded", message: "...", details: {resource, limit, current}}`.
- Limits are configurable per session via session config. The values above are defaults.
- Exceeding a limit does NOT terminate existing resources -- it prevents creating new ones.

## Interfaces And Contracts

- `SessionCreate` must return the session id, session state, and initial channels.
- `SessionRead` must return the authoritative session snapshot plus timeline cursors.
- `SessionJoin` must verify that the caller owns the session and return the same session id plus the latest shared metadata.
- `SessionSubscribe` must stream canonical session events and support replay from a known cursor.
- The session surface on the wire is `session.create`, `session.read`, `session.subscribe` (replay from a known cursor, then tail), `session.goalUpdate` and `session.goalClear` (the standing sentence every agent in the session is given, and its removal), `session.setWorkingFolder`, `session.fork`, `session.rename`, `session.draftUpdate`, `session.attachmentAdd` and `session.attachmentRemove`, and two search reads: one across the user's sessions over session titles and message text, answering with hits grouped by session and each hit's own message anchor, and the same search scoped to a single session, which counts every hit and loads the stretch of history a hit sits in only when the reader steps to it. No client walks history it does not already hold.
- `session.create` names the session's one main agent — a saved agent definition, or the axes spelled out — and its reply echoes the binding the daemon resolved for it: the driver, the model, the effort, and the provider account ([Spec-027 §Resolution when a run starts](./027-agent-definitions-and-peer-invocation.md#resolution-when-a-run-starts)). Those same resolved values ride the session's own creation record, because no verb attaches an agent to a session and that record is where the agent's row in the session's `agents` projection is born ([Spec-014 §Interfaces And Contracts](./014-multi-agent-channels-and-orchestration.md#interfaces-and-contracts)).
- `session.setWorkingFolder` is one call requesting the move. Re-targeting it at the session's current directory is how a pending request is cancelled, the pending intent lives on the session row rather than in a queue, and the move is applied when the session's active run reaches a boundary.
- `session.rename` writes a name field on the session record; a session with no name is shown by its first message instead, and nothing renames a session on the user's behalf.
- `session.fork` carries the message anchor, returns the new session's id, and records the parent on that new session's creation record.
- The composer draft, its staged files and the review notes left on a file's lines are one daemon-held, session-scoped store: `session.draftUpdate` saves the draft, `session.attachmentAdd` and `session.attachmentRemove` stage and unstage one file, a staged file is copied to the daemon when it is staged and held with the session outside the checkout, and a note left on a line is held the same way, scoped to the same session. Because the daemon holds all three, a half-written message, its files and an unsent review reach the user's other devices and sending needs no upload step; the draft is cleared when the message is sent. Typed unsent text is never written to window storage.
- The canonical stream carries `session.goal_updated`, `session.goal_cleared`, `session.renamed`, `session.archived`, `session.purged` and `session.notice`.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Session records must be durable before active run state is admitted.
- The system must maintain a canonical session event stream and session snapshot projection.
- Clients may cache presentation state, but cache must not be authoritative for session or run truth.
- The session record carries the shape discriminator and, for a chat, the managed-workspace mount the session is bound to. The daemon-held draft, its staged attachments and the session's review notes are durable session-scoped state, never client state.
- Session records may carry an optional minimum client-version floor (`min_client_version`) per [ADR-018: Cross-Version Compatibility](../decisions/018-cross-version-compatibility.md). A NULL floor means no minimum is enforced. Attach-time enforcement is performed at the [Runtime Node Attach](./002-runtime-node-attach.md) boundary.

## Example Flows

- `Example: A user creates a session for a repository review. The system creates the session, creates a main channel, and later attaches a runtime node without changing the session id.`
- `Example: A second device joins an already active session and receives the existing timeline plus current device-presence state instead of creating a new conversation container.`

## Implementation Notes

- Keep session ids globally unique and opaque.
- Default channel creation belongs to session creation, not to the first run.
- `local-only` fallback must remain visibly distinct from relayed mode, but it must not become a second session type.

## Pitfalls To Avoid

- Treating provider thread ids as session ids
- Letting the active client tab own session truth
- Creating hidden shadow sessions during reconnect or join

## Acceptance Criteria

- [ ] AC1 — Creating a session yields one stable session id and one default channel.
- [ ] AC2 — Session record is durable in shared state before any run admission or attached-node activity.
- [ ] AC3 — Session id is stable across reconnect, client restart, and transport change.
- [ ] AC4 — A second client `SessionJoin` to an existing session returns the same session id and full event history.
- [ ] AC5 — `SessionJoin` does not silently fork the session, change the session id, or reset existing runs.
- [ ] AC6 — Reconnecting clients restore session state from the authoritative snapshot plus replay data, never from client cache.
- [ ] AC7 — Concurrent channels and runs up to the [Resource Limits](#resource-limits) defaults are supported without timeline corruption.
- [ ] AC8 — Each Resource Limits enforcement returns the standard `{code: "resource.limit_exceeded", ...}` error shape and does not terminate existing resources.
- [ ] AC9 — A session's shape is read from its binding and its durable discriminator; attaching a folder that is already a project opens that project and mints no second project record for the same origin.
- [ ] AC10 — A chat converted to a project keeps its session id and its full timeline, its managed workspace and history are kept, and a file the repository already has is left untouched, stays in the managed workspace, and is named on the conversion's own timeline row.
- [ ] AC11 — A fork yields a new session id of the same shape carrying the transcript prefix through the anchor message, records the parent on its own creation record, and leaves the parent session's id, timeline and runs unchanged.

## ADR Triggers

- If the product stops treating session as the primary domain object, create or update `../decisions/001-session-is-the-primary-domain-object.md`.
- If `local-only` fallback evolves into a materially different session model, create or update `../decisions/002-local-execution-shared-control-plane.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: `local-only` session continuity is not promotable in place. Reaching a session from another device requires an explicit transition to relayed mode rather than silent in-place promotion.

## References

- [Session Model](../domain/session-model.md)
- [System Context](../architecture/system-context.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
