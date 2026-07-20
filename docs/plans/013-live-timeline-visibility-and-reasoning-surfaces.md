# Plan-013: Live Timeline Visibility And Reasoning Surfaces

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `013` |
| **Slug** | `live-timeline-visibility-and-reasoning-surfaces` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-013: Live Timeline Visibility And Reasoning Surfaces](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
| **Dependencies** | [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (event taxonomy), [Plan-004](./004-queue-steer-pause-resume.md) (superseded-turn read seam — the exported `supersededTurns(runId)` attribution read, CP-004-13) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement the replay-backed session timeline, child-run visibility, and policy-aware reasoning surfaces used by the primary collaboration experience.

## Scope

This plan covers timeline projections, live subscribe plus replay recovery, child-run summaries and expansion, and reasoning-availability surfaces.

## Non-Goals

- Notification routing
- Provider-specific reasoning rendering beyond normalized surfaces
- Full timeline design polish

## Preconditions

- [ ] Paired spec is approved — Spec-013 flipped to `review` by the 2026-07-20 CP-004-13 consumer amendment (superseded-turn rendering; the audit runbook's spec-amendment rule); the Tier-8 readiness audit, or an earlier batch gate, restores `approved`
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/timeline/`
- `packages/runtime-daemon/src/timeline/timeline-projector.ts`
- `packages/runtime-daemon/src/timeline/reasoning-surface-service.ts`
- `packages/runtime-daemon/src/timeline/child-run-summary-service.ts`
- `packages/client-sdk/src/timelineClient.ts`
- `apps/desktop/src/renderer/src/timeline/`
- `apps/desktop/src/renderer/src/reasoning-surfaces/`

## Data And Storage Changes

- Add or extend replayable timeline projection storage for ordered rows, child-run summary rows, and reasoning availability metadata.
- Preserve provenance links from timeline rows back to canonical event ids, run ids, runtime nodes, and policy-redaction reasons.
- Store durable reasoning summaries and policy markers separately from any bounded detailed-reasoning diagnostic payloads.
- Carry the projection-derived superseded marker on timeline rows of rolled-back turns (campaign B9, CP-004-13 — 2026-07-20): computed from Plan-004 T3.14's exported `supersededTurns(runId)` read, epoch-scoped per `Spec-004 §Required Behavior` (a re-executed reused ordinal stays current), provenance to the accepted `run.rolled_back` boundary (run and carried rewind cutoff) plus the projection-derived source epoch, surviving projection rebuilds and composing with audit-stub rows over compacted regions (`Spec-006 §Compacted Event Format`).

## API And Transport Changes

- Add `TimelineRead`, `TimelineSubscribe`, `ReasoningSurfaceRead`, and `ChildRunExpand` to shared contracts and the typed client SDK.
- Ensure live subscription payloads and replay windows use the same row schema so reconnect recovery does not require projection translation.
- `TimelineEntry` carries an optional `superseded` marker struct — `{runId, sourceEpoch, targetPosition}`, present exactly when the row's turn is superseded, absence meaning current — identical on `TimelineRead` windows and `TimelineSubscribe` replay ([API Payload Contracts](../architecture/contracts/api-payload-contracts.md) mirrors the shape); run-scoped rows additionally expose typed `runId` + `position` fields (the projection-resolved originating run position — Plan-004 T3.14's uniform row-to-turn assignment; the session `sequence` is never a run position), the comparands of the live-stream client rule: the `run.rolled_back` boundary entry carries the rewind cutoff, cached rows of that run with `position` above it mark, and rows delivered after the boundary arrive marker-precomputed — a late straggler pre-marked exactly when its stamped attribution ranks above the run's effective lineage-minimum cutoff for its epoch, current within the surviving history; new-epoch rows unmarked — per `Spec-013 §Required Behavior`.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define timeline-row, child-run-summary, and reasoning-availability contracts in shared packages.
2. Implement daemon-owned timeline projection and replay-aware subscription delivery from canonical events — consuming Plan-004 T3.14's exported `supersededTurns(runId)` (CP-004-13) to compute each row's `superseded` marker on read and replay windows, stamping each run-scoped row's `runId` + `position` at emission and marking live-appended rows there too (a late pre-rollback straggler appends pre-marked exactly when its stamped attribution ranks above the run's effective lineage-minimum cutoff for its epoch and current when it ranks into the surviving history; a new-epoch row appends unmarked), emitting the `run.rolled_back` boundary entry with its rewind cutoff for the client-side rule over already-delivered rows, and composing the marker with audit-stub rows over compacted regions.
3. Implement child-run expansion plus summary-first, policy-aware reasoning-surface reads with explicit unavailable-or-compacted states.
4. Add desktop timeline rendering for live rows, summarized child runs, visible unavailable or redacted reasoning placeholders, and the distinct superseded treatment for rolled-back turns — applied live via the `run.rolled_back` boundary entry's idempotent already-delivered-rows rule and rendered from the row marker on read/replay, never dropping rewound history and never marking a re-executed reused ordinal — a compacted superseded row rendering as Plan-006's `<CompactedStubSegment>` (the CP-006-8 audit-stub render contract, consumed here, never re-implemented) composed with the superseded treatment.

## Parallelization Notes

- Projection work and reasoning-surface normalization can proceed in parallel once row schemas are fixed.
- Renderer work should wait for replay-catch-up semantics and unavailable-reason payloads to stabilize.

## Test And Verification Plan

- Projection tests covering ordered messages, run-state changes, tool activity, approvals, artifacts, and child-run summaries
- Replay-gap tests proving clients can recover missing rows without rebuilding from free-form text
- Policy-redaction tests proving unavailable reasoning still produces visible explanation surfaces
- Retention tests proving detailed reasoning expiry or compaction does not erase durable summary and policy surfaces
- Superseded-rendering tests proving live marking keys on the exposed `runId` + `position` pair (already-delivered rows of the rewound run with `position` above the boundary's cutoff take the treatment — never a `sequence` comparison; an above-effective-cutoff late straggler delivered after the boundary arrives pre-marked while a straggler ranking into the surviving history arrives current — the T3.14 late-delivered-sibling case; new-epoch rows never mark), read/replay marker parity with the live outcome, reused-ordinal correctness across the two-rollback sequence Plan-004 T3.14 pins (10→5, re-execute, 7→6 — the second epoch's re-executed turn 6 renders current while the first epoch's turn 6 stays superseded, the epoch-scoping `Spec-004 §Required Behavior` owns), the lineage sequence T3.14 pins (10→5, re-execute to 7, 7→3 — the inherited epoch-0 turn 4 renders superseded via the second rollback's cutoff), and the compacted-stub composition (stub placeholder + superseded marker)

## Rollout Order

1. Land row schemas and replay-backed projection reads
2. Enable live subscribe plus replay recovery
3. Enable reasoning surfaces and child-run expansion in the primary session experience

## Rollback Or Fallback

- Collapse to summarized timeline rows and disable detailed reasoning expansion if payload shape or policy gating regresses.

## Risks And Blockers

- Per-session verbose reasoning opt-in remains unresolved (deferral tracked in parent [Spec-013](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md))
- Timeline projections will drift if row schemas are allowed to diverge from canonical event provenance
- Detailed reasoning payloads can be mistaken for canonical history unless summary-first storage stays explicit across contracts and UI

## Progress Log

### Shipment Manifest

<!-- Machine-readable. Housekeeper-emitted, orchestrator-written, preflight-read.
     Schema authoritative in:
       .claude/skills/plan-execution/scripts/lib/manifest.mjs -->

```yaml
manifest_schema_version: 1
shipped: []
```

### Notes

<!-- Per-PR human commentary (round-trips, learnings, partial-ship details). Append-only. -->

- 2026-07-20 — CP-004-13 consumer registration (campaign B9 follow-up, PR #232): registers the Plan-013 side of Plan-004 T3.14's `supersededTurns(runId)` provide-forward — timeline-projector consumption with at-emission marking for live appends, the `TimelineEntry.superseded` marker struct, the `run.rolled_back` boundary-entry client rule, renderer treatment, and tests — with the paired Spec-013 amendment (superseded-turn-rendering Required Behavior + `run.rolled_back` subtype row + compacted composition + acceptance criterion). Spec-013 flips `approved → review` per the audit runbook's spec-amendment rule (Required Behavior, Acceptance Criteria, and Depends On all changed), and Plan-013 flips `approved → review` with it under the Status Flip Rule's behavior-change row: the amendment adds mandatory plan-body behavior (the step-2/step-4 consumer legs) plus a new cross-plan dependency (Plan-004) — the recorded campaign-precedent flip signature — while minting no new CP row (the obligation ledger is Plan-004's CP-004-13). Both restore together at the Tier-8 readiness audit or an earlier batch gate, the Preconditions spec-box staying unchecked until the spec's restore; adjudication surfaced for lead review in the PR body.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
