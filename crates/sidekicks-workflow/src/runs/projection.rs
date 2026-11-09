//! The run and step tables as the log keeps them in step: each run's row from its
//! `workflow.run.started`, its chain's count from each `workflow.chain.runJoined`, its Keep mark,
//! status, person wait and ending from its run events, and each step's row from the step and phase
//! events that move it. A rebuild writes every row at the event's own instant through the live
//! writes' own statements and guards, so the rows it writes are the rows the live writes wrote. A
//! run's execution context, gate answers and form drafts are no projection and stay as they are.

use std::borrow::Cow;
use std::collections::HashMap;

use rusqlite::types::Value;
use sidekicks_contracts::approval::ApprovalDecision;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::run::events::{
    WorkflowRunFailedOutcome, WorkflowRunFailedPayload, WorkflowRunStartedPayload,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::{WorkflowRunStatus, WorkflowWaitCause};
use sidekicks_contracts::workflow::run::step::events::{
    WorkflowPhaseSuspendedPayload, WorkflowReadiedStep,
};
use sidekicks_contracts::workflow::run::step::record::WorkflowStepKey;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement};
use sidekicks_store::events::projection::{
    ProjectionContradiction, SessionProjection, SessionProjectionFold,
};

use crate::engine::chain::kept_going_statement;
use crate::engine::tick::run_status::{
    RunPersonWait, RunStatusChange, person_wait_after, run_status_statement, run_version_statement,
    whole_milliseconds_between,
};
use crate::runs::cancellation::cancel_steps_statement;
use crate::runs::creation::{
    WorkflowRunCreation, count_chain_run_statement, run_row_statement, trigger_step_statement,
};
use crate::runs::deletion::keep::keep_statement;
use crate::runs::deletion::workflow_run_deletion_statements;
use crate::runs::record::end_run_row_statement;
use crate::runs::step_payload::stored_output_lengths;
use crate::runs::step_rows::{
    FailedStepRow, add_step_pool_wait, admit_step, cancel_step, fail_step, hold_step,
    insert_pending_step, insert_skipped_step, record_step_start, resume_step, succeed_step,
    wait_step_on_account, wait_step_on_chain, wait_step_on_person,
};

// Steps first, so the foreign key to their run holds.
const CLEAR_STEPS_SQL: &str = "DELETE FROM workflow_steps
  WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE session_id = ?)";

// A run a gate answer or a form draft names stays, since those rows are no projection and keep
// naming it; its `workflow.run.started` writes over it.
const CLEAR_RUNS_SQL: &str = "DELETE FROM workflow_runs WHERE session_id = ?
    AND NOT EXISTS (SELECT 1 FROM workflow_gate_resolutions AS gate
      WHERE gate.workflow_run_id = workflow_runs.id)
    AND NOT EXISTS (SELECT 1 FROM human_phase_form_state AS form
      WHERE form.workflow_run_id = workflow_runs.id)";

// Every type that moves a row; the others (a phase started, progressed, canceling, completed or
// failed, a join's branches canceled, a gate reached, results posted, a version, a trigger or a
// schedule) write no run or step row.
const WORKFLOW_RUN_EVENT_TYPES: [SessionEventType; 21] = [
    SessionEventType::WorkflowRunStarted,
    SessionEventType::WorkflowChainRunJoined,
    SessionEventType::WorkflowRunKeepChanged,
    SessionEventType::WorkflowRunDeleted,
    SessionEventType::WorkflowRunWaiting,
    SessionEventType::WorkflowRunResumed,
    SessionEventType::WorkflowRunFailed,
    SessionEventType::WorkflowRunCompleted,
    SessionEventType::WorkflowRunCanceled,
    SessionEventType::WorkflowRunCrashed,
    SessionEventType::WorkflowGateResolved,
    SessionEventType::WorkflowPhaseWaitingOnPool,
    SessionEventType::WorkflowPhaseAdmitted,
    SessionEventType::WorkflowPhaseSuspended,
    SessionEventType::WorkflowPhaseResumed,
    SessionEventType::WorkflowPhaseRetried,
    SessionEventType::WorkflowStepStarted,
    SessionEventType::WorkflowStepCompleted,
    SessionEventType::WorkflowStepFailed,
    SessionEventType::WorkflowStepCanceled,
    SessionEventType::WorkflowStepSkipped,
];

/// The `workflow_runs` and `workflow_steps` rows of a session as a rebuild replaces them.
#[derive(Clone, Copy, Debug)]
pub struct WorkflowRunsProjection;

impl SessionProjection for WorkflowRunsProjection {
    fn name(&self) -> &'static str {
        "workflowRuns"
    }

    fn event_types(&self) -> &[SessionEventType] {
        &WORKFLOW_RUN_EVENT_TYPES
    }

    fn clear_statements(&self, session_id: &SessionId) -> Vec<WriteStatement> {
        [CLEAR_STEPS_SQL, CLEAR_RUNS_SQL]
            .into_iter()
            .map(|sql| WriteStatement {
                sql: Cow::Borrowed(sql),
                bindings: StatementBindings::Positional(vec![Value::Text(
                    session_id.text().as_str().to_owned(),
                )]),
                expected_row_count: None,
            })
            .collect()
    }

    fn fold(&self, _session_id: &SessionId) -> Box<dyn SessionProjectionFold> {
        Box::new(WorkflowRunsFold::default())
    }
}

// What the fold keeps of each run and step that its events alone do not carry.
#[derive(Default)]
struct WorkflowRunsFold {
    runs: HashMap<WorkflowRunId, RunFold>,
    steps: HashMap<(WorkflowRunId, u64), StepFold>,
}

// A run not yet ended: its stored status, `failed` for one parked on a failed step, and its
// person-wait columns.
struct RunFold {
    status: WorkflowRunStatus,
    person_wait: RunPersonWait,
}

// A step's open wait, its id where a person answers it, its memory hold's last report while the
// gate holds it, and the sequence its last hold's reports name, which tells a new hold apart.
#[derive(Default)]
struct StepFold {
    wait_cause: Option<WorkflowWaitCause>,
    wait_id: Option<UuidTextForm>,
    last_hold_report_at: Option<WireInstant>,
    hold_since_seq: Option<SafeInt<0>>,
}

/// The key of the step a step event's members name.
macro_rules! step_key {
    ($payload:expr) => {
        WorkflowStepKey {
            workflow_run_id: $payload.workflow_run_id,
            node_id: $payload.node_id.clone(),
            attempt: $payload.attempt,
            execution_index: $payload.execution_index,
        }
    };
}
pub(crate) use step_key;

impl SessionProjectionFold for WorkflowRunsFold {
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "the fold reads only the types it names, and every other event moves no row"
    )]
    fn apply(
        &mut self,
        envelope: &EventEnvelope,
        event: &SessionEvent,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        let at =
            WireInstant::try_from(envelope.occurred_at.as_str().to_owned()).map_err(|refusal| {
                ProjectionContradiction(format!("the event's instant does not read: {refusal}"))
            })?;
        match event {
            SessionEvent::WorkflowRunStarted(started) => self.start(started, at, statements),
            SessionEvent::WorkflowChainRunJoined(joined) => {
                statements.push(count_chain_run_statement(&joined.chain_root_run_id, None));
            }
            SessionEvent::WorkflowRunKeepChanged(changed) => {
                statements.push(keep_statement(changed.workflow_run_id, changed.kept));
            }
            SessionEvent::WorkflowRunDeleted(deleted) => {
                let run_id = deleted.workflow_run_id;
                self.runs.remove(&run_id);
                self.steps
                    .retain(|(step_run_id, _), _| *step_run_id != run_id);
                statements.extend(workflow_run_deletion_statements(&[run_id]));
            }
            SessionEvent::WorkflowRunWaiting(waiting) => self.move_run(
                waiting.workflow_run_id,
                RunStatusChange::Waiting,
                &at,
                statements,
            )?,
            SessionEvent::WorkflowRunResumed(resumed) => {
                let run_id = resumed.workflow_run_id;
                if let Some(joined) = resumed.repinned_to_workflow_version_id {
                    statements.push(run_version_statement(run_id, joined));
                }
                self.move_run(run_id, RunStatusChange::Resumed, &at, statements)?;
                ready(run_id, &resumed.readied, &at, statements);
            }
            SessionEvent::WorkflowRunFailed(failed) => self.fail_run(failed, &at, statements)?,
            SessionEvent::WorkflowRunCompleted(completed) => {
                self.end_run(completed.workflow_run_id);
                statements.push(end_run_row_statement(
                    completed.workflow_run_id,
                    WorkflowRunStatus::Succeeded,
                    &at,
                    None,
                ));
            }
            SessionEvent::WorkflowRunCanceled(canceled) => {
                let run_id = canceled.workflow_run_id;
                self.end_run(run_id);
                statements.push(end_run_row_statement(
                    run_id,
                    WorkflowRunStatus::Canceled,
                    &at,
                    canceled.error.as_ref(),
                ));
                statements.push(cancel_steps_statement(run_id, &at));
            }
            SessionEvent::WorkflowRunCrashed(crashed) => {
                self.end_run(crashed.workflow_run_id);
                statements.push(end_run_row_statement(
                    crashed.workflow_run_id,
                    WorkflowRunStatus::Crashed,
                    &at,
                    crashed.error.as_ref(),
                ));
                statements.push(cancel_steps_statement(crashed.workflow_run_id, &at));
            }
            SessionEvent::WorkflowGateResolved(resolved) => {
                // A chain's question answered Keep going; a node's answer moves no run or step row.
                if resolved.node_id.is_none()
                    && matches!(resolved.outcome, ApprovalDecision::Approved)
                {
                    statements.push(kept_going_statement(&resolved.workflow_run_id));
                }
            }
            SessionEvent::WorkflowPhaseWaitingOnPool(waiting) => {
                let step = step_key!(waiting);
                let held = self.step(&step);
                // A report naming another sequence than the open hold's starts a new hold, as a
                // restart's sweep does for a step the daemon's stop held, so no stopped time is
                // counted.
                let is_new_hold = held.hold_since_seq.replace(waiting.waiting_since_seq)
                    != Some(waiting.waiting_since_seq);
                statements.push(match held.last_hold_report_at.replace(at.clone()) {
                    Some(since) if !is_new_hold => {
                        add_step_pool_wait(&step, whole_milliseconds_between(&since, &at))
                    }
                    _ => hold_step(&step),
                });
            }
            SessionEvent::WorkflowPhaseAdmitted(admitted) => {
                let step = step_key!(admitted);
                statements.push(admit_step(&step, self.cut_hold(&step, &at)));
                let run = self.run(step.workflow_run_id)?;
                if matches!(run.status, WorkflowRunStatus::New) {
                    run.status = WorkflowRunStatus::Running;
                    statements.push(run_status_statement(
                        step.workflow_run_id,
                        run.status,
                        &run.person_wait,
                    ));
                }
            }
            SessionEvent::WorkflowPhaseSuspended(suspended) => {
                self.suspend(suspended, &at, statements)?;
            }
            SessionEvent::WorkflowPhaseResumed(resumed) => {
                let step = step_key!(resumed);
                let waited = self.step(&step);
                waited.wait_cause = None;
                statements.push(resume_step(&step, waited.wait_id.take().as_ref()));
            }
            SessionEvent::WorkflowPhaseRetried(retried) => {
                ready(retried.workflow_run_id, &retried.readied, &at, statements);
            }
            SessionEvent::WorkflowStepStarted(started) => {
                if started.permission_level.is_some() || started.pin_hash.is_some() {
                    statements.push(record_step_start(
                        &step_key!(started),
                        started.permission_level,
                        started.pin_hash.as_ref(),
                    ));
                }
            }
            SessionEvent::WorkflowStepCompleted(completed) => {
                let step = step_key!(completed);
                self.steps.remove(&fold_key(&step));
                statements.push(succeed_step(
                    &step,
                    &at,
                    &completed.output_ref,
                    &stored_output_lengths(&completed.output_item_counts),
                    &completed.log_ref,
                    completed.cost.as_ref(),
                ));
                ready(step.workflow_run_id, &completed.readied, &at, statements);
            }
            SessionEvent::WorkflowStepFailed(failed) => {
                let step = step_key!(failed);
                let pool_wait_ms = self.cut_hold(&step, &at);
                self.steps.remove(&fold_key(&step));
                let passed_on = failed.passed_on.as_ref().map(|passed_on| {
                    (
                        &passed_on.output_ref,
                        stored_output_lengths(&passed_on.output_item_counts),
                    )
                });
                statements.push(fail_step(
                    &step,
                    &FailedStepRow {
                        finished_at: &at,
                        error: &failed.error,
                        decline_reason: failed.decline_reason.as_ref(),
                        output: passed_on
                            .as_ref()
                            .map(|(output_ref, lengths)| (*output_ref, lengths.as_slice())),
                        log_ref: &failed.log_ref,
                        pool_wait_ms,
                    },
                ));
                ready(step.workflow_run_id, &failed.readied, &at, statements);
            }
            SessionEvent::WorkflowStepCanceled(canceled) => {
                let step = step_key!(canceled);
                let pool_wait_ms = self.cut_hold(&step, &at);
                self.steps.remove(&fold_key(&step));
                statements.push(cancel_step(&step, &at, pool_wait_ms));
                ready(step.workflow_run_id, &canceled.readied, &at, statements);
            }
            SessionEvent::WorkflowStepSkipped(skipped) => {
                let step = step_key!(skipped);
                statements.push(insert_skipped_step(
                    &step,
                    &skipped.sources,
                    &skipped.input_ref,
                    &skipped.output_ref,
                    &stored_output_lengths(&skipped.output_item_counts),
                    &at,
                    (skipped.reused_from.as_ref(), skipped.pin_hash.as_ref()),
                ));
                ready(step.workflow_run_id, &skipped.readied, &at, statements);
            }
            _ => {}
        }
        Ok(())
    }
}

impl WorkflowRunsFold {
    // The run's row as its start wrote it, `new` at the event's instant, with its trigger step's
    // `pending` row unless a node run or a retry reuses its trigger's step; the run's execution
    // context is no projection, so none is written.
    fn start(
        &mut self,
        started: &WorkflowRunStartedPayload,
        at: WireInstant,
        statements: &mut Vec<WriteStatement>,
    ) {
        let creation = WorkflowRunCreation {
            workflow_run_id: started.workflow_run_id,
            workflow_version_id: started.workflow_version_id,
            session_id: started.session_id,
            mode: started.mode,
            trigger: started.trigger.clone(),
            started_by: started.started_by.clone(),
            chain: started.chain.clone(),
            execution_context: None,
            provider: started.provider.clone(),
            started_at: at,
            trigger_input: started.input_ref.clone(),
            node_run: started.node_run.clone(),
            retried_run_id: started.retried_workflow_run_id,
        };
        statements.push(run_row_statement(&creation));
        statements.extend(trigger_step_statement(&creation));
        self.runs.insert(
            started.workflow_run_id,
            RunFold {
                status: WorkflowRunStatus::New,
                person_wait: RunPersonWait::default(),
            },
        );
    }

    // A parked failure moves the run's status as `workflow.run.waiting` and `workflow.run.resumed`
    // do; an ended one ends its row.
    fn fail_run(
        &mut self,
        failed: &WorkflowRunFailedPayload,
        at: &WireInstant,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        match failed.outcome {
            WorkflowRunFailedOutcome::Parked => self.move_run(
                failed.workflow_run_id,
                RunStatusChange::FailedPark,
                at,
                statements,
            ),
            WorkflowRunFailedOutcome::Ended => {
                self.end_run(failed.workflow_run_id);
                statements.push(end_run_row_statement(
                    failed.workflow_run_id,
                    WorkflowRunStatus::Failed,
                    at,
                    failed.error.as_ref(),
                ));
                Ok(())
            }
        }
    }

    // The run's status and person-wait columns after `change` at `at`, as the live turn's status
    // move stores them: a wait on people opens only while no step of the run waits on an account.
    fn move_run(
        &mut self,
        run_id: WorkflowRunId,
        change: RunStatusChange,
        at: &WireInstant,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        let account_waits = self
            .steps
            .iter()
            .filter(|((step_run_id, _), step)| {
                *step_run_id == run_id && step.wait_cause == Some(WorkflowWaitCause::Account)
            })
            .count();
        let run = self.run(run_id)?;
        run.person_wait = person_wait_after(
            std::mem::take(&mut run.person_wait),
            Some(change),
            false,
            account_waits,
            at,
        );
        run.status = match change {
            RunStatusChange::Waiting => WorkflowRunStatus::Waiting,
            RunStatusChange::Resumed => WorkflowRunStatus::Running,
            RunStatusChange::FailedPark => WorkflowRunStatus::Failed,
        };
        statements.push(run_status_statement(run_id, run.status, &run.person_wait));
        Ok(())
    }

    // The step's wait as its suspension writes it. A step that starts waiting while its run is
    // parked on a failed step leaves the run waiting, a move no run event records.
    fn suspend(
        &mut self,
        suspended: &WorkflowPhaseSuspendedPayload,
        at: &WireInstant,
        statements: &mut Vec<WriteStatement>,
    ) -> Result<(), ProjectionContradiction> {
        let step = suspended_step(suspended);
        let (cause, wait_id) = match suspended {
            WorkflowPhaseSuspendedPayload::Approval {
                wait_deadline_at,
                wait_id,
                log_ref,
                ..
            } => {
                let cause = WorkflowWaitCause::Approval;
                statements.push(wait_step_on_person(
                    &step,
                    cause,
                    *wait_id,
                    at,
                    wait_deadline_at.as_ref(),
                    log_ref,
                ));
                (cause, Some(*wait_id))
            }
            WorkflowPhaseSuspendedPayload::Form {
                wait_deadline_at,
                wait_id,
                log_ref,
                ..
            } => {
                let cause = WorkflowWaitCause::Form;
                statements.push(wait_step_on_person(
                    &step,
                    cause,
                    *wait_id,
                    at,
                    wait_deadline_at.as_ref(),
                    log_ref,
                ));
                (cause, Some(*wait_id))
            }
            WorkflowPhaseSuspendedPayload::Reply {
                wait_deadline_at,
                wait_id,
                log_ref,
                ..
            } => {
                let cause = WorkflowWaitCause::Reply;
                statements.push(wait_step_on_person(
                    &step,
                    cause,
                    *wait_id,
                    at,
                    wait_deadline_at.as_ref(),
                    log_ref,
                ));
                (cause, Some(*wait_id))
            }
            WorkflowPhaseSuspendedPayload::Account {
                provider_account_id,
                resume_at,
                ..
            } => {
                let pool_wait_ms = self.cut_hold(&step, at);
                statements.push(wait_step_on_account(
                    &step,
                    provider_account_id,
                    at,
                    resume_at.as_ref(),
                    pool_wait_ms,
                ));
                (WorkflowWaitCause::Account, None)
            }
            WorkflowPhaseSuspendedPayload::Chain { .. } => {
                statements.push(wait_step_on_chain(&step, at));
                (WorkflowWaitCause::Chain, None)
            }
        };
        let waiting = self.step(&step);
        waiting.wait_cause = Some(cause);
        waiting.wait_id = wait_id;
        let run = self.run(step.workflow_run_id)?;
        if matches!(run.status, WorkflowRunStatus::Failed) {
            run.status = WorkflowRunStatus::Waiting;
            statements.push(run_status_statement(
                step.workflow_run_id,
                run.status,
                &run.person_wait,
            ));
        }
        Ok(())
    }

    // Forgets an ended run, whose rows nothing moves again but a delete.
    fn end_run(&mut self, run_id: WorkflowRunId) {
        self.runs.remove(&run_id);
        self.steps
            .retain(|(step_run_id, _), _| *step_run_id != run_id);
    }

    // The whole milliseconds the step's memory hold ran from its last report to `at`, a move that
    // cuts it, which ends the hold; 0 for a step the gate was not holding.
    fn cut_hold(&mut self, step: &WorkflowStepKey, at: &WireInstant) -> u64 {
        self.step(step)
            .last_hold_report_at
            .take()
            .map_or(0, |since| whole_milliseconds_between(&since, at))
    }

    fn step(&mut self, step: &WorkflowStepKey) -> &mut StepFold {
        self.steps.entry(fold_key(step)).or_default()
    }

    fn run(&mut self, run_id: WorkflowRunId) -> Result<&mut RunFold, ProjectionContradiction> {
        self.runs.get_mut(&run_id).ok_or_else(|| {
            ProjectionContradiction(format!(
                "run {} moves while the log holds no going run of that id",
                run_id.text().as_str()
            ))
        })
    }
}

/// The step a suspension names, whatever it waits on.
pub(crate) fn suspended_step(suspended: &WorkflowPhaseSuspendedPayload) -> WorkflowStepKey {
    let (WorkflowPhaseSuspendedPayload::Account {
        workflow_run_id,
        node_id,
        attempt,
        execution_index,
        ..
    }
    | WorkflowPhaseSuspendedPayload::Approval {
        workflow_run_id,
        node_id,
        attempt,
        execution_index,
        ..
    }
    | WorkflowPhaseSuspendedPayload::Form {
        workflow_run_id,
        node_id,
        attempt,
        execution_index,
        ..
    }
    | WorkflowPhaseSuspendedPayload::Reply {
        workflow_run_id,
        node_id,
        attempt,
        execution_index,
        ..
    }
    | WorkflowPhaseSuspendedPayload::Chain {
        workflow_run_id,
        node_id,
        attempt,
        execution_index,
        ..
    }) = suspended;
    WorkflowStepKey {
        workflow_run_id: *workflow_run_id,
        node_id: node_id.clone(),
        attempt: *attempt,
        execution_index: *execution_index,
    }
}

// The `pending` rows of the steps an event of run `run_id` readied, each on the input ref the live
// write stored, an artifact's above the inline cap, at the event's instant.
fn ready(
    run_id: WorkflowRunId,
    readied: &[WorkflowReadiedStep],
    at: &WireInstant,
    statements: &mut Vec<WriteStatement>,
) {
    statements.extend(readied.iter().map(|ready| {
        let step = WorkflowStepKey {
            workflow_run_id: run_id,
            node_id: ready.node_id.clone(),
            attempt: ready.attempt,
            execution_index: ready.execution_index,
        };
        insert_pending_step(&step, &ready.sources, &ready.input_ref, at)
    }));
}

// Execution indexes are unique within a run, so they key its steps.
fn fold_key(step: &WorkflowStepKey) -> (WorkflowRunId, u64) {
    (step.workflow_run_id, step.execution_index.get())
}
