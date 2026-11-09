//! A person's run controls: Cancel, Resume and a chain's `Stop them all`. Each goes to the tick,
//! which takes it where it drives the run; a run the tick does not hold is answered from its rows,
//! a cancel of one written here in one unit of work with its events. Every refusal names why and
//! changes nothing.

#![cfg_attr(
    not(test),
    expect(dead_code, reason = "the daemon's workflow run method handlers")
)]

use std::sync::{Arc, LazyLock};

use rusqlite::Connection;
use serde_json::json;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::ComposedText;
use sidekicks_contracts::workflow::definition::document::WorkflowVersionId;
use sidekicks_contracts::workflow::run::control::{
    WorkflowCancelReason, WorkflowRunCancelResponse, WorkflowRunCanceledStatus,
    WorkflowRunResumeVersionRepin,
};
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::workflow_run::workflow_run_not_found;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::run_setup_gates::execution_root::context::SessionRunBinder;
use tokio::sync::{mpsc, oneshot};

use crate::engine::tick::{
    EngineTickInput, RepinReadError, RepinRefusal, RunCancelIntake, RunCancelRefusal,
    RunResumeIntake, RunResumeRefusal,
};
use crate::kinds::uncoded_step_error;
use crate::runs::cancellation::{
    WorkflowRunCancellation, WorkflowRunCancellationWrite, read_canceled_event_id,
    workflow_run_cancellation_statements,
};
use crate::runs::record::{RunProgress, finished_run_condition, read_run_progress};

// The cancel's statement that ends the run's row, refused once the run has ended.
const END_ROW_STATEMENT_INDEX: usize = 0;

// The runs of a chain still going or parked, the first run included, in the order they started.
static GOING_CHAIN_RUNS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id FROM workflow_runs AS run
  WHERE chain_root_run_id = ?1 AND NOT {finished}
  ORDER BY started_at, id",
        finished = finished_run_condition("run"),
    )
});

/// What a person's run controls reach: the tick's inbox, the rows a run the tick does not hold is
/// read from, the log its cancel is written to, and the binder told once that cancel commits.
pub(crate) struct WorkflowRunControls {
    inbox: mpsc::Sender<EngineTickInput>,
    pool: Arc<DatabaseReadPool>,
    appender: SessionEventAppender,
    binder: Arc<dyn SessionRunBinder>,
}

/// Why a run control did not do what it asked; nothing of the run was written.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowRunControlError {
    /// Refused: `workflow.run.notFound`, `workflow.run.notCancelable`,
    /// `workflow.run.resumeNotParked`, `workflow.run.resumeAwaitsAnswer`, a re-pin's
    /// `workflow.run.repair*` codes, or a start's refusal of the version a re-pin names.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// A re-pin's reads of the run and the version it names did not finish.
    #[error(transparent)]
    Repin(#[from] RepinReadError),
    /// The tick has stopped, or dropped the reply when the run's write failed.
    #[error("the workflow engine did not answer")]
    EngineGone,
    /// The read pool is closed, a connection did not open, or the read's task did not finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The run's rows did not read.
    #[error("the run's rows did not read")]
    Rows(#[from] rusqlite::Error),
    /// The cancel's events broke one of their type's checks.
    #[error("the cancel's events could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep the cancel's write.
    #[error("the cancel was not kept")]
    Append(#[from] SessionEventAppendError),
}

impl From<WorkflowRunControlError> for HandlerError {
    /// A refusal answers its code; any other failure is a fault in the daemon.
    fn from(error: WorkflowRunControlError) -> Self {
        match error {
            WorkflowRunControlError::Refused(refusal) => Self::Refused(refusal),
            fault @ (WorkflowRunControlError::EngineGone
            | WorkflowRunControlError::Repin(_)
            | WorkflowRunControlError::Pool(_)
            | WorkflowRunControlError::Rows(_)
            | WorkflowRunControlError::Draft(_)
            | WorkflowRunControlError::Append(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// What the rows of a run the tick does not hold say of its cancel.
enum UnheldCancel {
    /// No row answers to the run.
    Missing,
    /// The run is going or parked: the write that cancels it.
    Write(Box<WorkflowRunCancellationWrite>),
    /// The run was canceled already: the first cancel's event.
    AlreadyCanceled(String),
    /// The run has ended otherwise.
    Ended,
}

impl WorkflowRunControls {
    /// The controls over the tick's `inbox`, reading through `pool`, writing to `event_log` and
    /// telling `binder` once a cancel the tick does not hold commits.
    pub(crate) fn new(
        inbox: mpsc::Sender<EngineTickInput>,
        pool: Arc<DatabaseReadPool>,
        event_log: Arc<EventLogService>,
        binder: Arc<dyn SessionRunBinder>,
    ) -> Self {
        Self {
            inbox,
            pool,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
            binder,
        }
    }

    /// Cancels `workflow_run_id` for the person's `reason`, which the run's error carries as its
    /// message: the tick winds a run it drives down and answers once its ending commits; a going
    /// or parked run it does not hold is canceled here. A run already canceled answers the first
    /// cancel's event and writes nothing. Refused `workflow.run.notFound` for a run no row answers
    /// to, and `workflow.run.notCancelable` for one that has ended or whose ending is decided.
    pub(crate) async fn cancel(
        &self,
        workflow_run_id: WorkflowRunId,
        reason: Option<WorkflowCancelReason>,
    ) -> Result<WorkflowRunCancelResponse, WorkflowRunControlError> {
        let error = reason
            .as_ref()
            .map(|reason| uncoded_step_error(reason.as_str().to_owned()));
        let (reply, replied) = oneshot::channel();
        let intake = RunCancelIntake {
            run_id: workflow_run_id,
            reason: reason.clone(),
            error: error.clone(),
            reply,
        };
        match self
            .ask_tick(EngineTickInput::Cancel(intake), replied)
            .await?
        {
            Ok(event_id) => Ok(canceled(workflow_run_id, event_id.into(), false)),
            Err(RunCancelRefusal::Ending) => {
                Err(not_cancelable(workflow_run_id, "its ending is under way").into())
            }
            Err(RunCancelRefusal::NotHeld) => {
                self.cancel_unheld(WorkflowRunCancellation {
                    workflow_run_id,
                    finished_at: WireInstant::now(),
                    reason,
                    error,
                })
                .await
            }
        }
    }

    /// Resumes `workflow_run_id` through the tick, on its pinned version, or, where `version_repin`
    /// names another version of its workflow, on that one; answers the version the run left on an
    /// accepted re-pin. Refused `workflow.run.resumeNotParked` for a run with nothing a Resume
    /// lifts, `workflow.run.resumeAwaitsAnswer` for one waiting only on a person's answer,
    /// `workflow.run.notFound` for one no row answers to, and, on a re-pin,
    /// `workflow.version.notFound`, the `workflow.run.repair*` codes in their order and a start's
    /// refusal of the version's graph.
    pub(crate) async fn resume(
        &self,
        workflow_run_id: WorkflowRunId,
        version_repin: Option<WorkflowRunResumeVersionRepin>,
    ) -> Result<Option<WorkflowVersionId>, WorkflowRunControlError> {
        let (reply, replied) = oneshot::channel();
        let intake = RunResumeIntake {
            run_id: workflow_run_id,
            version_repin: version_repin.map(|repin| repin.target_workflow_version_id),
            reply,
        };
        let refusal = match self
            .ask_tick(EngineTickInput::Resume(intake), replied)
            .await?
        {
            Ok(left_version) => return Ok(left_version),
            Err(RunResumeRefusal::AwaitsAnswer) => DomainError::new(
                format!(
                    "Workflow run {workflow_run_id} waits on an answer: answer the waiting step."
                ),
                RefusalCode::WorkflowRunResumeAwaitsAnswer,
            )
            .with_detail(json!({ "workflowRunId": workflow_run_id })),
            Err(RunResumeRefusal::NotParked) => not_parked(workflow_run_id),
            Err(RunResumeRefusal::Repin(refusal)) => repin_refused(workflow_run_id, refusal),
            Err(RunResumeRefusal::Target(refusal)) => refusal,
            Err(RunResumeRefusal::Unread(unread)) => return Err(unread.into()),
            Err(RunResumeRefusal::NotHeld) => {
                let progress = self
                    .pool
                    .read(ReadLength::Short, move |connection| {
                        Ok::<_, WorkflowRunControlError>(read_run_progress(
                            connection,
                            workflow_run_id,
                        )?)
                    })
                    .await?;
                match progress {
                    None => workflow_run_not_found(&workflow_run_id),
                    Some(_) => not_parked(workflow_run_id),
                }
            }
        };
        Err(refusal.into())
    }

    /// `Stop them all` on the chain whose first run is `root`: cancels every run of the chain still
    /// going or parked, the first run included, through [`Self::cancel`] with no reason, in the
    /// order they started; a run that ends meanwhile is passed over. Answers each cancel taken.
    pub(crate) async fn stop_chain(
        &self,
        root: WorkflowRunId,
    ) -> Result<Vec<WorkflowRunCancelResponse>, WorkflowRunControlError> {
        let runs = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowRunControlError>(going_chain_runs(connection, root)?)
            })
            .await?;
        let mut canceled = Vec::with_capacity(runs.len());
        for workflow_run_id in runs {
            match self.cancel(workflow_run_id, None).await {
                Ok(response) => canceled.push(response),
                Err(WorkflowRunControlError::Refused(refusal))
                    if refusal.code == RefusalCode::WorkflowRunNotCancelable => {}
                Err(error) => return Err(error),
            }
        }
        Ok(canceled)
    }

    /// Sends `input` to the tick and waits for its answer on `replied`.
    async fn ask_tick<Answer>(
        &self,
        input: EngineTickInput,
        replied: oneshot::Receiver<Answer>,
    ) -> Result<Answer, WorkflowRunControlError> {
        self.inbox
            .send(input)
            .await
            .map_err(|_closed| WorkflowRunControlError::EngineGone)?;
        replied
            .await
            .map_err(|_dropped| WorkflowRunControlError::EngineGone)
    }

    /// Cancels the run of `cancellation`, which the tick does not hold, from its rows: a going or
    /// parked run's `workflow.run.canceled`, its results event after it for a run that posts them,
    /// and its rows' statements in one write, then the session's binder told. A run that ended
    /// between the read and the write is read again.
    async fn cancel_unheld(
        &self,
        cancellation: WorkflowRunCancellation,
    ) -> Result<WorkflowRunCancelResponse, WorkflowRunControlError> {
        let workflow_run_id = cancellation.workflow_run_id;
        loop {
            let read = cancellation.clone();
            let unheld = self
                .pool
                .read(ReadLength::Short, move |connection| {
                    read_unheld_cancel(connection, &read)
                })
                .await?;
            let write = match unheld {
                UnheldCancel::Missing => {
                    return Err(workflow_run_not_found(&workflow_run_id).into());
                }
                UnheldCancel::AlreadyCanceled(event_id) => {
                    let event_id = ComposedText::new(event_id).expect("a stored event id is text");
                    return Ok(canceled(workflow_run_id, event_id, true));
                }
                UnheldCancel::Ended => {
                    return Err(not_cancelable(workflow_run_id, "it has already ended").into());
                }
                UnheldCancel::Write(write) => *write,
            };
            let WorkflowRunCancellationWrite {
                session_id,
                statements,
                canceled: canceled_event,
                results_posted,
            } = write;
            let canceled_draft = SessionEventDraft::of_session(session_id, &canceled_event)?;
            let (draft, preceding_events) = match results_posted {
                Some(posted) => (
                    SessionEventDraft::of_session(session_id, &posted)?,
                    vec![canceled_draft],
                ),
                None => (canceled_draft, Vec::new()),
            };
            let linkage = SessionEventLinkage {
                transactional_prelude: statements.into(),
                preceding_events,
                ..SessionEventLinkage::default()
            };
            match self.appender.append(draft, linkage).await {
                Ok(receipt) => {
                    self.binder.note_context_changed(session_id);
                    let event_id = receipt
                        .preceding_ids
                        .into_iter()
                        .next()
                        .unwrap_or(receipt.id);
                    return Ok(canceled(workflow_run_id, event_id.into(), false));
                }
                // The run ended between the read and the write; its rows now say how.
                Err(append)
                    if append.refused_statement_index() == Some(END_ROW_STATEMENT_INDEX) => {}
                Err(append) => return Err(append.into()),
            }
        }
    }
}

/// What the rows on `connection` say of the cancel `cancellation` of a run the tick does not hold.
fn read_unheld_cancel(
    connection: &Connection,
    cancellation: &WorkflowRunCancellation,
) -> Result<UnheldCancel, WorkflowRunControlError> {
    let workflow_run_id = cancellation.workflow_run_id;
    let (Some(progress), Some(write)) = (
        read_run_progress(connection, workflow_run_id)?,
        workflow_run_cancellation_statements(connection, cancellation)?,
    ) else {
        return Ok(UnheldCancel::Missing);
    };
    Ok(match (progress.progress(), progress.status) {
        (RunProgress::Going | RunProgress::ParkedOnFailedStep, _) => {
            UnheldCancel::Write(Box::new(write))
        }
        (RunProgress::Finished, WorkflowRunStatus::Canceled) => {
            match read_canceled_event_id(connection, write.session_id, workflow_run_id)? {
                Some(event_id) => UnheldCancel::AlreadyCanceled(event_id),
                None => UnheldCancel::Ended,
            }
        }
        (RunProgress::Finished, _) => UnheldCancel::Ended,
    })
}

/// The runs of the chain whose first run is `root` still going or parked, in the order they
/// started, read on `connection`.
fn going_chain_runs(
    connection: &Connection,
    root: WorkflowRunId,
) -> rusqlite::Result<Vec<WorkflowRunId>> {
    connection
        .prepare_cached(GOING_CHAIN_RUNS_SQL.as_str())?
        .query_map([root.text().as_str()], |row| {
            text_column(row, 0, |text| WorkflowRunId::new(&text))
        })?
        .collect()
}

/// The answer of a cancel of `workflow_run_id` whose `workflow.run.canceled` is `event_id`.
fn canceled(
    workflow_run_id: WorkflowRunId,
    event_id: ComposedText,
    already_canceled: bool,
) -> WorkflowRunCancelResponse {
    WorkflowRunCancelResponse {
        workflow_run_id,
        status: WorkflowRunCanceledStatus::Value,
        canceled_event_id: event_id,
        already_canceled,
    }
}

/// `workflow.run.notCancelable` for `workflow_run_id`, saying why in `why`.
fn not_cancelable(workflow_run_id: WorkflowRunId, why: &str) -> DomainError {
    DomainError::new(
        format!("Workflow run {workflow_run_id} cannot be canceled: {why}."),
        RefusalCode::WorkflowRunNotCancelable,
    )
    .with_detail(json!({ "workflowRunId": workflow_run_id }))
}

/// The refusal of a move of `workflow_run_id` to another version for `refusal`.
fn repin_refused(workflow_run_id: WorkflowRunId, refusal: RepinRefusal) -> DomainError {
    match refusal {
        RepinRefusal::NotParked => DomainError::new(
            format!(
                "Workflow run {workflow_run_id} is not waiting on a Resume, so it stays on its \
                 version."
            ),
            RefusalCode::WorkflowRunRepairNotParked,
        )
        .with_detail(json!({ "workflowRunId": workflow_run_id })),
        RepinRefusal::AttemptInFlight(step) => DomainError::new(
            format!(
                "Workflow run {workflow_run_id} cannot move to another version while its step at \
                 node {} is still under way: cancel the run and retry it from that step to start \
                 it fresh.",
                step.node_id.as_str()
            ),
            RefusalCode::WorkflowRunRepairAttemptInFlight,
        )
        .with_detail(json!({ "workflowRunId": workflow_run_id, "step": step })),
        RepinRefusal::VersionUnaccountable => DomainError::new(
            format!(
                "Workflow run {workflow_run_id} cannot move to that version: it lacks a step the \
                 run already finished, or cannot reach one."
            ),
            RefusalCode::WorkflowRunRepairVersionUnaccountable,
        )
        .with_detail(json!({ "workflowRunId": workflow_run_id })),
    }
}

/// `workflow.run.resumeNotParked` for `workflow_run_id`.
fn not_parked(workflow_run_id: WorkflowRunId) -> DomainError {
    DomainError::new(
        format!("Workflow run {workflow_run_id} is not waiting on a Resume."),
        RefusalCode::WorkflowRunResumeNotParked,
    )
    .with_detail(json!({ "workflowRunId": workflow_run_id }))
}

#[cfg(test)]
mod tests;
