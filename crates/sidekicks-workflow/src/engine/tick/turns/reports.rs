//! The report path of the tick's loop: each report first offered to its run's waves, then added
//! to its run's turn, a settlement's payload failure failed in its place, and what each settlement
//! answers followed.

use std::collections::VecDeque;
use std::sync::Arc;

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;

use super::{EngineTick, ReadiedNext, RunTurn, TurnReadied, step_failure};
use crate::engine::event_record::EngineFault;
use crate::engine::ports::AgentStepRun;
use crate::engine::tick::branch_cancellation::WaveSettle;
use crate::engine::tick::commit::{RunTurnCommit, SettlementAnswer, SettlementWriteFailure};
use crate::engine::tick::live_runs::{LiveRun, LiveStep};
use crate::engine::tick::step_failure::{
    RunSibling, RunStop, SiblingState, SiblingStop, stop_siblings,
};
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};
use crate::kinds::StepFailure;

impl EngineTick {
    /// Offers `report` to the run's waves, then adds it to the turn and follows what a settlement
    /// answers. A wave's `branchesCanceled` is written whether or not its deciding step is live;
    /// any other report of a step that is not live is dropped.
    pub(super) async fn apply_report(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        report: StepReport,
    ) {
        let Some(report) = offer_to_waves(live, &mut turn.follow_ups, report).await else {
            return;
        };
        if let StepReportKind::BranchesCanceled { reason, count } = report.kind {
            turn.commit
                .branches_canceled(report.step, &report.at, reason, count);
            return;
        }
        let execution_index = report.step.execution_index.get();
        if !live.steps.contains_key(&execution_index) {
            return;
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
            StepReportKind::Started { .. }
            | StepReportKind::Progressed
            | StepReportKind::BranchesCanceled { .. } => None,
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
    /// passed-on output cannot be stored either ends the run, which stores nothing more.
    async fn report_settlement(
        &self,
        live: &LiveRun,
        commit: &mut RunTurnCommit,
        report: StepReport,
    ) -> SettlementAnswer {
        let step = report.step.clone();
        let at = report.at.clone();
        let failure = match commit.report(report, self.reported(live, &step)).await {
            Ok(answer) => return answer.expect("a settlement answers"),
            Err(failure) => failure,
        };
        let failed = self
            .fail_in_place(live, &step, at.clone(), failure, StepFailure::Failed)
            .await;
        let failure = match commit.report(failed, self.reported(live, &step)).await {
            Ok(answer) => return answer.expect("a settlement answers"),
            Err(failure) => failure,
        };
        let ended = self
            .fail_in_place(live, &step, at, failure, StepFailure::EndsRun)
            .await;
        commit
            .report(ended, self.reported(live, &step))
            .await
            .expect("a failure that ends its run stores no output and an empty log")
            .expect("a settlement answers")
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
        for artifact_id in &artifact_ids {
            if let Err(removal) = self.payloads.delete(artifact_id).await {
                live.record
                    .fault(Some(step), EngineFault::TurnPayloadLeftBehind, &*removal)
                    .await;
            }
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
    /// other steps; a person wait or a spent account keeps it waiting, a spent account's agent run
    /// kept on it.
    async fn follow_settlement(
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
                    .steps
                    .remove(&step.execution_index.get())
                    .expect("a retried step is live");
                turn.commit.retried(&next, failed.input_ref.clone());
                // A stopped run starts nothing new; with no wait, the attempt goes out this turn.
                let follows = if live.stop.is_some() {
                    turn.commit.canceled_unrun(&next.step, &at);
                    live.walk.drop_step(&next.step);
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
                live.walk.drop_step(step);
                live.steps.remove(&step.execution_index.get());
                turn.last_readying_event = Some((readying_event, at));
            }
            SettlementAnswer::Park => self.stop_run(live, turn, step, &at, RunStop::Park).await,
            SettlementAnswer::End => self.stop_run(live, turn, step, &at, RunStop::End).await,
            SettlementAnswer::PersonWait { opened, .. } => {
                live.move_step(
                    step.execution_index.get(),
                    WorkflowStepStatus::Waiting,
                    Some(opened.cause),
                );
            }
            SettlementAnswer::AccountSpent { run } => {
                let execution_index = step.execution_index.get();
                let account = Some(WorkflowWaitCause::Account);
                live.move_step(execution_index, WorkflowStepStatus::Waiting, account);
                live.steps
                    .get_mut(&execution_index)
                    .expect("a step the turn moved is live")
                    .parked_agent_run = Some(run);
            }
        }
    }

    /// Fails `step` of `live`, whose failure stops its run as `stop` at `at`, an end replacing a
    /// park: every other live step and every step this turn readied stops as its sibling, the
    /// running ones winding down as one wave and an end's waits canceled now.
    async fn stop_run(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        step: &WorkflowStepKey,
        at: &WireInstant,
        stop: RunStop,
    ) {
        live.move_step(step.execution_index.get(), WorkflowStepStatus::Failed, None);
        let stop = if live.stop == Some(RunStop::End) {
            RunStop::End
        } else {
            stop
        };
        live.stop = Some(stop);
        let mut others: Vec<&LiveStep> = live
            .steps
            .values()
            .filter(|live_step| live_step.step != *step)
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
        let SiblingStop {
            reports,
            wave,
            canceled_waits,
        } = stop_siblings(step.clone(), stop, siblings);
        turn.follow_ups.extend(reports);
        live.waves.extend(wave);
        for waiting in canceled_waits {
            cancel_now(live, turn, waiting, at).await;
        }
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
                live.walk.drop_step(&step);
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
                SiblingState::Running(cancel.clone())
            }
            (WorkflowStepStatus::Pending | WorkflowStepStatus::WaitingMemory, Some(cancel)) => {
                SiblingState::Held(cancel.clone())
            }
            (WorkflowStepStatus::Pending, None) => {
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
        .and_then(|live_step| live_step.parked_agent_run.take());
    stop_agent_run(live, &step, parked).await;
    turn.follow_ups.push_back(StepReport {
        step,
        at: at.clone(),
        kind: StepReportKind::Settled(StepSettlement::Canceled {
            hold_started_at: None,
            is_sibling_failure: false,
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
async fn stop_agent_run(
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
