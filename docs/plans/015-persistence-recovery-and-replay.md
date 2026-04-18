# Plan-015: Persistence Recovery And Replay

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `015` |
| **Slug** | `persistence-recovery-and-replay` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-015: Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md) |
| **Required ADRs** | [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session events), [Plan-004](./004-queue-steer-pause-resume.md) (queue state), [Plan-005](./005-provider-driver-contract-and-capabilities.md) (runtime bindings), [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (event log), [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (approval records) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement durable local persistence, replay rebuild, and startup recovery for session execution state.

## Scope

This plan covers SQLite-backed canonical local persistence, replay services, runtime-binding restoration, startup recovery sequencing, and recovery-status surfaces.

## Non-Goals

- Operator runbook authoring
- Long-term retention tuning
- Provider-specific internal persistence formats

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/recovery/`
- `packages/runtime-daemon/src/persistence/sqlite/`
- `packages/runtime-daemon/src/recovery/startup-recovery-service.ts`
- `packages/runtime-daemon/src/replay/replay-service.ts`
- `packages/runtime-daemon/src/provider/runtime-binding-store.ts`
- `packages/client-sdk/src/recoveryClient.ts`
- `apps/desktop/renderer/src/recovery-status/`

## Data And Storage Changes

- Add or extend local `session_events`, `session_snapshots`, `command_receipts`, `runtime_bindings`, `queue_items`, and approval-state tables for recovery completeness.
- Add recovery-status projection data and replay cursors needed to expose healthy, replaying, degraded, or blocked startup state.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add `RecoveryStatusRead`, `ProjectionRebuild`, `ReplayReadAfterCursor`, and `RuntimeBindingRead` APIs to the typed client SDK and daemon contract.
- Expose machine-readable recovery outcomes, failure categories, and recovery conditions through the same contracts.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Finalize SQLite schema, receipts, and runtime-binding persistence needed for replay-safe restart.
2. Implement replay rebuild and idempotent projection restoration on daemon startup.
3. Implement runtime-binding adoption or resume logic plus explicit failure transitions for in-flight runs.
4. Expose recovery-status reads and renderer surfaces for degraded or blocked startup conditions.

## Parallelization Notes

- Schema and persistence work can proceed in parallel with replay-service scaffolding once event envelope contracts are stable.
- Renderer recovery-status UI should wait for recovery outcome payloads and machine-readable categories.

## Test And Verification Plan

- SQLite durability and restart recovery integration tests
- Replay rebuild idempotency tests across multiple startup cycles
- Provider-session adoption and failed-resume tests with explicit failure and recovery-needed visibility

## Rollout Order

1. Land persistence schema and receipt storage
2. Enable startup replay rebuild and recovery-status reads
3. Enable automatic in-flight run recovery before mutable work admission

## Rollback Or Fallback

- Disable automatic run resumption and keep replay rebuild plus explicit blocked startup if recovery rollout regresses.

## Risks And Blockers

- Snapshot compaction cadence remains unresolved and may affect rebuild performance
- Recovery ordering mistakes can admit mutable work before canonical local truth is trustworthy

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
