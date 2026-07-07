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

- [x] Paired spec is approved
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
| **I-004-3** | Request:dispatch:record cardinality is 1:1:1 — one `applyIntervention` call produces exactly one driver dispatch and exactly one durable record. | T2.4 |
| **I-004-4** | `target_run_id` is stable across `waiting` / `blocked` transitions — an intervention never silently retargets to a different run. | T1.4, T1.7, T3.3 |
| **I-004-5** | Queue admission is FIFO by `created_at ASC`; queue priority is excluded from admission ordering (Spec-004:124). | T2.2 |
| **I-004-6** | Run-state and queue-item transitions are monotonic — no backward transitions; terminal states are absorbing. | T2.3, T3.4, T3.5, T1.6 |
| **I-004-7** | Stale-replay version guard: a run-mutating client command — an intervention, `pause`, or `resume` — whose `expectedRunVersion` does **not equal** the current run version is rejected and applies nothing (an intervention transitions `requested → expired`; `pause` / `resume` reject the request with the run left untouched). **Any** mismatch fails closed — stale (older) _or_ anomalous-future — per Spec-004:64 ("a version guard mismatch produces `expired`"); a `<`-only guard would silently admit a future comparand no honest client can hold. **The version comparand is the any-run-progression counter (D-004-1); the guard authors the comparison _behavior_ and the version _derivation_ is fixed by the ratified D-004-1 semantics. The comparand is mandatory (D-004-2, covering interventions + pause/resume) — an absent `expectedRunVersion` is rejected, not skipped.** | T2.8, T3.4, T3.5 (read T1.7) |
| **I-004-8** | Intervention authorization uses the verified PASETO `sub` as the Cedar principal; any client-supplied `initiatorId` is informational only and never authoritative. | T2.5 |
| **I-004-9** | Runtime-truth: the daemon run-state stream is canonical; desktop run-controls render an optimistic projection that is reconciled to the daemon truth on every update. | T4.1, T4.3, T4.4 |
| **I-004-10** | Capability-gate: only `steer` is gated on the driver steer capability. `pause` / `resume` / `interrupt` / `cancel` are orchestration-layer (daemon-composed) and are **never** capability-gated. | T4.2 |
| **I-004-11** | Bridge-only: the `run-controls/` renderer subtree reaches daemon / control-plane state exclusively via `window.sidekicks`; it never imports `packages/runtime-daemon` or `packages/control-plane` directly. | T4.5 (= CP-004-5) |
| **I-004-12** | Setup-gate: a run transitions `starting -> running` only after every registered `RunSetupGate.assertRunReady` resolves; a gate refusal parks the run in `starting` (never a silent skip, never `running`), and registered `onRunTerminal` hooks fire exactly once at the run's terminal transition. (Tier-6 audit.) | T3.10 |

## Cross-Plan Obligations

| ID | Obligation | Direction | Tasks |
| --- | --- | --- | --- |
| **CP-004-1** | Driver capability flags + `DriverInterventionResult` (`applied` / `degraded`) | **Consume** from [Plan-005](./005-provider-driver-contract-and-capabilities.md) | T2.6, T2.7 |
| **CP-004-2** | `command_receipts` table — Plan-004 CREATEs the forward-declared table shell; Plan-015 OWNS its column semantics + read model | **Provide shell** to [Plan-015](./015-persistence-recovery-and-replay.md) | T1.5 |
| **CP-004-3** | `packages/contracts/src/runControl.ts` — new contract surface, no prior owner (verified against the ownership map) | **Create** | T1.1–T1.3, T1.6, T1.7 |
| **CP-004-4** | `run.*` method-name namespace (`run.queueList` / `run.queueCreate` / `run.queueCancel` / `run.intervene` / `run.pause` / `run.resume` / `run.subscribeState` / `run.subscribeQueue`) — wire contract registered in `api-payload-contracts.md §Method-Name Registry`. **The eight concrete strings are ratified (D-004-3).** | **Register** with [Plan-007](./007-local-ipc-and-daemon-control.md) | T4.1, T4.4 |
| **CP-004-5** | `run-controls/` renderer subtree consumes daemon / control-plane state only via `window.sidekicks` (Spec-023 bridge discipline) | **Honor** [Plan-023](./023-desktop-shell-and-renderer.md) | T4.5 (= I-004-11) |
| **CP-004-6** | `packages/runtime-daemon/src/session/run-engine.ts` — EXTEND the Plan-001-owned `session/` file with run-control state transitions (per the cross-plan-deps EXTEND convention) | **Extend** [Plan-001](./001-shared-session-core.md) | Phase 3 (T3.1–T3.10) |
| **CP-004-7** | `getRun(runId): { version, sessionId, state }` run-state read accessor — Plan-004 is the run-state-read **origin** (cross-plan-deps:249–250: Plan-015 / Plan-016 / Plan-017 all consume it) | **Provide (forward)** to Plan-015 / Plan-016 / Plan-017 | T1.7 |
| **CP-004-8** | `RunSetupGate` registration seam (`{ assertRunReady, onRunTerminal? }`, ordered array on `run-engine.ts`) + the `QueueItemCreateRequest.workspaceId?` run-binding carrier — Plan-004 ships the seam with zero gates; Plan-010's execution-root gate registers at Tier 6 (Tier-6 audit, 2026-06-10) | **Provide (forward)** to [Plan-010](./010-worktree-lifecycle-and-execution-modes.md) (reciprocal CP-010-9) | T3.10, T1.1 |
| **CP-004-9** | Approval run-blocking seam — Plan-012's approval-service provides `registerApprovalOutcomeListener({ onBlocking(runId, approvalRequestId, blockingState), onResolved(runId, approvalRequestId, outcome) })` + `cancelPendingForRun(runId, cause)`; the run-engine registers the listener at engine construction (same registration directionality as the CP-004-8 seam). `onBlocking` drives `running -> waiting_for_input` for `user_input` / `mcp_elicitation` categories and `running -> waiting_for_approval` for the other 7; `onResolved` returns the run to `running` — rejected/expired outcomes continue-with-refusal, never terminate (run-state-machine.md `waiting_for_approval -> running` row), except a denied pre-turn moderation gate (`category: 'gate'`), which Plan-016's moderation gate system-cancels with `trigger: 'moderation_denied'` (Spec-016 D-016-10); every terminal transition calls `cancelPendingForRun` so still-pending requests settle as `approval.canceled` (Spec-006:259; Tier-6 audit 2026-06-10, Plan-012 A-6/A-10) | **Consume** from [Plan-012](./012-approvals-permissions-and-trust-boundaries.md) (reciprocal CP-012-5) | Phase 3 (doc-only at this audit — Phase 3 unexecuted; listener registration + terminal-hook call land with the run-engine implementation) |
| **CP-004-10** | Orchestration queue-admission seam — Plan-016's orchestration-run-service composes **in-process** with the daemon queue-admission service after its own admission pipeline passes, passing the typed `OrchestrationRunLinkCarrier` ([api-payload-contracts §Plan-016](../architecture/contracts/api-payload-contracts.md)); the admission API returns the minted `RunId` alongside `queueItemId`; `run.queued` threads the carrier fields into its payload as optional additive fields (`{agentId?, parentRunId?, linkType?, internalHelper?, producingNodeId?}` plus the admission-resolved `effectiveRunConfig?`); independent of the carrier, the queue write stamps `admittedUnpricedCapCents?` (native-cap unpriced admissions only) + `admittedModelFamily?` (every admitted run) on EVERY provider run's `run.queued` — the ordinary `run.queueCreate` path stamps directly via **Plan-016's admission-stamp resolver** (the T2.3 family/pricing/`cost_cap` accessor set), which Plan-016 T2.3 wires into this queue-write seam as an EXTEND (Plan-004's own Phase-2 queue tasks carry no pricing/budget machinery — the ordinary-path stamp code lands with Plan-016 T2.3 and is gated on it); the orchestration path supplies the same resolver's values via the carrier — the durable replay sources for cost reservations, worst-case terminal debits, and as-of-admission family keying, never client-suppliable (campaign B6, Spec-016 §Cost Derivation And Absent-Cost Semantics) — Spec-006 §Run Lifecycle, Plan-016 D-016-3); the wire `run.queueCreate` never accepts the carrier (child-run creation goes through `orchestration.runCreate` only); the `run.completed` `trigger` value set gains `'turn_limit'` for Plan-016's turn-limit completion (D-016-8); Plan-016's system-initiated interventions (budget/idle/moderation) enter through an in-process entrypoint below the wire authz boundary with NULL-for-system actor + the standard `expectedRunVersion` reject-re-read-retry loop (D-016-7) | **Provide (forward)** to [Plan-016](./016-multi-agent-channels-and-orchestration.md) (reciprocal CP-016-7; Tier-6 audit, Plan-016 walk) | Phase 2 (doc-only at this audit — carrier threading lands with the queue-create implementation) |

## Ratified Design Decisions (Tier 5 audit, 2026-05-30)

The Tier-5 plan-readiness audit (NS-17) surfaced three open decisions; all three were ratified at the user-review pause and are folded here as the plan's design of record. The cross-cutting corpus amendments they entail (Spec-004 / Spec-006 version-derivation + emission; `api-payload-contracts.md §Method-Name Registry`; `error-contracts.md`) are executed at swap alongside this `approved → review` flip.

- **D-004-1 (was F-004-2-10) — `version` = any-run-progression counter.** The `expectedRunVersion` stale-replay guard (I-004-7 / T2.8) compares against a run `version` derived as an **any-run-progression counter** (reading (b)): it increments on every run progression — applied interventions included — not only on `run.*` state-machine transitions (reading (a)). **Rationale (the hardened call):** reading (a) fails to catch two steers racing on a still-`running` run (zero new `run.*` events → the second stale steer passes undetected); reading (b) closes that replay window. Plan-004 authors T1.7's accessor _shape_ and T2.8's guard _behavior_; the `version` _derivation_ follows this ratified semantics. Entails a Spec-004 / Spec-006 amendment defining the `version` field on the `run.*` payload + its increment/emission point (executed at swap).
- **D-004-2 (was F-004-2-06) — `expectedRunVersion` is mandatory (fail-closed).** The comparand is **required** on every intervention request (Spec-004:63 mandatory reading); the absent-comparand case is **rejected**, not applied. An optional comparand would let a caller bypass the stale-replay guard by omitting the field — the hardened reading fails closed. T2.8 authors the present-comparand guard; the absent case rejects. Entails a Spec-004 clarification (executed at swap).
  - **Scope extension (Tier-5 audit) — the mandatory comparand binds `run.pause` / `run.resume`, not only interventions.** The ratified `RunPauseRequest` / `RunResumeRequest` contracts (`api-payload-contracts.md:1355-1362`) carry the **same mandatory** `expectedRunVersion` guard, with `RunControlAck` echoing the advanced `runVersion` so the caller threads the fresh comparand forward. This **extends D-004-2 beyond its original intervention-only scope**: a stale `pause` replayed against a run that has since progressed is the identical replay hazard the guard exists to close, so the comparand fails closed the same way (T3.4 / T3.5 apply the T2.8 guard before composing). `pause` / `resume` remain **orchestration-layer run-control verbs, not interventions** — they hold no `InterventionType` (`steer | interrupt | cancel`) membership and are not serialized through the intervention queue (ADR-011) — so this is a deliberate cross-cutting extension of the mandatory-comparand obligation, recorded here and reflected in the `api-payload-contracts.md` run-control comment at swap.
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
  - **Spec coverage:** Spec-004 §Required Behavior — queue list/create/cancel
  - **Verifies invariant:** I-004-1
  - **Consumes:** `QueueItemState` enum (queued / admitted / superseded / canceled / expired) + branded `QueueItemId` / `RunId` / `SessionId` (in-package)
- **T1.2 — `InterventionRequestPayload` discriminated union** (`steer` | `interrupt` | `cancel`)
  - **Files:** `packages/contracts/src/runControl.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior — intervention request
  - **Verifies invariant:** I-004-4
  - **Consumes:** `RunId`, `InterventionType` (`'steer' | 'interrupt' | 'cancel'`)
- **T1.3 — `InterventionRequestResponse` (6 states) + `RunStateChangeEvent` (9 states)**
  - **Files:** `packages/contracts/src/runControl.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior — intervention result + run-state event
  - **Verifies invariant:** I-004-2
  - **Consumes:** `InterventionId` / `RunId`, `InterventionState` (requested / accepted / applied / rejected / degraded / expired), `RunState` (9-state), `RunFailureCategory` (**import** from the Plan-001 / Spec-006 taxonomy — do not redefine)
- **T1.4 — Migration: `queue_items` + `interventions` tables**
  - **Files:** `packages/runtime-daemon/src/migrations/00NN-queue-and-interventions.ts` (CREATE)
  - **Spec coverage:** Spec-004 §Storage — queue + intervention persistence
  - **Verifies invariant:** I-004-1, I-004-2, I-004-3, I-004-4
  - **Consumes:** local SQLite migration runner (Plan-001 substrate)
- **T1.5 — Migration: `command_receipts` table (forward-declared shell)**
  - **Files:** `packages/runtime-daemon/src/migrations/00NN-queue-and-interventions.ts` (EXTEND)
  - **Spec coverage:** _none_ — forward-declared shell; column semantics + read model owned by Plan-015 (no fabricated spec anchor, per anti-fabrication rule)
  - **Verifies invariant:** _none_ (structural shell only) — see CP-004-2
  - **Consumes:** local SQLite migration runner
- **T1.6 — `RunPauseRequest` / `RunResumeRequest` + `RunControlAck` (client-facing pause/resume trigger)**
  - **Files:** `packages/contracts/src/runControl.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior — pause/resume as orchestration triggers
  - **Verifies invariant:** I-004-6, I-004-7
  - **Consumes:** `RunId`, `RunState`. Authors the two request types `RunPauseRequest { targetRunId: RunId; expectedRunVersion: number }` and `RunResumeRequest { targetRunId: RunId; expectedRunVersion: number }` plus the shared `RunControlAck { runId: RunId; currentState: RunState; runVersion: number }`, matching `api-payload-contracts.md:1355-1369` byte-for-byte. Authored as **separate request types** (not an `InterventionType` member) because `pause` / `resume` are absent from `InterventionType` (`steer | interrupt | cancel`) by design (orchestration-layer, ADR-011) — the client needs a typed trigger distinct from `applyIntervention`. The **mandatory** `expectedRunVersion` carries the stale-replay guard (I-004-7; D-004-2 as extended to pause/resume).
- **T1.7 — Run-read accessor `getRun(runId): { version, sessionId, state }`**
  - **Files:** `packages/contracts/src/runControl.ts` (accessor contract, CREATE) + `packages/runtime-daemon/src/session/run-engine.ts` (thin read; engine populates run state in Phase 3)
  - **Spec coverage:** Spec-006:186 (`run.*` event payload `{ sessionId, runId, previousState, newState }`) — run state is event-sourced; no standalone `runs` table (ADR-001 / ADR-017)
  - **Verifies invariant:** I-004-7 (provides the version comparand for the stale-replay guard) — = CP-004-7 forward-provide
  - **Consumes:** `RunId`, `RunState`. `sessionId` + `state` are derivable from the Spec-006:186 projection. **`version` is the any-run-progression counter ratified as D-004-1** — this task authors the accessor _shape_; the `version` _derivation_ follows the ratified D-004-1 semantics.

### Phase 2 — Queue Admission and Serialized Intervention Application

**Goal:** Daemon-owned, serialized queue admission and the generic `applyIntervention` dispatcher with durable per-outcome records.

**Precondition:** Phase 1 contracts + migrations landed; D-004-1 ratified (T2.8 guard implements the any-run-progression version semantics).

#### Tasks

- **T2.1 (Q1) — Queue admission gate (fail-closed when persistence unavailable)**
  - **Files:** `packages/runtime-daemon/src/queue/queue-store.ts` (CREATE)
  - **Spec coverage:** Spec-004 §Failure + ADR-003:72 (block new queued work when persistence unavailable)
  - **Verifies invariant:** I-004-1
  - **Consumes:** QueueItem contracts (T1.1); error code `queue.persistence_unavailable` (F-004-2-07 — register in `error-contracts.md`)
- **T2.2 (Q2) — FIFO admission (`created_at ASC`; priority excluded)**
  - **Files:** `packages/runtime-daemon/src/queue/queue-store.ts` (EXTEND)
  - **Spec coverage:** Spec-004:124 — FIFO admission; priority excluded from ordering
  - **Verifies invariant:** I-004-5
  - **Consumes:** QueueItem store (T2.1)
- **T2.3 (Q3) — Pre-admission cancellation + supersede / expire transitions**
  - **Files:** `packages/runtime-daemon/src/queue/queue-store.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Queue Lifecycle (5-state queue item)
  - **Verifies invariant:** I-004-6
  - **Consumes:** `QueueItemState` (T1.1)
- **T2.4 (I1) — `applyIntervention` generic dispatch (ADR-011)**
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (CREATE)
  - **Spec coverage:** Spec-004 §Required Behavior + ADR-011 (generic dispatcher — `applyIntervention(type, payload)`)
  - **Verifies invariant:** I-004-3 (1:1:1 request:dispatch:record)
  - **Consumes:** `InterventionRequestPayload` (T1.2)
- **T2.5 (I2) — Authorization (Cedar principal = verified PASETO `sub`)**
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Authorization + ADR-012 (Cedar) + ADR-010 (PASETO `sub`)
  - **Verifies invariant:** I-004-8
  - **Consumes:** verified PASETO claims (from the Plan-001 / Plan-008 auth context); client `initiatorId` is informational only
- **T2.6 (I3) — Map `DriverInterventionResult` {`applied` | `degraded`} → 6-state**
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior — 6 intervention states
  - **Verifies invariant:** I-004-2
  - **Consumes:** `DriverInterventionResult` (Plan-005 driver contract — CP-004-1), `InterventionState` (T1.3)
- **T2.7 (I4) — Steer-no-capability degrades to queue + interrupt; durable audit every path**
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Degraded Behavior + Plan-005 capability checks
  - **Verifies invariant:** I-004-2
  - **Consumes:** driver capability flags (Plan-005 — CP-004-1)
- **T2.8 (I5) — Stale-replay version guard + per-outcome event**
  - **Files:** `packages/runtime-daemon/src/interventions/intervention-service.ts` (EXTEND)
  - **Spec coverage:** Spec-004:63 (`expectedRunVersion` stale-replay guard)
  - **Verifies invariant:** I-004-7
  - **Consumes:** T1.7 `getRun` accessor (reads current run version)
  - **Behavior (authored):** read current run version via `getRun(targetRunId)`; if `expectedRunVersion !== current` → transition `requested → expired`, apply nothing, and emit an `intervention.*` event `{ sessionId, interventionId, targetRunId, type, state, actor }`. The guard rejects **any** mismatch — stale (older) _or_ anomalous-future — per Spec-004:64 ("a version guard mismatch produces `expired`"); a `<`-only comparison would silently admit a future comparand no honest client can hold. **Comparand evaluated against the any-run-progression version semantics (D-004-1).** The absent-`expectedRunVersion` case is rejected (fail-closed) per D-004-2 (mandatory).

### Phase 3 — Run-Engine Orchestration (Interrupt / Pause / Resume / Recover)

**Goal:** Wire intervention outcomes into the 9-state run machine; compose pause/resume as orchestration (not a driver capability); deterministic restart recovery.

**Precondition:** Phase 2 intervention service landed. **EXTENDs the Plan-001-owned `session/run-engine.ts` (CP-004-6).**

#### Tasks

- **T3.1 (INTERRUPT) — Interrupt application** (`running → interrupted`)
  - **Files:** `packages/runtime-daemon/src/session/run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Run-State Transitions — interrupt; Spec-006 `run_lifecycle`
  - **Verifies invariant:** I-004-6
- **T3.2 (CANCEL) — Cancel application** (`running → interrupted`)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Run-State Transitions — cancel
  - **Verifies invariant:** I-004-6
  - **Note:** the cancel intervention maps the active run to the canonical `interrupted` run-terminal — cancel is a user-initiated interruption, distinct from T3.1's `interrupt` in actor/intent but **not** in run-terminal (per [run-state-machine.md](../domain/run-state-machine.md): "the cancel intervention maps to the `interrupted` terminal state … distinct from queue-level `QueueItemCancel`"; the run terminals are `completed` / `interrupted` / `failed` — there is no `canceled` run-state). `canceled` is a **`QueueItemState`** (queued / admitted / superseded / canceled / expired; T1.1), applied to queued items by the `QueueItemCancel` path (T2.3), never a run-terminal — this task transitions only the run.
- **T3.3 (WAIT-GUARD) — `waiting` / `blocked` guard (target_run_id stable)**
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Run-State Transitions — waiting / blocked
  - **Verifies invariant:** I-004-4
- **T3.4 (PAUSE) — Pause orchestration** (compose: interrupt + persist resumable state + enqueue resume marker — **not** driver-dependent)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Pause (orchestration-layer) + ADR-011
  - **Verifies invariant:** I-004-6, I-004-7
  - **Consumes:** T1.7 `getRun` accessor (reads current run version)
  - **Behavior (authored):** apply the **same** stale-replay version guard as T2.8 before composing the pause — read current run version via `getRun(RunPauseRequest.targetRunId)`; reject the request untouched if `RunPauseRequest.expectedRunVersion !== current` (Spec-004:64, mandatory per D-004-2 as extended to pause/resume); otherwise interrupt the active run, persist resumable state, enqueue the resume marker, and acknowledge via `RunControlAck { runId, currentState, runVersion }`.
- **T3.5 (RESUME) — Resume orchestration** (re-admit the **same** run id from persisted state)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Resume
  - **Verifies invariant:** I-004-4, I-004-6, I-004-7
  - **Consumes:** T1.7 `getRun` accessor (reads current run version)
  - **Behavior (authored):** apply the **same** stale-replay version guard as T2.8 before composing the resume — reject the request untouched if `RunResumeRequest.expectedRunVersion !== current` (Spec-004:64, mandatory per D-004-2 as extended to pause/resume); otherwise re-admit the **same** run id from persisted state and acknowledge via `RunControlAck { runId, currentState, runVersion }`.
- **T3.6 (RECOVER) — Deterministic restart recovery** (distinguish `failed` vs `interrupted` on daemon restart)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Recovery + Spec-006 replay
  - **Verifies invariant:** I-004-2, I-004-6
- **T3.7 (EMIT) — Emit `run.*` state-change events** (Spec-006 `run_lifecycle` taxonomy)
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-006:186 — `run.*` event payload
  - **Verifies invariant:** I-004-2
- **T3.8 (MAP) — Map intervention outcomes → run-state transitions**
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Required Behavior — outcome → run-state
  - **Verifies invariant:** I-004-6
- **T3.9 (STEER-ROUTE) — Route steer to driver (or degrade per T2.7)**
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-004 §Steer + Plan-005 capability
  - **Verifies invariant:** I-004-2
- **T3.10 (SETUP-GATE) — Run-setup gate seam: ordered pre-start gates + terminal release hooks (Tier-6 audit)**
  - **Files:** `run-engine.ts` (EXTEND)
  - **Spec coverage:** Spec-010 §Fallback Behavior (blocked-in-setup parks the run in `starting`, interruptible) + run-state-machine.md `starting` rows (`starting -> running` fires only after gates pass; `starting -> interrupted` on user stop while parked)
  - **Verifies invariant:** I-004-12
  - Note: `RunSetupGate` interface `{ assertRunReady(context): Promise<void>; onRunTerminal?(context): Promise<void> }` with an ordered gate array on the run-engine; context carries `{ runId, sessionId, queueItem }` (incl. the T1.1 `workspaceId?`). `queued -> starting` admits the run, then gates execute in registration order BEFORE `driver.startRun`; a gate throw parks the run in `starting` with the typed error surfaced (no `running` transition fires; interrupt/cancel per T3.1/T3.2 applies to parked runs). `onRunTerminal` hooks fire in reverse registration order when the run reaches any terminal state. Plan-004 ships the SEAM with zero registered gates — generic, no Plan-010 knowledge; Plan-010's execution-root gate registers at Tier 6 (Plan-010 D-010-16, reciprocal CP-010-9 — CP-004-8). Tests: gate registration order; gate-throw parks in `starting` with the typed error; zero-gate pass-through; reverse-order terminal hooks fire exactly once; interrupt-while-parked transitions to `interrupted`.

> **Tier-6 reciprocal (CP-004-9, doc-only):** when Phase 3 executes, the run-engine also registers Plan-012's approval outcome listener (`registerApprovalOutcomeListener` — blocking/unblocking transitions per the CP-004-9 row) and calls `cancelPendingForRun(runId, cause)` from the same terminal path that fires `onRunTerminal` hooks, so pending approval requests settle as `approval.canceled` instead of dangling (Plan-012 A-6/A-10).

> **Resolved at the Plan-016 walk (same Tier-6 audit):** child-run behavior on parent interrupt/cancel is **non-cascade** — children are independent intervention targets (Spec-016 §Run Hierarchy; run-state-machine.md §Child-Run Behavior as rewritten by Plan-016 A-016-17). No cascade logic is authored here or in Plan-016; `run_links` is owned by Plan-016 (Tier 6). (F-004-3-08 → closed by Plan-016 A-016-17.)

### Phase 4 — Desktop Run-Controls

**Goal:** The client SDK + renderer run-controls subtree — optimistic projection reconciled to daemon truth, capability-gated steer only, bridge-only.

**Precondition:** Phase 1–3 daemon surface landed; **D-004-3 (`run.*` method strings) ratified** before T4.1 / T4.4 wire calls land. Plan-023 renderer substrate + `window.sidekicks` bridge present.

#### Tasks

- **T4.1 — `runControlClient.ts` SDK (single daemon-transport factory)**
  - **Files:** `packages/client-sdk/src/runControlClient.ts` (CREATE)
  - **Spec coverage:** Spec-023:382 (daemon run-state / queue subscriptions) + Spec-004 §Client
  - **Verifies invariant:** I-004-9
  - **Transport (authored):** a single daemon-transport factory `createDaemonRunControlClient(transport)` riding `window.sidekicks.daemon.call` / `daemon.subscribe`. **Rationale:** run-control authority is daemon-only — ADR-003:26 ("the daemon will be the authority that applies and records their outcomes"), Assumption #3 (ADR-003:66), and no control-plane run-control surface exists in the corpus (verified). This **excludes** the `sessionClient.ts` dual-transport pattern; it structurally resembles `membershipClient.ts`'s daemon half (cross-plan-deps:378), but the rationale is the source fact, not the precedent.
  - **Consumes:** `window.sidekicks.daemon` bridge (Spec-023); the `run.*` method strings (CP-004-4 — ratified, D-004-3)
- **T4.2 — Capability-gated steer; pause/resume/interrupt/cancel NEVER gated**
  - **Files:** `apps/desktop/src/renderer/src/run-controls/` (CREATE)
  - **Spec coverage:** Spec-004 §Capability + ADR-011 (pause is orchestration, not a driver capability)
  - **Verifies invariant:** I-004-10
  - **Note:** the §Rollback "disable any false flag" line is a **trap** — only `steer` is gated on driver capability; `pause` / `resume` / `interrupt` / `cancel` are orchestration-layer and are never capability-gated.
- **T4.3 — Optimistic-vs-runtime-truth reconciliation**
  - **Files:** `apps/desktop/src/renderer/src/run-controls/` (EXTEND)
  - **Spec coverage:** Spec-023:382 (daemon run-state subscription)
  - **Verifies invariant:** I-004-9
  - **Consumes:** daemon run-state subscription — subscribe request shape follows the shipped `subscribePresence → { sessionId }` precedent (NS-29, cross-plan-deps:378)
- **T4.4 — Surface 9 run-states + 6 intervention-states**
  - **Files:** `apps/desktop/src/renderer/src/run-controls/` (EXTEND)
  - **Spec coverage:** Spec-004 (9 run + 6 intervention states); **use `failed`, not `errored`** — Spec-023:383 `errored` is non-canonical
  - **Verifies invariant:** I-004-9
  - **Consumes:** `RunState` / `InterventionState` (T1.3); `run.*` subscription channel names (CP-004-4 — ratified, D-004-3)
- **T4.5 — Bridge-bypass import-restriction**
  - **Files:** `apps/desktop/src/renderer/src/run-controls/` (EXTEND) + import-restriction assertion test
  - **Spec coverage:** Spec-023:356 (renderer composes via the preload bridge, never bypasses)
  - **Verifies invariant:** I-004-11 (= CP-004-5)
  - **Note:** enforces the cross-plan-deps:93 renderer bridge-discipline rule for the `run-controls/` subtree.
- **T4.6 — Test suite (SDK + orchestration + single-client renderer component tests)**
  - **Files:** `packages/client-sdk/**/*.test.ts` + daemon orchestration integration tests + `apps/desktop/src/renderer/src/run-controls/__tests__/*.test.tsx`
  - **Spec coverage:** Spec-004 §Test And Verification
  - **Verifies invariant:** covers I-004-9 / I-004-10 / I-004-11 at the SDK + orchestration + renderer-component layer
  - **Note:** single-client RTL renderer component tests ship **now**, mirroring the merged NS-29 `session-members/participant-roster.test.tsx` precedent (`@testing-library/react` `render`/`screen` + an `installMockBridge` `{ daemon: { call, subscribe } }` mock + the bridge-projection / no-direct-daemon-import assertion, per the `SessionBootstrap.test.tsx` idiom). Only the **multi-client live-run-state E2E** (cross-client daemon-stream reconciliation) defers — to the **Plan-023 Tier-8 IPC dispatcher**, _not_ BL-131 (which is Plan-003-scoped and whose "harness unavailable until Tier 8" premise NS-29 has already overtaken). SDK + orchestration tests are in-scope now.

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
3. Enable steer where driver capabilities allow — `steer` is the only driver-capability-gated control

## Rollback Or Fallback

- Disable `steer` (the only capability-gated control) if driver-capability handling regresses; queue + the orchestration-layer controls (interrupt, cancel, pause, resume) stay enabled — they are not capability-gated (I-004-10).

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

## Done Checklist

- [ ] Code changes implemented
- [ ] Tests added or updated
- [ ] Verification completed
- [ ] Related docs updated
