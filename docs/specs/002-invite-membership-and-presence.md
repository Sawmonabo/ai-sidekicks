# Spec-002: Invite Membership And Presence

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `002` |
| **Slug** | `invite-membership-and-presence` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Participant And Membership Model](../domain/participant-and-membership-model.md), [Session Model](../domain/session-model.md), [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md), [Security Architecture](../architecture/security-architecture.md), [Shared Session Core](../specs/001-shared-session-core.md) |
| **Implementation Plan** | [Plan-002: Invite Membership And Presence](../plans/002-invite-membership-and-presence.md) |

## Purpose

Define how participants are invited into sessions, how membership is granted, and how live presence is tracked.

## Scope

This spec covers invite lifecycle, join-mode assignment, membership role changes, and participant presence.

## Non-Goals

- Runtime-node attach details
- Artifact-level sharing policy
- Full identity-provider contract

## Domain Dependencies

- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)

## Required Behavior

- The system must support issuing an invite into an existing live session.
- Accepting an invite must create or activate membership without interrupting active session runs.
- Invite lifecycle must support `issued`, `accepted`, `declined`, `revoked`, and `expired`.
- Membership must be durable and separate from ephemeral presence.
- Invites must support the canonical join modes `viewer`, `collaborator`, and `runtime contributor`.
- A participant must be able to join a session before attaching any runtime node.
- Presence updates must support at least `online`, `idle`, `reconnecting`, and `offline`.
- Role changes and membership revocation must be explicit events in session history.

## Default Behavior

- Invite default join mode is `collaborator`.
- Session creator default role is `owner`.
- Invite default expiry is `7d` from issuance.
- Presence heartbeat default interval is `15s`, with a reconnect grace window of `45s` before `offline`.
- Presence state is managed using the Yjs Awareness protocol (`y-protocols`), a purpose-built ephemeral CRDT for presence. Presence data is never persisted to durable storage — it lives in memory and is garbage-collected on disconnect.
- Presence heartbeat payload must include at minimum: `deviceType`, `focusedSessionId`, `focusedChannelId`, `lastActivityAt`, `appVisible`.
- Cross-node presence fan-out uses Postgres `LISTEN/NOTIFY` in V1. Redis Pub/Sub is a documented upgrade path for V1.1 if scale demands it.
- For local IPC (daemon-to-desktop/CLI over JSON-RPC), the daemon exposes a JSON-RPC presence surface (`PresenceUpdate`, `PresenceRead`) that bridges to the Yjs Awareness state. The Yjs binary protocol runs natively on the WebSocket transport to the control plane; the JSON-RPC transport carries serialized presence state.

## Fallback Behavior

- If presence heartbeats are missed, the system must move the participant to `reconnecting` before `offline`.
- If an invited participant in `runtime contributor` mode cannot attach a runtime node yet, they may still join as a human participant according to membership role.
- If invite delivery fails, the invite remains durable and may be re-shared or revoked without recreating the session.

## Interfaces And Contracts

- Invite tokens use PASETO v4 (consistent with the control-plane auth stack per [ADR-010](../decisions/010-paseto-webauthn-mls-auth.md)). Token payload includes session id, inviter, proposed join mode, and expiry.
- `InviteCreate` must include session id, inviter, proposed join mode, and expiry.
- `InviteAccept` must create active membership and emit participant join events.
- `MembershipUpdate` must support role change, suspension, and revocation.
- `PresenceHeartbeat` must accept participant id, device or client id, and last-known activity state. Presence metadata carried in heartbeats: `{deviceType, focusedSessionId, focusedChannelId, lastActivityAt, appVisible}`.
- `PresenceUpdate` (JSON-RPC, local IPC) — daemon pushes serialized Yjs Awareness state to local clients.
- `PresenceRead` (JSON-RPC, local IPC) — local clients read current presence state for a session.

## State And Data Implications

- Invite records must be durable until accepted, declined, revoked, or expired.
- Membership records must survive client restart and presence loss.
- Presence records are ephemeral (Yjs Awareness CRDT, in-memory only). Durable state-change events (`participant.went_online`, `participant.went_offline`) are emitted to the session event log for audit. Presence data itself is never written to SQLite or Postgres.

## Example Flows

- `Example: A reviewer is invited into an active implementation session in viewer mode, accepts the invite, appears online in the participant roster, and reads the active timeline without interrupting the current run.`
- `Example: A participant drops offline mid-session. Their membership remains active while presence moves through reconnecting to offline.`

## Implementation Notes

- Presence timing values must be configurable, but the default behavior must be stable enough for testing.
- Membership state belongs to shared control-plane storage, not client cache.
- Invite acceptance should not imply approval or execution authority on any participant machine.

## Pitfalls To Avoid

- Treating socket connectivity as proof of membership
- Auto-attaching runtime nodes as part of invite acceptance
- Hiding role changes or revocations from audit history

## Acceptance Criteria

- [ ] An invited participant can join an already active session without resetting active runs.
- [ ] Membership remains durable when presence goes offline and later returns.
- [ ] Revoking membership prevents further join and approval actions while preserving historical authorship.

## ADR Triggers

- If membership and runtime trust are collapsed into one permission model, create or update `../decisions/007-collaboration-trust-and-permission-model.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: invitees must authenticate before acceptance. Guest invites are out of scope for the first release.

## References

- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [PASETO WebAuthn MLS Auth](../decisions/010-paseto-webauthn-mls-auth.md)
