# Run State Machine

## Purpose

Define the canonical lifecycle of a run so queueing, steering, pause and resume, approvals, interruption, rollback, and failure semantics are unambiguous.

## Scope

This document covers run states, transition rules, and the meaning of control actions against a run.

## Definitions

- `RunState`: the authoritative lifecycle state of a run.
- `BlockingState`: a non-terminal run state that requires external input before normal progress can continue.
- `TerminalState`: a run state from which the run does not continue under normal forward execution. The only exit is the `rollback` intervention (§Rollback Transitions, campaign B2), which re-opens the same run at an earlier position.
- `RunFailureCategory`: a machine-readable classification that explains why a run failed or degraded without creating a new run state.
- `RecoveryCondition`: a derived signal that explains whether recovery still requires operator or participant action.
- `RunHealthSignal`: a derived signal such as `stuck-suspected` that helps operators reason about a live run without changing the canonical `RunState`.

## What This Is

The run state machine is the source of truth for execution lifecycle semantics.

## What This Is Not

- It is not a UI spinner model.
- It is not provider-specific lifecycle terminology.
- It is not a queue state model.
- It is not a separate taxonomy of extra run states for every failure cause.

## Invariants

- A run has exactly one current state at a time.
- A run enters at most one terminal state per execution epoch — the interval between accepted `run.rolled_back` rewinds: a confirmed conversation rewind advances the epoch regardless of the file-leg disposition, so a `degraded`-but-confirmed rollback opens a new epoch exactly like an `applied` one ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior); campaign B2). A rollback out of a terminal state re-opens the run, and any later terminal event carries a higher `runVersion`, so the at-most-once terminal emission keyed on `(runId, runVersion)` ([Spec-006 §Run Lifecycle](../specs/006-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle), campaign B1) is preserved across epochs. Absent rollback, a run enters exactly one terminal state.
- `resume` is valid only from `paused`.
- Reattach after reconnect is not the same thing as `resume`.
- Waiting for approval or input keeps the same run id; it does not create a replacement run.
- A liveness exemption granted for a run's pending driver ask (the idle sweep's pending-blocking-work hard-skip) is **expiry-bounded**: it ends the moment the ask expires or resolves — `driver_ask.expired` closes the exemption together with the ask, and an expired ask never counts as pending blocking work — so an unanswered ask is a bounded wait, never an indefinite shield against reaping ([Spec-012 §Required Behavior](../specs/012-approvals-permissions-and-trust-boundaries.md#required-behavior)'s decoupled-but-coordinated rule; campaign B13).

## Relationships To Adjacent Concepts

- `QueueItem` may create a run in `queued` state.
- `Intervention` can alter a run's state when permitted.
- `Approval` and participant input can unblock waiting states.
- `Artifact` publication can occur while a run is active or when it becomes terminal.

## State Model

| State | Meaning |
| --- | --- |
| `queued` | The run exists but has not yet been admitted to execution. |
| `starting` | The runtime is preparing provider, workspace, or execution state. |
| `running` | The run is actively executing. |
| `waiting_for_approval` | The run is blocked on an approval request. |
| `waiting_for_input` | The run is blocked on participant input or structured answers. |
| `paused` | The run has been intentionally suspended and can later continue with the same run id. |
| `completed` | The run finished successfully. |
| `interrupted` | The run ended because of an interrupt or cancel path. |
| `failed` | The run ended because of an unrecovered error. |

Primary allowed transitions:

- `queued -> starting`
- `starting -> running`
- `starting -> failed`
- `starting -> interrupted`
- `running -> waiting_for_approval`
- `running -> waiting_for_input` (approval-pipeline input block; live driver input-ask opened, atomic with its `driver_ask.requested` append — campaign B13)
- `running -> paused`
- `running -> interrupted`
- `running -> completed`
- `running -> failed`
- `waiting_for_approval -> running` (approval resolved; or a pending permission-ask's provider retraction, atomic with `driver_ask.canceled`, no outcome delivered — campaign B13)
- `waiting_for_approval -> interrupted`
- `waiting_for_input -> running` (input supplied; a driver input-ask's delivered answer, atomic with `driver_ask.responded` — campaign B13; provider retraction, atomic with `driver_ask.canceled`, no input delivered — campaign B13)
- `waiting_for_input -> interrupted`
- `paused -> running`
- `paused -> interrupted`
- `waiting_for_approval -> failed` (provider or transport failure while waiting)
- `waiting_for_input -> failed` (provider or transport failure while waiting)
- `paused -> failed` (resume handle lost or recovery exhausted)
- `waiting_for_approval -> paused` (rollback intervention — campaign B2)
- `waiting_for_input -> paused` (rollback intervention — campaign B2; driver input-ask expiry — Spec-012 Part-B fail-closed follow-up, 2026-07-17)
- `completed -> paused` (rollback intervention; the only exit from a terminal state — campaign B2)
- `interrupted -> paused` (rollback intervention; the only exit from a terminal state — campaign B2)
- `failed -> paused` (rollback intervention; the only exit from a terminal state — campaign B2)

## Recovery Transitions

During startup reconciliation the daemon detects runs left in non-terminal states after a crash or restart. The following recovery transitions apply:

- From `starting`, `running`, `waiting_for_approval`, `waiting_for_input`: the daemon may transition the run to `failed` if automatic recovery cannot safely resume execution.
- From `paused`: the daemon may transition the run to `failed` if the resume handle is lost and recovery is impossible.
- From any non-terminal state during recovery: the run transitions to `interrupted` if a pending user-initiated stop (interrupt or cancel intervention) was recorded before the crash; otherwise it transitions to `failed` when recovery cannot safely resume, or — on a resume that succeeds (`DriverResumeResult.status: 'resumed'`) but reports a session position diverged from the daemon-recorded position — halts for human action in `waiting_for_input` per the divergence rows below (`Spec-015 §Fallback Behavior`, campaign B5).

Decision rule — `interrupted` vs `failed` vs `waiting_for_input` during recovery:

- `interrupted`: the run had a pending user-initiated stop. The user's intent was to end the run; recovery honours that intent — this outcome takes precedence over the other two.
- `failed`: recovery itself fails with no prior user-initiated stop. The run did not end on its own terms.
- `waiting_for_input`: recovery resumed the provider session but the reported position diverged from the daemon-recorded position; the local log is authoritative and a human decides how to reconcile (`recovery-needed` — `Spec-015 §Fallback Behavior`, campaign B5).

## Rollback Transitions (campaign B2)

The `rollback` intervention ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior) — R8 run time-travel, V1 feature #19) rewinds a run to an earlier turn boundary within the same run id. Rollback is legal from `paused`, `waiting_for_approval`, `waiting_for_input`, and the three terminal states, and a conversation-leg-confirmed rollback lands the run in `paused` at the rewound position — a non-confirming conversation leg applies no rewind: a pause-first `running` source rests `paused` (its internal pause already applied), every other source keeps its state ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)'s no-rewind path; the confirmed-leg paragraph below):

- From `paused`: rollback applies in place — the run stays `paused` at the new position. No self-transition row exists (§Implementation Note); the position change is carried by the forward `run.rolled_back` event, not a state transition.
- From `waiting_for_approval` / `waiting_for_input`: a conversation-leg-confirmed rollback voids the pending block — the awaited approval or input request is canceled as moot when the turn that raised it is rewound, never at admission or dispatch — and the run transitions to `paused`; a non-confirming conversation leg leaves the block pending and the run in its waiting state (the transition-table rows carry the same gate).
- From `completed` / `interrupted` / `failed`: rollback is the only exit from a terminal state. The run re-opens in `paused`; any later terminal event carries a higher `runVersion` (§Invariants). The terminal exit had released the run's execution root (workspace `busy` → `ready` — [Spec-010 §State And Data Implications](../specs/010-worktree-lifecycle-and-execution-modes.md#state-and-data-implications)), so a terminal-source rollback first re-acquires it; a root `busy` under another run refuses the whole intervention pre-dispatch ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)), and the re-opened run holds the root again — re-acquisition **reactivates the run's durable execution context** (the terminal exit had stamped `run_execution_contexts.released_at`; the rollback's durable commit clears it atomically with the re-open, so active-root provenance never reports a live `paused` run as released), while every path that does not confirm the conversation rewind releases the re-acquired hold and restores the release marker — the run stays terminal and the workspace returns to `ready` (same Spec-004 contract). A run whose root no longer exists (disposed ephemeral clone, retired worktree) rolls back **conversation-only** and skips re-acquisition — there is no root to hold — per the same Spec-004 contract; such a re-opened run is **non-resumable**: the `paused → running` resume is guarded on a live execution root, and a resume against a released, root-less context is refused with a typed error — re-execution is a fresh run through normal admission, never an activation against a nonexistent root ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)).
- From `running`: not directly legal — the orchestration layer first pauses the run (the existing pause path: interrupt + persist), then applies rollback from `paused` (pause-first, [Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)); the pause is an unguarded internal sub-step of the atomic rollback application, whose `expectedRunVersion` guard was evaluated once at admission against the pre-pause version. Every fail-closed pre-dispatch validation completes **before** the pause sub-step — a refused rollback of a `running` run leaves it running, untouched — and the internal pause queues **no resume event**; a queued resume already pending against the run is canceled as moot at application (`Spec-004 §Required Behavior`).

Every rollback whose **conversation leg is confirmed** appends a forward `run.rolled_back` event ([Spec-006 §Run Lifecycle](../specs/006-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle)), advances `runVersion`, and lands the run in `paused` — **including a rollback whose file leg subsequently fails**: the intervention outcome reports the partial state, but the run state follows the confirmed conversation rewind, because recording anything else would silently diverge the daemon's position from the provider's ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)). A state-changing rollback (terminal-exit or waiting-void) emits the `run.paused` state event for its transition alongside `run.rolled_back`; an in-place rollback from `paused` emits only `run.rolled_back` (no transition to record). The authoritative log never truncates or rewrites, and rolled-back turns stay queryable history marked superseded by projection ([ADR-017 Decision Log, 2026-07-02](../decisions/017-shared-event-sourcing-scope.md#decision-log)). A run-lifecycle event sourced from the **pre-rollback execution epoch** — delivered after the run re-opened — never transitions the machine: it is absorbed at ingestion ([Spec-004 §Required Behavior](../specs/004-queue-steer-pause-resume.md#required-behavior)'s epoch gate), so the at-most-one-terminal-per-epoch invariant (§Invariants) counts only events the machine accepts.

## Complete Transition Table

The following table is the single authoritative reference for every allowed run state transition. It includes primary transitions, the failure paths added above, and recovery transitions.

| From | To | Trigger | Condition |
| --- | --- | --- | --- |
| `queued` | `starting` | Run admitted to execution | Queue slot available |
| `starting` | `running` | Initialization complete | Provider and workspace ready |
| `starting` | `failed` | Initialization error | Provider or workspace setup cannot complete |
| `starting` | `interrupted` | Interrupt or cancel intervention | User-initiated stop while run setup is in progress or parked (e.g. blocked-in-setup per `Spec-010 §Fallback Behavior` — Tier-6 audit) |
| `running` | `waiting_for_approval` | Approval requested | Run requires explicit approval before continuing |
| `running` | `waiting_for_input` | Input requested | Run requires participant input or structured answers |
| `running` | `paused` | Pause intervention | User or orchestration initiates pause |
| `running` | `interrupted` | Interrupt or cancel intervention | User-initiated stop |
| `running` | `completed` | Execution finished | Run reaches successful terminal condition |
| `running` | `failed` | Unrecovered error | Provider, transport, or internal error during execution |
| `waiting_for_approval` | `running` | Approval resolved | Resolution outcome (approved, rejected, or expired) delivered to the run; a rejected or expired outcome continues the run with the action refused — it does not terminate the run (Spec-012 — Tier-6 audit); exception: a denied pre-turn moderation gate (`category: 'gate'`) does not continue — Plan-016's moderation gate system-cancels it with `trigger: 'moderation_denied'` (Spec-016 D-016-10), exiting via the interrupt row below |
| `waiting_for_approval` | `running` | Provider ask retraction | The provider withdrew its still-pending permission ask on the live leg — `driver_ask.canceled` settles at once, the associated approval request settles `approval.canceled` (no resolution row) in the same atomic pass, and the run resumes with no outcome delivered (Plan-012 T2.8's cancel ingress, campaign B13) |
| `waiting_for_approval` | `interrupted` | Interrupt or cancel intervention | User-initiated stop while waiting, or the system-cancel of a denied pre-turn moderation gate (`trigger: 'moderation_denied'` — Spec-016 D-016-10) |
| `waiting_for_approval` | `failed` | Provider or transport failure | Failure occurs while run is blocked on approval |
| `waiting_for_input` | `running` | Input received | Valid participant input received, or a blocking `user_input` / `mcp_elicitation` approval-category request resolves — rejected/expired outcomes continue-with-refusal (Spec-012, CP-012-5 seam); a driver input-ask expiry never takes this row — it takes the park row below (Spec-012 Part-B fail-closed follow-up, 2026-07-17) |
| `waiting_for_input` | `running` | Provider ask retraction | The provider withdrew its still-pending input ask on the live leg — `driver_ask.canceled` settles at once and the run resumes with no input delivered (Plan-012 T2.8's cancel ingress, campaign B13) |
| `waiting_for_input` | `interrupted` | Interrupt or cancel intervention | User-initiated stop while waiting |
| `waiting_for_input` | `failed` | Provider or transport failure | Failure occurs while run is blocked on input |
| `paused` | `running` | Resume intervention | Resume handle valid and provider ready |
| `paused` | `interrupted` | Interrupt or cancel intervention | User-initiated stop while paused |
| `paused` | `failed` | Resume failure | Resume handle lost or recovery exhausted |
| `waiting_for_approval` | `paused` | Rollback intervention | Conversation-leg-confirmed rollback voids the pending approval block (`approval.canceled`) and rewinds to the confirmed position (`targetPosition` bar a position-mismatch degrade); the run lands `paused` (§Rollback Transitions, campaign B2) |
| `waiting_for_input` | `paused` | Rollback intervention | Conversation-leg-confirmed rollback voids the pending input block (`driver_ask.canceled`) and rewinds to the confirmed position (`targetPosition` bar a position-mismatch degrade); the run lands `paused` (§Rollback Transitions, campaign B2) |
| `waiting_for_input` | `paused` | Driver input-ask expiry | The pending `kind: 'input'` driver ask timed out (`driver_ask.expired`) — no input is fabricated; the run parks in its ordinary resumable `paused` state, driven by the daemon's ask-expiry path, never the approval-outcome seam ([Spec-012 §Resolved Questions and V1 Scope Decisions](../specs/012-approvals-permissions-and-trust-boundaries.md#resolved-questions-and-v1-scope-decisions), Part-B fail-closed follow-up 2026-07-17) |
| `completed` | `paused` | Rollback intervention | Terminal-exit rollback re-opens the run at the confirmed position (`targetPosition` bar a position-mismatch degrade); any later terminal event carries a higher `runVersion` (§Rollback Transitions, campaign B2) |
| `interrupted` | `paused` | Rollback intervention | Terminal-exit rollback re-opens the run at the confirmed position (`targetPosition` bar a position-mismatch degrade); any later terminal event carries a higher `runVersion` (§Rollback Transitions, campaign B2) |
| `failed` | `paused` | Rollback intervention | Terminal-exit rollback re-opens the run at the confirmed position (`targetPosition` bar a position-mismatch degrade); any later terminal event carries a higher `runVersion` (§Rollback Transitions, campaign B2) |
| `queued` | `failed` | Startup reconciliation | Recovery fails with no prior user-initiated stop |
| `queued` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `starting` | `failed` | Startup reconciliation | Recovery fails with no prior user-initiated stop |
| `starting` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `running` | `failed` | Startup reconciliation | Recovery fails with no prior user-initiated stop |
| `running` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `running` | `waiting_for_input` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the driver-reported session position diverges from the daemon-recorded position — the local log is authoritative and the run halts for human action carrying `recovery-needed` (`Spec-015 §Fallback Behavior`, campaign B5) |
| `waiting_for_approval` | `failed` | Startup reconciliation | Recovery fails with no prior user-initiated stop |
| `waiting_for_approval` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `waiting_for_approval` | `waiting_for_input` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the driver-reported session position diverges from the daemon-recorded position — the local log is authoritative and the run halts for human action carrying `recovery-needed` (`Spec-015 §Fallback Behavior`, campaign B5) |
| `waiting_for_input` | `failed` | Startup reconciliation | Recovery fails with no prior user-initiated stop |
| `waiting_for_input` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `paused` | `failed` | Startup reconciliation | Resume impossible and no prior user-initiated stop |
| `paused` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `paused` | `waiting_for_input` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the driver-reported session position diverges from the daemon-recorded position — the local log is authoritative and the run halts for human action carrying `recovery-needed` (`Spec-015 §Fallback Behavior`, campaign B5) |

## Derived Failure And Recovery Signals

The canonical run lifecycle has one failure terminal state: `failed`. Additional labels describe why a run failed or whether recovery still needs action; they do not create extra run states.

| Signal Or Category | Meaning | Classification |
| --- | --- | --- |
| `stuck-suspected` | The run appears active but has exceeded progress thresholds without reaching a valid blocking or terminal state. | Derived run-health signal, not `RunState` |
| `recovery-needed` | Automatic recovery did not return the run to safe progress and operator or participant action is required. | Recovery condition, not `RunState` |
| `reauth-required` | Provider credentials or the provider session expired mid-run or during resume; re-authentication on the runtime node is required before recovery proceeds ([Spec-005 §Fallback Behavior](../specs/005-provider-driver-contract-and-capabilities.md#fallback-behavior) `RecoveryCondition`, campaign B3). | Recovery condition, not `RunState` |
| `provider failure` | The provider or driver could not safely start, continue, or resume the run. | Failure category, not `RunState` |
| `transport failure` | A required transport path failed independently of provider semantics. | Failure category, not `RunState` |
| `local persistence failure` | Canonical local storage was unavailable or inconsistent enough that recovery or safe mutation could not continue. | Failure category, not `RunState` |
| `projection failure` | Replay or projection rebuild could not produce trustworthy read state. | Failure category, not `RunState` |

- Recovery is handled by startup reconciliation: on boot the daemon detects stale runs and dispatches corrective commands. There is no visible `recovering` state.
- If recovery cannot proceed safely, the run transitions to `failed`; failure detail may then carry one or more failure categories plus `recovery-needed` when intervention is still required. A resume that succeeds but reports a diverged session position instead halts for human action in `waiting_for_input` carrying `recovery-needed` — the divergence rows above; a run already recorded `waiting_for_input` stays in that state with the same condition attached, with no self-transition row — and its stale pre-crash input request is replaced by the `recovery-needed` reconciliation block plus the recorded span classification, never left masking the divergence (`Spec-015 §Fallback Behavior`, campaign B5; replacement emphasis campaign B14).

## Example Flows

- Example: A queued implementation task is admitted, moves through `starting` to `running`, pauses for approval before a risky file write, returns to `running` after approval, and ends in `completed`.
- Example: A daemon restarts during execution. Startup reconciliation detects the stale run and dispatches corrective commands to resume or fail it.
- Example: A user stops an active run. The run transitions directly from `running` to `interrupted`.
- Example: A user cancels a run via `applyIntervention(type: "cancel")`. The cancel intervention maps to the `interrupted` terminal state — cancel is a user-initiated interruption distinct from queue-level `QueueItemCancel`.
- Example: A completed run is rolled back via `applyIntervention(type: "rollback")`. The run re-opens in `paused` at `targetPosition` with a forward `run.rolled_back` event appended (plus the `run.paused` state event for the `completed → paused` transition) and later turns marked superseded by projection; the user steers, resumes, and the run completes again — the second `run.completed` carries a higher `runVersion` (campaign B2).

## Child-Run Behavior

Child runs are **independent intervention targets**: a parent state change never automatically propagates to children. This table was rewritten at the Tier-6 audit (Plan-016 A-016-17) to align with [Spec-016 §Intervention Propagation](../specs/016-multi-agent-channels-and-orchestration.md#intervention-propagation) — "A pause, interrupt, or steer applied to a parent run does not auto-cascade to its child runs. Each child run is an independent intervention target." — which postdates this document's original auto-cascade table (the Spec-016 V1-readiness review is the later ruling, and per `Spec-016 §ADR Triggers` an auto-cascade default would require a new ADR against ADR-011). Participants act on children explicitly via the same intervention surfaces as any run (Plan-004), using the `run_links` projection (`orchestration.childRunLinkRead`) to enumerate them.

| Parent State | Child-Run Effect |
| --- | --- |
| `interrupted` | No automatic effect. Children keep their current state; each child is interrupted explicitly if the participant wants the subtree stopped. |
| `failed` | No automatic effect. Children keep running; the parent's death does not invalidate work the children were spawned to do. |
| `paused` | No automatic effect. Pausing a parent pauses only the parent; children are paused individually if needed. |
| `completed` | Child runs continue to completion. They were spawned for a reason and are allowed to finish. |
| `waiting_for_approval` | Child runs continue running. The parent blocking on approval does not block children. |
| `waiting_for_input` | Child runs continue running. The parent blocking on input does not block children. |

V1 run nesting is depth-1 (`Spec-016 §Default Behavior`): a child run cannot create its own children, so "subtree" is always a flat set of direct children.

## Edge Cases

- A run may fail from `starting` if workspace or provider initialization cannot complete.
- Pause is an orchestration-layer construct (interrupt + persist + queue resume) that does not require driver capability support. See ADR-011.
- Interruption is a synchronous or near-synchronous provider call. There is no intermediate `interrupting` state; runs transition directly to `interrupted`.
- A run may be `failed` with `provider failure` detail after an unsuccessful resume attempt; provider-specific failure causes do not create separate run states.
- A run may be `failed` with visible `recovery-needed` condition after automatic recovery is exhausted; failed recovery remains visible through failure detail and recovery condition rather than a separate terminal run state.

## Implementation Note

Implementation uses a hybrid approach: XState v5 for internal transition logic and guard validation (with Stately Studio visualization), TypeScript discriminated union for the public API (compile-time state narrowing).

Validation against the complete transition table:

- All transitions are deterministic: a given trigger combined with its guard condition produces exactly one target state. No ambiguous transitions exist.
- Guards required: version checks for interventions (ensuring stale interventions do not apply), recovery eligibility checks (determining whether a stale run can be safely resumed or must fail), rollback state-gating guards (legal source states per §Rollback Transitions with pause-first for `running` — campaign B2), and child-run independence guards (ensuring no code path auto-propagates a parent state change to children — non-cascade per §Child-Run Behavior; Tier-6 audit, Plan-016 A-016-17).
- No self-transitions or history states are required. Every transition moves the run to a different state (a rollback applied from `paused` is not a transition — the run stays `paused` and the position change rides the forward `run.rolled_back` event, §Rollback Transitions).
- The complete transition table is expressible in both XState v5 (as an explicit transition map with guard functions) and as a TypeScript discriminated union (where each state variant enumerates its valid next states at compile time).

## Related Specs

- [Queue Steer Pause Resume](../specs/004-queue-steer-pause-resume.md)
- [Session Event Taxonomy And Audit Log](../specs/006-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/015-persistence-recovery-and-replay.md)

## Related ADRs

- [Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
