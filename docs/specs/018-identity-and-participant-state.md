# Spec-018: Identity And Participant State

| Field                   | Value                                                                                                                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**              | `approved`                                                                                                                                                                                                                                                           |
| **NNN**                 | `018`                                                                                                                                                                                                                                                                |
| **Slug**                | `identity-and-participant-state`                                                                                                                                                                                                                                     |
| **Date**                | `2026-04-14`                                                                                                                                                                                                                                                         |
| **Author(s)**           | `Codex`                                                                                                                                                                                                                                                              |
| **Depends On**          | [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md), [Participant And Membership Model](../domain/participant-and-membership-model.md), [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md) |
| **Implementation Plan** | [Plan-018: Identity And Participant State](../plans/018-identity-and-participant-state.md)                                                                                                                                                                           |

## Purpose

Define how authenticated identity maps into session participants and how participant state is represented over time.

## Scope

This spec covers participant identity mapping, participant profile state, device presence fan-out, and session-scoped participant projections.

## Non-Goals

- Organization-wide directory sync
- Billing or account subscription state
- Runtime-node attach details

## Domain Dependencies

- [Participant And Membership Model](../domain/participant-and-membership-model.md)
- [Session Model](../domain/session-model.md)

## Architectural Dependencies

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)
- [ADR-008: Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)

## Required Behavior

- An authenticated identity must map to one canonical participant record per session.
- A participant may have multiple simultaneous device or client presences.
- Participant display state must include stable id, display name, canonical membership role, membership state, and current presence summary.
- Historical participant authorship must remain stable even when display metadata later changes.
- Participant state changes must be represented in session history when they affect collaboration semantics.

## Default Behavior

- Participant display name defaults to the authenticated profile display name at join time.
- Session participant projection defaults to one aggregated presence summary plus optional device-level detail.
- If multiple presences exist, participant status defaults to the highest-activity summary state, preferring `online` over `idle` over `reconnecting` over `offline`.

## Fallback Behavior

- If authenticated profile data is partially unavailable, the system must still create a participant record with a stable id and placeholder display metadata.
- If multiple devices report conflicting activity states, the session projection must remain conservative and avoid false `offline`.
- If a participant later loses access, authorship on prior events remains attached to the stable participant id.

## Interfaces And Contracts

- `ParticipantProjectionRead` must expose stable participant id and canonical session-scoped membership role.
- `ParticipantStateUpdate` must support display metadata changes that do not rewrite historical events.
- `PresenceDetailRead` may expose device-level detail for authorized operators or participants.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Participant identity mapping belongs to shared control-plane storage.
- Historical event authorship must reference stable participant ids, not mutable display names.
- Device-level presence detail may be ephemeral, but participant-state changes with collaboration impact must be durable.

## Example Flows

- `Example: One authenticated user joins the same session from desktop and CLI. The session still shows one participant with two active presences.`
- `Example: A participant changes display name after joining. Future projections show the updated name while historical authorship remains stable to the same participant id.`

## Implementation Notes

- Separate session-scoped participant state from global account state.
- Participant projection should optimize for collaboration clarity, not identity-provider completeness.
- Device fan-out is real, but participant identity must remain the stable unit of authorship.

## Pitfalls To Avoid

- Creating a new participant record per device connection
- Rewriting old event authorship when display metadata changes
- Treating identity-provider data as always complete and always available

## Acceptance Criteria

- [ ] One authenticated user appears as one participant per session, even with multiple active devices.
- [ ] Historical event authorship remains stable when participant profile data changes.
- [ ] Session projections can summarize multiple presences into one participant state.

## ADR Triggers

- If participant identity and membership are no longer session-scoped projections, revisit `../decisions/001-session-is-the-primary-domain-object.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: guest and anonymous participant identities are out of scope for the first release. Shared participation requires authenticated identity.

## References

- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Participant And Membership Model](../domain/participant-and-membership-model.md)
