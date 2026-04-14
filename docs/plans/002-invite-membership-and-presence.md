# Plan-002: Invite Membership And Presence

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `002` |
| **Slug** | `invite-membership-and-presence` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-002: Invite Membership And Presence](../specs/002-invite-membership-and-presence.md) |
| **Required ADRs** | [ADR-002](../decisions/002-local-execution-shared-control-plane.md), [ADR-007](../decisions/007-collaboration-trust-and-permission-model.md), [ADR-008](../decisions/008-default-transports-and-relay-boundaries.md) |

## Goal

Implement durable invites, membership state, and participant presence tracking for live sessions.

## Scope

This plan covers invite create or accept or revoke flows, membership storage, presence heartbeats, and session participant projections.

## Non-Goals

- Runtime-node attach
- Full identity-provider integration breadth
- Notification fan-out beyond minimal invite and presence updates

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [ ] Blocking open questions are resolved or explicitly deferred

## Target Areas

- `packages/contracts/src/invites.ts`
- `packages/control-plane/src/invites/`
- `packages/control-plane/src/memberships/`
- `packages/control-plane/src/presence/`
- `packages/client-sdk/src/membershipClient.ts`
- `apps/desktop/renderer/src/session-members/`

## Data And Storage Changes

- Add shared `session_invites`, `session_memberships`, and `participant_presences` tables.

## API And Transport Changes

- Add invite CRUD endpoints, membership update endpoints, and presence heartbeat transport to the client SDK.

## Implementation Steps

1. Implement invite and membership contracts plus migrations.
2. Build control-plane services for invite issuance, acceptance, revocation, and role update.
3. Add participant presence heartbeat ingestion and summary projection.
4. Integrate desktop invite acceptance and participant roster surfaces.

## Parallelization Notes

- Invite service and presence service can be implemented in parallel after shared identity assumptions are fixed.
- Desktop roster and invite UI should follow stable projection payloads.

## Test And Verification Plan

- Invite acceptance and revocation integration tests
- Presence heartbeat timeout and reconnect tests
- Manual verification of live join into an active session

## Rollout Order

1. Ship invite and membership APIs
2. Add presence heartbeat and participant roster
3. Enable live invite acceptance in desktop client

## Rollback Or Fallback

- Disable live invite acceptance and keep membership changes admin-only if invite flows regress.

## Risks And Blockers

- Guest identity policy remains unresolved
- Presence churn can create noisy state unless heartbeat thresholds are tuned carefully

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
