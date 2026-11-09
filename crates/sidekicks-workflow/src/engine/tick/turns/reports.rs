//! The report path of the tick's loop: each report first offered to its run's waves, then added
//! to its run's turn, a settlement's payload failure failed in its place, a form or reply wait the
//! settlement ends unanswered marked on its question, and what each settlement answers followed.

use std::collections::VecDeque;
use std::sync::Arc;

use sidekicks_contracts::git::local::WorkflowRunSnapshotPoint;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::question::QuestionWaitOutcome;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::item::{WorkflowItem, WorkflowStepError};
use sidekicks_contracts::workflow::run::failures::{
    WorkflowStepTimedOutCause, WorkflowStepTimedOutDetails,
};
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunPauseNumber;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseCancellationReason;
use sidekicks_contracts::workflow::run::step::record::{WorkflowPayloadRef, WorkflowStepKey};

use super::{EngineTick, PausePoint, ReadiedNext, RunTurn, TurnReadied, step_failure};
use crate::definitions::kept_values::remove_dropped;
use crate::engine::event_record::{EngineFault, EngineIntent, EngineOutcome};
use crate::engine::ports::{AgentStepRun, WorkflowRunSnapshotPointRequest};
use crate::engine::tick::branch_cancellation::{BranchCancelReason, WaveSettle};
use crate::engine::tick::commit::{
    RunEnding, RunTurnCommit, SettlementAnswer, SettlementWriteFailure,
};
use crate::engine::tick::live_runs::{LiveRun, LiveStep, TurnAsk};
use crate::engine::tick::step_failure::{
    RunSibling, RunStop, SiblingState, SiblingStop, stop_siblings,
};
use crate::engine::tick::{ParkedAgentRun, StepReport, StepReportKind, StepSettlement};
use crate::kinds::{PersonAsk, StepFailure};

impl EngineTick {
    /// Offers `report` to the run's waves, then adds it to the turn and follows what a settlement
    /// answers; the run cap's failure goes to the run whichever step reported it, and a spent
    /// account's reset at or past the run's cap deadline is dropped, so no resume is armed. A
    /// wave's `branchesCanceled` is written whether or not its deciding step is live; a failed
    /// step's own settlement after its cancel ends its wind-down, writing nothing; any other report
    /// of a step that is not live, or is live and failed, is dropped.
    pub(super) async fn apply_report(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        report: StepReport,
    ) {
        let mut report = match report {
            StepReport {
                step,
                at,
                kind: StepReportKind::RunCapped { limit_ms },
            } => {
                self.cap_run(live, turn, &step, at, limit_ms).await;
                return;
            }
            report => report,
        };
        // The cap wins: a reset at or past the run's cap deadline is not armed.
        if let StepReportKind::Settled(StepSettlement::AccountSpent { resets_at, .. }) =
            &mut report.kind
            && let Some(resets) = resets_at.as_ref().and_then(WireInstant::timestamp)
            && let Some(cap) = self
                .deadlines
                .cap_deadline(live.scope.run_started_at, turn.commit.person_wait())
                .as_ref()
                .and_then(WireInstant::timestamp)
            && resets >= cap
        {
            *resets_at = None;
        }
        let Some(mut report) = offer_to_waves(live, &mut turn.follow_ups, report).await else {
            return;
        };
        // Every step a person's cancel stops fails as canceled with its run.
        if matches!(live.ending, Some(RunEnding::Canceled { .. }))
            && let StepReportKind::Settled(StepSettlement::Canceled {
                cancellation_reason,
                ..
            }) = &mut report.kind
        {
            cancellation_reason.get_or_insert(WorkflowPhaseCancellationReason::RunCanceled);
        }
        if let StepReportKind::BranchesCanceled { reason, count } = report.kind {
            turn.commit
                .branches_canceled(report.step, &report.at, reason, count);
            return;
        }
        let execution_index = report.step.execution_index.get();
        // A park or an end keeps its failed step live, and the deadline clock can report one wait
        // twice; nothing more is written for a failed step.
        match live.steps.get_mut(&execution_index) {
            Some(live_step) if live_step.status != WorkflowStepStatus::Failed => {}
            Some(live_step) => {
                if live_step.is_winding_down
                    && let StepReportKind::Settled(settlement) = report.kind
                {
                    live_step.is_winding_down = false;
                    if let StepSettlement::AccountSpent { run, .. } = settlement {
                        stop_agent_run(live, &report.step, Some(run)).await;
                    }
                }
                return;
            }
            None => return,
        }
        let hold = match &report.kind {
            StepReportKind::WaitingOnPool { .. } => Some(Some(report.at.clone())),
            StepReportKind::Admitted { .. } => Some(None),
            StepReportKind::Settled(_) => {
                let step = report.step.clone();
                let at = report.at.clone();
                let answer = self.report_settlement(live, &mut turn.commit, report).await;
                self.follow_settlement(live, turn, &step, at, answer).await;
                return;
            }
            StepReportKind::Canceling => {
                if let Some(live_step) = live.steps.get_mut(&execution_index) {
                    live_step.is_winding_down = true;
                }
                None
            }
            StepReportKind::ResumeDue { resume_at } => {
                Self::resume_account_park(live, turn, report.step, &report.at, resume_at);
                return;
            }
            StepReportKind::Started { .. }
            | StepReportKind::Progressed
            | StepReportKind::BranchesCanceled { .. }
            | StepReportKind::RunCapped { .. } => None,
        };
        let step = report.step.clone();
        turn.commit
            .report(report, self.reported(live, &step))
            .await
            .expect("only a settlement stores a payload");
        if let Some(last_hold_report_at) = hold {
            let status = if last_hold_report_at.is_some() {
                WorkflowStepStatus::WaitingMemory
            } else {
                WorkflowStepStatus::Running
            };
            live.move_step(execution_index, status, None);
            if let Some(live_step) = live.steps.get_mut(&execution_index) {
                live_step.last_hold_report_at = last_hold_report_at;
            }
        }
    }

    /// Adds the settlement `report` to `commit` and answers what follows. A settlement whose
    /// payload cannot be stored fails its step with that error in its place, and a failure whose
    /// passed-on output cannot be stored either ends the run, which stores nothing more. A step
    /// still waiting on a form or a reply has its question marked once, after the settlement that
    /// lands: timed out where the step's own `Timeout` failed it, else ended.
    pub(super) async fn report_settlement(
        &self,
        live: &LiveRun,
        commit: &mut RunTurnCommit,
        report: StepReport,
    ) -> SettlementAnswer {
        let step = report.step.clone();
        let at = report.at.clone();
        let ended_wait = ended_question_wait(live, &report);
        let answer = match commit.report(report, self.reported(live, &step)).await {
            Ok(answer) => answer,
            Err(failure) => {
                let failed = self
                    .fail_in_place(live, &step, at.clone(), failure, StepFailure::Failed)
                    .await;
                match commit.report(failed, self.reported(live, &step)).await {
                    Ok(answer) => answer,
                    Err(failure) => {
                        let ended = self
                            .fail_in_place(live, &step, at.clone(), failure, StepFailure::EndsRun)
                            .await;
                        commit
                            .report(ended, self.reported(live, &step))
                            .await
                            .expect("a failure that ends its run stores no output and an empty log")
                    }
                }
            }
        };
        if let Some((wait_id, outcome)) = ended_wait {
            commit.settle_wait_question(&wait_id, outcome, &at);
        }
        answer.expect("a settlement answers")
    }

    /// Deletes what the failed settlement of `step` wrote, records the failure, and answers the
    /// step's report at `at` failing as `failed_as` with the write's error.
    async fn fail_in_place(
        &self,
        live: &LiveRun,
        step: &WorkflowStepKey,
        at: WireInstant,
        failure: SettlementWriteFailure,
        failed_as: fn(Box<WorkflowStepError>) -> StepFailure,
    ) -> StepReport {
        let SettlementWriteFailure {
            error,
            artifact_ids,
        } = failure;
        for (_, removal) in remove_dropped(&*self.payloads, &artifact_ids).await {
            live.record
                .fault(Some(step), EngineFault::TurnPayloadLeftBehind, &*removal)
                .await;
        }
        live.record
            .fault(Some(step), EngineFault::SettlementWriteFailed, &error)
            .await;
        StepReport {
            step: step.clone(),
            at,
            kind: StepReportKind::Settled(StepSettlement::Failed {
                failure: step_failure(live, step, failed_as, error.to_string()),
                log_lines: Vec::new(),
            }),
        }
    }

    /// Follows the settlement of `step` at `at`: a completion or a pass-on settles the walk and
    /// records the outputs; a retry readies the next attempt, canceled unrun in a stopped run; a
    /// cancel drops the step. A park or an end keeps the step live and failed and stops the run's
    /// other steps, an end deciding the run's ending with the step's error; a person wait or a
    /// spent account keeps it waiting, a spent account's agent run kept on it and its resume armed
    /// where one is set.
    pub(super) async fn follow_settlement(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        step: &WorkflowStepKey,
        at: WireInstant,
        answer: SettlementAnswer,
    ) {
        match answer {
            SettlementAnswer::Completed {
                readying_event,
                outputs,
                run_variables,
            } => {
                let variables = Arc::make_mut(&mut live.run_variables);
                for (name, variable) in run_variables {
                    variables.insert(name, variable.value);
                }
                self.settle_step(live, turn, step, (readying_event, at), outputs)
                    .await;
            }
            SettlementAnswer::PassOn {
                readying_event,
                outputs,
            } => {
                self.settle_step(live, turn, step, (readying_event, at), outputs)
                    .await;
            }
            SettlementAnswer::Retry { wait } => {
                let next = live.walk.retry(step);
                let failed = live
                    .remove_step(step.execution_index.get())
                    .expect("a retried step is live");
                turn.commit.retried(&next, failed.input_ref.clone());
                // A stopped run starts nothing new; with no wait, the attempt goes out this turn.
                let follows = if live.stop.is_some() {
                    turn.commit.canceled_unrun(&next.step, &at);
                    live.leave_walk(&next.step, &failed.inputs, &failed.input_ref);
                    ReadiedNext::Canceled
                } else if wait.is_zero() {
                    ReadiedNext::Dispatch
                } else {
                    ReadiedNext::Retry(wait)
                };
                turn.readied.push(TurnReadied {
                    ready: next,
                    inputs: failed.inputs,
                    input_ref: failed.input_ref,
                    next: follows,
                });
            }
            SettlementAnswer::Canceled { readying_event } => {
                let canceled = live
                    .remove_step(step.execution_index.get())
                    .expect("a canceled step is live");
                if !canceled.is_park_canceled {
                    live.walk.drop_step(step);
                } else if live.stop.is_some() {
                    live.leave_walk(step, &canceled.inputs, &canceled.input_ref);
                } else {
                    // A Resume lifted the park before this cancel settled, so it runs again now.
                    let LiveStep {
                        inputs, input_ref, ..
                    } = canceled;
                    run_again(live, turn, step, (inputs, input_ref), readying_event);
                }
                turn.last_readying_event = Some((readying_event, at));
            }
            SettlementAnswer::Park => self.stop_run(live, turn, step, &at, RunStop::Park).await,
            SettlementAnswer::End { error } => {
                live.ending.get_or_insert(RunEnding::Failed {
                    step: step.clone(),
                    error,
                });
                self.stop_run(live, turn, step, &at, RunStop::End).await;
            }
            SettlementAnswer::PersonWait {
                opened,
                ask,
                admission,
            } => {
                live.wait_on_person(step.execution_index.get(), &opened);
                turn.asks.push(TurnAsk {
                    step: step.clone(),
                    opened,
                    ask,
                    admission,
                    is_point_taken: false,
                });
            }
            SettlementAnswer::AccountSpent { parked, resume_at } => {
                live.wait_on_account(step.execution_index.get(), parked, resume_at);
            }
        }
    }

    /// Resumes `step` of `live` from its spent account at `at`, as its resume armed at `resume_at`
    /// coming due does, only while it still waits on the account with that resume armed, is not
    /// winding down and its run's ending is undecided; else nothing is written, so a second report
    /// of a resume the step has since parked past is dropped. A failed park beside it does not hold
    /// it back, since its attempt is in flight. The step leaves its wait as [`lift_account_wait`]
    /// says.
    pub(super) fn resume_account_park(
        live: &mut LiveRun,
        turn: &mut RunTurn,
        step: WorkflowStepKey,
        at: &WireInstant,
        resume_at: &WireInstant,
    ) {
        let execution_index = step.execution_index.get();
        let is_parked = live.ending.is_none()
            && live.steps.get(&execution_index).is_some_and(|live_step| {
                live_step.status == WorkflowStepStatus::Waiting
                    && live_step.wait_cause == Some(WorkflowWaitCause::Account)
                    && !live_step.is_winding_down
                    && live_step.resume_at.as_ref() == Some(resume_at)
            });
        if is_parked {
            lift_account_wait(live, turn, step, at);
        }
    }

    /// Hands each of `resumes`, a step of `live` whose resume the turn's write just committed,
    /// with its kept agent run to the dispatch, which takes the run again under the step's cancel.
    pub(super) fn resume_parked(
        &self,
        live: &LiveRun,
        resumes: Vec<(WorkflowStepKey, ParkedAgentRun)>,
    ) {
        for (step, parked) in resumes {
            let live_step = live
                .steps
                .get(&step.execution_index.get())
                .expect("a resumed step stays live until its run settles it");
            let cancel = live_step
                .cancel
                .clone()
                .expect("a resumed step holds its cancel");
            self.dispatch
                .resume_agent_step(&live.scope, step, &live_step.inputs, parked, cancel);
        }
    }

    /// Asks the person each of `asks`, opened by the run of `live` in the turn whose write just
    /// committed, whose step still waits under its wait: an approval whose pause point is not
    /// taken yet starts its point on its own task and waits on the run, asked once the point
    /// ends; otherwise the intent recorded, the card raised or the question opened, and the
    /// outcome recorded. A failed ask fails its step with the port's error, its report queued on
    /// the run's next batch, which routes it by the step's error setting.
    pub(super) async fn ask_people(&mut self, live: &mut LiveRun, asks: Vec<TurnAsk>) {
        for turn_ask in asks {
            let is_waiting = live
                .steps
                .get(&turn_ask.step.execution_index.get())
                .is_some_and(|live_step| live_step.wait_id == Some(turn_ask.opened.wait_id));
            if !is_waiting {
                continue;
            }
            if matches!(turn_ask.ask, PersonAsk::Approval { .. }) && !turn_ask.is_point_taken {
                self.take_pause_point(live, turn_ask);
                continue;
            }
            let TurnAsk {
                step,
                opened,
                ask,
                admission,
                ..
            } = turn_ask;
            let wait_id = opened.wait_id;
            let intent = match ask {
                PersonAsk::Approval { .. } => EngineIntent::RaisingCard { wait_id },
                PersonAsk::Form { .. } | PersonAsk::Reply { .. } => {
                    EngineIntent::OpeningQuestion { wait_id }
                }
            };
            let pending = live.record.intent(Some(&step), intent).await;
            let asked = self
                .person_waits
                .ask_person(&live.scope, &step, &opened, &ask, admission.as_ref())
                .await;
            // The step settles on its answer and never resumes its place, so it goes now.
            drop(admission);
            let error = match asked {
                Ok(()) => {
                    live.record.outcome(pending, EngineOutcome::Done).await;
                    continue;
                }
                Err(error) => error,
            };
            live.record
                .outcome(pending, EngineOutcome::Failed { code: None })
                .await;
            let failure = step_failure(live, &step, StepFailure::Failed, error.to_string());
            live.next_batch.push(StepReport {
                step,
                at: WireInstant::now(),
                kind: StepReportKind::Settled(StepSettlement::Failed {
                    failure,
                    log_lines: Vec::new(),
                }),
            });
        }
    }

    /// Starts the pause point of `turn_ask`, an approval of the run of `live`, on its own task as
    /// the run's next pause, and keeps the ask on the run until the point ends.
    fn take_pause_point(&mut self, live: &mut LiveRun, turn_ask: TurnAsk) {
        live.approval_pauses += 1;
        let pause_number = WorkflowRunPauseNumber(
            SafeInt::new(live.approval_pauses).expect("a run's pause count is a safe integer"),
        );
        let request = WorkflowRunSnapshotPointRequest {
            session_id: live.scope.session_id,
            workflow_run_id: live.scope.run_id,
            point: WorkflowRunSnapshotPoint::Pause {
                epoch: live.epoch,
                pause_number,
            },
        };
        let task = self.pause_points.spawn(self.snapshot_points.take(request));
        let point = PausePoint {
            run_id: live.scope.run_id,
            wait_id: turn_ask.opened.wait_id,
            epoch: live.epoch,
            pause_number,
        };
        self.pause_point_tasks.insert(task.id(), point);
        live.pausing.push(turn_ask);
    }

    /// Fails `step` of `live`, whose failure stops its run as `stop` at `at`: every other step
    /// stops as [`stop_steps`] says, the wave's event on `step`.
    pub(super) async fn stop_run(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        step: &WorkflowStepKey,
        at: &WireInstant,
        stop: RunStop,
    ) {
        live.move_step(step.execution_index.get(), WorkflowStepStatus::Failed, None);
        stop_steps(live, turn, Some(step), at, stop).await;
    }
}

/// Takes `step` of `live`, waiting on its spent account, out of its wait at `at`: its row back to
/// `running` in the turn's write, its resume disarmed, a fresh cancel, a child of the run's, and
/// its kept agent run waiting on the turn, taken again once the write commits.
pub(super) fn lift_account_wait(
    live: &mut LiveRun,
    turn: &mut RunTurn,
    step: WorkflowStepKey,
    at: &WireInstant,
) {
    let execution_index = step.execution_index.get();
    turn.commit
        .resume_step(&step, None, WorkflowWaitCause::Account, at);
    live.move_step(execution_index, WorkflowStepStatus::Running, None);
    let cancel = live.scope.cancel.child_token();
    let live_step = live
        .steps
        .get_mut(&execution_index)
        .expect("a resumed step is live");
    live_step.cancel = Some(cancel);
    let parked = live_step
        .parked_agent_run
        .take()
        .expect("a step waiting on its spent account keeps its run");
    turn.resumes.push((step, parked));
}

/// Readies the next attempt of `step`, a step of `live` a failed park stopped, on its earlier
/// attempt's `(inputs, input_ref)`, its `pending` row riding the turn's event at `readying_event`,
/// to dispatch once the turn's write commits.
pub(super) fn run_again(
    live: &mut LiveRun,
    turn: &mut RunTurn,
    step: &WorkflowStepKey,
    (inputs, input_ref): (Vec<Vec<WorkflowItem>>, WorkflowPayloadRef),
    readying_event: usize,
) {
    let next = live.walk.retry(step);
    turn.commit.rerun(&next, input_ref.clone(), readying_event);
    turn.readied.push(TurnReadied {
        ready: next,
        inputs,
        input_ref,
        next: ReadiedNext::Dispatch,
    });
}

/// Stops the run of `live` as `stop` at `at`, an end replacing a park: every live step but
/// `deciding` and every step this turn readied stops as its sibling, the running ones winding
/// down as one wave and an end's waits canceled now. The wave's event sits on `deciding`, or with
/// none, on the earliest running step; its reason is the person's cancel where the run's ending
/// is one, else a sibling's failure.
pub(super) async fn stop_steps(
    live: &mut LiveRun,
    turn: &mut RunTurn,
    deciding: Option<&WorkflowStepKey>,
    at: &WireInstant,
    stop: RunStop,
) {
    let stop = if live.stop == Some(RunStop::End) {
        RunStop::End
    } else {
        stop
    };
    live.stop = Some(stop);
    let mut others: Vec<&LiveStep> = live
        .steps
        .values()
        .filter(|live_step| Some(&live_step.step) != deciding)
        .collect();
    others.sort_by_key(|live_step| live_step.step.execution_index.get());
    let others: Vec<WorkflowStepKey> = others
        .into_iter()
        .map(|live_step| live_step.step.clone())
        .chain(
            turn.readied
                .iter()
                .map(|readied| readied.ready.step.clone()),
        )
        .collect();
    let siblings = sort_losers(live, turn, others, at).await;
    // With no running sibling no wave forms, so the step the key names carries nothing.
    let Some(deciding) = deciding
        .cloned()
        .or_else(|| {
            siblings
                .iter()
                .find(|sibling| matches!(sibling.state, SiblingState::Running(_)))
                .map(|sibling| sibling.step.clone())
        })
        .or_else(|| siblings.first().map(|sibling| sibling.step.clone()))
    else {
        return;
    };
    let reason = if matches!(live.ending, Some(RunEnding::Canceled { .. })) {
        BranchCancelReason::RunCanceled
    } else {
        BranchCancelReason::SiblingFailure
    };
    let SiblingStop {
        reports,
        wave,
        canceled_waits,
    } = stop_siblings(deciding, stop, reason, siblings);
    turn.follow_ups.extend(reports);
    live.waves.extend(wave);
    for waiting in canceled_waits {
        cancel_now(live, turn, waiting, at).await;
    }
}

/// Sorts `steps`, which a cancel of `live` at `at` names, by how each stops. A step readied
/// earlier in this turn is canceled unrun and leaves the walk; an undispatched `pending` step is
/// canceled now; a step winding down, or one that settled, is left as it is. Answers each running
/// step with its cancel, each dispatched one the entry line or the memory gate holds with its
/// cancel, whose driver reports its own cancel, and each waiting one, which the caller stops.
pub(super) async fn sort_losers(
    live: &mut LiveRun,
    turn: &mut RunTurn,
    steps: Vec<WorkflowStepKey>,
    at: &WireInstant,
) -> Vec<RunSibling> {
    // A failed park's cancels are run again by the person's Resume.
    let is_parked = live.is_parked_on_failure();
    let mut siblings = Vec::new();
    for step in steps {
        if let Some(readied) = turn
            .readied
            .iter_mut()
            .find(|readied| readied.ready.step == step)
        {
            if !matches!(readied.next, ReadiedNext::Canceled) {
                readied.next = ReadiedNext::Canceled;
                turn.commit.canceled_unrun(&step, at);
                live.leave_walk(&step, &readied.inputs, &readied.input_ref);
            }
            continue;
        }
        let Some(live_step) = live.steps.get_mut(&step.execution_index.get()) else {
            continue;
        };
        if live_step.is_winding_down {
            continue;
        }
        let state = match (live_step.status, &live_step.cancel) {
            (WorkflowStepStatus::Running, Some(cancel)) => {
                // Marked now, so a second cancel in this turn never puts it in a second wave.
                live_step.is_winding_down = true;
                live_step.is_park_canceled = is_parked;
                SiblingState::Running(cancel.clone())
            }
            (WorkflowStepStatus::Pending | WorkflowStepStatus::WaitingMemory, Some(cancel)) => {
                // A held loser of an earlier race is already canceled and is not run again.
                live_step.is_park_canceled = is_parked && !cancel.is_cancelled();
                SiblingState::Held(cancel.clone())
            }
            (WorkflowStepStatus::Pending, None) => {
                live_step.is_park_canceled = is_parked;
                cancel_now(live, turn, step, at).await;
                continue;
            }
            (WorkflowStepStatus::Waiting, _) => SiblingState::Waiting,
            (
                WorkflowStepStatus::Running
                | WorkflowStepStatus::WaitingMemory
                | WorkflowStepStatus::Succeeded
                | WorkflowStepStatus::Failed
                | WorkflowStepStatus::Skipped
                | WorkflowStepStatus::Canceled,
                _,
            ) => continue,
        };
        siblings.push(RunSibling { step, state });
    }
    siblings
}

/// The wait whose question the settlement `report` ends unanswered, with how: its step still
/// waits on a form or a reply, and the step's own `Timeout` failing it reads timed out while
/// anything else, the run cap's cut among them, reads ended. `None` for any other step, an answered
/// one included, since its answer cleared its wait before its settlement.
fn ended_question_wait(
    live: &LiveRun,
    report: &StepReport,
) -> Option<(UuidTextForm, QuestionWaitOutcome)> {
    let live_step = live.steps.get(&report.step.execution_index.get())?;
    match live_step.wait_cause? {
        WorkflowWaitCause::Form | WorkflowWaitCause::Reply => {}
        WorkflowWaitCause::Approval | WorkflowWaitCause::Account | WorkflowWaitCause::Chain => {
            return None;
        }
    }
    let wait_id = live_step.wait_id?;
    let outcome = if matches!(
        &report.kind,
        StepReportKind::Settled(StepSettlement::Failed {
            failure: StepFailure::Failed(error) | StepFailure::EndsRun(error),
            ..
        }) if is_step_timeout(error)
    ) {
        QuestionWaitOutcome::TimedOut
    } else {
        QuestionWaitOutcome::Ended
    };
    Some((wait_id, outcome))
}

/// Whether `error` is the failure the step's own `Timeout` gives: `workflow.step.timedOut` with
/// the cause `stepTimeout`, never the run cap's `runCap`.
fn is_step_timeout(error: &WorkflowStepError) -> bool {
    let WorkflowStepError::Coded(coded) = error else {
        return false;
    };
    coded.code.as_str() == RefusalCode::WorkflowStepTimedOut.as_str()
        && coded.details.as_ref().is_some_and(|details| {
            serde_json::to_value(details)
                .and_then(serde_json::from_value::<WorkflowStepTimedOutDetails>)
                .is_ok_and(|details| details.cause == WorkflowStepTimedOutCause::StepTimeout)
        })
}

/// Cancels the live `step` of `live` at `at` without a driver: its cancel queued on the turn's
/// follow-ups, and the agent run a spent account parked on it stopped.
pub(super) async fn cancel_now(
    live: &mut LiveRun,
    turn: &mut RunTurn,
    step: WorkflowStepKey,
    at: &WireInstant,
) {
    let parked = live
        .steps
        .get_mut(&step.execution_index.get())
        .and_then(|live_step| live_step.parked_agent_run.take())
        .map(|parked| parked.run);
    stop_agent_run(live, &step, parked).await;
    turn.follow_ups.push_back(StepReport {
        step,
        at: at.clone(),
        kind: StepReportKind::Settled(StepSettlement::Canceled {
            hold_started_at: None,
            cancellation_reason: None,
        }),
    });
}

/// Offers `report` to each wave of `live` in order: a member's settlement is held by its wave,
/// and the last one closes the wave, whose reports queue on `follow_ups`; an agent run a member
/// hands back is stopped. Answers the report when no wave holds it.
async fn offer_to_waves(
    live: &mut LiveRun,
    follow_ups: &mut VecDeque<StepReport>,
    mut report: StepReport,
) -> Option<StepReport> {
    let mut index = 0;
    while index < live.waves.len() {
        let step = report.step.clone();
        match live.waves[index].settle(report) {
            WaveSettle::Passed(passed) => {
                report = passed;
                index += 1;
            }
            WaveSettle::Pending { run_to_stop } => {
                stop_agent_run(live, &step, run_to_stop).await;
                return None;
            }
            WaveSettle::Closed {
                reports,
                run_to_stop,
            } => {
                live.waves.remove(index);
                follow_ups.extend(reports);
                stop_agent_run(live, &step, run_to_stop).await;
                return None;
            }
        }
    }
    Some(report)
}

/// Stops `run`, the agent run of `step` of `live` that no cancel reaches any more, recording a
/// stop that could not be sent.
pub(super) async fn stop_agent_run(
    live: &LiveRun,
    step: &WorkflowStepKey,
    run: Option<Box<dyn AgentStepRun>>,
) {
    if let Some(run) = run
        && let Err(error) = run.cancel().await
    {
        live.record
            .fault(Some(step), EngineFault::AgentRunStopFailed, error.as_ref())
            .await;
    }
}

#[cfg(test)]
mod tests;
