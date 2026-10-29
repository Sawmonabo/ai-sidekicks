//! What a preparation materializes inside its bracket: the folder a `boundRoot` workspace binds,
//! read and never changed, a new worktree, or a tree the daemon made that a move roots in; the
//! branch context each one writes; and the `lastError` a failed preparation records.

use std::borrow::Cow;
use std::path::PathBuf;

use notify::Watcher;
use rusqlite::types::Value;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::repo::mount::{ExecutionMode, WorkspaceId};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::worktree::lifecycle::{BranchContextId, WorktreeId};
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use sidekicks_store::database::stored_column::parse_stored_json_object;

use super::{ExecutionRootError, ExecutionRootService};
use crate::errors::{WorkspaceServiceInvariantError, WorkspaceServiceInvariantKind};
use crate::git::worktree::carry::CarriedStash;
use crate::git::worktree::creation::{CreateWorktreeInput, NameCollision, WorktreeNameRequest};
use crate::git::worktree::reads::read_current_branch;
use crate::row_guards::{BOUND_ROOT_METADATA_PATH, CHECKOUT_ROOT_METADATA_PATH};
use crate::service::{AttachedMount, WorkspaceRow};

// What `branch_contexts.head_branch` records while the bound checkout's HEAD is detached: git's
// own name for it, which no branch can take.
const DETACHED_HEAD_NAME: &str = "HEAD";

// One row per (worktree, workspace): a workspace binding a tree again refreshes its own row, and a
// first binding inserts one beside the tree's rows for other workspaces. The conflict target
// repeats the partial index's `WHERE`, as SQLite requires; `@id` is dropped on the update arm, so
// the row's own id is returned.
const UPSERT_WORKTREE_CONTEXT_SQL: &str = "INSERT INTO branch_contexts (
    id, workspace_id, worktree_id, base_branch, head_branch, created_at, updated_at
  )
  VALUES (@id, @workspace_id, @worktree_id, @base_branch, @head_branch, @now, @now)
  ON CONFLICT (worktree_id, workspace_id) WHERE worktree_id IS NOT NULL
  DO UPDATE SET base_branch = excluded.base_branch,
                head_branch = excluded.head_branch,
                updated_at = excluded.updated_at
  RETURNING id";

// A `boundRoot` preparation's row: rows accumulate, so it never meets another.
const INSERT_BOUND_CONTEXT_SQL: &str = "INSERT INTO branch_contexts (
    id, workspace_id, worktree_id, base_branch, head_branch, created_at, updated_at
  )
  VALUES (@id, @workspace_id, NULL, @base_branch, @head_branch, @now, @now)";

/// Keyed on the row id alone, so it reaches only the row the failing preparation wrote.
pub(super) const DELETE_BRANCH_CONTEXT_SQL: &str = "DELETE FROM branch_contexts WHERE id = @id";

// The member names under the metadata paths' `$.`, so each key and its path are one fact.
const BOUND_ROOT_METADATA_KEY: &str = BOUND_ROOT_METADATA_PATH.split_at(2).1;
const CHECKOUT_ROOT_METADATA_KEY: &str = CHECKOUT_ROOT_METADATA_PATH.split_at(2).1;

/// What a preparation materializes.
pub(super) enum RootMaterialization {
    /// The folder the bind admitted, as the workspace's metadata records it.
    StoredBoundRoot,
    /// A folder a move binds from now on as a `boundRoot` checkout.
    MovedBoundRoot(PathBuf),
    /// A new worktree cut for the workspace.
    NewWorktree(NewWorktree),
    /// A standing tree the daemon made, which a move roots in.
    ExistingWorktree(ExistingWorktree),
}

impl RootMaterialization {
    /// The mode the root is made in.
    pub(super) fn execution_mode(&self) -> ExecutionMode {
        match self {
            Self::StoredBoundRoot | Self::MovedBoundRoot(_) => ExecutionMode::BoundRoot,
            Self::NewWorktree(_) | Self::ExistingWorktree(_) => ExecutionMode::ProvisionedWorktree,
        }
    }
}

/// A new worktree's name and base, and the run and carry that make it.
pub(super) struct NewWorktree {
    /// Its name.
    pub(super) name: WorktreeNameRequest,
    /// What a taken name does.
    pub(super) on_collision: NameCollision,
    /// The base its branch is cut from; `None` takes the mount's HEAD branch.
    pub(super) base_ref: Option<GitRefName>,
    /// The run making it, `None` for a prepare before any run.
    pub(super) run_id: Option<RunId>,
    /// Whether it takes the uncommitted work of the folder the workspace works in now.
    pub(super) carry_uncommitted: bool,
}

/// A standing tree the daemon made, with the branches its newest context recorded.
pub(super) struct ExistingWorktree {
    /// The tree.
    pub(super) worktree_id: WorktreeId,
    /// Its folder.
    pub(super) fs_root: PathBuf,
    /// The base its newest context recorded, else the tree's own.
    pub(super) base_branch: String,
    /// The branch its newest context recorded, else the tree's own.
    pub(super) head_branch: String,
}

/// How a root came to be. Only a created one is undone: a bound root is the person's own checkout,
/// and a tree moved into already had its owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RootProvenance {
    /// This preparation made it.
    Created,
    /// It stood before this preparation.
    Bound,
}

/// What a materialization made, before its branch context and the bracket's close.
pub(super) struct MaterializedRoot {
    /// The mode it was made in.
    pub(super) execution_mode: ExecutionMode,
    /// The folder runs work in.
    pub(super) execution_root: PathBuf,
    /// The top level of the working tree it sits in.
    pub(super) checkout_root: PathBuf,
    /// The branch the context records as its head.
    pub(super) head_branch: String,
    /// The branch the context records as its base.
    pub(super) base_branch: String,
    /// The tree, for a worktree root.
    pub(super) worktree_id: Option<WorktreeId>,
    /// Whether this preparation made it.
    pub(super) provenance: RootProvenance,
    /// The folder a moved `boundRoot` workspace binds from now on.
    pub(super) bound_root: Option<PathBuf>,
    /// The stash holding work carried onto a new tree, dropped once the tree is adopted.
    pub(super) carried_stash: Option<CarriedStash>,
}

impl<W: Watcher + Send + 'static> ExecutionRootService<W> {
    /// Makes or reads `materialization`'s root for `workspace` on `mount`. Fails with an
    /// unreadable-row invariant for a folder the workspace's metadata does not record, a
    /// bound-root invariant when git cannot name a bound folder's branch or working tree, and as
    /// the worktree creation fails.
    pub(super) async fn materialize(
        &self,
        workspace: &WorkspaceRow,
        mount: &AttachedMount,
        materialization: RootMaterialization,
    ) -> Result<MaterializedRoot, ExecutionRootError> {
        match materialization {
            RootMaterialization::StoredBoundRoot => {
                let folder = stored_root(workspace, BOUND_ROOT_METADATA_KEY, "bound folder")?;
                self.read_bound_root(workspace, folder, None).await
            }
            RootMaterialization::MovedBoundRoot(folder) => {
                self.read_bound_root(workspace, folder.clone(), Some(folder))
                    .await
            }
            RootMaterialization::NewWorktree(new) => {
                self.create_worktree_root(workspace, mount, new).await
            }
            RootMaterialization::ExistingWorktree(tree) => Ok(MaterializedRoot {
                execution_mode: ExecutionMode::ProvisionedWorktree,
                execution_root: tree.fs_root.clone(),
                checkout_root: tree.fs_root,
                head_branch: tree.head_branch,
                base_branch: tree.base_branch,
                worktree_id: Some(tree.worktree_id),
                provenance: RootProvenance::Bound,
                bound_root: None,
                carried_stash: None,
            }),
        }
    }

    // `boundRoot`: `folder` on the branch it is on, inside the working tree git names for it, its
    // base anchored to that branch since nothing is cut.
    async fn read_bound_root(
        &self,
        workspace: &WorkspaceRow,
        folder: PathBuf,
        bound_root: Option<PathBuf>,
    ) -> Result<MaterializedRoot, ExecutionRootError> {
        let unreadable = |source: Box<dyn std::error::Error + Send + Sync>| {
            invariant(
                workspace.id,
                WorkspaceServiceInvariantKind::BoundRootUnreadable,
                "gave git no branch or working tree",
                Some(source),
            )
        };
        let branch = read_current_branch(&self.git, workspace.place.as_ref(), &folder)
            .await
            .map_err(|failure| unreadable(Box::new(failure)))?;
        let checkout_root = self
            .resolver
            .read_working_tree_root(&folder)
            .await
            .map_err(|failure| unreadable(Box::new(failure)))?
            .ok_or_else(|| unreadable("git names no working tree around the folder".into()))?;
        let head_branch = branch.unwrap_or_else(|| DETACHED_HEAD_NAME.to_owned());
        Ok(MaterializedRoot {
            execution_mode: ExecutionMode::BoundRoot,
            execution_root: folder,
            checkout_root,
            base_branch: head_branch.clone(),
            head_branch,
            worktree_id: None,
            provenance: RootProvenance::Bound,
            bound_root,
            carried_stash: None,
        })
    }

    // `provisionedWorktree`: a new tree cut for this workspace, carrying the uncommitted work of
    // the checkout the workspace works in now when asked.
    async fn create_worktree_root(
        &self,
        workspace: &WorkspaceRow,
        mount: &AttachedMount,
        new: NewWorktree,
    ) -> Result<MaterializedRoot, ExecutionRootError> {
        let carry_uncommitted_from = if new.carry_uncommitted {
            Some(stored_root(
                workspace,
                CHECKOUT_ROOT_METADATA_KEY,
                "folder to carry uncommitted work from",
            )?)
        } else {
            None
        };
        let created = self
            .creator
            .create(CreateWorktreeInput {
                repo_mount_id: mount.id,
                session_id: workspace.session_id,
                run_id: new.run_id,
                name: new.name,
                on_collision: new.on_collision,
                base_ref: new.base_ref,
                carry_uncommitted_from,
                actor: None,
                correlation_id: None,
            })
            .await?;
        Ok(MaterializedRoot {
            execution_mode: ExecutionMode::ProvisionedWorktree,
            execution_root: created.fs_root.clone(),
            checkout_root: created.fs_root,
            // The name made, not the one asked: a derived name may have taken an ordinal.
            head_branch: created.branch_name.as_str().to_owned(),
            base_branch: created.base_ref.as_str().to_owned(),
            worktree_id: Some(created.worktree_id),
            provenance: RootProvenance::Created,
            bound_root: None,
            carried_stash: created.carried_stash,
        })
    }

    /// Writes the workspace's branch context for `materialized`: refreshed in place for a tree the
    /// workspace bound before, a new row otherwise. Fails as the write fails.
    pub(super) async fn write_branch_context(
        &self,
        workspace_id: WorkspaceId,
        materialized: &MaterializedRoot,
    ) -> Result<BranchContextId, ExecutionRootError> {
        let branch_context_id = BranchContextId::try_from(mint_uuid_v7())
            .expect("a minted UUID is a branch context id");
        let mut bindings = vec![
            text_binding("@id", branch_context_id.text().as_str()),
            text_binding("@workspace_id", workspace_id.text().as_str()),
            text_binding("@base_branch", &materialized.base_branch),
            text_binding("@head_branch", &materialized.head_branch),
            text_binding("@now", WireInstant::now().as_str()),
        ];
        let Some(worktree_id) = materialized.worktree_id else {
            self.writer
                .write(vec![WriteStatement {
                    sql: Cow::Borrowed(INSERT_BOUND_CONTEXT_SQL),
                    bindings: StatementBindings::Named(bindings),
                    expected_row_count: Some(1),
                }])
                .await?;
            return Ok(branch_context_id);
        };
        bindings.push(nullable_text_binding(
            "@worktree_id",
            Some(worktree_id.text().as_str()),
        ));
        let results = self
            .writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(UPSERT_WORKTREE_CONTEXT_SQL),
                bindings: StatementBindings::Named(bindings),
                expected_row_count: Some(1),
            }])
            .await?;
        // The writer refuses any count but the one row the upsert returns.
        match results
            .first()
            .and_then(|result| result.rows.first())
            .and_then(|row| row.first())
        {
            Some(Value::Text(id)) => BranchContextId::new(id).map_err(|error| {
                invariant(
                    workspace_id,
                    WorkspaceServiceInvariantKind::BranchContextUnreadable,
                    "kept a branch context whose id is no UUID",
                    Some(Box::new(error)),
                )
            }),
            _ => Err(invariant(
                workspace_id,
                WorkspaceServiceInvariantKind::BranchContextUnreadable,
                "kept a branch context the write did not name",
                None,
            )),
        }
    }
}

/// The `lastError` a failed preparation records: a refusal's code and message, else the failure's
/// own message, each free of paths; the cause underneath, which can name one, stays out.
pub(crate) fn last_error_detail(failure: &ExecutionRootError) -> String {
    if let Some(refusal) = failure.refusal() {
        return format!("{}: {}", refusal.code.as_str(), refusal.message);
    }
    match failure {
        ExecutionRootError::Undone(undone) => last_error_detail(undone.original()),
        ExecutionRootError::Preparation { failure, .. } => last_error_detail(failure),
        ExecutionRootError::Invariant(invariant) => invariant.message.clone(),
        ExecutionRootError::Refused(refusal) => refusal.message.clone(),
        ExecutionRootError::Workspace(_)
        | ExecutionRootError::Creation(_)
        | ExecutionRootError::Read(_)
        | ExecutionRootError::Row(_)
        | ExecutionRootError::Write(_)
        | ExecutionRootError::Folder(_)
        | ExecutionRootError::RootText(_) => failure.to_string(),
    }
}

// The folder the workspace's metadata records under `key`; an unreadable-row invariant naming
// `what` when it records none.
fn stored_root(
    workspace: &WorkspaceRow,
    key: &str,
    what: &str,
) -> Result<PathBuf, ExecutionRootError> {
    let members = parse_stored_json_object(&workspace.metadata).map_err(|fault| {
        invariant(
            workspace.id,
            WorkspaceServiceInvariantKind::WorkspaceRowUnprojectable,
            "holds metadata that is no JSON object",
            Some(Box::new(fault)),
        )
    })?;
    members
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| {
            invariant(
                workspace.id,
                WorkspaceServiceInvariantKind::WorkspaceRowUnprojectable,
                &format!("records no {what}"),
                None,
            )
        })
}

fn invariant(
    workspace_id: WorkspaceId,
    kind: WorkspaceServiceInvariantKind,
    what: &str,
    source: Option<Box<dyn std::error::Error + Send + Sync>>,
) -> ExecutionRootError {
    WorkspaceServiceInvariantError {
        message: format!("workspace {workspace_id} {what}"),
        kind,
        workspace_id: Some(workspace_id),
        source,
    }
    .into()
}
