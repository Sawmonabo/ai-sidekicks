# Run State Machine

## Purpose

Define the canonical lifecycle of a run so queuing, steering, pause and resume, approvals, interruption, rollback, and failure semantics are unambiguous.

## Scope

This document covers run states, transition rules, and the meaning of control actions against a run.

## Definitions

- `Session`: the app's primary object, holding the lead and its helpers ([Session Model](session-model.md)).
- `Conversation`: the provider's own ongoing exchange with one agent (a Claude Code session, a Codex thread), idle between turns and never completed. The lead has one per session; a helper has its own.
- `Agent`: a lasting identity in the session, the lead or a helper keyed by its handle, with many runs over time ([Agent And Run Model](agent-and-run-model.md)).
- `Run`: one stretch of one agent's work, started by a send or a launch. It ends once, in `completed`, `failed` or `stopped`, and that end is final; an `interrupted` or `paused` run is not over, and a send continues it. A send to an agent whose run has ended starts a new run of the same agent on the same conversation, where the provider takes one.
- `Turn`: the provider's own unit, from one input it takes to the end it reports for that input (Codex's `turn/completed`, Claude Code's one `result` per turn). A run holds one turn or several: it continues after an interrupt or a pause, a turn is retried on another model, or the provider takes waiting messages as its next turn.
- `RunState`: the authoritative lifecycle state of a run.
- `BlockingState`: a non-terminal run state that requires external input before normal progress can continue.
- `TerminalState`: a run state from which the run does not continue on its own. Only `interrupted` has an exit: a send into it, or the waiting messages going as its next turn, returns it to `running` on the same run id with everything it knew. `completed`, `failed` and `stopped` are final, and a send to that agent starts its next run, where the provider takes one.
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
- Terminal emission is at most once per `(runId, runVersion)` ([Spec-005 §Run Lifecycle](../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-runlifecycle)). An undo's conversation cut advances `runVersion` and opens a new execution epoch — the interval between accepted `agent.run.rolledBack` cuts — whether or not the files also went back, and it moves the run through no transition of its own (§Rollback Transitions; [Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)). A send that continues an `interrupted` run (§Complete Transition Table) advances `runVersion` the same way, so the same at-most-once key holds across it; unlike a cut it rewinds nothing, opens no new epoch, and marks no turn superseded.
- Every turn that starts ends exactly once. Turn events sit beside the run's states and change none of them: the turn's start (`agent.turn.started`), then exactly one of `agent.turn.completed`, `agent.turn.interrupted` or `agent.turn.failed`, each carrying its `turnNumber` within its run. `agent.turn.interrupted` and `agent.turn.failed` carry an `origin`, which says who reported the turn's end, not who cut it: `provider` when the provider's own end frame arrived, `daemon` when the daemon wrote the end with no provider frame. They carry a `cause` where the daemon knows one: `processExit` when the daemon saw the provider process end, `daemonRestart` when a restart settled the turn, or the limit the person set that cut it, `stepLimit`, `spendLimit` or `tokenLimit`, with either origin. `agent.turn.completed` carries no origin, because only the provider reports a completion. A turn cut by a limit ends `agent.turn.interrupted` with that limit as its cause and its partial result kept: `origin: provider` when the provider's end frame arrived after the cut, `origin: daemon` when a restart settled the pending limit. A turn's word and its run's word may differ: a paused run's turn is interrupted. A provider's report of a turn's end that arrives after its run ended is written once as that turn's end and never changes the run.
- `resume` is valid from `pausing` or `paused`: the pause toggle pressed again, or a send, continues the run from exactly where it stopped.
- Reattach after reconnect is not the same thing as `resume`.
- Waiting for approval or input keeps the same run id; it does not create a replacement run.
- A run's pending blocking work — a pending question, a pending permission ask, a pending pipeline approval request, Claude Code's retry-or-edit choice on a refused turn or its switch-or-credits choice when a Fable turn needs usage credits — has no deadline: a question, an ask, an approval and the two choices all wait until they are answered ([Spec-010 §Required Behavior](../specs/010-approvals-permissions-and-trust-boundaries.md#required-behavior)). The block ends the moment it resolves or is closed with the run that raised it — the answer, the cancellation that rides an interrupt, or the end of the provider process. The startup-reconciliation divergence halt (`waitingForInput` carrying `recoveryNeeded`) is a human-action halt rather than a pending question, ask or approval, and ends only by the person's recovery action ([Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)).

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
| `waitingForApproval` | The run is blocked on an approval request. |
| `waitingForInput` | The run is blocked on user input or structured answers. |
| `pausing` | A pause has been asked for and the step already in flight is still finishing. Nothing new starts, and the state is visible to a reader rather than internal. |
| `paused` | The run has been intentionally suspended and can later continue with the same run id. |
| `completed` | The run finished successfully. |
| `interrupted` | The run's turn was cut by an interrupt — the person's, or one the daemon made itself at the step limit or the spend limit, because a workflow phase was canceled, or because a restart ended a child held in a pause or the turn of a run whose conversation the resume brought back, which carries its `trigger` — and the run rests until a send continues it on the same run id, or a newer run of the same agent supersedes it and it keeps `interrupted` as its last word. |
| `stopped` | The run was ended by a stop before its work was done, and it is final: a child that `Interrupt everything` or `Stop all running` reached on Claude Code, where the CLI refuses every later message to it, or any run at its token limit, which carries `trigger: tokenLimit`. A send to that agent starts its next run, where the provider takes one. |
| `failed` | The run ended because of an unrecovered error. |

Primary allowed transitions:

- `queued -> starting`
- `starting -> running`
- `starting -> failed`
- `starting -> interrupted`
- `running -> waitingForApproval`
- `running -> waitingForInput` (an agent's question recorded: the question handler that holds the provider's request open appends `question.asked` and moves the run in the same step — a Claude Code question, a Codex user-input request or a tool server's own MCP elicitation alike, while one marked `_meta.codex_approval_kind: "mcp_tool_call"` is Codex's approval of the call and goes to the approval card; or Claude Code's retry-or-edit choice on a refused turn, recorded as `agent.run.refusalChoice.requested`; or Claude Code's switch-or-credits choice when a Fable turn needs usage credits, recorded as `agent.run.usageCreditsChoice.requested`)
- `running -> pausing` (the pause toggle; the step already in flight is still finishing)
- `pausing -> paused` (the step in flight landed)
- `waitingForInput -> paused` (the restart question answered `keepProvider` or `continueProvider` on a run that was `paused` or `pausing` when the daemon stopped: it comes back paused, as the person left it)
- `pausing -> running` (the pause toggle pressed again, or a send, before the step in flight landed)
- `pausing -> interrupted` (an interrupt while the step in flight is finishing, or the session's spend limit, `trigger: spendLimit`)
- `running -> interrupted` (the person's interrupt, or the daemon's own at the step limit or the spend limit or because a workflow phase was canceled, carrying its `trigger`)
- `running -> completed`
- `running -> failed`
- `waitingForApproval -> running` (approval resolved; or a pending permission-ask's provider retraction, atomic with `approval.canceled`, no outcome delivered)
- `waitingForApproval -> interrupted` (an interrupt, or the session's spend limit, `trigger: spendLimit`)
- `waitingForInput -> running` (the question answered, the question handler moving the run back as it writes the answer's `user.message.sent` row; or the question canceled — the provider withdrew its held request — with no answer delivered; or the refusal choice answered `retryFallback`; or the usage-credits choice answered `switchDefault` or `consent`)
- `waitingForInput -> interrupted` (an interrupt or the session's spend limit, `trigger: spendLimit`; not while the refusal choice waits: an interrupt or an undo answers that choice `canceled`, and the run ends `failed`; while the usage-credits choice waits, an interrupt or an undo interrupts the turn and never answers the choice)
- `paused -> running` (the pause toggle pressed again — `agent.run.resume` — or a send)
- `paused -> interrupted`
- `interrupted -> running` (a send, or the messages that were waiting going as the next turn)
- `running -> stopped` and `interrupted -> stopped` (a Claude Code child, on `Interrupt everything` or `Stop all running`; the same press interrupts a Codex child)
- `running -> stopped`, `pausing -> stopped`, `paused -> stopped`, `waitingForApproval -> stopped` and `waitingForInput -> stopped` (the run's token limit, `trigger: tokenLimit`)
- `waitingForApproval -> failed` (provider or transport failure while waiting)
- `waitingForInput -> failed` (provider or transport failure while waiting; or the refusal choice answered `editPrompt` or `canceled`, the run ending with `failureCategory: 'refused'`)
- `paused -> failed` (resume handle lost or recovery exhausted)

## Recovery Transitions

During startup reconciliation the daemon detects runs left in non-terminal states after a crash or restart. The following recovery transitions apply:

- From `starting`, `running`, `waitingForApproval`, `waitingForInput`: the daemon may transition the run to `failed` if automatic recovery cannot safely resume execution.
- From `paused`: the daemon may transition the run to `failed` if the resume handle is lost and recovery is impossible.
- From any non-terminal state during recovery: the run transitions to `interrupted` if a pending user-initiated interrupt was recorded before the crash, or a pending interrupt the daemon made itself at the step limit or the spend limit, which keeps its `trigger`; to `stopped` with `trigger: tokenLimit` if the daemon's pending stop at the run's token limit was recorded; otherwise it transitions to `failed` when recovery cannot safely resume. On a resume that succeeds (`DriverResumeResult.status: 'resumed'`) the daemon compares the provider's record with its own by provider id at the grain of each step, and nothing is decided on the person's behalf except the read-only case: where the two agree, the run goes on from its state before the restart and what the provider holds of its turn: a run whose provider still runs its turn stays in its state, a queued run stays queued, a run whose turn the provider ended is left to the provider's own end, a paused run stays paused and a `pausing` run becomes `paused`, and a run whose turn ended with its process is `interrupted` with `trigger: 'daemonRestart'`, its open turns ended `agent.turn.interrupted` with `cause: daemonRestart` and its ask let go with it, resting until a send continues it (a child whose turn ended is `interrupted` in any state); where the provider is ahead only by steps that read, those steps are added to the transcript from the provider's own record, recorded as `agent.run.recoverySteps.added`, and the run goes on as if the two had agreed; any other mismatch — the provider ahead by anything else, or the daemon ahead of the provider — is a divergence, which halts the run for human action in `waitingForInput` per the divergence rows below, recorded as `agent.run.recovery.requested` ([Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)). A crashed run is never replayed into a fresh session.

Decision rule — `interrupted` or `stopped` vs `failed` vs `waitingForInput` during recovery:

- `interrupted` or `stopped`: the run had a pending stop — the person's interrupt, or the daemon's own at a limit, whose intervention records its reason. Recovery settles the run as that stop would have: `interrupted` for the person's, the step limit's or the spend limit's, with its `trigger`, and `stopped` with `trigger: tokenLimit` for the token limit's. Each open turn a limit's pending or carried-out interrupt names ends `agent.turn.interrupted` with `origin: daemon` and that limit as its `cause`, the higher-ranked one where two name the same turn, and every other open turn ends with `cause: daemonRestart`; a limit's stop whose interrupt was never recorded cut no turn. This outcome takes precedence over the others.
- `interrupted` with `trigger: 'daemonRestart'`: recovery resumed the conversation, the records agree, and the provider holds no turn of a run that was starting, running or waiting on an approval or the person's input, or of a child in any state. Each open turn ends `agent.turn.interrupted` with `origin: daemon` and `cause: daemonRestart`, except a turn a limit's interrupt names, which keeps that limit. A pending stop takes precedence.
- `failed`: recovery itself fails with no prior stop pending. The run did not end on its own terms, and each open turn ends `agent.turn.failed` with `origin: daemon` and `cause: daemonRestart`, except a turn a limit's interrupt names, which ends `agent.turn.interrupted` with that limit as its `cause`.
- `waitingForInput`: recovery resumed the provider session and found a divergence; the local log is authoritative, and the person answers one question whose choices are worded for which record is ahead (`recoveryNeeded` — [Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)). The question is recorded as `agent.run.recovery.requested`; the answer travels as `agent.run.recovery.resolve`, is recorded as `agent.run.recovery.resolved`, and ends the halt through the ordinary rows out of `waitingForInput`; the choice that goes back to the last point both records agree on is an undo's conversation cut and file restore (§Rollback Transitions).

## Rollback Transitions

An undo that takes the conversation back ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)) cuts the provider's conversation with the provider's own verb and records the cut as a forward `agent.run.rolledBack` event on the run whose history it cut ([Spec-005 §Run Lifecycle](../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-runlifecycle)). The cut is not a state transition, and an undo adds none. Before the cut, the undo stops the agents and commands started after the point, and what it does to the run is what any stop does:

- A run that is `running`, `pausing` or `paused` has its turn ended exactly as an interrupt ends it (`running -> interrupted`, `pausing -> interrupted`, `paused -> interrupted`); the undo is never refused because a turn is running.
- A run `waitingForApproval` or `waitingForInput` is interrupted the same way, and the approval or question it held is canceled with it. A run waiting on Claude Code's retry-or-edit choice on a refused turn has the choice answered `canceled`, as an interrupt answers it: the run ends `failed` with `failureCategory: 'refused'`, and the cut then removes the turn. A run waiting on Claude Code's switch-or-credits choice is interrupted with the choice never answered, as an interrupt leaves it: the turn ends `interrupted`, on Fable.
- A run already `completed`, `interrupted`, `stopped` or `failed` keeps its state.

The next send — the edited message of an edit and resend included, which goes at once — starts from the cut conversation through the ordinary transitions. A cut advances `runVersion` and opens a new execution epoch (§Invariants), so a run-lifecycle event sourced from the execution before the cut and delivered after it never transitions the machine: it is absorbed at ingestion ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)'s epoch gate), and the at-most-one-terminal rule counts only events the machine accepts. An undo of the files alone cuts nothing and appends no `agent.run.rolledBack`. The authoritative log never truncates or rewrites: turns after the point stay queryable history, marked superseded by projection only when the conversation went back ([ADR-016](../decisions/016-shared-event-sourcing-scope.md)). Where the session works changes nothing here: the checkpoints an undo reads are held with the session outside the checkout ([Spec-013 §Required Behavior](../specs/013-persistence-and-recovery.md#required-behavior)).

## Complete Transition Table

The following table lists every allowed run state transition. It includes primary transitions, the failure paths added above, and recovery transitions.

| From | To | Trigger | Condition |
| --- | --- | --- | --- |
| `queued` | `starting` | Run admitted to execution | The memory gate admits it |
| `starting` | `running` | Initialization complete | Provider and workspace ready |
| `starting` | `failed` | Initialization error | Provider or workspace setup cannot complete; a setup gate's failure carries `failureCategory: 'setupFailure'` and `failureCause: {cause: 'setupFailed'}` with the gate's own error |
| `starting` | `interrupted` | Interrupt intervention | User-initiated stop while run setup is in progress ([Spec-008 §Fallback Behavior](../specs/008-worktree-lifecycle-and-execution-modes.md#fallback-behavior)) |
| `running` | `waitingForApproval` | Approval requested | Run requires explicit approval before continuing |
| `running` | `waitingForInput` | Input requested | Run requires user input or structured answers, or Claude Code's retry-or-edit choice on a refused turn waits on the person (`agent.run.refusalChoice.requested`), or its switch-or-credits choice when a Fable turn needs usage credits does (`agent.run.usageCreditsChoice.requested`) |
| `running` | `pausing` | Pause toggle pressed | The step already in flight is still finishing and nothing new starts ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)) |
| `pausing` | `paused` | The step in flight landed | Nothing is running; the run continues later from exactly where it stopped, with nothing repeated |
| `waitingForInput` | `paused` | Restart question answered `keepProvider` or `continueProvider` | The run was `paused` or `pausing` when the daemon stopped, so the answer returns it paused, as the person left it, and it goes on only by the pause toggle or a send ([Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)) |
| `pausing` | `running` | The pause toggle pressed again, or a send | Pressed before the step in flight landed; the run goes on from where it is, with nothing repeated ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)) |
| `pausing` | `interrupted` | Interrupt intervention | User-initiated stop while the step in flight is finishing — an interrupt stays available throughout a pause — or an undo ending the turn (§Rollback Transitions) |
| `pausing` | `failed` | Unrecovered error | Provider, transport, or internal error while the step in flight is finishing |
| `running` | `interrupted` | Interrupt intervention | User-initiated stop, or an undo ending the running turn (§Rollback Transitions) |
| `running` | `interrupted` | Step limit reached | The turn reached `Max steps per turn` by the daemon's own count, on every provider; the run carries `trigger: stepLimit`, and its turn ends `agent.turn.interrupted` with `cause: stepLimit` and its partial result kept ([Spec-003 §The Step Bound On A Turn](../specs/003-queue-steer-pause-resume.md#the-step-bound-on-a-turn)) |
| `running` | `interrupted` | Spend limit reached | The first usage report past the session's spend limit; the run carries `trigger: spendLimit`, and its turn ends `agent.turn.interrupted` with `cause: spendLimit` and its partial result kept ([Spec-014 §Budget Policies](../specs/014-multi-agent-orchestration.md#budget-policies)) |
| `pausing` | `interrupted` | Spend limit reached | The same, while the step in flight is finishing |
| `waitingForApproval` | `interrupted` | Spend limit reached | The same while the run waits on an approval, which is canceled with the interrupt |
| `waitingForInput` | `interrupted` | Spend limit reached | The same while the run waits on the person's input, which is canceled with the interrupt |
| `running` | `completed` | Execution finished | Run reaches successful terminal condition |
| `running` | `failed` | Unrecovered error | Provider, transport, or internal error during execution |
| `waitingForApproval` | `running` | Approval resolved | Resolution outcome (approved or rejected) delivered to the run; a rejected outcome continues the run with the action refused — it does not terminate the run (Spec-010); an approval never settles on its own, so there is no time-based arm to this row (Spec-010 §Required Behavior) |
| `waitingForApproval` | `running` | Provider ask retraction | The provider withdrew its still-pending permission ask on the live leg — its approval request settles `approval.canceled` (no resolution row) at once, and the run resumes with no outcome delivered in the same atomic pass (Plan-009 T2.8's cancel ingress) |
| `waitingForApproval` | `interrupted` | Interrupt intervention | User-initiated stop while waiting — which cancels the approval the run was holding open, the cancellation recorded (Spec-010 §Required Behavior) — or an undo, which cancels it the same way (§Rollback Transitions) |
| `waitingForApproval` | `failed` | Provider or transport failure | Failure occurs while run is blocked on approval |
| `waitingForInput` | `running` | Question answered | The person answered the question: the question handler writes the answer as an ordinary `user.message.sent` row and moves the run back in the same step. A question waits until it is answered, so nothing reaches this row on elapsed time (Spec-010 §Required Behavior) |
| `waitingForInput` | `running` | Question canceled | The provider withdrew its still-held request on the live leg — the question handler settles the question canceled and the run resumes with no answer delivered |
| `waitingForInput` | `running` | Refusal choice answered `retryFallback` | The person chose to retry on the fallback model; the daemon sends that answer, appends `agent.run.refusalChoice.resolved`, and the turn goes on on that model |
| `waitingForInput` | `running` | Usage-credits choice answered `switchDefault` or `consent` | The person chose to switch models or to go on on usage credits; the daemon sends that answer, appends `agent.run.usageCreditsChoice.resolved`, and the turn goes on, on the model Claude Code switches to, or on Fable while the account's usage credits are on |
| `waitingForInput` | `interrupted` | Interrupt intervention | User-initiated stop while waiting, or an undo, which cancels the question the run held (§Rollback Transitions). An interrupt or an undo while the refusal choice waits takes the next row instead. An interrupt or an undo while the usage-credits choice waits interrupts the turn and never answers the choice, which is recorded `interrupted` |
| `waitingForInput` | `failed` | Refusal choice answered `editPrompt` or `canceled` | The person chose to edit the message, or the choice was answered `canceled` — by an interrupt, by an undo, whose cut then removes the turn, by a message sent while it waits, which then goes as the next turn, or by Claude Code settling it itself; the run ends with `failureCategory: 'refused'` |
| `waitingForInput` | `failed` | Provider or transport failure | Failure occurs while run is blocked on input |
| `paused` | `running` | The pause toggle pressed again (`agent.run.resume`), or a send | Resume handle valid and provider ready; the run continues from exactly where it stopped with nothing repeated, and any messages that were waiting are delivered ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)) |
| `paused` | `interrupted` | Interrupt intervention | User-initiated stop while paused, or an undo (§Rollback Transitions) |
| `paused` | `failed` | Resume failure | Resume handle lost or recovery exhausted |
| `interrupted` | `running` | Send into the interrupted run | A user message — or the messages that were waiting going as the next turn — returns the run to `running` with everything it knew; nothing is rewound and no turn is marked superseded ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)). A helper's interrupted run is continued this way only when its own parent run carries the send; a send through a new parent run starts the helper's next run |
| `running` | `stopped` | A stop that reaches several agents | A Claude Code child reached by `Interrupt everything` or `Stop all running`: `stop_task`, after which the CLI refuses every later message to it. The same press is `turn/interrupt` on a Codex child, which rests `interrupted` |
| `interrupted` | `stopped` | A stop that reaches several agents | The same stop reaching a Claude Code child already interrupted; the interruption and its cause stay in the record and the stop is a new event of its own |
| `running` | `stopped` | Token limit reached | The first usage report past the run's `Tokens per run`; the run carries `trigger: tokenLimit`, its turn ends `agent.turn.interrupted` with `cause: tokenLimit` and what it wrote kept ([Spec-014 §Budget Policies](../specs/014-multi-agent-orchestration.md#budget-policies)) |
| `pausing` | `stopped` | Token limit reached | The same, while the step in flight is finishing |
| `paused` | `stopped` | Token limit reached | The same, reached by a usage report that lands while the run is paused |
| `waitingForApproval` | `stopped` | Token limit reached | The same while the run waits on an approval, which is canceled with the run's end |
| `waitingForInput` | `stopped` | Token limit reached | The same while the run waits on the person's input, which is canceled with the run's end |
| `queued` | `failed` | Startup reconciliation | Recovery fails |
| `starting` | `failed` | Startup reconciliation | Recovery fails with no stop pending |
| `starting` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash |
| `starting` | `running` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) and the provider's record agrees with the daemon's, compared by provider id at the grain of each step — the agreeing attach in the pre-`running` crash window: provider and workspace re-confirmed ready, initialization resumes and completes |
| `starting` | `waitingForInput` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the provider's record, compared with the daemon's by provider id at the grain of each step, diverges from it — the pre-`running` crash window: the provider session advanced before the `starting → running` transition was recorded; the local log is authoritative, the run halts for human action carrying `recoveryNeeded` ([Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)) |
| `running` | `failed` | Startup reconciliation | Recovery fails with no stop pending |
| `running` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash, or the daemon's pending interrupt at the step limit or the spend limit, which keeps its `trigger` |
| `running` | `waitingForInput` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the provider's record, compared with the daemon's by provider id at the grain of each step, diverges from it — the local log is authoritative and the run halts for human action carrying `recoveryNeeded` ([Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)) |
| `waitingForApproval` | `failed` | Startup reconciliation | Recovery fails with no stop pending |
| `waitingForApproval` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash, or the daemon's pending interrupt at the step limit or the spend limit, which keeps its `trigger` |
| `waitingForApproval` | `waitingForInput` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the provider's record, compared with the daemon's by provider id at the grain of each step, diverges from it — the local log is authoritative and the run halts for human action carrying `recoveryNeeded`; the pending approval is canceled as moot through its existing terminal, never left actionable against a diverged run ([Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)) |
| `waitingForInput` | `failed` | Startup reconciliation | Recovery fails with no stop pending |
| `waitingForInput` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash, or the daemon's pending interrupt at the step limit or the spend limit, which keeps its `trigger` |
| `paused` | `failed` | Startup reconciliation | Resume impossible and no stop pending |
| `paused` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash, or the daemon's pending interrupt at the step limit or the spend limit, which keeps its `trigger`, or a child held in the pause, which carries `trigger: 'daemonRestart'`, the same where the resume succeeded and the provider holds no turn of the child |
| `starting` | `interrupted` | Startup reconciliation | Resume succeeds and the records agree, but the provider holds no turn of the run: its open turns end with `cause: daemonRestart` and the run carries `trigger: 'daemonRestart'` |
| `running` | `interrupted` | Startup reconciliation | The same |
| `waitingForApproval` | `interrupted` | Startup reconciliation | The same; the approval the run held is canceled with its end |
| `waitingForInput` | `interrupted` | Startup reconciliation | The same; the question the run held is canceled with its end |
| `pausing` | `paused` | Startup reconciliation | Resume succeeds and the records agree, and the provider ended the turn or holds none of it: the pause reaches its boundary, a turn the provider holds none of ending with `cause: daemonRestart`; a child whose turn is gone takes `pausing → interrupted` instead |
| `paused` | `waitingForInput` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the provider's record, compared with the daemon's by provider id at the grain of each step, diverges from it — the local log is authoritative and the run halts for human action carrying `recoveryNeeded` ([Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)) |
| `pausing` | `waitingForInput` | Startup reconciliation | Resume succeeds (`DriverResumeResult.status: 'resumed'`) but the provider's record, compared with the daemon's by provider id at the grain of each step, diverges from it — the step in flight did not land, since the restart ended it, so the run never reads `paused`; the local log is authoritative and the run halts for human action carrying `recoveryNeeded`, and the pause is kept for the answer ([Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)) |
| `pausing` | `failed` | Startup reconciliation | Recovery fails with no stop pending |
| `pausing` | `interrupted` | Startup reconciliation | Pending user-initiated stop recorded before crash, or the daemon's pending interrupt at the step limit or the spend limit, which keeps its `trigger`, or a child held in the pause, which carries `trigger: 'daemonRestart'`, the same where the resume succeeded and the provider holds no turn of the child |
| `running` | `stopped` | Startup reconciliation | The daemon's pending stop at the run's token limit recorded before crash; the run carries `trigger: tokenLimit` |
| `pausing` | `stopped` | Startup reconciliation | The same |
| `paused` | `stopped` | Startup reconciliation | The same |
| `waitingForApproval` | `stopped` | Startup reconciliation | The same |
| `waitingForInput` | `stopped` | Startup reconciliation | The same |

## Derived Failure And Recovery Signals

The canonical run lifecycle has one failure terminal state: `failed`. Additional labels describe why a run failed or whether recovery still needs action; they do not create extra run states.

| Signal Or Category | Meaning | Classification |
| --- | --- | --- |
| `recoveryNeeded` | Automatic recovery did not return the run to safe progress, and the person must act. | Recovery condition, not `RunState` |
| `reauthRequired` | Provider credentials or the provider session expired mid-run or during resume; re-authentication on the machine is required before recovery proceeds ([Spec-004 §Fallback Behavior](../specs/004-provider-driver-contract-and-capabilities.md#fallback-behavior) `RecoveryCondition`). | Recovery condition, not `RunState` |
| `providerFailure` | The provider or driver could not safely start, continue, or resume the run. | Failure category, not `RunState` |
| `transportFailure` | A required transport path failed independently of provider semantics. | Failure category, not `RunState` |
| `localPersistenceFailure` | Canonical local storage was unavailable or inconsistent enough that recovery or safe mutation could not continue. | Failure category, not `RunState` |
| `projectionFailure` | A projection rebuild could not produce trustworthy read state. | Failure category, not `RunState` |
| `refused` | The provider's safety check refused a turn and no other model could take it; the payload names the refusing model and carries the provider's words ([Spec-005 §Run Lifecycle](../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-runlifecycle)). | Failure category, not `RunState` |
| `setupFailure` | A setup gate threw before the provider started the run; the payload carries the gate's error code and its own words ([Spec-005 §Run Lifecycle](../specs/005-session-event-taxonomy-and-audit-log.md#run-lifecycle-runlifecycle)). | Failure category, not `RunState` |

- Recovery is handled by startup reconciliation: on boot the daemon detects stale runs and dispatches corrective commands. There is no visible `recovering` state.
- If recovery cannot proceed safely, the run transitions to `failed`; failure detail may then carry one or more failure categories plus `recoveryNeeded` when intervention is still required. A resume that succeeds but finds the provider's record diverged from the daemon's instead halts for human action in `waitingForInput` carrying `recoveryNeeded` — the divergence rows above, recorded as `agent.run.recovery.requested`; a run already recorded `waitingForInput` stays in that state with the same condition attached, with no self-transition row — and its stale pre-crash input request is replaced by the restart question, never left masking the divergence, the replaced ask canceled as moot through its existing terminal, as an undo cancels the question a waiting run held (§Rollback Transitions) ([Spec-013 §Fallback Behavior](../specs/013-persistence-and-recovery.md#fallback-behavior)).

## Example Flows

- Example: A queued implementation task is admitted, moves through `starting` to `running`, pauses for approval before a risky file write, returns to `running` after approval, and ends in `completed`.
- Example: A daemon restarts during execution. Startup reconciliation detects the stale run and dispatches corrective commands to resume or fail it.
- Example: A user stops an active run. The run transitions directly from `running` to `interrupted`.
- Example: A user interrupts a paused run (`agent.run.intervene {type: "interrupt"}`). The run transitions from `paused` to `interrupted` — the interrupt is the one way to end a run, distinct from queue-level `QueueItemCancel`, which withdraws a message the agent has not yet taken.
- Example: A user presses `Undo to here` on a message whose run completed two turns later. The conversation and the files go back together to the moment before that message: the conversation by the provider's own cut, the files by the daemon's own checkpointer. A forward `agent.run.rolledBack` event records the conversation cut alone; the run stays `completed` with a higher `runVersion`, and the turns after the point are marked superseded by projection. The undo's one result is stored as `session.restore.completed`, and the transcript reads `Restored to before <the message's first words>`. The user's next send starts from the cut conversation.

## Child-Run Behavior

Child runs are **independent intervention targets**: a parent state change never automatically propagates to children. This follows [Spec-014 §Intervention Propagation](../specs/014-multi-agent-orchestration.md#intervention-propagation) — "A pause, interrupt, or steer applied to a parent run does not auto-cascade to its child runs. Each child run is an independent intervention target." The user acts on children explicitly via the same intervention surfaces as any run (Plan-002), using the `run_links` projection (`agent.childRunLink.list`) to enumerate them.

| Parent State | Child-Run Effect |
| --- | --- |
| `interrupted` | No automatic effect. Children keep their current state; each child is interrupted explicitly, or the subtree stopped by `Interrupt everything` or `Stop all running`, which takes each Claude Code child it reaches to `stopped` and each Codex child to `interrupted`. |
| `failed` | No automatic effect. Children keep running; the parent's death does not invalidate work the children were spawned to do. |
| `paused` | No automatic effect. Pausing a parent pauses only the parent; children are paused individually if needed. |
| `completed` | Child runs continue to completion. They were spawned for a reason and are allowed to finish. |
| `waitingForApproval` | Child runs continue running. The parent blocking on approval does not block children. |
| `waitingForInput` | Child runs continue running. The parent blocking on input does not block children. |

The runtime adds no depth limit of its own to run nesting — how deep agents may nest is the provider's own limit under the person's own provider settings, and a provider's refusal is shown in its own words ([Spec-014 §Default Behavior](../specs/014-multi-agent-orchestration.md#default-behavior)): a child run may create children of its own, so a "subtree" is every run beneath the parent at any depth, and each row of the table above holds at every level.

## Edge Cases

- A run may fail from `starting` if workspace or provider initialization cannot complete.
- Pause is an orchestration-layer construct the daemon owns and does not require driver capability support: it is made true by the provider's own hooks where the provider has them and by a boundary interrupt where it does not, and the run's state is persisted; the second press of the toggle, or a send, continues it, and no resume event is queued ([Spec-003 §Required Behavior](../specs/003-queue-steer-pause-resume.md#required-behavior)). See ADR-011.
- Interruption is a synchronous or near-synchronous provider call. There is no intermediate `interrupting` state; runs transition directly to `interrupted`. Pause is the opposite case and does have one: `pausing` stands while the step already in flight finishes, because the person can see that the pause has not landed yet.
- A run may be `failed` with `providerFailure` detail after an unsuccessful resume attempt; provider-specific failure causes do not create separate run states.
- A run may be `failed` with visible `recoveryNeeded` condition after automatic recovery is exhausted; failed recovery remains visible through failure detail and recovery condition rather than a separate terminal run state.

## Implementation Note

The run state is a Rust `enum` in the daemon, and one `match` over the transition table, with its guard functions, decides every transition. Its TypeScript union, which clients narrow on at compile time, is generated from the contracts.

Validation against the complete transition table:

- All transitions are deterministic: a given trigger combined with its guard condition produces exactly one target state. No ambiguous transitions exist.
- Guards required: version checks for interventions (ensuring stale interventions do not apply), recovery eligibility checks (determining whether a stale run can be safely resumed or must fail), and child-run independence guards (ensuring no code path auto-propagates a parent state change to children — non-cascade per §Child-Run Behavior).
- No self-transitions or history states are required. Every transition moves the run to a different state (an undo's conversation cut is not a transition — the position change rides the forward `agent.run.rolledBack` event, §Rollback Transitions).
- The complete transition table is expressible as one `match` on the state and the trigger, with a guard function where a transition needs one, and the generated TypeScript union names every state.

## Related Specs

- [Queue Steer Pause Resume](../specs/003-queue-steer-pause-resume.md)
- [Session Event Taxonomy And Audit Log](../specs/005-session-event-taxonomy-and-audit-log.md)
- [Persistence And Recovery](../specs/013-persistence-and-recovery.md)

## Related ADRs

- [Daemon Backed Queue And Interventions](../decisions/003-daemon-backed-queue-and-interventions.md)
