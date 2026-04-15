# Plan-013: Live Timeline Visibility And Reasoning Surfaces

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `013` |
| **Slug** | `live-timeline-visibility-and-reasoning-surfaces` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-013: Live Timeline Visibility And Reasoning Surfaces](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md) |

## Goal

Implement the replay-backed session timeline, child-run visibility, and policy-aware reasoning surfaces used by the primary collaboration experience.

## Scope

This plan covers timeline projections, live subscribe plus replay recovery, child-run summaries and expansion, and reasoning-availability surfaces.

## Non-Goals

- Notification routing
- Provider-specific reasoning rendering beyond normalized surfaces
- Full timeline design polish

## Preconditions

- [x] Paired spec is approved
- [ ] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/timeline/`
- `packages/runtime-daemon/src/timeline/timeline-projector.ts`
- `packages/runtime-daemon/src/timeline/reasoning-surface-service.ts`
- `packages/runtime-daemon/src/timeline/child-run-summary-service.ts`
- `packages/client-sdk/src/timelineClient.ts`
- `apps/desktop/renderer/src/timeline/`
- `apps/desktop/renderer/src/reasoning-surfaces/`

## Data And Storage Changes

- Add or extend replayable timeline projection storage for ordered rows, child-run summary rows, and reasoning availability metadata.
- Preserve provenance links from timeline rows back to canonical event ids, run ids, runtime nodes, and policy-redaction reasons.
- Store durable reasoning summaries and policy markers separately from any bounded detailed-reasoning diagnostic payloads.

## API And Transport Changes

- Add `TimelineRead`, `TimelineSubscribe`, `ReasoningSurfaceRead`, and `ChildRunExpand` to shared contracts and the typed client SDK.
- Ensure live subscription payloads and replay windows use the same row schema so reconnect recovery does not require projection translation.

## Implementation Steps

1. Define timeline-row, child-run-summary, and reasoning-availability contracts in shared packages.
2. Implement daemon-owned timeline projection and replay-aware subscription delivery from canonical events.
3. Implement child-run expansion plus summary-first, policy-aware reasoning-surface reads with explicit unavailable-or-compacted states.
4. Add desktop timeline rendering for live rows, summarized child runs, and visible unavailable or redacted reasoning placeholders.

## Parallelization Notes

- Projection work and reasoning-surface normalization can proceed in parallel once row schemas are fixed.
- Renderer work should wait for replay-catch-up semantics and unavailable-reason payloads to stabilize.

## Test And Verification Plan

- Projection tests covering ordered messages, run-state changes, tool activity, approvals, artifacts, and child-run summaries
- Replay-gap tests proving clients can recover missing rows without rebuilding from free-form text
- Policy-redaction tests proving unavailable reasoning still produces visible explanation surfaces
- Retention tests proving detailed reasoning expiry or compaction does not erase durable summary and policy surfaces

## Rollout Order

1. Land row schemas and replay-backed projection reads
2. Enable live subscribe plus replay recovery
3. Enable reasoning surfaces and child-run expansion in the primary session experience

## Rollback Or Fallback

- Collapse to summarized timeline rows and disable detailed reasoning expansion if payload shape or policy gating regresses.

## Risks And Blockers

- Per-session verbose reasoning opt-in remains unresolved
- Timeline projections will drift if row schemas are allowed to diverge from canonical event provenance
- Detailed reasoning payloads can be mistaken for canonical history unless summary-first storage stays explicit across contracts and UI

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
