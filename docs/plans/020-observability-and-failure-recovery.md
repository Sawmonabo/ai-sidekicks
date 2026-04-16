# Plan-020: Observability And Failure Recovery

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `020` |
| **Slug** | `observability-and-failure-recovery` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-020: Observability And Failure Recovery](../specs/020-observability-and-failure-recovery.md) |
| **Required ADRs** | [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md) |
| **Dependencies** | [Plan-015](./015-persistence-recovery-and-replay.md) (persistence layer) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement the health, failure-detail, stuck-run, and recovery-action surfaces needed for safe diagnosis and operator response.

## Scope

This plan covers runtime health projections, failure-category reads, stuck-run inspection, recovery-action requests, and degraded-mode visibility across daemon and control-plane dependencies.

## Non-Goals

- External dashboard or vendor-tool rollout
- Full incident-management workflow
- Business analytics

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/health/`
- `packages/runtime-daemon/src/observability/health-status-service.ts`
- `packages/runtime-daemon/src/observability/failure-detail-service.ts`
- `packages/runtime-daemon/src/observability/stuck-run-inspector.ts`
- `packages/control-plane/src/health/`
- `packages/client-sdk/src/healthClient.ts`
- `apps/desktop/renderer/src/health-and-recovery/`

## Data And Storage Changes

- Add daemon-owned health projections and failure-detail records derived from canonical events, replay state, and provider diagnostics.
- Add recovery-action audit records and surfaced health snapshots needed for operators and user-facing projections.
- Add bounded-retention handling for raw diagnostic payload classes so compaction never removes canonical health or failure truth.
- See [Shared Postgres Schema](../architecture/schemas/shared-postgres-schema.md) for column definitions.

## API And Transport Changes

- Add `HealthStatusRead`, `FailureDetailRead`, `StuckRunInspect`, and `RecoveryActionRequest` to the typed client SDK and daemon contracts.
- Expose control-plane dependency health in a form that can be merged with daemon-owned observability projections.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define health-status, failure-category, recovery-condition, and stuck-run inspection contracts.
2. Implement daemon-owned health and failure-detail projections derived from canonical state and provider diagnostics.
3. Implement safe recovery-action request handling and audit recording.
4. Implement bounded-retention policy handling for raw diagnostics without weakening canonical diagnosis surfaces.
5. Add desktop recovery and health surfaces that distinguish runtime state, failure categories, and degraded modes without requiring raw logs.

## Parallelization Notes

- Contract work and daemon projection work can proceed in parallel once recovery vocabulary is fixed.
- Desktop health surfaces should wait for stable machine-readable payloads and actionability rules.

## Test And Verification Plan

- Health-projection tests for healthy, degraded, and blocked runtime conditions
- Stuck-run detection tests covering thresholds, blocking-state exemptions, and false-positive suppression
- Recovery-action audit and safety tests for provider, replay, and persistence failure scenarios
- Retention tests proving compaction of raw diagnostics does not erase canonical failure detail or recovery visibility

## Rollout Order

1. Ship health and failure-detail projections
2. Enable stuck-run inspection and degraded-mode UI visibility
3. Enable operator-triggered recovery actions where policy allows

## Rollback Or Fallback

- Disable operator-triggered recovery actions and keep read-only observability surfaces if action handling regresses.

## Risks And Blockers

- Automated retry policy remains unresolved across drivers
- Health projections can become misleading if replay and provider diagnostics are not merged from authoritative sources
- Bounded-retention implementation can become misleading if raw diagnostic expiry is not clearly distinguished from canonical observability truth

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
