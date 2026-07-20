# Plan-004: Queue Steer Pause Resume

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `004` |
| **Slug** | `queue-steer-pause-resume` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Spec** | [Spec-004: Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md) |
| **Required ADRs** | [ADR-003](../decisions/003-daemon-backed-queue-and-interventions.md), [ADR-004](../decisions/004-sqlite-local-state-and-postgres-control-plane.md), [ADR-011](../decisions/011-generic-intervention-dispatch.md), [ADR-015](../decisions/015-v1-feature-scope-definition.md) |
| **Dependencies** | [Plan-001](./001-shared-session-core.md) (session core + `session/` run-engine dir + Phase 5 renderer bootstrap), [Plan-005](./005-provider-driver-contract-and-capabilities.md) (driver capability checks + `DriverInterventionResult`), [Plan-007](./007-local-ipc-and-daemon-control.md) (`api-payload-contracts.md` method-name registry), [Plan-023 Tier 1 Partial](./023-desktop-shell-and-renderer.md#tier-1-partial-pr-sequence) (`window.sidekicks` preload bridge + renderer substrate — the Tier-1-shipped substrate slice, not the Tier-8 remainder; this plan's `run-controls/` renderer subtree consumes only the bridge, so the substrate is the sole dependency and no Tier-5 → Tier-8 back-edge is created) |
| **Cross-Plan Deps** | [Cross-Plan Dependency Graph](../architecture/cross-plan-dependencies.md) |
| **References** | [Updated Spec-004](../specs/004-queue-steer-pause-resume.md) (6 intervention states, pause as orchestration-layer), [Run State Machine](../domain/run-state-machine.md) (9 states) |

## Goal

Implement daemon-backed queue state and authoritative intervention handling for active runs.

## Scope

This plan covers queue persistence, intervention records, run-state transitions, and client control surfaces for queue, steer, pause, resume, and interrupt.

## Non-Goals

- Workflow scheduling
- Provider-specific pause emulation beyond declared capabilities
- Notification routing

## Preconditions

- [x] Paired spec is approved — re-checked 2026-07-18 by the campaign Task-28 / W1.5 batch spec re-promotion (supersedes the 2026-07-13 re-open note): Spec-004 returned to `approved`; its campaign amendment window closed.
- [x] **Driver input-ask park leg authored (Part-B fail-closed follow-up, 2026-07-17; authored by campaign B9, 2026-07-20):** [Spec-012 §Resolved Questions and V1 Scope Decisions](../specs/012-approvals-permissions-and-trust-boundaries.md#resolved-questions-and-v1-scope-decisions) and [run-state-machine.md](../domain/run-state-machine.md) require the run-engine to handle `driver_ask.expired` for `kind: 'input'` asks via the `waiting_for_input → paused` park edge — **authored as T3.15** (reciprocal of Plan-012's B13-authored T2.8 normalizer; the CP-004-9 expired→continue mapping stays approval-pipeline-only). Phase-3 run-engine code does not dispatch while this box is unchecked — enforced mechanically by Phase 3's `preconditions:` block (`precondition_box_checked` entry, preflight Gate 5; Gate 7's governance scan deliberately covers only the plan-template trio, so a scoped box needs the phase-level entry); the B9 bundle PR authored T3.15 and checks this box.
- [x] Required ADRs are accepted
- [x] Blocking open questions are resolved or explicitly deferred
- [x] Plan-implementation-readiness audit passed (Tier 5 / NS-17)

Target paths below assume the canonical implementation topology defined in [Container Architecture](../architecture/container-architecture.md).

## Target Areas

- `packages/contracts/src/runControl.ts`
- `packages/runtime-daemon/src/queue/queue-store.ts`
- `packages/runtime-daemon/src/interventions/intervention-service.ts`
- `packages/runtime-daemon/src/session/run-engine.ts`
- `packages/client-sdk/src/runControlClient.ts`
- `apps/desktop/src/renderer/src/run-controls/`

## Invariants

| ID | Invariant | Verified by |
| --- | --- | --- |
| **I-004-1** | Queue items are persisted by the runtime before admission; queue creation fails closed (rejects) when persistence is unavailable rather than admitting un-durable work. | T1.4, T2.1 |
| **I-004-2** | Every intervention outcome (`applied` / `degraded` / `rejected` / `expired`) is durably recorded with a daemon-owned receipt on every path. | T1.4, T2.6, T2.7 |
| **I-004-3** | Request:dispatch:record cardinality is 1:1:1 — one `applyIntervention` call produces exactly one driver dispatch and exactly one durable record. **Amended (campaign B2):** the `rollback` composite from `running` is the sole dispatch-axis exception — one intervention, one durable record, but the atomic application makes two driver-facing calls (the internal pause's interrupt, then the `rollbackTo` conversation leg — [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)); authored by T3.12 (handler) + T3.13 (provider-leg), campaign B9. | T2.4, T3.12, T3.13 |
| **I-004-4** | `target_run_id` is stable across `waiting` / `blocked` transitions — an intervention never silently retargets to a different run. | T1.4, T1.7, T3.3 |
| **I-004-5** | Queue admission is FIFO by `created_at ASC`; queue priority is excluded from admission ordering (`Spec-004 §Resolved Questions and V1 Scope Decisions`). | T2.2 |
| **I-004-6** | Run-state and queue-item transitions are monotonic — no backward transitions; terminal states are absorbing — **absent rollback** (campaign B2: the `rollback` intervention is the sole backward/terminal-exit path, [Run State Machine §Rollback Transitions](../domain/run-state-machine.md#rollback-transitions-campaign-b2); authored by T3.12, campaign B9). | T2.3, T3.4, T3.5, T1.6, T3.12 |
| **I-004-7** | Stale-replay version guard: a run-mutating client command — an intervention, `pause`, or `resume` — whose `expectedRunVersion` does **not equal** the current run version is rejected and applies nothing (an intervention transitions `requested → expired`; `pause` / `resume` reject the request with the run left untouched). **Any** mismatch fails closed — stale (older) _or_ anomalous-future — per `Spec-004 §Interfaces And Contracts` ("a version guard mismatch produces `expired`"); a `<`-only guard would silently admit a future comparand no honest client can hold. **The version comparand is the any-run-progression counter (D-004-1); the guard authors the comparison _behavior_ and the version _derivation_ is fixed by the ratified D-004-1 semantics. The comparand is mandatory (D-004-2, covering interventions + pause/resume) — an absent `expectedRunVersion` is rejected, not skipped.** | T2.8, T3.4, T3.5 (read T1.7) |
| **I-004-8** | Intervention authorization uses the verified PASETO `sub` as the Cedar principal; any client-supplied `initiatorId` is informational only and never authoritative. | T2.5 |
| **I-004-9** | Runtime-truth: the daemon run-state stream is canonical; desktop run-controls render an optimistic projection that is reconciled to the daemon truth on every update. | T4.1, T4.3, T4.4 |
| **I-004-10** | Capability-gate: only `steer` is gated on the driver steer capability. `pause` / `resume` / `interrupt` / `cancel` are orchestration-layer (daemon-composed) and are **never** capability-gated. **Amended (campaign B2):** `rollback` is the second capability-gated intervention — statically refused (`driver.capability_unsupported`, no orchestration fallback) when the driver does not declare the `rollback` flag ([Spec-004 §Interfaces And Contracts](../specs/004-queue-steer-pause-resume.md#interfaces-and-contracts)); the daemon-side static gate is authored by T3.12, the desktop control gate by T4.2, campaign B9. | T4.2, T3.12 |
| **I-004-11** | Bridge-only: the `run-controls/` renderer subtree reaches daemon / control-plane state exclusively via `window.sidekicks`; it never imports `packages/runtime-daemon` or `packages/control-plane` directly. | T4.5 (= CP-004-5) |
| **I-004-12** | Setup-gate: a run transitions `starting -> running` only after every registered `RunSetupGate.assertRunReady` resolves; a gate refusal parks the run in `starting` (never a silent skip, never `running`), and registered `onRunTerminal` hooks fire exactly once per terminal transition — once per `runVersion` epoch: a campaign-B2 rollback out of a terminal state re-opens the run, and a later terminal fires them again ([Run State Machine §Rollback Transitions](../domain/run-state-machine.md#rollback-transitions-campaign-b2); the terminal-source re-open + execution-root re-acquisition is authored by T3.12, campaign B9). (Tier-6 audit.) | T3.10, T3.12 |
| **I-004-13** | Terminal exactly-once (campaign B9, P1-2): the terminal `run_lifecycle` emitter is the **primary** at-most-once-per-`(runId, runVersion)` guard — a guard→swap→append sequence run inside `withSessionAppendLock` ([Plan-006](./006-session-event-taxonomy-and-audit-log.md) T3.1) with read-your-writes state from `getRun`, so the check-and-append is atomic against concurrent same-session appends. Plan-006's partial-unique backstop index + terminal-key trigger pair are defense-in-depth behind this emitter guard, never a replacement for it ([Spec-006 §Run Lifecycle](../specs/006-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle)). | T3.7 |
| **I-004-14** | Late-event absorption (campaign B9, P1-8): a provider run-lifecycle event for a run already in an absorbing terminal state — or one attributed to a pre-rollback execution epoch — is **absorbed, never appended**: a terminal-class straggler routes into the T3.7 emitter and no-ops; a non-terminal lifecycle straggler is dropped with only a `run.late_event.absorbed` OTel diagnostic **non-event** — no `session_events` row, no state transition, no `runVersion` advance ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)). Non-lifecycle families (usage telemetry foremost) append normally, carrying a durable source-epoch stamp when pre-rollback. | T3.11 |
| **I-004-15** | Rollback intervention (campaign B9, R8/RA-2): `rollback` is version-guarded (mandatory `expectedRunVersion`; every fail-closed pre-dispatch validation completes before any effect), state-gated (legal from `paused` / `waiting_for_approval` / `waiting_for_input` / the three terminal states; a `running` target is paused-first via the existing pause path), and always lands the run in `paused`; a conversation-leg-confirmed rollback appends a **forward** `run.rolled_back` under the append lock and advances `runVersion` — the authoritative log never truncates or rewrites, and rolled-back turns stay queryable marked superseded by projection ([Run State Machine §Rollback Transitions](../domain/run-state-machine.md#rollback-transitions-campaign-b2); [ADR-017 Decision Log](../decisions/017-shared-event-sourcing-scope.md#decision-log)). | T3.12, T3.14 |
| **I-004-16** | Rollback file-restore caller contract (campaign B9, CP-004-11 / CP-010-12): the file-restore leg resolves the execution root + `execution_mode` + epoch from the `run_execution_contexts` row, derives the `epochLineage` (`{epoch, rewindBase}` list) from durable epoch / intervention records, validates the driver-confirmed floor equal to the accepted `targetPosition`, and invokes [Plan-010](./010-worktree-lifecycle-and-execution-modes.md)'s turn-snapshot restore under exclusive execution-root tenancy — never authoring Plan-010's callee. A root-less run (disposed ephemeral clone / retired worktree) rolls back **conversation-only** and is non-resumable, and the restore result's per-path disposition (`files-restored` / `files-partially-restored` / `files-unrestored` / `conversation-only`) is recorded on the intervention outcome, never collapsed. | T3.13 |
| **I-004-17** | Driver input-ask expiry park (campaign B9, Spec-012 Part-B fail-closed follow-up): an input-kind `driver_ask.expired` parks the run `waiting_for_input → paused` **replay-atomically** with the ask closure (one `withSessionAppendLock` unit); no input is ever fabricated (fail-closed), the park deliberately does NOT traverse the CP-004-9 approval-outcome seam (that seam's expired outcomes continue-with-refusal, correct only for approval-pipeline categories), and daemon startup reconciliation derives a missing sibling effect from the persisted `(ask_id, expiry_at)` pair ([Spec-012 §Resolved Questions and V1 Scope Decisions](../specs/012-approvals-permissions-and-trust-boundaries.md#resolved-questions-and-v1-scope-decisions)). | T3.15 |

## Cross-Plan Obligations

| ID | Obligation | Direction | Tasks |
| --- | --- | --- | --- |
| **CP-004-1** | Driver capability flags + `DriverInterventionResult` (`applied` / `degraded`) | **Consume** from [Plan-005](./005-provider-driver-contract-and-capabilities.md) | T2.6, T2.7 |
| **CP-004-2** | `command_receipts` table — Plan-004 CREATEs the forward-declared table shell; Plan-015 OWNS its column semantics + read model | **Provide shell** to [Plan-015](./015-persistence-recovery-and-replay.md) | T1.5 |
| **CP-004-3** | `packages/contracts/src/runControl.ts` — new contract surface, no prior owner (verified against the ownership map) | **Create** | T1.1–T1.3, T1.6, T1.7 |
| **CP-004-4** | `run.*` method-name namespace (`run.queueList` / `run.queueCreate` / `run.queueCancel` / `run.intervene` / `run.pause` / `run.resume` / `run.subscribeState` / `run.subscribeQueue`) — wire contract registered in `api-payload-contracts.md §Method-Name Registry`. **The eight concrete strings are ratified (D-004-3).** | **Register** with [Plan-007](./007-local-ipc-and-daemon-control.md) | T4.1, T4.4 |
| **CP-004-5** | `run-controls/` renderer subtree consumes daemon / control-plane state only via `window.sidekicks` (Spec-023 bridge discipline) | **Honor** [Plan-023](./023-desktop-shell-and-renderer.md) | T4.5 (= I-004-11) |
| **CP-004-6** | `packages/runtime-daemon/src/session/run-engine.ts` — **Plan-004 CREATEs this file** (its unexecuted Phase 3 is the file's first author; corrects the prior EXTEND-of-Plan-001 attribution — P-1, campaign B9). The `session/` **directory** is Plan-001-owned, but this specific file crosses per the CP-001-1 per-file-content-ownership precedent ([cross-plan-dependencies.md §2 Package Path Ownership Map](../architecture/cross-plan-dependencies.md#2-package-path-ownership-map)); Plan-001's completed Shipment Manifest is never touched. | **Create** (in Plan-001's `session/` dir) | Phase 3 (T3.1 CREATE; T3.2–T3.15 EXTEND) |
| **CP-004-7** | `getRun(runId): { version, sessionId, state }` run-state read accessor — Plan-004 is the run-state-read **origin**; per [cross-plan-dependencies.md §3 Inter-Plan Dependency Graph](../architecture/cross-plan-dependencies.md#3-inter-plan-dependency-graph), the Plan-016 row names this `getRun` accessor (per CP-004-7), while the Plan-015 (queue-state recovery) and Plan-017 (queue/steer) rows depend on Plan-004 without naming this accessor | **Provide (forward)** to [Plan-016](./016-multi-agent-channels-and-orchestration.md) (the §3-named `getRun` consumer) | T1.7 |
| **CP-004-8** | `RunSetupGate` registration seam (`{ assertRunReady, onRunTerminal? }`, ordered array on `run-engine.ts`) + the `QueueItemCreateRequest.workspaceId?` run-binding carrier — Plan-004 ships the seam with zero gates; Plan-010's execution-root gate registers at Tier 6 (Tier-6 audit, 2026-06-10) | **Provide (forward)** to [Plan-010](./010-worktree-lifecycle-and-execution-modes.md) (reciprocal CP-010-9) | T3.10, T1.1 |
| **CP-004-9** | Approval run-blocking seam — Plan-012's approval-service provides `registerApprovalOutcomeListener({ onBlocking(runId, approvalRequestId, blockingState), onResolved(runId, approvalRequestId, outcome) })` + `cancelPendingForRun(runId, cause)`; the run-engine registers the listener at engine construction (same registration directionality as the CP-004-8 seam). `onBlocking` drives `running -> waiting_for_input` for `user_input` / `mcp_elicitation` categories and `running -> waiting_for_approval` for the other 7; `onResolved` returns the run to `running` — rejected/expired outcomes continue-with-refusal, never terminate (run-state-machine.md `waiting_for_approval -> running` row), except a denied pre-turn moderation gate (`category: 'gate'`), which Plan-016's moderation gate system-cancels with `trigger: 'moderation_denied'` (Spec-016 D-016-10); every terminal transition calls `cancelPendingForRun` so still-pending requests settle as `approval.canceled` (`Spec-006 §Approval Flow (approval_flow)`; Tier-6 audit 2026-06-10, Plan-012 A-6/A-10) | **Consume** from [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (reciprocal CP-012-5) | Phase 3 (doc-only at this audit — Phase 3 unexecuted; listener registration + terminal-hook call land with the run-engine implementation) |
| **CP-004-10** | Orchestration queue-admission seam — Plan-016's orchestration-run-service composes **in-process** with the daemon queue-admission service after its own admission pipeline passes, passing the typed `OrchestrationRunLinkCarrier` ([api-payload-contracts §Plan-016](../architecture/contracts/api-payload-contracts.md#plan-016--multi-agent-channels-and-orchestration)); the admission API returns the minted `RunId` alongside `queueItemId`; `run.queued` threads the carrier fields into its payload as optional additive fields (`{agentId?, parentRunId?, linkType?, internalHelper?, producingNodeId?}` plus the admission-resolved `effectiveRunConfig?`); independent of the carrier, the queue write stamps `admittedUnpricedCapCents?` (native-cap unpriced admissions only) + `admittedModelFamily?` (every admitted run) on EVERY provider run's `run.queued` — the ordinary `run.queueCreate` path stamps directly via **Plan-016's admission-stamp resolver** (the T2.3 family/pricing/`cost_cap` accessor set), which Plan-016 T2.3 wires into this queue-write seam as an EXTEND (Plan-004's own Phase-2 queue tasks carry no pricing/budget machinery — the ordinary-path stamp code lands with Plan-016 T2.3 and is gated on it); the orchestration path supplies the same resolver's values via the carrier — the durable replay sources for cost reservations, worst-case terminal debits, and as-of-admission family keying, never client-suppliable (campaign B6, `Spec-016 §Cost Derivation And Absent-Cost Semantics`) — `Spec-006 §Run Lifecycle (run_lifecycle)`, Plan-016 D-016-3); the wire `run.queueCreate` never accepts the carrier (child-run creation goes through `orchestration.runCreate` only); the `run.completed` `trigger` value set gains `'turn_limit'` for Plan-016's turn-limit completion (D-016-8); Plan-016's system-initiated interventions (budget/idle/moderation) enter through an in-process entrypoint below the wire authz boundary with NULL-for-system actor + the standard `expectedRunVersion` reject-re-read-retry loop (D-016-7) | **Provide (forward)** to [Plan-016](./016-multi-agent-channels-and-orchestration.md) (reciprocal CP-016-7; Tier-6 audit, Plan-016 walk) | Phase 2 (doc-only at this audit — carrier threading lands with the queue-create implementation) |
| **CP-004-11** | Rollback leg consumes (campaign B9): (a) the file-restore leg calls [Plan-010](./010-worktree-lifecycle-and-execution-modes.md)'s Phase-5 turn-snapshot ops — `captureTurnSnapshot` at the turn boundary and `resolveRestoreTarget` / `restoreToTurn` for the rewind (whose `TurnSnapshotResolution` / `TurnSnapshotRestoreResult` result unions T3.13 maps onto the file-leg arms of the `RollbackInterventionResult` `disposition`) — supplying the caller-resolved execution root, `execution_mode`, epoch, turn ordinal, and `epochLineage`; Plan-004 is the caller side (CP-010-12), never authors `git/turn-snapshot-service.ts` (cross-plan §2 one-writer). (b) the conversation leg calls Plan-005's `rollbackTo` driver op + `DriverRollbackResult` (campaign B3) — the daemon resolves the run's live binding at dispatch; the driver-confirmed floor is domain-validated equal to the accepted `targetPosition` before the file leg. | **Consume** from [Plan-010](./010-worktree-lifecycle-and-execution-modes.md) (reciprocal CP-010-12) + [Plan-005](./005-provider-driver-contract-and-capabilities.md) | T3.13 |
| **CP-004-12** | Durable source-epoch attribution carrier (campaign B9, round-2 F5): a **typed epoch-attribution field on the event-append surface**, stamped on pre-rollback-epoch non-lifecycle rows at late-append (T3.11) and read by the supersede projection's cross-epoch keying (T3.14). `Spec-004 §Required Behavior` mandates the durable stamp and delegates its typed shape to the campaign's Plan-006 bundle, but **no such field is in the Plan-006 corpus yet** — so it is a **named merge prerequisite** gating T3.11's late-append leg and T3.14's epoch consumption (that code cannot merge until the carrier lands) and is not authorable here (cross-plan §2 one-writer — Plan-004 writes no Plan-006 symbol). Registering it in Plan-006 / Spec-006 is a **lead-owned follow-up** (§Notes). | **Consume** from [Plan-006](./006-session-event-taxonomy-and-audit-log.md) | T3.11, T3.14 |
| **CP-004-13** | Superseded-turn read seam (campaign B9, round-2 F10): T3.14's projection **exports `supersededTurns(runId)`** — the per-turn supersede predicate the position cutoff + epoch keying produce — as the seam [Plan-013](./013-live-timeline-visibility-and-reasoning-surfaces.md)'s `timeline-projector.ts` + `TimelineRead` consume to render rewound turns distinctly (without it the marking never reaches the rendered timeline). Plan-004 provides-forward the export; the **Plan-013-side consumer task is a lead-owned follow-up** (§Notes), no Plan-013 symbol authored here (cross-plan §2 one-writer). | **Provide (forward)** to [Plan-013](./013-live-timeline-visibility-and-reasoning-surfaces.md) | T3.14 |

## Ratified Design Decisions (Tier 5 audit, 2026-05-30)

The Tier-5 plan-readiness audit (NS-17) surfaced three open decisions; all three were ratified at the user-review pause and are folded here as the plan's design of record. The cross-cutting corpus amendments they entail (Spec-004 / Spec-006 version-derivation + emission; `api-payload-contracts.md §Method-Name Registry`; `error-contracts.md`) are executed at swap alongside this `approved → review` flip.

- **D-004-1 (was F-004-2-10) — `version` = any-run-progression counter.** The `expectedRunVersion` stale-replay guard (I-004-7 / T2.8) compares against a run `version` derived as an **any-run-progression counter** (reading (b)): it increments on every run progression — applied interventions included — not only on `run.*` state-machine transitions (reading (a)). **Rationale (the hardened call):** reading (a) fails to catch two steers racing on a still-`running` run (zero new `run.*` events → the second stale steer passes undetected); reading (b) closes that replay window. Plan-004 authors T1.7's accessor _shape_ and T2.8's guard _behavior_; the `version` _derivation_ follows this ratified semantics. Entails a Spec-004 / Spec-006 amendment defining the `version` field on the `run.*` payload + its increment/emission point (executed at swap).
- **D-004-2 (was F-004-2-06) — `expectedRunVersion` is mandatory (fail-closed).** The comparand is **required** on every intervention request (`Spec-004 §Interfaces And Contracts` mandatory reading); the absent-comparand case is **rejected**, not applied. An optional comparand would let a caller bypass the stale-replay guard by omitting the field — the hardened reading fails closed. T2.8 authors the present-comparand guard; the absent case rejects. Entails a Spec-004 clarification (executed at swap).
  - **Scope extension (Tier-5 audit) — the mandatory comparand binds `run.pause` / `run.resume`, not only interventions.** The ratified `RunPauseRequest` / `RunResumeRequest` contracts (`docs/architecture/contracts/api-payload-contracts.md §Plan-004 — Queue Steer Pause Resume`) carry the **same mandatory** `expectedRunVersion` guard, with `RunControlAck` echoing the advanced `runVersion` so the caller threads the fresh comparand forward. This **extends D-004-2 beyond its original intervention-only scope**: a stale `pause` replayed against a run that has since progressed is the identical replay hazard the guard exists to close, so the comparand fails closed the same way (T3.4 / T3.5 apply the T2.8 guard before composing). `pause` / `resume` remain **orchestration-layer run-control verbs, not interventions** — they hold no `InterventionType` (`steer | interrupt | cancel | rollback`, campaign B2) membership and are not serialized through the intervention queue (ADR-011) — so this is a deliberate cross-cutting extension of the mandatory-comparand obligation, recorded here and reflected in the `api-payload-contracts.md` run-control comment at swap.
- **D-004-3 (was F-004-4-04) — the eight `run.*` method strings are ratified.** `run.queueList` / `run.queueCreate` / `run.queueCancel` / `run.intervene` / `run.pause` / `run.resume` / `run.subscribeState` / `run.subscribeQueue` (CP-004-4) are the wire contract, registered in `api-payload-contracts.md §Method-Name Registry` at swap. Reciprocal `provides` is recorded on [Plan-007](./007-local-ipc-and-daemon-control.md) (the `run.*` namespace owner) in the cross-plan dependency map.

## Data And Storage Changes

- Add local `queue_items`, `interventions`, and `command_receipts` tables.
- Project queue and intervention read models from the durable `queue_items` / `interventions` tables — run state is event-sourced (per ADR-001 / ADR-017), so the `session_events` log is **not** extended with new queue/intervention columns.
- See [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) for column definitions.

## API And Transport Changes

- Add queue list/create/cancel endpoints and intervention request or result events to the client SDK.

## Implementation Steps

- Contracts: See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed schemas this plan consumes.

1. Define run-control contracts and migrations.
2. Implement queue store and serialized intervention application in the daemon.
3. Integrate run-engine state transitions and capability checks.
4. Add desktop queue and intervention controls plus status rendering.

## Implementation Phase Sequence

### Phase 1 — Contracts, Migrations, and the Run-Read Accessor

**Goal:** Land the `runControl.ts` contract surface, the `queue_items` / `interventions` / `command_receipts` migrations, the client-facing pause/resume trigger, and the run-state read accessor that Phase 2's guard and Phase 4's surfacing both consume.

**Precondition:** D-004-1 (`version` = any-run-progression counter) and D-004-2 (`expectedRunVersion` mandatory, fail-closed) ratified — T1.7's accessor `version` field and T1.6's request shape implement these outcomes.

#### Tasks

- **T1.1 — QueueItem contracts** (`QueueItemCreate` / `QueueItemList` / `QueueItemCancel` Zod schemas, incl. the Tier-6-amended `QueueItemCreateRequest.workspaceId?` run-binding field per api-payload-contracts.md §Plan-004 — CP-004-8)
  - **Files:** `packages/contracts/src/runControl.ts` (CREATE)
  - **Spec coverage:** Spec-004 §Interfaces And Contracts (QueueItemCreate / QueueItemList / QueueItemCancel against runtime-owned durable state)
  - **Verifies invariant:** I-004-1
  - **Consumes:** `QueueItemState` enum (queued / admitted / superseded / canceled / expired) + branded `QueueItemId` / `RunId` / `SessionId` (in-package)
- **T1.2 — `InterventionRequestPayload` discriminated union** (`steer` | `interrupt` | `cancel` | **`rollback`**) — the `rollback` arm `{ type: 'rollback'; targetPosition: number }` is authored by this bundle (campaign B9), mirroring `docs/architecture/contracts/api-payload-contracts.md §Plan-004 — Queue Steer Pause Resume` byte-for-byte (`targetPosition`: normalized session position, Zod int + nonnegative at parse; the daemon boundary-existence + strictly-below-current-position check is the fail-closed admission validation, not a parse concern — Spec-004 §Required Behavior)
  - **Files:** `packages/contracts/src/runControl.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Interfaces And Contracts (InterventionRequest — target run id, type, mandatory expectedRunVersion guard)
  - **Verifies invariant:** I-004-4
  - **Consumes:** `RunId`, `InterventionType` (`'steer' | 'interrupt' | 'cancel' | 'rollback'` — the `'rollback'` member is Plan-005-owned (`provider-driver.ts` §Shared Enums per CP-005-6) and imported upward; the shipped `provider-driver.ts` union stays three-membered until the campaign's Plan-005 bundle (B10) widens union + consumers together, so this arm is gated on that widening — the api-payload-contracts code-mirror gate)
- **T1.3 — `InterventionRequestResponse` (6 states) + `RunStateChangeEvent` (9 states)** (campaign B9; Codex round 2 restructures the rollback outcome to the discriminated `RollbackInterventionResult` `disposition` union — `files-restored` / `files-partially-restored` (with `failedStep`) / `files-unrestored` / `conversation-only` / `pause-only` / `nothing-applied` / `position-mismatch` (with `requestedPosition` + `confirmedPosition`) — mirroring `Spec-004 §Required Behavior`'s full vocabulary, carried only on a `rollback` result; the response is discriminated on `interventionType` so the seam parses `result` STRICTLY per type — a malformed rollback result fails validation, never a generic fall-through (test); a `rejected` outcome carries `rejectionReason` so the static `driver.capability_unsupported` refusal rides the lifecycle response, not the `JsonRpcError` channel; the 6 `InterventionState` values are unchanged, and non-rollback results omit the disposition)
  - **Files:** `packages/contracts/src/runControl.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Interfaces And Contracts (InterventionResult 6-state + RunStateChange event)
  - **Verifies invariant:** I-004-2
  - **Consumes:** `InterventionId` / `RunId`, `InterventionState` (requested / accepted / applied / rejected / degraded / expired), `RunState` (9-state), `RunFailureCategory` (**import** from the Plan-001 / Spec-006 taxonomy — do not redefine). The `RollbackInterventionResult` `disposition` vocabulary is Plan-004-owned rollback-outcome content (semantics in T3.13; `files-partially-restored` is never collapsed into `files-unrestored`, per [Plan-010](./010-worktree-lifecycle-and-execution-modes.md) T5.2).
- **T1.4 — Migration: `queue_items` + `interventions` tables**
  - **Files:** `packages/runtime-daemon/src/migrations/00NN-queue-and-interventions.ts` (CREATE)
  - **Spec coverage:** Spec-004 §State And Data Implications (queue items durable storage + intervention audit records)
  - **Verifies invariant:** I-004-1, I-004-2, I-004-3, I-004-4
  - **Consumes:** local SQLite migration runner (Plan-001 substrate)
- **T1.5 — Migration: `command_receipts` table (forward-declared shell)**
  - **Files:** `packages/runtime-daemon/src/migrations/00NN-queue-and-interventions.ts` (EXTEND)
  - **Spec coverage:** none (forward-declared shell — column semantics + read model owned by Plan-015, no fabricated spec anchor per anti-fabrication rule)
  - **Verifies invariant:** none (structural shell only — see CP-004-2)
  - **Consumes:** local SQLite migration runner
- **T1.6 — `RunPauseRequest` / `RunResumeRequest` + `RunControlAck` (client-facing pause/resume trigger)**
  - **Files:** `packages/contracts/src/runControl.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior (pause/resume as orchestration-layer triggers)
  - **Verifies invariant:** I-004-6, I-004-7
  - **Consumes:** `RunId`, `RunState`. Authors the two request types `RunPauseRequest { targetRunId: RunId; expectedRunVersion: number }` and `RunResumeRequest { targetRunId: RunId; expectedRunVersion: number }` plus the shared `RunControlAck { runId: RunId; currentState: RunState; runVersion: number }`, matching `docs/architecture/contracts/api-payload-contracts.md §Plan-004 — Queue Steer Pause Resume` byte-for-byte. Authored as **separate request types** (not an `InterventionType` member) because `pause` / `resume` are absent from `InterventionType` (`steer | interrupt | cancel | rollback`, campaign B2) by design (orchestration-layer, ADR-011) — the client needs a typed trigger distinct from `applyIntervention`. The **mandatory** `expectedRunVersion` carries the stale-replay guard (I-004-7; D-004-2 as extended to pause/resume).
- **T1.7 — Run-read accessor `getRun(runId): { version, sessionId, state }`**
  - **Files:** `packages/contracts/src/runControl.ts` (accessor contract, CREATE) + `packages/runtime-daemon/src/session/run-engine.ts` (forward-ref only — the `getRun` engine-side read lands in Phase 3 when Plan-004 CREATEs the file at T3.1, CP-004-6; Phase 1 authors only the accessor contract)
  - **Spec coverage:** Spec-006 §Run Lifecycle (run_lifecycle) (`run.*` run-state payload — {sessionId, runId, previousState, newState}, event-sourced run state, no standalone runs table); ADR-001; ADR-017
  - **Verifies invariant:** I-004-7 (provides the version comparand for the stale-replay guard) — = CP-004-7 forward-provide
  - **Consumes:** `RunId`, `RunState`. `sessionId` + `state` are derivable from the `Spec-006 §Run Lifecycle (run_lifecycle)` projection. **`version` is the any-run-progression counter ratified as D-004-1** — this task authors the accessor _shape_; the `version` _derivation_ follows the ratified D-004-1 semantics.

### Phase 2 — Queue Admission and Serialized Intervention Application

**Goal:** Daemon-owned, serialized queue admission and the generic `applyIntervention` dispatcher with durable per-outcome records.

**Precondition:** Phase 1 contracts + migrations landed; D-004-1 ratified (T2.8 guard implements the any-run-progression version semantics).

#### Tasks

- **T2.1 (Q1) — Queue admission gate (fail-closed when persistence unavailable)**
  - **Files:** `packages/runtime-daemon/src/queue/queue-store.ts` (CREATE)
  - **Spec coverage:** Spec-004 §Fallback Behavior (reject new queue creation when persistence unavailable); ADR-003 §Failure Mode Analysis (block new queued work when persistence unavailable)
  - **Verifies invariant:** I-004-1
  - **Consumes:** QueueItem contracts (T1.1); error code `queue.persistence_unavailable` (F-004-2-07 — register in `error-contracts.md`)
- **T2.2 (Q2) — FIFO admission (`created_at ASC`; priority excluded)**
  - **Files:** `packages/runtime-daemon/src/queue/queue-store.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Default Behavior (FIFO admission, created_at ASC); Spec-004 §Resolved Questions and V1 Scope Decisions (queue priority deferred — excluded from ordering)
  - **Verifies invariant:** I-004-5
  - **Consumes:** QueueItem store (T2.1)
- **T2.3 (Q3) — Pre-admission cancellation + supersede / expire transitions**
  - **Files:** `packages/runtime-daemon/src/queue/queue-store.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior (queue items support cancellation before admission; supersede / expire transitions)
  - **Verifies invariant:** I-004-6
  - **Consumes:** `QueueItemState` (T1.1)
- **T2.4 (I1) — `applyIntervention` generic dispatch (ADR-011)**
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (CREATE)
  - **Spec coverage:** Spec-004 §Required Behavior (generic intervention dispatch); ADR-011 (applyIntervention(type, payload) generic dispatcher)
  - **Verifies invariant:** I-004-3 (1:1:1 request:dispatch:record)
  - **Consumes:** `InterventionRequestPayload` (T1.2)
- **T2.5 (I2) — Authorization (Cedar principal = verified PASETO `sub`)**
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Interfaces And Contracts (Cedar principal = verified PASETO sub; initiatorId informational only); ADR-012 (Cedar); ADR-010 (PASETO sub)
  - **Verifies invariant:** I-004-8
  - **Consumes:** verified PASETO claims (from the Plan-001 / Plan-008 auth context); client `initiatorId` is informational only
- **T2.6 (I3) — Map `DriverInterventionResult` {`applied` | `degraded`} → 6-state**
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Interfaces And Contracts (InterventionResult 6-state mapping from DriverInterventionResult)
  - **Verifies invariant:** I-004-2
  - **Consumes:** `DriverInterventionResult` (Plan-005 driver contract — CP-004-1), `InterventionState` (T1.3)
- **T2.7 (I4) — Steer-no-capability degrades to queue + interrupt; durable audit every path**
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Driver-Level Steer Mechanics (steer-no-capability degrades to queue + interrupt, durable audit every path; Plan-005 capability checks)
  - **Verifies invariant:** I-004-2
  - **Consumes:** driver capability flags (Plan-005 — CP-004-1)
- **T2.8 (I5) — Stale-replay version guard + per-outcome event**
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Interfaces And Contracts (expectedRunVersion stale-replay guard, mandatory fail-closed)
  - **Verifies invariant:** I-004-7
  - **Consumes:** T1.7 `getRun` accessor (reads current run version)
  - **Behavior (authored):** read current run version via `getRun(targetRunId)`; if `expectedRunVersion !== current` → transition `requested → expired`, apply nothing, and emit an `intervention.*` event `{ sessionId, interventionId, targetRunId, type, state, actor }`. The guard rejects **any** mismatch — stale (older) _or_ anomalous-future — per `Spec-004 §Interfaces And Contracts` ("a version guard mismatch produces `expired`"); a `<`-only comparison would silently admit a future comparand no honest client can hold. **Comparand evaluated against the any-run-progression version semantics (D-004-1).** The absent-`expectedRunVersion` case is rejected (fail-closed) per D-004-2 (mandatory).

### Phase 3 — Run-Engine Orchestration (Interrupt / Pause / Resume / Recover)

**Goal:** Wire intervention outcomes into the 9-state run machine; compose pause/resume as orchestration (not a driver capability); deterministic restart recovery. **Campaign B9 adds:** the P1-2 terminal-emitter enforcement detail (T3.7), P1-8 late-event absorption (T3.11), the `rollback` time-travel intervention (T3.12–T3.14), and the driver-input-ask expiry park leg (T3.15).

**Precondition:** Phase 2 intervention service landed. **Plan-004 CREATEs `packages/runtime-daemon/src/session/run-engine.ts` at T3.1 (CP-004-6 — Plan-004 is the file's first author; the `session/` directory is Plan-001-owned, this file crosses per the §2 per-file precedent); T3.2–T3.15 EXTEND it.**

```yaml
preconditions:
  # Machine-enforced form of the prose line above (preflight Gate 5).
  - { type: plan_phase, plan: 004, phase: 2, status: merged }
  # Plan-010's B22 turn-snapshot service is its Phase 5 (the discrete named
  # snapshot Phase); B23 ships it as code and it must merge before this phase
  # dispatches the rollback file-restore leg (T3.13, CP-010-12). A free-form
  # prose precondition emits zero Gate-5 entries and silently passes — only
  # this YAML shape makes the snapshot gate real (preflight-contract §Gate 5).
  - { type: plan_phase, plan: 010, phase: 5, status: merged }
  - { type: precondition_box_checked, box: "Driver input-ask park leg authored" }
```

#### Tasks

- **T3.1 (INTERRUPT) — Interrupt application** (`running → interrupted`)
  - **Files:** `packages/runtime-daemon/src/session/run-engine.ts` (**CREATE** — Plan-004 is this file's first author, CP-004-6; T3.2–T3.15 EXTEND it)
  - **Spec coverage:** Spec-004 §Required Behavior (interrupt transitions run directly to interrupted); Spec-006 §Run Lifecycle (run_lifecycle) (`run.*` taxonomy)
  - **Verifies invariant:** I-004-6
- **T3.2 (CANCEL) — Cancel application** (`running → interrupted`)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior (cancel intervention → interrupted run-terminal)
  - **Verifies invariant:** I-004-6
  - **Note:** the cancel intervention maps the active run to the canonical `interrupted` run-terminal — cancel is a user-initiated interruption, distinct from T3.1's `interrupt` in actor/intent but **not** in run-terminal (per [run-state-machine.md](../domain/run-state-machine.md): "the cancel intervention maps to the `interrupted` terminal state … distinct from queue-level `QueueItemCancel`"; the run terminals are `completed` / `interrupted` / `failed` — there is no `canceled` run-state). `canceled` is a **`QueueItemState`** (queued / admitted / superseded / canceled / expired; T1.1), applied to queued items by the `QueueItemCancel` path (T2.3), never a run-terminal — this task transitions only the run.
- **T3.3 (WAIT-GUARD) — `waiting` / `blocked` guard (target_run_id stable)**
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §State And Data Implications (waiting / blocked stays on the same run id — target_run_id stable)
  - **Verifies invariant:** I-004-4
- **T3.4 (PAUSE) — Pause orchestration** (compose: interrupt + persist resumable state + enqueue resume marker — **not** driver-dependent)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior (pause composes interrupt + persist + queue resume, orchestration-layer); ADR-011 (orchestration dispatch, not a driver capability)
  - **Verifies invariant:** I-004-6, I-004-7
  - **Consumes:** T1.7 `getRun` accessor (reads current run version)
  - **Behavior (authored):** apply the **same** stale-replay version guard as T2.8 before composing the pause — read current run version via `getRun(RunPauseRequest.targetRunId)`; reject the request untouched if `RunPauseRequest.expectedRunVersion !== current` (`Spec-004 §Interfaces And Contracts`, mandatory per D-004-2 as extended to pause/resume); otherwise interrupt the active run, persist resumable state, enqueue the resume marker, and acknowledge via `RunControlAck { runId, currentState, runVersion }`.
- **T3.5 (RESUME) — Resume orchestration** (re-admit the **same** run id from persisted state)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior (resume returns a paused run to active execution, same run id)
  - **Verifies invariant:** I-004-4, I-004-6, I-004-7
  - **Consumes:** T1.7 `getRun` accessor (reads current run version)
  - **Behavior (authored):** apply the **same** stale-replay version guard as T2.8 before composing the resume — reject the request untouched if `RunResumeRequest.expectedRunVersion !== current` (`Spec-004 §Interfaces And Contracts`, mandatory per D-004-2 as extended to pause/resume); otherwise re-admit the **same** run id from persisted state and acknowledge via `RunControlAck { runId, currentState, runVersion }`.
- **T3.6 (RECOVER) — Deterministic restart recovery** (distinguish `failed` vs `interrupted` on daemon restart)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Fallback Behavior (deterministic restart recovery — distinguish failed vs interrupted); Spec-006 §Replay Interaction with Compacted Regions (replay on daemon restart)
  - **Verifies invariant:** I-004-2, I-004-6
- **T3.7 (EMIT) — Emit `run.*` state-change events + terminal exactly-once emitter** (Spec-006 `run_lifecycle` taxonomy; campaign B9 P1-2 detail)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-006 §Run Lifecycle (run_lifecycle) (`run.*` state-change event payload + the at-most-once terminal emission per `(runId, runVersion)` — the emitter contract)
  - **Verifies invariant:** I-004-2, I-004-13
  - **Behavior (authored, campaign B9 P1-2):** the terminal `run_lifecycle` emit (`run.completed` / `run.failed` / `run.interrupted`) is the **primary** at-most-once-per-`(runId, runVersion)` guard. It runs a **guard → swap → append** sequence wrapped in `withSessionAppendLock(sessionId, critical)` — the per-session append lock [Plan-006](./006-session-event-taxonomy-and-audit-log.md) T3.1 publishes on `event-log-service.ts`, owner-scoped reentrant via `AsyncLocalStorage` so the `append()` issued inside the critical section reuses the held token and never self-deadlocks. Under the lock: read-your-writes current run state via `getRun(runId)` (T1.7), verify no terminal row already exists for this `(runId, runVersion)` epoch, then append the terminal event — so the check-and-append is atomic against concurrent same-session appends. The terminal payload MUST carry non-null `runId` / `runVersion` (the emitter precondition). **Backstop-index interplay:** Plan-006's partial-unique `idx_session_events_run_terminal_once` + the `trg_run_terminal_key_insert` / `trg_run_terminal_key_update` trigger pair are the **schema-level backstop** behind this guard (a duplicate terminal, or a NULL / storage-class-drifted key, fails loud at the DB layer) — never a replacement for the emitter, which is the primary enforcement; the schema work is defense-in-depth (`Spec-006 §Run Lifecycle (run_lifecycle)`).
  - **Rejected alternatives (carried from campaign B1 / design §9 BP-7):** a generic silent-no-op `appendIfAbsent(...)` API stays **rejected** — the corpus enforces terminal exactly-once with a fail-loud emitter guard + fail-loud schema backstop, not a silent absorb-if-present primitive. A projection-level deterministic identity `run-terminal:<runId>:<runVersion>` stays **SECONDARY** — the emitter guard + schema backstop are primary; a deterministic-id dedupe would at best restate that guarantee at the projection layer and is not authored as the enforcement mechanism.
- **T3.8 (MAP) — Map intervention outcomes → run-state transitions**
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior (intervention outcome → run-state mapping)
  - **Verifies invariant:** I-004-6
- **T3.9 (STEER-ROUTE) — Route steer to driver (or degrade per T2.7)**
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Driver-Level Steer Mechanics (route steer to driver, or degrade per T2.7; Plan-005 capability)
  - **Verifies invariant:** I-004-2
- **T3.10 (SETUP-GATE) — Run-setup gate seam: ordered pre-start gates + terminal release hooks (Tier-6 audit)**
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-010 §Fallback Behavior (blocked-in-setup parks the run in `starting`, interruptible) + run-state-machine.md `starting` rows (`starting -> running` fires only after gates pass; `starting -> interrupted` on user stop while parked)
  - **Verifies invariant:** I-004-12
  - Note: `RunSetupGate` interface `{ assertRunReady(context): Promise<void>; onRunTerminal?(context): Promise<void> }` with an ordered gate array on the run-engine; context carries `{ runId, sessionId, queueItem }` (incl. the T1.1 `workspaceId?`). `queued -> starting` admits the run, then gates execute in registration order BEFORE `driver.startRun`; a gate throw parks the run in `starting` with the typed error surfaced (no `running` transition fires; interrupt/cancel per T3.1/T3.2 applies to parked runs). `onRunTerminal` hooks fire in reverse registration order when the run reaches any terminal state. Plan-004 ships the SEAM with zero registered gates — generic, no Plan-010 knowledge; Plan-010's execution-root gate registers at Tier 6 (Plan-010 D-010-16, reciprocal CP-010-9 — CP-004-8). Tests: gate registration order; gate-throw parks in `starting` with the typed error; zero-gate pass-through; reverse-order terminal hooks fire exactly once (per `runVersion` epoch — campaign B2); interrupt-while-parked transitions to `interrupted`.
- **T3.11 (LATE-ABSORB) — Post-interrupt / post-rollback late-event absorption** (campaign B9, P1-8)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior (post-interrupt late-event absorption; execution-epoch keying); Spec-006 §Run Lifecycle (run_lifecycle) (terminal-class straggler routes into the at-most-once terminal emitter)
  - **Verifies invariant:** I-004-14
  - **Behavior (authored):** at the run-engine inbound dispatch, a provider **run-lifecycle** event for a run already in an absorbing terminal state — or one the per-binding epoch cursor attributes to a **pre-rollback execution epoch** — is **absorbed, never appended**: a terminal-class straggler routes into the T3.7 terminal emitter and no-ops there (the guard finds the `(runId, runVersion)` terminal already present); a non-terminal lifecycle straggler is dropped from the lifecycle path and recorded only as a `run.late_event.absorbed` OTel diagnostic **non-event** (never a `session_events` row), with no state transition and no `runVersion` advance. The absorb decision runs inside `withSessionAppendLock` so the terminal-check and the absorb see one consistent state. Non-lifecycle families (usage telemetry foremost) append normally under their own rules — a pre-rollback-epoch non-lifecycle row appends **carrying the durable source-epoch stamp** (the typed epoch-attribution field on the append surface — **owed by Plan-006 per CP-004-12**, a **named merge prerequisite** gating this late-append leg; consumed by T3.14's supersede projection), so billable usage is never dropped. Epoch attribution is per-binding and needs no wire token: a superseded fork-repointed binding's deliveries are entirely pre-epoch; on an in-place binding the driver's `rollbackTo` confirmation is the in-stream fence. For the **pause-first composite** the absorption window opens **earlier than the fence** — from the moment the composite issues its internal interrupt (T3.12), run-lifecycle events sourced from the interrupted execution are the pause's **expected echo**: consumed by the pause application exactly as the client pause path consumes its own interrupt's echo, or absorbed as above, never routed as spontaneous transitions — so a late `run.interrupted` arriving after the internal pause but before the `rollbackTo` confirmation cannot re-terminalize the mid-composite run or release its root (`Spec-004 §Required Behavior`). **Tests:** a late `run.interrupted` in the pause-first composite window (after the internal interrupt, before the `rollbackTo` confirmation) is absorbed as the pause's expected echo — the mid-composite run is neither re-terminalized nor has its execution root released.
- **T3.12 (ROLLBACK) — `rollback` intervention handler: guard, state-gating, transitions, forward emission** (campaign B9, R8/RA-2)
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (EXTEND — the `rollback` dispatch arm) + `run-engine.ts` (EXTEND — the transitions + forward emission)
  - **Spec coverage:** Spec-004 §Required Behavior (rollback — version guard, state-gating, pause-first, forward `run.rolled_back`, failure semantics); Spec-004 §Interfaces And Contracts (rollback capability gate + 6-state result); ADR-011 (generic `applyIntervention` dispatch — new types need no interface change)
  - **Verifies invariant:** I-004-3, I-004-6, I-004-10, I-004-12, I-004-15
  - **Consumes:** T1.2 (`rollback` payload arm), T1.7 `getRun`; the `Run State Machine §Rollback Transitions` edges (campaign B2)
  - **Behavior (authored):** `applyIntervention('rollback', {targetPosition})` rides the existing generic dispatch (ADR-011, zero interface change). **All fail-closed pre-dispatch validation completes before any effect:** the mandatory `expectedRunVersion` guard (evaluated once at admission against the pre-pause version, per D-004-1 semantics), the static capability gate (`driver.capability_unsupported`, no orchestration fallback, when the driver does not declare `rollback` — I-004-10), the `targetPosition` boundary check (a recorded turn boundary strictly below the current position — with the sole carve-out that a target **equal to the current position** is admissible when the run's recorded rollback outcome at that position left the file leg incomplete: `files-unrestored`, `files-partially-restored`, or the position-mismatch skip — the **file-leg recovery path**, whose conversation leg no-ops by absolute-position convergence and whose restore re-runs to the fixpoint), and execution-root availability. **State-gating** per `Run State Machine §Rollback Transitions`: legal from `paused` / `waiting_for_approval` / `waiting_for_input` / the three terminal states; a `running` target is **paused-first** (the existing pause path: interrupt + persist) as an unguarded internal sub-step that queues **no** resume event and cancels a pending resume as moot. A `waiting_for_approval` / `waiting_for_input` source **voids the pending block durably, atomic with the rollback transition**: the awaited approval settles `approval.canceled` via Plan-012's `cancelPendingForRun(runId, cause)` seam (CP-004-9 — consumed, never authored here; `Spec-006 §Approval Flow (approval_flow)` terminal) and a driver input-ask settles `driver_ask.canceled` through its owning surface (`Spec-006 §Driver Ask Events` terminal — no new event type minted); a queued pending resume against the target run is voided the same way (canceled as moot — the position it would resume from is rewound). The void is **progression-serialized**: a concurrent resolution that applies first advances `runVersion` so the in-flight rollback `expired`s; a rollback that applies first cancels the block and the late resolution finds a canceled request and no-ops. A **terminal-source** rollback re-acquires the execution root (reactivating `run_execution_contexts`, clearing `released_at` atomically with the re-open — I-004-12); a root `busy` under another run refuses the whole intervention pre-dispatch; a root-less run rolls back conversation-only (T3.13). A terminal-source composite **releases its re-acquired root on every path that does not confirm the conversation rewind** (a preflight refusal, a conversation-leg `degraded`, or the no-rewind reconciliation): the run stays terminal, the workspace returns to `ready`, and the execution context's `released_at` marker is restored — the re-acquired hold is retained **exactly** when the run re-opens `paused`, and released on every non-confirming exit so the terminal-source re-acquisition never leaks the root. On the **confirmed conversation leg** (T3.13), append the **forward** `run.rolled_back` event (`{sessionId, runId, runVersion, channelId?, targetPosition}`) under `withSessionAppendLock`, advance `runVersion`, and land the run in `paused` — a state-changing rollback (terminal-exit or waiting-void) also emits `run.paused`; an in-place rollback from `paused` emits only `run.rolled_back`. The authoritative log never truncates (`ADR-017 Decision Log`). 1:1:1 cardinality holds with the sole dispatch-axis exception of the pause-first composite's two driver-facing calls (I-004-3). **Tests:** a waiting-source rollback settles the pending approval `approval.canceled` (via `cancelPendingForRun`) / a driver input-ask `driver_ask.canceled` and voids a queued resume; the progression-serialized race — resolution-first ⇒ the rollback is `expired`; rollback-first ⇒ the late resolution no-ops.
- **T3.13 (ROLLBACK-RESTORE) — Conversation leg + turn-snapshot file-restore caller** (campaign B9; CP-004-11 / CP-010-12 caller side)
  - **Files:** `run-engine.ts` (EXTEND) + rollback integration tests (`packages/runtime-daemon/**/__tests__/`)
  - **Spec coverage:** Spec-004 §Required Behavior (conversation-then-file sequencing, confirmed-floor validation, partial-restore disposition, conversation-only fallback); Spec-004 §Driver-Level Rollback Mechanics; Spec-010 §Turn-Boundary Snapshots (the consumed capture / restore ops)
  - **Verifies invariant:** I-004-16
  - **Consumes:** CP-004-11 — [Plan-010](./010-worktree-lifecycle-and-execution-modes.md)'s `captureTurnSnapshot` / `resolveRestoreTarget` / `restoreToTurn` (Phase-5 callees, never authored here) + [Plan-005](./005-provider-driver-contract-and-capabilities.md)'s `rollbackTo` op / `DriverRollbackResult`; the `run_execution_contexts` row (Plan-010 D-010-5)
  - **Behavior (authored):** the caller side of CP-010-12. **(a) Turn-boundary capture call-site:** at each turn boundary of a writable-mode run, call `captureTurnSnapshot({executionRoot, runId, epoch, turnOrdinal, mode})` — resolving `executionRoot` + `mode` from the run's `run_execution_contexts` row (D-010-5), supplying the **execution epoch** (0 before any rollback, incremented per applied rollback); the callee's `read-only` self-guard and its capture-never-blocks-the-turn contract are Plan-010's. **(b) Rollback restore sequencing under exclusive execution-root tenancy — preflight → conversation → bound file-restore:** **conversation-only short-circuit first** — a run whose mode snapshots nothing (`read-only`) or whose execution root no longer exists (a disposed ephemeral clone / a worktree retired by the cleanup sweep) takes the **conversation-only** branch here, before `resolveRestoreTarget`: it records the `conversation-only` disposition and skips the file leg entirely (the resolver would otherwise `no_snapshot`-refuse a read-only run that correctly captured nothing, wrongly failing the whole rollback), and the re-opened rootless run is **non-resumable** — `run.resume` against a released-context run with no existing root is refused with the typed `run.execution_root_released` (409, run state unchanged; distinct from the setup-time `workspace.execution_root_unresolved` — `error-contracts.md §Run`), nothing recreating a disposed clone / retired worktree. For a writable-mode run with a live root, derive the **`epochLineage`** (ordered `{epoch, rewindBase}` list) from the run engine's durable epoch / intervention records and call the non-mutating `resolveRestoreTarget({executionRoot, runId, targetPosition, epochLineage})`, which returns a `TurnSnapshotResolution` (Plan-010 T5.2) — its typed `head_moved` (HEAD advanced past the snapshot) / `no_snapshot` (no ref in the owning epoch) refusal variants reject the whole rollback **before** the conversation leg. Conversation leg: dispatch `rollbackTo` (the daemon resolves the run's live binding at dispatch; a fork-composed leg repoints it via `DriverRollbackResult.applied.bindingId`) and domain-validate the driver-confirmed floor (`sessionPosition`) equal to the accepted `targetPosition` before the file leg — a mismatch degrade records the confirmed position. Bound file-restore: call `restoreToTurn(resolution)` (it re-verifies the HEAD precondition under the hold — TOCTOU guard) and map the returned `TurnSnapshotRestoreResult` (Plan-010 T5.2) onto the result's file-leg `disposition` (`RollbackInterventionResult`) — `restored → files-restored`, `partial_restore → files-partially-restored` (with the failed step named; **never collapsed into `files-unrestored`**), and the execution-time `head_moved` re-verify refusal → `files-unrestored` (the conversation leg has already applied; the worktree is untouched by the refusal). Plan-004 owns the pre-dispatch validation, the exclusive execution-root tenancy, and the conversation leg; Plan-010 owns the callee (`git/turn-snapshot-service.ts`) — B9 **calls** it, never writes it (cross-plan §2 one-writer). **Provider-rewind currency:** Codex `thread/rollback` / Claude `--resume-session-at` are unconfirmed against a live binary (`Plan-005 §Risks And Blockers`; `ADR-017 Decision Log`) — re-verify the method against the then-installed provider binary before this leg's code lands. **Tests:** the turn-boundary call-site invokes the callee with the resolved root / mode / epoch; a full rollback round-trip as integration tests — preflight refusal (no worktree mutation), conversation-then-file success, confirmed-floor-mismatch degrade, root-less conversation-only, the `files-partially-restored` disposition, and a `run.resume` against the rootless re-opened run refused `run.execution_root_released`.
- **T3.14 (ROLLBACK-SUPERSEDE) — Projection supersede-marking of rolled-back turns** (campaign B9)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior (rolled-back turns stay in the timeline marked superseded by projection); Spec-004 §Driver-Level Rollback Mechanics (timeline presentation — supersede cutoff: turn > post-rollback position of the accepted `run.rolled_back` event); ADR-017 Decision Log (the authoritative log never truncates or rewrites)
  - **Verifies invariant:** I-004-15
  - **Behavior (authored):** rolled-back turns are never truncated from the authoritative log; the run / intervention projection marks them **superseded** by the **post-rollback position cutoff** carried on the accepted `run.rolled_back` event — a turn is superseded when its position is **strictly greater than that event's post-rollback position** (`turn > targetPosition`), so the epoch-0 prefix **at or below** the target stays current while the rewound tail above it is marked (`Spec-004 §Driver-Level Rollback Mechanics`). Cross-epoch rows are keyed additionally on the **pre-rollback execution epoch**: the projection consumes the durable source-epoch stamp T3.11 records on pre-rollback rows (the Plan-006-owned epoch-attribution field per CP-004-12 — the named merge prerequisite above), so a replayed projection marks stale-epoch rows superseded exactly like the in-time rows of the epoch they belong to — a re-executed turn reusing a superseded ordinal at or below the target is still marked by its source epoch, and pre-rollback assistant output / tool activity can never resurface as current timeline state. The projection **exports the superseded-turn read** (`supersededTurns(runId)` — the per-turn supersede predicate the position-cutoff + epoch keying produce) as the seam **[Plan-013](./013-live-timeline-visibility-and-reasoning-surfaces.md)'s `timeline-projector.ts` + `TimelineRead` consume** to render rewound turns distinctly (CP-004-13 — Plan-004 provides-forward; the Plan-013-side consumer task is a lead-owned follow-up, no Plan-013 symbol authored here — without this seam the marking never reaches the rendered timeline). **Tests:** a rolled-back run's turns above `targetPosition` are marked superseded while the at-or-below prefix stays current; a re-executed turn reusing a superseded ordinal at or below the target is marked by its source epoch; a projection rebuild preserves both markings; the exported `supersededTurns(runId)` returns the marked set for a given run.
- **T3.15 (ASK-EXPIRY-PARK) — Driver input-ask expiry park leg** (campaign B9; Spec-012 Part-B fail-closed follow-up, 2026-07-17)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-012 §Resolved Questions and V1 Scope Decisions (input-kind ask expiry is park-resumable via `waiting_for_input → paused`; never auto-approve); Spec-006 §Driver Ask Events (input-kind asks route to the run's interactive surface, not the approval pipeline)
  - **Verifies invariant:** I-004-17
  - **Behavior (authored):** the run-engine handles `driver_ask.expired` for `kind: 'input'` asks by parking the run **`waiting_for_input → paused`** — the park edge Spec-012's Part-B amendment adds to `run-state-machine.md` (previously legal only for rollback) — driven by the daemon's ask-expiry path and **deliberately NOT** the CP-004-9 / CP-012-5 approval-outcome seam (that seam's expired outcomes continue-with-refusal back to `running`, correct only for approval-pipeline categories; a driver input ask never traverses the approval pipeline). No input is fabricated (fail-closed); the ask closes as expired and the run parks in its ordinary resumable `paused` state (resume re-engages the provider, which may re-raise the ask). **Replay-atomic:** the park transition commits as one unit with `driver_ask.expired` under `withSessionAppendLock`; daemon startup reconciliation derives a missing sibling effect from the persisted `(ask_id, expiry_at)` pair; a crash-after-first-effect test rides this task. This is the reciprocal of Plan-012's B13-authored T2.8 driver-ask-normalizer emission; the CP-004-9 expired→continue-with-refusal mapping stays approval-pipeline-only.

> **Tier-6 reciprocal (CP-004-9, doc-only):** when Phase 3 executes, the run-engine also registers Plan-012's approval outcome listener (`registerApprovalOutcomeListener` — blocking/unblocking transitions per the CP-004-9 row) and calls `cancelPendingForRun(runId, cause)` from the same terminal path that fires `onRunTerminal` hooks, so pending approval requests settle as `approval.canceled` instead of dangling (Plan-012 A-6/A-10).

> **Resolved at the Plan-016 walk (same Tier-6 audit):** child-run behavior on parent interrupt/cancel is **non-cascade** — children are independent intervention targets (Spec-016 §Run Hierarchy; run-state-machine.md §Child-Run Behavior as rewritten by Plan-016 A-016-17). No cascade logic is authored here or in Plan-016; `run_links` is owned by Plan-016 (Tier 6). (F-004-3-08 → closed by Plan-016 A-016-17.)

### Phase 4 — Desktop Run-Controls

**Goal:** The client SDK + renderer run-controls subtree + the `run rollback` CLI command — optimistic projection reconciled to daemon truth, capability-gated steer (with `rollback` the second identically-gated control per campaign B2 — desktop control-gate at T4.2, CLI command at T4.7, both campaign B9), renderer bridge-only.

**Precondition:** Phase 1–3 daemon surface landed; **D-004-3 (`run.*` method strings) ratified** before T4.1 / T4.4 wire calls land. Plan-023 renderer substrate + `window.sidekicks` bridge present. For T4.7 only, [Plan-007](./007-local-ipc-and-daemon-control.md)'s `apps/cli` scaffold (Phase R3, T-007r-3-1) is present — the CLI command file cannot compile before the workspace exists (a cross-plan sequence dependency, prose-only like the Plan-023 substrate above; the load-bearing Plan-010 snapshot dependency is the YAML-gated one below).

```yaml
preconditions:
  # Machine-enforced form of the phase-1–3 prose (preflight Gate 5). The
  # Part-B box entry is carried onto this phase too: the auto-walk soft-skips
  # an ineligible phase and tries later ones, so gating Phase 3 alone would
  # let the walk select Phase 4 past the unmet park leg.
  - { type: plan_phase, plan: 004, phase: 1, status: merged }
  - { type: plan_phase, plan: 004, phase: 2, status: merged }
  - { type: plan_phase, plan: 004, phase: 3, status: merged }
  - { type: precondition_box_checked, box: "Driver input-ask park leg authored" }
```

#### Tasks

- **T4.1 — `runControlClient.ts` SDK (single daemon-transport factory)**
  - **Files:** `packages/client-sdk/src/runControlClient.ts` (CREATE)
  - **Spec coverage:** Spec-023 §Signature Feature Composition Sketches (Runs View — daemon run-state / queue subscriptions); Spec-004 §Interfaces And Contracts (run-control client surface)
  - **Verifies invariant:** I-004-9
  - **Transport (authored):** a single daemon-transport factory `createDaemonRunControlClient(transport)` riding `window.sidekicks.daemon.call` / `daemon.subscribe`. **Rationale:** run-control authority is daemon-only — `ADR-003 §Decision` ("the daemon will be the authority that applies and records their outcomes"), Assumption #3 (`ADR-003 §Assumptions Audit`), and no control-plane run-control surface exists in the corpus (verified). This **excludes** the `sessionClient.ts` dual-transport pattern; it structurally resembles `membershipClient.ts`'s daemon half (`docs/architecture/cross-plan-dependencies.md §NS-28: Plan-002 Phase 5 — Client SDK Membership Surface`), but the rationale is the source fact, not the precedent.
  - **Consumes:** `window.sidekicks.daemon` bridge (Spec-023); the `run.*` method strings (CP-004-4 — ratified, D-004-3)
- **T4.2 — Capability-gated steer + rollback; pause/resume/interrupt/cancel NEVER gated**
  - **Files:** `apps/desktop/src/renderer/src/run-controls/` (CREATE)
  - **Spec coverage:** Spec-004 §Default Behavior (capability-gated controls; pause/resume orchestration-layer, never driver-gated); Spec-004 §Interfaces And Contracts (the `rollback` capability gate — the second gated control); ADR-011 (pause is orchestration, not a driver capability)
  - **Verifies invariant:** I-004-10
  - **Note:** the §Rollback "disable any false flag" line is a **trap** — of this plan's controls exactly two are gated on driver capability: `steer` and, per I-004-10 as amended, the campaign-B2 `rollback` intervention. The desktop `rollback` control-gate is **authored here** (campaign B9): the run-controls subtree disables the rollback affordance when the driver does not declare the `rollback` capability, the renderer mirror of T3.12's daemon-side static gate — no orchestration fallback, identical to the `steer` gate. `pause` / `resume` / `interrupt` / `cancel` are orchestration-layer and are never capability-gated.
- **T4.3 — Optimistic-vs-runtime-truth reconciliation**
  - **Files:** `apps/desktop/src/renderer/src/run-controls/` (EXTEND)
  - **Spec coverage:** Spec-023 §Signature Feature Composition Sketches (Runs View — daemon run-state subscription)
  - **Verifies invariant:** I-004-9
  - **Consumes:** daemon run-state subscription — subscribe request shape follows the shipped `subscribePresence → { sessionId }` precedent (`docs/architecture/cross-plan-dependencies.md §NS-29: Plan-002 Phase 6 — Desktop session-members Renderer`)
- **T4.4 — Surface 9 run-states + 6 intervention-states**
  - **Files:** `apps/desktop/src/renderer/src/run-controls/` (EXTEND)
  - **Spec coverage:** Spec-004 §Interfaces And Contracts (surface 9 run-states + 6 intervention-states; canonical terminal is failed, not errored)
  - **Verifies invariant:** I-004-9
  - **Consumes:** `RunState` / `InterventionState` (T1.3); `run.*` subscription channel names (CP-004-4 — ratified, D-004-3)
- **T4.5 — Bridge-bypass import-restriction**
  - **Files:** `apps/desktop/src/renderer/src/run-controls/` (EXTEND) + import-restriction assertion test
  - **Spec coverage:** Spec-023 §Preload Bridge Contract (renderer composes via the preload bridge, never bypasses)
  - **Verifies invariant:** I-004-11 (= CP-004-5)
  - **Note:** enforces the renderer bridge-discipline rule (`docs/architecture/cross-plan-dependencies.md §2. Package Path Ownership Map`, `apps/desktop/src/renderer/` row) for the `run-controls/` subtree.
- **T4.6 — Test suite (SDK + orchestration + single-client renderer component tests)**
  - **Files:** `packages/client-sdk/**/*.test.ts` + daemon orchestration integration tests + `apps/desktop/src/renderer/src/run-controls/__tests__/*.test.tsx`
  - **Spec coverage:** Spec-004 §Acceptance Criteria (SDK + orchestration + renderer-component test coverage)
  - **Verifies invariant:** I-004-9, I-004-10, I-004-11 (SDK + orchestration + renderer-component layer)
  - **Note:** single-client RTL renderer component tests ship **now**, mirroring the merged NS-29 `session-members/participant-roster.test.tsx` precedent (`@testing-library/react` `render`/`screen` + an `installMockBridge` `{ daemon: { call, subscribe } }` mock + the bridge-projection / no-direct-daemon-import assertion, per the `SessionBootstrap.test.tsx` idiom). Only the **multi-client live-run-state E2E** (cross-client daemon-stream reconciliation) defers — to the **Plan-023 Tier-8 IPC dispatcher**, _not_ BL-131 (which is Plan-003-scoped and whose "harness unavailable until Tier 8" premise NS-29 has already overtaken). SDK + orchestration tests are in-scope now.
- **T4.7 — `run rollback` CLI command** (campaign B9; RA-7 reachability)
  - **Files:** `apps/cli/src/commands/run-rollback.ts` (CREATE) + `apps/cli/src/main.ts` (EXTEND — register the command on Plan-007's clipanion `Cli` instance; clipanion has no auto-discovery) + `apps/cli/src/commands/__tests__/run-rollback.test.ts`
  - **Spec coverage:** Spec-004 §Interfaces And Contracts (the `rollback` intervention client surface + 6-state `InterventionResult` + `RollbackInterventionResult` disposition-union rendering + result-state→exit mapping); Spec-007 §Required Behavior (the CLI is the first delivery track; commands consume the daemon through the typed client, never daemon internals)
  - **Verifies invariant:** I-004-10
  - **Command (authored):** `ai-sidekicks run rollback <runId> --to <targetPosition> --expected-run-version <n>` — a clipanion command file (kebab filename → nested `run rollback` path per the Plan-007 `daemon-status.ts` command-file precedent, `Plan-007 §Client SDK + CLI (packages/client-sdk/, apps/cli/)`). The command is **registered on Plan-007's `apps/cli/src/main.ts` `Cli` instance** (T-007r-3-2 CREATE) — clipanion has no auto-discovery, so an unregistered command file is unreachable; Plan-007 owns `main.ts` and Plan-004 EXTENDs it with this one `.register()` call (dep-map §2 `apps/cli/src/main.ts` row; the CP-004-4 `run.*` reciprocal with Plan-007 already covers the namespace). It dispatches the `run.intervene` `rollback` intervention (CP-004-4 namespace; T1.2 payload arm) via the `@ai-sidekicks/client-sdk` typed daemon client — the client seam generates the **mandatory** requester-side `clientIdempotencyKey` (a fresh UUID per invocation, `Spec-004 §Interfaces And Contracts`; the T1.2 arm carries it) so an at-least-once retry replays the recorded outcome rather than re-applying — and renders the 6-state `InterventionResult` — including the `RollbackInterventionResult` disposition (T1.3) — and maps the **result state to a POSIX exit code**: `applied` → 0, and `rejected` / `expired` / `degraded` → distinct nonzero codes per the `exit-codes.ts` scheme. The static `driver.capability_unsupported` refusal is a **normal `run.intervene` response** with lifecycle state `rejected` carrying `rejectionReason` (`Queue And Intervention Model §Driver Result To Lifecycle Mapping` maps it `requested → rejected`), so it rides the **result**, not the `JsonRpcError` channel — the CLI renders the `rejectionReason` + disposition and adds **no** local gate (it renders the daemon's authoritative decision, I-004-10). The `exit-codes.ts` `JsonRpcErrorCode → PosixExitCode` mapping still covers genuine **transport** errors (an unreachable daemon, a malformed request). `--expected-run-version` is **required** (the fail-closed guard is mandatory, D-004-1 / T3.12 — the CLI never omits it). Honors Plan-007's `apps/cli` import isolation (I-007-13 — imports only `@ai-sidekicks/client-sdk`, `@ai-sidekicks/contracts`, `clipanion`, Node built-ins; never `@ai-sidekicks/runtime-daemon`), enforced by `apps/cli/eslint.config.mjs`. **Consumes:** the [Plan-007](./007-local-ipc-and-daemon-control.md) `apps/cli` scaffold (Phase R3, T-007r-3-1 — the precondition prose above) + `@ai-sidekicks/client-sdk` daemon client + the `run.*` namespace (CP-004-4, ratified D-004-3). Tests: dispatches `run.intervene` with the `rollback` arm carrying `targetPosition` + `expectedRunVersion` + a client-generated `clientIdempotencyKey` (UUID); renders each of the 6 result states and maps each to its POSIX exit code (`applied` → 0; `rejected` / `expired` / `degraded` → their distinct nonzero codes); a `driver.capability_unsupported` refusal renders as a `rejected` result carrying `rejectionReason` (not a transport error); the command is reachable through the real `Cli` (an end-to-end `ai-sidekicks run rollback` invocation resolves to this command, proving registration); a `--expected-run-version`-omitted invocation is a usage error before any dispatch.

## Parallelization Notes

- Queue store and run-engine integration can proceed in parallel once the contracts are fixed.
- UI controls should wait for intervention result semantics to stabilize.

## Test And Verification Plan

- Queue durability tests across daemon restart
- State-machine tests for pause, resume, interrupt, and blocked states
- Manual verification of queue then steer then interrupt flows

## Rollout Order

1. Ship queue persistence and read-only queue visibility
2. Enable queue mutation and the orchestration-layer run-controls — interrupt, cancel, pause, resume (none capability-gated, I-004-10)
3. Enable steer where driver capabilities allow — `steer` and the campaign-B2 `rollback` intervention are this plan's two driver-capability-gated controls (rollback sequenced by campaign B9: daemon handler T3.12, provider-leg + file-restore T3.13, desktop gate T4.2, CLI command T4.7)

## Rollback Or Fallback

- Disable `steer` and `rollback` (this plan's two capability-gated controls — I-004-10 as amended; `rollback` added by campaign B9 via T3.12–T3.14 / T4.2 / T4.7) if driver-capability handling regresses; queue + the orchestration-layer controls (interrupt, cancel, pause, resume) stay enabled — they are not capability-gated (I-004-10). A rollback whose file-restore leg cannot proceed is handled **fail-closed within the intervention itself**, so no plan-level fallback is needed: for a writable live root an unavailable snapshot or a failed HEAD precondition **rejects the whole intervention pre-dispatch** (no leg applied), and an execution-time restore failure after the confirmed conversation leg records `files-unrestored` / `files-partially-restored` (T3.13); `conversation-only` is confined to the two Spec-004 cases — `read-only` mode and a released execution root — never a general file-leg-unavailable degradation.

## Risks And Blockers

- Provider capability mismatch can produce misleading controls
- Queue concurrency across multiple clients needs strict daemon serialization

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

**Round 2 (Codex on 8e6583a) — 10 findings, all fixed in one commit.**

- **F1 (contracts):** `RollbackInterventionResult` restructured from the four-literal `fileRestore` into a `disposition` discriminated union spanning the full `Spec-004 §Required Behavior` vocabulary — file-leg (`files-restored` / `files-partially-restored` (+`failedStep`) / `files-unrestored` / `conversation-only`) plus the pre-file arms (`pause-only`, `nothing-applied`, `position-mismatch` (+`requestedPosition`/`confirmedPosition`)); never-collapse preserved; T1.3 mirror + T4.7 rendering updated.
- **F2 (contracts):** root-`busy` reclassified as pre-dispatch whole-rejection, not `files-unrestored`; the `files-unrestored` comment now names execution-time refusal causes only (the HEAD re-verify) and drops "root busy".
- **F3 (contracts):** `InterventionRequestResponse` discriminated per intervention type — a `rollback` outcome that fails `RollbackInterventionResult` parse fails validation, never falling through to the generic `Record<string, unknown>` arm; test added.
- **F4 (T4.7):** explicit result-state→POSIX-exit contract added (`applied`→0; `rejected`/`expired`/`degraded`→distinct nonzero) alongside the transport `JsonRpcErrorCode` mapper; the static `driver.capability_unsupported` refusal rides the **result** as `rejected` carrying the new `rejectionReason` field, not the transport channel; per-state test.
- **F5 (T3.11):** the "typed stamp shape Plan-006-owned" phantom replaced by CP-004-12 — a named merge prerequisite for the owed Plan-006 epoch-attribution carrier + a dep-map Plan-004→Plan-006 edge; no Plan-006 symbol authored. **Lead-owned follow-up:** register the typed epoch-attribution field in Plan-006 / Spec-006 (the B11 Plan-006 bundle shipped without it).
- **F6 (T3.12):** the waiting-source void now names the durable actions — `approval.canceled` via Plan-012 `cancelPendingForRun` and `driver_ask.canceled` via its owning surface (both consumed, not authored), atomic with the rollback transition — plus the queued-resume void and the progression-serialized race; test added.
- **F7 (T3.13):** new `run.execution_root_released` (409, run state unchanged) added to `error-contracts.md §Run` as a Plan-004 extension (the Plan-027 error-contracts-extension precedent) and named in T3.13's non-resumable rule; test added.
- **F8 (T4.7):** `apps/cli/src/main.ts` added to T4.7 Files (EXTEND) with the Plan-007 ownership note (T-007r-3-2 CREATE; clipanion has no auto-discovery) + a dep-map §2 row + an invocation-through-real-`Cli` registration test.
- **F9 (fallback bullet):** reworded fail-closed — an unavailable snapshot / failed HEAD precondition rejects pre-dispatch and an execution-time failure records `files-unrestored` / `files-partially-restored`; conversation-only is confined to read-only mode + a released root.
- **F10 (T3.14):** the exported `supersededTurns(runId)` read seam named + CP-004-13 + a dep-map Plan-013→Plan-004 consumer edge; no Plan-013 symbol authored. **Lead-owned follow-up:** the Plan-013 consumer task (`timeline-projector.ts` + `TimelineRead` calling the seam).

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
