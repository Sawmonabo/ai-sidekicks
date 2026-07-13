# Spec-004: Queue Steer Pause Resume

| Field | Value |
| --- | --- |
| **Status** | `review` |
| **NNN** | `004` |
| **Slug** | `queue-steer-pause-resume` |
| **Date** | `2026-04-14` |
| **Author(s)** | `Codex` |
| **Depends On** | [Run State Machine](../domain/run-state-machine.md), [Queue And Intervention Model](../domain/queue-and-intervention-model.md), [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md), [Shared Session Core](../specs/001-shared-session-core.md) |
| **Implementation Plan** | [Plan-004: Queue Steer Pause Resume](../plans/004-queue-steer-pause-resume.md) |

> **Amendment (2026-07-13, capability-enhancement campaign B2 — amends the previously-`approved` spec; the header is flipped to `review` for the amendment's review window per the audit runbook's spec-amendment rule, and the campaign plan's Task 28 batch re-promotion restores `approved` after the W1.5 spec gate; dependent plans' code dispatch stays census-gated on that restoration).** This bundle lands two coordinated changes; each affected section carries the normative text in place. (1) **Post-interrupt late-event absorption (P1-8)**: a provider **run-lifecycle** event arriving for a run already in a terminal state is **absorbed, never appended** — a terminal-class straggler routes into the at-most-once terminal emitter ([Spec-006 §Run Lifecycle](006-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle), campaign B1) and no-ops; a non-terminal lifecycle straggler is dropped from the lifecycle path and recorded only as a `run.late_event.absorbed` diagnostic **non-event** — no state transition, no `runVersion` advance; non-lifecycle families (usage telemetry foremost) append normally (§Required Behavior). (2) **The `rollback` intervention type (R8 run time-travel — V1 feature #19 per [ADR-015](../decisions/015-v1-feature-scope-definition.md))**: `applyIntervention('rollback', {targetPosition})` rides the existing generic dispatch — [ADR-011](../decisions/011-generic-intervention-dispatch.md) is cited as designed-for-this ("new intervention types require no interface change"; zero ADR amendment) — with the mandatory fail-closed `expectedRunVersion` guard and the 6-state `InterventionResult`; state-gated with pause-first for `running` targets; modeled as a **forward** `run.rolled_back` event per the [ADR-017 Decision Log, 2026-07-02](../decisions/017-shared-event-sourcing-scope.md#decision-log) (the authoritative log never truncates); conversation leg via the [Spec-005](005-provider-driver-contract-and-capabilities.md) `rollbackTo` parity operation (campaign B3), file leg via [Spec-010 §Turn-Boundary Snapshots](010-worktree-lifecycle-and-execution-modes.md#turn-boundary-snapshots) (campaign B21); rolled-back turns stay in the timeline marked superseded by projection (§Required Behavior; §Interfaces And Contracts; §Driver-Level Rollback Mechanics; §Acceptance Criteria). Mirrors carried by this bundle because they are Spec-004 rollback content (landing them elsewhere would cite an unlanded amendment): the [Run State Machine](../domain/run-state-machine.md) rollback transitions + per-`runVersion`-epoch terminal invariant, the [Queue And Intervention Model](../domain/queue-and-intervention-model.md) `InterventionType`/payload extension, the [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) `InterventionRequestPayload` `rollback` union member, and the [Local SQLite Schema](../architecture/schemas/local-sqlite-schema.md) `interventions.type` CHECK. This amendment also records the two rollback-semantics rulings [Spec-010 §Turn-Boundary Snapshots](010-worktree-lifecycle-and-execution-modes.md#turn-boundary-snapshots) defers to this bundle: standing refusal when `HEAD` has advanced past the snapshot (whole-intervention rejection, never a silent partial restore), and conversation-only rollback for disposed ephemeral clones (§Required Behavior).

## Purpose

Define the canonical control semantics for queued work, active-run steering, pause and resume, and interrupt behavior.

## Scope

This spec covers queue admission, interventions, blocked states, and operator-visible control outcomes.

## Non-Goals

- Provider-specific transport details
- Workflow-level orchestration semantics
- Notification policy

## Domain Dependencies

- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)

## Architectural Dependencies

- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
- [Data Architecture](../architecture/data-architecture.md)
- [ADR-003: Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)

## Required Behavior

- Follow-up work created while a run is active must be stored as persisted queue items unless the user explicitly requests steer and the target run supports it.
- `pause` is an orchestration-layer construct: the daemon interrupts the active run, persists conversation history and run state, and queues a resume event. The resulting `paused` state must not mean queue-drain suspension or blocked waiting.
- `resume` must return a `paused` run to active execution with the same run id.
- `interrupt` must transition a run directly to `interrupted`. Interruption is a synchronous or near-synchronous provider call with no intermediate state.
- Waiting for approval or input must remain `waiting_for_approval` or `waiting_for_input`, not `paused`.
- Every intervention outcome must be visible in the canonical event stream.
- Queue items must support cancellation before admission.
- **Post-interrupt late-event absorption (campaign B2, P1-8).** A provider **run-lifecycle** event — a run-state-transition report — that arrives for a run already in a terminal state (`completed`, `interrupted`, `failed`) is **absorbed, never appended**: a terminal-class straggler routes into the at-most-once terminal emitter ([Spec-006 §Run Lifecycle](006-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle) emission contract, campaign B1) and no-ops there; a non-terminal lifecycle straggler is dropped from the lifecycle path entirely and recorded only as a `run.late_event.absorbed` **diagnostic non-event** on the daemon's telemetry (an OTel log record per [Observability Architecture](../architecture/observability-architecture.md) — never a `session_events` row), with no state transition and no `runVersion` advance. Absorption is scoped to the run-lifecycle family: non-lifecycle provider events arriving in the same window — usage telemetry above all, plus assistant output, tool activity, and artifact publication — append normally under their own families' rules (late usage telemetry must still reach the cost ledger; absorption never drops billable usage). The near-synchronous interrupt hedge above is the _reason_ the window exists — a provider may emit briefly after the daemon records the terminal; canonical-stream visibility of the intervention outcome is satisfied by the terminal event itself, and absorption adds no second visible outcome.
- **Rollback intervention (campaign B2 — R8 run time-travel, V1 feature #19 per [ADR-015](../decisions/015-v1-feature-scope-definition.md)).** `rollback` is a first-class intervention type on the existing generic dispatch: `applyIntervention('rollback', {targetPosition})`, carrying the same mandatory fail-closed `expectedRunVersion` guard and mandatory `clientIdempotencyKey` as every intervention (§Interfaces And Contracts) — a rollback racing a progressing run expires exactly like a stale steer. `targetPosition` is the **normalized session position** (a `number`, the [Spec-005](005-provider-driver-contract-and-capabilities.md) `rollbackTo` position vocabulary) identifying the turn boundary to rewind to; the accepted intervention's value serializes identically onto the forward `run.rolled_back` event ([Spec-006 §Run Lifecycle](006-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle) per-type row — this contract is that row's named structural-type owner). **State-gated:** legal from `paused`, `waiting_for_approval`, `waiting_for_input`, and the three terminal states; a `running` target is first brought to `paused` via the existing orchestration-layer pause path (interrupt + persist), and rollback applies from `paused` — the pause is an **unguarded internal sub-step of the atomic rollback application**, not a client `run.pause` request: the intervention's `expectedRunVersion` guard is evaluated **exactly once, at admission**, against the caller-observed pre-pause `runVersion` (the internal pause's own progression cannot expire the very intervention that initiated it), and the intervention response returns the post-composition `runVersion`; rollback is the **only** path out of a terminal state ([Run State Machine §Rollback Transitions](../domain/run-state-machine.md#rollback-transitions-campaign-b2), this bundle). A rollback from a waiting state voids the pending block — the awaited approval or input request is canceled as moot when the turn that raised it is rewound (the approval reaches `approval.canceled`, a driver ask reaches `driver_ask.canceled` — Spec-006's existing terminals; the void mints no new event type). A concurrent resolution racing the rollback serializes on the run's progression: a resolution that applies first advances `runVersion`, so the in-flight rollback correctly expires; a rollback that applies first cancels the block, and the late resolution finds a canceled request and no-ops. **Same-run resurrection, not fork-new-run:** budgets, supersede-marking, and the `expectedRunVersion` guard are all run-scoped; a fork would orphan all three. Modeled as a **forward** `run.rolled_back` event on the authoritative log ([ADR-017 Decision Log, 2026-07-02](../decisions/017-shared-event-sourcing-scope.md#decision-log)): the log never truncates or rewrites, and rolled-back turns remain queryable history **marked superseded by projection**. Successful rollback lands the run in `paused` at the rewound position. Leg ordering is **fail-closed**: the file-leg restore precondition ([Spec-010 §Turn-Boundary Snapshots](010-worktree-lifecycle-and-execution-modes.md#turn-boundary-snapshots) — current `HEAD` must equal the snapshot's recorded first parent) is validated pre-dispatch, and a refusal rejects the whole intervention with no leg applied (this records the post-snapshot-commit ruling Spec-010's Restore bullet defers to this bundle: standing refusal, never rewind/revert of reviewable Spec-011 history and never a silent partial restore); the conversation leg (the driver's capability-gated `rollbackTo` parity operation, campaign B3) applies next — a driver failure ends the intervention with no file mutation; the file leg restores last, and a file-leg failure after a confirmed conversation rollback is surfaced as a **`degraded`** intervention outcome naming the partial state (conversation rewound, files unrestored) — never `applied`, which would hide the file-leg failure ([Queue And Intervention Model](../domain/queue-and-intervention-model.md): `degraded` is the lifecycle's partial-effect terminal, and `failed` is not an intervention state). The run-state consequence follows the **conversation leg**: once that leg is confirmed, the run's authoritative position has rewound, so the run lands `paused` at `targetPosition` and the forward `run.rolled_back` event is appended **even when the file leg then fails** — recording anything else would silently diverge the daemon's recorded position from the provider's. Replaying the same `clientIdempotencyKey` returns the recorded partial outcome (replay-or-conflict — never a re-execution); recovery is a **fresh** rollback intervention to the same `targetPosition`, which re-runs both legs. Runs whose mode snapshots nothing (`read-only`) and ephemeral-clone runs past disposal roll back **conversation-only** per Spec-010 §Retention/§Applicability, with the outcome recording the file-leg disposition ([Plan-004](../plans/004-queue-steer-pause-resume.md)'s rollback tasks — campaign B9 — own the typed outcome detail).

## Default Behavior

- The default follow-up behavior while a run is active is `queue`.
- Queue ordering default is FIFO within the target scheduling scope.
- If a driver does not support steer natively, the intervention must be rejected or degraded to a new queue item. Pause does not require driver support — it is an orchestration-layer run-control mutation (`run.pause` / `run.resume`), handled entirely by the daemon (interrupt + persist + queue a resume) and **not** dispatched through the driver-facing `applyIntervention` path that steer/interrupt/cancel follow ([ADR-011](../decisions/011-generic-intervention-dispatch.md); the driver never needs to know about pause — see [Queue And Intervention Model](../domain/queue-and-intervention-model.md)).

## Fallback Behavior

- If `steer` is requested against a run that cannot accept it, the system must either reject the intervention or explicitly degrade it to a new queue item.
- If a paused run cannot be resumed because driver state is lost, the system must transition it through recovery logic and then to `failed` or `interrupted`; it must not pretend the same run resumed.
- If queue persistence is temporarily unavailable, the system must reject new queue creation rather than silently storing queue state only in client memory.

## Interfaces And Contracts

- `QueueItemCreate`, `QueueItemList`, and `QueueItemCancel` must operate against runtime-owned durable state.
- `InterventionRequest` must include target run id, intervention type, and a **mandatory** version guard (`expectedRunVersion`). The guard is **fail-closed**: the comparand is required on every intervention, and an absent comparand is **rejected**, never applied — an optional guard would let a caller bypass stale-replay protection by omitting the field (Plan-004 D-004-2). `expectedRunVersion` is compared against the target run's `runVersion` — an **any-run-progression counter** that increments on every run progression, applied interventions included (not only `run.*` state-machine transitions), so two steers racing on a still-`running` run cannot both pass undetected (Plan-004 D-004-1). `runVersion` is the run aggregate's optimistic-concurrency token, distinct from the immutable `EventEnvelope.version` wire-contract field ([Spec-006 §EventEnvelope Version Semantics](006-session-event-taxonomy-and-audit-log.md#eventenvelope-version-semantics)). Payload fields vary by type: `steer` includes `expectedTurnId`, `content`, and optional `attachments`; `interrupt` and `cancel` include optional `reason`; `rollback` (campaign B2) includes a **mandatory** `targetPosition` — the normalized session position (a `number`, [Spec-005](005-provider-driver-contract-and-capabilities.md) `RollbackToParams.position` vocabulary) of the turn boundary to rewind to. Every intervention request additionally carries a **mandatory** requester-generated `clientIdempotencyKey` (UUID) — the second, orthogonal guard ([Spec-005 §Required Behavior](005-provider-driver-contract-and-capabilities.md), campaign B3): `expectedRunVersion` defeats stale replays of outdated intent, the key defeats duplicate applications of the same intent (replay-or-conflict, `intervention.idempotency_conflict`). See [Queue And Intervention Model](../domain/queue-and-intervention-model.md) for canonical payload shapes.
- `InterventionResult` must distinguish the 6 canonical intervention states: `requested`, `accepted`, `applied`, `rejected`, `degraded`, and `expired`. A version guard mismatch produces `expired`. An authorization failure produces `rejected`.
- Intervention dispatch uses `applyIntervention` (see [Spec-005](../specs/005-provider-driver-contract-and-capabilities.md) and [ADR-011](../decisions/011-generic-intervention-dispatch.md)), which routes to the appropriate driver-specific handler based on intervention type and declared capabilities. The Cedar `principal` for authorizing an intervention is the verified PASETO `sub` of the caller; `initiatorId` and any body-level actor fields are informational only. See [API Payload Contracts §Authenticated Principal And Authorization Model](../architecture/contracts/api-payload-contracts.md#authenticated-principal-and-authorization-model).
- **Rollback routing (campaign B2).** `rollback` is a full intervention on the client→daemon wire — the `InterventionRequestPayload` union in [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) carries a `rollback` member, and the request flows through the same authorization, `expectedRunVersion` guard, idempotency ledger, and `InterventionResult` lifecycle as every other type. At the driver boundary it does **not** ride `ApplyInterventionParams`: the conversation leg dispatches through the driver's dedicated, capability-gated `rollbackTo` parity operation ([Spec-005 §Interfaces And Contracts](005-provider-driver-contract-and-capabilities.md), campaign B3) — `RollbackToParams {sessionId, position}` returning `DriverRollbackResult` (`applied {sessionPosition, bindingId?}` | `degraded {fallbackAction?}`). A driver whose capabilities do not declare rollback support produces a **static refusal** (`driver.capability_unsupported`, the [Queue And Intervention Model §Driver Result To Lifecycle Mapping](../domain/queue-and-intervention-model.md#driver-result-to-lifecycle-mapping) no-documented-fallback carve-out) — there is no orchestration-layer emulation, because a synthesized rollback (replaying a truncated history into a fresh run) would violate same-run resurrection and silently fork budgets and supersede-marking.
- See [Queue And Intervention Model](../domain/queue-and-intervention-model.md) § Boundary: Interventions vs Interactive Requests for the steer/respondToRequest distinction.
- `RunStateChange` events must reflect the canonical state machine defined in `../domain/run-state-machine.md`.
- See [API Payload Contracts](../architecture/contracts/api-payload-contracts.md) for typed request/response schemas.
- See [Error Contracts](../architecture/contracts/error-contracts.md) for error response schemas and error codes.

## State And Data Implications

- Queue items require durable storage and ordering metadata.
- Interventions require durable audit records even when they fail.
- Blocked states must remain associated with the same run id and same event lineage.

## Example Flows

- `Example: A queued follow-up becomes a persisted QueueItem and is later steered into the active run.`
- `Example: A user pauses a long-running implementation run, later resumes it, and the run id remains unchanged throughout the pause cycle.`
- `Example: A run waits for approval. A second follow-up is queued but does not change the blocked run into paused state.`

## Driver-Level Steer Mechanics

- **Codex driver**: native `turn/steer` API — content is injected mid-conversation as a new user turn. The active generation is interrupted and the model continues from the steer content.
- **Claude driver**: no native steer support — degrades to queue + interrupt. The orchestration layer: (1) interrupts the active run (transitioning it to `interrupted`), (2) creates a new queue item with the steer content, (3) admits the queue item as a new run. The conversation history is preserved.
- **Generic driver fallback**: same as Claude (queue + interrupt).

### Steer Content Injection Point

- For native steer (Codex): content appears as a new user message in the conversation, immediately after the point of interruption. The model sees it as if the user sent a follow-up.
- For degraded steer (queue + interrupt): content becomes the initial message of the new run. Previous conversation history is loaded from the session event log.
- In both cases: steer content is marked with `source: 'steer'` in the event payload so the timeline can distinguish it from normal user messages.

The typed payload shapes for steer, interrupt, cancel, and rollback interventions are defined in [Queue And Intervention Model](../domain/queue-and-intervention-model.md) and verified against API contracts in that document's Field-Level Consistency section.

## Driver-Level Rollback Mechanics

- **Codex driver**: native `thread/rollback` (drop-N-turns). The protocol schema itself notes it does not revert local file changes — file restore is always the daemon's leg, below. `thread/rollback` is upstream-deprecated beyond the `0.141.0` pin: [Plan-005](../plans/005-provider-driver-contract-and-capabilities.md)/[Plan-010](../plans/010-worktree-lifecycle-and-execution-modes.md) MUST re-verify the method or its replacement against the then-installed binary before driver code lands ([ADR-017 Decision Log, 2026-07-02](../decisions/017-shared-event-sourcing-scope.md#decision-log)).
- **Claude driver**: native composed — `--resume-session-at <message-uuid>` + `--fork-session`, with the driver running `--replay-user-messages` so message-UUID rewind targets appear on the wire; the driver owns the normalized-position → message-UUID translation. `--resume-session-at` is binary-probe-only (absent from the live CLI reference) and MUST equally be re-verified against the then-installed binary before load-bearing use (same ADR-017 row). The provider-level fork is **beneath the binding, not a run fork**: the daemon's run aggregate persists (same run id, same `runVersion` lineage, same budgets) and the driver mints a new binding for the same run — the established relaunch pattern ([Spec-005](005-provider-driver-contract-and-capabilities.md) `DriverResumeResult.bindingId`) — reporting it on `DriverRollbackResult.applied.bindingId?`, which the daemon persists as the run's live binding so every later per-binding operation (goal delivery, resume, steer) targets the post-fork session, never the dead pre-fork one; the field is absent on an in-place rollback (Codex). §Required Behavior's same-run resurrection invariant holds.
- **File restore** is the daemon's turn-snapshot git leg ([Spec-010 §Turn-Boundary Snapshots](010-worktree-lifecycle-and-execution-modes.md#turn-boundary-snapshots), campaign B21) — never the driver's, on either provider.
- **Confirmed floor**: `DriverRollbackResult`'s `applied` variant carries a REQUIRED driver-confirmed `sessionPosition` — the new authoritative recovery floor consumed by the [Spec-015](015-persistence-recovery-and-replay.md) resume position-compare (campaign B5/B14) — plus the optional `bindingId` above (present exactly when the mechanism minted a new binding). A successful rollback without a confirmed floor is structurally inexpressible.
- **Timeline presentation**: rolled-back turns are never deleted from `session_events`; projections mark them superseded (turn > post-rollback position of the accepted `run.rolled_back` event) so clients render the rewound history distinctly rather than dropping it.

## Implementation Notes

- Queueing and intervention logic must live in the daemon or equivalent runtime authority, not in the currently open client.
- UI affordances may be optimistic, but canonical run state changes must come from runtime truth.
- Capability-aware controls are required so unsupported operations do not masquerade as working.
- Pause is an orchestration-layer construct. The daemon interrupts the active run, persists conversation history and run state to local SQLite, and queues a resume. The driver never needs to know about pause.

## Pitfalls To Avoid

- Using client memory as the queue of record
- Calling reread or reattach semantics `resume`
- Treating waiting states as paused states
- Appending a late provider run-lifecycle event to a terminal run's timeline (the absorption rule exists precisely for this window) — or, inversely, absorbing non-lifecycle events the rule never covered (late usage telemetry is billable and must append)
- Treating rollback as log truncation — the authoritative log never truncates; rollback is a forward `run.rolled_back` event plus projection-level supersede marking

## Acceptance Criteria

- [ ] Follow-up work while a run is active is durably queued by default.
- [ ] Pause (orchestration-layer interrupt + persist + queue resume) and resume operate on the same run id and same run history.
- [ ] Unsupported intervention requests result in explicit `degraded` or `rejected` outcomes rather than silent behavior changes.
- [ ] A provider run-lifecycle event arriving for a run already terminal never appends a `session_events` row and never advances `runVersion`: a terminal-class straggler no-ops in the at-most-once terminal emitter; a non-terminal lifecycle straggler surfaces only as the `run.late_event.absorbed` OTel diagnostic. Non-lifecycle provider events in the same window (usage telemetry foremost) still append under their own families' rules.
- [ ] A `rollback` intervention from every legal source state — `paused`, `waiting_for_approval`, `waiting_for_input`, each terminal state, and `running` via the pause-first path (guard evaluated once at admission against the pre-pause `runVersion`) — lands the run in `paused` at `targetPosition` with a forward `run.rolled_back` event appended (plus the `run.paused` state event for state-changing sources; in-place from `paused` emits only `run.rolled_back`) and prior turns marked superseded by projection; a stale `expectedRunVersion` produces `expired` with no leg applied.
- [ ] Rollback leg ordering is fail-closed end to end: a [Spec-010](010-worktree-lifecycle-and-execution-modes.md) file-leg precondition refusal rejects the whole intervention with no leg applied; a file-leg failure after a confirmed conversation rollback surfaces as a `degraded` outcome naming the partial state while the run still lands `paused` at `targetPosition` with `run.rolled_back` appended (state follows the confirmed conversation leg); `read-only` and disposed-ephemeral-clone runs complete conversation-only with the file-leg disposition recorded on the outcome.

## ADR Triggers

- If the product stops using daemon-backed queue state, create or update `../decisions/003-daemon-backed-queue-and-interventions.md`.
- If the product changes how interventions are dispatched to drivers, create or update `../decisions/011-generic-intervention-dispatch.md`.

## Resolved Questions and V1 Scope Decisions

- No blocking open questions remain for v1.
- V1 decision: queue priority overrides are deferred. The first implementation uses canonical queue order plus explicit steer, pause, resume, and interrupt controls only.

## References

- [Run State Machine](../domain/run-state-machine.md)
- [Queue And Intervention Model](../domain/queue-and-intervention-model.md)
- [Component Architecture Local Daemon](../architecture/component-architecture-local-daemon.md)
