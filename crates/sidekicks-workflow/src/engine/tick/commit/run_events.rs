//! The run's own share of a turn's write: the status its steps leave it in, stored with its
//! person-wait columns and recorded by the run event the move implies, the write's last, or the
//! run's ending in its place; and the two moves that take a step out of a wait, a gate's answer
//! and the step's resume, which a person's answer and Keep going share.

use std::borrow::Cow;

use rusqlite::types::Value;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::events::{
    WorkflowResumedStep, WorkflowResumptionPoint, WorkflowRunCanceledPayload,
    WorkflowRunCompletedPayload, WorkflowRunEndingStep, WorkflowRunFailedOutcome,
    WorkflowRunFailedPayload, WorkflowRunResumedPayload, WorkflowRunWaitingPayload,
};
use sidekicks_contracts::workflow::run::snapshot::WorkflowRunEpoch;
use sidekicks_contracts::workflow::run::status::{
    WorkflowRunStatus, WorkflowStepStatus, WorkflowWaitCause,
};
use sidekicks_contracts::workflow::run::step::events::WorkflowPhaseResumedPayload;
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

use super::{RunEnding, RunTurnCommit};
use crate::engine::results::results_posted_event;
use crate::engine::tick::run_status::{
    GoingRunStatus, RunStatusChange, going_run_status, person_wait_after, run_status_change,
};
use crate::runs::gate_resolution::{WorkflowGateAnswer, gate_resolved_payload};
use crate::runs::record::end_run_statements;
use crate::runs::step_rows;

// Only a going or parked run's status moves here; an ended run's row is never written again.
const RUN_STATUS_SQL: &str = "UPDATE workflow_runs SET status = @status,
    person_wait_since = @person_wait_since, person_wait_ms = @person_wait_ms
  WHERE id = @id AND finished_at IS NULL";

/// A step of the run the tick keeps live after the turn, as a resumption point names it.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(not(test), expect(dead_code, reason = "the daemon's workflow engine"))]
pub(crate) struct RunLiveStep<'tick> {
    /// The step.
    pub(crate) step: &'tick WorkflowStepKey,
    /// Where it stands.
    pub(crate) status: WorkflowStepStatus,
    /// What it waits on, while it is `waiting`.
    pub(crate) wait_cause: Option<WorkflowWaitCause>,
}

impl RunTurnCommit {
    /// Writes `statements`, a gate answer's row and what its write guards, then `answer`'s
    /// `workflow.gate.resolved` at `at`; the answer is recorded once the write commits.
    pub(crate) fn answer_gate(
        &mut self,
        answer: &WorkflowGateAnswer,
        statements: Vec<WriteStatement>,
        at: &WireInstant,
    ) {
        self.statements.extend(statements);
        self.push(
            at,
            SessionEvent::WorkflowGateResolved(gate_resolved_payload(answer, self.keys)),
        );
        self.gates.push((answer.outcome, answer.node_id.clone()));
    }

    /// Resumes `step`, waiting on `cause` under `wait_id` (`None` for a wait with no id), at `at`:
    /// its row back to `running` with its wait cleared, refusing the write where the row no
    /// longer holds that wait, and `workflow.phase.resumed`.
    pub(crate) fn resume_step(
        &mut self,
        step: &WorkflowStepKey,
        wait_id: Option<&UuidTextForm>,
        cause: WorkflowWaitCause,
        at: &WireInstant,
    ) {
        self.statements.push(step_rows::resume_step(step, wait_id));
        let session_id = self.keys.session_id;
        self.push(
            at,
            SessionEvent::WorkflowPhaseResumed(step_payload!(
                WorkflowPhaseResumedPayload,
                session_id,
                step,
            )),
        );
        self.counts.moved(
            Some((WorkflowStepStatus::Waiting, Some(cause))),
            (WorkflowStepStatus::Running, None),
        );
    }

    /// Writes a person's Resume at `at` as `workflow.run.resumed` opening the run's execution
    /// `epoch`, lifting `lifted_parks` failed parks; the steps it runs again ride it, and the
    /// turn's status move fills in where the run picks up. Answers the event's index.
    pub(crate) fn resume_run(
        &mut self,
        at: &WireInstant,
        epoch: WorkflowRunEpoch,
        lifted_parks: usize,
    ) -> usize {
        for _ in 0..lifted_parks {
            self.counts.unparked();
        }
        self.epoch = epoch;
        self.push(
            at,
            SessionEvent::WorkflowRunResumed(run_payload!(
                WorkflowRunResumedPayload,
                self.keys,
                self.run_id,
                epoch: epoch,
                resumption_point: WorkflowResumptionPoint {
                    active_steps: Vec::new(),
                    pending_gates: Vec::new(),
                },
                repinned_from_workflow_version_id: None,
                repinned_to_workflow_version_id: None,
                readied: Vec::new(),
            )),
        );
        let resumed = self.events.len() - 1;
        self.resumed_event = Some(resumed);
        resumed
    }

    /// Adds the run's status move to the turn, at the instant of its last event: the run event
    /// the move implies as the turn's last event, and the statement that stores the status and
    /// the person-wait columns after every other, written only where either changes. A run whose
    /// steps all settled writes nothing, its ending deciding what follows. Answers the status
    /// stored, where it moved.
    pub(super) fn add_run_status_move<'tick>(
        &mut self,
        live_steps: impl IntoIterator<Item = RunLiveStep<'tick>>,
    ) -> Option<WorkflowRunStatus> {
        let at = self.events.last()?.at.clone();
        let after = going_run_status(&self.counts);
        let stored = stored_run_status(after)?;
        // A first admission moves the run to running with no event of its own, so a turn that
        // admits and then waits or parks moves from running.
        let moved_from = if self.status_before == GoingRunStatus::New {
            GoingRunStatus::Running
        } else {
            self.status_before
        };
        let change = run_status_change(moved_from, after);
        let had_open_wait = self.person_wait.since.is_some();
        let total_before = self.person_wait.total_ms;
        self.person_wait = person_wait_after(
            std::mem::take(&mut self.person_wait),
            change,
            false,
            self.counts.account_waits,
            &at,
        );
        let is_status_moved = after != self.status_before;
        if !is_status_moved
            && self.person_wait.since.is_some() == had_open_wait
            && self.person_wait.total_ms == total_before
        {
            return None;
        }
        match (change, self.resumed_event) {
            // A person's Resume already wrote the event; only where the run picks up is new.
            (Some(RunStatusChange::Resumed), Some(resumed)) => {
                let point = self.resumption_point(live_steps);
                if let SessionEvent::WorkflowRunResumed(payload) = &mut self.events[resumed].event {
                    payload.resumption_point = point;
                }
            }
            (Some(change), _) => {
                let event = self.run_event(change, live_steps);
                self.push(&at, event);
            }
            (None, _) => {}
        }
        self.statements.push(self.run_status_statement(stored));
        is_status_moved.then_some(stored)
    }

    /// Adds the run's `ending` to the turn, at the instant of its last event, or now where the
    /// turn has none: its run event, then the results event where the run posts them, as the
    /// turn's last, the open wait on people closed, and the statement that ends the row after every
    /// other. Answers the status stored and the index of the ending's event.
    pub(super) fn add_run_ending(&mut self, ending: RunEnding) -> (WorkflowRunStatus, usize) {
        let at = self
            .events
            .last()
            .map_or_else(WireInstant::now, |turn_event| turn_event.at.clone());
        self.person_wait = person_wait_after(
            std::mem::take(&mut self.person_wait),
            None,
            true,
            self.counts.account_waits,
            &at,
        );
        let (status, error, event) = match ending {
            RunEnding::Completed => (
                WorkflowRunStatus::Succeeded,
                None,
                SessionEvent::WorkflowRunCompleted(run_payload!(
                    WorkflowRunCompletedPayload,
                    self.keys,
                    self.run_id,
                )),
            ),
            RunEnding::Failed { step, error } => (
                WorkflowRunStatus::Failed,
                Some(error.clone()),
                SessionEvent::WorkflowRunFailed(run_payload!(
                    WorkflowRunFailedPayload,
                    self.keys,
                    self.run_id,
                    outcome: WorkflowRunFailedOutcome::Ended,
                    ending_step: Some(WorkflowRunEndingStep {
                        node_id: step.node_id,
                        attempt: step.attempt,
                        execution_index: step.execution_index,
                    }),
                    error: Some(error),
                )),
            ),
            RunEnding::Canceled { reason, error } => (
                WorkflowRunStatus::Canceled,
                error.clone(),
                SessionEvent::WorkflowRunCanceled(run_payload!(
                    WorkflowRunCanceledPayload,
                    self.keys,
                    self.run_id,
                    reason: reason,
                    error: error,
                )),
            ),
        };
        self.push(&at, event);
        let ending_event = self.events.len() - 1;
        if self.posts_results {
            // The tick's live run keeps no summary line to post.
            let posted = results_posted_event(self.keys.session_id, self.run_id, None);
            self.push(&at, posted);
        }
        self.statements
            .extend(end_run_statements(self.run_id, status, &at, error.as_ref()));
        (status, ending_event)
    }

    /// The run event of `change`; a resume names where the run picks up from `live_steps` and the
    /// steps this turn readied.
    fn run_event<'tick>(
        &self,
        change: RunStatusChange,
        live_steps: impl IntoIterator<Item = RunLiveStep<'tick>>,
    ) -> SessionEvent {
        match change {
            RunStatusChange::Waiting => SessionEvent::WorkflowRunWaiting(run_payload!(
                WorkflowRunWaitingPayload,
                self.keys,
                self.run_id,
            )),
            RunStatusChange::Resumed => SessionEvent::WorkflowRunResumed(run_payload!(
                WorkflowRunResumedPayload,
                self.keys,
                self.run_id,
                epoch: self.epoch,
                resumption_point: self.resumption_point(live_steps),
                repinned_from_workflow_version_id: None,
                repinned_to_workflow_version_id: None,
                readied: Vec::new(),
            )),
            RunStatusChange::FailedPark => SessionEvent::WorkflowRunFailed(run_payload!(
                WorkflowRunFailedPayload,
                self.keys,
                self.run_id,
                outcome: WorkflowRunFailedOutcome::Parked,
                ending_step: None,
                error: None,
            )),
        }
    }

    /// Where a resumed run picks up: its steps running, held for memory or pending, this turn's
    /// readied ones among them, in execution order, and the approval steps still waiting.
    fn resumption_point<'tick>(
        &self,
        live_steps: impl IntoIterator<Item = RunLiveStep<'tick>>,
    ) -> WorkflowResumptionPoint {
        let mut active: Vec<&WorkflowStepKey> = Vec::new();
        let mut pending_gates: Vec<&WorkflowStepKey> = Vec::new();
        for live in live_steps {
            match live.status {
                WorkflowStepStatus::Running
                | WorkflowStepStatus::WaitingMemory
                | WorkflowStepStatus::Pending => active.push(live.step),
                WorkflowStepStatus::Waiting
                    if live.wait_cause == Some(WorkflowWaitCause::Approval) =>
                {
                    pending_gates.push(live.step);
                }
                WorkflowStepStatus::Waiting
                | WorkflowStepStatus::Succeeded
                | WorkflowStepStatus::Failed
                | WorkflowStepStatus::Skipped
                | WorkflowStepStatus::Canceled => {}
            }
        }
        active.extend(self.pending.iter().map(|(step, _)| step));
        active.sort_by_key(|step| step.execution_index);
        pending_gates.sort_by_key(|step| step.execution_index);
        WorkflowResumptionPoint {
            active_steps: active
                .into_iter()
                .map(|step| WorkflowResumedStep {
                    node_id: step.node_id.clone(),
                    attempt: step.attempt,
                    execution_index: step.execution_index,
                })
                .collect(),
            pending_gates: pending_gates
                .into_iter()
                .map(|step| step.node_id.clone())
                .collect(),
        }
    }

    /// The statement that stores `status` and the turn's person-wait columns on the run's row,
    /// refusing the write unless the run is still going or parked.
    fn run_status_statement(&self, status: WorkflowRunStatus) -> WriteStatement {
        WriteStatement {
            sql: Cow::Borrowed(RUN_STATUS_SQL),
            bindings: StatementBindings::Named(vec![
                text_binding("@status", <&'static str>::from(status)),
                nullable_text_binding(
                    "@person_wait_since",
                    self.person_wait.since.as_ref().map(WireInstant::as_str),
                ),
                (
                    Cow::Borrowed("@person_wait_ms"),
                    // No run waits the 292 million years past which the milliseconds overflow.
                    Value::Integer(i64::try_from(self.person_wait.total_ms).unwrap_or(i64::MAX)),
                ),
                text_binding("@id", self.run_id.text().as_str()),
            ]),
            expected_row_count: Some(1),
        }
    }
}

/// The status a run row stores for `status`; `None` for a run whose steps all settled, which its
/// ending stores.
fn stored_run_status(status: GoingRunStatus) -> Option<WorkflowRunStatus> {
    match status {
        GoingRunStatus::New => Some(WorkflowRunStatus::New),
        GoingRunStatus::Running => Some(WorkflowRunStatus::Running),
        GoingRunStatus::Waiting => Some(WorkflowRunStatus::Waiting),
        GoingRunStatus::FailedPark => Some(WorkflowRunStatus::Failed),
        GoingRunStatus::Settled => None,
    }
}

#[cfg(test)]
mod tests;
