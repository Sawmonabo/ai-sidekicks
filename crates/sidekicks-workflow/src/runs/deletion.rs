//! Deleting runs and keeping them: one run's delete, `Delete runs older than…` with the preview
//! its confirm reads, and the Keep mark that bulk delete leaves. Neither delete touches a run still
//! going or parked on its failed step, which a person can still cancel. A run's delete removes its
//! steps, its form drafts, its gate answers and its execution context with the run, in the write
//! that appends the run's `workflow.run.deleted`: the session log keeps the run's earlier events,
//! so a rebuild of the runs from the log needs that record to leave the run out. Bulk delete reads
//! the runs a page at a time and writes each page's runs of one session as one write, every run in
//! it guarded and its event appended in that write. Once a run's write commits, the folder it
//! worked in when its session had none goes too, with the workflow's runs folder when that leaves
//! it empty. Each deleted run's git common folder is answered, so its snapshot refs can be pruned.

pub(crate) mod keep;
#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::error::Error;
use std::fmt::{self, Display};
use std::io;
use std::iter;
use std::path::{Path, PathBuf};
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
use sidekicks_contracts::workflow::run::retention::WorkflowRunPurgePreviewResponse;
use sidekicks_contracts::workflow::run::status::WorkflowRunStatus;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::settle_all::DescribeEach;
use sidekicks_store::data_folder::workflow_run_folder;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::stored_column::{safe_int_column, text_column};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::run_setup_gates::execution_root::context::run_workspace_delete_sql;

use crate::not_found::WorkflowNotFound;
use crate::runs::record::{
    GOING_RUN_STATUSES_SQL, RunProgress, StoredInstantBound, finished_run_condition,
    parked_failed_run_condition, read_run_progress, stored_instant_bound,
};

/// The statements the deletion's reads run: the run a delete removes, the runs a bulk delete
/// removes, the bulk delete's preview, and a refused run's status.
pub const WORKFLOW_RUN_DELETION_STATEMENT_CAPACITY: usize = 4;

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
        "{finished_run}
  AND NOT EXISTS (SELECT 1 FROM workflow_runs AS later
    WHERE later.chain_root_run_id = run.id AND later.id <> run.id
      AND (later.status IN ({going}) OR {parked_later}))",
        finished_run = finished_run_condition("run"),
        going = *GOING_RUN_STATUSES_SQL,
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

// The deletes of the runs a JSON list of their ids names, with every row that hangs off them.
static LISTED_RUN_DELETE_SQL: LazyLock<Vec<String>> =
    LazyLock::new(|| run_delete_sql("SELECT value FROM json_each(?1)"));

// The deletes of the runs of a session, bound first, that a JSON list of run ids, bound second,
// leaves out, with every row that hangs off them.
static UNLISTED_SESSION_RUN_DELETE_SQL: LazyLock<Vec<String>> = LazyLock::new(|| {
    run_delete_sql(
        "SELECT id FROM workflow_runs WHERE session_id = ?1
    AND id NOT IN (SELECT value FROM json_each(?2))",
    )
});

// The deletes of the runs `runs` selects, a subquery of run ids, and of the rows that hang off
// them, children first so the foreign keys hold at every statement: the workspace a run owns goes
// after its execution context, which names that workspace's branch context, and the run's own row
// last.
fn run_delete_sql(runs: &str) -> Vec<String> {
    [
        ("workflow_steps", "workflow_run_id"),
        ("human_phase_form_state", "workflow_run_id"),
        ("workflow_gate_resolutions", "workflow_run_id"),
        ("run_execution_contexts", "run_id"),
    ]
    .into_iter()
    .map(|(table, run_column)| format!("DELETE FROM {table} WHERE {run_column} IN ({runs})"))
    .chain(run_workspace_delete_sql(runs))
    .chain([format!("DELETE FROM workflow_runs WHERE id IN ({runs})")])
    .collect()
}

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
    /// The event log did not keep a delete's or a Keep mark's write.
    #[error("a run's delete or Keep mark was not kept")]
    Append(#[from] SessionEventAppendError),
    /// A delete's reads, writes or folder removals failed: `deleted` holds every run it did
    /// delete, whose snapshot refs still need pruning, and the source the first failures and how
    /// many there were.
    #[error("deleting runs failed after {} were deleted", .deleted.len())]
    Incomplete {
        /// Every run deleted.
        deleted: Vec<DeletedWorkflowRun>,
        /// The first failures, in the order they came, and their count.
        #[source]
        cause: Box<RunDeletionFailures>,
    },
    /// SQLite refused a read, or a stored value did not read as its type.
    #[error("a read of the workflow runs failed")]
    Database(#[from] rusqlite::Error),
    /// The read pool is closed, a connection did not open, or the read's blocking task did not
    /// finish.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// A deleted run's own folder, or the workflow's runs folder it left empty, could not be
    /// removed.
    #[error("the folder at {} was left behind", .folder.display())]
    FolderLeft {
        /// The folder.
        folder: PathBuf,
        /// Why the removal failed.
        #[source]
        removal: io::Error,
    },
}

/// How many failures a delete keeps whole; past them it only counts, so a bulk delete over a folder
/// it cannot write keeps a bounded message.
const KEPT_DELETION_FAILURES: usize = 3;

/// The failures of one delete: the first [`KEPT_DELETION_FAILURES`] kept whole, in the order they
/// came, and how many there were in all.
#[derive(Debug, Default)]
pub(crate) struct RunDeletionFailures {
    /// The first failures, each kept whole.
    first: Vec<WorkflowRunDeletionError>,
    /// Every failure counted, those kept among them.
    count: usize,
}

impl RunDeletionFailures {
    /// Counts `failure`, keeping it whole while fewer than [`KEPT_DELETION_FAILURES`] are kept.
    fn push(&mut self, failure: WorkflowRunDeletionError) {
        self.count += 1;
        if self.first.len() < KEPT_DELETION_FAILURES {
            self.first.push(failure);
        }
    }
}

impl Display for RunDeletionFailures {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.count == 1 {
            return write!(formatter, "{}", DescribeEach(&self.first));
        }
        write!(
            formatter,
            "{} failures, the first {}: {}",
            self.count,
            self.first.len(),
            DescribeEach(&self.first)
        )
    }
}

impl Error for RunDeletionFailures {
    /// The first failure, whose own sources stay as they were.
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.first
            .first()
            .map(|failure| failure as &(dyn Error + 'static))
    }
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
            | WorkflowRunDeletionError::Incomplete { .. }
            | WorkflowRunDeletionError::Database(_)
            | WorkflowRunDeletionError::Pool(_)
            | WorkflowRunDeletionError::FolderLeft { .. }) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The statements that remove the runs `workflow_run_ids` with every row that hangs off them, the
/// workspace each owns among them, children first so the foreign keys hold at every statement:
/// what a delete writes with each run's `workflow.run.deleted`, and what a rebuild of the runs
/// applies on reading that event.
pub fn workflow_run_deletion_statements(workflow_run_ids: &[WorkflowRunId]) -> Vec<WriteStatement> {
    let ids_json = serde_json::to_string(workflow_run_ids).expect("run ids write as JSON");
    run_deletes(&LISTED_RUN_DELETE_SQL, &[Value::Text(ids_json)])
}

/// The statements that remove every run of `session_id` but `kept`, with every row that hangs off
/// them, as [`workflow_run_deletion_statements`] removes a listed run: what a rebuild of the runs
/// that read the log only up to a point applies once it has, for a run it kept for its gate
/// answers or form drafts whose `workflow.run.started` lies past that point.
pub(crate) fn unlisted_session_run_deletion_statements(
    session_id: SessionId,
    kept: &[WorkflowRunId],
) -> Vec<WriteStatement> {
    let kept_json = serde_json::to_string(kept).expect("run ids write as JSON");
    run_deletes(
        &UNLISTED_SESSION_RUN_DELETE_SQL,
        &[
            Value::Text(session_id.text().as_str().to_owned()),
            Value::Text(kept_json),
        ],
    )
}

// The statements of `deletes`, each over `bindings`.
fn run_deletes(deletes: &'static [String], bindings: &[Value]) -> Vec<WriteStatement> {
    deletes
        .iter()
        .map(|sql| WriteStatement {
            sql: Cow::Borrowed(sql.as_str()),
            bindings: StatementBindings::Positional(bindings.to_vec()),
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
    // The run's own folder in `data_folder`, which a run whose session had a working folder never
    // made.
    fn folder(&self, data_folder: &Path) -> PathBuf {
        workflow_run_folder(data_folder, &self.definition_id, &self.workflow_run_id)
    }

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
/// daemon's read pool, appending each delete and each Keep mark through the event log and removing
/// each deleted run's own folder from the daemon's data folder.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the workflow.run.delete, workflow.run.purge and workflow.run.keep.update handlers"
    )
)]
pub(crate) struct WorkflowRunDeletion {
    pool: Arc<DatabaseReadPool>,
    appender: SessionEventAppender,
    data_folder: PathBuf,
}

impl WorkflowRunDeletion {
    /// The deletion reading through `pool`, appending each delete and each Keep mark to
    /// `event_log` and removing runs' folders from `data_folder`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the workflow.run.delete and workflow.run.purge handlers"
        )
    )]
    pub(crate) fn new(
        pool: Arc<DatabaseReadPool>,
        event_log: Arc<EventLogService>,
        data_folder: PathBuf,
    ) -> Self {
        Self {
            pool,
            appender: SessionEventAppender::new(event_log, SESSION_EVENT_VERSION.clone()),
            data_folder,
        }
    }

    /// Deletes one run with its steps, form drafts, gate answers and execution context, and appends
    /// its `workflow.run.deleted` in the same write, then removes its own folder. Fails with
    /// [`WorkflowRunDeletionError::NotDeletable`] for a new, running or waiting run, a failed run
    /// parked on its failed step, and a chain's first run while a later run of its chain is one of
    /// those, and with [`WorkflowRunDeletionError::NotFound`] for a run there is none of, writing
    /// nothing either way; and with [`WorkflowRunDeletionError::Incomplete`] holding the run when
    /// its folder could not be removed after its write.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the workflow.run.delete handler")
    )]
    pub(crate) async fn delete(
        &self,
        workflow_run_id: WorkflowRunId,
    ) -> Result<DeletedWorkflowRun, WorkflowRunDeletionError> {
        let run = self.read_run(workflow_run_id).await?;
        match self.delete_runs(&[], &run, RunGuard::Deletable).await {
            Ok(()) => match remove_run_folder(run.folder(&self.data_folder)).await {
                Ok(()) => Ok(run.deleted()),
                Err((folder, removal)) => {
                    let mut failures = RunDeletionFailures::default();
                    failures.push(WorkflowRunDeletionError::FolderLeft { folder, removal });
                    Err(WorkflowRunDeletionError::Incomplete {
                        deleted: vec![run.deleted()],
                        cause: Box::new(failures),
                    })
                }
            },
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
    /// `workflow.run.deleted` and its own folder, and answers each one deleted. A run read as
    /// deletable that its guard no longer matches at its write, such as one kept since, is left.
    /// Fails with [`WorkflowRunDeletionError::Incomplete`], holding the first failures and their
    /// count, when a read, a write or a folder's removal fails: a failed write or removal leaves
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
        let mut failures = RunDeletionFailures::default();
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
                    failures.push(error);
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
                    Ok(chunk_deleted) => {
                        for run in chunk_deleted {
                            let removed = remove_run_folder(run.folder(&self.data_folder)).await;
                            if let Err((folder, removal)) = removed {
                                failures
                                    .push(WorkflowRunDeletionError::FolderLeft { folder, removal });
                            }
                            deleted.push(run.deleted());
                        }
                    }
                    Err(error) => failures.push(error),
                }
            }
            if is_last_page {
                break;
            }
        }
        if failures.count == 0 {
            return Ok(deleted);
        }
        Err(WorkflowRunDeletionError::Incomplete {
            deleted,
            cause: Box::new(failures),
        })
    }

    // Deletes the chunk's runs bulk delete would still remove, and answers those it deleted. A run
    // whose guard refuses the write is dropped and the rest written again, so a run kept since the
    // read is left and the others go.
    async fn delete_still_removable_runs(
        &self,
        mut runs: Vec<RunToDelete>,
        guard: RunGuard<'_>,
    ) -> Result<Vec<RunToDelete>, WorkflowRunDeletionError> {
        while let Some((last, earlier)) = runs.split_last() {
            let error = match self.delete_runs(earlier, last, guard).await {
                Ok(()) => return Ok(runs),
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

    // The run `workflow_run_id` names, failing with `NotFound` when there is none.
    async fn read_run(
        &self,
        workflow_run_id: WorkflowRunId,
    ) -> Result<RunToDelete, WorkflowRunDeletionError> {
        self.pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowRunDeletionError>(read_run_to_delete(connection, workflow_run_id)?)
            })
            .await?
            .ok_or_else(|| WorkflowNotFound::Run { workflow_run_id }.into())
    }

    // Why a delete was refused, read after the refusal: there is no such run, it is still going,
    // it is parked on its failed step, or it is a chain's first run and a later run of the chain is
    // going or parked on its failed step.
    async fn refusal(&self, workflow_run_id: WorkflowRunId) -> WorkflowRunDeletionError {
        let progress = self
            .pool
            .read(ReadLength::Short, move |connection| {
                Ok::<_, WorkflowRunDeletionError>(read_run_progress(connection, workflow_run_id)?)
            })
            .await;
        match progress {
            Ok(None) => WorkflowNotFound::Run { workflow_run_id }.into(),
            Ok(Some(stored)) => {
                let status = stored.status;
                match stored.progress() {
                    RunProgress::Going => WorkflowRunNotDeletable::Going {
                        workflow_run_id,
                        status,
                    },
                    RunProgress::ParkedOnFailedStep => {
                        WorkflowRunNotDeletable::ParkedOnFailedStep {
                            workflow_run_id,
                            status,
                        }
                    }
                    RunProgress::Finished => WorkflowRunNotDeletable::LaterChainRunGoing {
                        workflow_run_id,
                        status,
                    },
                }
                .into()
            }
            Err(error) => error,
        }
    }
}

// The position of the statement whose row count refused a delete's write, if that is why it was
// not kept.
fn refused_statement_index(error: &WorkflowRunDeletionError) -> Option<usize> {
    match error {
        WorkflowRunDeletionError::Append(append) => append.refused_statement_index(),
        WorkflowRunDeletionError::NotFound(_)
        | WorkflowRunDeletionError::NotDeletable(_)
        | WorkflowRunDeletionError::Draft(_)
        | WorkflowRunDeletionError::Incomplete { .. }
        | WorkflowRunDeletionError::Database(_)
        | WorkflowRunDeletionError::Pool(_)
        | WorkflowRunDeletionError::FolderLeft { .. } => None,
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

fn run_to_delete_from_row(row: &Row<'_>) -> rusqlite::Result<RunToDelete> {
    Ok(RunToDelete {
        workflow_run_id: text_column(row, 0, |text| WorkflowRunId::new(&text))?,
        session_id: text_column(row, 1, |text| SessionId::new(&text))?,
        definition_id: text_column(row, 2, |text| WorkflowDefinitionId::new(&text))?,
        workflow_version_id: text_column(row, 3, |text| WorkflowVersionId::new(&text))?,
        git_common_dir: row.get::<_, Option<String>>(4)?.map(PathBuf::from),
    })
}

/// Removes a run's own `folder`, where it has one, since a run whose session had a working folder
/// made none, then its workflow's runs folder when that leaves it empty, so no empty folder stays
/// for a workflow with no run folder left: a deleted run's, and a start's that made no run. Fails
/// with the folder left and why.
pub(crate) async fn remove_run_folder(folder: PathBuf) -> Result<(), (PathBuf, io::Error)> {
    match tokio::fs::remove_dir_all(&folder).await {
        Ok(()) => {}
        Err(removal) if removal.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(removal) => return Err((folder, removal)),
    }
    let runs_folder = folder
        .parent()
        .expect("a run's folder sits in its workflow's runs folder")
        .to_path_buf();
    match tokio::fs::remove_dir(&runs_folder).await {
        Ok(()) => Ok(()),
        // Another run of the workflow still has its folder there, or another removal took it.
        Err(removal)
            if matches!(
                removal.kind(),
                io::ErrorKind::DirectoryNotEmpty | io::ErrorKind::NotFound
            ) =>
        {
            Ok(())
        }
        Err(removal) => Err((runs_folder, removal)),
    }
}
