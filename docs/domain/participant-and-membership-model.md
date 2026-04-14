# Participant And Membership Model

## Purpose

Define how humans belong to a session, what authority that membership grants, and how live presence differs from durable membership.

## Scope

This document covers `Participant`, `Membership`, `Invite`, and `Presence` at the session level.

## Definitions

- `Participant`: the session-scoped human actor.
- `Membership`: the durable grant that authorizes a participant to belong to a session.
- `Invite`: the pre-membership object that can result in membership when accepted.
- `Presence`: the ephemeral signal that a participant is connected or recently active.

## What This Is

This model defines who is in a session, what rights they hold, and how their live availability is represented.

## What This Is Not

- A participant is not a runtime node.
- Membership is not the same thing as presence.
- An invite is not itself membership.
- Presence is not authorization.

## Invariants

- A participant must have active membership before they can act in a session.
- Membership can outlive presence.
- A participant can have multiple simultaneous presences.
- Runtime-node attachment must not implicitly create or elevate membership.
- Role and capability changes apply to membership, not to the participant identity record itself.

## Relationships To Adjacent Concepts

- `Session` is the container that memberships belong to.
- `Invite` can produce `Membership`.
- `Presence` attaches to a `Participant` and may optionally describe device or runtime-node connectivity.
- `Approval` and execution permissions are downstream of membership and trust policy, not substitutes for membership.

## State Model

Membership states:

| State | Meaning |
| --- | --- |
| `pending` | The participant has not completed the join path yet. |
| `active` | The participant currently belongs to the session. |
| `suspended` | The participant still exists in session history but currently lacks normal active rights. |
| `revoked` | The participant no longer has session membership. |

Presence states:

| State | Meaning |
| --- | --- |
| `online` | The participant has an active live connection. |
| `idle` | The participant is connected but inactive. |
| `reconnecting` | The system is within a reconnect grace window. |
| `offline` | No active presence is currently observed. |

## Example Flows

- Example: A reviewer accepts an invite, becomes a participant with `active` membership, and appears as `online` while connected from the desktop client.
- Example: A participant temporarily disconnects. Their membership remains `active`, their presence transitions to `reconnecting`, and later settles to `offline` if they do not return in time.
- Example: A session owner revokes a participant's membership. Historical authored events remain in the session, but the participant can no longer join or approve actions.

## Edge Cases

- A participant can observe a session without attaching a runtime node.
- One person can appear through multiple presences at once if they connect from multiple devices.
- Historical session events remain attributed to a participant after membership is revoked.

## Related Specs

- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Identity And Participant State](../specs/018-identity-and-participant-state.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)

## Related ADRs

- [Collaboration Trust And Permission Model](../decisions/007-collaboration-trust-and-permission-model.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
