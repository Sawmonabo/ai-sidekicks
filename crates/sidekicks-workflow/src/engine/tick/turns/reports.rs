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
use crate::engine::tick::live_runs::LiveRun;
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
    /// records the outputs, a retry readies the next attempt, a cancel drops the step. What
    /// follows a park, an end, a person wait or a spent account is the run's wave or wait, which
    /// keeps the step live, failed or waiting.
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
                turn.readied.push(TurnReadied {
                    ready: next,
                    inputs: failed.inputs,
                    input_ref: failed.input_ref,
                    // With no wait, the attempt goes out this turn.
                    next: if wait.is_zero() {
                        ReadiedNext::Dispatch
                    } else {
                        ReadiedNext::Retry(wait)
                    },
                });
            }
            SettlementAnswer::Canceled { readying_event } => {
                live.walk.drop_step(step);
                live.steps.remove(&step.execution_index.get());
                turn.last_readying_event = Some((readying_event, at));
            }
            SettlementAnswer::Park | SettlementAnswer::End => {
                live.move_step(step.execution_index.get(), WorkflowStepStatus::Failed, None);
            }
            SettlementAnswer::PersonWait { opened, .. } => {
                live.move_step(
                    step.execution_index.get(),
                    WorkflowStepStatus::Waiting,
                    Some(opened.cause),
                );
            }
            SettlementAnswer::AccountSpent { .. } => {
                let account = Some(WorkflowWaitCause::Account);
                live.move_step(
                    step.execution_index.get(),
                    WorkflowStepStatus::Waiting,
                    account,
                );
            }
        }
    }
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
