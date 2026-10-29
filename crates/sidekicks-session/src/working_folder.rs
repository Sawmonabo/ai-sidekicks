//! A project session's working folder: moving it into any tree its repository has, at once while no
//! run of the session is live, or as a pending move on the session's own row that the run's next
//! boundary applies. The row holds at most one, so a later request replaces it, and a request for
//! the folder the session already works in clears it. A removed tree's sessions are swept back to
//! the repository's own checkout; one whose run is still bound there keeps its folder until that
//! run is released, and is swept at that run's end.
//!
//! - Each move takes one workspace's preparation hold at a time, and a move at a run's boundary
//!   runs under the hold the gate gives it, never taking it again.
//! - A run may end under the engine's hold of its session's append lock; every event a move or a
//!   sweep appends on that session goes under that hold, never waiting on it.
//! - A move ends in `workspace.prepared` and a sweep in `session.sweptToCheckout`, so the session's
//!   live folder follows either.

#[cfg(test)]
mod tests;

use std::borrow::Cow;
use std::collections::BTreeSet;
use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use notify::{RecommendedWatcher, Watcher};
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::repo::folders::RepoMountRootResolutionReason;
use sidekicks_contracts::repo::mount::{RepoMountId, WorkspaceId, WorkspaceState};
use sidekicks_contracts::session::directory::{
    SessionWorkingFolderDisposition, SessionWorkingFolderUpdateRequest,
    SessionWorkingFolderUpdateResponse,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::worktree::events::SessionSweptToCheckoutPayload;
use sidekicks_contracts::worktree::lifecycle::{WorktreeId, WorktreeState};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::session_not_found::session_not_found;
use sidekicks_platforms::PathRules;
#[cfg(test)]
use sidekicks_std::pause_point::PausePoint;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::{closed_word, text_column};
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_store::events::session::appender::{SessionEventEmitError, SessionEventLinkage};
use sidekicks_workspace::execution_root::{
    ExecutionRootError, ExecutionRootService, WorkspacePreparationHold,
};
use sidekicks_workspace::folder::canonical_path::canonical_folder_path;
use sidekicks_workspace::git::worktree::event_emitter::WorktreeEventEmitter;
use sidekicks_workspace::git::worktree::removal::{WorktreeSessionSweep, WorktreeSweep};
use sidekicks_workspace::repo::errors::RepoRefusal;
use sidekicks_workspace::row_guards::CHECKOUT_ROOT_METADATA_PATH;
use sidekicks_workspace::run_setup_gates::execution_root::SessionFolderMoves;
use sidekicks_workspace::schema::MountOrigin;

use crate::directory::lookups::{SessionWriteError, write_while_session_exists};
use crate::refusals::working_folder_missing;
use crate::run::transitions::RUN_TERMINAL_STATES_SQL;

/// The statements the working folders' reads keep prepared on each read connection: a session's
/// pending move, every pending move, a session's workspace, a mount's workspaces, a mount's root,
/// a session's live run, its bound run and the removed tree it works in.
pub const SESSION_WORKING_FOLDERS_STATEMENT_CAPACITY: usize = 8;

// Why a session with no working folder cannot move.
const CANNOT_MOVE: &str = "The session works in no folder any more, so it cannot move.";

const SELECT_PENDING_SQL: &str =
    "SELECT pending_working_folder, pending_working_folder_workspace_id
  FROM sessions WHERE id = @session_id";

const SELECT_EVERY_PENDING_SQL: &str =
    "SELECT id, pending_working_folder FROM sessions WHERE pending_working_folder IS NOT NULL";

const SELECT_MOUNT_ROOT_SQL: &str = "SELECT canonical_root FROM repo_mounts WHERE id = @id";

// The session's live workspace by where it works now: its execution root, else the checkout it
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
  ORDER BY workspace.created_at DESC, workspace.id DESC
  LIMIT 1",
        attached = <&'static str>::from(MountOrigin::Attached),
        archived = <&'static str>::from(WorkspaceState::Archived),
    )
});

// Each live workspace on the mount by the checkout it works in, so one bound to a folder inside a
// tree stands in that tree; a workspace without a recorded checkout stands at its root.
static SELECT_MOUNT_WORKSPACES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, session_id,
        coalesce(json_extract(metadata, '{CHECKOUT_ROOT_METADATA_PATH}'), fs_root)
   FROM workspaces
  WHERE repo_mount_id = @repo_mount_id AND state <> '{archived}'
  ORDER BY created_at, id",
        archived = <&'static str>::from(WorkspaceState::Archived),
    )
});

// A run of the session is live: one not yet ended, queued and starting included, or one whose
// context its end has not released yet.
static SELECT_LIVE_RUN_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT EXISTS (SELECT 1 FROM runs
                 WHERE session_id = @session_id AND state NOT IN ({terminal}))
     OR EXISTS (SELECT 1 FROM run_execution_contexts
                 WHERE session_id = @session_id AND released_at IS NULL)",
        terminal = RUN_TERMINAL_STATES_SQL.as_str(),
    )
});

// A run of the session still bound to its folder: its context not yet released.
const SELECT_BOUND_RUN_SQL: &str = "SELECT EXISTS (SELECT 1 FROM run_execution_contexts
  WHERE session_id = @session_id AND released_at IS NULL)";

// The removed tree the session's live workspace still works in, if any.
static SELECT_REMOVED_TREE_OF_SESSION_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT tree.id, tree.repo_mount_id, tree.fs_root
   FROM workspaces AS workspace
   JOIN worktrees AS tree
     ON tree.repo_mount_id = workspace.repo_mount_id
    AND tree.state = '{retired}'
    AND tree.fs_root = coalesce(json_extract(workspace.metadata, '{CHECKOUT_ROOT_METADATA_PATH}'),
                                workspace.fs_root)
  WHERE workspace.session_id = @session_id AND workspace.state <> '{archived}'
  ORDER BY tree.updated_at DESC, tree.id DESC
  LIMIT 1",
        retired = <&'static str>::from(WorktreeState::Retired),
        archived = <&'static str>::from(WorkspaceState::Archived),
    )
});

const SET_PENDING_SQL: &str = "UPDATE sessions
  SET pending_working_folder = @path, pending_working_folder_workspace_id = @workspace_id
  WHERE id = @session_id";

// Clears the pending move only while it still names `@path` and `@workspace_id`, so a newer
// request survives.
const CLEAR_PENDING_AT_SQL: &str = "UPDATE sessions
  SET pending_working_folder = NULL, pending_working_folder_workspace_id = NULL
  WHERE id = @session_id AND pending_working_folder = @path
    AND pending_working_folder_workspace_id = @workspace_id";

/// What the working folders run with; `W` is the worktree setup card's file watch.
pub struct SessionWorkingFoldersDeps<W = RecommendedWatcher> {
    /// The read pool, sized with [`SESSION_WORKING_FOLDERS_STATEMENT_CAPACITY`].
    pub reads: Arc<DatabaseReadPool>,
    /// The writer the pending moves go through.
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
    /// The pending move could not be written.
    #[error("the session's pending move could not be written")]
    Write(#[from] WriteError),
    /// A folder could not be resolved for comparison.
    #[error("a working folder could not be resolved")]
    Folder(#[source] io::Error),
    /// A sweep's `session.sweptToCheckout` was not appended.
    #[error("the session's sweep could not be recorded")]
    Append(#[from] SessionEventEmitError),
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

impl From<SessionWriteError> for SessionWorkingFolderError {
    fn from(error: SessionWriteError) -> Self {
        match error {
            SessionWriteError::Refused(refusal) => Self::Refused(refusal),
            SessionWriteError::Write(fault) => Self::Write(fault),
        }
    }
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
            | SessionWorkingFolderError::Write(_)
            | SessionWorkingFolderError::Folder(_)
            | SessionWorkingFolderError::Append(_)
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

/// A move held on the session's row: the folder, as stored, and the workspace it was asked for.
struct PendingMove {
    path: String,
    workspace_id: WorkspaceId,
}

/// A live workspace on a swept mount.
struct MountWorkspace {
    id: WorkspaceId,
    session_id: SessionId,
    // The checkout it works in, else its root.
    folder: Option<PathBuf>,
}

impl<W: Watcher + Send + Sync + 'static> SessionWorkingFolders<W> {
    /// The working folders over `deps`.
    pub fn new(deps: SessionWorkingFoldersDeps<W>) -> Self {
        Self {
            reads: deps.reads,
            writer: deps.writer,
            execution_roots: deps.execution_roots,
            worktree_events: deps.worktree_events,
            #[cfg(test)]
            pending_take_pause: PausePoint::default(),
        }
    }

    /// `session.workingFolder.update`: moves the session now when no run of it is live, else holds
    /// the move on its row for the run's end; the folder it already works in clears a held move.
    /// Refuses `session.notFound`, `repoMount.rootResolutionFailed` (`notAbsolute`) for a relative
    /// path, `session.workingFolder.missing` for a session that works in no folder,
    /// `repoMount.managed` for a chat, and as the execution roots refuse a move.
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
            self.write_pending(session_id, None).await?;
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
            self.write_pending(session_id, None).await?;
            return Ok(response(SessionWorkingFolderDisposition::Applied));
        }
        drop(hold);
        self.execution_roots
            .require_listed_tree(workspace.id, folder)
            .await?;
        self.write_pending(session_id, Some((request.path.as_str(), workspace.id)))
            .await?;
        // A run that ended while the tree was checked found no move to apply, so it is made now.
        Ok(response(
            if self.apply_pending_unheld(session_id, None).await? {
                SessionWorkingFolderDisposition::Pending
            } else {
                SessionWorkingFolderDisposition::Applied
            },
        ))
    }

    // Applies the session's pending move under the hold of the workspace it was asked for, the
    // move's events under `append_hold`, answering whether a live run keeps it pending. The live
    // run is read under the hold, which a run's gate holds while it binds the run, so a run bound
    // before it keeps the move for that run's own end.
    async fn apply_pending_unheld(
        &self,
        session_id: SessionId,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<bool, SessionWorkingFolderError> {
        let Some(Some(pending)) = self.read_pending(session_id).await? else {
            return Ok(false);
        };
        let hold = self
            .execution_roots
            .hold_preparation(pending.workspace_id)
            .await;
        if self.is_run_live(session_id).await? {
            return Ok(true);
        }
        // A move replaced since the read is left to the request that replaced it.
        if let Some((_, folder)) = self.take_pending(session_id, pending).await? {
            self.execution_roots
                .move_to_folder_held(&hold, &folder, held_for(append_hold, session_id))
                .await?;
        }
        Ok(false)
    }

    // Takes `pending`, the session's pending move as read, clearing it before it is made so a move
    // that fails surfaces once and never wedges every later run: the workspace it was asked for and
    // its folder, `None` when another caller took or replaced it first, the session works in
    // another workspace now, or it already works there. Only the caller whose clear removed the row
    // takes it, so two appliers never both make one move.
    async fn take_pending(
        &self,
        session_id: SessionId,
        pending: PendingMove,
    ) -> Result<Option<(WorkspaceId, PathBuf)>, SessionWorkingFolderError> {
        #[cfg(test)]
        self.pending_take_pause.pass().await;
        let cleared = self
            .writer
            .write(vec![clear_pending_statement(session_id, &pending)])
            .await?;
        if cleared.first().is_none_or(|clear| clear.row_count == 0) {
            return Ok(None);
        }
        let workspace = self.require_project_workspace(session_id).await?;
        if workspace.id != pending.workspace_id {
            tracing::info!(
                session_id = session_id.text().as_str(),
                pending_workspace_id = %pending.workspace_id,
                live_workspace_id = %workspace.id,
                "a pending move for a workspace the session no longer works in was dropped"
            );
            return Ok(None);
        }
        let folder = PathBuf::from(pending.path);
        if is_working_in(&workspace, &folder).await? {
            return Ok(None);
        }
        Ok(Some((workspace.id, folder)))
    }

    // Moves every session standing in the removed tree to the repository's own checkout and clears
    // every pending move to it, one `session.sweptToCheckout` per session either touched; a
    // session whose run is still bound there is passed over until that run's end. Each session is
    // tried, each under its own workspace's hold, and the failures answered together. Events of the
    // session `append_hold` holds go under it.
    async fn sweep(
        &self,
        sweep: &WorktreeSweep,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<(), SessionWorkingFolderError> {
        let checkout = self.read_mount_root(sweep).await?;
        let folder = canonical(Path::new(sweep.folder.as_str())).await?;
        let mut pending_sessions = BTreeSet::new();
        for (session_id, pending) in self.read_every_pending().await? {
            if canonical(&pending).await? == folder {
                pending_sessions.insert(session_id);
            }
        }
        let mut standing = Vec::new();
        for workspace in self.read_mount_workspaces(sweep.repo_mount_id).await? {
            if let Some(workspace_folder) = &workspace.folder
                && canonical(workspace_folder).await? == folder
            {
                standing.push(workspace);
            }
        }

        let mut outcomes = Vec::new();
        for workspace in standing {
            if self.is_run_bound(workspace.session_id).await? {
                // Its pending move to the tree is cleared with its sweep, in one event.
                pending_sessions.remove(&workspace.session_id);
                continue;
            }
            let is_pending_cleared = pending_sessions.remove(&workspace.session_id);
            let session_id = workspace.session_id;
            let swept = self
                .sweep_session(
                    sweep,
                    session_id,
                    Some((workspace.id, checkout.as_path())),
                    is_pending_cleared.then_some(folder.as_path()),
                    held_for(append_hold, session_id),
                )
                .await;
            outcomes.push(swept.map_err(|failure| sweep_failure(session_id, failure)));
        }
        for session_id in pending_sessions {
            let swept = self
                .sweep_session(
                    sweep,
                    session_id,
                    None,
                    Some(folder.as_path()),
                    held_for(append_hold, session_id),
                )
                .await;
            outcomes.push(swept.map_err(|failure| sweep_failure(session_id, failure)));
        }
        settle_all(outcomes, "sweeping the sessions out of a removed worktree")?;
        Ok(())
    }

    // Moves `session_id`'s workspace to the checkout when `moved` names one, then records its
    // sweep, clearing its pending move into the tree `cleared_folder` keys when given.
    async fn sweep_session(
        &self,
        sweep: &WorktreeSweep,
        session_id: SessionId,
        moved: Option<(WorkspaceId, &Path)>,
        cleared_folder: Option<&Path>,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<(), SessionWorkingFolderError> {
        if let Some((workspace_id, checkout)) = moved {
            let hold = self.execution_roots.hold_preparation(workspace_id).await;
            self.execution_roots
                .move_to_folder_held(&hold, checkout, append_hold)
                .await?;
        }
        let mut transactional_prelude = Vec::new();
        if let Some(folder) = cleared_folder {
            // The clear names the stored spelling, which the sweep matched by its resolved form.
            if let Some(Some(pending)) = self.read_pending(session_id).await?
                && canonical(Path::new(&pending.path)).await?.as_path() == folder
            {
                transactional_prelude.push(clear_pending_statement(session_id, &pending));
            }
        }
        let payload = SessionSweptToCheckoutPayload {
            session_id,
            repo_mount_id: sweep.repo_mount_id,
            worktree_id: sweep.worktree_id,
            pending_move_cleared: cleared_folder.is_some().then(True::default),
        };
        self.worktree_events
            .emit_session_swept_to_checkout(
                payload,
                SessionEventLinkage {
                    transactional_prelude,
                    ..SessionEventLinkage::default()
                },
                append_hold,
            )
            .await?;
        Ok(())
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

    // `None` for a session with no row, else its pending move.
    async fn read_pending(
        &self,
        session_id: SessionId,
    ) -> Result<Option<Option<PendingMove>>, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_PENDING_SQL)?
                    .query_row(
                        named_params! { "@session_id": session_id.text().as_str() },
                        |row| {
                            let Some(path) = row.get::<_, Option<String>>(0)? else {
                                return Ok(None);
                            };
                            Ok(Some(PendingMove {
                                path,
                                workspace_id: text_column(row, 1, |text| WorkspaceId::new(&text))?,
                            }))
                        },
                    )
                    .optional()?)
            })
            .await
    }

    async fn read_every_pending(
        &self,
    ) -> Result<Vec<(SessionId, PathBuf)>, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(SELECT_EVERY_PENDING_SQL)?
                    .query_map([], |row| {
                        Ok((
                            text_column(row, 0, |text| SessionId::new(&text))?,
                            PathBuf::from(row.get::<_, String>(1)?),
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    async fn read_mount_workspaces(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<Vec<MountWorkspace>, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_MOUNT_WORKSPACES_SQL)?
                    .query_map(
                        named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
                        |row| {
                            Ok(MountWorkspace {
                                id: text_column(row, 0, |text| WorkspaceId::new(&text))?,
                                session_id: text_column(row, 1, |text| SessionId::new(&text))?,
                                folder: row.get::<_, Option<String>>(2)?.map(PathBuf::from),
                            })
                        },
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()?)
            })
            .await
    }

    async fn read_mount_root(
        &self,
        sweep: &WorktreeSweep,
    ) -> Result<PathBuf, SessionWorkingFolderError> {
        let repo_mount_id = sweep.repo_mount_id;
        let root = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, SessionWorkingFolderError>(
                    connection
                        .prepare_cached(SELECT_MOUNT_ROOT_SQL)?
                        .query_row(
                            named_params! { "@id": repo_mount_id.text().as_str() },
                            |row| row.get::<_, String>(0),
                        )
                        .optional()?,
                )
            })
            .await?;
        root.map(PathBuf::from)
            .ok_or(SessionWorkingFolderError::MountMissing {
                worktree_id: sweep.worktree_id,
                repo_mount_id,
            })
    }

    async fn read_removed_tree_of(
        &self,
        session_id: SessionId,
    ) -> Result<Option<WorktreeSweep>, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection
                    .prepare_cached(&SELECT_REMOVED_TREE_OF_SESSION_SQL)?
                    .query_row(
                        named_params! { "@session_id": session_id.text().as_str() },
                        |row| {
                            Ok(WorktreeSweep {
                                worktree_id: text_column(row, 0, |text| WorktreeId::new(&text))?,
                                repo_mount_id: text_column(row, 1, |text| RepoMountId::new(&text))?,
                                folder: text_column(row, 2, FilesystemPath::new)?,
                            })
                        },
                    )
                    .optional()?)
            })
            .await
    }

    async fn is_run_live(&self, session_id: SessionId) -> Result<bool, SessionWorkingFolderError> {
        self.read_session_flag(SELECT_LIVE_RUN_SQL.as_str(), session_id)
            .await
    }

    async fn is_run_bound(&self, session_id: SessionId) -> Result<bool, SessionWorkingFolderError> {
        self.read_session_flag(SELECT_BOUND_RUN_SQL, session_id)
            .await
    }

    // The one boolean `sql` reads for the session.
    async fn read_session_flag(
        &self,
        sql: &'static str,
        session_id: SessionId,
    ) -> Result<bool, SessionWorkingFolderError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok(connection.prepare_cached(sql)?.query_row(
                    named_params! { "@session_id": session_id.text().as_str() },
                    |row| row.get::<_, bool>(0),
                )?)
            })
            .await
    }

    // Stores `pending`, a folder and the workspace it was asked for, as the session's pending
    // move, or clears it with `None`; refuses `session.notFound` for a session purged meanwhile.
    async fn write_pending(
        &self,
        session_id: SessionId,
        pending: Option<(&str, WorkspaceId)>,
    ) -> Result<(), SessionWorkingFolderError> {
        let workspace_text = pending.map(|(_, workspace_id)| workspace_id.text());
        write_while_session_exists(
            &self.writer,
            &session_id,
            WriteStatement {
                sql: Cow::Borrowed(SET_PENDING_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@session_id", session_id.text().as_str()),
                    nullable_text_binding("@path", pending.map(|(path, _)| path)),
                    nullable_text_binding(
                        "@workspace_id",
                        workspace_text.as_ref().map(UuidText::as_str),
                    ),
                ]),
                expected_row_count: Some(1),
            },
        )
        .await?;
        Ok(())
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
            let Some((workspace_id, folder)) = self.take_pending(*session_id, pending).await?
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

impl<W: Watcher + Send + Sync + 'static> WorktreeSessionSweep for SessionWorkingFolders<W> {
    /// Sweeps every session standing in the removed tree, and every pending move into it.
    fn sweep_to_repo_root<'a>(
        &'a self,
        sweep: &'a WorktreeSweep,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            self.sweep(sweep, None).await?;
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

fn sweep_failure(session_id: SessionId, failure: SessionWorkingFolderError) -> SessionSweepFailure {
    SessionSweepFailure {
        session_id,
        failure: Box::new(failure),
    }
}

fn clear_pending_statement(session_id: SessionId, pending: &PendingMove) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(CLEAR_PENDING_AT_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@session_id", session_id.text().as_str()),
            text_binding("@path", &pending.path),
            text_binding("@workspace_id", pending.workspace_id.text().as_str()),
        ]),
        expected_row_count: None,
    }
}
