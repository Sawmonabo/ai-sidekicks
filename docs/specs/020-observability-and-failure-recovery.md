# Spec-020: Observability And Failure Recovery

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `020` |
| **Slug** | `observability-and-failure-recovery` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md), [Observability Architecture](../architecture/observability-architecture.md), [Data Architecture](../architecture/data-architecture.md) |
| **Implementation Plan** | [Plan-020: Observability And Failure Recovery](../plans/020-observability-and-failure-recovery.md) |

## Purpose

Define the operator- and user-facing contract for detecting failures, diagnosing them, and recovering from degraded runtime conditions.

## Scope

This spec covers failure categories, health signals, stuck-run detection, replay-health visibility, and degraded-mode behavior.

## Non-Goals

- Full incident response procedures
- Specific dashboards or vendor tooling
- Business analytics

## Domain Dependencies

- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Observability Architecture](../architecture/observability-architecture.md)
- [Data Architecture](../architecture/data-architecture.md)

## Required Behavior

- The system must expose health and failure signals for local daemon, provider drivers, replay state, queue state, and control-plane connectivity.
- The system must detect and surface `stuck-suspected` runs, projection lag, failed recovery attempts, and provider-session recovery failures.
- Operators and users must be able to distinguish:
  - transport failure
  - provider failure
  - local persistence failure
  - projection failure
  - policy or approval blockage
- Operators and users must be able to distinguish canonical `RunState` from derived health signals, failure categories, and recovery conditions.
- Degraded modes must be explicit and must preserve as much read visibility as possible.
- Non-canonical observability payloads such as driver raw events, raw command output, high-volume tool traces, and policy-permitted detailed reasoning payloads must use explicit bounded retention separate from canonical event and failure-detail retention.

## Default Behavior

- Local runtime health defaults to visible status categories `healthy`, `degraded`, and `blocked`.
- A run is considered `stuck-suspected` when it exceeds expected heartbeat or event-progress thresholds without entering a terminal or blocking state.
- Replay health defaults to visible status when the daemon is rebuilding projections or recovering bindings after restart.
- Canonical health and failure-detail projections remain durable even after bounded raw diagnostic payloads are compacted or removed.

## Fallback Behavior

- If remote telemetry export is unavailable, local logs, traces, and canonical event replay remain sufficient for diagnosis.
- If projection rebuild fails, the system enters degraded read-only mode instead of accepting unsafe new mutable work.
- If provider recovery fails, the affected run remains visible in canonical state `failed` with `provider failure` detail and `recovery-needed` condition rather than disappearing.
- If bounded diagnostic payload retention has expired, diagnosis must fall back to canonical events, health projections, failure detail, and any retained summaries rather than failing closed.

## Interfaces And Contracts

- `HealthStatusRead` must expose daemon, control-plane, provider, and replay health.
- `FailureDetailRead` must expose machine-readable failure category, recovery condition where applicable, and human-readable summary.
- `StuckRunInspect` must expose the last known progress point, last event time, blocking reason if any, and whether the run is currently `stuck-suspected`.
- `RecoveryActionRequest` must support safe operator-triggered retry where allowed.

## State And Data Implications

- Failure and recovery signals must be derived from canonical state and observability pipelines.
- Health projections must remain queryable even when full timeline UIs are not open.
- Recovery actions and outcomes must be auditable.
- Raw diagnostic payloads are non-canonical observability records with bounded retention and must not become the only source for audit or recovery truth.

## Example Flows

- `Example: A provider session stops emitting events without reaching a terminal state. The run is marked stuck-suspected, the health projection turns degraded, and an operator can inspect the last known progress point. If resume later fails, the run moves to failed with provider failure detail and recovery-needed condition.`
- `Example: Replay rebuild fails on startup. The daemon enters blocked read-only mode, surfaces a recovery error, and refuses new mutable work until repaired.`

## Implementation Notes

- Observability is not separate from recovery; it is the mechanism that makes recovery safe to reason about.
- Failure categories should be enumerable and stable for automation and operations docs.
- Degraded read-only mode is preferable to silent partial mutation during uncertain recovery state.

## Pitfalls To Avoid

- Treating all failures as generic provider errors
- Accepting new mutable work during uncertain replay state
- Hiding recovery failures behind silent retries only

## Acceptance Criteria

- [ ] Users and operators can distinguish blocked, degraded, and healthy runtime conditions.
- [ ] Stuck-run suspicion and replay-health state are visible without opening raw logs.
- [ ] Recovery failures remain visible and auditable until resolved.

## ADR Triggers

- If the system changes how replay or health truth is derived, update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md` or create a new observability ADR.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: automated recovery retries use one product-defined bounded policy across providers in v1. Drivers may mark failures non-retryable, but they do not define independent retry budgets.
- V1 decision: raw diagnostic payload retention is bounded and non-canonical in v1. The product does not standardize one global duration, but every implementation must apply explicit retention policy for driver raw events, raw command output, high-volume tool traces, and any policy-permitted detailed reasoning payloads.

## References

- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)
- [Observability Architecture](../architecture/observability-architecture.md)
- [Data Architecture](../architecture/data-architecture.md)
