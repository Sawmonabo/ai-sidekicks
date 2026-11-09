//! A person's Resume in the tick's loop: each step waiting on a spent account resumed ahead of
//! its armed resume, and each step a failed park stopped run again as its next attempt, all in
//! the turn's one write; a run with nothing a Resume lifts refuses it in words that say why.

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunEpoch;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use tokio::sync::oneshot;

use super::RunTurn;
use super::reports::{lift_account_wait, run_again};
use crate::engine::tick::live_runs::{LiveRun, LiveStep, ParkCanceledStep};

mod repin;

/// The reply to a person's Resume: `Ok` once the write that resumes the run commits, or why the
/// tick did not take it.
pub(crate) type RunResumeReply = oneshot::Sender<Result<(), RunResumeRefusal>>;

/// A person's Resume of a run, as it reaches the tick.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the run controls, which send it")
)]
pub(crate) struct RunResumeIntake {
    /// The run.
    pub(crate) run_id: WorkflowRunId,
    /// Where the answer goes.
    pub(crate) reply: RunResumeReply,
}

/// Why the tick did not take a person's Resume; each leaves the run as it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RunResumeRefusal {
    /// The tick does not hold the run, so its rows say why it cannot resume.
    NotHeld,
    /// Nothing waits on a Resume: the run is going, or its ending is decided.
    NotParked,
    /// The run waits only on a person's answer or its chain's question, which the answer lifts.
    AwaitsAnswer,
}

/// Takes the person's Resume `intake` of the run of `live` in `turn`: each step waiting on a spent
/// account leaves its wait now, its armed resume or none; on a failed park the run opens its next
/// execution, written as `workflow.run.resumed`, and each failed step and each step the park
/// canceled runs again as its next attempt on its own input, riding that event, while every other
/// wait stays. The reply waits for the turn's write.
pub(super) fn apply_resume(live: &mut LiveRun, turn: &mut RunTurn, intake: RunResumeIntake) {
    let RunResumeIntake { reply, .. } = intake;
    let account_waits = steps_where(live, |live_step| {
        live_step.status == WorkflowStepStatus::Waiting
            && live_step.wait_cause == Some(WorkflowWaitCause::Account)
            && !live_step.is_winding_down
    });
    let failed_parks = if live.is_parked_on_failure() {
        steps_where(live, |live_step| {
            live_step.status == WorkflowStepStatus::Failed
        })
    } else {
        Vec::new()
    };
    if live.ending.is_some() || (account_waits.is_empty() && failed_parks.is_empty()) {
        let is_awaiting_answer = live.ending.is_none()
            && !live.steps.is_empty()
            && live
                .steps
                .values()
                .all(|live_step| live_step.status == WorkflowStepStatus::Waiting);
        let refusal = if is_awaiting_answer {
            RunResumeRefusal::AwaitsAnswer
        } else {
            RunResumeRefusal::NotParked
        };
        let _unheard = reply.send(Err(refusal));
        return;
    }
    let at = WireInstant::now();
    for step in account_waits {
        lift_account_wait(live, turn, step, &at);
    }
    if !failed_parks.is_empty() {
        live.epoch = WorkflowRunEpoch(
            SafeInt::new(live.epoch.0.get() + 1)
                .expect("a run's executions are far below the largest safe integer"),
        );
        live.approval_pauses = 0;
        let resumed = turn.commit.resume_run(&at, live.epoch, failed_parks.len());
        for step in failed_parks {
            let LiveStep {
                inputs, input_ref, ..
            } = live
                .remove_step(step.execution_index.get())
                .expect("a failed park keeps its step live");
            run_again(live, turn, &step, (inputs, input_ref), resumed);
        }
        for ParkCanceledStep {
            step,
            inputs,
            input_ref,
        } in std::mem::take(&mut live.park_canceled)
        {
            run_again(live, turn, &step, (inputs, input_ref), resumed);
        }
        live.stop = None;
        turn.last_readying_event = Some((resumed, at));
    }
    turn.resume_replies.push(reply);
}

/// The live steps of `live` that `is_lifted` takes, in execution order.
fn steps_where(live: &LiveRun, is_lifted: impl Fn(&LiveStep) -> bool) -> Vec<WorkflowStepKey> {
    let mut steps: Vec<WorkflowStepKey> = live
        .steps
        .values()
        .filter(|live_step| is_lifted(live_step))
        .map(|live_step| live_step.step.clone())
        .collect();
    steps.sort_by_key(|step| step.execution_index.get());
    steps
}

#[cfg(test)]
pub(super) mod tests;
