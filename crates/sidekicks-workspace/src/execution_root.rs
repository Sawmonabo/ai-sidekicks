//! The execution roots: where a workspace's runs work. A prepare makes the root for the workspace:
//! a new worktree when it names a branch or a run's tail, otherwise the folder its bind admitted. A
//! move roots the workspace in another tree its repository already has. Both run inside the
//! preparation bracket, and this is the one writer of `branch_contexts`.
//!
//! - Every preparation of one workspace runs under its preparation hold, which only
//!   [`ExecutionRootService::hold_preparation`] hands out. The work takes the hold, never the lock,
//!   so a holder's nested call cannot wait on itself. The preparation lock comes before the
//!   checkout lock a carry takes, never after.
//! - Every refusal a caller can avoid fires before the bracket opens. A failure inside it parks the
//!   workspace `rootLost` with why, and undoes a tree this call made.
//! - A `boundRoot` root is read, never changed: no command that moves a checkout runs in it. Its
//!   branch contexts accumulate, one per preparation, since refreshing one in place would lose the
//!   branches of the binding before.

mod bind;
mod bracket;
#[cfg(any(test, feature = "test-support"))]
pub mod test_fixture;
#[cfg(test)]
mod tests;

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};

use notify::{RecommendedWatcher, Watcher};
use rusqlite::named_params;
use serde_json::json;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::repo::folders::RepoMountOutsideTrustEnvelopeReason;
use sidekicks_contracts::repo::mount::{ExecutionMode, RepoMountId, WorkspaceId, WorkspaceState};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_contracts::worktree::lifecycle::{
    BranchContextId, WorkspaceExecutionRootPrepareRequest, WorkspaceExecutionRootPrepareResponse,
    WorktreeId, WorktreeState,
};
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::text_column;
use sidekicks_store::database::writer::{DatabaseWriter, WriteError};
use sidekicks_store::events::session::append_lock::SessionAppendHold;

pub(crate) use self::bind::last_error_detail;
use self::bind::{ExistingWorktree, NewWorktree, RootMaterialization};
use self::bracket::BracketGate;
use crate::errors::{WorkspaceRefusal, WorkspaceServiceInvariantError};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::GitRunner;
use crate::git::worktree::creation::{
    NameCollision, WorktreeCreationError, WorktreeCreator, WorktreeNameRequest,
};
use crate::git::worktree::errors::WorktreeRefusal;
use crate::git::worktree::service::{WorktreeService, WorktreeServiceError};
use crate::git::worktree::setup::WorktreeSetupRunner;
use crate::repo::errors::RepoRefusal;
use crate::repo::root_resolver::RepoRootResolver;
use crate::service::{WorkspaceRow, WorkspaceService, WorkspaceServiceError, wire_path};
use crate::trust_envelope::components_equal;

/// The statements the execution roots' reads keep prepared on each read connection: the mount's
/// live trees and its retired trees whose folders still stand.
pub const EXECUTION_ROOT_SERVICE_STATEMENT_CAPACITY: usize = 2;

// The daemon's trees on the mount that stand ready to work in, each with the branches its newest
// context recorded, which a workspace moving in carries over; the tree's own stand in before any.
// A tree still being made is no move target, so the live predicate's `creating` is left out.
static SELECT_STANDING_WORKTREES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT tree.id, tree.fs_root,
        COALESCE(newest.base_branch, tree.base_ref),
        COALESCE(newest.head_branch, tree.branch_name)
   FROM worktrees AS tree
   LEFT JOIN branch_contexts AS newest
     ON newest.id = (SELECT context.id FROM branch_contexts AS context
                      WHERE context.worktree_id = tree.id
                      ORDER BY context.updated_at DESC, context.id DESC
                      LIMIT 1)
  WHERE tree.repo_mount_id = @repo_mount_id AND tree.state IN ('{}', '{}', '{}')",
        <&'static str>::from(WorktreeState::Ready),
        <&'static str>::from(WorktreeState::Dirty),
        <&'static str>::from(WorktreeState::Merged),
    )
});

// The daemon's retired trees on the mount whose folders the sweep has not yet dealt with.
static SELECT_UNSWEPT_RETIRED_ROOTS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT fs_root FROM worktrees
  WHERE repo_mount_id = @repo_mount_id AND state = '{}' AND cleaned_at IS NULL",
        <&'static str>::from(WorktreeState::Retired)
    )
});

/// Why preparing or moving an execution root failed: a refusal the wire carries, or a failure
/// inside the daemon. A failure after the bracket opened keeps the workspace it parked `rootLost`.
#[derive(Debug, thiserror::Error)]
pub enum ExecutionRootError {
    /// The call was refused with its code.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The workspace service failed inside the daemon.
    #[error(transparent)]
    Workspace(WorkspaceServiceError),
    /// The worktree could not be made, for a cause no refusal names.
    #[error(transparent)]
    Creation(WorktreeCreationError),
    /// A stored row or git's answer broke what a preparation holds.
    #[error(transparent)]
    Invariant(#[from] WorkspaceServiceInvariantError),
    /// The worktree rows did not reach the database.
    #[error("the worktree rows did not reach the database")]
    Read(#[from] DatabaseReadError),
    /// The worktree rows could not be read.
    #[error("the worktree rows could not be read")]
    Row(#[from] rusqlite::Error),
    /// The branch context was not written.
    #[error("the branch context was not written")]
    Write(#[from] WriteError),
    /// A folder could not be resolved to compare it with a worktree's.
    #[error("a folder could not be resolved to compare it with a worktree's")]
    Folder(#[source] io::Error),
    /// The prepared root is no path the wire takes.
    #[error("the prepared execution root cannot be sent")]
    RootText(#[source] TextError),
    /// The failure, beside the failures of cleaning up after it.
    #[error(transparent)]
    Undone(Box<CleanupFailures<ExecutionRootError, Box<dyn Error + Send + Sync>>>),
    /// The preparation failed after its bracket opened, which parked the workspace `rootLost`.
    #[error("{failure}")]
    Preparation {
        /// The workspace being prepared.
        workspace_id: WorkspaceId,
        /// Why.
        #[source]
        failure: Box<ExecutionRootError>,
    },
}

impl ExecutionRootError {
    /// The refusal this failure answers with, inside any cleanup or bracket it is wrapped in.
    fn refusal(&self) -> Option<&DomainError> {
        match self {
            Self::Refused(refusal) => Some(refusal),
            Self::Undone(undone) => undone.original().refusal(),
            Self::Preparation { failure, .. } => failure.refusal(),
            Self::Workspace(_)
            | Self::Creation(_)
            | Self::Invariant(_)
            | Self::Read(_)
            | Self::Row(_)
            | Self::Write(_)
            | Self::Folder(_)
            | Self::RootText(_) => None,
        }
    }
}

impl From<WorkspaceServiceError> for ExecutionRootError {
    fn from(error: WorkspaceServiceError) -> Self {
        match error {
            WorkspaceServiceError::Refused(refusal) => Self::Refused(refusal),
            fault @ (WorkspaceServiceError::Invariant(_)
            | WorkspaceServiceError::Read(_)
            | WorkspaceServiceError::Row(_)
            | WorkspaceServiceError::HealthProjection(_)
            | WorkspaceServiceError::Append(_)) => Self::Workspace(fault),
        }
    }
}

impl From<WorktreeCreationError> for ExecutionRootError {
    /// A refusal keeps its code, the failures of undoing the tree beside it.
    fn from(error: WorktreeCreationError) -> Self {
        match error {
            WorktreeCreationError::Refused(refusal) => Self::Refused(refusal.into()),
            WorktreeCreationError::Mount(WorktreeServiceError::MountRefused(refusal)) => {
                Self::Refused(refusal.into())
            }
            WorktreeCreationError::Undone(undone) => {
                let (original, failures, operation) = undone.into_parts();
                Self::Undone(Box::new(CleanupFailures::new(
                    original.into(),
                    failures,
                    operation,
                )))
            }
            fault @ (WorktreeCreationError::Mount(_)
            | WorktreeCreationError::Naming(_)
            | WorktreeCreationError::LiveRunFolders(_)
            | WorktreeCreationError::Pool(_)
            | WorktreeCreationError::Database(_)
            | WorktreeCreationError::Folder(_)
            | WorktreeCreationError::TreeFolder(_)
            | WorktreeCreationError::FolderText(_)
            | WorktreeCreationError::Record(_)
            | WorktreeCreationError::RowMoved(_)
            | WorktreeCreationError::Ready(_)
            | WorktreeCreationError::Setup(_)
            | WorktreeCreationError::SuggestionText(_)) => Self::Creation(fault),
        }
    }
}

impl From<WorkspaceRefusal> for ExecutionRootError {
    fn from(refusal: WorkspaceRefusal) -> Self {
        Self::Refused(refusal.into())
    }
}

impl From<WorktreeRefusal> for ExecutionRootError {
    fn from(refusal: WorktreeRefusal) -> Self {
        Self::Refused(refusal.into())
    }
}

impl From<RepoRefusal> for ExecutionRootError {
    fn from(refusal: RepoRefusal) -> Self {
        Self::Refused(refusal.into())
    }
}

impl From<ExecutionRootError> for HandlerError {
    /// A refusal is answered with its code, wherever it is wrapped; a preparation that failed for
    /// any other cause is `workspace.preparationFailed`; every other failure is a fault.
    fn from(error: ExecutionRootError) -> Self {
        if let ExecutionRootError::Refused(refusal) = error {
            return Self::Refused(refusal);
        }
        if let Some(refusal) = error.refusal() {
            let answer = DomainError {
                message: refusal.message.clone(),
                code: refusal.code,
                detail: refusal.detail.clone(),
                source: None,
            };
            return Self::Refused(answer.with_source(error));
        }
        if let ExecutionRootError::Preparation { workspace_id, .. } = &error {
            let answer = DomainError::new(
                format!("preparing workspace {workspace_id} failed inside the daemon"),
                RefusalCode::WorkspacePreparationFailed,
            )
            .with_detail(json!({ "workspaceId": workspace_id }));
            return Self::Refused(answer.with_source(error));
        }
        Self::Internal(Box::new(error))
    }
}

/// A root a preparation made or a move bound, as the bracket completed it `ready`.
#[derive(Clone, Debug)]
pub struct PreparedExecutionRoot {
    /// The workspace.
    pub workspace_id: WorkspaceId,
    /// The mode the root was made in.
    pub execution_mode: ExecutionMode,
    /// The folder the run works in.
    pub execution_root: PathBuf,
    /// The top level of the working tree the root sits in.
    pub checkout_root: PathBuf,
    /// The worktree, for a `provisionedWorktree` root only.
    pub worktree_id: Option<WorktreeId>,
    /// The branch context the preparation wrote or refreshed.
    pub branch_context_id: BranchContextId,
}

/// One workspace's preparation hold: every preparation of the workspace runs under it, and the
/// work reads the workspace from it. Only [`ExecutionRootService::hold_preparation`] makes one;
/// dropping it lets the next preparation of the workspace in.
pub struct WorkspacePreparationHold<'lock> {
    hold: KeyHold<'lock, WorkspaceId>,
}

impl WorkspacePreparationHold<'_> {
    /// The workspace held.
    pub fn workspace_id(&self) -> WorkspaceId {
        *self.hold.key()
    }
}

/// What the execution roots run with; `W` is the worktree setup card's file watch.
pub struct ExecutionRootServiceDeps<W = RecommendedWatcher> {
    /// The writer the branch contexts go through.
    pub writer: Arc<DatabaseWriter>,
    /// The read pool, sized with [`EXECUTION_ROOT_SERVICE_STATEMENT_CAPACITY`].
    pub reads: Arc<DatabaseReadPool>,
    /// The daemon's git, which reads a bound folder's branch and working tree.
    pub git: GitRunner,
    /// The workspace lifecycle, the one writer of `workspaces`.
    pub workspaces: Arc<WorkspaceService>,
    /// The retirement of a tree this service made and could not hand over.
    pub worktrees: Arc<WorktreeService>,
    /// Makes the worktrees.
    pub creator: Arc<WorktreeCreator<W>>,
    /// Forgets the setup card of a tree once its retirement is written.
    pub setup: Arc<WorktreeSetupRunner<W>>,
}

/// Prepares a workspace's execution root, and moves a workspace into a tree its repository
/// already has.
pub struct ExecutionRootService<W = RecommendedWatcher> {
    writer: Arc<DatabaseWriter>,
    reads: Arc<DatabaseReadPool>,
    git: GitRunner,
    resolver: RepoRootResolver,
    workspaces: Arc<WorkspaceService>,
    worktrees: Arc<WorktreeService>,
    creator: Arc<WorktreeCreator<W>>,
    setup: Arc<WorktreeSetupRunner<W>>,
    preparation_lock: KeyedLock<WorkspaceId>,
}

/// How a prepare names the tree it makes, and what a taken name does.
struct WorktreeNameChoice {
    request: WorktreeNameRequest,
    on_collision: NameCollision,
}

/// What a prepare asks for beside its workspace.
struct RootRequest {
    name: Option<WorktreeNameChoice>,
    base_ref: Option<GitRefName>,
    run_id: Option<RunId>,
    carry_uncommitted: bool,
}

impl<W: Watcher + Send + 'static> ExecutionRootService<W> {
    /// The service over `deps`.
    pub fn new(deps: ExecutionRootServiceDeps<W>) -> Self {
        Self {
            writer: deps.writer,
            reads: deps.reads,
            resolver: RepoRootResolver::new(deps.git.clone()),
            git: deps.git,
            workspaces: deps.workspaces,
            worktrees: deps.worktrees,
            creator: deps.creator,
            setup: deps.setup,
            preparation_lock: KeyedLock::new(),
        }
    }

    /// Waits for and takes `workspace_id`'s preparation hold, the one way into a preparation.
    pub async fn hold_preparation(
        &self,
        workspace_id: WorkspaceId,
    ) -> WorkspacePreparationHold<'_> {
        WorkspacePreparationHold {
            hold: self.preparation_lock.acquire(workspace_id).await,
        }
    }

    /// The wire's prepare of the held workspace; the request's workspace id is the one the caller
    /// took the hold for. A named branch makes a worktree, refusing a taken name; no branch
    /// prepares the stored mode, refusing `workspace.branchNameRequired` before any git call for a
    /// `provisionedWorktree` workspace. Also refuses `workspace.notFound`, `repoMount.notFound`,
    /// `workspace.modeUnsupported`, `workspace.rootUnavailable`, `repoMount.rootResolutionFailed`
    /// and the worktree creation's refusals; a failure inside the bracket parks the workspace
    /// `rootLost`.
    pub async fn prepare_held(
        &self,
        hold: &WorkspacePreparationHold<'_>,
        request: &WorkspaceExecutionRootPrepareRequest,
    ) -> Result<WorkspaceExecutionRootPrepareResponse, ExecutionRootError> {
        let name = request
            .branch_name
            .as_ref()
            .map(|branch| branch.as_str().trim())
            .filter(|branch| !branch.is_empty())
            .map(|branch| WorktreeNameChoice {
                request: WorktreeNameRequest::BranchName(branch.to_owned()),
                on_collision: NameCollision::Refuse,
            });
        let prepared = self
            .prepare(
                hold,
                RootRequest {
                    name,
                    base_ref: request.base_ref.clone(),
                    run_id: None,
                    carry_uncommitted: request.carry_uncommitted == Some(true),
                },
            )
            .await?;
        Ok(WorkspaceExecutionRootPrepareResponse {
            execution_root: wire_path(&prepared.execution_root)
                .map_err(ExecutionRootError::RootText)?,
            state: WorkspaceState::Ready,
            worktree_id: prepared.worktree_id,
            branch_context_id: prepared.branch_context_id,
        })
    }

    /// The run setup gate's prepare of the held workspace for `run_id`: a non-blank `tail` makes a
    /// worktree named from it, taking the first free ordinal; none prepares the stored mode. Fails
    /// as [`ExecutionRootService::prepare_held`] does.
    pub(crate) async fn prepare_for_run_held(
        &self,
        hold: &WorkspacePreparationHold<'_>,
        run_id: RunId,
        tail: Option<String>,
    ) -> Result<PreparedExecutionRoot, ExecutionRootError> {
        let name = tail
            .as_deref()
            .map(str::trim)
            .filter(|tail| !tail.is_empty())
            .map(|tail| WorktreeNameChoice {
                request: WorktreeNameRequest::Tail(tail.to_owned()),
                on_collision: NameCollision::Suffix,
            });
        self.prepare(
            hold,
            RootRequest {
                name,
                base_ref: None,
                run_id: Some(run_id),
                carry_uncommitted: false,
            },
        )
        .await
    }

    /// Moves the held workspace into `folder`, any tree git lists for its repository: a tree the
    /// daemon made becomes its `provisionedWorktree` root and keeps that tree's branches; any
    /// other, the repository's own checkout and a tree the person made included, binds as a
    /// `boundRoot` checkout. Ungated, since a move is how a `rootLost` workspace leaves a folder that went
    /// away. The bracket's events are appended under `append_hold` where the caller holds the
    /// workspace's session, as a run's end does. Refuses as
    /// [`ExecutionRootService::require_listed_tree`] does, and `repoMount.notFound`; a failure
    /// inside the bracket parks the workspace `rootLost`.
    pub async fn move_to_folder_held(
        &self,
        hold: &WorkspacePreparationHold<'_>,
        folder: &Path,
        append_hold: Option<&SessionAppendHold>,
    ) -> Result<PreparedExecutionRoot, ExecutionRootError> {
        let workspace = self
            .workspaces
            .require_workspace_row(hold.workspace_id())
            .await?;
        let mount = self
            .workspaces
            .require_attached_mount(workspace.repo_mount_id)
            .await?;
        let tree_root = self.require_listed_tree_of(&workspace, folder).await?;
        let materialization = match self
            .find_standing_worktree_at(workspace.repo_mount_id, &tree_root)
            .await?
        {
            Some(tree) => RootMaterialization::ExistingWorktree(tree),
            None => RootMaterialization::MovedBoundRoot(tree_root),
        };
        self.run_bracket(
            &workspace,
            &mount,
            BracketGate::Ungated,
            materialization,
            append_hold,
        )
        .await
    }

    /// Admits `folder` as a move target of `workspace_id`, so a move held for a run's end names a
    /// folder the move will take: the top level of a tree of the workspace's repository, admitted
    /// as a bind admits its pick. Refuses `workspace.notFound`, `repoMount.notFound`,
    /// `workspace.rootUnavailable` when the mount's folder is out of reach,
    /// `repoMount.rootResolutionFailed` when it holds another repository, and
    /// `repoMount.outsideTrustEnvelope` for any other folder, with reason `worktreeRemoved` for a
    /// retired tree whose folder the sweep has not yet removed.
    pub async fn require_listed_tree(
        &self,
        workspace_id: WorkspaceId,
        folder: &Path,
    ) -> Result<(), ExecutionRootError> {
        let workspace = self.workspaces.require_workspace_row(workspace_id).await?;
        self.require_listed_tree_of(&workspace, folder)
            .await
            .map(drop)
    }

    // The held workspace's root as `root` asks: a named tree in `provisionedWorktree`, else the
    // stored mode, behind the write gate.
    async fn prepare(
        &self,
        hold: &WorkspacePreparationHold<'_>,
        root: RootRequest,
    ) -> Result<PreparedExecutionRoot, ExecutionRootError> {
        let workspace = self
            .workspaces
            .require_workspace_row(hold.workspace_id())
            .await?;
        let materialization = match (root.name, workspace.execution_mode) {
            (Some(name), _) => RootMaterialization::NewWorktree(NewWorktree {
                name: name.request,
                on_collision: name.on_collision,
                base_ref: root.base_ref,
                run_id: root.run_id,
                carry_uncommitted: root.carry_uncommitted,
            }),
            (None, ExecutionMode::BoundRoot) => RootMaterialization::StoredBoundRoot,
            (None, ExecutionMode::ProvisionedWorktree) => {
                return Err(WorktreeRefusal::BranchNameRequired {
                    workspace_id: workspace.id,
                }
                .into());
            }
        };
        let mount = self
            .workspaces
            .require_attached_mount(workspace.repo_mount_id)
            .await?;
        self.run_bracket(
            &workspace,
            &mount,
            BracketGate::Gated,
            materialization,
            None,
        )
        .await
    }

    // The tree's top level, each link resolved, which the workspace then roots at.
    async fn require_listed_tree_of(
        &self,
        workspace: &WorkspaceRow,
        folder: &Path,
    ) -> Result<PathBuf, ExecutionRootError> {
        let admitted = self.workspaces.admit_folder(workspace.id, folder).await?;
        // A move names a whole tree; a folder inside one is a bind's pick, not a move.
        if !components_equal(&admitted.execution_root, &admitted.checkout_root) {
            return Err(outside_trust_envelope(
                RepoMountOutsideTrustEnvelopeReason::OutsideProject,
            ));
        }
        // A retired tree git still lists is the sweep's to delete, so work done there would be
        // lost.
        let target = canonical_folder_path(&admitted.execution_root)
            .await
            .map_err(ExecutionRootError::Folder)?;
        for retired in self
            .read_unswept_retired_roots(workspace.repo_mount_id)
            .await?
        {
            if canonical_folder_path(&retired)
                .await
                .map_err(ExecutionRootError::Folder)?
                == target
            {
                return Err(outside_trust_envelope(
                    RepoMountOutsideTrustEnvelopeReason::WorktreeRemoved,
                ));
            }
        }
        Ok(admitted.execution_root)
    }

    // The daemon's standing tree at `folder`, `None` when it made none there.
    async fn find_standing_worktree_at(
        &self,
        repo_mount_id: RepoMountId,
        folder: &Path,
    ) -> Result<Option<ExistingWorktree>, ExecutionRootError> {
        let target = canonical_folder_path(folder)
            .await
            .map_err(ExecutionRootError::Folder)?;
        let trees = self
            .reads
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(&SELECT_STANDING_WORKTREES_SQL)?
                    .query_map(
                        named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
                        |row| {
                            Ok(ExistingWorktree {
                                worktree_id: text_column(row, 0, |text| WorktreeId::new(&text))?,
                                fs_root: PathBuf::from(row.get::<_, String>(1)?),
                                base_branch: row.get(2)?,
                                head_branch: row.get(3)?,
                            })
                        },
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(ExecutionRootError::from)
            })
            .await?;
        for tree in trees {
            if canonical_folder_path(&tree.fs_root)
                .await
                .map_err(ExecutionRootError::Folder)?
                == target
            {
                return Ok(Some(tree));
            }
        }
        Ok(None)
    }

    async fn read_unswept_retired_roots(
        &self,
        repo_mount_id: RepoMountId,
    ) -> Result<Vec<PathBuf>, ExecutionRootError> {
        self.reads
            .read(ReadLength::Short, move |connection| {
                connection
                    .prepare_cached(&SELECT_UNSWEPT_RETIRED_ROOTS_SQL)?
                    .query_map(
                        named_params! { "@repo_mount_id": repo_mount_id.text().as_str() },
                        |row| row.get::<_, String>(0).map(PathBuf::from),
                    )?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(ExecutionRootError::from)
            })
            .await
    }
}

fn outside_trust_envelope(reason: RepoMountOutsideTrustEnvelopeReason) -> ExecutionRootError {
    RepoRefusal::OutsideTrustEnvelope { reason }.into()
}
