# Spec-001: Shared Session Core

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `001` |
| **Slug** | `shared-session-core` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Glossary](../domain/glossary.md), [Session Model](../domain/session-model.md), [Participant And Membership Model](../domain/participant-and-membership-model.md), [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md), [System Context](../architecture/system-context.md), [Container Architecture](../architecture/container-architecture.md) |
| **Implementation Plan** | [Plan-001: Shared Session Core](../plans/001-shared-session-core.md) |

## Purpose

Define the minimum shared-session contract that all user, agent, and collaboration behavior must build on.

## Scope

This spec covers session identity, default session structure, session creation, join, and attachment semantics.

## Non-Goals

- Detailed invite lifecycle
- Detailed runtime-node attach protocol
- Detailed run state or queue semantics

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Agent Channel And Run Model](../domain/agent-channel-and-run-model.md)

## Architectural Dependencies

- [System Context](../architecture/system-context.md)
- [Container Architecture](../architecture/container-architecture.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)

## Required Behavior

- The system must treat `Session` as the primary collaborative container.
- Every participant, runtime node, channel, agent, run, queue item, artifact, and approval must reference exactly one session id.
- Creating a session must produce a durable session record before any run starts.
- Joining an existing session must attach to the same session id and existing timeline; it must not silently fork the session.
- A session must support concurrent participants, channels, and runs.
- Session identity must remain stable across reconnect, client restart, and transport changes.
- The Local Runtime Daemon must own execution state while the Collaboration Control Plane owns shared coordination state.

## Default Behavior

- A newly created session starts in `provisioning` state and transitions to `active` once initial membership, storage, and control-plane metadata are ready. See [Session Model](../domain/session-model.md) for the full lifecycle including `archived`, `closed`, `purge_requested`, and `purged` states (see [Spec-022](../specs/022-data-retention-and-gdpr.md) for GDPR states).
- A newly created session defaults to one `owner` membership for the creator and one default `main` channel.
- If the creator has a healthy local runtime node available, the client may offer immediate node attach after session creation.

## Fallback Behavior

- If the control plane is unavailable during single-participant session creation, the system may create a `local-only` session projection that can later be promoted into shared mode.
- If a client reconnects after missing live updates, it must restore from the canonical snapshot and replay surface rather than trusting client cache.

## Interfaces And Contracts

- `SessionCreate` must return the session id, session state, initial memberships, and initial channels.
- `SessionRead` must return the authoritative session snapshot plus timeline cursors.
- `SessionJoin` must verify membership and return the same session id plus the latest shared metadata.
- `SessionSubscribe` must stream canonical session events and support replay from a known cursor.

## State And Data Implications

- Session records must be durable before active run state is admitted.
- The system must maintain a canonical session event stream and session snapshot projection.
- Clients may cache presentation state, but cache must not be authoritative for session membership or run truth.

## Example Flows

- `Example: A user creates a session for a repository review. The system creates the session, assigns owner membership, creates a main channel, and later attaches a runtime node without changing the session id.`
- `Example: A collaborator joins an already active session and receives the existing timeline plus current membership and presence state instead of creating a new conversation container.`

## Implementation Notes

- Keep session ids globally unique and opaque.
- Default channel creation belongs to session creation, not to the first run.
- `local-only` fallback must remain visibly distinct from shared collaborative mode, but it must not become a second session type.

## Pitfalls To Avoid

- Treating provider thread ids as session ids
- Letting the active client tab own session truth
- Creating hidden shadow sessions during reconnect or join

## Acceptance Criteria

- [ ] Creating a session yields one stable session id, one owner membership, and one default channel.
- [ ] A second participant can join the same live session without changing the session id or resetting existing runs.
- [ ] Reconnecting clients can restore session state from authoritative snapshot plus replay data.

## ADR Triggers

- If the product stops treating session as the primary domain object, create or update `../decisions/001-session-is-the-primary-domain-object.md`.
- If `local-only` fallback evolves into a materially different session model, create or update `../decisions/002-local-execution-shared-control-plane.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: `local-only` session continuity is not promotable in place. Shared collaboration requires explicit collaborative enablement as a new shared-session transition rather than silent in-place promotion.

## References

- [Session Model](../domain/session-model.md)
- [System Context](../architecture/system-context.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
