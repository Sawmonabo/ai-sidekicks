//! The restart's ending of a run that cannot be driven again: its version or its log no longer
//! reads, so it ends crashed with the reason in one write that cancels each unsettled step on an
//! event of its own, with every agent run its steps made stopped and every card withdrawn.

use std::sync::Arc;

use sidekicks_contracts::question::QuestionWaitOutcome;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::item::WorkflowStepError;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunEpoch;
use sidekicks_contracts::workflow::run::status::{WorkflowStepStatus, WorkflowWaitCause};

use crate::engine::event_record::EngineFault;
use crate::engine::start::ReloadedStep;
use crate::engine::tick::commit::{RunEnding, RunLiveStep, RunTurnCommit};
use crate::engine::tick::run_status::{RunPersonWait, RunStepCounts};
use crate::engine::tick::turns::EngineTick;
use crate::engine::waits::withdraw_cards;
use crate::runs::gate_resolution::RunEventKeys;
use crate::secrets::redaction::RunRedaction;

/// A reloaded run that cannot be driven again: what its crashed ending writes.
pub(super) struct UnrunnableRun<'run> {
    /// The session, definition and version its events name.
    pub(super) keys: RunEventKeys,
    /// The run.
    pub(super) run_id: WorkflowRunId,
    /// Whether its row had left `new`.
    pub(super) is_admitted: bool,
    /// Its person-wait columns as its row stores them.
    pub(super) person_wait: RunPersonWait,
    /// Whether its mode posts its results at its end.
    pub(super) posts_results: bool,
    /// Its execution as its newest Resume left it.
    pub(super) epoch: WorkflowRunEpoch,
    /// Its steps' rows.
    pub(super) steps: &'run [ReloadedStep],
}

impl EngineTick {
    /// Ends `run`, which cannot be driven again, crashed with `error` in one write that cancels
    /// each unsettled step on a `workflow.step.canceled` of its own and settles the question a
    /// form's or a reply's wait holds; then stops each agent run a running, held or account-parked
    /// step made, which the queue's recovery would start again, and withdraws each approval's
    /// card. A refused write leaves its rows for the next restart, off the clock.
    pub(super) async fn end_unrunnable(
        &mut self,
        run: UnrunnableRun<'_>,
        error: WorkflowStepError,
    ) {
        let UnrunnableRun {
            keys,
            run_id,
            is_admitted,
            person_wait,
            posts_results,
            epoch,
            steps,
        } = run;
        let record = self
            .recorder
            .for_run(run_id, Arc::new(RunRedaction::new(&[])));
        let unsettled: Vec<&ReloadedStep> = steps.iter().filter(|row| is_kept_row(row)).collect();
        let mut counts = RunStepCounts::default();
        for row in &unsettled {
            counts.moved(None, (row.status, row.wait_cause));
        }
        if is_admitted {
            counts.admitted();
        }
        let session_id = keys.session_id;
        let mut commit = RunTurnCommit::new(
            keys,
            run_id,
            epoch,
            counts,
            person_wait,
            Arc::clone(&self.payloads),
        );
        let now = WireInstant::now();
        let mut cards = Vec::new();
        for row in &unsettled {
            commit.canceled_at_restart(&row.step, &now, (row.status, row.wait_cause));
            let Some(wait_id) = row.wait_id else {
                continue;
            };
            match row.wait_cause {
                Some(WorkflowWaitCause::Form | WorkflowWaitCause::Reply) => {
                    commit.settle_wait_question(&wait_id, QuestionWaitOutcome::Ended, &now);
                }
                Some(WorkflowWaitCause::Approval) => cards.push((row.step.clone(), wait_id)),
                Some(WorkflowWaitCause::Account | WorkflowWaitCause::Chain) | None => {}
            }
        }
        commit.end(RunEnding::Crashed { error: Some(error) }, posts_results);
        match commit
            .append(
                &self.appender,
                &record,
                std::iter::empty::<RunLiveStep<'_>>(),
            )
            .await
        {
            Ok(_) => {
                self.binder.note_context_changed(session_id);
                if let Err(error) = self.binder.sweep_released_run(session_id).await {
                    let fault = EngineFault::RemovedTreeSweepFailed;
                    record.fault(None, fault, &error).await;
                }
                for row in unsettled.iter().filter(|row| has_agent_run(row)) {
                    self.dispatch.stop_stored_run(&record, &row.step).await;
                }
                withdraw_cards(self.person_waits.cards.as_ref(), &record, session_id, cards).await;
            }
            Err(failure) => {
                self.deadlines.skip_run(run_id);
                self.dropped_waits
                    .extend(unsettled.iter().filter_map(|row| row.wait_id));
                record
                    .fault(None, EngineFault::TurnWriteFailed, &failure.error)
                    .await;
            }
        }
        self.recorder.end_run(run_id);
    }
}

/// Whether `row` is a step the run still has to settle.
pub(super) fn is_kept_row(row: &ReloadedStep) -> bool {
    matches!(
        row.status,
        WorkflowStepStatus::Pending
            | WorkflowStepStatus::WaitingMemory
            | WorkflowStepStatus::Running
            | WorkflowStepStatus::Waiting
    )
}

/// Whether the step of `row` may have made an agent run the queue's recovery starts again: it ran,
/// was held at the memory gate, or was parked on a spent account; a step still pending can be
/// between its run's making and its hold.
fn has_agent_run(row: &ReloadedStep) -> bool {
    match row.status {
        WorkflowStepStatus::Pending
        | WorkflowStepStatus::WaitingMemory
        | WorkflowStepStatus::Running => true,
        WorkflowStepStatus::Waiting => row.wait_cause == Some(WorkflowWaitCause::Account),
        WorkflowStepStatus::Succeeded
        | WorkflowStepStatus::Failed
        | WorkflowStepStatus::Skipped
        | WorkflowStepStatus::Canceled => false,
    }
}
