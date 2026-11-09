//! The run setup gate that binds a run to its session's working folder before the provider starts
//! it: it applies a move the session held for this boundary, makes the first root of a workspace
//! still `preparing` (a worktree named from the session's title, or the bound folder), and writes
//! the run's execution context: the folder, the working tree around it and the repository's git
//! folder, which outlives a removed tree. Nothing holds the workspace while a run works in it, so
//! two sessions' runs may work in one folder. The run's end stamps the context released, sweeps the
//! session out of a removed tree and applies a move held during the run.
//!
//! - The run's workspace is the one its send named, else its parent's for a helper the provider
//!   started, else the session's newest; a named one the session no longer holds live refuses the
//!   run `workspace.notFound` rather than placing it elsewhere.
//! - A helper is no run boundary: it applies no held move and sweeps nothing, and binds at the
//!   root its own parent run's live context holds, since it works in its parent's folder; a helper
//!   whose parent is bound in no workspace binds nothing.
//! - A workspace a re-attach moved waits `preparing` with its root kept; the gate admits it again
//!   first, so a run never binds the old repository's root.
//! - Only the binding holds the workspace's preparation hold, and everything it calls takes that
//!   hold, never the lock. The context write also holds the checkout's lock, taken second, so a
//!   carry out of that checkout never stashes between its last check and its stash while a run is
//!   bound there.
//! - The context is written only while the workspace is `ready` on the attached mount the binding
//!   read and its checkout is no retired tree still to be cleaned, so a detach, re-attach or
//!   removal that commits meanwhile refuses the run.
//! - A run folder whose git folder is not the mount's repository is refused, so a run never works
//!   in another repository's checkout. A chat's run writes no context: its folder is no project's
//!   checkout.
//! - A workflow run started in a project session binds the same way, then answers its context row
//!   for the start's own write, which holds the checkout's lock around it; a tree its binding makes
//!   names no agent run as its creator.

pub mod context;
#[cfg(test)]
mod tests;

use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use futures::future::BoxFuture;
use notify::{RecommendedWatcher, Watcher};
use rusqlite::{Connection, OptionalExtension, named_params};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, WorkspaceId, WorkspaceState};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_contracts::worktree::lifecycle::{BranchContextId, WorktreeId};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::file::real_location::resolve_real_path;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
#[cfg(test)]
use sidekicks_std::pause_point::PausePoint;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};
use sidekicks_store::database::writer::DatabaseWriter;
use sidekicks_store::events::session::append_lock::SessionAppendHold;

use self::context::{
    RunContextBinding, SessionRunBinder, context_statement, release_run_context_statement,
};
use super::{RunSetupContext, RunSetupGate, RunSetupGateError, RunTerminalContext};
use crate::errors::{
    WorkspaceRefusal, WorkspaceServiceInvariantError, WorkspaceServiceInvariantKind,
};
use crate::execution_root::{ExecutionRootError, ExecutionRootService, WorkspacePreparationHold};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::{GitRunner, read_git_common_folder};
use crate::git::worktree::errors::WorktreeRefusal;
use crate::git::worktree::naming::{derive_run_tail, suggest_tail_for};
use crate::git::worktree::rows::standing_worktree_state_predicate;
use crate::project::list_feed::ProjectListFeed;
use crate::repo::mount::reattach::RepoMountReattachService;
use crate::row_guards::{CHECKOUT_ROOT_METADATA_PATH, COMMON_DIR_METADATA_PATH};
use crate::service::{WorkspaceService, root_mismatch};
use crate::trust_envelope::components_equal;

/// The statements the gate's reads keep prepared on each read connection: the run's workspace,
/// the session's title, the root's ids and a helper's parent's context.
pub const EXECUTION_ROOT_SETUP_GATE_STATEMENT_CAPACITY: usize = 4;

// The session's live workspace the run names, else its newest, when a detach left an older one
// archived; with its mount's anchor, place and whether the mount is a chat's own.
static SELECT_RUN_WORKSPACE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT workspace.id, workspace.repo_mount_id, workspace.execution_mode, workspace.state,
        workspace.fs_root, json_extract(workspace.metadata, '{CHECKOUT_ROOT_METADATA_PATH}'),
        json_extract(mount.metadata, '{COMMON_DIR_METADATA_PATH}'), mount.place,
        mount.managed_session_id IS NOT NULL
   FROM workspaces AS workspace
   JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
  WHERE workspace.session_id = @session_id AND workspace.state <> '{archived}'
    AND (@workspace_id IS NULL OR workspace.id = @workspace_id)
  ORDER BY workspace.created_at DESC, workspace.id DESC
  LIMIT 1",
        archived = <&'static str>::from(WorkspaceState::Archived),
    )
});

const SELECT_SESSION_TITLE_SQL: &str =
    "SELECT name, first_message_preview FROM sessions WHERE id = @session_id";

// The daemon's standing tree at a `provisionedWorktree` root, and the workspace's newest context
// for it; for a `boundRoot` root, its newest context with no tree.
static SELECT_RUN_ROOT_IDS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT tree.id,
        (SELECT context.id FROM branch_contexts AS context
          WHERE context.workspace_id = @workspace_id AND context.worktree_id IS tree.id
          ORDER BY context.updated_at DESC, context.id DESC
          LIMIT 1)
   FROM (SELECT 1) AS anchor
   LEFT JOIN worktrees AS tree
     ON @execution_mode = '{provisioned}' AND tree.fs_root = @execution_root
    AND {standing}",
        provisioned = <&'static str>::from(ExecutionMode::ProvisionedWorktree),
        standing = standing_worktree_state_predicate("tree"),
    )
});

// A helper's parent run's live context in the workspace, whose root the helper binds at.
const SELECT_PARENT_CONTEXT_SQL: &str = "SELECT execution_mode, execution_root, checkout_root,
        git_common_dir, worktree_id, branch_context_id
   FROM run_execution_contexts
  WHERE run_id = @parent_run_id AND session_id = @session_id AND workspace_id = @workspace_id
    AND released_at IS NULL";

/// The session's working-folder moves the gate drives at a run's boundaries, which the session
/// crate implements. Each fails with the implementation's own failure.
pub trait SessionFolderMoves: Send + Sync {
    /// Applies the move `session_id` held for the run's boundary, under the caller's hold of the
    /// workspace it moves; does nothing when none is held.
    fn apply_pending_held<'a>(
        &'a self,
        session_id: &'a SessionId,
        hold: &'a WorkspacePreparationHold<'_>,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Applies the move `session_id` held during a run that has ended, taking the workspace's hold
    /// itself; does nothing when none is held. `hold` is the caller's hold on the session's append
    /// lock, which the move's events are appended under.
    fn apply_pending<'a>(
        &'a self,
        session_id: &'a SessionId,
        hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Moves `session_id` out of a tree removed under it, back to its repository's checkout,
    /// taking each swept workspace's hold itself; does nothing while it works in no removed tree.
    /// `hold` is the caller's hold on the session's append lock, which that session's events are
    /// appended under.
    fn sweep_from_removed_tree<'a>(
        &'a self,
        session_id: &'a SessionId,
        hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// What the gate runs with; `W` is the worktree setup card's file watch.
pub struct ExecutionRootSetupGateDeps<W = RecommendedWatcher> {
    /// The writer the run contexts go through.
    pub writer: Arc<DatabaseWriter>,
    /// The read pool, sized with [`EXECUTION_ROOT_SETUP_GATE_STATEMENT_CAPACITY`].
    pub reads: Arc<DatabaseReadPool>,
    /// The daemon's git, which names the run folder's repository.
    pub git: GitRunner,
    /// The workspace lifecycle, whose write gate a ready workspace passes.
    pub workspaces: Arc<WorkspaceService>,
    /// The owner of every workspace's preparation hold, which makes a first root.
    pub execution_roots: Arc<ExecutionRootService<W>>,
    /// Admits again a workspace a re-attach moved, when a run reaches it first; built over the
    /// same `execution_roots`.
    pub reattach: Arc<RepoMountReattachService<W>>,
    /// The session's working-folder moves.
    pub moves: Arc<dyn SessionFolderMoves>,
    /// The worktree creator's per-checkout lock, keyed by the canonical folder, held around the
    /// context write.
    pub checkout_lock: Arc<KeyedLock<PathBuf>>,
    /// The projects list, told when a run's held root changes.
    pub list_feed: Arc<ProjectListFeed>,
}

/// Binds each repository-bound run to its working folder; registered on the run engine's setup
/// gates. See the module doc.
pub struct ExecutionRootSetupGate<W = RecommendedWatcher> {
    writer: Arc<DatabaseWriter>,
    reads: Arc<DatabaseReadPool>,
    git: GitRunner,
    workspaces: Arc<WorkspaceService>,
    execution_roots: Arc<ExecutionRootService<W>>,
    reattach: Arc<RepoMountReattachService<W>>,
    moves: Arc<dyn SessionFolderMoves>,
    checkout_lock: Arc<KeyedLock<PathBuf>>,
    list_feed: Arc<ProjectListFeed>,
    /// Where a test holds a binding between its root's read and its context write.
    #[cfg(test)]
    write_pause: PausePoint,
}

/// The run's workspace as the binding reads it.
#[derive(Clone, Debug)]
struct RunWorkspace {
    id: WorkspaceId,
    repo_mount_id: RepoMountId,
    execution_mode: ExecutionMode,
    state: WorkspaceState,
    fs_root: Option<PathBuf>,
    checkout_root: Option<PathBuf>,
    // The repository the mount was attached as; `None` on a mount that records none.
    mount_common_folder: Option<PathBuf>,
    place: Option<Place>,
    // A chat's own folder, whose runs write no context.
    is_managed: bool,
}

/// Why the run's workspace could not be found where the binding looked.
#[derive(Debug, thiserror::Error)]
enum RunWorkspaceAbsence {
    /// The session's workspace went while its run was set up.
    #[error("session {0} lost its workspace while its run was set up")]
    Lost(SessionId),
    /// A helper's parent run no longer holds a root in its workspace.
    #[error("parent run {0} holds no live root in workspace {1}")]
    ParentReleased(RunId, WorkspaceId),
    /// The session works in a chat's own folder, whose runs take no context.
    #[error("session {0} works in a chat's own folder, which takes no run context")]
    Managed(SessionId),
}

/// The run a binding places: the id its context row is written under, the agent run that is a
/// tree's creator where the run is one, the words a worktree's first root is named from before
/// the session has a title, and the workspace it names.
struct RunToBind<'a> {
    session_id: SessionId,
    run_id: &'a str,
    agent_run_id: Option<RunId>,
    opening_words: Option<&'a str>,
    workspace_id: Option<WorkspaceId>,
}

/// What a context row records of its root: read from the root itself, or copied from a helper's
/// parent's live context.
struct RootFacts {
    execution_mode: ExecutionMode,
    execution_root: PathBuf,
    checkout_root: PathBuf,
    common_folder: PathBuf,
    worktree_id: Option<WorktreeId>,
    branch_context_id: BranchContextId,
}

/// Why a read of the binding failed.
#[derive(Debug, thiserror::Error)]
enum RunBindingReadError {
    /// The database could not be read.
    #[error("the run's workspace rows could not be read")]
    Read(#[from] DatabaseReadError),
    /// A stored row could not be read into its typed facts.
    #[error("a run's workspace row could not be read")]
    Row(#[from] rusqlite::Error),
}

impl<W: Watcher + Send + 'static> ExecutionRootSetupGate<W> {
    /// The gate over `deps`.
    pub fn new(deps: ExecutionRootSetupGateDeps<W>) -> Self {
        Self {
            writer: deps.writer,
            reads: deps.reads,
            git: deps.git,
            workspaces: deps.workspaces,
            execution_roots: deps.execution_roots,
            reattach: deps.reattach,
            moves: deps.moves,
            checkout_lock: deps.checkout_lock,
            list_feed: deps.list_feed,
            #[cfg(test)]
            write_pause: PausePoint::default(),
        }
    }

    // Binds `run` in `before`'s workspace: the sweep, then under the hold the pending move, the
    // root, and the context's facts, answered with the hold still held; no facts for a chat's own
    // folder, which takes no context. Every failure is the cause the gate wraps.
    async fn bind_run(
        &self,
        run: &RunToBind<'_>,
        before: &RunWorkspace,
    ) -> Result<(Option<RunContextBinding>, WorkspacePreparationHold<'_>), RunSetupGateError> {
        // Before the hold: a sweep takes each swept workspace's own hold, one at a time. A run's
        // setup holds no session.
        self.moves
            .sweep_from_removed_tree(&run.session_id, None)
            .await
            .map_err(RunSetupGateError::Failed)?;
        let hold = self.execution_roots.hold_preparation(before.id).await;
        self.moves
            .apply_pending_held(&run.session_id, &hold)
            .await
            .map_err(RunSetupGateError::Failed)?;
        let mut workspace = self.require_workspace(run).await?;
        // A re-attach moved it with its root kept: admitted again before anything binds there.
        if workspace.state == WorkspaceState::Preparing && workspace.fs_root.is_some() {
            self.reattach
                .prepare_moved_workspace_held(&hold)
                .await
                .map_err(cause_of_root)?;
            workspace = self.require_workspace(run).await?;
        }
        if workspace.state == WorkspaceState::Preparing {
            // Only a worktree's first root takes a name; a bound folder makes nothing.
            let tail = match workspace.execution_mode {
                ExecutionMode::ProvisionedWorktree => Some(self.derive_tail(run).await?),
                ExecutionMode::BoundRoot => None,
            };
            self.execution_roots
                .prepare_for_run_held(&hold, run.agent_run_id, tail)
                .await
                .map_err(cause_of_root)?;
        } else {
            self.workspaces
                .assert_writable(workspace.id)
                .await
                .map_err(|error| cause_of_root(error.into()))?;
        }
        let workspace = self.require_workspace(run).await?;
        if workspace.is_managed {
            return Ok((None, hold));
        }
        let binding = self.resolve_run_context(run, &workspace).await?;
        Ok((Some(binding), hold))
    }

    // The tail the session's title, or before it has one its first message or the run's opening
    // words, gives the tree; `run-<run short id>` when no usable words remain.
    async fn derive_tail(&self, run: &RunToBind<'_>) -> Result<String, RunSetupGateError> {
        let session_id = run.session_id;
        let title = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, RunBindingReadError>(
                    connection
                        .prepare_cached(SELECT_SESSION_TITLE_SQL)?
                        .query_row(
                            named_params! { "@session_id": session_id.text().as_str() },
                            |row| {
                                Ok((
                                    row.get::<_, Option<String>>(0)?,
                                    row.get::<_, Option<String>>(1)?,
                                ))
                            },
                        )
                        .optional()?,
                )
            })
            .await
            .map_err(failed)?;
        let (name, first_message_preview) = title.unwrap_or_default();
        let title_words = name
            .or(first_message_preview)
            .or_else(|| run.opening_words.map(str::to_owned))
            .unwrap_or_default();
        derive_run_tail(&suggest_tail_for(&title_words), Some(run.run_id))
            .map_err(|refusal| RunSetupGateError::Refused(refusal.into()))
    }

    // The run's context: the root's repository checked against the mount's, then the root's ids.
    async fn resolve_run_context(
        &self,
        run: &RunToBind<'_>,
        workspace: &RunWorkspace,
    ) -> Result<RunContextBinding, RunSetupGateError> {
        let (Some(execution_root), Some(checkout_root)) =
            (&workspace.fs_root, &workspace.checkout_root)
        else {
            return Err(failed(WorkspaceServiceInvariantError {
                message: format!(
                    "workspace \"{}\" is ready with no root or checkout recorded",
                    workspace.id
                ),
                kind: WorkspaceServiceInvariantKind::WorkspaceRowUnprojectable,
                workspace_id: Some(workspace.id),
                source: None,
            }));
        };
        let common_folder =
            read_git_common_folder(&self.git, workspace.place.as_ref(), execution_root, None)
                .await
                .map_err(failed)?;
        let common_folder = resolve_real_path(&common_folder).await.map_err(failed)?;
        if let Some(anchor) = &workspace.mount_common_folder
            && !components_equal(&common_folder, anchor)
        {
            return Err(RunSetupGateError::Refused(root_mismatch().into()));
        }
        let (worktree_id, branch_context_id) =
            self.read_root_ids(workspace, execution_root).await?;
        let is_tree_gone =
            workspace.execution_mode == ExecutionMode::ProvisionedWorktree && worktree_id.is_none();
        if is_tree_gone {
            return Err(RunSetupGateError::Refused(
                WorkspaceRefusal::RootUnavailable {
                    workspace_id: Some(workspace.id),
                }
                .into(),
            ));
        }
        let Some(branch_context_id) = branch_context_id else {
            return Err(failed(WorkspaceServiceInvariantError {
                message: format!(
                    "workspace \"{}\" is ready with no branch context for its root",
                    workspace.id
                ),
                kind: WorkspaceServiceInvariantKind::BranchContextMissing,
                workspace_id: Some(workspace.id),
                source: None,
            }));
        };
        run_context_binding(
            run,
            workspace,
            RootFacts {
                execution_mode: workspace.execution_mode,
                execution_root: execution_root.clone(),
                checkout_root: checkout_root.clone(),
                common_folder,
                worktree_id,
                branch_context_id,
            },
        )
        .await
    }

    // Binds a helper at its parent's root: no sweep, no held move and no preparation, since the
    // helper starts mid-run in its parent's folder.
    async fn bind_beside_parent(
        &self,
        run: &RunToBind<'_>,
        parent_run_id: RunId,
        workspace: &RunWorkspace,
    ) -> Result<RunContextBinding, RunSetupGateError> {
        let parent = self
            .read_parent_context(run.session_id, parent_run_id, workspace.id)
            .await?;
        run_context_binding(run, workspace, parent).await
    }

    // The checkout's lock for `binding`'s write.
    async fn lock_checkout(&self, binding: &RunContextBinding) -> KeyHold<'_, PathBuf> {
        #[cfg(test)]
        self.write_pause.pass().await;
        self.checkout_lock
            .acquire(binding.checkout_key.clone())
            .await
    }

    // The upsert under the checkout's lock with its in-write guards.
    async fn write_context_row(
        &self,
        binding: &RunContextBinding,
    ) -> Result<(), RunSetupGateError> {
        let _checkout_hold = self.lock_checkout(binding).await;
        match self
            .writer
            .write(vec![context_statement(binding, &WireInstant::now())])
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if error.refused_statement_index() == Some(0) => {
                Err(root_unavailable(binding.workspace_id, error))
            }
            Err(error) => Err(failed(error)),
        }
    }

    // The live context the helper's parent run `parent_run_id` holds in `workspace_id`.
    async fn read_parent_context(
        &self,
        session_id: SessionId,
        parent_run_id: RunId,
        workspace_id: WorkspaceId,
    ) -> Result<RootFacts, RunSetupGateError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, RunBindingReadError>(
                    connection
                        .prepare_cached(SELECT_PARENT_CONTEXT_SQL)?
                        .query_row(
                            named_params! {
                                "@parent_run_id": parent_run_id.text().as_str(),
                                "@session_id": session_id.text().as_str(),
                                "@workspace_id": workspace_id.text().as_str(),
                            },
                            |row| {
                                Ok(RootFacts {
                                    execution_mode: text_column(row, 0, closed_word)?,
                                    execution_root: PathBuf::from(row.get::<_, String>(1)?),
                                    checkout_root: PathBuf::from(row.get::<_, String>(2)?),
                                    common_folder: PathBuf::from(row.get::<_, String>(3)?),
                                    worktree_id: optional_text_column(row, 4, |text| {
                                        WorktreeId::new(&text)
                                    })?,
                                    branch_context_id: text_column(row, 5, |text| {
                                        BranchContextId::new(&text)
                                    })?,
                                })
                            },
                        )
                        .optional()?,
                )
            })
            .await
            .map_err(failed)?
            .ok_or_else(|| {
                failed(RunWorkspaceAbsence::ParentReleased(
                    parent_run_id,
                    workspace_id,
                ))
            })
    }

    // The daemon's standing tree at the root and the context to bind, each `None` when absent.
    async fn read_root_ids(
        &self,
        workspace: &RunWorkspace,
        execution_root: &Path,
    ) -> Result<(Option<WorktreeId>, Option<BranchContextId>), RunSetupGateError> {
        let workspace_id = workspace.id;
        let execution_mode = workspace.execution_mode;
        let execution_root = execution_root.to_string_lossy().into_owned();
        self.reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, RunBindingReadError>(
                    connection
                        .prepare_cached(&SELECT_RUN_ROOT_IDS_SQL)?
                        .query_row(
                            named_params! {
                                "@workspace_id": workspace_id.text().as_str(),
                                "@execution_mode": <&'static str>::from(execution_mode),
                                "@execution_root": execution_root,
                            },
                            |row| {
                                Ok((
                                    optional_text_column(row, 0, |text| WorktreeId::new(&text))?,
                                    optional_text_column(row, 1, |text| {
                                        BranchContextId::new(&text)
                                    })?,
                                ))
                            },
                        )?,
                )
            })
            .await
            .map_err(failed)
    }

    async fn read_workspace(
        &self,
        session_id: SessionId,
        named: Option<WorkspaceId>,
    ) -> Result<Option<RunWorkspace>, RunSetupGateError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                read_run_workspace(connection, session_id, named)
            })
            .await
            .map_err(failed)
    }

    async fn require_workspace(
        &self,
        run: &RunToBind<'_>,
    ) -> Result<RunWorkspace, RunSetupGateError> {
        self.read_workspace(run.session_id, run.workspace_id)
            .await?
            .ok_or_else(|| failed(RunWorkspaceAbsence::Lost(run.session_id)))
    }
}

impl<W: Watcher + Send + Sync + 'static> RunSetupGate for ExecutionRootSetupGate<W> {
    /// Binds the run, refusing `workspace.executionRoot.unresolved` wrapping why it could not,
    /// which ends the run `failed`; a send that named, or a helper whose parent is bound in, a
    /// workspace the session does not hold live is refused so with the cause `workspace.notFound`,
    /// never placed in the newest. A session bound to no repository, and a helper whose parent is
    /// bound in no workspace, have nothing to bind.
    fn assert_run_ready<'a>(
        &'a self,
        context: &'a RunSetupContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        Box::pin(async move {
            if context
                .parent_run
                .is_some_and(|parent| parent.workspace_id.is_none())
            {
                return Ok(());
            }
            let run_id = context.run_id.text();
            let run = RunToBind {
                session_id: context.session_id,
                run_id: run_id.as_str(),
                agent_run_id: Some(context.run_id),
                opening_words: context.opening_words.as_ref().map(FreeFormText::as_str),
                workspace_id: named_workspace(context),
            };
            let Some(before) = self
                .read_workspace(run.session_id, run.workspace_id)
                .await?
            else {
                return match run.workspace_id {
                    Some(workspace_id) => Err(unresolved(
                        workspace_id,
                        RunSetupGateError::Refused(
                            WorkspaceRefusal::NotFound { workspace_id }.into(),
                        ),
                    )),
                    None => Ok(()),
                };
            };
            let bound = match context.parent_run {
                Some(parent) => match self.bind_beside_parent(&run, parent.run_id, &before).await {
                    Ok(binding) => self.write_context_row(&binding).await,
                    Err(cause) => Err(cause),
                },
                None => match self.bind_run(&run, &before).await {
                    // Written under the preparation hold the binding took.
                    Ok((Some(binding), _hold)) => self.write_context_row(&binding).await,
                    Ok((None, _hold)) => Ok(()),
                    Err(cause) => Err(cause),
                },
            };
            bound.map_err(|cause| unresolved(before.id, cause))?;
            // The run's held root changed without an event.
            self.list_feed.refresh_sessions(&[context.session_id]);
            Ok(())
        })
    }

    /// Stamps the run's context released, sweeps the session out of a tree removed while the run
    /// was bound there, then applies a move the session held during the run.
    fn on_run_terminal<'a>(
        &'a self,
        context: &'a RunTerminalContext,
        hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        Box::pin(async move {
            self.writer
                .write(vec![release_run_context_statement(
                    context.run_id.text().as_str(),
                    &WireInstant::now(),
                )])
                .await
                .map_err(failed)?;
            // The run may end under the engine's hold of its session, which the moves append under.
            self.moves
                .sweep_from_removed_tree(&context.session_id, hold)
                .await
                .map_err(RunSetupGateError::Failed)?;
            self.moves
                .apply_pending(&context.session_id, hold)
                .await
                .map_err(RunSetupGateError::Failed)?;
            self.list_feed.refresh_sessions(&[context.session_id]);
            Ok(())
        })
    }
}

impl<W: Watcher + Send + Sync + 'static> SessionRunBinder for ExecutionRootSetupGate<W> {
    fn bind_session_run<'a>(
        &'a self,
        session_id: SessionId,
        run_id: &'a str,
        opening_words: &'a str,
    ) -> BoxFuture<'a, Result<RunContextBinding, RunSetupGateError>> {
        Box::pin(async move {
            let run = RunToBind {
                session_id,
                run_id,
                agent_run_id: None,
                opening_words: Some(opening_words),
                workspace_id: None,
            };
            let Some(before) = self.read_workspace(session_id, None).await? else {
                return Err(failed(RunWorkspaceAbsence::Lost(session_id)));
            };
            self.bind_run(&run, &before)
                .await
                .and_then(|(binding, _hold)| {
                    binding.ok_or_else(|| failed(RunWorkspaceAbsence::Managed(session_id)))
                })
                .map_err(|cause| unresolved(before.id, cause))
        })
    }

    fn hold_checkout<'a>(
        &'a self,
        binding: &'a RunContextBinding,
    ) -> BoxFuture<'a, KeyHold<'a, PathBuf>> {
        Box::pin(self.lock_checkout(binding))
    }
}

// The binding of `run` in `workspace` at the root `facts` names, its checkout resolved for the
// checkout's lock.
async fn run_context_binding(
    run: &RunToBind<'_>,
    workspace: &RunWorkspace,
    facts: RootFacts,
) -> Result<RunContextBinding, RunSetupGateError> {
    let checkout_key = canonical_folder_path(&facts.checkout_root)
        .await
        .map_err(failed)?;
    Ok(RunContextBinding {
        run_id: run.run_id.to_owned(),
        session_id: run.session_id,
        workspace_id: workspace.id,
        repo_mount_id: workspace.repo_mount_id,
        execution_mode: facts.execution_mode,
        execution_root: facts.execution_root,
        checkout_root: facts.checkout_root,
        common_folder: facts.common_folder,
        worktree_id: facts.worktree_id,
        branch_context_id: facts.branch_context_id,
        checkout_key,
    })
}

// The workspace the run names: the one its send named, else a helper's parent's; `None` takes the
// session's newest.
fn named_workspace(context: &RunSetupContext) -> Option<WorkspaceId> {
    context
        .workspace_id
        .or(context.parent_run.and_then(|parent| parent.workspace_id))
}

fn read_run_workspace(
    connection: &Connection,
    session_id: SessionId,
    named: Option<WorkspaceId>,
) -> Result<Option<RunWorkspace>, RunBindingReadError> {
    let named = named.map(|workspace_id| workspace_id.text());
    Ok(connection
        .prepare_cached(&SELECT_RUN_WORKSPACE_SQL)?
        .query_row(
            named_params! {
                "@session_id": session_id.text().as_str(),
                "@workspace_id": named.as_ref().map(UuidText::as_str),
            },
            |row| {
                Ok(RunWorkspace {
                    id: text_column(row, 0, |text| WorkspaceId::new(&text))?,
                    repo_mount_id: text_column(row, 1, |text| RepoMountId::new(&text))?,
                    execution_mode: text_column(row, 2, closed_word)?,
                    state: text_column(row, 3, closed_word)?,
                    fs_root: row.get::<_, Option<String>>(4)?.map(PathBuf::from),
                    checkout_root: row.get::<_, Option<String>>(5)?.map(PathBuf::from),
                    mount_common_folder: row.get::<_, Option<String>>(6)?.map(PathBuf::from),
                    // The column holds the place's wire JSON.
                    place: optional_text_column(row, 7, |text| {
                        serde_json::from_str::<Place>(&text)
                    })?,
                    is_managed: row.get(8)?,
                })
            },
        )
        .optional()?)
}

// A preparation's failure as the gate's cause: a refusal keeps its code wherever it is wrapped.
fn cause_of_root(error: ExecutionRootError) -> RunSetupGateError {
    match HandlerError::from(error) {
        HandlerError::Refused(refusal) => RunSetupGateError::Refused(refusal),
        HandlerError::Internal(fault) => RunSetupGateError::Failed(fault),
        canceled @ HandlerError::Canceled => failed(canceled),
    }
}

// A refused context write: the workspace left `ready`, its mount was detached or its checkout's
// removal committed since the binding read them.
fn root_unavailable(
    workspace_id: WorkspaceId,
    source: impl Error + Send + Sync + 'static,
) -> RunSetupGateError {
    RunSetupGateError::Refused(
        DomainError::from(WorkspaceRefusal::RootUnavailable {
            workspace_id: Some(workspace_id),
        })
        .with_source(source),
    )
}

fn failed(error: impl Error + Send + Sync + 'static) -> RunSetupGateError {
    RunSetupGateError::Failed(Box::new(error))
}

// The refusal that ends the run `failed`: the workspace, and why it could not be bound.
fn unresolved(workspace_id: WorkspaceId, cause: RunSetupGateError) -> RunSetupGateError {
    RunSetupGateError::Refused(
        WorktreeRefusal::ExecutionRootUnresolved {
            workspace_id,
            cause: Box::new(cause),
        }
        .into(),
    )
}
