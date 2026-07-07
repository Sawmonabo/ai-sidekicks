# Plan-015: Persistence Recovery And Replay

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `015` |
| **Slug** | `persistence-recovery-and-replay` |
| **Date** | `2026-04-14` (Tier-7 readiness audit 2026-06-15) |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-015: Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md) |
| **Required ADRs** | [ADR-003](../decisions/003-daemon-backed-queue-and-interventions.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
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

- [x] Paired spec is approved — **dated gate note (2026-07-06):** Spec-015 is temporarily `review` while the campaign B5 amendment (reconstruction gate + resume-divergence halt) sits in its review window; the campaign plan's Task 28 batch re-promotion restores `approved` after the W1.5 spec gate, and this plan's code dispatch stays blocked until that restoration.
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] **Plan-readiness audit complete per [runbook](../operations/plan-implementation-readiness-audit-runbook.md)** — Tier-7 audit (2026-06-15): 6 findings adjudicated via A-015-1..5; D-015-1 ratified (the `ReplayReadAfterCursor` sequence-position cursor model). §Invariants I-015-1..4 and the `#### Tasks` block were added as audit backfill recording EXISTING relationships — no new contract, so Plan-015 stays `approved`. Companion amendments: api-payload-contracts.md (recovery read shapes), local-sqlite-schema.md (`replay_cursors` / `recovery_checkpoints`), cross-plan-dependencies.md §1.

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/recovery/`
- `packages/runtime-daemon/src/persistence/sqlite/`
- `packages/runtime-daemon/src/recovery/startup-recovery-service.ts`
- `packages/runtime-daemon/src/replay/replay-service.ts`
- `packages/runtime-daemon/src/provider/runtime-binding-store.ts`
- `packages/client-sdk/src/recoveryClient.ts`
- `apps/desktop/src/renderer/src/recovery-status/`

## Data And Storage Changes

- Add or extend local `session_events`, `session_snapshots`, `command_receipts`, `runtime_bindings`, `queue_items`, and approval-state tables for recovery completeness.
- Add recovery-status projection data and replay cursors needed to expose healthy, replaying, degraded, or blocked startup state.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add `RecoveryStatusRead`, `ProjectionRebuild`, `ReplayReadAfterCursor`, and `RuntimeBindingRead` APIs to the typed client SDK and daemon contract.
- Expose machine-readable recovery outcomes, failure categories, and recovery conditions through the same contracts.

## Invariants

- **I-015-1 (exactly-once recovery execution):** A side-effecting tool call identified by `command_id` executes at most once across any number of daemon restarts and concurrent recovery workers, enforced by the two-phase receipt commit and the Phase-2 optimistic CAS (`UPDATE ... SET started_at = now() WHERE started_at IS NULL`). Spec-015:79-110.
- **I-015-2 (idempotent rebuild):** `ProjectionRebuild` for a session over the same canonical event range yields identical projection state regardless of how many times it runs. Spec-015:72,348.
- **I-015-3 (no premature admission):** No mutable operation is accepted until startup recovery has restored canonical local truth or the node is in an explicit blocked/degraded state. Spec-015:56-57,349.
- **I-015-4 (no silent run loss):** A persisted driver handle that cannot be resumed transitions its run to `failed` with visible recovery-failure detail; it never silently disappears or restarts as a new run. Spec-015:63,350.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

#### Tasks

- [ ] **T15.1 — Finalize SQLite schema, receipts, and runtime-binding persistence needed for replay-safe restart.**
  - Author migration(s) that (a) create the Plan-015-owned `replay_cursors` and `recovery_checkpoints` tables and (b) add recovery-completeness columns to the extended tables, exactly per the Local SQLite Schema. Implement the two-phase command-receipt commit protocol (`accept` → `execute` (optimistic CAS) → terminal-status) as a `command-receipt-store` module under the persistence layer.
  - **Target paths:** `packages/runtime-daemon/src/persistence/sqlite/` (migration + receipt store)
  - **Spec coverage:** Spec-015 Required Behavior — "Canonical local execution data must include session events, queue state, approvals, runtime bindings, and command receipts" (`docs/specs/015-persistence-recovery-and-replay.md:47`); Idempotency Protocol two-phase receipt commit (`docs/specs/015-persistence-recovery-and-replay.md:79-110`); Idempotency classes table (`docs/specs/015-persistence-recovery-and-replay.md:118-126`); Acceptance Criterion (`docs/specs/015-persistence-recovery-and-replay.md:348`).
  - **Verifies invariant:** I-015-1
  - **Owns (CREATE):** `replay_cursors` (id, session_id UNIQUE, last_sequence, state CHECK ∈ {current,rebuilding,stale}, updated_at) and `recovery_checkpoints` (id, session_id, checkpoint_type, as_of_sequence, state_blob, created_at) ← [GDPR and Recovery Tables (`replay_cursors`, `recovery_checkpoints`)](../architecture/schemas/local-sqlite-schema.md#gdpr-and-recovery-tables-spec-022-plan-015); both rows attributed Owner=Plan-015 in `docs/architecture/cross-plan-dependencies.md:51`.
  - **Consumes (EXTEND, by SHAPE):**
    - `command_receipts` columns (id, command_id, run_id, status, idempotency_class, dedupe_key, started_at, completed_at, created_at) ← Plan-004 owner; "Owner: Plan-004 | Extended by: Plan-015 (recovery + two-phase idempotency protocol, BL-051)" ([`command_receipts`](../architecture/schemas/local-sqlite-schema.md#queue-and-intervention-tables-plan-004)).
    - `runtime_bindings` columns incl. `resume_handle`, `runtime_metadata` ← Plan-005 owner; "Extended by Plan-015 (recovery-aware persistence)" ([`runtime_bindings`](../architecture/schemas/local-sqlite-schema.md#driver-and-runtime-binding-tables-plan-005)).
    - `session_events` ← Plan-001/Plan-006 owner; "Extended by Plan-015 (replay cursors)" ([`session_events`](../architecture/schemas/local-sqlite-schema.md#session-events-plan-001-extended-by-plans-006-015)).
    - `session_snapshots` (read-only consumer of `has_compacted_ranges`, `compacted_range_count`) ← Plan-006 owner; `docs/architecture/cross-plan-dependencies.md:29`; [`session_snapshots`](../architecture/schemas/local-sqlite-schema.md#session-snapshots-plan-001-extended-by-plans-006-015).
    - `queue_items` ← Plan-004 owner (queue state) `docs/plans/015-persistence-recovery-and-replay.md:12`.
    - approval-state table ← Plan-012 owner (approval records) `docs/plans/015-persistence-recovery-and-replay.md:12`.
    - `tool.idempotency_class` per-tool declaration ← Spec-005 §Tool Metadata `docs/specs/015-persistence-recovery-and-replay.md:139`.

- [ ] **T15.2 — Implement replay rebuild and idempotent projection restoration on daemon startup.**
  - Build `replay-service.ts` (reads canonical events after a cursor, advancing `replay_cursors`) and the idempotent `ProjectionRebuild` path so a restart deterministically reconstructs projections from canonical events with no client memory. Apply the ADR-018 envelope-version handling (`min_client_version` floor, accept-and-stub, upcaster chain) when replaying mixed-version envelopes — see A-015-3.
  - **Target paths:** `packages/runtime-daemon/src/replay/replay-service.ts`, `packages/runtime-daemon/src/persistence/sqlite/`
  - **Spec coverage:** Required Behavior — restart "projection rebuild from canonical events" (`docs/specs/015-persistence-recovery-and-replay.md:48-49`); "Replay must be possible without client memory or ad hoc transcript reconstruction" (`docs/specs/015-persistence-recovery-and-replay.md:52`); Interfaces — `ReplayReadAfterCursor` / `ProjectionRebuild` idempotent (`docs/specs/015-persistence-recovery-and-replay.md:71-72`); Acceptance Criterion (`docs/specs/015-persistence-recovery-and-replay.md:348`).
  - **Verifies invariant:** I-015-2
  - **Consumes (by SHAPE):**
    - `ReplayReadAfterCursor` { sessionId, afterSequence, limit } → { events: EventEnvelope[], nextSequence, hasMore } ← `docs/architecture/contracts/api-payload-contracts.md:2241-2249` (replay uses a sequence-position cursor `afterSequence: number`, intentionally distinct from `EventReadAfterCursor`'s opaque `EventCursor` brand — ratified D-015-1).
    - `ProjectionRebuild` { sessionId, force } → { sessionId, rebuiltProjections, asOfSequence } ← `docs/architecture/contracts/api-payload-contracts.md:2253-2260`.
    - `EventEnvelope` (incl. `version: EventEnvelopeVersion` "MAJOR.MINOR" at line 1009) ← `docs/architecture/contracts/api-payload-contracts.md:1019-1031`; ADR-018 versioning decisions (semver #1 line 35, floor #3 line 39, upcaster #6 line 45) `docs/decisions/018-cross-version-compatibility.md:35-51`.
    - `session_events` canonical log + `replay_cursors` state machine ← [`session_events`](../architecture/schemas/local-sqlite-schema.md#session-events-plan-001-extended-by-plans-006-015) + [`replay_cursors`](../architecture/schemas/local-sqlite-schema.md#gdpr-and-recovery-tables-spec-022-plan-015).
    - Event-log replay obligation ← Plan-006 (event log) `docs/architecture/cross-plan-dependencies.md:157`.

- [ ] **T15.3 — Implement runtime-binding adoption or resume logic plus explicit failure transitions for in-flight runs.**
  - Extend the Plan-005 `runtime-binding-store.ts` with recovery-aware read/persist methods, then implement startup adoption (prefer adopting a live provider session before using a stored resume handle), resume via the driver, and the explicit `failed`-with-detail transition when a handle cannot be resumed. Run the in-flight-receipt sweep at startup only, dispatching on `idempotency_class` per the spec table (re-execute / dedupe-key / `recovery-needed` halt), emitting `tool.replayed` / `tool.skipped_during_recovery`.
  - **Target paths:** `packages/runtime-daemon/src/provider/runtime-binding-store.ts` (EXTEND), `packages/runtime-daemon/src/recovery/startup-recovery-service.ts`
  - **Spec coverage:** Required Behavior restart steps — restoration of runtime bindings + resume-or-explicit-failure (`docs/specs/015-persistence-recovery-and-replay.md:50-51`); Default Behavior — recovery before mutable work; prefer adopting live sessions (`docs/specs/015-persistence-recovery-and-replay.md:57-58`); Fallback Behavior — un-resumable handle → `failed` with visible detail (`docs/specs/015-persistence-recovery-and-replay.md:63`); Idempotency-class recovery dispatch + recovery events (`docs/specs/015-persistence-recovery-and-replay.md:118-135`); Interfaces — `RuntimeBindingRead` (`docs/specs/015-persistence-recovery-and-replay.md:73`).
  - **Verifies invariant:** I-015-1, I-015-4
  - **Ownership note:** `runtime-binding-store.ts` is Owner=Plan-005, Extender=Plan-015 ("extends the store with recovery-aware persistence methods") per `docs/architecture/cross-plan-dependencies.md:87`. Plan-015 must EXTEND, not re-CREATE — Plan-005 Phase 2 is the upstream producer.
  - **Consumes (by SHAPE):**
    - `runtime-binding-store.ts` (Plan-005-owned module) ← `docs/architecture/cross-plan-dependencies.md:87`.
    - `RuntimeBindingRead` { runId } → { runId, driverName, contractVersion, resumeHandle?, runtimeMetadata } ← `docs/architecture/contracts/api-payload-contracts.md:2264-2272`.
    - `DriverResumeResult` discriminated union incl. `recoveryCondition: RecoveryCondition` ← `docs/architecture/contracts/api-payload-contracts.md:772-779`; Spec-005 §Fallback Behavior `docs/specs/015-persistence-recovery-and-replay.md:124`.
    - `RunFailureCategory` ∈ {provider failure, transport failure, local persistence failure, projection failure} ← `docs/architecture/contracts/api-payload-contracts.md:142-146`.
    - `tool.replayed` / `tool.skipped_during_recovery` event types (category `tool_activity`), registered in Spec-006, taxonomy tracked by BL-064 ← `docs/specs/015-persistence-recovery-and-replay.md:128-135`.
    - `command_receipts` in-flight predicate (`started_at IS NOT NULL AND completed_at IS NULL`) ← `docs/specs/015-persistence-recovery-and-replay.md:114`.

- [ ] **T15.4 — Expose recovery-status reads and renderer surfaces for degraded or blocked startup conditions.**
  - Implement the `RecoveryStatusRead` daemon contract + `recoveryClient.ts` SDK method, and the renderer recovery-status surface that renders healthy / replaying / degraded / blocked states with machine-readable failure category + recovery condition. Block mutable operations when the local durable store is unavailable. Map `RunFailureCategory.projection failure` → `RecoveryStatusRead` state `degraded`; `RunFailureCategory.local persistence failure` → state `blocked`, per Spec-015:56,65.
  - **Target paths:** `packages/contracts/src/recovery/` (with a `recovery/index.ts` barrel re-exported from `packages/contracts/src/index.ts` — the repo single-import-surface convention, Plan-021 T21.1-1/T21.1-2 precedent; `package.json` keeps exporting only `"."`), `packages/client-sdk/src/recoveryClient.ts`, `apps/desktop/src/renderer/src/recovery-status/`
  - **Spec coverage:** Default Behavior — block local mutable ops when store unavailable (`docs/specs/015-persistence-recovery-and-replay.md:56`); Fallback Behavior — degraded read-only + repair signals (`docs/specs/015-persistence-recovery-and-replay.md:65`); Interfaces — `RecoveryStatusRead` healthy/replaying/degraded/blocked (`docs/specs/015-persistence-recovery-and-replay.md:70`); Acceptance Criteria — block when unavailable + failure visible/auditable (`docs/specs/015-persistence-recovery-and-replay.md:349-350`).
  - **Verifies invariant:** I-015-3
  - **Ownership note:** renderer slot `apps/desktop/src/renderer/src/recovery-status/` is Plan-015's extender slot under Plan-023 per `docs/architecture/cross-plan-dependencies.md:101`.
  - **Consumes (by SHAPE):**
    - `RecoveryStatusRead` → { overall, sessions: [{ state, lastReplayedSequence, failureCategory, recoveryCondition }] } ← `docs/architecture/contracts/api-payload-contracts.md:2221-2234`.
    - `RunFailureCategory` enum ← `docs/architecture/contracts/api-payload-contracts.md:142-146`.
    - `RecoveryCondition` (`"recovery-needed" | "reauth-required"`) ← `docs/architecture/contracts/api-payload-contracts.md:790`.
    - renderer host slot ← Plan-023 `docs/architecture/cross-plan-dependencies.md:101`.

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

- Snapshot compaction cadence remains unresolved and may affect rebuild performance (correctness is compaction-independent per Spec-015 §Resolved Questions:355; only rebuild performance is affected)
- Recovery ordering mistakes can admit mutable work before canonical local truth is trustworthy

## Ratified Design Decisions (Tier-7 audit)

- **D-015-1 — `ReplayReadAfterCursor` retains a sequence-position cursor (`afterSequence: number`), not the `EventCursor` brand.** The replay read advances over the canonical `session_events.sequence` integer (the `replay_cursors.last_sequence` state machine), so a numeric sequence position is the natural cursor and makes idempotent rebuild (I-015-2) trivially verifiable. The sibling `EventReadAfterCursor` uses the opaque `EventCursor` brand because client-facing event reads must tolerate cursor-format evolution (Plan-006). The two read models intentionally differ; reconciling them to a single brand is a non-blocking refinement **not** adopted in V1 — `api-payload-contracts.md:2241-2244` keeps `afterSequence: number`. This resolves the cursor-model reconcile the audit flagged as a non-blocking owner decision.

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

- 2026-06-15 — Tier-7 plan-readiness audit (NS-19): 6 findings adjudicated via A-015-1..5; D-015-1 ratified. The audit added §Invariants I-015-1..4 (A-015-2) and the four-task `#### Tasks` block (A-015-1) as backfill recording EXISTING relationships — no new contract, so Plan-015 stays `approved`. Other adjudications: replay envelope ADR-018 version handling threaded into T15.2 (A-015-3); `RunFailureCategory` → recovery-state mapping pinned in T15.4 (A-015-4); compaction-cadence risk re-classed as performance-only, correctness compaction-independent per Spec-015:359 (A-015-5). D-015-1 ratifies the `ReplayReadAfterCursor` sequence-position cursor model. No upstream-tier or sealed-plan amendments.
- 2026-06-18 — Codex review round 15 (NS-19 PR finalization): KcMXv — T15.4's `packages/contracts/src/recovery/` subdir exposes a `recovery/index.ts` barrel re-exported from `packages/contracts/src/index.ts` (the repo single-import-surface convention — the Plan-021 T21.1-1/T21.1-2 `index.ts` re-export precedent); `package.json` keeps exporting only `"."`. Companion: cross-plan-dependencies.md §2 `recovery/` row. No new contract — Plan-015 stays `approved`. No sealed-plan amendments owed.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
