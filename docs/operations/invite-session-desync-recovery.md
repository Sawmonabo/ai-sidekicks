# Invite Session Desync Recovery

## Purpose

Recover mismatches between invite or membership state and the visible session participant state.

## Symptoms

- Invite shows accepted but participant is not visible in the session
- Participant appears duplicated or with stale role data
- Session roster disagrees across clients
- Scope and blast radius: one shared session or all sessions with the same Collaboration Control Plane projection bug

## Detection

- Compare invite record, membership record, and participant projection for the same session
- Check presence heartbeats and relay join logs for the affected participant
- Verify whether the issue is projection lag or authoritative membership corruption

## Preconditions

- Operator access to invite, membership, and presence records
- Ability to invalidate or refresh session participant projections
- Ability to revoke and reissue invites if necessary

## Recovery Steps

1. Read the authoritative invite and membership records for the affected participant and session.
2. If the projection is stale but the authoritative records are correct, rebuild or refresh the session participant projection.
3. If duplicate participant records exist, reconcile to one canonical participant id and preserve historical authorship.
4. If invite state is corrupted or ambiguous, revoke the broken invite and issue a replacement rather than mutating it in place.
5. Ask the participant to reconnect only after authoritative records and projections agree.

## Validation

- All clients show the same participant roster and role state
- The affected participant can join or rejoin without duplicate identity
- Invite and membership records align with visible session state

## Escalation

- Escalate when authoritative membership records are corrupted, participant authorship is inconsistent, or projection rebuild repeatedly reintroduces duplicates

## CLI Commands

```bash
sidekicks invite list --session <id> --state pending
sidekicks invite revoke <invite-id>
sidekicks membership list --session <id>
sidekicks membership repair --session <id>
sidekicks membership diff --session <id>
sidekicks invite reissue <invite-id>
```

## SLOs and Thresholds

| Metric                            | Target                      |
| --------------------------------- | --------------------------- |
| Projection refresh latency        | < 5s after membership write |
| Roster convergence across clients | within 10s                  |
| Invite accept-to-visible          | < 15s end-to-end            |
| Duplicate participant detection   | < 5s                        |

## On-Call Routing

- **Severity 1** (service down): Page on-call engineer immediately. Escalate to team lead after 15min.
- **Severity 2** (degraded): Alert on-call via Slack. Investigate within 30min.
- **Severity 3** (warning): Log alert. Review during business hours.
- **Domain routing**: Invite and membership desync issues route to **backend on-call**.

## Related Architecture Docs

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Security Architecture](../architecture/security-architecture.md)

## Related Specs

- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)
- [Identity And Participant State](../specs/018-identity-and-participant-state.md)

## Related Plans

- [Invite Membership And Presence](../plans/002-invite-membership-and-presence.md)
