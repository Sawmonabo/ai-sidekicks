# Plan-013: Live Timeline Visibility And Reasoning Surfaces

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `013` |
| **Slug** | `live-timeline-visibility-and-reasoning-surfaces` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-013: Live Timeline Visibility And Reasoning Surfaces](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md) |
| **Required ADRs** | [ADR-001](../decisions/001-session-is-the-primary-domain-object.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
| **Dependencies** | [Plan-006](./006-session-event-taxonomy-and-audit-log.md) (event taxonomy), [Plan-004](./004-queue-steer-pause-resume.md) (superseded-turn read seam — the exported `supersededTurns(runId)` attribution read, CP-004-13), [Plan-016](./016-multi-agent-channels-and-orchestration.md) (durable child-run events + carrier consumed for timeline summary rows; Plan-016 publishes events only, D-016-14), [Plan-005](./005-provider-driver-contract-and-capabilities.md) (`usage_telemetry` driver events feeding the composer usage meters — `usage.context_window_update` / `usage.context_compacted` for the context-window meter, consumed off Plan-006's `event.subscribe` read path; declared from this side only, no Plan-013-minted ledger row — the provider-side registration rides the lead-owned amendment §Preconditions names) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |

## Goal

Implement the replay-backed session timeline, child-run visibility, policy-aware reasoning surfaces, and composer usage meters used by the primary collaboration experience.

## Scope

This plan covers timeline projections, live subscribe plus replay recovery, child-run summaries and expansion, reasoning-availability surfaces, and the composer usage meters (the context-window meter and the rate-limit indicator, `Spec-013 §Context Window and Usage Meters`).

## Non-Goals

- Notification routing
- Provider-specific reasoning rendering beyond normalized surfaces
- Full timeline design polish

## Invariants

- **I-013-1** — Every run-scoped timeline row carries the complete attribution triple `runId` + `position` + `epoch`, all-or-none; a partial row fails SDK schema parse rather than being delivered. Grounds in `Spec-013 §Required Behavior`.
- **I-013-2** — A rolled-back turn is never dropped from the timeline; it is marked superseded and stays renderable. Grounds in `Spec-004 §Required Behavior`.
- **I-013-3** — The `superseded` marker is single-field (`targetPosition`); run identity and source epoch are read from the containing row, so live marking and replay marking cannot disagree. Grounds in `Spec-013 §Required Behavior`.
- **I-013-4** — Superseding is epoch-scoped: a re-executed reused ordinal in a later epoch renders current while the earlier epoch's same ordinal stays superseded. Grounds in `Spec-004 §Required Behavior`.
- **I-013-5** — Every `run.rolled_back` boundary payload validates into the typed `RunRolledBackEvent` shape at projection; no consumer receives an untyped cutoff or performs a cast. Grounds in `Spec-013 §Required Behavior`.
- **I-013-6** — The rollback boundary is delivered visibility-resolved to every filtered subscription admitting any of the affected run's rows, never keyed on the event's optional `channelId`. Grounds in `Spec-013 §Required Behavior`.
- **I-013-7** — Reasoning unavailability always produces a visible explanation surface; redaction never renders as absence. Grounds in `Spec-013 §Acceptance Criteria`.
- **I-013-8** — Detailed-reasoning expiry or compaction never erases the durable summary or the policy marker. Grounds in `Spec-013 §Fallback Behavior`.

## Cross-Plan Obligations

| ID | Direction | Counterparty | Obligation |
| --- | --- | --- | --- |
| CP-004-13 | consumes | Plan-004 | Consumes T3.14's exported `supersededTurns(runId)` attribution read to compute each row's `superseded` marker on read, replay, and live append. Ledger row is Plan-004's; this plan mints none. |
| CP-006-8 | consumes | Plan-006 | Renders compacted superseded rows through Plan-006 T4.8's `<CompactedStubSegment>` audit-stub render contract — consumed, never re-implemented. Bidirectional since 2026-07-20. |
| D-016-14 | consumes | Plan-016 | Consumes Plan-016's durable child-run events and carrier for timeline child-run summary rows; Plan-016 publishes events only. |

## Preconditions

- [x] Paired spec is approved — Spec-013 flipped to `review` by the 2026-07-20 CP-004-13 consumer amendment (superseded-turn rendering; the audit runbook's spec-amendment rule). **Delivered 2026-08-10:** the Tier-8 readiness audit (§6 node NS-20) restored Spec-013 `approved`, adjudicating the CP-004-13 legs contract-complete and shape-matched against Plan-004 T3.14's `supersededTurns(runId)` export.
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Plan-readiness audit complete per [runbook](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-8 walk, §6 node NS-20 (2026-08-10). Findings: 4 critical / 7 major / 2 minor. Residuals this box does not and cannot clear, each requiring a lead-owned amendment except where marked closed in-PR: `Spec-013 §Context Window and Usage Meters` (with its Rate-Limit Display subsection) had no plan coverage — closed in-PR by the Codex-round meter fix (T4.4 / T4.5, the `usage-meters/` target area, the Plan-005 edge, and the rate-limit carrier §Preconditions box below); the `ChildRunSummary` incompleteness marker and the `ReasoningSurfaceReadRequest` principal are unshaped in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) — the `ReasoningSurfaceReadResponse` unavailable-vs-redacted split closed in-PR by the Codex-round contract fix: a closed four-state `availability` discriminated union with per-state field rules; and the Plan-007 / Plan-021 / Plan-023 dependency edges are undeclared in both directions — with one addition from the meter fix: the Plan-005 telemetry edge it consumes is declared from this plan's side only (header Dependencies row; dep-map §2 and §3), its provider-side registration riding the same amendment.
- [ ] **Plan-004 Phase 3 merged** — T3.14 provides the `supersededTurns(runId)` read seam CP-004-13 obliges this plan to consume. Phase 2 below carries the matching `external_plan_phase_merged` gate; Plan-004's own Phase-3 §Preconditions boxes remain open, which the NS-49 restoration cleared audit and status gates for but not phase gates.
- [ ] **Rate-limit indicator carrier reconciled** — `Spec-013 §Rate-Limit Display` sources `remaining` / `limit` / `resetAt` "from response headers returned by control-plane API calls," but no shipped client surface observes control-plane response headers, and the corpus's registered rate-limit carrier is the Plan-005-emitted `usage.rate_limit_update` event (`Spec-006 §Usage Telemetry (usage_telemetry)`) — which carries `{provider, windowMins, usedPercent, resetsAt?}`: no absolute `remaining` / `limit` counts (underivable from a percentage), an optional reset time (spelled `resetsAt`, diverging from the spec's `resetAt`), and node-scope sentinel binding per `Spec-006 §Daemon-Scope Event Binding And Node-Scope Anchoring` (an account-scoped snapshot with no owning session, so the session-scoped event stream a session view consumes has no defined delivery path for it). This box fails until a lead-owned amendment reconciles the spec's source line and field set with a reachable carrier — naming the carrier (the event, or a newly registered response-header observation surface, in which case `Spec-021 §Default Behavior`'s below-25% header-emission rule must also be reconciled with the spec's below-50% visibility band), the count-field disposition, the reset-time spelling, and the session-view delivery path — alongside the provider-side registration of the Plan-005 edge this plan declares one-directionally. T4.5 is the consuming task and does not dispatch while this box is unchecked; the hold is task-scoped and reviewer-checkable (the Plan-014 Tasks-7–10 dispatch-hold shape) — deliberately not a phase-level `precondition_box_checked` entry, which would hold all of Phase 4 while T4.1–T4.4 dispatch on the phase gates alone. Until wired the indicator never renders, which is the spec's own hidden-when-healthy state — fail-safe by construction.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/timeline/`
- `packages/runtime-daemon/src/timeline/timeline-projector.ts`
- `packages/runtime-daemon/src/timeline/reasoning-surface-service.ts`
- `packages/runtime-daemon/src/timeline/child-run-summary-service.ts`
- `packages/client-sdk/src/timelineClient.ts`
- `apps/desktop/src/renderer/src/timeline/`
- `apps/desktop/src/renderer/src/reasoning-surfaces/`
- `apps/desktop/src/renderer/src/usage-meters/`

## Data And Storage Changes

- Add or extend replayable timeline projection storage for ordered rows, child-run summary rows, and reasoning availability metadata.
- Preserve provenance links from timeline rows back to canonical event ids, run ids, runtime nodes, and policy-redaction reasons.
- Store durable reasoning summaries and policy markers separately from any bounded detailed-reasoning diagnostic payloads.
- Carry the projection-derived superseded marker on timeline rows of rolled-back turns (campaign B9, CP-004-13 — 2026-07-20): computed from Plan-004 T3.14's exported `supersededTurns(runId)` read, epoch-scoped per `Spec-004 §Required Behavior` (a re-executed reused ordinal stays current), provenance to the accepted `run.rolled_back` boundary (run and carried rewind cutoff) plus the projection-derived source epoch, surviving projection rebuilds and composing with audit-stub rows over compacted regions (`Spec-006 §Compacted Event Format`).

## API And Transport Changes

- Add `TimelineRead`, `TimelineSubscribe`, `ReasoningSurfaceRead`, and `ChildRunExpand` to shared contracts and the typed client SDK.
- Ensure live subscription payloads and replay windows use the same row schema so reconnect recovery does not require projection translation.
- The timeline row model carries an optional single-field `superseded` marker — `{targetPosition}`, present exactly when the row's turn is superseded, absence meaning current; the marker's run identity and source epoch are the containing row's own `runId` + `epoch`, so no duplicated fields exist to disagree and live marking is identical to replay marking by construction — identical on `TimelineRead` windows and `TimelineSubscribe` replay ([API Payload Contracts](../architecture/contracts/api-payload-contracts.md) mirrors the shape); run-scoped rows are the required-attribution variant `RunScopedTimelineEntry` — `runId` + `position` + `epoch` all required, all-or-none by construction, a partial row failing SDK schema parse (the projection-resolved originating run position and execution epoch — Plan-004 T3.14's uniform row-to-turn assignment and row attribution; the session `sequence` is never a run position, and reused ordinals mean `position` can never recover the epoch) — and every timeline surface returns the `TimelineRow` union, genuinely discriminated on the literal `kind` field (`rollback_boundary` | `run` | `legacy_stub` | `general` — consumers narrow structurally on `row.kind`, never probing the free-form `type`; `legacy_stub` carries a vacuous-attribution-era compacted row: `runId` preserved, position/epoch structurally absent because unknowable), whose boundary arm is the typed `TimelineRollbackBoundary` (payload validated into the `RunRolledBackEvent` shape at projection; the SDK parser hands consumers the narrowed arm, never a cast) carrying the rewind cutoff, the comparands of the live-stream client rule: cached rows of that run with `position` above it mark — each marker just the boundary's cutoff against the row's own identity, identical to replay by construction — and rows delivered after the boundary arrive marker-precomputed — a late straggler pre-marked exactly when its stamped attribution ranks above the run's effective lineage-minimum cutoff for its epoch, current within the surviving history; new-epoch rows unmarked — per `Spec-013 §Required Behavior`.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define timeline-row, child-run-summary, and reasoning-availability contracts in shared packages.
2. Implement daemon-owned timeline projection and replay-aware subscription delivery from canonical events — consuming Plan-004 T3.14's exported `supersededTurns(runId)` (CP-004-13) to compute each row's `superseded` marker on read and replay windows, stamping each run-scoped row's `runId` + `position` + `epoch` at emission and marking live-appended rows there too (a late pre-rollback straggler appends pre-marked exactly when its stamped attribution ranks above the run's effective lineage-minimum cutoff for its epoch and current when it ranks into the surviving history; a new-epoch row appends unmarked), emitting the typed `run.rolled_back` boundary entry (`TimelineRollbackBoundary` — payload validated into the `RunRolledBackEvent` shape, never delivered untyped) with its rewind cutoff for the client-side rule over already-delivered rows — delivered visibility-resolved to every filtered subscription admitting any of the affected run's rows, never keyed on the event's optional `channelId`, and composing the marker with audit-stub rows over compacted regions — an attributed stub populates the run arm from its stub-preserved keys, while a vacuous-era position-less legacy stub takes the `legacy_stub` arm, rendering the placeholder alone, exempt from marking by construction since its run can never admit a rollback while it exists.
3. Implement child-run expansion plus summary-first, policy-aware reasoning-surface reads emitting the closed `availability` states (`available` / `unavailable` / `compacted` / `policy_redacted`).
4. Add desktop timeline rendering for live rows, summarized child runs, visible placeholders for every non-`available` reasoning state, and the distinct superseded treatment for rolled-back turns — applied live via the `run.rolled_back` boundary entry's idempotent already-delivered-rows rule and rendered from the row marker on read/replay, never dropping rewound history and never marking a re-executed reused ordinal — a compacted superseded row rendering as Plan-006's `<CompactedStubSegment>` (the CP-006-8 audit-stub render contract, consumed here, never re-implemented) composed with the superseded treatment. Also add the composer usage meters (`Spec-013 §Context Window and Usage Meters`): the always-visible context-window meter fed by `usage.context_window_update` / `usage.context_compacted` off the canonical event stream (T4.4), and the rate-limit indicator held by the "Rate-limit indicator carrier reconciled" §Preconditions box (T4.5).

## Implementation Phase Sequence

Plan-013 implementation lands as a sequence of small PRs. Each PR exercises one slice of the plan's vertical and carries a `**Precondition:**` line so the merge order is reviewer-checkable. Phase N corresponds 1:1 to §Implementation Steps step N; the ordering is the one §Rollout Order and §Parallelization Notes already ratify.

### Phase 1 — Timeline Contracts

**Precondition:** Tier-8 plan-readiness audit complete. Implementation Step 1; gates both parallel legs §Parallelization Notes names ("once row schemas are fixed").

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8-complete" }
```

#### Tasks

- **T1.1** — Define the `TimelineRow` discriminated union in `packages/contracts/src/timeline/` — arms `TimelineRollbackBoundary` | `RunScopedTimelineEntry` | `LegacyStubTimelineEntry` | `TimelineEntry`, genuinely discriminated on the literal `kind` field, mirroring [API Payload Contracts](../architecture/contracts/api-payload-contracts.md). `RunScopedTimelineEntry` requires `runId` + `position` + `epoch` all-or-none with the optional single-field `superseded` marker; `LegacyStubTimelineEntry` preserves `runId` with position and epoch structurally absent.
  - **Spec coverage:** Spec-013 §Timeline Entry Types
  - **Verifies invariant:** I-013-1, I-013-3
- **T1.2** — Define `ChildRunSummary` (`runId`, `parentRunId`, `state`, `producingNodeId?`, `eventCount`) in `packages/contracts/src/timeline/`.
  - **Spec coverage:** Spec-013 §Timeline Entry Types
  - **Verifies invariant:** none
- **T1.3** — Define `ReasoningSurfaceReadRequest` / `ReasoningSurfaceReadResponse` in `packages/contracts/src/timeline/` — the response a closed discriminated union on `availability: 'available' | 'unavailable' | 'compacted' | 'policy_redacted'` mirroring [API Payload Contracts](../architecture/contracts/api-payload-contracts.md): `available` requires the bounded `reasoningEntries`, `policy_redacted` requires `policyReason`, and `unavailable` / `compacted` carry neither — a Zod `discriminatedUnion` with strict arms, so no two states serialize identically and a state-inconsistent field set fails parse.
  - **Spec coverage:** Spec-013 §Interfaces And Contracts
  - **Verifies invariant:** I-013-7
  - **Tests:** each of the four states round-trips; `available` without `reasoningEntries` fails; `policy_redacted` without `policyReason` fails; entries or a policy reason on `unavailable` or `compacted` fail strict parse; the prior `available: boolean` shape fails parse (no tolerant fallback arm).
- **T1.4** — Register the four timeline method strings — `timeline.read`, `timeline.subscribe`, `timeline.reasoningSurfaceRead`, `timeline.childRunExpand` — in the [Timeline Method-Name Registry](../architecture/contracts/api-payload-contracts.md#timeline-method-name-registry-tier-8-plan-013-t14) and against the daemon IPC `MethodRegistry`, so every operation's method string resolves and not merely its schema name.
  - **Spec coverage:** Spec-013 §Interfaces And Contracts
  - **Verifies invariant:** none

### Phase 2 — Projection And Replay-Aware Subscription

**Precondition:** Phase 1 merged; **Plan-004 Phase 3 merged** — T3.14 provides the `supersededTurns(runId)` read seam CP-004-13 obliges this phase to consume. Implementation Step 2.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8-complete" }
  - { type: plan_phase, plan: 013, phase: 1, status: merged }
  - { type: external_plan_phase_merged, plan: 004, phase: 3 }
```

#### Tasks

- **T2.1** — Implement `packages/runtime-daemon/src/timeline/timeline-projector.ts` building ordered rows from canonical events, stamping each run-scoped row's `runId` + `position` + `epoch` at emission, and preserving provenance to canonical event ids, run ids, runtime nodes, and policy-redaction reasons.
  - **Spec coverage:** Spec-013 §State And Data Implications
  - **Verifies invariant:** I-013-1
- **T2.2** — Consume Plan-004 T3.14's `supersededTurns(runId)` (CP-004-13) to compute each row's `superseded` marker on read and replay windows and to mark live appends at emission — a late pre-rollback straggler appending pre-marked exactly when its stamped attribution ranks above the run's effective lineage-minimum cutoff for its epoch, current when it ranks into surviving history, and a new-epoch row appending unmarked. Marker survives projection rebuild.
  - **Spec coverage:** Spec-013 §Required Behavior
  - **Verifies invariant:** I-013-2, I-013-3, I-013-4
- **T2.3** — Emit the typed `run.rolled_back` boundary entry with its rewind cutoff, payload validated into the `RunRolledBackEvent` shape at projection, delivered visibility-resolved to every filtered subscription admitting any of the affected run's rows.
  - **Spec coverage:** Spec-013 §Timeline Entry Types
  - **Verifies invariant:** I-013-5, I-013-6
- **T2.4** — Implement replay-window reads and live subscription delivery over the identical row schema so reconnect recovery needs no projection translation; compose the marker with audit-stub rows over compacted regions, an attributed stub populating the run arm from its stub-preserved keys and a vacuous-era stub taking the `legacy_stub` arm.
  - **Spec coverage:** Spec-013 §Fallback Behavior
  - **Verifies invariant:** I-013-1, I-013-3

### Phase 3 — Child-Run Expansion And Reasoning Surfaces

**Precondition:** Phase 1 merged. Implementation Step 3; runs parallel to Phase 2 per §Parallelization Notes.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8-complete" }
  - { type: plan_phase, plan: 013, phase: 1, status: merged }
```

#### Tasks

- **T3.1** — Implement `packages/runtime-daemon/src/timeline/child-run-summary-service.ts` producing summary rows and expansion from Plan-016's durable child-run events and carrier (D-016-14).
  - **Spec coverage:** Spec-013 §Required Behavior
  - **Verifies invariant:** none
- **T3.2** — Implement `packages/runtime-daemon/src/timeline/reasoning-surface-service.ts` — summary-first, policy-aware reads emitting T1.3's closed `availability` states (`available` / `unavailable` / `compacted` / `policy_redacted`, each with its mandated field set), storing durable summaries and policy markers separately from bounded detailed-reasoning diagnostic payloads.
  - **Spec coverage:** Spec-013 §Required Behavior
  - **Verifies invariant:** I-013-7, I-013-8
- **T3.3** — Project the `handoff` timeline entry type and intervention-visibility rows into the timeline surface, with tests proving each renders from canonical events.
  - **Spec coverage:** Spec-013 §Timeline Entry Types
  - **Verifies invariant:** none
- **T3.4** — Implement `packages/client-sdk/src/timelineClient.ts` exposing the four operations, parsing rows into the narrowed `TimelineRow` arm — a run-scoped row missing any attribution field failing its `kind`-selected Zod arm rather than falling through to the general or `legacy_stub` arm.
  - **Spec coverage:** Spec-013 §Interfaces And Contracts
  - **Verifies invariant:** I-013-1, I-013-5

### Phase 4 — Desktop Timeline Rendering

**Precondition:** Phase 2 and Phase 3 merged — §Parallelization Notes holds renderer work until replay-catch-up semantics and unavailable-reason payloads stabilize. Implementation Step 4.

<!-- prettier-ignore -->
```yaml
preconditions:
  - { type: audit_status, status: complete, evidence_pr: 318, baseline_tag: "plan-readiness-audit-tier-8-complete" }
  - { type: plan_phase, plan: 013, phase: 2, status: merged }
  - { type: plan_phase, plan: 013, phase: 3, status: merged }
```

#### Tasks

- **T4.1** — Render live rows, replay-recovered rows, and summarized child runs in `apps/desktop/src/renderer/src/timeline/`, narrowing structurally on `row.kind` and never probing the free-form `type`.
  - **Spec coverage:** Spec-013 §Required Behavior
  - **Verifies invariant:** I-013-1
- **T4.2** — Render the distinct superseded treatment for rolled-back turns — applied live via the boundary entry's idempotent already-delivered-rows rule and from the row marker on read/replay, never dropping rewound history and never marking a re-executed reused ordinal — with a compacted superseded row rendering as Plan-006's `<CompactedStubSegment>` (CP-006-8, consumed never re-implemented) composed with the superseded treatment.
  - **Spec coverage:** Spec-013 §Fallback Behavior
  - **Verifies invariant:** I-013-2, I-013-4
- **T4.3** — Render a visible reasoning placeholder for every non-`available` `availability` state (`unavailable` / `compacted` / `policy_redacted`) in `apps/desktop/src/renderer/src/reasoning-surfaces/`, and the `handoff` and intervention entries from T3.3.
  - **Spec coverage:** Spec-013 §Acceptance Criteria
  - **Verifies invariant:** I-013-7
- **T4.4** — Implement the always-visible context-window meter in `apps/desktop/src/renderer/src/usage-meters/` — a thin projection over the `window.sidekicks` bridge, mounted at the renderer shell's composer-area composition point (the shell mounts, never authors, feature views; no edit inside Plan-023's shell subtree), consuming session-attributed `usage.context_window_update` rows off Plan-006's `event.subscribe` read path. Latest-wins over the delivered stream: derive `usagePercent` / `tokenCount` / `maxTokens` from the `windowUsedTokens` / `windowMaxTokens` pair (consume, never re-derive — the composer meter is `Spec-016 §Budget Policies`' independent human-facing consumer of the same telemetry, distinct from Plan-016's budget projection), render the informational compaction hint when `usagePercent` exceeds 80% (never auto-triggering compaction), render an explicit indeterminate state on a counts-absent update (never a fabricated denominator), and treat `usage.context_compacted` as invalidating the last reading — `postCompactionTokens` when present, indeterminate otherwise.
  - **Files:** `apps/desktop/src/renderer/src/usage-meters/ContextWindowMeter.tsx` plus co-located tests.
  - **Provides:** the `Spec-013 §Context Window and Usage Meters` composer meter — always rendered, above-80% hint, explicit indeterminate state.
  - **Consumes:** `usage.context_window_update` / `usage.context_compacted` (`Spec-006 §Usage Telemetry (usage_telemetry)`; Plan-005 driver emitters) over Plan-006's `event.subscribe` via the preload bridge — the Plan-005 edge the header Dependencies row declares.
  - **Spec coverage:** Spec-013 §Context Window and Usage Meters
  - **Verifies invariant:** none
  - **Tests:** renders in the composer area with zero usage rows (indeterminate, never absent); derives the percent from a counted pair; the hint appears above 80% and not at or below it, and issues no compaction call; a counts-absent update renders indeterminate; `usage.context_compacted` resets the reading to the post-compaction count when present, else indeterminate.
- **T4.5** — Implement the rate-limit indicator in `apps/desktop/src/renderer/src/usage-meters/`, rendering `Spec-013 §Rate-Limit Display`'s threshold coloring, reset countdown, and visibility rule (shown below 50% remaining, hidden when healthy) over the reconciled carrier the "Rate-limit indicator carrier reconciled" §Preconditions box names — presumptively the Plan-005-emitted `usage.rate_limit_update` (`Spec-006 §Usage Telemetry (usage_telemetry)`: `{provider, windowMins, usedPercent, resetsAt?}`), from which coloring and visibility derive off `usedPercent`, with the countdown rendered only when the reset time is present (an explicit no-countdown arm otherwise) and the surfaced quota labeled as the provider account's — the event is account-scoped with no owning session, never presented as a per-session figure. Absence of observed data renders as the hidden-when-healthy state — fail-safe by construction. **Dispatch-held:** this task does not dispatch while the §Preconditions carrier box is unchecked (task-scoped, reviewer-checkable hold; T4.1–T4.4 dispatch on the phase gates alone).
  - **Files:** `apps/desktop/src/renderer/src/usage-meters/RateLimitIndicator.tsx` plus co-located tests.
  - **Provides:** the `Spec-013 §Rate-Limit Display` indicator — threshold colors, reset countdown with an explicit unknown arm, below-50% visibility.
  - **Consumes:** the reconciled rate-limit carrier the §Preconditions box names (presumptively `usage.rate_limit_update`; consume, never re-derive).
  - **Spec coverage:** Spec-013 §Rate-Limit Display
  - **Verifies invariant:** none
  - **Tests:** hidden with no observed data and at or above 50% remaining; visible below 50%; yellow at 20–50% and red below 20% (the green band coincides with the hidden-when-healthy range by the spec's own visibility rule); the countdown renders toward the reset time when present and is omitted — indicator still rendering — when absent; the quota label names the provider-account scope.

## Parallelization Notes

- Projection work and reasoning-surface normalization can proceed in parallel once row schemas are fixed.
- Renderer work should wait for replay-catch-up semantics and unavailable-reason payloads to stabilize.
- The composer meters (T4.4 / T4.5) have no dependency on the timeline row schemas — they ride Phase 4 for renderer placement, not for data; T4.5 additionally holds on the §Preconditions carrier box.

## Test And Verification Plan

- Projection tests covering ordered messages, run-state changes, tool activity, approvals, artifacts, and child-run summaries
- Replay-gap tests proving clients can recover missing rows without rebuilding from free-form text
- Policy-redaction tests proving unavailable reasoning still produces visible explanation surfaces
- Retention tests proving detailed reasoning expiry or compaction does not erase durable summary and policy surfaces
- Superseded-rendering tests proving live marking keys on the exposed `runId` + `position` pair (already-delivered rows of the rewound run with `position` above the boundary's cutoff take the treatment — never a `sequence` comparison; an above-effective-cutoff late straggler delivered after the boundary arrives pre-marked while a straggler ranking into the surviving history arrives current — the T3.14 late-delivered-sibling case; new-epoch rows never mark), read/replay marker parity with the live outcome (a bounded-window subscriber holding current cached rows across earlier rollbacks marks them on a later boundary identically to replay — the single-field marker composes with the row's own `runId` + `epoch` by construction; a channel-filtered subscriber holding the affected run's rows receives the boundary and marks them — the filter never suppresses a rollback cutoff; every `run.rolled_back` boundary payload validates into the typed shape — a subscriber never receives an untyped cutoff; a run-scoped row missing any attribution field fails its `kind`-selected Zod arm — the malformed-row test, never a fall-through to the general or `legacy_stub` arm; a vacuous-attribution-era stub parses on the `legacy_stub` arm and renders the compaction placeholder without attribution — never invented, never dropped, never a parse failure; a boundary whose outer attribution disagrees with its payload — `runId`, `sessionId`, or `position` vs `targetPosition` — fails parse), reused-ordinal correctness across the two-rollback sequence Plan-004 T3.14 pins (10→5, re-execute, 7→6 — the second epoch's re-executed turn 6 renders current while the first epoch's turn 6 stays superseded, the epoch-scoping `Spec-004 §Required Behavior` owns), the lineage sequence T3.14 pins (10→5, re-execute to 7, 7→3 — the inherited epoch-0 turn 4 renders superseded via the second rollback's cutoff), and the compacted-stub composition (stub placeholder + superseded marker)
- Composer-meter tests proving the context-window meter renders in every usage state — counted pair, counts-absent indeterminate, post-compaction reset — with the above-80% hint informational only, and the rate-limit indicator's visibility, threshold-color, and countdown rules over observed carrier values, including the no-reset-time no-countdown arm and the provider-account scope label

## Rollout Order

1. Land row schemas and replay-backed projection reads
2. Enable live subscribe plus replay recovery
3. Enable reasoning surfaces and child-run expansion in the primary session experience
4. Enable the composer usage meters — the context-window meter with Phase 4, the rate-limit indicator as its §Preconditions carrier box clears

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

- 2026-07-20 — CP-004-13 consumer registration (campaign B9 follow-up, PR #232): registers the Plan-013 side of Plan-004 T3.14's `supersededTurns(runId)` provide-forward — timeline-projector consumption with at-emission marking for live appends, the run-scoped timeline row's `superseded` marker struct, the `run.rolled_back` boundary-entry client rule, renderer treatment, and tests — with the paired Spec-013 amendment (superseded-turn-rendering Required Behavior + `run.rolled_back` subtype row + compacted composition + acceptance criterion). Spec-013 flips `approved → review` per the audit runbook's spec-amendment rule (Required Behavior, Acceptance Criteria, and Depends On all changed), and Plan-013 flips `approved → review` with it under the Status Flip Rule's behavior-change row: the amendment adds mandatory plan-body behavior (the step-2/step-4 consumer legs) plus a new cross-plan dependency (Plan-004) — the recorded campaign-precedent flip signature — while minting no new CP row (the obligation ledger is Plan-004's CP-004-13). Both restore together at the Tier-8 readiness audit or an earlier batch gate, the Preconditions spec-box staying unchecked until the spec's restore; adjudication surfaced for lead review in the PR body.
- 2026-08-10 — Tier-8 plan-readiness audit (§6 node NS-20): restores Plan-013 and Spec-013 `approved`, discharging the 2026-07-20 campaign B9 CP-004-13 consumer flip (PR #232). **Scope and method:** full runbook walk — gates G1–G7, the 11 completeness dimensions, the D1–D8 dependency trace, plus targeted adjudication of the CP-004-13 legs. **CP-004-13 adjudication:** ready. Plan-004 T3.14's per-`(epoch, turn)` → source-epoch + `targetPosition` export exactly populates the row-level single-field `superseded` marker keyed on the row's own `runId` + `position` + `epoch`, so the Dimension-11 provider shape matches the consumer need by construction; every amendment leg lands on both the spec and plan sides. **Negative control:** two refutations were seeded and both correctly rejected — that the marker duplicates `runId` + `epoch` and can therefore disagree between live and replay (refuted: the marker is deliberately single-field, reading identity from the containing row, so no duplicated fields exist to disagree) and that the rollback boundary is keyed on the event's `channelId` and can be suppressed by a channel filter (refuted: delivery is visibility-resolved to every subscription admitting any of the affected run's rows). **Findings: 4 critical / 7 major / 2 minor.** **Restoration effected:** Status `review → approved` on both docs; the §Preconditions paired-spec box re-checked with its Delivered record; the missing Gate-2 plan-readiness-audit box added and checked, without which the plan would have restored `approved` and stayed mechanically undispatchable; §Invariants (I-013-1..8) and §Cross-Plan Obligations authored as backfill; `## Implementation Phase Sequence` plus Phases 1–4 authored 1:1 onto the ratified §Implementation Steps, ordered by §Rollout Order and §Parallelization Notes; a Plan-004 Phase 3 gate line added with the matching `external_plan_phase_merged` entry on Phase 2; the Plan-016 dependency edge recorded from this side; the timeline substrate ownership rows and the [Timeline Method-Name Registry](../architecture/contracts/api-payload-contracts.md#timeline-method-name-registry-tier-8-plan-013-t14) land with this tier PR's cross-plan-dependencies and api-payload-contracts legs. **Status stays `approved`:** every edit records an existing relationship, structure, or ownership fact that ratified text already asserts — none invents behavior — so the Status Flip Rule's citation/additive rows govern and this audit's own edits trigger no flip. **Residuals, each requiring a lead-owned amendment and none cleared by this restore:** `Spec-013 §Context Window and Usage Meters` (with its Rate-Limit Display subsection) had no plan coverage — since closed in-PR by the Codex-round meter fix recorded at this entry's end; the `ChildRunSummary` incompleteness marker and the `ReasoningSurfaceReadRequest` principal are unshaped — the `ReasoningSurfaceReadResponse` unavailable-vs-redacted split closed in-PR by the same Codex round: the canonical response is now a closed four-state `availability` discriminated union (`available` / `unavailable` / `compacted` / `policy_redacted`) with per-state field rules, amended in place rather than compatibility-extended because the shape predates this PR as canonical-doc text only with no shipped emitter or parser, so ADR-018's deployed-skew rules impose no legacy arm; and the Plan-007 / Plan-021 / Plan-023 dependency edges are undeclared in both directions. Restoration clears the audit and status gates only — Plan-004 Phase 3 still holds the `supersededTurns` provider. **Same-PR Codex round (meter coverage):** the review round on this PR closed the meters residual in place — T4.4 (context-window meter) and T4.5 (rate-limit indicator) under Phase 4 / Implementation Step 4, the `apps/desktop/src/renderer/src/usage-meters/` target area, the Plan-005 `usage_telemetry` edge declared from this side (header Dependencies row; dep-map §2 renderer and §3 rows), and a born-unchecked "Rate-limit indicator carrier reconciled" §Preconditions box holding T4.5 (task-scoped and reviewer-checkable, the Plan-014 Tasks-7–10 shape — deliberately not a phase-level `precondition_box_checked` entry, which would hold all of Phase 4) until a lead-owned amendment reconciles `Spec-013 §Rate-Limit Display`'s header-sourced `remaining` / `limit` / `resetAt` fields with the registered `usage.rate_limit_update` carrier's `usedPercent` / `resetsAt?` shape and node-scope binding. Status stays `approved` under the same reasoning as this restore: the meter tasks transcribe already-`approved` `Spec-013 §Context Window and Usage Meters` normative text into coverage — conforming the plan to its ratified spec, minting no invariant and no CP row — so the Status Flip Rule's citation/additive rows govern.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
