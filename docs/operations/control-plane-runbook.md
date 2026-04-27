# Control-Plane Runbook

## Purpose

Recover the shared Collaboration Control Plane when session join, invites, presence, or shared metadata are failing.

## Symptoms

- Invite issuance or acceptance fails
- Participants cannot join shared sessions
- Presence becomes stale across many sessions
- Scope and blast radius: all collaborative sessions using the affected Collaboration Control Plane

## Detection

- Read control-plane health plus failure-category projections for auth, shared database, membership, presence, and relay coordination.
- Inspect recent invite-create, invite-accept, session-join, and presence-write failure rates.
- Compare the last successful shared write timestamp with current projection freshness for session directory and presence reads.

## Preconditions

- Operator access to Collaboration Control Plane services and shared Postgres
- Access to Collaboration Control Plane logs, traces, and deployment controls
- Ability to pause or rate-limit invite or join traffic if needed

## Recovery Steps

1. Confirm whether the primary failure category is auth, shared database, membership service, presence projection, or relay coordination.
2. If shared database connectivity is impaired, restore shared Postgres availability before restarting higher services.
3. If auth is impaired, recover auth reachability and token validation before accepting new invite or join traffic.
4. Restart only the unhealthy Collaboration Control Plane services after persistent dependencies are healthy again.
5. Rebuild or refresh session-directory and presence projections if writes recovered but reads remain stale.
6. Re-run one invite acceptance and one session join verification flow before declaring recovery complete.

## Validation

- Invite create and accept succeed
- Shared session join succeeds for at least one known-good membership
- Presence updates resume within normal heartbeat windows
- Session-directory and presence projections show current timestamps after recovery

## Escalation

- Escalate when shared Postgres recovery requires failover or restore, or when auth and relay services fail simultaneously

## CLI Commands

```bash
sidekicks cp status
sidekicks cp sessions --state active
sidekicks cp health
sidekicks cp migrate --status
sidekicks cp sessions --state degraded --since 1h
sidekicks cp presence --session <id>
```

## SLOs and Thresholds

| Metric                     | Target                    |
| -------------------------- | ------------------------- |
| API p99 latency            | < 200ms                   |
| Availability               | 99.9% uptime              |
| Error rate                 | < 0.1% of requests        |
| Session join latency (p95) | < 500ms                   |
| Presence staleness         | < 30s from last heartbeat |

## On-Call Routing

- **Severity 1** (service down): Page on-call engineer immediately. Escalate to team lead after 15min.
- **Severity 2** (degraded): Alert on-call via Slack. Investigate within 30min.
- **Severity 3** (warning): Log alert. Review during business hours.
- **Domain routing**: Control-plane issues route to **backend on-call**.

## Related Architecture Docs

- [Component Architecture Control Plane](../architecture/component-architecture-control-plane.md)
- [Data Architecture](../architecture/data-architecture.md)
- [Security Architecture](../architecture/security-architecture.md)

## Related Specs

- [Invite Membership And Presence](../specs/002-invite-membership-and-presence.md)
- [Control Plane Relay And Session Join](../specs/008-control-plane-relay-and-session-join.md)
- [Identity And Participant State](../specs/018-identity-and-participant-state.md)

## Related Plans

- [Shared Session Core](../plans/001-shared-session-core.md)
- [Invite Membership And Presence](../plans/002-invite-membership-and-presence.md)
- [Runtime Node Attach](../plans/003-runtime-node-attach.md)
