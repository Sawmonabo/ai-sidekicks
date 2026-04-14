# Replay And Audit Runbook

## Purpose

Recover replay and audit projections when session history appears incomplete, stale, or inconsistent.

## Symptoms

- Timeline is missing known events
- Audit history stops before the current session state
- Replay health shows lag or rebuild failure
- Scope and blast radius: one session projection, one node-local event store, or one shared audit projection

## Detection

- Compare current replay cursor with latest canonical event sequence
- Check projection lag metrics and replay status
- Verify whether missing history is payload compaction or true event-loss symptoms

## Preconditions

- Access to canonical event storage and projection status
- Ability to pause new mutable work if replay safety is uncertain
- Access to command receipts and projection rebuild tooling

## Recovery Steps

1. Confirm whether canonical events exist for the missing history before attempting rebuild.
2. If projection lag or failure is present, pause new mutable work on the affected node or session until replay health is understood.
3. Rebuild the affected projection from canonical events using idempotent replay tooling.
4. Validate command receipts and artifact manifests for any side-effecting ranges that were replayed.
5. Re-open mutable work only after session timeline and audit views match canonical event ranges again.

## Validation

- Replay status returns to healthy
- Timeline and audit projections match canonical event ranges for the affected session
- No duplicate side effects appear after replay rebuild

## Escalation

- Escalate when canonical events are missing, replay tooling is not idempotent, or audit surfaces diverge again immediately after rebuild

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
