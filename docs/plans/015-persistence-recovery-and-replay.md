# Plan-015: Persistence Recovery And Replay

| Field | Value |
| --- | --- |
| **Status** | `approved` |
| **NNN** | `015` |
| **Slug** | `persistence-recovery-and-replay` |
| **Date** | `2026-04-14` (Tier-7 readiness audit 2026-06-15) |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-015: Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md) |
| **Required ADRs** | [ADR-003](../decisions/003-daemon-backed-queue-and-interventions.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-005](../decisions/005-provider-drivers-use-a-normalized-interface.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md), [ADR-017](../decisions/017-shared-event-sourcing-scope.md), [ADR-018](../decisions/018-cross-version-compatibility.md) |
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

- [x] Paired spec is approved — re-checked 2026-07-18 by the campaign Task-28 / W1.5 batch spec re-promotion (supersedes the 2026-07-13 re-open note): Spec-015 returned to `approved`; its campaign amendment window closed.
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
- Expose machine-readable recovery outcomes, failure categories, recovery conditions, and recovery span classifications through the same contracts.

## Invariants

- **I-015-1 (exactly-once recovery execution):** A side-effecting tool call identified by `command_id` executes at most once across any number of daemon restarts and concurrent recovery workers, enforced by the two-phase receipt commit and the Phase-2 optimistic CAS (`UPDATE ... SET started_at = now() WHERE started_at IS NULL`). `Spec-015 §Idempotency Protocol`, `Spec-015 §Two-Phase Receipt Commit`.
- **I-015-2 (idempotent rebuild):** `ProjectionRebuild` for a session over the same canonical event range yields identical projection state regardless of how many times it runs. `Spec-015 §Interfaces And Contracts`, `Spec-015 §Acceptance Criteria`.
- **I-015-3 (no premature admission):** No mutable operation is accepted until startup recovery has restored canonical local truth or the node is in an explicit blocked/degraded state. `Spec-015 §Default Behavior`, `Spec-015 §Acceptance Criteria`.
- **I-015-4 (no silent run loss):** A persisted driver handle that cannot be resumed transitions its run to `failed` with visible recovery-failure detail; it never silently disappears or restarts as a new run. `Spec-015 §Fallback Behavior`, `Spec-015 §Acceptance Criteria`.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

#### Tasks

- [ ] **T15.1 — Finalize SQLite schema, receipts, and runtime-binding persistence needed for replay-safe restart.**
  - Author migration(s) that (a) create the Plan-015-owned `replay_cursors` and `recovery_checkpoints` tables and (b) add recovery-completeness columns to the extended tables, exactly per the Local SQLite Schema. Implement the two-phase command-receipt commit protocol (`accept` → `execute` (optimistic CAS) → terminal-status) as a `command-receipt-store` module under the persistence layer — the Phase-2 claim is the module's **`claimForExecution(receiptId)`** method (the `UPDATE ... SET started_at = now() WHERE started_at IS NULL` compare-and-set per Spec-015 §Two-Phase Receipt Commit: rowcount 1 = this worker owns the execution, rowcount 0 = another worker claimed it, abort without invoking the tool). The P2-3 schema surface is disposition **`already-landed`** (campaign B14): `command_receipts` already carries the status CHECK, `idempotency_class` CHECK, `dedupe_key`, `started_at`, `completed_at` two-phase columns (BL-051) — this task names the CAS at the module API, no schema amendment.
  - **Target paths:** `packages/runtime-daemon/src/persistence/sqlite/` (migration + receipt store)
  - **Spec coverage:** Spec-015 Required Behavior — "Canonical local execution data must include session events, queue state, approvals, runtime bindings, and command receipts" (`docs/specs/015-persistence-recovery-and-replay.md:47`); Idempotency Protocol two-phase receipt commit (`docs/specs/015-persistence-recovery-and-replay.md:79-110`); Idempotency classes table (`docs/specs/015-persistence-recovery-and-replay.md:118-126`); Acceptance Criterion (`docs/specs/015-persistence-recovery-and-replay.md:348`).
  - **Verifies invariant:** I-015-1
  - **Owns (CREATE):** `replay_cursors` (id, session_id UNIQUE, last_sequence, state CHECK ∈ {current,rebuilding,stale}, updated_at) and `recovery_checkpoints` (id, session_id, checkpoint_type, as_of_sequence, state_blob, created_at) ← [GDPR and Recovery Tables (`replay_cursors`, `recovery_checkpoints`)](../architecture/schemas/local-sqlite-schema.md#gdpr-and-recovery-tables-spec-022-plan-015); both rows attributed Owner=Plan-015 in `docs/architecture/cross-plan-dependencies.md §Uncontested Tables`.
  - **Consumes (EXTEND, by SHAPE):**
    - `command_receipts` columns (id, command_id, run_id, status, idempotency_class, dedupe_key, started_at, completed_at, mcp_task_id, created_at) ← Plan-004 owner; "Owner: Plan-004 | Extended by: Plan-015 (recovery + two-phase idempotency protocol, BL-051); Plan-005 (additive nullable mcp_task_id — MCP Tasks durable recovery handle, campaign B10; own Plan-005 migration, never a Plan-004 migration edit)" ([`command_receipts`](../architecture/schemas/local-sqlite-schema.md#queue-and-intervention-tables-plan-004)) — `mcp_task_id` is Plan-005 T5.1's column (NULL until the receiver accepts a task-augmented call); the recovery sweep READS it for T15.3's task-handle carve-out and never writes it.
    - `runtime_bindings` columns incl. `resume_handle`, `runtime_metadata` ← Plan-005 owner; "Extended by Plan-015 (recovery-aware persistence)" ([`runtime_bindings`](../architecture/schemas/local-sqlite-schema.md#driver-and-runtime-binding-tables-plan-005)).
    - `session_events` ← Plan-001/Plan-006 owner; "Extended by Plan-015 (replay cursors)" ([`session_events`](../architecture/schemas/local-sqlite-schema.md#session-events-plan-001-extended-by-plans-006-015)).
    - `session_snapshots` (read-only consumer of `has_compacted_ranges`, `compacted_range_count`) ← Plan-006 owner; `docs/architecture/cross-plan-dependencies.md §1. Table Ownership Map`; [`session_snapshots`](../architecture/schemas/local-sqlite-schema.md#session-snapshots-plan-001-extended-by-plans-006-015).
    - `queue_items` ← Plan-004 owner (queue state), per Plan-015 Dependencies.
    - approval-state table ← Plan-012 owner (approval records), per Plan-015 Dependencies.
    - `tool.idempotency_class` per-tool declaration ← `Spec-005 §Tool Metadata`, per [Spec-015 §References](../specs/015-persistence-recovery-and-replay.md#references).

- [ ] **T15.2 — Implement replay rebuild and idempotent projection restoration on daemon startup.**
  - Build `replay-service.ts` (reads canonical events after a cursor, advancing `replay_cursors`) and the idempotent `ProjectionRebuild` path so a restart deterministically reconstructs projections from canonical events with no client memory. Apply the ADR-018 envelope-version handling (`min_client_version` floor, accept-and-stub, upcaster chain) when replaying mixed-version envelopes — see A-015-3. Replay application carries the **completion-drop guard** (campaign B14, P3-2 — the surveyed completion-drop pattern): a terminal `run_lifecycle` event applying onto a run projection already terminal at the same `(runId, runVersion)` execution epoch is **dropped without a state write** — idempotent rebuild (I-015-2) over ranges containing replayed or duplicate terminals stays byte-stable, a post-rollback second terminal (higher `runVersion`, campaign B2) is NOT dropped, and the guard is the projection-side sibling of the emitter's at-most-once discipline (Plan-004 T3.7 primary; Plan-006's terminal-backstop partial-unique index), never a second dedupe authority.
  - **Target paths:** `packages/runtime-daemon/src/replay/replay-service.ts`, `packages/runtime-daemon/src/persistence/sqlite/`
  - **Spec coverage:** Required Behavior — restart "projection rebuild from canonical events" (`docs/specs/015-persistence-recovery-and-replay.md:48-49`); "Replay must be possible without client memory or ad hoc transcript reconstruction" (`docs/specs/015-persistence-recovery-and-replay.md:52`); Interfaces — `ReplayReadAfterCursor` / `ProjectionRebuild` idempotent (`docs/specs/015-persistence-recovery-and-replay.md:71-72`); Acceptance Criterion (`docs/specs/015-persistence-recovery-and-replay.md:348`).
  - **Verifies invariant:** I-015-2
  - **Consumes (by SHAPE):**
    - `ReplayReadAfterCursor` { sessionId, afterSequence, limit } → { events: EventEnvelope[], nextSequence, hasMore } ← `docs/architecture/contracts/api-payload-contracts.md §Plan-015 — Persistence Recovery And Replay` (replay uses a sequence-position cursor `afterSequence: number`, intentionally distinct from `EventReadAfterCursor`'s opaque `EventCursor` brand — ratified D-015-1).
    - `ProjectionRebuild` { sessionId, force } → { sessionId, rebuiltProjections, asOfSequence } ← `docs/architecture/contracts/api-payload-contracts.md §Plan-015 — Persistence Recovery And Replay`.
    - `EventEnvelope` (incl. `version: EventEnvelopeVersion` "MAJOR.MINOR") ← `docs/architecture/contracts/api-payload-contracts.md §Plan-006 — Session Event Taxonomy`; ADR-018 versioning decisions (semver #1, floor #3, upcaster #6) per `ADR-018 §Decision`.
    - `session_events` canonical log + `replay_cursors` state machine ← [`session_events`](../architecture/schemas/local-sqlite-schema.md#session-events-plan-001-extended-by-plans-006-015) + [`replay_cursors`](../architecture/schemas/local-sqlite-schema.md#gdpr-and-recovery-tables-spec-022-plan-015).
    - Event-log replay obligation ← Plan-006 (event log) `docs/architecture/cross-plan-dependencies.md §3. Inter-Plan Dependency Graph`.

- [ ] **T15.3 — Implement runtime-binding adoption or resume logic plus explicit failure transitions for in-flight runs.**
  - Extend the Plan-005 `runtime-binding-store.ts` with recovery-aware read/persist methods, then implement startup adoption (prefer adopting a live provider session before using a stored resume handle), resume via the driver, and the explicit `failed`-with-detail transition when a handle cannot be resumed. Run the in-flight-receipt sweep at startup only, dispatching on `idempotency_class` per the spec table (re-execute / dedupe-key / `recovery-needed` halt), emitting `tool.replayed` / `tool.skipped_during_recovery`. Four campaign-B14 hardenings on this path: **(P0-6 consume edge)** the whole startup action sequence — adoption, resume, and the receipt sweep — runs strictly **after** T15.2's projection reconstruction completes, per Spec-015 §Default Behavior's reconstruction-before-action gate (campaign B5): no provider-facing action ever consumes a partially reconstructed projection. **(P3-3 exhaustive switch)** resume dispatch switches exhaustively over `DriverResumeResult.status` (`resumed` | `failed`) with a compile-time `never` check — no default-case swallow, so a future union variant fails the build rather than silently mapping to either arm; the driver-side I-005-5 no-silent-replacement discipline carries into recovery as I-015-4. **(P1-2 recovery caller guard)** recovery transitions runs only through the ordinary run-lifecycle emitters and never re-emits a terminal for an already-terminal `(runId, runVersion)` — terminal dedupe lives at the emitter (Plan-004 T3.7 primary; Plan-006's backstop index), and the recovery caller is a guard-respecting client, never a second emission path. **(`manual_reconcile_only` carve-outs)** the sweep implements Spec-015's two deterministic carve-outs (Part-B fail-closed follow-up, 2026-07-17): a receipt whose durably recorded MCP **task handle** exists (`command_receipts.mcp_task_id`, Plan-005 T5.1's additive column — campaign B10; NULL means no task was accepted, so the receipt stays on the plain halt) resolves by polling `tasks/get` to a terminal status and reading the recorded outcome via `tasks/result` — never re-executed, no operator escalation, no `tool.skipped_during_recovery` (the receipt lands its real recorded outcome; a purged/expired task or one observed `input_required` falls back to the halt with the handle preserved) — and a receipt **provably never dispatched** (connection refused, DNS resolution failure, recorded pre-send abort) auto-retries as a first execution regardless of class (no skip event); the sent-but-unacked window keeps the halt (Spec-015 §Idempotency Classes and Recovery Behavior; Spec-005 §Tool Metadata).
  - **Target paths:** `packages/runtime-daemon/src/provider/runtime-binding-store.ts` (EXTEND), `packages/runtime-daemon/src/recovery/startup-recovery-service.ts`
  - **Spec coverage:** Required Behavior restart steps — restoration of runtime bindings + resume-or-explicit-failure (`docs/specs/015-persistence-recovery-and-replay.md:50-51`); Default Behavior — recovery before mutable work; prefer adopting live sessions (`docs/specs/015-persistence-recovery-and-replay.md:57-58`); Fallback Behavior — un-resumable handle → `failed` with visible detail (`docs/specs/015-persistence-recovery-and-replay.md:63`); Idempotency-class recovery dispatch + recovery events (`docs/specs/015-persistence-recovery-and-replay.md:118-135`); Interfaces — `RuntimeBindingRead` (`docs/specs/015-persistence-recovery-and-replay.md:73`).
  - **Verifies invariant:** I-015-1, I-015-4
  - **Ownership note:** `runtime-binding-store.ts` is Owner=Plan-005, Extender=Plan-015 ("extends the store with recovery-aware persistence methods") per `docs/architecture/cross-plan-dependencies.md §2. Package Path Ownership Map`. Plan-015 must EXTEND, not re-CREATE — Plan-005 Phase 2 is the upstream producer.
  - **Consumes (by SHAPE):**
    - `runtime-binding-store.ts` (Plan-005-owned module) ← `docs/architecture/cross-plan-dependencies.md §2. Package Path Ownership Map`.
    - `RuntimeBindingRead` { runId } → { runId, driverName, contractVersion, resumeHandle?, runtimeMetadata } ← `docs/architecture/contracts/api-payload-contracts.md §Plan-015 — Persistence Recovery And Replay`.
    - `DriverResumeResult` discriminated union incl. `recoveryCondition: RecoveryCondition` ← `docs/architecture/contracts/api-payload-contracts.md §Plan-005 — Provider Driver Contract (Internal Interface)`; [Spec-005 §Fallback Behavior](../specs/005-provider-driver-contract-and-capabilities.md#fallback-behavior), per `Spec-015 §Idempotency Classes and Recovery Behavior`.
    - `RunFailureCategory` ∈ {provider failure, transport failure, local persistence failure, projection failure} ← `docs/architecture/contracts/api-payload-contracts.md §Shared Enums`.
    - `tool.replayed` / `tool.skipped_during_recovery` event types (category `tool_activity`), registered in Spec-006, taxonomy tracked by BL-064 ← `Spec-015 §Recovery Events`.
    - `command_receipts` in-flight predicate (`started_at IS NOT NULL AND completed_at IS NULL`) ← `Spec-015 §Idempotency Classes and Recovery Behavior`.

- [ ] **T15.4 — Expose recovery-status reads and renderer surfaces for degraded or blocked startup conditions.**
  - Implement the `RecoveryStatusRead` daemon contract + `recoveryClient.ts` SDK method, and the renderer recovery-status surface that renders healthy / replaying / degraded / blocked states with machine-readable failure category + recovery condition — a T15.5 divergence halt's session entry additionally carries `recoverySpanClassification`, rendered as audit metadata alongside the recovery condition (Part-B follow-up 2026-07-17, campaign B14). Block mutable operations when the local durable store is unavailable. Map `RunFailureCategory.projection failure` → `RecoveryStatusRead` state `degraded`; `RunFailureCategory.local persistence failure` → state `blocked`, per `Spec-015 §Default Behavior`, `Spec-015 §Fallback Behavior`.
  - **Target paths:** `packages/contracts/src/recovery/` (with a `recovery/index.ts` barrel re-exported from `packages/contracts/src/index.ts` — the repo single-import-surface convention, Plan-021 T21.1-1/T21.1-2 precedent; `package.json` keeps exporting only `"."`), `packages/client-sdk/src/recoveryClient.ts`, `apps/desktop/src/renderer/src/recovery-status/`
  - **Spec coverage:** Default Behavior — block local mutable ops when store unavailable (`docs/specs/015-persistence-recovery-and-replay.md:56`); Fallback Behavior — degraded read-only + repair signals (`docs/specs/015-persistence-recovery-and-replay.md:65`); Interfaces — `RecoveryStatusRead` healthy/replaying/degraded/blocked (`docs/specs/015-persistence-recovery-and-replay.md:70`); Acceptance Criteria — block when unavailable + failure visible/auditable (`docs/specs/015-persistence-recovery-and-replay.md:349-350`).
  - **Verifies invariant:** I-015-3
  - **Ownership note:** renderer slot `apps/desktop/src/renderer/src/recovery-status/` is Plan-015's extender slot under Plan-023 per `docs/architecture/cross-plan-dependencies.md §2. Package Path Ownership Map`.
  - **Consumes (by SHAPE):**
    - `RecoveryStatusRead` → { overall, sessions: [{ state, lastReplayedSequence, failureCategory, recoveryCondition, recoverySpanClassification? }] } ← `docs/architecture/contracts/api-payload-contracts.md §Plan-015 — Persistence Recovery And Replay` (the optional `recoverySpanClassification` is the Part-B 2026-07-17 span-content sibling of `recoveryCondition` — audit metadata, present only for a T15.5 divergence halt).
    - `RunFailureCategory` enum ← `docs/architecture/contracts/api-payload-contracts.md §Shared Enums`.
    - `RecoveryCondition` (`"recovery-needed" | "reauth-required"`) ← `docs/architecture/contracts/api-payload-contracts.md §Plan-005 — Provider Driver Contract (Internal Interface)`.
    - renderer host slot ← Plan-023 `docs/architecture/cross-plan-dependencies.md §2. Package Path Ownership Map`.

- [ ] **T15.5 — Resume position-compare + divergence halt-for-human (campaign B14; P1-5 with the R8 interplay guard).**
  - On every successful resume (`DriverResumeResult.status: 'resumed'` — a failed resume follows T15.3's explicit-failure arm), compare the driver-reported normalized `sessionPosition` against the daemon-recorded position derived from the local log. Both recovery attach modes — adopting a live provider session (preferred per Spec-015 §Default Behavior) and cold resume from a stored handle — traverse the single driver `resumeSession → DriverResumeResult` ingress, so the compare gates **every** successful attach: no adoption path finalizes without it (Spec-005's fresh-session sentence — "caught by this comparison rather than silently adopted"). Equal → recovery proceeds. Diverged → **the local log is authoritative** ([ADR-017 Decision Log, 2026-07-02](../decisions/017-shared-event-sourcing-scope.md#decision-log)) and the run **halts for human action**: it enters `waiting_for_input` carrying `recovery-needed` together with the daemon-derived `RecoverySpanClassification` of the diverged span — derived by folding the span's daemon-recorded content (receipt `idempotency_class` values and event kinds): reads only → `read_only`; writes all idempotent/compensable → `idempotent_write`; any `manual_reconcile_only` or side-effecting content of unknown class → `irreversible`; underivable → `unclassifiable`, handled **exactly as `irreversible`** (fail-closed). V1 consumes the classification as **audit metadata only** — every divergence halts; recording it makes tiered auto-resolution a future policy flip gated on this task's CI divergence-injection tests. The daemon never silently re-emits locally recorded events into the provider session and never silently discards provider-side events; the halt surfaces on the existing owner-visible channels only — Spec-013's `run.blocked` status row (the run enters `waiting_for_input`) and `RecoveryStatusRead`'s `blocked` state — never a new notification surface. The compare also catches a provider silently returning a **fresh session** on resume (e.g. Claude on a working-directory mismatch): a fresh session's position cannot match the recorded one. A run already `waiting_for_input` at crash time takes the same halt as a **self-state divergence** — the stale pre-crash input request is replaced by the `recovery-needed` reconciliation block, never left masking the divergence (the run-state-machine self-row, campaign B14).
  - **R8 interplay guard (consumes ADR-017's 2026-07-02 R8 rollback row):** the daemon-recorded comparand respects rollback markers — a `run.rolled_back` event on the run's log establishes the **new authoritative position floor** (the rollback applied-variant's driver-confirmed `sessionPosition`, domain-validated per its api-payload block), so a post-rollback resume compares against the rolled-back position, and rollback and recovery never fight over position truth. **Dispatched-but-unconcluded rollback reconciliation (consumes Spec-004 §Required Behavior's reconciliation rule):** before the compare renders any divergence verdict, a durable dispatched-but-unconcluded `rollback` intervention row on the run (the write-ahead `interventions` marker — accepted-before-dispatch) is reconciled first, "before anything else touches the run": a driver-reported position at the row's `targetPosition` (or a discovered post-fork binding at it) **completes the intervention forward** — remaining legs, durable outcome, forward `run.rolled_back`, binding repoint — establishing the floor the compare then passes against; an unchanged position concludes it by Spec-004's no-rewind path with the floor unmoved; only a divergence unexplained by either branch takes the halt. The crash window between a driver-confirmed rewind and the marker append therefore completes forward instead of stranding as a blanket halt.
  - **Target paths:** `packages/runtime-daemon/src/recovery/startup-recovery-service.ts` (EXTEND — the T15.3 resume path gains the compare before any adoption is finalized), CI divergence-injection test suite under the same package.
  - **Tests:** the CI divergence-injection suite — equal-position resume proceeds; each divergence direction halts in `waiting_for_input` with `recovery-needed` + the recorded classification; every `RecoverySpanClassification` value is exercised and `unclassifiable` handling is asserted identical to `irreversible`; an adoption-mode attach (live provider session) with a divergent position halts identically — no adoption bypass; a `waiting_for_input`-source run re-enters the halt with its stale input request replaced; a post-rollback resume compares against the `run.rolled_back` floor; a dispatched-but-unconcluded rollback whose resume reports `targetPosition` completes forward (marker appended, floor updated, no halt) while an unchanged-position row concludes no-rewind; the fresh-session catch fires; **with a firing negative control** (a seeded known-divergence fixture must fail the suite when the compare is disabled) — this suite is the named gate the future tiered-auto-resolution policy flip waits on.
  - **Spec coverage:** Spec-015 §Fallback Behavior (the resume-divergence halt + span-classification sentence, campaign B5/B14); Spec-015 §Acceptance Criteria (the classification-recording criterion); Spec-015 §Default Behavior (reconstruction-before-action ordering the compare runs under)
  - **Verifies invariant:** I-015-4 (its no-silent-replacement half — the compare catches a provider silently returning a fresh session as the same run, and a diverged position never silently reconciles in either direction)
  - **Consumes (by SHAPE):**
    - `DriverResumeResult` `resumed` variant `{ status: "resumed"; bindingId; sessionPosition }` (REQUIRED `sessionPosition`, campaign B3) ← `docs/architecture/contracts/api-payload-contracts.md §Plan-005 — Provider Driver Contract (Internal Interface)`.
    - `RecoverySpanClassification` named type (`read_only | idempotent_write | irreversible | unclassifiable`; REQUIRED on `DriverResumeResult.failed`, optional on the three replay-visible carriers) ← `docs/architecture/contracts/api-payload-contracts.md §Plan-005 — Provider Driver Contract (Internal Interface)` (Part-B follow-up 2026-07-17).
    - local-log-authoritative ruling + forward `run.rolled_back` position floor ← [ADR-017 Decision Log, 2026-07-02](../decisions/017-shared-event-sourcing-scope.md#decision-log); the rollback applied-variant `sessionPosition` domain-validation ← `docs/architecture/contracts/api-payload-contracts.md §Plan-005 — Provider Driver Contract (Internal Interface)` (`DriverRollbackResult`).
    - sanctioned divergence rows (`running | waiting_for_approval | paused → waiting_for_input`, plus the `waiting_for_input` self-state row — campaign B14; startup reconciliation) + the three-outcome recovery decision rule ← [run-state-machine.md §Recovery Transitions](../domain/run-state-machine.md#recovery-transitions) (campaign B5).
    - dispatched-but-unconcluded rollback reconciliation rule (write-ahead `interventions` row durable before dispatch; at-target completes the intervention forward, unchanged concludes no-rewind; ordered "before anything else touches the run") ← [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior).
    - `run.blocked` status-row surface ← [Spec-013 §Timeline Entry Types](../specs/013-live-timeline-visibility-and-reasoning-surfaces.md#timeline-entry-types) (the Run-State Subtypes table); `RecoveryStatusRead` `blocked` state ← `docs/architecture/contracts/api-payload-contracts.md §Plan-015 — Persistence Recovery And Replay`.
    - `recovery.succeeded`'s third-outcome counter `runsHaltedForReconciliation` ← [Spec-006 §Recovery Events](../specs/006-session-event-taxonomy-and-audit-log.md#recovery-events-recovery_events) (campaign B5 companion).

## Parallelization Notes

- Schema and persistence work can proceed in parallel with replay-service scaffolding once event envelope contracts are stable.
- Renderer recovery-status UI should wait for recovery outcome payloads and machine-readable categories.
- T15.5 extends the T15.3 resume path and follows it; its divergence-injection suite is independent of the renderer track (campaign B14).

## Test And Verification Plan

- SQLite durability and restart recovery integration tests
- Replay rebuild idempotency tests across multiple startup cycles
- Provider-session adoption and failed-resume tests with explicit failure and recovery-needed visibility
- CI divergence-injection suite for the T15.5 resume position-compare (equal / diverged / rollback-floor / fresh-session paths, every `RecoverySpanClassification` value, firing negative control — campaign B14)

## Rollout Order

1. Land persistence schema and receipt storage
2. Enable startup replay rebuild and recovery-status reads
3. Enable automatic in-flight run recovery before mutable work admission

## Rollback Or Fallback

- Disable automatic run resumption and keep replay rebuild plus explicit blocked startup if recovery rollout regresses.

## Risks And Blockers

- Snapshot compaction cadence remains unresolved and may affect rebuild performance (correctness is compaction-independent per `Spec-015 §Resolved Questions and V1 Scope Decisions`; only rebuild performance is affected)
- Recovery ordering mistakes can admit mutable work before canonical local truth is trustworthy

## Ratified Design Decisions (Tier-7 audit)

- **D-015-1 — `ReplayReadAfterCursor` retains a sequence-position cursor (`afterSequence: number`), not the `EventCursor` brand.** The replay read advances over the canonical `session_events.sequence` integer (the `replay_cursors.last_sequence` state machine), so a numeric sequence position is the natural cursor and makes idempotent rebuild (I-015-2) trivially verifiable. The sibling `EventReadAfterCursor` uses the opaque `EventCursor` brand because client-facing event reads must tolerate cursor-format evolution (Plan-006). The two read models intentionally differ; reconciling them to a single brand is a non-blocking refinement **not** adopted in V1 — `docs/architecture/contracts/api-payload-contracts.md §Plan-015 — Persistence Recovery And Replay` keeps `afterSequence: number`. This resolves the cursor-model reconcile the audit flagged as a non-blocking owner decision.

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

- 2026-06-15 — Tier-7 plan-readiness audit (NS-19): 6 findings adjudicated via A-015-1..5; D-015-1 ratified. The audit added §Invariants I-015-1..4 (A-015-2) and the four-task `#### Tasks` block (A-015-1) as backfill recording EXISTING relationships — no new contract, so Plan-015 stays `approved`. Other adjudications: replay envelope ADR-018 version handling threaded into T15.2 (A-015-3); `RunFailureCategory` → recovery-state mapping pinned in T15.4 (A-015-4); compaction-cadence risk re-classed as performance-only, correctness compaction-independent per `Spec-015 §Resolved Questions and V1 Scope Decisions` (A-015-5). D-015-1 ratifies the `ReplayReadAfterCursor` sequence-position cursor model. No upstream-tier or sealed-plan amendments.
- 2026-06-18 — Codex review round 15 (NS-19 PR finalization): KcMXv — T15.4's `packages/contracts/src/recovery/` subdir exposes a `recovery/index.ts` barrel re-exported from `packages/contracts/src/index.ts` (the repo single-import-surface convention — the Plan-021 T21.1-1/T21.1-2 `index.ts` re-export precedent); `package.json` keeps exporting only `"."`. Companion: cross-plan-dependencies.md §2 `recovery/` row. No new contract — Plan-015 stays `approved`. No sealed-plan amendments owed.
- 2026-07-21 — Campaign B14 amendment (capability-enhancement campaign Task 17; design §4 B14 row): authored **T15.5** (resume position-compare + divergence halt-for-human — `DriverResumeResult.resumed`'s REQUIRED `sessionPosition` compared against the daemon-recorded position; diverged ⇒ local log authoritative per ADR-017's 2026-07-02 ruling, run halts `waiting_for_input` carrying `recovery-needed` + the daemon-derived `RecoverySpanClassification` (audit-metadata-only in V1, `unclassifiable` ≡ `irreversible` fail-closed), surfaced on the existing `run.blocked` + `RecoveryStatusRead` channels; the R8 interplay guard makes a `run.rolled_back` marker the new authoritative position floor so rollback and recovery never fight; CI divergence-injection suite with a firing negative control is the named gate for the future tiered-auto-resolution flip), and hardened the existing tasks: T15.1 names the `claimForExecution(receiptId)` Phase-2 CAS at the module API (P2-3 disposition `already-landed` — BL-051 shipped the two-phase columns, no schema amendment); T15.2 gains the completion-drop guard (a terminal for an already-terminal `(runId, runVersion)` drops without a state write — projection-side sibling of the emitter's at-most-once discipline, post-rollback higher-`runVersion` terminals excepted); T15.3 gains the P0-6 reconstruction-before-action consume edge, the P3-3 exhaustive `DriverResumeResult.status` switch with compile-time `never` check (I-005-5 → I-015-4), the P1-2 recovery caller guard (recovery never re-emits terminals — dedupe lives at the emitter), and the two Spec-015 `manual_reconcile_only` carve-outs (durable MCP task-handle `tasks/get`→`tasks/result` resolution; provably-never-dispatched auto-retry; sent-but-unacked keeps the halt). Companion: cross-plan-dependencies.md §2 `src/replay/` ownership row (closes the design §3.1 P-8 gap, P-6 near-collision disposition). **Classification: additive** — no new invariant, no new table, no new cross-plan dependency edge (Plan-004/Plan-005/Plan-006 already in the Dependencies row); every T15.5 behavior is already normative in the approved Spec-015 (§Fallback Behavior, AC4) with contracts pre-documented in api-payload (B3/B10/Part-B), so Plan-015 stays `approved`; the W2.5 targeted re-audit rides the dep-map amendment per the campaign's re-audit table.
- 2026-07-21 — Codex round 1 (PR #234; 6 findings, all fixed) + lead pre-review self-audit: ADR-017 joined Required ADRs (T15.5 makes its local-log-authoritative ruling + rollback floor load-bearing — backfill of an existing accepted dependency, no new contract); T15.5 states that both attach modes (adopt-live preferred, cold resume) traverse the single `resumeSession → DriverResumeResult` ingress so the compare gates every attach (Spec-005's "caught by this comparison rather than silently adopted"), with an adoption-divergence fixture; run-state-machine.md gained the `waiting_for_input` self-state divergence row and T15.5 the matching stale-input-request-replacement sentence; the R8 guard gained Spec-004 §Required Behavior's dispatched-but-unconcluded rollback reconciliation branch (write-ahead `interventions` row reconciled "before anything else touches the run" — at-target completes forward, unchanged concludes no-rewind, only unexplained divergence halts; the confirmed-rewind-before-marker crash window completes instead of stranding); T15.1's `command_receipts` consumed shape and T15.3's task-handle carve-out name `mcp_task_id` (Plan-005 T5.1, campaign B10; NULL ⇒ plain halt); T15.4's status-read shape, §API And Transport Changes, and §Test And Verification Plan surface `recoverySpanClassification` + the divergence-injection suite (the self-audit staged these three mirrors pre-review; Codex R1-6 independently confirmed the same gap). All additions consume existing normative text — classification stays additive.

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
