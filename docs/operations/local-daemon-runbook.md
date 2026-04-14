# Local Daemon Runbook

## Purpose

Recover the participant-local execution daemon, the Local Runtime Daemon, when local execution, IPC, or replay health is degraded.

## Symptoms

- Desktop or CLI cannot connect to the Local Runtime Daemon
- Session reads work intermittently or not at all
- New mutable work is blocked because the daemon reports degraded or blocked health
- Scope and blast radius: one participant node, its local sessions, and any runs scheduled on that node

## Detection

- Read `HealthStatusRead` and `RecoveryStatusRead` from the client SDK or admin surface
- Check Local Runtime Daemon start or restart outcome from the desktop shell or CLI
- Inspect local replay status, SQLite availability, and recent crash or restart telemetry

## Preconditions

- Access to the affected participant machine
- Permission to stop and restart the Local Runtime Daemon
- Access to Local Runtime Daemon logs and local SQLite files

## Recovery Steps

1. Read current daemon health and recovery status before restarting anything.
2. If the daemon is blocked on replay or persistence, stop new mutable work and preserve the current state for inspection.
3. Restart the daemon in normal recovery mode and wait for replay or projection rebuild to complete.
4. If restart fails repeatedly, inspect local persistence health and last recovery error, then run the documented local repair or restore path.
5. Reconnect one client and verify session read plus subscribe before re-enabling normal writable work.

## Validation

- Local Runtime Daemon health returns to `healthy`
- Session read and live subscribe succeed through local IPC
- One previously affected session can replay and show current state correctly

## Escalation

- Escalate when local SQLite remains unavailable, replay cannot rebuild, or repeated daemon restarts fail without a clear local fix

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
