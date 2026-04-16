# Local Persistence Repair And Restore

## Purpose

Repair or restore the Local Runtime Daemon SQLite store when daemon startup, replay rebuild, or local mutation is blocked by persistence failure.

## Symptoms

- `RecoveryStatusRead` remains `blocked` because local persistence is unavailable
- Local Runtime Daemon logs show SQLite open, lock, integrity, or WAL-related failure
- Replay rebuild fails before projections become queryable
- Scope and blast radius: one participant node and the daemon-owned canonical local store for that node

## Detection

- Read `RecoveryStatusRead` and `FailureDetailRead` for the affected node before mutating any files.
- Inspect Local Runtime Daemon logs for SQLite open failure, WAL replay failure, integrity error, or projection-rebuild failure.
- Confirm whether the failure is limited to projection rebuild or whether the canonical SQLite store itself is unreadable or corrupt.

## Preconditions

- Access to the affected participant machine and daemon-owned SQLite files
- Permission to stop the Local Runtime Daemon
- Access to the most recent known-good local persistence backup if one exists

## Recovery Steps

1. Stop the Local Runtime Daemon before modifying any SQLite, WAL, or SHM files.
2. Create a timestamped backup copy of the current SQLite database, WAL, and SHM files before attempting repair or restore.
3. Run a SQLite integrity check against the copied database to determine whether the canonical local store is structurally healthy.
4. If integrity is healthy, restart the daemon and run `ProjectionRebuild` from canonical events instead of replacing the database.
5. If integrity fails and a known-good backup exists, restore the last known-good SQLite, WAL, and SHM set, then restart the daemon and allow replay rebuild to run.
6. If integrity fails and no known-good backup exists, preserve the broken files for later analysis, keep new mutable work blocked, and escalate rather than creating a fresh empty database.

## Validation

- `RecoveryStatusRead` moves out of `blocked` and replay rebuild completes
- Session projections become queryable again through the typed client SDK or CLI
- One affected session can replay from canonical events without missing history or duplicate side effects

## Escalation

- Escalate when integrity check fails and no viable backup exists, restore does not unblock replay, or repaired storage diverges again immediately after restart

## CLI Commands

```bash
sidekick db status
sidekick db integrity-check
sidekick db backup --output <path>
sidekick db restore --from <path>
sidekick db wal-status
sidekick db vacuum
```

## SLOs and Thresholds

| Metric | Target |
|---|---|
| SQLite integrity check | < 30s |
| Backup restore | < 60s |
| Projection rebuild after restore | < 120s |
| WAL checkpoint latency | < 5s |

## On-Call Routing

- **Severity 1** (service down): Page on-call engineer immediately. Escalate to team lead after 15min.
- **Severity 2** (degraded): Alert on-call via Slack. Investigate within 30min.
- **Severity 3** (warning): Log alert. Review during business hours.
- **Domain routing**: Local persistence issues route to **platform on-call**.

## Related Architecture Docs

- [Data Architecture](../architecture/data-architecture.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

## Related Plans

- [Shared Session Core](../plans/001-shared-session-core.md)
- [Persistence Recovery And Replay](../plans/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../plans/020-observability-and-failure-recovery.md)
