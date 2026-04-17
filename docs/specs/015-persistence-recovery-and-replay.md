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
- [ADR-003: Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
- [ADR-004: SQLite Local State And Postgres Control Plane](../decisions/004-sqlite-local-state-and-postgres-control-plane.md)

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

## Idempotency Protocol

Side-effecting tool calls that may be retried — either by the driver on transient failure, or by the daemon during restart recovery — must not execute twice. The daemon enforces exactly-once semantics via a **two-phase command receipt**: `accept` → `execute` → terminal-status, with each phase committed in its own SQLite transaction. A tool call is uniquely identified by `command_id` (the idempotency key) and may additionally carry a caller-supplied `dedupe_key` for remote-side deduplication.

### Two-Phase Receipt Commit

```sql
-- Phase 1: accept (one transaction)
BEGIN;
  INSERT INTO command_receipts
    (id, command_id, run_id, status, idempotency_class, dedupe_key, created_at)
    VALUES (?, ?, ?, 'accepted', ?, ?, now());
COMMIT;

-- Phase 2: execute (one transaction, optimistic compare-and-set)
BEGIN;
  UPDATE command_receipts
    SET started_at = now()
    WHERE id = ? AND started_at IS NULL;
  -- rowcount = 1 → this worker owns the execution; rowcount = 0 → another worker
  -- already claimed the receipt, abort this attempt without invoking the tool.
COMMIT;
-- side-effecting tool call happens here, outside any DB transaction

-- Phase 3: terminal-status (one transaction)
BEGIN;
  UPDATE command_receipts
    SET status = ?, completed_at = now()
    WHERE id = ?;
  -- status ∈ {'completed','failed'}; 'rejected' is only set at accept-time.
COMMIT;
```

The `UPDATE ... SET started_at = now() WHERE started_at IS NULL` in Phase 2 is an **optimistic compare-and-set primitive**. Under SQLite WAL mode it is serializable on the row's page, so exactly one concurrent caller observes a rowcount of 1 and proceeds to invoke the tool; all others observe 0 and abort without invoking. This closes the double-execution window during concurrent restart recovery, where multiple recovery workers might race to re-drive the same in-flight receipt.

### Idempotency Classes and Recovery Behavior

Drivers declare `tool.idempotency_class` per-tool at attach time (see [Spec-005 § Tool Metadata](005-provider-driver-contract-and-capabilities.md#tool-metadata)). A receipt whose Phase 2 started but never reached Phase 3 — `started_at IS NOT NULL AND completed_at IS NULL` — is an in-flight receipt.

The in-flight-receipt sweep runs **only at daemon startup**, per [§Default Behavior](#default-behavior) ("Recovery runs automatically on daemon startup before new mutable work is accepted"). While the daemon is running, an in-flight marker denotes a live worker that owns the receipt and is actively invoking the tool; another worker MUST NOT re-claim it. The optimistic CAS in Phase 2 covers the narrow concurrent-boot race (for example a supervisor restarting the daemon twice in quick succession or two recovery workers racing on the same receipt); it is **not** a general garbage-collector for long-running in-flight executions. A receipt stuck in-flight across a fully-live daemon is treated as a bug, not a recovery input.

Recovery dispatches on `idempotency_class`:

| Class | Recovery Behavior |
| --- | --- |
| `idempotent` | Re-execute the tool. External deduplication (if any) is the tool's responsibility. Emit `tool.replayed`. |
| `compensable` | Re-execute the tool with the receipt's `dedupe_key` attached so the remote side can reject duplicates. Pattern follows [Stripe idempotency keys](https://docs.stripe.com/api/idempotent_requests). On confirmed duplicate response, emit `tool.skipped_during_recovery`. |
| `manual_reconcile_only` | Do **not** re-execute. Halt the affected run with a `recovery-needed` condition per [Spec-005 § Fallback Behavior](005-provider-driver-contract-and-capabilities.md#fallback-behavior). Emit `tool.skipped_during_recovery` and surface an operator escalation. |

Examples: `idempotent` covers pure reads (`file.read`, `shell.stat`) and server-side-idempotent writes (for example `S3 PutObject` with `If-Match`). `compensable` covers Stripe charges, payment authorizations, and any remote side that honors a client-supplied idempotency key. `manual_reconcile_only` covers one-shot external actions where the remote side offers no deduplication — for example a webhook to a legacy system or a PR merge on a remote repo — and where executing twice would produce a user-visible incident.

### Recovery Events

Two event types are reserved for tool-recovery outcomes, both with category `tool_activity`. They are registered here and in [Spec-006](006-session-event-taxonomy-and-audit-log.md), with full taxonomy-table enumeration tracked by [BL-064](../backlog.md):

| Type | Description |
| --- | --- |
| `tool.replayed` | A tool with `idempotency_class ∈ {idempotent, compensable}` was re-executed during recovery. Payload: `{sessionId, runId, commandId, idempotencyClass, dedupeKey?}`. |
| `tool.skipped_during_recovery` | A tool with `idempotency_class = 'manual_reconcile_only'` was detected in-flight during recovery and was **not** re-executed. Payload: `{sessionId, runId, commandId, reason}`. |

### References

- [Spec-005 § Tool Metadata](005-provider-driver-contract-and-capabilities.md#tool-metadata) — per-tool `idempotency_class` declaration
- [Local SQLite Schema § Command Receipts](../architecture/schemas/local-sqlite-schema.md) — `command_receipts` table and two-phase columns
- [Stripe Idempotency Keys](https://docs.stripe.com/api/idempotent_requests) — canonical precedent for `compensable`
- [Sagas: Long-Lived Transactions — Garcia-Molina & Salem, 1987](https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf) — precedent for compensating-transaction pattern

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
