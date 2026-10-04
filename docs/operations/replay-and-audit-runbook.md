# Replay And Audit Runbook

## Purpose

Recover replay and audit projections when session history appears incomplete, stale, or inconsistent.

## Symptoms

- Transcript is missing known events
- Audit history stops before the current session state
- The daemon is in its degraded read-only mode after a projection rebuild failed
- Scope and blast radius: one session projection, or the machine's local event store

## Detection

- Compare `ReplayReadAfterCursor` results with the latest canonical event sequence for the affected session.
- Read the `recovery` field on `daemon.status.read` (healthy, replaying, degraded or blocked, with each session's state) plus projection lag signals for the affected node or session.
- Verify whether missing history is an expected purge (a session removed by `Delete old data` is deleted with its rows), stale projection state, or true canonical-event loss.

## Preconditions

- Access to canonical event storage and projection status
- Ability to pause new mutable work if replay safety is uncertain
- Access to command receipts and projection rebuild tooling

## Recovery Steps

1. Confirm whether canonical events exist for the missing history before attempting rebuild.
2. If projection lag or failure is present, start no new mutable work in the affected session until the history is understood.
3. Restart the daemon (`Restart` on Settings › Runtime, or `sidekicks daemon restart`). Startup runs `ProjectionRebuild`, which rebuilds every session projection from canonical events, idempotently, before any new mutable work is accepted.
4. If canonical local storage is damaged or unreadable, stop and follow [Local Persistence Repair And Restore](./local-persistence-repair-and-restore.md) before rebuilding again.
5. Validate command receipts and artifact manifests for any side-effecting ranges that were replayed.
6. Re-open mutable work only after the session transcript matches canonical event ranges again.

## Validation

- `sidekicks daemon status` reads the service as running with its store open
- Transcript and audit projections match canonical event ranges for the affected session
- No duplicate side effects appear after replay rebuild
- `ReplayReadAfterCursor` from the prior failure point returns the expected missing range without divergence

## Escalation

- When canonical events are missing, the rebuild is not idempotent, or the transcript diverges again immediately after a rebuild, report it to the project as a bug with the daemon's logs attached

## CLI Commands

```bash
sidekicks daemon status          # the service and its store
sidekicks daemon restart         # startup rebuilds every projection
sidekicks export-data <folder>   # every session's events, one per line
```

## SLOs and Thresholds

| Metric                  | Target                        |
| ----------------------- | ----------------------------- |
| Replay projection lag   | < 30s behind canonical events |
| Projection rebuild      | < 60s per 10k events          |
| Event export throughput | > 1k events/s                 |

## Who Runs It And Where To Report

- The machine belongs to one person, who runs this procedure on it; there is no paging, no chat alert and no on-call rotation.
- History that stays missing or diverges again after these steps is reported to the project as a bug, with the daemon's logs attached.

## Related Architecture Docs

- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/013-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/018-observability-and-failure-recovery.md)

## Related Plans

- [Session Core](../plans/001-session-core.md)
- [Queue Steer Pause Resume](../plans/002-queue-steer-pause-resume.md)
- [Persistence Recovery And Replay](../plans/012-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../plans/017-observability-and-failure-recovery.md)
