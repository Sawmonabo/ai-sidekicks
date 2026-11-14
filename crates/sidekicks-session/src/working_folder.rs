//! A project session's working folder: moving it into any tree its repository has, at once while no
//! agent run of the session is live, or as a pending move on the session's own row that the run's
//! next boundary applies; a workflow run holds no move, its steps staying on its recorded root.
//! The row holds at most one, so a later request replaces it, and a request for the folder the
//! session already works in clears it. A removed tree's sessions are swept back to the
//! repository's own checkout; one with a run still bound in that tree, an agent run or a workflow
//! run, keeps its folder until that run is released, and is swept at that run's end.
//!
//! - Each move takes one workspace's preparation hold at a time, and a move at a run's boundary
//!   runs under the hold the gate gives it, never taking it again.
//! - A run may end under the engine's hold of its session's append lock; every event a move or a
//!   sweep appends on that session goes under that hold, never waiting on it.
//! - A move ends in `workspace.prepared` and a sweep in `session.sweptToCheckout`, so the session's
//!   live folder follows either.
//! - Every change to the pending move appends `session.pendingWorkingFolder.changed` in the same
//!   write, so every window of the session follows the move that waits.

mod pending;
mod sweep;
#[cfg(test)]
mod tests;

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use notify::{RecommendedWatcher, Watcher};
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::repo::folders::RepoMountRootResolutionReason;
use sidekicks_contracts::repo::mount::{RepoMountId, WorkspaceId, WorkspaceState};
use sidekicks_contracts::session::directory::{
    SessionWorkingFolderDisposition, SessionWorkingFolderUpdateRequest,
    SessionWorkingFolderUpdateResponse,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::not_found::session::session_not_found;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::PathRules;
#[cfg(test)]
use sidekicks_std::pause_point::PausePoint;
use sidekicks_std::settle_all::SettleFailures;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::log_service::EventLogService;
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_store::events::session::appender::{SessionEventAppender, SessionEventEmitError};
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use sidekicks_workspace::execution_root::{
    ExecutionRootError, ExecutionRootService, WorkspacePreparationHold,
};
use sidekicks_workspace::folder::canonical_path::canonical_folder_path;
use sidekicks_workspace::git::worktree::event_emitter::WorktreeEventEmitter;
use sidekicks_workspace::git::worktree::rows::UNRELEASED_RUNS_STATEMENT_CAPACITY;
use sidekicks_workspace::repo::errors::RepoRefusal;
use sidekicks_workspace::row_guards::CHECKOUT_ROOT_METADATA_PATH;
use sidekicks_workspace::run_setup_gates::execution_root::SessionFolderMoves;
use sidekicks_workspace::schema::MountOrigin;

use crate::refusals::working_folder_missing;
use crate::run::transitions::RUN_TERMINAL_STATES_SQL;
use crate::working_folder::pending::PendingMove;

/// The statements the working folders' reads keep prepared on each read connection: a session's
/// pending move, every pending move, a session's workspace, a mount's workspaces, a mount's root,
/// a session's live run, the removed tree it works in, and the unreleased runs a sweep reads, a
/// read the worktree service shares.
pub const SESSION_WORKING_FOLDERS_STATEMENT_CAPACITY: usize =
    7 + UNRELEASED_RUNS_STATEMENT_CAPACITY;

// Why a session with no working folder cannot move.
const CANNOT_MOVE: &str = "The session works in no folder any more, so it cannot move.";

// The session's own live workspace by where it works now: its execution root, else the checkout it
// last had. Only one on a project's mount moves; a chat's managed workspace never does.
static SELECT_SESSION_WORKSPACE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT workspace.id, workspace.state, workspace.repo_mount_id,
        mount.origin = '{attached}',
        coalesce(workspace.fs_root,
                 json_extract(workspace.metadata, '{CHECKOUT_ROOT_METADATA_PATH}'))
   FROM workspaces AS workspace
   JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
  WHERE workspace.session_id = @session_id AND workspace.state <> '{archived}'
    AND workspace.workflow_run_id IS NULL
  ORDER BY workspace.created_at DESC, workspace.id DESC
  LIMIT 1",
        attached = <&'static str>::from(MountOrigin::Attached),
        archived = <&'static str>::from(WorkspaceState::Archived),
    )
});

// An agent run of the session is live: one not yet ended, queued and starting included, or one
// whose context its end has not released yet. A workflow run holds no move: its steps stay on the
// root its context records.
static SELECT_LIVE_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT EXISTS (SELECT 1 FROM runs
                 WHERE session_id = @session_id AND state NOT IN ({terminal}))
     OR EXISTS (SELECT 1 FROM run_execution_contexts
                 WHERE session_id = @session_id AND released_at IS NULL
                   AND run_id IN (SELECT run_id FROM runs WHERE session_id = @session_id))",
        terminal = RUN_TERMINAL_STATES_SQL.as_str(),
    )
});

/// What the working folders run with; `W` is the worktree setup card's file watch.
pub struct SessionWorkingFoldersDeps<W = RecommendedWatcher> {
    /// The read pool, sized with [`SESSION_WORKING_FOLDERS_STATEMENT_CAPACITY`].
    pub reads: Arc<DatabaseReadPool>,
    /// The event log each change to a pending move is written to with its event.
    pub event_log: Arc<EventLogService>,
    /// The writer of a change to a pending move's workspace alone, which no event carries.
    pub writer: Arc<DatabaseWriter>,
    /// The owner of every workspace's preparation hold, which makes each move.
    pub execution_roots: Arc<ExecutionRootService<W>>,
    /// Appends each swept session's `session.sweptToCheckout`.
    pub worktree_events: Arc<WorktreeEventEmitter>,
}

/// Moves project sessions between the trees of their repository, and sweeps them out of a removed
/// one. See the module doc.
pub struct SessionWorkingFolders<W = RecommendedWatcher> {
    reads: Arc<DatabaseReadPool>,
    appender: SessionEventAppender,
    writer: Arc<DatabaseWriter>,
    execution_roots: Arc<ExecutionRootService<W>>,
    worktree_events: Arc<WorktreeEventEmitter>,
    /// Where a test holds a take of the pending move between its read and its clear.
    #[cfg(test)]
    pub(crate) pending_take_pause: PausePoint,
}

/// Why a working-folder move or sweep failed.
#[derive(Debug, thiserror::Error)]
pub enum SessionWorkingFolderError {
    /// A refusal sent with its code: `session.notFound`, `session.workingFolder.missing`,
    /// `repoMount.managed` or `repoMount.rootResolutionFailed`.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The move was refused or failed, boxed to keep the error small.
    #[error(transparent)]
    Root(Box<ExecutionRootError>),
    /// The database could not be read.
    #[error("the session's working-folder rows could not be read")]
    Read(#[from] DatabaseReadError),
    /// A stored row could not be read into its typed facts.
    #[error("a session's working-folder row could not be read")]
    Row(#[from] rusqlite::Error),
    /// A folder could not be resolved for comparison.
    #[error("a working folder could not be resolved")]
    Folder(#[source] io::Error),
    /// A change to the pending move, or a sweep's `session.sweptToCheckout`, was not written.
    #[error("the session's pending move or sweep could not be written")]
    Append(#[from] SessionEventEmitError),
    /// The workspace of a move to the folder already waiting was not written.
    #[error("the workspace of the session's pending move could not be written")]
    Write(#[from] WriteError),
    /// The removed tree's mount has no row to sweep its sessions to.
    #[error("cannot sweep worktree {worktree_id}: its mount {repo_mount_id} has no row")]
    MountMissing {
        /// The removed tree.
        worktree_id: WorktreeId,
        /// Its mount.
        repo_mount_id: RepoMountId,
    },
    /// One or more sessions of a sweep could not be swept; every other session was.
    #[error(transparent)]
    Sweep(#[from] SettleFailures<SessionSweepFailure>),
}

/// One session a sweep could not move or record.
#[derive(Debug, thiserror::Error)]
#[error("session {session_id} could not be swept out of the removed worktree")]
pub struct SessionSweepFailure {
    /// The session.
    pub session_id: SessionId,
    /// Why.
    #[source]
    pub failure: Box<SessionWorkingFolderError>,
}

impl From<SessionWorkingFolderError> for HandlerError {
    /// A refusal answers its code, a move's refusal as the execution roots answer it; anything
    /// else is a fault in the daemon.
    fn from(error: SessionWorkingFolderError) -> Self {
        match error {
            SessionWorkingFolderError::Refused(refusal) => Self::Refused(refusal),
            SessionWorkingFolderError::Root(root) => (*root).into(),
            fault @ (SessionWorkingFolderError::Read(_)
            | SessionWorkingFolderError::Row(_)
            | SessionWorkingFolderError::Folder(_)
            | SessionWorkingFolderError::Append(_)
            | SessionWorkingFolderError::Write(_)
            | SessionWorkingFolderError::MountMissing { .. }
            | SessionWorkingFolderError::Sweep(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

impl From<ExecutionRootError> for SessionWorkingFolderError {
    fn from(error: ExecutionRootError) -> Self {
        Self::Root(Box::new(error))
    }
}

/// The session's live workspace, as a move reads it.
#[derive(Clone, Debug)]
struct SessionWorkspace {
    id: WorkspaceId,
    state: WorkspaceState,
    // Where it works now: its root, else the checkout it last had.
    folder: Option<PathBuf>,
}

/// What taking a pending move found.
enum PendingTake {
    /// The move to make: the workspace it was asked for and its folder.
    Move(WorkspaceId, PathBuf),
    /// Nothing left to make: another caller took or replaced it first, or the session already
    /// works in its folder.
    Done,
    /// The session works in another workspace now, so the move was dropped.
    Dropped,
}

impl<W: Watcher + Send + Sync + 'static> SessionWorkingFolders<W> {
    /// The working folders over `deps`.
    pub fn new(deps: SessionWorkingFoldersDeps<W>) -> Self {
        Self {
            reads: deps.reads,
            appender: SessionEventAppender::new(deps.event_log, SESSION_EVENT_VERSION.clone()),
            writer: deps.writer,
            execution_roots: deps.execution_roots,
            worktree_events: deps.worktree_events,
            #[cfg(test)]
            pending_take_pause: PausePoint::default(),
        }
    }

    /// `session.workingFolder.update`: moves the session now when no run of it is live, else holds
    /// the move on its row for the run's end; the folder it already works in clears a held move.
    /// A move the session's own run end makes first answers `applied`, and one dropped because the
    /// session moved to another workspace before it was made answers `dropped`. Refuses
    /// `session.notFound`, `repoMount.rootResolutionFailed` (`notAbsolute`) for a relative path,
    /// `session.workingFolder.missing` for a session that works in no folder, `repoMount.managed`
    /// for a chat, and as the execution roots refuse a move.
    pub async fn set(
        &self,
        request: &SessionWorkingFolderUpdateRequest,
    ) -> Result<SessionWorkingFolderUpdateResponse, SessionWorkingFolderError> {
        let session_id = request.session_id;
        if self.read_pending(session_id).await?.is_none() {
            return Err(session_not_found(&session_id).into());
        }
        // A relative path would be completed from the daemon's own state into a wrong folder.
        if !PathRules::NATIVE.names_complete_location(request.path.as_str()) {
            return Err(DomainError::from(RepoRefusal::RootResolutionFailed {
                reason: RepoMountRootResolutionReason::NotAbsolute,
                detail: None,
            })
            .into());
        }
        let folder = Path::new(request.path.as_str());
        let workspace = self.require_project_workspace(session_id).await?;
        let response = |disposition| SessionWorkingFolderUpdateResponse {
            session_id,
            disposition,
            path: request.path.clone(),
        };
        if is_working_in(&workspace, folder).await? {
            self.store_pending(session_id, None).await?;
            return Ok(response(SessionWorkingFolderDisposition::Applied));
        }
        // Read under the hold, which a run's gate holds while it binds the run, so no run is bound
        // between the read and the move.
        let hold = self.execution_roots.hold_preparation(workspace.id).await;
        if !self.is_run_live(session_id).await? {
            self.execution_roots
                .move_to_folder_held(&hold, folder, None)
                .await?;
            drop(hold);
            self.store_pending(session_id, None).await?;
            return Ok(response(SessionWorkingFolderDisposition::Applied));
        }
        drop(hold);
        self.execution_roots
            .require_listed_tree(workspace.id, folder)
            .await?;
        self.store_pending(session_id, Some((&request.path, workspace.id)))
            .await?;
        // A run that ended while the tree was checked found no move to apply, so it is made now.
        Ok(response(self.apply_pending_unheld(session_id, None).await?))
    }

    // Applies the session's pending move under the hold of the workspace it was asked for, the
    // move's events under `append_hold`: `pending` while a live run keeps it, `dropped` when the
    // session works in another workspace now, else `applied`. The live run is read under the hold,
    // which a run's gate holds while it binds the run, so a run bound before it keeps the move for
    // that run's own end.
    async fn apply_pending_unheld(
        &self,
        session_id: SessionId,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<SessionWorkingFolderDisposition, SessionWorkingFolderError> {
        let Some(Some(pending)) = self.read_pending(session_id).await? else {
            return Ok(SessionWorkingFolderDisposition::Applied);
        };
        let hold = self
            .execution_roots
            .hold_preparation(pending.workspace_id)
            .await;
        if self.is_run_live(session_id).await? {
            return Ok(SessionWorkingFolderDisposition::Pending);
        }
        // A move replaced since the read is left to the request that replaced it.
        let append_hold = held_for(append_hold, session_id);
        match self.take_pending(session_id, pending, append_hold).await? {
            PendingTake::Move(_, folder) => {
                self.execution_roots
                    .move_to_folder_held(&hold, &folder, append_hold)
                    .await?;
                Ok(SessionWorkingFolderDisposition::Applied)
            }
            PendingTake::Done => Ok(SessionWorkingFolderDisposition::Applied),
            PendingTake::Dropped => Ok(SessionWorkingFolderDisposition::Dropped),
        }
    }

    // Takes `pending`, the session's pending move as read, clearing it before it is made so a move
    // that fails surfaces once and never wedges every later run; the clear's event goes under
    // `append_hold` when given. Only the caller whose clear removed the row takes it, so two
    // appliers never both make one move.
    async fn take_pending(
        &self,
        session_id: SessionId,
        pending: PendingMove,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<PendingTake, SessionWorkingFolderError> {
        #[cfg(test)]
        self.pending_take_pause.pass().await;
        if !self
            .clear_pending(session_id, &pending, append_hold)
            .await?
        {
            return Ok(PendingTake::Done);
        }
        let workspace = self.require_project_workspace(session_id).await?;
        if workspace.id != pending.workspace_id {
            tracing::info!(
                session_id = session_id.text().as_str(),
                pending_workspace_id = %pending.workspace_id,
                live_workspace_id = %workspace.id,
                "a pending move for a workspace the session no longer works in was dropped"
            );
            return Ok(PendingTake::Dropped);
        }
        let folder = PathBuf::from(pending.path);
        if is_working_in(&workspace, &folder).await? {
            return Ok(PendingTake::Done);
        }
        Ok(PendingTake::Move(workspace.id, folder))
    }

    async fn require_project_workspace(
        &self,
        session_id: SessionId,
    ) -> Result<SessionWorkspace, SessionWorkingFolderError> {
        let read = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_session_workspace(connection, session_id)
            })
            .await?;
        let Some((workspace, repo_mount_id, is_project)) = read else {
            return Err(working_folder_missing(&session_id, CANNOT_MOVE).into());
        };
        if !is_project {
            return Err(DomainError::from(RepoRefusal::MountManaged { repo_mount_id }).into());
        }
        Ok(workspace)
    }

    async fn is_run_live(&self, session_id: SessionId) -> Result<bool, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_LIVE_RUN_SQL.as_str())?
                    .query_row(
                        named_params! { "@session_id": session_id.text().as_str() },
                        |row| row.get::<_, bool>(0),
                    )?)
            })
            .await
    }
}

impl<W: Watcher + Send + Sync + 'static> SessionFolderMoves for SessionWorkingFolders<W> {
    /// Applies the session's pending move under the gate's hold of the workspace it moves. A move
    /// asked for another workspace than the hold's, or for one the session no longer works in, is
    /// dropped.
    fn apply_pending_held<'a>(
        &'a self,
        session_id: &'a SessionId,
        hold: &'a WorkspacePreparationHold<'_>,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            let Some(Some(pending)) = self.read_pending(*session_id).await? else {
                return Ok(());
            };
            let PendingTake::Move(workspace_id, folder) =
                self.take_pending(*session_id, pending, None).await?
            else {
                return Ok(());
            };
            if workspace_id != hold.workspace_id() {
                tracing::info!(
                    session_id = session_id.text().as_str(),
                    pending_workspace_id = %workspace_id,
                    held_workspace_id = %hold.workspace_id(),
                    "a pending move for a workspace the run does not hold was dropped"
                );
                return Ok(());
            }
            self.execution_roots
                .move_to_folder_held(hold, &folder, None)
                .await?;
            Ok(())
        }
        .boxed()
    }

    /// Applies the session's pending move at its run's end, each event under `hold`.
    fn apply_pending<'a>(
        &'a self,
        session_id: &'a SessionId,
        hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.apply_pending_unheld(*session_id, hold).await?;
            Ok(())
        }
        .boxed()
    }

    /// Sweeps the session out of a removed tree it still works in: the sweep its removal passed
    /// over while a run of it was bound there. A session in no removed tree is left as it is.
    fn sweep_from_removed_tree<'a>(
        &'a self,
        session_id: &'a SessionId,
        hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            if let Some(sweep) = self.read_removed_tree_of(*session_id).await? {
                self.sweep(&sweep, hold).await?;
            }
            Ok(())
        }
        .boxed()
    }
}

// The session's live workspace with its mount and whether that mount is a project's.
fn read_session_workspace(
    connection: &Connection,
    session_id: SessionId,
) -> Result<Option<(SessionWorkspace, RepoMountId, bool)>, SessionWorkingFolderError> {
    Ok(connection
        .prepare_cached(&SELECT_SESSION_WORKSPACE_SQL)?
        .query_row(
            named_params! { "@session_id": session_id.text().as_str() },
            |row| {
                Ok((
                    SessionWorkspace {
                        id: text_column(row, 0, |text| WorkspaceId::new(&text))?,
                        state: text_column(row, 1, closed_word)?,
                        folder: row.get::<_, Option<String>>(4)?.map(PathBuf::from),
                    },
                    text_column(row, 2, |text| RepoMountId::new(&text))?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )
        .optional()?)
}

// A `preparing` or `rootLost` workspace is not yet working in its folder, so asking for it again
// moves it there, which repairs it.
async fn is_working_in(
    workspace: &SessionWorkspace,
    requested: &Path,
) -> Result<bool, SessionWorkingFolderError> {
    let Some(folder) = &workspace.folder else {
        return Ok(false);
    };
    Ok(workspace.state == WorkspaceState::Ready
        && canonical(folder).await? == canonical(requested).await?)
}

async fn canonical(folder: &Path) -> Result<PathBuf, SessionWorkingFolderError> {
    canonical_folder_path(folder)
        .await
        .map_err(SessionWorkingFolderError::Folder)
}

// The caller's append hold when it holds `session_id`, the session whose events are appended.
fn held_for(
    append_hold: Option<&SessionAppendHold>,
    session_id: SessionId,
) -> Option<&SessionAppendHold> {
    append_hold.filter(|hold| *hold.key() == session_id)
}
