# Local Daemon Runbook

## Purpose

Recover the user-local execution daemon, the Local Runtime Daemon, when local execution, IPC, or replay is failing.

## Symptoms

- Desktop or CLI cannot connect to the Local Runtime Daemon
- Session reads work intermittently or not at all
- New mutable work is refused because the daemon is in its degraded read-only mode
- Scope and blast radius: one machine, its local sessions, and any runs on it

## Detection

- Run `sidekicks daemon status` on the machine, or open Settings › Runtime. It says whether the service is up, since when, its version, its processor and memory use. A service that is not answering says so, and on Windows the status names the reason the service cannot start.
- Check the most recent start or restart outcome on Settings › Runtime or from the CLI client.
- Inspect Local Runtime Daemon logs for one of these categories before acting:
  - IPC bind failure
  - SQLite open or lock failure
  - replay rebuild failure
  - provider resume or runtime binding recovery failure

## Preconditions

- Access to the affected user machine
- Permission to stop and restart the Local Runtime Daemon
- Access to Local Runtime Daemon logs and local SQLite files

## Recovery Steps

1. Run `sidekicks daemon status` and record its output before restarting anything.
2. If the daemon is in its degraded read-only mode, start no new mutable work on the machine and leave read surfaces available for diagnosis.
3. Restart the daemon: `Restart` on Settings › Runtime, `sidekicks daemon restart`, or `sidekicks daemon stop` followed by `sidekicks daemon start`. Work in flight stops.
4. If restart succeeds, run `sidekicks daemon status` again and resume writable work once it reads the service as running with its store open.
5. If restart fails with SQLite, replay, or projection-rebuild errors, follow [Local Persistence Repair And Restore](./local-persistence-repair-and-restore.md) before trying another restart.
6. If restart fails because of provider resume or runtime-binding recovery, follow [Provider Failure Runbook](./provider-failure-runbook.md).
7. Reconnect one CLI client and one desktop client, then verify session read plus live subscribe before re-enabling normal writable work.

## Validation

- `sidekicks daemon status` reads the service as running, with its store open
- `sidekicks daemon status` reports the service's version, and each app accepts it: an app accepts its own service version and the one before it
- Session read and live subscribe succeed through local IPC
- One previously affected session can replay and show current state correctly

## Escalation

- When local SQLite remains unavailable, replay cannot rebuild after the repair path, or repeated daemon restarts fail without a stable failure category, report it to the project as a bug with the daemon's logs and the output of `sidekicks daemon status` attached

## CLI Commands

```bash
sidekicks daemon status
sidekicks daemon restart
sidekicks daemon stop
sidekicks daemon start
```

## SLOs and Thresholds

| Metric                       | Target |
| ---------------------------- | ------ |
| Startup time                 | < 3s   |
| Event append latency         | < 10ms |
| SQLite WAL checkpoint        | < 5s   |
| IPC round-trip latency (p99) | < 50ms |

## Who Runs It And Where To Report

- The machine belongs to one person, who runs this procedure on it; there is no paging, no chat alert and no on-call rotation.
- A daemon that stays down after these steps is reported to the project as a bug, with the daemon's logs and the output of `sidekicks daemon status` attached.

## Related Architecture Docs

- [Daemon Architecture](../architecture/daemon.md)
- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Local IPC And Daemon Control](../specs/006-local-ipc-and-daemon-control.md)
- [Persistence Recovery And Replay](../specs/013-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md)

## Related Plans

- [Session Core](../plans/001-session-core.md)
- [Queue Steer Pause Resume](../plans/002-queue-steer-pause-resume.md)
- [Persistence Recovery And Replay](../plans/012-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../plans/017-observability-and-failure-recovery.md)
