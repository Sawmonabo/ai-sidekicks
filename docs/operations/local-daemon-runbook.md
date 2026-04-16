# Local Daemon Runbook

## Purpose

Recover the participant-local execution daemon, the Local Runtime Daemon, when local execution, IPC, or replay health is degraded.

## Symptoms

- Desktop or CLI cannot connect to the Local Runtime Daemon
- Session reads work intermittently or not at all
- New mutable work is blocked because the daemon reports degraded or blocked health
- Scope and blast radius: one participant node, its local sessions, and any runs scheduled on that node

## Detection

- Read `DaemonStatusRead`, `HealthStatusRead`, and `RecoveryStatusRead` through the typed client SDK or CLI client.
- Check the most recent Local Runtime Daemon start or restart outcome from the desktop shell or CLI client.
- Inspect Local Runtime Daemon logs for one of these categories before acting:
  - IPC bind failure
  - SQLite open or lock failure
  - replay rebuild failure
  - provider resume or runtime binding recovery failure

## Preconditions

- Access to the affected participant machine
- Permission to stop and restart the Local Runtime Daemon
- Access to Local Runtime Daemon logs and local SQLite files

## Recovery Steps

1. Read and record `DaemonStatusRead`, `HealthStatusRead`, and `RecoveryStatusRead` before restarting anything.
2. If the daemon reports `blocked` or `degraded`, stop new mutable work on the affected node and leave read surfaces available for diagnosis.
3. Restart the daemon through `DaemonRestart` or by issuing `DaemonStop` followed by `DaemonStart`.
4. If restart succeeds, wait for `RecoveryStatusRead` to leave replay or rebuild mode before resuming writable work.
5. If restart fails with SQLite, replay, or projection-rebuild errors, follow [Local Persistence Repair And Restore](./local-persistence-repair-and-restore.md) before trying another restart.
6. If restart fails because of provider resume or runtime-binding recovery, follow [Provider Failure Runbook](./provider-failure-runbook.md).
7. Reconnect one CLI client and one desktop client, then verify session read plus live subscribe before re-enabling normal writable work.

## Validation

- Local Runtime Daemon health returns to `healthy`
- `DaemonStatusRead` reports a reachable and version-compatible daemon
- Session read and live subscribe succeed through local IPC
- One previously affected session can replay and show current state correctly

## Escalation

- Escalate when local SQLite remains unavailable, replay cannot rebuild after the repair path, or repeated daemon restarts fail without a stable failure category

## CLI Commands

```bash
sidekicks daemon status
sidekicks daemon restart
sidekicks daemon logs --tail 100
sidekicks daemon config show
sidekicks daemon health
sidekicks daemon stop
sidekicks daemon start
```

## SLOs and Thresholds

| Metric | Target |
|---|---|
| Startup time | < 3s |
| Event append latency | < 10ms |
| SQLite WAL checkpoint | < 5s |
| IPC round-trip latency (p99) | < 50ms |
| Health check interval | every 10s |

## On-Call Routing

- **Severity 1** (service down): Page on-call engineer immediately. Escalate to team lead after 15min.
- **Severity 2** (degraded): Alert on-call via Slack. Investigate within 30min.
- **Severity 3** (warning): Log alert. Review during business hours.
- **Domain routing**: Daemon issues route to **platform on-call**.

## Related Architecture Docs

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Local IPC And Daemon Control](../specs/007-local-ipc-and-daemon-control.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

## Related Plans

- [Shared Session Core](../plans/001-shared-session-core.md)
- [Queue Steer Pause Resume](../plans/004-queue-steer-pause-resume.md)
- [Persistence Recovery And Replay](../plans/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../plans/020-observability-and-failure-recovery.md)
