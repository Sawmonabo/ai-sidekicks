# Replay And Audit Runbook

## Purpose

Recover replay and audit projections when session history appears incomplete, stale, or inconsistent.

## Symptoms

- Timeline is missing known events
- Audit history stops before the current session state
- Replay health shows lag or rebuild failure
- Scope and blast radius: one session projection, one node-local event store, or one shared audit projection

## Detection

- Compare `ReplayReadAfterCursor` results with the latest canonical event sequence for the affected session.
- Read `RecoveryStatusRead` plus projection lag signals for the affected node or session.
- Verify whether missing history is expected payload compaction, stale projection state, or true canonical-event loss.

## Preconditions

- Access to canonical event storage and projection status
- Ability to pause new mutable work if replay safety is uncertain
- Access to command receipts and projection rebuild tooling

## Recovery Steps

1. Confirm whether canonical events exist for the missing history before attempting rebuild.
2. If projection lag or failure is present, pause new mutable work on the affected node or session until replay health is understood.
3. Rebuild the affected projection from canonical events using `ProjectionRebuild` or the equivalent idempotent replay path.
4. If canonical local storage is damaged or unreadable, stop and follow [Local Persistence Repair And Restore](./local-persistence-repair-and-restore.md) before rebuilding again.
5. Validate command receipts and artifact manifests for any side-effecting ranges that were replayed.
6. Re-open mutable work only after session timeline and audit views match canonical event ranges again.

## Validation

- Replay status returns to healthy
- Timeline and audit projections match canonical event ranges for the affected session
- No duplicate side effects appear after replay rebuild
- `ReplayReadAfterCursor` from the prior failure point returns the expected missing range without divergence

## Escalation

- Escalate when canonical events are missing, replay tooling is not idempotent, or audit surfaces diverge again immediately after rebuild

## CLI Commands

```bash
sidekick replay status --session <id>
sidekick replay rebuild --session <id> --force
sidekick events list --session <id> --after <cursor>
sidekick events export --session <id> --format json
sidekick replay lag --session <id>
sidekick events count --session <id>
```

## SLOs and Thresholds

| Metric | Target |
|---|---|
| Replay projection lag | < 30s behind canonical events |
| Projection rebuild | < 60s per 10k events |
| Audit query p99 latency | < 500ms |
| Event export throughput | > 1k events/s |

## On-Call Routing

- **Severity 1** (service down): Page on-call engineer immediately. Escalate to team lead after 15min.
- **Severity 2** (degraded): Alert on-call via Slack. Investigate within 30min.
- **Severity 3** (warning): Log alert. Review during business hours.
- **Domain routing**: Replay and audit issues route to **backend on-call**.

## Related Architecture Docs

- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Related Specs

- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md)

## Related Plans

- [Shared Session Core](../plans/001-shared-session-core.md)
- [Queue Steer Pause Resume](../plans/004-queue-steer-pause-resume.md)
- [Persistence Recovery And Replay](../plans/015-persistence-recovery-and-replay.md)
- [Observability And Failure Recovery](../plans/020-observability-and-failure-recovery.md)
