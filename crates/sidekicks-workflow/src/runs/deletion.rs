//! Deleting runs and keeping them: one run's delete, `Delete runs older than…` with the preview its
//! confirm reads, and the Keep mark that bulk delete leaves. Neither delete touches a run still
//! going or parked on its failed step, which a person can still cancel. A run's delete removes its
//! steps, its form drafts, its gate answers and its execution context with the run, in the write
//! that appends the run's `workflow.run.deleted`: the session log keeps the run's earlier events,
//! so a rebuild of the runs from the log needs that record to leave the run out. Bulk delete reads
//! the runs a page at a time and writes each page's runs of one session as one write, every run in
//! it guarded and its event appended in that write. Each deleted run's git common folder is
//! answered, so its snapshot refs can be pruned.

#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::iter;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension as _, Row, named_params};
use serde_json::json;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::workflow::definition::document::{
    WorkflowDefinitionId, WorkflowVersionId,
};
use sidekicks_contracts::workflow::run::events::WorkflowRunDeletedPayload;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::workflow::run::retention::{
    WorkflowRunKeepSet, WorkflowRunPurgePreviewResponse,
};
use sidekicks_contracts::workflow::run::status::{GOING_RUN_STATUSES, WorkflowRunStatus};

use crate::not_found::WorkflowNotFound;
use crate::runs::record::{
    GOING_RUN_STATUSES_SQL, StoredInstantBound, parked_failed_run_condition, stored_instant_bound,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{closed_word, safe_int_column, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::log_service::{EventAppendError, EventLogService};
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;

/// The statements the deletion's reads run: the run a delete removes, the runs a bulk delete
/// removes, the bulk delete's preview, and a refused run's status.
pub(crate) const WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY: usize = 4;

/// The most runs one page of bulk delete reads, and so the most one of its writes removes. Bulk
/// delete waits for each write to commit before it reads or queues the next, so it holds at most
/// one page and the writer's queue at most this many of its events; a larger write holds the
/// writer longer while other sessions' writes wait.
const RUNS_PER_DELETE_WRITE: usize = 100;

// A run that is neither going nor parked on its failed step. A chain's first run holds the chain's
// count and its answer, which a later run of the chain needs while it is either, so the first run
// is not deletable while one is.
static DELETABLE_RUN_CONDITION: LazyLock<String> = LazyLock::new(|| {
    format!(
        "run.status NOT IN ({going}) AND NOT {parked_run}
  AND NOT EXISTS (SELECT 1 FROM workflow_runs AS later
    WHERE later.chain_root_run_id = run.id AND later.id <> run.id
      AND (later.status IN ({going}) OR {parked_later}))",
        going = *GOING_RUN_STATUSES_SQL,
        parked_run = parked_failed_run_condition("run"),
        parked_later = parked_failed_run_condition("later"),
    )
});

// A run started before the bound, every run when the bound is `NULL`.
const OLD_RUN_CONDITION: &str = "(@older_than IS NULL OR run.started_at < @older_than)";

// Bulk delete never removes a run that is not deletable, nor a kept run. The preview counts with
// these same conditions, so it counts what the delete removes.
static REMOVABLE_BUT_FOR_KEEP: LazyLock<String> =
    LazyLock::new(|| format!("{OLD_RUN_CONDITION} AND {}", *DELETABLE_RUN_CONDITION));

static REMOVABLE: LazyLock<String> =
    LazyLock::new(|| format!("{} AND run.kept = 0", *REMOVABLE_BUT_FOR_KEEP));

static PREVIEW_SQL: LazyLock<String> = LazyLock::new(|| {
    let waiting = <&'static str>::from(WorkflowRunStatus::Waiting);
    format!(
        "SELECT
    COALESCE(SUM(CASE WHEN {removable} THEN 1 ELSE 0 END), 0) AS delete_count,
    COALESCE(SUM(CASE WHEN {removable_but_for_keep} AND run.kept = 1 THEN 1 ELSE 0 END), 0)
      AS kept_count,
    COALESCE(SUM(CASE WHEN {OLD_RUN_CONDITION}
                       AND (run.status = '{waiting}' OR {parked_run})
                      THEN 1 ELSE 0 END), 0) AS waiting_count
  FROM workflow_runs AS run",
        removable = *REMOVABLE,
        removable_but_for_keep = *REMOVABLE_BUT_FOR_KEEP,
        parked_run = parked_failed_run_condition("run"),
    )
});

// What a run's deleted event and its answer carry, read before its write: the run's pinned
// version and session never change, nor does the git common folder its execution context names.
const SELECT_RUN_TO_DELETE: &str = "SELECT run.id, run.session_id, version.definition_id,
    run.workflow_version_id, context.git_common_dir
  FROM workflow_runs AS run
  JOIN workflow_versions AS version ON version.id = run.workflow_version_id
  LEFT JOIN run_execution_contexts AS context ON context.run_id = run.id";

static RUN_TO_DELETE_SQL: LazyLock<String> =
    LazyLock::new(|| format!("{SELECT_RUN_TO_DELETE} WHERE run.id = @workflow_run_id"));

// One page in session order, since one write's events all belong to one session, after the run
// the last page ended on; `NULL` starts at the first.
static REMOVABLE_RUNS_PAGE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "{SELECT_RUN_TO_DELETE} WHERE {}
    AND (@after_session_id IS NULL
      OR (run.session_id, run.id) > (@after_session_id, @after_run_id))
  ORDER BY run.session_id, run.id
  LIMIT {RUNS_PER_DELETE_WRITE}",
        *REMOVABLE
    )
});

// Matches the run only while it may be deleted, so a write that starts with it refuses a run still
// going or parked on its failed step, and a chain's first run while a later run is either.
static DELETABLE_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run.id FROM workflow_runs AS run
  WHERE run.id = @workflow_run_id AND {}",
        *DELETABLE_RUN_CONDITION
    )
});

// Matches the run only while bulk delete would still remove it.
static STILL_REMOVABLE_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT run.id FROM workflow_runs AS run WHERE run.id = @workflow_run_id AND {}",
        *REMOVABLE
    )
});

const RUN_STATUS_SQL: &str =
    "SELECT status, finished_at FROM workflow_runs WHERE id = @workflow_run_id";

const KEEP_SQL: &str = "UPDATE workflow_runs SET kept = @kept WHERE id = @workflow_run_id";

// The deletes of the rows that hang off a run, children first so the foreign keys hold at every
// statement, then of the run, each over a JSON list of run ids.
static RUN_ROW_DELETE_SQL: LazyLock<[String; 5]> = LazyLock::new(|| {
    [
        ("workflow_steps", "workflow_run_id"),
        ("human_phase_form_state", "workflow_run_id"),
        ("workflow_gate_resolutions", "workflow_run_id"),
        ("run_execution_contexts", "run_id"),
        ("workflow_runs", "id"),
    ]
    .map(|(table, run_column)| {
        format!("DELETE FROM {table} WHERE {run_column} IN (SELECT value FROM json_each(?1))")
    })
});

/// A run a delete removed, with the git common folder its execution context named, or `None` where
/// it had none; the snapshot cleanup prunes the run's refs there after the rows are gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeletedWorkflowRun {
    /// The run.
    pub(crate) workflow_run_id: WorkflowRunId,
    /// The repository's common git folder its execution context recorded.
    pub(crate) git_common_dir: Option<PathBuf>,
}

/// Why a delete refused a run that is still needed; nothing was deleted. Each answers
/// `workflow.run.notDeletable` with the run and its status.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowRunNotDeletable {
    /// The run is new, running or waiting.
    #[error("The run is {}. Cancel it first.", <&'static str>::from(.status))]
    Going {
        /// The run.
        workflow_run_id: WorkflowRunId,
        /// Where it stands.
        status: WorkflowRunStatus,
    },
    /// The run failed and is parked on its failed step, waiting on Resume.
    #[error("The run is parked on its failed step. Cancel it first.")]
    ParkedOnFailedStep {
        /// The run.
        workflow_run_id: WorkflowRunId,
        /// Where it stands.
        status: WorkflowRunStatus,
    },
    /// The run is a chain's first run and a later run of the chain is going or parked.
    #[error("A later run of its chain is still going. Cancel it first.")]
    LaterChainRunGoing {
        /// The run.
        workflow_run_id: WorkflowRunId,
        /// Where it stands.
        status: WorkflowRunStatus,
    },
}

impl From<WorkflowRunNotDeletable> for DomainError {
    fn from(refusal: WorkflowRunNotDeletable) -> Self {
        let message = refusal.to_string();
        let (WorkflowRunNotDeletable::Going {
            workflow_run_id,
            status,
        }
        | WorkflowRunNotDeletable::ParkedOnFailedStep {
            workflow_run_id,
            status,
        }
        | WorkflowRunNotDeletable::LaterChainRunGoing {
            workflow_run_id,
            status,
        }) = refusal;
        DomainError::new(message, RefusalCode::WorkflowRunNotDeletable)
            .with_detail(json!({ "workflowRunId": workflow_run_id, "status": status }))
    }
}

/// Why runs were not deleted or kept; a refused write keeps nothing.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorkflowRunDeletionError {
    /// No run has the id (`workflow.run.notFound`).
    #[error(transparent)]
    NotFound(#[from] WorkflowNotFound),
    /// The run is still needed (`workflow.run.notDeletable`).
    #[error(transparent)]
    NotDeletable(#[from] WorkflowRunNotDeletable),
    /// A run's deleted event broke one of its type's checks.
    #[error("a run's deleted event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep a delete's write.
    #[error("a run's delete was not kept")]
    Append(#[from] SessionEventAppendError),
    /// The writer did not keep the Keep mark.
    #[error("a run's Keep mark was not kept")]
    Write(#[from] WriteError),
    /// A bulk delete's read or write failed: `deleted` holds every run it did delete, whose
    /// snapshot refs still need pruning, and the source the first failure.
    #[error("deleting old runs failed after {} were deleted", .deleted.len())]
    Incomplete {
        /// Every run deleted.
        deleted: Vec<DeletedWorkflowRun>,
        /// The first failure.
        #[source]
        cause: Box<WorkflowRunDeletionError>,
    },
    /// SQLite refused a read, or a stored value did not read as its type.
    #[error("a read of the workflow runs failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
}

impl From<WorkflowRunDeletionError> for HandlerError {
    /// A run not found and a run still needed answer their refusals; any other failure is a fault
    /// in the daemon.
    fn from(error: WorkflowRunDeletionError) -> Self {
        match error {
            WorkflowRunDeletionError::NotFound(not_found) => Self::Refused(not_found.into()),
            WorkflowRunDeletionError::NotDeletable(refusal) => Self::Refused(refusal.into()),
            fault @ (WorkflowRunDeletionError::Draft(_)
            | WorkflowRunDeletionError::Append(_)
            | WorkflowRunDeletionError::Write(_)
            | WorkflowRunDeletionError::Incomplete { .. }
            | WorkflowRunDeletionError::Database(_)
            | WorkflowRunDeletionError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The statements that remove the runs `workflow_run_ids` with every row that hangs off them,
/// children first so the foreign keys hold at every statement: what a delete writes with each run's
/// `workflow.run.deleted`, and what a rebuild of the runs applies on reading that event.
pub(crate) fn workflow_run_deletion_statements(
    workflow_run_ids: &[WorkflowRunId],
) -> Vec<WriteStatement> {
    let ids_json = serde_json::to_string(workflow_run_ids).expect("run ids write as JSON");
    RUN_ROW_DELETE_SQL
        .iter()
        .map(|sql| WriteStatement {
            sql: Cow::Borrowed(sql.as_str()),
            bindings: StatementBindings::Positional(vec![Value::Text(ids_json.clone())]),
            expected_row_count: None,
        })
        .collect()
}

/// What a write's guard for each run requires: the run deletable, or still one bulk delete
/// removes for the bound it read with.
#[derive(Clone, Copy)]
enum RunGuard<'bound> {
    /// The run may be deleted.
    Deletable,
    /// Bulk delete would still remove the run; `None` bounds no run.
    StillRemovable {
        older_than: Option<&'bound WireInstant>,
    },
}

impl RunGuard<'_> {
    // The statement that refuses its write unless the guard matches the run.
    fn statement(self, workflow_run_id: WorkflowRunId) -> WriteStatement {
        let run_text = workflow_run_id.text();
        let (sql, mut bindings) = match self {
            Self::Deletable => (DELETABLE_RUN_SQL.as_str(), Vec::new()),
            Self::StillRemovable { older_than } => (
                STILL_REMOVABLE_RUN_SQL.as_str(),
                vec![older_than_binding(older_than)],
            ),
        };
        bindings.push(text_binding("@workflow_run_id", run_text.as_str()));
        WriteStatement {
            sql: Cow::Borrowed(sql),
            bindings: StatementBindings::Named(bindings),
            expected_row_count: Some(1),
        }
    }
}

/// One run a delete is about to remove, as read before its write.
#[derive(Clone, Debug)]
struct RunToDelete {
    workflow_run_id: WorkflowRunId,
    session_id: SessionId,
    definition_id: WorkflowDefinitionId,
    workflow_version_id: WorkflowVersionId,
    git_common_dir: Option<PathBuf>,
}

impl RunToDelete {
    fn deleted(&self) -> DeletedWorkflowRun {
        DeletedWorkflowRun {
            workflow_run_id: self.workflow_run_id,
            git_common_dir: self.git_common_dir.clone(),
        }
    }

    fn deleted_event(&self) -> Result<SessionEventDraft, SessionEventDraftError> {
        SessionEventDraft::of_session(
            self.session_id,
            &SessionEvent::WorkflowRunDeleted(WorkflowRunDeletedPayload {
                session_id: self.session_id,
                workflow_run_id: self.workflow_run_id,
                definition_id: self.definition_id,
                workflow_version_id: self.workflow_version_id,
            }),
        )
    }
}

/// Deletes runs, one or many, and sets the Keep mark that bulk delete leaves, reading through the
/// daemon's read pool and appending each delete through the event log.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow.run.delete, workflow.run.purge and workflow.run.keep.update handlers"
    )
)]
pub(crate) struct WorkflowRunDeletion {
    pool: Arc<DatabaseReadPool>,
    writer: Arc<DatabaseWriter>,
    appender: SessionEventAppender,
}

impl WorkflowRunDeletion {
    /// The deletion reading through `pool`, writing the Keep mark through `writer`, and appending
    /// each delete to `event_log`, whose writer `writer` is.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the workflow.run.delete and workflow.run.purge handlers"
        )
    )]
    pub(crate) fn new(
        pool: Arc<DatabaseReadPool>,
        writer: Arc<DatabaseWriter>,
        event_log: Arc<EventLogService>,
    ) -> Self {
        Self {
            pool,
            writer,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
        }
    }

    /// Deletes one run with its steps, form drafts, gate answers and execution context, and appends
    /// its `workflow.run.deleted` in the same write. Fails with
    /// [`WorkflowRunDeletionError::NotDeletable`] for a new, running or waiting run, a failed run
    /// parked on its failed step, and a chain's first run while a later run of its chain is one of
    /// those, and with [`WorkflowRunDeletionError::NotFound`] for a run there is none of, writing
    /// nothing either way.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.run.delete handler")
    )]
    pub(crate) async fn delete(
        &self,
        workflow_run_id: WorkflowRunId,
    ) -> Result<DeletedWorkflowRun, WorkflowRunDeletionError> {
        let run = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowRunDeletionError>(read_run_to_delete(connection, workflow_run_id)?)
            })
            .await?
            .ok_or(WorkflowNotFound::Run { workflow_run_id })?;
        match self.delete_runs(&[], &run, RunGuard::Deletable).await {
            Ok(()) => Ok(run.deleted()),
            Err(error) if refused_statement_index(&error).is_some() => {
                Err(self.refusal(workflow_run_id).await)
            }
            Err(error) => Err(error),
        }
    }

    /// How many runs started before `older_than` `Delete runs older than…` would remove; how many
    /// it would remove but for their Keep mark; and how many it leaves because they are waiting or
    /// parked on a failed step. Fails with [`WorkflowRunDeletionError::Database`] or
    /// [`WorkflowRunDeletionError::Pool`] when the read does.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.run.purge.preview handler")
    )]
    pub(crate) async fn preview_delete_older_than(
        &self,
        older_than: &WireInstant,
    ) -> Result<WorkflowRunPurgePreviewResponse, WorkflowRunDeletionError> {
        let bound = match stored_instant_bound(older_than) {
            StoredInstantBound::BeforeEvery => {
                return Ok(WorkflowRunPurgePreviewResponse {
                    delete_count: SafeInt::ZERO,
                    kept_count: SafeInt::ZERO,
                    waiting_count: SafeInt::ZERO,
                });
            }
            StoredInstantBound::At(instant) => Some(instant),
            StoredInstantBound::AfterEvery => None,
        };
        self.pool
            .read(ReadLength::Long, move |connection| {
                Ok(read_preview(connection, bound.as_ref())?)
            })
            .await
    }

    /// Deletes every run the preview counts for deletion, each with all its rows and its own
    /// `workflow.run.deleted`, and answers each one deleted. A run read as deletable that its guard
    /// no longer matches at its write, such as one kept since, is left. Fails with
    /// [`WorkflowRunDeletionError::Incomplete`] when a read or a write fails: a failed write leaves
    /// the later pages to be written, and a failed read ends the delete.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.run.purge handler")
    )]
    pub(crate) async fn delete_older_than(
        &self,
        older_than: &WireInstant,
    ) -> Result<Vec<DeletedWorkflowRun>, WorkflowRunDeletionError> {
        let bound = match stored_instant_bound(older_than) {
            StoredInstantBound::BeforeEvery => return Ok(Vec::new()),
            StoredInstantBound::At(instant) => Some(instant),
            StoredInstantBound::AfterEvery => None,
        };
        let guard = RunGuard::StillRemovable {
            older_than: bound.as_ref(),
        };
        let mut deleted = Vec::new();
        let mut failure = None;
        let mut after = None;
        loop {
            let read_bound = bound.clone();
            let read = self
                .pool
                .read(ReadLength::Long, move |connection| {
                    Ok::<_, WorkflowRunDeletionError>(read_removable_runs(
                        connection,
                        read_bound.as_ref(),
                        after,
                    )?)
                })
                .await;
            let page = match read {
                Ok(page) => page,
                Err(error) => {
                    failure.get_or_insert(error);
                    break;
                }
            };
            let Some(last) = page.last() else {
                break;
            };
            // The next page starts after this one's last run, so a run left at its write is not
            // read again.
            after = Some((last.session_id, last.workflow_run_id));
            let is_last_page = page.len() < RUNS_PER_DELETE_WRITE;
            for chunk in chunk_runs_by_session(page) {
                match self.delete_still_removable_runs(chunk, guard).await {
                    Ok(chunk_deleted) => deleted.extend(chunk_deleted),
                    Err(error) => {
                        failure.get_or_insert(error);
                    }
                }
            }
            if is_last_page {
                break;
            }
        }
        match failure {
            None => Ok(deleted),
            Some(cause) => Err(WorkflowRunDeletionError::Incomplete {
                deleted,
                cause: Box::new(cause),
            }),
        }
    }

    /// Sets or clears the run's Keep mark. Fails with [`WorkflowRunDeletionError::NotFound`] for a
    /// run there is none of.
    #[expect(dead_code, reason = "the workflow.run.keep.update handler")]
    pub(crate) async fn set_keep(
        &self,
        keep_set: WorkflowRunKeepSet,
    ) -> Result<WorkflowRunKeepSet, WorkflowRunDeletionError> {
        let statement = WriteStatement {
            sql: Cow::Borrowed(KEEP_SQL),
            bindings: StatementBindings::Named(vec![
                (
                    Cow::Borrowed("@kept"),
                    Value::Integer(i64::from(keep_set.keep)),
                ),
                text_binding("@workflow_run_id", keep_set.workflow_run_id.text().as_str()),
            ]),
            expected_row_count: Some(1),
        };
        match self.writer.write(vec![statement]).await {
            Ok(_) => Ok(keep_set),
            Err(WriteError::Refused { .. }) => Err(WorkflowNotFound::Run {
                workflow_run_id: keep_set.workflow_run_id,
            }
            .into()),
            Err(error) => Err(error.into()),
        }
    }

    // Deletes the chunk's runs bulk delete would still remove. A run whose guard refuses the write
    // is dropped and the rest written again, so a run kept since the read is left and the others
    // go.
    async fn delete_still_removable_runs(
        &self,
        mut runs: Vec<RunToDelete>,
        guard: RunGuard<'_>,
    ) -> Result<Vec<DeletedWorkflowRun>, WorkflowRunDeletionError> {
        while let Some((last, earlier)) = runs.split_last() {
            let error = match self.delete_runs(earlier, last, guard).await {
                Ok(()) => return Ok(runs.iter().map(RunToDelete::deleted).collect()),
                Err(error) => error,
            };
            // The guards come first in the write, one per run in order.
            match refused_statement_index(&error) {
                Some(index) if index < runs.len() => {
                    runs.remove(index);
                }
                Some(_) | None => return Err(error),
            }
        }
        Ok(Vec::new())
    }

    // Runs of one session deleted as one write, `last` after `earlier`: each run's guard, which
    // refuses the write unless it matches the run; the deletes of the runs' rows; and each run's
    // deleted event, in the same order.
    async fn delete_runs(
        &self,
        earlier: &[RunToDelete],
        last: &RunToDelete,
        guard: RunGuard<'_>,
    ) -> Result<(), WorkflowRunDeletionError> {
        let runs = || earlier.iter().chain(iter::once(last));
        let mut transactional_prelude: Vec<WriteStatement> = runs()
            .map(|run| guard.statement(run.workflow_run_id))
            .collect();
        let run_ids: Vec<WorkflowRunId> = runs().map(|run| run.workflow_run_id).collect();
        transactional_prelude.extend(workflow_run_deletion_statements(&run_ids));
        let preceding_events = earlier
            .iter()
            .map(RunToDelete::deleted_event)
            .collect::<Result<_, _>>()?;
        self.appender
            .append(
                last.deleted_event()?,
                SessionEventLinkage {
                    transactional_prelude,
                    preceding_events,
                    ..SessionEventLinkage::default()
                },
            )
            .await?;
        Ok(())
    }

    // Why a delete was refused, read after the refusal: there is no such run, it is still going,
    // it is parked on its failed step, or it is a chain's first run and a later run of the chain is
    // going or parked on its failed step.
    async fn refusal(&self, workflow_run_id: WorkflowRunId) -> WorkflowRunDeletionError {
        let status = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowRunDeletionError>(read_run_status(connection, workflow_run_id)?)
            })
            .await;
        match status {
            Ok(None) => WorkflowNotFound::Run { workflow_run_id }.into(),
            Ok(Some((status, finished_at))) => if GOING_RUN_STATUSES.contains(&status) {
                WorkflowRunNotDeletable::Going {
                    workflow_run_id,
                    status,
                }
            } else if status == WorkflowRunStatus::Failed && finished_at.is_none() {
                WorkflowRunNotDeletable::ParkedOnFailedStep {
                    workflow_run_id,
                    status,
                }
            } else {
                WorkflowRunNotDeletable::LaterChainRunGoing {
                    workflow_run_id,
                    status,
                }
            }
            .into(),
            Err(error) => error,
        }
    }
}

// The position of the statement whose row count refused a delete's write, if that is why it was
// not kept.
fn refused_statement_index(error: &WorkflowRunDeletionError) -> Option<usize> {
    if let WorkflowRunDeletionError::Append(SessionEventAppendError::Append(
        EventAppendError::Write(WriteError::Refused {
            statement_index, ..
        }),
    )) = error
    {
        Some(*statement_index)
    } else {
        None
    }
}

// The bound as the conditions bind it: `NULL` bounds no run.
fn older_than_binding(older_than: Option<&WireInstant>) -> (Cow<'static, str>, Value) {
    (
        Cow::Borrowed("@older_than"),
        older_than.map_or(Value::Null, |instant| {
            Value::Text(instant.as_str().to_owned())
        }),
    )
}

// A page's runs of each session, consecutive in it since a page is in session order.
fn chunk_runs_by_session(runs: Vec<RunToDelete>) -> Vec<Vec<RunToDelete>> {
    let mut chunks: Vec<Vec<RunToDelete>> = Vec::new();
    for run in runs {
        match chunks.last_mut() {
            Some(chunk)
                if chunk
                    .first()
                    .is_some_and(|first| first.session_id == run.session_id) =>
            {
                chunk.push(run);
            }
            Some(_) | None => chunks.push(vec![run]),
        }
    }
    chunks
}

fn read_run_to_delete(
    connection: &Connection,
    workflow_run_id: WorkflowRunId,
) -> rusqlite::Result<Option<RunToDelete>> {
    connection
        .prepare_cached(RUN_TO_DELETE_SQL.as_str())?
        .query_row(
            named_params! { "@workflow_run_id": workflow_run_id.text().as_str() },
            run_to_delete_from_row,
        )
        .optional()
}

// One page of the runs bulk delete removes, after the session and run `after` names.
fn read_removable_runs(
    connection: &Connection,
    older_than: Option<&WireInstant>,
    after: Option<(SessionId, WorkflowRunId)>,
) -> rusqlite::Result<Vec<RunToDelete>> {
    let after_session = after.map(|(session_id, _)| session_id.text());
    let after_run = after.map(|(_, workflow_run_id)| workflow_run_id.text());
    let mut statement = connection.prepare_cached(REMOVABLE_RUNS_PAGE_SQL.as_str())?;
    let rows = statement.query_map(
        named_params! {
            "@older_than": older_than.map(WireInstant::as_str),
            "@after_session_id": after_session.as_ref().map(UuidText::as_str),
            "@after_run_id": after_run.as_ref().map(UuidText::as_str),
        },
        run_to_delete_from_row,
    )?;
    rows.collect()
}

fn read_preview(
    connection: &Connection,
    older_than: Option<&WireInstant>,
) -> rusqlite::Result<WorkflowRunPurgePreviewResponse> {
    connection.prepare_cached(PREVIEW_SQL.as_str())?.query_row(
        named_params! { "@older_than": older_than.map(WireInstant::as_str) },
        |row| {
            Ok(WorkflowRunPurgePreviewResponse {
                delete_count: safe_int_column(row, 0)?,
                kept_count: safe_int_column(row, 1)?,
                waiting_count: safe_int_column(row, 2)?,
            })
        },
    )
}

fn read_run_status(
    connection: &Connection,
    workflow_run_id: WorkflowRunId,
) -> rusqlite::Result<Option<(WorkflowRunStatus, Option<String>)>> {
    connection
        .prepare_cached(RUN_STATUS_SQL)?
        .query_row(
            named_params! { "@workflow_run_id": workflow_run_id.text().as_str() },
            |row| Ok((text_column(row, 0, closed_word)?, row.get(1)?)),
        )
        .optional()
}

fn run_to_delete_from_row(row: &Row<'_>) -> rusqlite::Result<RunToDelete> {
    Ok(RunToDelete {
        workflow_run_id: text_column(row, 0, |text| WorkflowRunId::new(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        definition_id: text_column(row, 2, |text| WorkflowDefinitionId::new(&text))?,
        workflow_version_id: text_column(row, 3, |text| WorkflowVersionId::new(&text))?,
        git_common_dir: row.get::<_, Option<String>>(4)?.map(PathBuf::from),
    })
}
