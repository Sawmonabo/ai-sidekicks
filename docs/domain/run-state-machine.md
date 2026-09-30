# Run State Machine

## Purpose

Define the canonical lifecycle of a run so queueing, steering, pause and resume, approvals, interruption, rollback, and failure semantics are unambiguous.

## Scope

This document covers run states, transition rules, and the meaning of control actions against a run.

## Definitions

- `RunState`: the authoritative lifecycle state of a run.
- `BlockingState`: a non-terminal run state that requires external input before normal progress can continue.
- `TerminalState`: a run state from which the run does not continue on its own. Each exit keeps the same run id: a send into an `interrupted` run, which returns it to `running` with everything it knew; and a send into a finished child run's own steer box, which starts it again. `failed` has no exit.
- `RunFailureCategory`: a machine-readable classification that explains why a run failed or degraded without creating a new run state.
- `RecoveryCondition`: a derived signal that explains whether recovery still requires the person to act.

## What This Is

The run state machine defines the lifecycle semantics of execution.

## What This Is Not

- It is not a UI spinner model.
- It is not provider-specific lifecycle terminology.
- It is not a queue state model.
- It is not a separate taxonomy of extra run states for every failure cause.

## Invariants

- A run has exactly one current state at a time.
- Terminal emission is at most once per `(runId, runVersion)` ([Spec-005 §Run Lifecycle](../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle)). An undo's conversation cut advances `runVersion` and opens a new execution epoch — the interval between accepted `run.rolled_back` cuts — whether or not the files also went back, and it moves the run through no transition of its own (§Rollback Transitions; [Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)). A send that re-opens an `interrupted` or finished run (§Complete Transition Table) advances `runVersion` the same way, so the same at-most-once key holds across it; unlike a cut it rewinds nothing, opens no new epoch, and marks no turn superseded.
- `resume` is valid only from `paused`.
- Reattach after reconnect is not the same thing as `resume`.
- Waiting for approval or input keeps the same run id; it does not create a replacement run.
- A run's pending blocking work — a pending question, a pending permission ask or a pending pipeline approval request — grants the run a liveness exemption from the idle sweep for as long as the block stands, and no deadline bounds it: a question, an ask and an approval all wait until they are answered ([Spec-010 §Required Behavior](../specs/010-approvals-permissions-and-trust-boundaries.md#required-behavior)). The exemption ends the moment the block resolves or is closed with the run that raised it — the answer, the cancellation that rides an interrupt, or the end of the provider process — and a closed block never counts as pending blocking work, so the run returns to the ordinary idle path the instant it is no longer waiting on a person. The startup-reconciliation divergence halt (`waiting_for_input` carrying `recovery-needed`) is a human-action halt rather than a pending question, ask or approval, and is outside this rule by design ([Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior)).

## Relationships To Adjacent Concepts

- `QueueItem` may create a run in `queued` state.
- `Intervention` can alter a run's state when permitted.
- `Approval` and user input can unblock waiting states.
- `Artifact` publication can occur while a run is active or when it becomes terminal.

## State Model

| State | Meaning |
| --- | --- |
| `queued` | The run exists but has not yet been admitted to execution. |
| `starting` | The runtime is preparing provider, workspace, or execution state. |
| `running` | The run is actively executing. |
| `waiting_for_approval` | The run is blocked on an approval request. |
| `waiting_for_input` | The run is blocked on user input or structured answers. |
| `pausing` | A pause has been asked for and the step already in flight is still finishing. Nothing new starts, and the state is visible to a reader rather than internal. |
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
- `running -> waiting_for_input` (an agent's question recorded: the question handler that holds the provider's request open appends `question.asked` and moves the run in the same step — a Claude Code question, a Codex user-input request or a tool server's MCP elicitation alike)
- `running -> pausing` (the pause toggle; the step already in flight is still finishing)
- `pausing -> paused` (the step in flight landed)
- `pausing -> running` (the pause toggle pressed again, or a send, before the step in flight landed)
- `pausing -> interrupted` (an interrupt while the step in flight is finishing)
- `running -> interrupted`
- `running -> completed`
- `running -> failed`
- `waiting_for_approval -> running` (approval resolved; or a pending permission-ask's provider retraction, atomic with `approval.canceled`, no outcome delivered)
- `waiting_for_approval -> interrupted`
- `waiting_for_input -> running` (the question answered, the question handler moving the run back as it writes the answer's `user.message` row; or the question canceled — the provider withdrew its held request — with no answer delivered)
- `waiting_for_input -> interrupted`
- `paused -> running` (the pause toggle pressed again — `run.resume` — or a send)
- `paused -> interrupted`
- `interrupted -> running` (a send, or the messages that were waiting going as the next turn)
- `completed -> running` (a send into a finished child run's own steer box)
- `waiting_for_approval -> failed` (provider or transport failure while waiting)
- `waiting_for_input -> failed` (provider or transport failure while waiting)
- `paused -> failed` (resume handle lost or recovery exhausted)

## Recovery Transitions

During startup reconciliation the daemon detects runs left in non-terminal states after a crash or restart. The following recovery transitions apply:

- From `starting`, `running`, `waiting_for_approval`, `waiting_for_input`: the daemon may transition the run to `failed` if automatic recovery cannot safely resume execution.
- From `paused`: the daemon may transition the run to `failed` if the resume handle is lost and recovery is impossible.
- From any non-terminal state during recovery: the run transitions to `interrupted` if a pending user-initiated stop (interrupt or cancel intervention) was recorded before the crash; otherwise it transitions to `failed` when recovery cannot safely resume. On a resume that succeeds (`DriverResumeResult.status: 'resumed'`) the daemon compares the provider's reported session position with its own record, and nothing is decided on the person's behalf except the read-only case: where the two agree, the run goes on; where the provider is ahead only by steps that read, those steps are added to the transcript from the provider's own record, recorded as `run.recovery_steps_added`, and the run goes on as if the two had agreed; any other mismatch — the provider ahead by anything else, or the daemon ahead of the provider — is a divergence, which halts the run for human action in `waiting_for_input` per the divergence rows below ([Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior)). A crashed run is never replayed into a fresh session.

Decision rule — `interrupted` vs `failed` vs `waiting_for_input` during recovery:

- `interrupted`: the run had a pending user-initiated stop. The user's intent was to end the run; recovery honors that intent — this outcome takes precedence over the other two.
- `failed`: recovery itself fails with no prior user-initiated stop. The run did not end on its own terms.
- `waiting_for_input`: recovery resumed the provider session and found a divergence; the local log is authoritative, and the person answers one question whose choices are worded for which record is ahead (`recovery-needed` — [Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior)). The answer travels as `run.recoveryResolve`, is recorded as `run.recovery_resolved`, and ends the halt through the ordinary rows out of `waiting_for_input`; the choice that goes back to the last point both records agree on is an undo's conversation cut and file restore (§Rollback Transitions).

## Rollback Transitions

An undo that takes the conversation back ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)) cuts the provider's conversation with the provider's own verb and records the cut as a forward `run.rolled_back` event on the run whose history it cut ([Spec-005 §Run Lifecycle](../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle)). The cut is not a state transition, and an undo adds none. Before the cut, the undo stops the agents and commands started after the point, and what it does to the run is what any stop does:

- A run that is `running`, `pausing` or `paused` has its turn ended exactly as an interrupt ends it (`running -> interrupted`, `pausing -> interrupted`, `paused -> interrupted`); the undo is never refused because a turn is running.
- A run `waiting_for_approval` or `waiting_for_input` is interrupted the same way, and the approval or question it held is canceled with it.
- A run already `completed`, `interrupted` or `failed` keeps its state.

The next send — the edited message of an edit and resend included, which goes at once — starts from the cut conversation through the ordinary transitions. A cut advances `runVersion` and opens a new execution epoch (§Invariants), so a run-lifecycle event sourced from the execution before the cut and delivered after it never transitions the machine: it is absorbed at ingestion ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)'s epoch gate), and the at-most-one-terminal rule counts only events the machine accepts. An undo of the files alone cuts nothing and appends no `run.rolled_back`. The authoritative log never truncates or rewrites: turns after the point stay queryable history, marked superseded by projection only when the conversation went back ([ADR-017](../decisions/017-shared-event-sourcing-scope.md)). Where the session works changes nothing here: the checkpoints an undo reads are held with the session outside the checkout ([Spec-013 §Required Behavior](../specs/013-persistence-recovery-and-replay.md#required-behavior)).

## Complete Transition Table

The following table lists every allowed run state transition. It includes primary transitions, the failure paths added above, and recovery transitions.

| From | To | Trigger | Condition |
| --- | --- | --- | --- |
| `queued` | `starting` | Run admitted to execution | Queue slot available |
| `starting` | `running` | Initialization complete | Provider and workspace ready |
| `starting` | `failed` | Initialization error | Provider or workspace setup cannot complete |
| `starting` | `interrupted` | Interrupt or cancel intervention | User-initiated stop while run setup is in progress or parked (e.g. blocked-in-setup per [Spec-008 §Fallback Behavior](../specs/008-worktree-lifecycle-and-execution-modes.md#fallback-behavior)) |
| `running` | `waiting_for_approval` | Approval requested | Run requires explicit approval before continuing |
| `running` | `waiting_for_input` | Input requested | Run requires user input or structured answers |
| `running` | `pausing` | Pause toggle pressed | The step already in flight is still finishing and nothing new starts ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)) |
| `pausing` | `paused` | The step in flight landed | Nothing is running; the run continues later from exactly where it stopped, with nothing repeated |
| `pausing` | `running` | The pause toggle pressed again, or a send | Pressed before the step in flight landed; the run goes on from where it is, with nothing repeated ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)) |
| `pausing` | `interrupted` | Interrupt or cancel intervention | User-initiated stop while the step in flight is finishing — an interrupt stays available throughout a pause — or an undo ending the turn (§Rollback Transitions) |
| `running` | `interrupted` | Interrupt or cancel intervention | User-initiated stop, or an undo ending the running turn (§Rollback Transitions) |
| `running` | `completed` | Execution finished | Run reaches successful terminal condition |
| `running` | `failed` | Unrecovered error | Provider, transport, or internal error during execution |
| `waiting_for_approval` | `running` | Approval resolved | Resolution outcome (approved or rejected) delivered to the run; a rejected outcome continues the run with the action refused — it does not terminate the run (Spec-010); an approval never settles on its own, so there is no time-based arm to this row (Spec-010 §Required Behavior) |
| `waiting_for_approval` | `running` | Provider ask retraction | The provider withdrew its still-pending permission ask on the live leg — its approval request settles `approval.canceled` (no resolution row) at once, and the run resumes with no outcome delivered in the same atomic pass (Plan-010 T2.8's cancel ingress) |
| `waiting_for_approval` | `interrupted` | Interrupt or cancel intervention | User-initiated stop while waiting — which cancels the approval the run was holding open, the cancellation recorded (Spec-010 §Required Behavior) — or an undo, which cancels it the same way (§Rollback Transitions) |
| `waiting_for_approval` | `failed` | Provider or transport failure | Failure occurs while run is blocked on approval |
| `waiting_for_input` | `running` | Question answered | The person answered the question: the question handler writes the answer as an ordinary `user.message` row and moves the run back in the same step. A question waits until it is answered, so nothing reaches this row on elapsed time (Spec-010 §Required Behavior) |
| `waiting_for_input` | `running` | Question canceled | The provider withdrew its still-held request on the live leg — the question handler settles the question canceled and the run resumes with no answer delivered |
| `waiting_for_input` | `interrupted` | Interrupt or cancel intervention | User-initiated stop while waiting, or an undo, which cancels the question the run held (§Rollback Transitions) |
| `waiting_for_input` | `failed` | Provider or transport failure | Failure occurs while run is blocked on input |
| `paused` | `running` | The pause toggle pressed again (`run.resume`), or a send | Resume handle valid and provider ready; the run continues from exactly where it stopped with nothing repeated, and any messages that were waiting are delivered ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)) |
| `paused` | `interrupted` | Interrupt or cancel intervention | User-initiated stop while paused, or an undo (§Rollback Transitions) |
| `paused` | `failed` | Resume failure | Resume handle lost or recovery exhausted |
| `interrupted` | `running` | Send into the interrupted run | A user message — or the messages that were waiting going as the next turn — returns the run to `running` with everything it knew; nothing is rewound and no turn is marked superseded ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)) |
| `completed` | `running` | Send into a finished run | A send into a finished child run's own steer box starts it again on the same run id, its pause and interrupt coming back with it ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)) |
| `queued` | `failed` | Startup reconciliation | Recovery fails with no prior user-initiated stop |
| `queued` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `starting` | `failed` | Startup reconciliation | Recovery fails with no prior user-initiated stop |
| `starting` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `starting` | `running` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) at the daemon-recorded position — the equal-position attach in the pre-`running` crash window: provider and workspace re-confirmed ready, initialization resumes and completes |
| `starting` | `waiting_for_input` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the driver-reported session position diverges from the daemon-recorded position — the pre-`running` crash window: the provider session advanced before the `starting → running` transition was recorded; the local log is authoritative, the run halts for human action carrying `recovery-needed`, and the provider-ahead span classifies `unclassifiable` ([Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior)) |
| `running` | `failed` | Startup reconciliation | Recovery fails with no prior user-initiated stop |
| `running` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `running` | `waiting_for_input` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the driver-reported session position diverges from the daemon-recorded position — the local log is authoritative and the run halts for human action carrying `recovery-needed` ([Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior)) |
| `waiting_for_approval` | `failed` | Startup reconciliation | Recovery fails with no prior user-initiated stop |
| `waiting_for_approval` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `waiting_for_approval` | `waiting_for_input` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the driver-reported session position diverges from the daemon-recorded position — the local log is authoritative and the run halts for human action carrying `recovery-needed`; the pending approval is canceled as moot through its existing terminal, never left actionable against a diverged run ([Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior)) |
| `waiting_for_input` | `failed` | Startup reconciliation | Recovery fails with no prior user-initiated stop |
| `waiting_for_input` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `paused` | `failed` | Startup reconciliation | Resume impossible and no prior user-initiated stop |
| `paused` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `paused` | `waiting_for_input` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the driver-reported session position diverges from the daemon-recorded position — the local log is authoritative and the run halts for human action carrying `recovery-needed` ([Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior)) |

## Derived Failure And Recovery Signals

The canonical run lifecycle has one failure terminal state: `failed`. Additional labels describe why a run failed or whether recovery still needs action; they do not create extra run states.

| Signal Or Category | Meaning | Classification |
| --- | --- | --- |
| `recovery-needed` | Automatic recovery did not return the run to safe progress — or a driver-side integrity trip ended the run outright with the provider's client-side state possibly mutated ([Spec-004 §Required Behavior](../specs/004-provider-driver-contract-and-capabilities.md#required-behavior), the outbound-frame neutralization tripwire) — and the person must act. | Recovery condition, not `RunState` |
| `reauth-required` | Provider credentials or the provider session expired mid-run or during resume; re-authentication on the runtime node is required before recovery proceeds ([Spec-004 §Fallback Behavior](../specs/004-provider-driver-contract-and-capabilities.md#fallback-behavior) `RecoveryCondition`). | Recovery condition, not `RunState` |
| `provider failure` | The provider or driver could not safely start, continue, or resume the run. | Failure category, not `RunState` |
| `transport failure` | A required transport path failed independently of provider semantics. | Failure category, not `RunState` |
| `local persistence failure` | Canonical local storage was unavailable or inconsistent enough that recovery or safe mutation could not continue. | Failure category, not `RunState` |
| `projection failure` | Replay or projection rebuild could not produce trustworthy read state. | Failure category, not `RunState` |
| `refused` | The provider's safety check refused a turn and no other model could take it; the payload names the refusing model and carries the provider's words ([Spec-005 §Run Lifecycle](../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-run_lifecycle)). | Failure category, not `RunState` |

- Recovery is handled by startup reconciliation: on boot the daemon detects stale runs and dispatches corrective commands. There is no visible `recovering` state.
- If recovery cannot proceed safely, the run transitions to `failed`; failure detail may then carry one or more failure categories plus `recovery-needed` when intervention is still required. A resume that succeeds but reports a diverged session position instead halts for human action in `waiting_for_input` carrying `recovery-needed` — the divergence rows above; a run already recorded `waiting_for_input` stays in that state with the same condition attached, with no self-transition row — and its stale pre-crash input request is replaced by the `recovery-needed` reconciliation block plus the recorded span classification, never left masking the divergence, the replaced ask canceled as moot through its existing terminal, as an undo cancels the question a waiting run held (§Rollback Transitions) ([Spec-013 §Fallback Behavior](../specs/013-persistence-recovery-and-replay.md#fallback-behavior)).

## Example Flows

- Example: A queued implementation task is admitted, moves through `starting` to `running`, pauses for approval before a risky file write, returns to `running` after approval, and ends in `completed`.
- Example: A daemon restarts during execution. Startup reconciliation detects the stale run and dispatches corrective commands to resume or fail it.
- Example: A user stops an active run. The run transitions directly from `running` to `interrupted`.
- Example: A user cancels a run via `applyIntervention(type: "cancel")`. The cancel intervention maps to the `interrupted` terminal state — cancel is a user-initiated interruption distinct from queue-level `QueueItemCancel`.
- Example: A user presses `Undo to here` on a message whose run completed two turns later. The conversation and the files go back together to the moment before that message: the conversation by the provider's own cut, the files by the daemon's own checkpointer. A forward `run.rolled_back` event records the conversation cut alone; the run stays `completed` with a higher `runVersion`, and the turns after the point are marked superseded by projection. The undo's one result is stored as `session.restore_finished`, and the transcript reads `Restored to before <the message's first words>`. The user's next send starts from the cut conversation.

## Child-Run Behavior

Child runs are **independent intervention targets**: a parent state change never automatically propagates to children. This follows [Spec-014 §Intervention Propagation](../specs/014-multi-agent-orchestration.md#intervention-propagation) — "A pause, interrupt, or steer applied to a parent run does not auto-cascade to its child runs. Each child run is an independent intervention target." The user acts on children explicitly via the same intervention surfaces as any run (Plan-003), using the `run_links` projection (`orchestration.childRunLinkRead`) to enumerate them.

| Parent State | Child-Run Effect |
| --- | --- |
| `interrupted` | No automatic effect. Children keep their current state; each child is interrupted explicitly if the user wants the subtree stopped. |
| `failed` | No automatic effect. Children keep running; the parent's death does not invalidate work the children were spawned to do. |
| `paused` | No automatic effect. Pausing a parent pauses only the parent; children are paused individually if needed. |
| `completed` | Child runs continue to completion. They were spawned for a reason and are allowed to finish. |
| `waiting_for_approval` | Child runs continue running. The parent blocking on approval does not block children. |
| `waiting_for_input` | Child runs continue running. The parent blocking on input does not block children. |

The runtime adds no depth limit of its own to run nesting — how deep agents may nest is the provider's own limit under the person's own provider settings, and a provider's refusal is shown in its own words ([Spec-014 §Default Behavior](../specs/014-multi-agent-orchestration.md#default-behavior)): a child run may create children of its own, so a "subtree" is every run beneath the parent at any depth, and each row of the table above holds at every level.

## Edge Cases

- A run may fail from `starting` if workspace or provider initialization cannot complete.
- Pause is an orchestration-layer construct the daemon owns and does not require driver capability support: it is made true by the provider's own hooks where the provider has them and by a boundary interrupt where it does not, and the run's state is persisted; the second press of the toggle, or a send, continues it, and no resume event is queued ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)). See ADR-011.
- Interruption is a synchronous or near-synchronous provider call. There is no intermediate `interrupting` state; runs transition directly to `interrupted`. Pause is the opposite case and does have one: `pausing` stands while the step already in flight finishes, because the person can see that the pause has not landed yet.
- A run may be `failed` with `provider failure` detail after an unsuccessful resume attempt; provider-specific failure causes do not create separate run states.
- A run may be `failed` with visible `recovery-needed` condition after automatic recovery is exhausted; failed recovery remains visible through failure detail and recovery condition rather than a separate terminal run state.

## Implementation Note

Implementation uses a hybrid approach: XState v5 for internal transition logic and guard validation (with Stately Studio visualization), TypeScript discriminated union for the public API (compile-time state narrowing).

Validation against the complete transition table:

- All transitions are deterministic: a given trigger combined with its guard condition produces exactly one target state. No ambiguous transitions exist.
- Guards required: version checks for interventions (ensuring stale interventions do not apply), recovery eligibility checks (determining whether a stale run can be safely resumed or must fail), and child-run independence guards (ensuring no code path auto-propagates a parent state change to children — non-cascade per §Child-Run Behavior).
- No self-transitions or history states are required. Every transition moves the run to a different state (an undo's conversation cut is not a transition — the position change rides the forward `run.rolled_back` event, §Rollback Transitions).
- The complete transition table is expressible in both XState v5 (as an explicit transition map with guard functions) and as a TypeScript discriminated union (where each state variant enumerates its valid next states at compile time).

## Related Specs

- [Queue Steer Pause Resume](../specs/003-queue-steer-pause-resume.md)
- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Persistence Recovery And Replay](../specs/013-persistence-recovery-and-replay.md)

## Related ADRs

- [Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
