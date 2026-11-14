//! A person's Resume in the tick's loop: each step waiting on a spent account resumed ahead of
//! its armed resume, and each step a failed park stopped run again as its next attempt, all in
//! the turn's one write; a run with nothing a Resume lifts refuses it in words that say why. A
//! Resume that asks for another version of the workflow moves a failed park there first: the run's
//! graph, walk and scope are rebuilt on that version, its unchanged steps kept and replayed.

use std::sync::Arc;

use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::WorkflowVersionId;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunEpoch;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_ipc::domain_error::DomainError;
use tokio::sync::oneshot;

use super::reports::{lift_account_wait, run_again};
use super::{EngineTick, RunTurn};
use crate::engine::tick::RunScope;
use crate::engine::tick::live_runs::{LiveRun, LiveStep, ParkCanceledStep};

mod repin;

pub(super) use self::repin::RepinTarget;
pub(crate) use self::repin::{REPIN_STATEMENT_CAPACITY, RepinReadError, RepinRefusal};

/// The reply to a person's Resume: once the write that resumes the run commits, the version the
/// run left where it moved to another, or why the tick did not take it.
pub(crate) type RunResumeReply =
    oneshot::Sender<Result<Option<WorkflowVersionId>, RunResumeRefusal>>;

/// A person's Resume of a run, as it reaches the tick.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the run controls, which send it")
)]
pub(crate) struct RunResumeIntake {
    /// The run.
    pub(crate) run_id: WorkflowRunId,
    /// The version of its workflow the person moves the run to, where they ask for one.
    pub(crate) version_repin: Option<WorkflowVersionId>,
    /// Where the answer goes.
    pub(crate) reply: RunResumeReply,
}

/// Why the tick did not take a person's Resume; each leaves the run as it was.
#[derive(Debug)]
pub(crate) enum RunResumeRefusal {
    /// The tick does not hold the run, so its rows say why it cannot resume.
    NotHeld,
    /// Nothing waits on a Resume: the run is going, or its ending is decided.
    NotParked,
    /// The run waits only on a person's answer or its chain's question, which the answer lifts.
    AwaitsAnswer,
    /// The run may not move to the version asked for.
    Repin(RepinRefusal),
    /// The version asked for is none of the run's workflow's, or a start would refuse its graph:
    /// the refusal that says why.
    Target(DomainError),
    /// The reads of the move did not finish.
    Unread(RepinReadError),
}

impl EngineTick {
    /// Takes the person's Resume `intake` of the run of `live` in `turn`: each step waiting on a
    /// spent account leaves its wait now, its armed resume or none; on a failed park the run opens
    /// its next execution, written as `workflow.run.resumed`, and each failed step and each step
    /// the park canceled runs again as its next attempt, riding that event, while every other wait
    /// stays. A Resume asking for another version moves the run there first, as
    /// [`EngineTick::repin_target`] allows, and the event names both versions. The reply waits for
    /// the turn's write.
    pub(super) async fn apply_resume(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        intake: RunResumeIntake,
    ) {
        let RunResumeIntake {
            reply,
            version_repin,
            ..
        } = intake;
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
        let repin = match version_repin {
            None => None,
            Some(target) => {
                let settled_in_turn = turn.commit.first_settled_step();
                match self.repin_target(live, settled_in_turn, target).await {
                    Ok(repin) => Some(repin),
                    Err(refusal) => {
                        let _unheard = reply.send(Err(refusal));
                        return;
                    }
                }
            }
        };
        let at = WireInstant::now();
        for step in account_waits {
            lift_account_wait(live, turn, step, &at);
        }
        let mut left_version = None;
        if !failed_parks.is_empty() {
            live.epoch = WorkflowRunEpoch(
                SafeInt::new(live.epoch.0.get() + 1)
                    .expect("a run's executions are far below the largest safe integer"),
            );
            live.approval_pauses = 0;
            let kept: Vec<WorkflowStepKey> = repin
                .iter()
                .flat_map(|repin| repin.kept.iter().map(|kept| kept.step.clone()))
                .collect();
            let joined = repin
                .as_ref()
                .map(|repin| (repin.workflow_version_id, kept.as_slice()));
            let resumed = turn
                .commit
                .resume_run(&at, live.epoch, failed_parks.len(), joined);
            turn.last_readying_event = Some((resumed, at.clone()));
            match repin {
                None => {
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
                }
                Some(repin) => {
                    left_version = Some(live.scope.workflow_version_id);
                    let park_canceled = std::mem::take(&mut live.park_canceled)
                        .into_iter()
                        .map(|canceled| canceled.step)
                        .collect();
                    move_run(live, repin, &failed_parks, park_canceled);
                    let opened = live.walk.start();
                    self.take_walk(live, turn, opened, (resumed, at)).await;
                }
            }
        }
        turn.resume_replies.push((reply, left_version));
    }
}

/// Moves the run of `live`, parked on its `failed_parks`, to `repin`'s version: its scope names
/// the version and holds its nodes, its walk is rebuilt on the version's graph, settling again the
/// steps the run keeps, whose outputs it holds, its outputs read by the version's labels, and each
/// failed step and each step the park canceled whose node the version holds runs again as its
/// next attempt when the walk readies it, as does each of `park_canceled`, the steps the park
/// canceled. The run is no longer stopped.
pub(super) fn move_run(
    live: &mut LiveRun,
    repin: RepinTarget,
    failed_parks: &[WorkflowStepKey],
    park_canceled: Vec<WorkflowStepKey>,
) {
    let RepinTarget {
        workflow_version_id,
        workflow_name,
        nodes,
        graph,
        covered,
        kept,
    } = repin;
    let mut again: Vec<WorkflowStepKey> = failed_parks
        .iter()
        .cloned()
        .chain(park_canceled)
        .filter(|step| nodes.contains_key(&step.node_id))
        .collect();
    again.sort_by_key(|step| step.execution_index.get());
    for step in failed_parks {
        live.remove_step(step.execution_index.get());
    }
    live.walk = live.walk.rebuilt(graph, covered, kept, &again);
    live.outputs.relabel(
        nodes
            .values()
            .map(|node| (node.id.clone(), node.name.as_str().to_owned())),
    );
    let scope = Arc::clone(&live.scope);
    live.scope = Arc::new(RunScope {
        session_id: scope.session_id,
        run_id: scope.run_id,
        workflow_id: scope.workflow_id,
        workflow_version_id,
        workflow_name,
        mode: scope.mode,
        retried_mode: scope.retried_mode,
        trigger: scope.trigger.clone(),
        node_params: Arc::new(
            nodes
                .iter()
                .map(|(node_id, node)| (node_id.clone(), node.params.clone()))
                .collect(),
        ),
        nodes,
        pins: scope.pins.clone(),
        run_started_at: scope.run_started_at,
        time_zone: scope.time_zone.clone(),
        environment_rows: Arc::clone(&scope.environment_rows),
        kept_values: Arc::clone(&scope.kept_values),
        project: scope.project,
        working_folder: scope.working_folder.clone(),
        is_bound: scope.is_bound,
        provider: scope.provider.clone(),
        redaction: Arc::clone(&scope.redaction),
        cancel: scope.cancel.clone(),
    });
    live.stop = None;
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
