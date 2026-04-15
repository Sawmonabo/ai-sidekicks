# Plan-004: Queue Steer Pause Resume

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `004` |
| **Slug** | `queue-steer-pause-resume` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-004: Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md) |
| **Required ADRs** | [ADR-003](../decisions/003-daemon-backed-queue-and-interventions.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) |

## Goal

Implement daemon-backed queue state and authoritative intervention handling for active runs.

## Scope

This plan covers queue persistence, intervention records, run-state transitions, and client control surfaces for queue, steer, pause, resume, and interrupt.

## Non-Goals

- Workflow scheduling
- Provider-specific pause emulation beyond declared capabilities
- Notification routing

## Preconditions

- [x] Paired spec is approved
- [ ] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/runControl.ts`
- `packages/runtime-daemon/src/queue/queue-store.ts`
- `packages/runtime-daemon/src/interventions/intervention-service.ts`
- `packages/runtime-daemon/src/session/run-engine.ts`
- `packages/client-sdk/src/runControlClient.ts`
- `apps/desktop/renderer/src/run-controls/`

## Data And Storage Changes

- Add local `queue_items`, `interventions`, and `command_receipts` tables.
- Extend `session_events` projections with queue and intervention read models.

## API And Transport Changes

- Add queue list/create/cancel endpoints and intervention request or result events to the client SDK.

## Implementation Steps

1. Define run-control contracts and migrations.
2. Implement queue store and serialized intervention application in the daemon.
3. Integrate run-engine state transitions and capability checks.
4. Add desktop queue and intervention controls plus status rendering.

## Parallelization Notes

- Queue store and run-engine integration can proceed in parallel once the contracts are fixed.
- UI controls should wait for intervention result semantics to stabilize.

## Test And Verification Plan

- Queue durability tests across daemon restart
- State-machine tests for pause, resume, interrupt, and blocked states
- Manual verification of queue then steer then interrupt flows

## Rollout Order

1. Ship queue persistence and read-only queue visibility
2. Enable queue mutation and interrupt
3. Enable steer and pause/resume where driver capabilities allow

## Rollback Or Fallback

- Disable pause or steer controls and keep queue or interrupt only if capability handling regresses.

## Risks And Blockers

- Provider capability mismatch can produce misleading controls
- Queue concurrency across multiple clients needs strict daemon serialization

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
