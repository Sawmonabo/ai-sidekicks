# Control-Plane Runbook

## Purpose

Recover the Control Plane when device linking, device presence, the session directory, or relay coordination are failing.

## Symptoms

- A device cannot link to the account, or its registered identity key no longer resolves
- A linked device cannot read the session directory or open a session the user owns
- Device presence becomes stale across many sessions
- Scope and blast radius: every session reached through the affected Control Plane

## Detection

- Read control-plane health plus failure-category projections for auth, shared database, the device registry, device presence, and relay coordination.
- Inspect recent device-link, session-directory read, and presence-write failure rates.
- Compare the last successful shared write timestamp with current projection freshness for session directory and presence reads.

## Preconditions

- Operator access to Control Plane services and shared Postgres
- Access to Control Plane logs, traces, and deployment controls
- Ability to pause or rate-limit device-link or session-directory traffic if needed

## Recovery Steps

1. Confirm whether the primary failure category is auth, shared database, the device registry, presence projection, or relay coordination.
2. If shared database connectivity is impaired, restore shared Postgres availability before restarting higher services.
3. If auth is impaired, recover auth reachability and token validation before accepting new device-link or session-directory traffic.
4. Restart only the unhealthy Control Plane services after persistent dependencies are healthy again.
5. Rebuild or refresh session-directory and presence projections if writes recovered but reads remain stale.
6. Re-run one device-link flow and one session-open flow before declaring recovery complete.

## Validation

- A device links and its registered identity key resolves
- A linked device opens at least one known-good session through the directory
- Device presence updates resume within normal heartbeat windows
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
| Session open latency (p95) | < 500ms                   |
| Device presence staleness  | < 30s from last heartbeat |

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

- [Identity And Participant State](../specs/018-identity-and-participant-state.md)

## Related Plans

- [Shared Session Core](../plans/001-shared-session-core.md)
- [Runtime Node Attach](../plans/003-runtime-node-attach.md)
