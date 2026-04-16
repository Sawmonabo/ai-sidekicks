# Spec-015: Persistence Recovery And Replay

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `015` |
| **Slug** | `persistence-recovery-and-replay` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Data Architecture](../architecture/data-architecture.md), [Run State Machine](../domain/run-state-machine.md), [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md) |
| **Implementation Plan** | [Plan-015: Persistence Recovery And Replay](../plans/015-persistence-recovery-and-replay.md) |

## Purpose

Define the persistence contract that allows restart recovery, replay, and durable local execution truth.

## Scope

This spec covers local persistence, shared coordination persistence, recovery rules, and replay expectations.

## Non-Goals

- Full operations procedures
- Detailed schema design
- Provider-driver internal persistence formats

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)

## Architectural Dependencies

- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Required Behavior

- Each runtime node must persist canonical local execution state in a durable local store.
- The default local execution store must be SQLite with WAL and foreign keys enabled.
- The default shared collaboration store must be Postgres or an equivalent relational control-plane store.
- Canonical local execution data must include session events, queue state, approvals, runtime bindings, and command receipts.
- Restart recovery must attempt:
  1. projection rebuild from canonical events
  2. restoration of runtime bindings
  3. resumption or explicit failure transition for in-flight runs
- Replay must be possible without client memory or ad hoc transcript reconstruction.

## Default Behavior

- Local mutable operations are blocked if the local durable store is unavailable.
- Recovery runs automatically on daemon startup before new mutable work is accepted.
- Recovery prefers adopting existing live provider sessions where possible before using stored resume handles.

## Fallback Behavior

- If a persisted driver handle cannot be resumed, the affected run must transition to `failed` with visible recovery failure detail rather than silently disappearing or restarting as a new run.
- If projection rebuild fails, the daemon may enter degraded read-only mode while exposing repair signals.
- If shared control-plane storage is unavailable, local execution may continue for already attached local sessions, but shared membership and invite operations must fail explicitly.

## Interfaces And Contracts

- `RecoveryStatusRead` must expose whether the node is healthy, replaying, degraded, or blocked.
- `ReplayReadAfterCursor` must read authoritative events after a known cursor.
- `ProjectionRebuild` must be idempotent.
- `RuntimeBindingRead` must expose the data needed to attempt session adoption or resume.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Local canonical event data and command receipts are the basis for replay and idempotency.
- Shared control-plane data remains separate from local execution truth.
- Recovery outcomes must be surfaced into canonical event history and operational telemetry.

## Example Flows

- `Example: The daemon restarts during a blocked approval state. Startup replay rebuilds the session projection, restores the pending approval, and resumes the session in a recoverable waiting state.`
- `Example: A provider session cannot be resumed. The daemon records a recovery failure outcome, transitions the run to failed with provider failure detail and recovery-needed condition, and leaves the run visible to users and operators for intervention.`

## Implementation Notes

- Recovery is a first-class product behavior, not just an operator tool.
- SQLite durability settings are part of the correctness contract for local execution.
- Projection rebuild logic should be testable in isolation from live provider transports.

## Pitfalls To Avoid

- Treating client cache as sufficient for recovery
- Silently dropping in-flight run state after restart
- Using one undifferentiated store for both local execution and shared collaboration truth

## Acceptance Criteria

- [ ] Local node restart can rebuild session projections and restore pending queue or approval state.
- [ ] Local mutable work is blocked when canonical local persistence is unavailable.
- [ ] Recovery failure is visible and auditable rather than silent.

## ADR Triggers

- If the product changes the local-vs-shared storage split or the default local persistence engine, create or update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: snapshot compaction cadence is not standardized in v1. Correctness must not depend on compaction, and implementations may run without scheduled compaction.

## References

- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
