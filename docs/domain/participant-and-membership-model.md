# Participant And Membership Model

## Purpose

Define how humans belong to a session, what authority that membership grants, and how live presence differs from durable membership.

## Scope

This document covers `Participant`, `Membership`, `Invite`, and `Presence` at the session level.

## Definitions

- `Participant`: the session-scoped human actor.
- `Membership`: the durable grant that authorizes a participant to belong to a session.
- `MembershipRole`: the canonical role held by a membership. Supported roles are `owner`, `viewer`, `collaborator`, and `runtime contributor`.
- `JoinMode`: the invite-time entry mode for a participant joining a session. Supported join modes are `viewer`, `collaborator`, and `runtime contributor`.
- `Invite`: the pre-membership object that can result in membership when accepted.
- `Presence`: the ephemeral signal that a participant is connected or recently active.

## What This Is

This model defines who is in a session, what rights they hold, and how their live availability is represented.

## What This Is Not

- A participant is not a runtime node.
- Membership is not the same thing as presence.
- An invite is not itself membership.
- Presence is not authorization.
- `owner` is a canonical membership role, not a separate identity type.

## Invariants

- A participant must have active membership before they can act in a session.
- Membership can outlive presence.
- A participant can have multiple simultaneous presences.
- Runtime-node attachment must not implicitly create or elevate membership.
- Role and capability changes apply to membership, not to the participant identity record itself.
- `contributor` is not a canonical role label; use `collaborator` or `runtime contributor` as appropriate.
- `owner` is not a normal invite join mode; it is a bootstrap or explicit elevation role.
- A session must always have at least one owner. The last owner cannot depart until ownership is transferred.

## Relationships To Adjacent Concepts

- `Session` is the container that memberships belong to.
- `Invite` can produce `Membership`.
- `Presence` attaches to a `Participant` and may optionally describe device or runtime-node connectivity.
- `Approval` and execution permissions are downstream of membership and trust policy, not substitutes for membership.

## Role Model

| Role | Meaning |
| --- | --- |
| `owner` | Session administrator role. Includes collaborator participation plus membership-management authority and the ability to attach owned runtime nodes subject to local trust policy. |
| `viewer` | Read-focused participation role. Can observe the session according to visibility policy but does not chat or attach runtime nodes by default. |
| `collaborator` | Human participation role. Can join the live session, chat, and collaborate as a human participant, but does not attach runtime nodes by default. |
| `runtime contributor` | Collaborator role plus the ability to attach participant-owned runtime nodes subject to node trust and approval policy. |

- Invite join modes are the non-owner subset: `viewer`, `collaborator`, and `runtime contributor`.
- The session creator bootstraps as `owner` by default unless a stricter product policy is later defined.

## State Model

Membership states:

| State | Meaning |
| --- | --- |
| `pending` | The participant has not completed the join path yet. |
| `active` | The participant currently belongs to the session. |
| `suspended` | The participant still exists in session history but currently lacks normal active rights. |
| `revoked` | The participant no longer has session membership. |

Presence states:

| State          | Meaning                                        |
| -------------- | ---------------------------------------------- |
| `online`       | The participant has an active live connection. |
| `idle`         | The participant is connected but inactive.     |
| `reconnecting` | The system is within a reconnect grace window. |
| `offline`      | No active presence is currently observed.      |

## Owner Elevation

Only an existing owner can elevate another member to the `owner` role. Elevation uses an explicit `MembershipUpdate` with action `change_role` and `newRole: owner`. No invite is required — the target must already hold active membership in the session. Non-owner participants cannot grant or request the owner role; attempts to do so must be rejected with an authorization error.

### Last-Owner Departure

The system must prevent the last remaining owner from leaving a session. A session must always have at least one owner. If the last owner attempts to leave, the system returns the error: "Cannot leave: you are the last owner. Transfer ownership first."

**Rationale:** Auto-elevation (promoting another member automatically) is dangerous because the wrong person may be elevated without consent. Archiving the session on last-owner departure is destructive. Prevention is the simplest and safest approach for V1.

### Concurrent Mutation Resolution

Membership records use optimistic concurrency. Each membership record carries a version field (`updated_at` timestamp) that the system checks before committing a mutation.

- **Non-conflicting changes:** Last-write-wins. Independent mutations to different membership records proceed without contention.
- **Conflicting operations** (e.g., two simultaneous owner revocations targeting the same member, or two concurrent role changes on the same membership): The mutation that commits first wins. The second attempt receives a conflict error that includes the current state of the membership record, allowing the caller to retry with fresh data.

### Mid-Run Membership Revocation

When a participant's membership is revoked while activity is in progress, the system applies role-specific cleanup:

- **Runtime contributor revocation:** Active runs executing on the revoked participant's runtime node are interrupted. Their runtime node is detached from the session. Queued items targeting that node are returned to the session queue for reassignment.
- **Collaborator revocation:** Pending interventions authored by the revoked participant are expired immediately. Write access (chat, approvals, steering) is revoked immediately. Read access is revoked after a 30-second grace period to allow UI refresh and prevent abrupt visual disruption.

## Example Flows

- Example: A reviewer accepts an invite in `viewer` mode, becomes a participant with `active` membership, and appears as `online` while connected from the desktop client.
- Example: A participant temporarily disconnects. Their membership remains `active`, their presence transitions to `reconnecting`, and later settles to `offline` if they do not return in time.
- Example: A session owner revokes a participant's membership. Historical authored events remain in the session, but the participant can no longer join or approve actions.

## Edge Cases

- A participant can observe a session without attaching a runtime node.
- A `runtime contributor` may join the session before actually attaching any runtime node.
- One person can appear through multiple presences at once if they connect from multiple devices.
- Historical session events remain attributed to a participant after membership is revoked.

## Related Domain Docs

- [Trust And Identity](./trust-and-identity.md) — cryptographic identity is the precondition for membership. The trust-state lifecycle (`unprovisioned` → `provisioned` → `verified` → `bound`) runs alongside this doc's membership lifecycle (`pending` → `active` → `suspended` → `revoked`); a participant must be at least `provisioned` to hold any membership and must be `bound` to sign `SessionKeyBundle`s in shared sessions.

## Related Specs

- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Identity And Participant State](../specs/018-identity-and-participant-state.md)
- [Approvals Permissions And Trust Boundaries](../specs/012-approvals-permissions-and-trust-boundaries.md)

## Related ADRs

- [Collaboration Trust And Permission Model](../decisions/007-collaboration-trust-and-permission-model.md)
- [Default Transports And Relay Boundaries](../decisions/008-default-transports-and-relay-boundaries.md)
