//! The run's ending in the tick's loop: a person's cancel routed to its run and winding it down;
//! the run cap ending a run on its earliest running or parked step; and the turn that finds a run
//! over writing its ending, a run a stop ended once none of its steps runs, is held, pending or
//! waiting, and a run no stop touched once every step settled.

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::control::WorkflowCancelReason;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use tokio::sync::oneshot;

use super::reports::{stop_agent_run, stop_steps};
use super::{EngineTick, ReadiedNext, RunTurn};
use crate::engine::results::run_posts_results;
use crate::engine::tick::commit::RunEnding;
use crate::engine::tick::commit::SessionEventId;
use crate::engine::tick::live_runs::{LiveRun, LiveStep};
use crate::engine::tick::step_failure::{RunStop, run_cap_failure, step_failure_error};
use crate::engine::tick::{StepReport, StepReportKind, StepSettlement};

/// The reply to a person's cancel: the id of the run's `workflow.run.canceled` once the write of
/// the run's ending commits, or why the tick did not take it.
pub(crate) type RunCancelReply = oneshot::Sender<Result<SessionEventId, RunCancelRefusal>>;

/// A person's cancel of a run, as it reaches the tick.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the run cancel handler, which sends it")
)]
pub(crate) struct RunCancelIntake {
    /// The run.
    pub(crate) run_id: WorkflowRunId,
    /// The person's reason, where one was given.
    pub(crate) reason: Option<WorkflowCancelReason>,
    /// The run's error the cancel stores, carrying the reason as its message.
    pub(crate) error: Option<WorkflowStepError>,
    /// Where the answer goes.
    pub(crate) reply: RunCancelReply,
}

/// Why the tick did not take a person's cancel.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunCancelRefusal {
    /// The tick does not hold the run, so its cancel writes the run's rows itself.
    NotHeld,
    /// The run's ending is already decided, by a step's failure, the run cap or every step
    /// settling, and stands; the cancel answers `workflow.run.notCancelable`, as for a run that
    /// has ended.
    Ending,
}

impl EngineTick {
    /// Takes the person's cancel `intake` of the run of `live` in `turn`: the run's ending becomes
    /// `canceled` with the cancel's reason and error, and every step stops as an end's, the
    /// earliest running one carrying the wave; the reply waits for the ending's write. A second
    /// cancel waits with the first, and a run whose ending a failure or the cap decided, or whose
    /// every step settled with nothing readied after a flush, refuses it.
    pub(super) async fn apply_cancel(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        intake: RunCancelIntake,
    ) {
        let RunCancelIntake {
            reason,
            error,
            reply,
            ..
        } = intake;
        match live.ending {
            Some(RunEnding::Canceled { .. }) => {
                live.cancel_replies.push(reply);
                return;
            }
            Some(RunEnding::Completed | RunEnding::Failed { .. }) => {
                let _unheard = reply.send(Err(RunCancelRefusal::Ending));
                return;
            }
            None => {}
        }
        if live.steps.is_empty() {
            self.flush(live, turn).await;
        }
        // The run is over and completes in this turn's write.
        if live.steps.is_empty() && turn.readied.is_empty() {
            let _unheard = reply.send(Err(RunCancelRefusal::Ending));
            return;
        }
        live.ending = Some(RunEnding::Canceled { reason, error });
        live.cancel_replies.push(reply);
        stop_steps(live, turn, None, &WireInstant::now(), RunStop::End).await;
    }

    /// Ends the run of `live` on its cap of `limit_ms` at `at`, which the clock reported on
    /// `reported`: the run's earliest running or parked step takes the cap's failure, the run's
    /// error is the cap's, every other step winds down as the end's siblings, and the clock skips
    /// the run's cap from then on. A parked step keeps its failed row and its own error; a step
    /// still running fails now and is canceled, and the run's ending waits for its own settlement.
    /// With no step live, the steps this turn readied are canceled unrun and the run ends on the
    /// cap, its error naming `reported`'s node; a run whose every step settled with nothing
    /// readied completes, and a run whose ending is decided takes nothing more.
    pub(super) async fn cap_run(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        reported: &WorkflowStepKey,
        at: WireInstant,
        limit_ms: SafeInt<1>,
    ) {
        if live.ending.is_some() {
            return;
        }
        if live.steps.is_empty() {
            self.flush(live, turn).await;
        }
        let failure = run_cap_failure(limit_ms);
        let Some(capped) = capped_step(live) else {
            if turn.readied.is_empty() {
                return;
            }
            let error = step_failure_error(&reported.node_id, &failure);
            live.ending = Some(RunEnding::Failed {
                step: reported.clone(),
                error,
            });
            self.deadlines.skip_cap(live.scope.run_id);
            stop_steps(live, turn, None, &at, RunStop::End).await;
            return;
        };
        self.deadlines.skip_cap(live.scope.run_id);
        let step = capped.step.clone();
        if capped.status == WorkflowStepStatus::Failed {
            let error = step_failure_error(&step.node_id, &failure);
            live.ending = Some(RunEnding::Failed {
                step: step.clone(),
                error,
            });
            self.stop_run(live, turn, &step, &at, RunStop::End).await;
            return;
        }
        let driver = matches!(
            capped.status,
            WorkflowStepStatus::Running
                | WorkflowStepStatus::Pending
                | WorkflowStepStatus::WaitingMemory
        )
        .then(|| capped.cancel.clone())
        .flatten();
        let parked_agent_run = live
            .steps
            .get_mut(&step.execution_index.get())
            .and_then(|live_step| live_step.parked_agent_run.take())
            .map(|parked| parked.run);
        stop_agent_run(live, &step, parked_agent_run).await;
        let failed = StepReport {
            step: step.clone(),
            at: at.clone(),
            kind: StepReportKind::Settled(StepSettlement::Failed {
                failure,
                log_lines: Vec::new(),
            }),
        };
        let answer = self.report_settlement(live, &mut turn.commit, failed).await;
        self.follow_settlement(live, turn, &step, at, answer).await;
        if let Some(cancel) = driver {
            cancel.cancel();
            live.steps
                .get_mut(&step.execution_index.get())
                .expect("a failure that ends its run keeps its step live")
                .is_winding_down = true;
        }
    }
}

/// The step of `live` the run cap cuts: the earliest of its steps running, parked on a failure or
/// parked on a spent account that is not already winding down, else its earliest live step;
/// `None` with no step live.
fn capped_step(live: &LiveRun) -> Option<&LiveStep> {
    let is_running_or_parked = |live_step: &&LiveStep| {
        !live_step.is_winding_down
            && match live_step.status {
                WorkflowStepStatus::Running | WorkflowStepStatus::Failed => true,
                WorkflowStepStatus::Waiting => {
                    live_step.wait_cause == Some(WorkflowWaitCause::Account)
                }
                WorkflowStepStatus::Pending
                | WorkflowStepStatus::WaitingMemory
                | WorkflowStepStatus::Succeeded
                | WorkflowStepStatus::Skipped
                | WorkflowStepStatus::Canceled => false,
            }
    };
    let execution_index = |live_step: &&LiveStep| live_step.step.execution_index.get();
    live.steps
        .values()
        .filter(is_running_or_parked)
        .min_by_key(execution_index)
        .or_else(|| live.steps.values().min_by_key(execution_index))
}

/// Adds the ending of the run of `live` to `turn` where the run is over: the ending a stop decided
/// once every step left live is a failed one with nothing winding down and nothing this turn
/// readied goes on, else `Completed` for a run no stop touched with no step left live or readied;
/// a run whose mode posts its results posts them after its ending event.
pub(super) fn end_when_over(live: &mut LiveRun, turn: &mut RunTurn) {
    let is_wound_down = live.steps.values().all(|live_step| {
        live_step.status == WorkflowStepStatus::Failed && !live_step.is_winding_down
    }) && turn
        .readied
        .iter()
        .all(|readied| matches!(readied.next, ReadiedNext::Canceled));
    if !is_wound_down {
        return;
    }
    let posts_results = run_posts_results(live.scope.mode, live.scope.retried_mode);
    if let Some(ending) = live.ending.take() {
        turn.commit.end(ending, posts_results);
    } else if live.stop.is_none() && live.steps.is_empty() {
        turn.commit.end(RunEnding::Completed, posts_results);
    }
}

#[cfg(test)]
mod tests;
