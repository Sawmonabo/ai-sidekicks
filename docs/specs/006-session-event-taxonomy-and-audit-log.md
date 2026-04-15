# Spec-006: Session Event Taxonomy And Audit Log

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `006` |
| **Slug** | `session-event-taxonomy-and-audit-log` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Session Model](../domain/session-model.md), [Run State Machine](../domain/run-state-machine.md), [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md), [Data Architecture](../architecture/data-architecture.md), [Observability Architecture](../architecture/observability-architecture.md) |
| **Implementation Plan** | [Plan-006: Session Event Taxonomy And Audit Log](../plans/006-session-event-taxonomy-and-audit-log.md) |

## Purpose

Define the canonical event envelope and taxonomy used for replay, audit, and live projections.

## Scope

This spec covers event categories, required event fields, ordering, replay, and audit retention requirements.

## Non-Goals

- Full UI rendering rules for the timeline
- Metrics-only observability details
- Storage engine implementation details

## Domain Dependencies

- [Session Model](../domain/session-model.md)
- [Run State Machine](../domain/run-state-machine.md)
- [Artifact Diff And Approval Model](../domain/artifact-diff-and-approval-model.md)

## Architectural Dependencies

- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)

## Required Behavior

- Every durable session-relevant change must emit a canonical event.
- Canonical events must include at least `eventId`, `sessionId`, `sequence`, `occurredAt`, `category`, `type`, `actor`, and correlation or causation metadata where applicable.
- The taxonomy must cover at least:
  - session lifecycle
  - invite and membership
  - participant and runtime-node presence
  - channel and agent lifecycle
  - run lifecycle
  - queue and intervention
  - approval requests and resolutions
  - repo, workspace, and worktree lifecycle
  - artifact and diff publication
- Events must be immutable after append.
- Replay must support reading after a known cursor and reading bounded windows.

## Default Behavior

- Canonical event metadata is retained indefinitely unless an explicit retention policy supersedes it.
- Per-session event ordering is presented as a monotonically increasing sequence in session projections.
- High-volume payloads may be compacted, but their audit stub must preserve type, actor, timestamps, and provenance.

## Fallback Behavior

- If a client detects a live-stream gap, it must rehydrate from the canonical event log starting after the last acknowledged sequence.
- If full payload data has been compacted, the system must still return an audit-visible stub rather than pretending the event never existed.
- If a producer cannot emit a canonical event immediately, the related state change must not be considered committed.

## Interfaces And Contracts

- `EventEnvelope` must be versioned.
- `EventReadAfterCursor` must return ordered events plus next replay cursor.
- `EventReadWindow` must support bounded historical windows for replay and inspection.
- `EventSubscription` must expose live append-only delivery together with replay catch-up semantics.

## State And Data Implications

- Canonical events are the source of truth for replay and audit.
- Read projections may be rebuilt from canonical events.
- Command receipts or equivalent idempotency markers are required for safe replay of side-effecting command paths.

## Example Flows

- `Example: A run starts, emits tool activity, requests approval, publishes a diff artifact, and completes. Each change becomes a canonical session event with causation and actor metadata.`
- `Example: A participant reconnects after missing events and requests replay after the last acknowledged session sequence.`

## Implementation Notes

- Keep the event taxonomy stable and additive; avoid repurposing old types with new semantics.
- Treat provider-native diagnostic events as separate from canonical business events unless they are normalized.
- Replay must be safe for both operators and user-facing timeline projections.

## Pitfalls To Avoid

- Using final assistant text as the only historical source
- Mutating or deleting canonical events in normal operation
- Leaving approval or intervention decisions out of the audit log

## Acceptance Criteria

- [ ] Every run lifecycle transition results in one or more canonical session events.
- [ ] A client can recover missed state by replaying events after its last known cursor.
- [ ] Approval, membership, and artifact changes are visible in audit history even after payload compaction.

## ADR Triggers

- If the system stops using append-only canonical events as the replay source, create or update `../decisions/004-sqlite-local-state-and-postgres-control-plane.md`.

## Open Questions

- No blocking open questions remain for v1.
- V1 decision: session sequence numbers are assigned by the authoritative session-visible append path at write time. Projection merge must preserve those numbers and must not invent them later.

## References

- [Run State Machine](../domain/run-state-machine.md)
- [Data Architecture](../architecture/data-architecture.md)
- [Observability Architecture](../architecture/observability-architecture.md)
