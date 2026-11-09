//! The inbox path of the tick's loop: a person's answer routed to the run whose live step waits
//! under the wait it names, then made that step's resume and settlement in the run's turn, and
//! replied to once the turn's write commits; and a chain's `Keep going`, one read and one write
//! over every run it releases.

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowStepStatus;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};

use super::{EngineTick, RunTurn};
use crate::engine::chain::{
    ChainHeldStep, ChainQuestion, KEEP_GOING_STATEMENT_INDEX, KeepGoingIntake, keep_going_write,
    read_chain_held_steps, read_chain_question,
};
use crate::engine::event_record::EngineFault;
use crate::engine::tick::commit::{RunLiveStep, RunTurnCommit};
use crate::engine::tick::live_runs::LiveRun;
use crate::engine::tick::node_settings::main_inputs;
use crate::engine::tick::run_status::{RunPersonWait, RunStepCounts};
use crate::engine::waits::answers::{PersonWaitIntake, answered_step};
use crate::engine::waits::{PersonWaitRefusal, WaitingPersonStep};

/// Why a `Keep going`'s read failed.
#[derive(Debug, thiserror::Error)]
enum KeepGoingReadError {
    /// SQLite refused the read, or a stored value did not read as its type.
    #[error("a read of a chain's question or its held steps failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl EngineTick {
    /// Routes `intake` to the run whose live step waits under the wait it names, the run added
    /// to `order` where it is not there yet, by one scan of the live steps. An answer to a dropped
    /// run's wait is dropped unreplied, which its sender reads as not taken, since the wait may
    /// still hold after the restart; any other wait is answered not waiting at once.
    pub(super) fn route_answer(
        &self,
        intake: PersonWaitIntake,
        order: &mut Vec<WorkflowRunId>,
        answers: &mut HashMap<WorkflowRunId, Vec<PersonWaitIntake>>,
    ) {
        let waiting_run = self.runs.iter().find_map(|(run_id, live)| {
            live.steps
                .values()
                .any(|live_step| live_step.wait_id == Some(intake.wait_id))
                .then_some(*run_id)
        });
        match waiting_run {
            Some(run_id) => {
                if !order.contains(&run_id) {
                    order.push(run_id);
                }
                answers.entry(run_id).or_default().push(intake);
            }
            None if self.dropped_waits.contains(&intake.wait_id) => drop(intake),
            None => {
                let _unheard = intake.reply.send(Err(PersonWaitRefusal::NotWaiting));
            }
        }
    }

    /// Applies `intake` to the run of `live` in `turn`: the step still waiting under its wait
    /// resumes, and the answer's settlement settles it in the same pass, its reply kept for the
    /// write's commit. A refused answer, or one whose step an earlier report settled, is answered
    /// not waiting at once; a refused answer to a wait with a deadline has the clock read again,
    /// so a deadline it came after fires.
    pub(super) async fn apply_answer(
        &self,
        live: &mut LiveRun,
        turn: &mut RunTurn,
        intake: PersonWaitIntake,
    ) {
        let Some(live_step) = live
            .steps
            .values()
            .find(|live_step| live_step.wait_id == Some(intake.wait_id))
        else {
            let _unheard = intake.reply.send(Err(PersonWaitRefusal::NotWaiting));
            return;
        };
        let waiting = WaitingPersonStep {
            step: live_step.step.clone(),
            wait_id: intake.wait_id,
            cause: live_step
                .wait_cause
                .expect("a step under a person wait waits on its cause"),
            deadline_at: live_step.wait_deadline_at.clone(),
        };
        let node = live
            .scope
            .nodes
            .get(&waiting.step.node_id)
            .expect("a step's node is the run's");
        // The one copy an answer makes: the items it settles the step with.
        let input = main_inputs(self.spec(node), &live_step.inputs)
            .next()
            .cloned()
            .unwrap_or_default();
        match answered_step(&waiting, &intake, input) {
            Ok(answered) => {
                let report = answered.resume(&mut turn.commit);
                live.move_step(
                    waiting.step.execution_index.get(),
                    WorkflowStepStatus::Running,
                    None,
                );
                self.apply_report(live, turn, report).await;
                turn.replies.push(intake.reply);
            }
            Err(refusal) => {
                let _unheard = intake.reply.send(Err(refusal));
                if waiting.deadline_at.is_some() {
                    live.needs_deadline_read = true;
                }
            }
        }
    }

    /// Writes `intake`'s `Keep going` in one write over the chain's first run and every live run
    /// holding a step behind its question, each held step moved to `running`, and replies once it
    /// commits. A chain with no question left to answer, or a first run neither live nor stored,
    /// is answered not waiting; a failed read or write leaves the reply unsent, which its sender
    /// reads as not taken, and is recorded. Held steps of runs the tick does not drive are left for
    /// the restart to settle.
    pub(super) async fn keep_going(&mut self, intake: KeepGoingIntake) {
        let KeepGoingIntake { answer, at, reply } = intake;
        let root = answer.root();
        let is_root_live = self.runs.contains_key(&root);
        let read = self
            .pool
            .read(ReadLength::Short, move |connection| {
                read_keep_going(connection, &root, is_root_live)
            })
            .await;
        let (mut held, question) = match read {
            Ok(read) => read,
            Err(error) => {
                self.record_keep_going_failure(root, &[], &error).await;
                return;
            }
        };
        held.retain(|held_step| self.runs.contains_key(&held_step.step.workflow_run_id));
        let mut run_ids = vec![root];
        for held_step in &held {
            if !run_ids.contains(&held_step.step.workflow_run_id) {
                run_ids.push(held_step.step.workflow_run_id);
            }
        }
        let mut commits = Vec::with_capacity(run_ids.len());
        for run_id in &run_ids {
            let commit = match (self.runs.get(run_id), &question) {
                (Some(live), _) => RunTurnCommit::new(
                    live.event_keys(),
                    *run_id,
                    live.counts,
                    live.person_wait.clone(),
                    Arc::clone(&self.payloads),
                ),
                // A first run the tick does not drive writes no run event.
                (None, Some(question)) => RunTurnCommit::new(
                    question.keys,
                    *run_id,
                    RunStepCounts::default(),
                    RunPersonWait::default(),
                    Arc::clone(&self.payloads),
                ),
                (None, None) => {
                    let _unheard = reply.send(Err(PersonWaitRefusal::NotWaiting));
                    return;
                }
            };
            commits.push(commit);
        }
        let commits = keep_going_write(&answer, commits, &held, &at);
        // The write answers each turn in the order it was handed.
        let written: Vec<WorkflowRunId> = commits.iter().map(RunTurnCommit::run_id).collect();
        let writes = commits
            .into_iter()
            .map(|commit| match self.runs.get(&commit.run_id()) {
                Some(live) => {
                    // A held step goes in as the write moves it, running with no cause.
                    let live_steps = live
                        .live_steps()
                        .map(|live_step| {
                            if held
                                .iter()
                                .any(|held_step| held_step.step == *live_step.step)
                            {
                                RunLiveStep {
                                    status: WorkflowStepStatus::Running,
                                    wait_cause: None,
                                    ..live_step
                                }
                            } else {
                                live_step
                            }
                        })
                        .collect();
                    (commit, live_steps, Some(&live.record))
                }
                None => (commit, Vec::new(), None),
            })
            .collect();
        let committed = match RunTurnCommit::append_together(writes, &self.appender).await {
            Ok(committed) => committed,
            Err(failure) => {
                if failure.error.refused_statement_index() == Some(KEEP_GOING_STATEMENT_INDEX) {
                    let _unheard = reply.send(Err(PersonWaitRefusal::NotWaiting));
                } else {
                    // Keep going stores no payload, so the write names no artifact to delete.
                    self.record_keep_going_failure(root, &run_ids, &failure.error)
                        .await;
                }
                return;
            }
        };
        for (run_id, committed) in written.into_iter().zip(committed) {
            if let Some(live) = self.runs.get_mut(&run_id) {
                live.counts = committed.counts;
                live.person_wait = committed.person_wait;
            }
        }
        for held_step in &held {
            if let Some(live) = self.runs.get_mut(&held_step.step.workflow_run_id) {
                live.move_step(
                    held_step.step.execution_index.get(),
                    WorkflowStepStatus::Running,
                    None,
                );
            }
        }
        let _unheard = reply.send(Ok(()));
    }

    /// Records the failed `Keep going` of the chain whose first run is `root`, `error`, on the
    /// first run's record, or else on that of the first live run of `run_ids`; with neither live
    /// it goes to the service log.
    async fn record_keep_going_failure(
        &self,
        root: WorkflowRunId,
        run_ids: &[WorkflowRunId],
        error: &(dyn Error + Send + Sync + 'static),
    ) {
        let live = self
            .runs
            .get(&root)
            .or_else(|| run_ids.iter().find_map(|run_id| self.runs.get(run_id)));
        if let Some(live) = live {
            live.record
                .fault(None, EngineFault::KeepGoingFailed, error)
                .await;
        } else {
            tracing::warn!(
                workflow_run_id = %root,
                error = error as &(dyn Error + 'static),
                "a Keep going could not be read or written"
            );
        }
    }
}

/// Keep going's read for the chain whose first run is `root`: the steps held behind its question,
/// and, when the first run is not live, the question, which names the first run's keys.
fn read_keep_going(
    connection: &Connection,
    root: &WorkflowRunId,
    is_root_live: bool,
) -> Result<(Vec<ChainHeldStep>, Option<ChainQuestion>), KeepGoingReadError> {
    let held = read_chain_held_steps(connection, root)?;
    let question = if is_root_live {
        None
    } else {
        read_chain_question(connection, root)?
    };
    Ok((held, question))
}

#[cfg(test)]
mod tests;
