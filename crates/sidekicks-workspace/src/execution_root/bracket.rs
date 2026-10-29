//! The preparation bracket: the gate, the move into `preparing`, the root's materialization, its
//! branch context, and the move to `ready`; or, on a failure, the move to `rootLost` with why and
//! the undoing of a tree this preparation made.

use std::borrow::Cow;
use std::error::Error;

use notify::Watcher;
use sidekicks_contracts::repo::mount::WorkspaceState;
use sidekicks_contracts::worktree::lifecycle::BranchContextId;
use sidekicks_std::cleanup_failures::CleanupFailures;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};

use super::bind::{
    DELETE_BRANCH_CONTEXT_SQL, MaterializedRoot, RootMaterialization, RootProvenance,
    last_error_detail,
};
use super::{ExecutionRootError, ExecutionRootService, PreparedExecutionRoot};
use crate::git::worktree::carry::{KeptStash, kept_stash_failure};
use crate::row_guards::assert_mode_offered;
use crate::service::preparation::CompletedRootPreparation;
use crate::service::{AttachedMount, WorkspaceRow};

// What a failure's cleanups name, as a log line says it.
const PREPARATION_OPERATION: &str = "execution root preparation";

/// Whether a preparation passes the write gate first.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BracketGate {
    /// A prepare: the workspace must take writes, or, inside a bracket already open, its mount
    /// must still be reachable and hold its repository.
    Gated,
    /// A move, which is how a `rootLost` workspace leaves a folder that went away.
    Ungated,
}

impl<W: Watcher + Send + 'static> ExecutionRootService<W> {
    /// Opens the bracket unless it is open already, behind the gate `gate` names, materializes the
    /// root, writes its branch context and completes the bracket. A failure once the bracket is
    /// open parks the workspace `rootLost` and undoes a tree this call made; a failure after the
    /// carried work's stash was pushed names the stash.
    pub(super) async fn run_bracket(
        &self,
        workspace: &WorkspaceRow,
        mount: &AttachedMount,
        gate: BracketGate,
        materialization: RootMaterialization,
    ) -> Result<PreparedExecutionRoot, ExecutionRootError> {
        let workspace_id = workspace.id;
        let execution_mode = materialization.execution_mode();
        // Before the bracket, open or not: an open bracket skips the begin's own check.
        assert_mode_offered(execution_mode, mount.managed_session_id.is_some())?;
        // A bind's workspace is born `preparing`, and a failed recording of a failure leaves one
        // there; the write gate refuses `preparing`, so an open bracket checks the mount alone.
        match (workspace.state, gate) {
            (WorkspaceState::Preparing, BracketGate::Gated) => {
                self.workspaces.assert_mount_healthy(workspace_id).await?;
            }
            (WorkspaceState::Preparing, BracketGate::Ungated) => {}
            (WorkspaceState::Ready | WorkspaceState::RootLost | WorkspaceState::Archived, gate) => {
                // Before any git call, so a workspace that cannot take writes costs no spawn.
                if gate == BracketGate::Gated {
                    self.workspaces.assert_writable(workspace_id).await?;
                }
                self.workspaces
                    .begin_root_preparation(workspace_id, execution_mode)
                    .await?;
            }
        }

        let materialized = match self.materialize(workspace, mount, materialization).await {
            Ok(materialized) => materialized,
            // Nothing stands to undo: what the creation made, it undid itself.
            Err(failure) => {
                return Err(self.fail_preparation(workspace, failure, Vec::new()).await);
            }
        };
        let branch_context_id = match self.write_branch_context(workspace_id, &materialized).await {
            Ok(branch_context_id) => branch_context_id,
            Err(failure) => {
                // A root no context names is invisible to the sweep, so it is undone here.
                let undo_failures = self.undo_created_root(&materialized, None).await;
                let failure = naming_carried_stash(&materialized, failure);
                return Err(self
                    .fail_preparation(workspace, failure, undo_failures)
                    .await);
            }
        };
        let completed = CompletedRootPreparation {
            execution_root: materialized.execution_root.clone(),
            checkout_root: materialized.checkout_root.clone(),
            execution_mode: Some(materialized.execution_mode),
            bound_root: materialized.bound_root.clone(),
        };
        if let Err(failure) = self
            .workspaces
            .complete_root_preparation(workspace_id, &completed)
            .await
        {
            let undo_failures = self
                .undo_created_root(&materialized, Some(branch_context_id))
                .await;
            let failure = naming_carried_stash(&materialized, failure.into());
            return Err(ExecutionRootError::Preparation {
                workspace_id,
                failure: Box::new(with_cleanup_failures(failure, undo_failures)),
            });
        }
        // Only now does the adopted tree stand as the one copy of the carried work.
        if let (Some(carried_stash), Some(worktree_id)) =
            (&materialized.carried_stash, materialized.worktree_id)
        {
            self.creator
                .drop_carried_stash(carried_stash, &worktree_id, workspace.place.as_ref())
                .await;
        }
        Ok(PreparedExecutionRoot {
            workspace_id,
            execution_mode: materialized.execution_mode,
            execution_root: materialized.execution_root,
            checkout_root: materialized.checkout_root,
            worktree_id: materialized.worktree_id,
            branch_context_id,
        })
    }

    // Records `failure` on the workspace, `preparing` to `rootLost`, so its runs block in setup;
    // the recording's own failure rides beside `failure` with `cleanup_failures`, and a workspace
    // whose recording failed stays `preparing`, which a later prepare reads as an open bracket.
    async fn fail_preparation(
        &self,
        workspace: &WorkspaceRow,
        failure: ExecutionRootError,
        mut cleanup_failures: Vec<Box<dyn Error + Send + Sync>>,
    ) -> ExecutionRootError {
        if let Err(recording) = self
            .workspaces
            .fail_root_preparation(workspace.id, &last_error_detail(&failure))
            .await
        {
            cleanup_failures.push(Box::new(recording));
        }
        ExecutionRootError::Preparation {
            workspace_id: workspace.id,
            failure: Box::new(with_cleanup_failures(failure, cleanup_failures)),
        }
    }

    // Undoes a tree this preparation made but could not hand over, which nothing else reclaims:
    // its branch context when one was written, then its retirement, which frees its branch while
    // the sweep reclaims the folder. Each step runs after an earlier one failed, and the failures
    // are answered for the caller to carry beside its own.
    async fn undo_created_root(
        &self,
        materialized: &MaterializedRoot,
        branch_context_id: Option<BranchContextId>,
    ) -> Vec<Box<dyn Error + Send + Sync>> {
        let (RootProvenance::Created, Some(worktree_id)) =
            (materialized.provenance, materialized.worktree_id)
        else {
            return Vec::new();
        };
        let mut failures: Vec<Box<dyn Error + Send + Sync>> = Vec::new();
        if let Some(branch_context_id) = branch_context_id {
            let deleted = self
                .writer
                .write(vec![WriteStatement {
                    sql: Cow::Borrowed(DELETE_BRANCH_CONTEXT_SQL),
                    bindings: StatementBindings::Named(vec![text_binding(
                        "@id",
                        branch_context_id.text().as_str(),
                    )]),
                    expected_row_count: Some(1),
                }])
                .await;
            if let Err(failure) = deleted {
                failures.push(Box::new(failure));
            }
        }
        if let Err(failure) = self.worktrees.retire_unadopted(&worktree_id).await {
            failures.push(Box::new(failure));
        }
        // The retired tree's card goes once its retirement is written.
        self.setup.forget_retired().await;
        failures
    }
}

// A failure after a carry: the tree that took the work is undone, so the kept stash is the only
// copy and the failure names it.
fn naming_carried_stash(
    materialized: &MaterializedRoot,
    failure: ExecutionRootError,
) -> ExecutionRootError {
    match &materialized.carried_stash {
        Some(carried_stash) => {
            kept_stash_failure(KeptStash::Commit(&carried_stash.commit), failure).into()
        }
        None => failure,
    }
}

// `failure` with the failures of cleaning up after it beside it, or alone when every cleanup held.
fn with_cleanup_failures(
    failure: ExecutionRootError,
    cleanup_failures: Vec<Box<dyn Error + Send + Sync>>,
) -> ExecutionRootError {
    if cleanup_failures.is_empty() {
        return failure;
    }
    ExecutionRootError::Undone(Box::new(CleanupFailures::new(
        failure,
        cleanup_failures,
        PREPARATION_OPERATION,
    )))
}
