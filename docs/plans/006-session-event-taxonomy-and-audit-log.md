# Plan-006: Session Event Taxonomy And Audit Log

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `006` |
| **Slug** | `session-event-taxonomy-and-audit-log` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-006: Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session event tables) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement the canonical append-only session event contract used for replay, audit, and live projection rebuild.

## Scope

This plan covers event envelope contracts, append-only persistence, replay reads, live subscriptions, and projector integration.

## Non-Goals

- Full timeline UI rendering
- Metrics and dashboard implementation
- Long-term retention policy automation

## Preconditions

- [x] Paired spec is approved
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/events/`
- `packages/runtime-daemon/src/events/event-log-service.ts`
- `packages/runtime-daemon/src/events/event-projector.ts`
- `packages/runtime-daemon/src/events/replay-service.ts`
- `packages/control-plane/src/session-events/`
- `packages/client-sdk/src/eventClient.ts`
- `apps/desktop/renderer/src/timeline/`

## Data And Storage Changes

- Extend local `session_events` and `session_snapshots` persistence with canonical envelope fields, replay cursors, and compaction-stub support.
- Add shared event-sequencing or event-bridge records where control-plane coordination events must become session-visible.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add `EventReadAfterCursor`, `EventReadWindow`, and `EventSubscription` to the shared client SDK and daemon or control-plane contracts.
- Define versioned `EventEnvelope` and canonical event-category schema in shared contracts.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define the canonical event envelope, category registry, and idempotency markers in shared contracts.
2. Implement append-only local event persistence plus projector hooks in the Local Runtime Daemon.
3. Implement replay reads, live subscription catch-up, and compaction-stub behavior.
4. Wire shared coordination events into the same canonical taxonomy where required and expose typed client SDK reads.

## Parallelization Notes

- Contract taxonomy work and daemon append-log scaffolding can proceed in parallel once the envelope shape is fixed.
- Timeline UI integration should wait for replay and subscription payloads to stabilize.

## Test And Verification Plan

- Envelope-schema and category conformance tests
- Replay integration tests for cursor catch-up and bounded history windows
- Audit-history tests covering approvals, memberships, and artifact publication after compaction

## Rollout Order

1. Land envelope contracts and persistence changes
2. Enable append-only writes and replay reads behind internal feature gating
3. Enable live subscription catch-up and projector rebuild paths

## Rollback Or Fallback

- Freeze new event-category adoption and keep replay on the last stable envelope version if taxonomy rollout regresses.

## Risks And Blockers

- Session-sequence assignment resolved: sequence numbers are assigned by the authoritative session-visible append path at write time (see Spec-006 Open Questions). Category drift remains the primary risk
- Category drift can break replay or audit interpretation if additive discipline is not enforced

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
