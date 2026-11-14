//! A run's execution context row: the facts a binding resolved for it, the guarded statement that
//! writes it and the one that releases it, the binding a run started outside the run engine asks
//! the gate for, and the statements that archive and delete a workflow run's own workspace.

use std::borrow::Cow;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use futures::future::BoxFuture;
use notify::Watcher;
use sidekicks_contracts::repo::mount::{
    ExecutionMode, RepoMountId, RepoMountState, WorkspaceId, WorkspaceState,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::run::id::WorkflowRunId;
use sidekicks_contracts::worktree::lifecycle::{BranchContextId, WorktreeId, WorktreeState};
use sidekicks_std::keyed_lock::KeyHold;
use sidekicks_store::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};

use super::{
    ExecutionRootSetupGate, RunToBind, RunWorkspaceAbsence, cause_of_root, failed,
    root_unavailable, unresolved,
};
use crate::project::records::AttachedProjectRoot;
use crate::run_setup_gates::RunSetupGateError;

// Writes only while the workspace is `ready` on the attached mount the binding read and its
// checkout is no retired tree still to be cleaned; zero rows refuses the write. A run version that
// starts again rebinds its context and is live again.
static UPSERT_RUN_CONTEXT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "INSERT INTO run_execution_contexts (
    run_id, session_id, workspace_id, execution_mode, execution_root, checkout_root,
    git_common_dir, worktree_id, branch_context_id, created_at, released_at
  )
  SELECT @run_id, @session_id, workspace.id, @execution_mode, @execution_root, @checkout_root,
         @git_common_dir, @worktree_id, @branch_context_id, @now, NULL
    FROM workspaces AS workspace
    JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
   WHERE workspace.id = @workspace_id
     AND workspace.state = '{ready}'
     AND workspace.repo_mount_id = @repo_mount_id
     AND mount.state = '{attached}'
     AND NOT EXISTS (SELECT 1 FROM worktrees
                      WHERE state = '{retired}' AND cleaned_at IS NULL
                        AND fs_root = @checkout_root)
  ON CONFLICT (run_id) DO UPDATE SET
    workspace_id = excluded.workspace_id,
    execution_mode = excluded.execution_mode,
    execution_root = excluded.execution_root,
    checkout_root = excluded.checkout_root,
    git_common_dir = excluded.git_common_dir,
    worktree_id = excluded.worktree_id,
    branch_context_id = excluded.branch_context_id,
    released_at = NULL",
        ready = <&'static str>::from(WorkspaceState::Ready),
        attached = <&'static str>::from(RepoMountState::Attached),
        retired = <&'static str>::from(WorktreeState::Retired),
    )
});

const RELEASE_RUN_CONTEXT_SQL: &str = "UPDATE run_execution_contexts SET released_at = @now
  WHERE run_id = @run_id AND released_at IS NULL";

const ARCHIVE_RUN_WORKSPACE_SQL: &str = "UPDATE workspaces SET state = @archived, updated_at = @now
  WHERE workflow_run_id = @run_id AND state <> @archived";

/// Binds a run a session starts outside the run engine, a workflow run, in the session's own live
/// workspace, and holds the checkout its context row is written in, which the gate implements.
pub trait SessionRunBinder: Send + Sync {
    /// Binds run `run_id` of `session_id` as an agent run's setup does, a worktree's first root
    /// named from the session's title or else `opening_words`, and answers its context row's
    /// facts, writing nothing of the row. Refuses `workspace.executionRoot.unresolved` wrapping why
    /// the workspace could not be bound, the cause `workspace.notFound` naming the session's newest
    /// workspace when it holds none live; fails when the session never held a workspace or works
    /// in a chat's own folder, which takes no context.
    fn bind_session_run<'a>(
        &'a self,
        session_id: SessionId,
        run_id: &'a str,
        opening_words: &'a str,
    ) -> BoxFuture<'a, Result<RunContextBinding, RunSetupGateError>>;

    /// Binds workflow run `workflow_run_id` of `session_id`, started on the project whose folder
    /// `root` is, in a workspace of its own: a bound folder at the project's root on its attached
    /// mount, which the session's reads leave out, prepared and answered as
    /// [`SessionRunBinder::bind_session_run`] answers. Refuses as a workspace bind does before the
    /// workspace is made, and `workspace.executionRoot.unresolved` wrapping why it could not be
    /// bound after.
    fn bind_project_run<'a>(
        &'a self,
        session_id: SessionId,
        workflow_run_id: WorkflowRunId,
        root: &'a AttachedProjectRoot,
    ) -> BoxFuture<'a, Result<RunContextBinding, RunSetupGateError>>;

    /// Deletes the workspace workflow run `workflow_run_id` owns, with its branch contexts, for a
    /// start that made no run or one a stop cut before its run's row, writing nothing into its
    /// chat's log; does nothing where it owns none. Fails as the read or the write fails.
    fn discard_project_run(
        &self,
        workflow_run_id: WorkflowRunId,
    ) -> BoxFuture<'_, Result<(), RunSetupGateError>>;

    /// Waits for and takes the lock of `binding`'s checkout, which the caller holds across the one
    /// write of the binding's [`context_statement`].
    fn hold_checkout<'a>(
        &'a self,
        binding: &'a RunContextBinding,
    ) -> BoxFuture<'a, KeyHold<'a, PathBuf>>;

    /// Tells the projects list that a write holding a context row of `session_id`'s run, or its
    /// release, committed, so the session's live-run figure is read again.
    fn note_context_changed(&self, session_id: SessionId);

    /// Sweeps `session_id` out of a tree removed while a workflow run of it was bound there, once
    /// the write that released the run's context committed, as an agent run's end does. Fails as
    /// the sweep fails.
    fn sweep_released_run(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), RunSetupGateError>>;
}

/// A run bound in its workspace: the facts its context row is written from, and the canonical
/// checkout whose lock that write holds.
#[derive(Debug)]
pub struct RunContextBinding {
    /// The run's id, an agent run's or a workflow run's, which the row is keyed by.
    pub(super) run_id: String,
    /// The run's session.
    pub(super) session_id: SessionId,
    /// The workspace the run works in.
    pub(super) workspace_id: WorkspaceId,
    /// The mount that workspace is on, which the write checks is still attached.
    pub(super) repo_mount_id: RepoMountId,
    /// How the workspace uses its mount.
    pub(super) execution_mode: ExecutionMode,
    /// Where the run works.
    pub(super) execution_root: PathBuf,
    /// The top level of the working tree the run works in.
    pub(super) checkout_root: PathBuf,
    /// The repository's git common folder, which outlives a removed tree.
    pub(super) common_folder: PathBuf,
    /// The daemon's tree at a worktree's root; `None` for a bound folder.
    pub(super) worktree_id: Option<WorktreeId>,
    /// The workspace's branch context for the root.
    pub(super) branch_context_id: BranchContextId,
    /// The checkout resolved, which keys the checkout's lock.
    pub(super) checkout_key: PathBuf,
}

impl RunContextBinding {
    /// Where the run works.
    pub fn execution_root(&self) -> &Path {
        &self.execution_root
    }

    /// The mount the run's workspace is on.
    pub fn repo_mount_id(&self) -> RepoMountId {
        self.repo_mount_id
    }
}

/// The guarded upsert of `binding`'s context row, created at `now`: it writes one row only while
/// the workspace is `ready` on the attached mount the binding read and its checkout is no retired
/// tree still to be cleaned, so a write it is refused at has changed nothing.
pub fn context_statement(binding: &RunContextBinding, now: &WireInstant) -> WriteStatement {
    let worktree_id = binding.worktree_id.map(|worktree_id| worktree_id.text());
    WriteStatement {
        sql: Cow::Borrowed(UPSERT_RUN_CONTEXT_SQL.as_str()),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", &binding.run_id),
            text_binding("@session_id", binding.session_id.text().as_str()),
            text_binding("@workspace_id", binding.workspace_id.text().as_str()),
            text_binding("@repo_mount_id", binding.repo_mount_id.text().as_str()),
            text_binding(
                "@execution_mode",
                <&'static str>::from(binding.execution_mode),
            ),
            text_binding("@execution_root", &binding.execution_root.to_string_lossy()),
            text_binding("@checkout_root", &binding.checkout_root.to_string_lossy()),
            text_binding("@git_common_dir", &binding.common_folder.to_string_lossy()),
            nullable_text_binding("@worktree_id", worktree_id.as_ref().map(UuidText::as_str)),
            text_binding(
                "@branch_context_id",
                binding.branch_context_id.text().as_str(),
            ),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: Some(1),
    }
}

/// The refusal of a write that `binding`'s [`context_statement`] refused:
/// `workspace.executionRoot.unresolved` wrapping `workspace.rootUnavailable`, with the write's
/// failure as its source, since the workspace left `ready`, its mount was detached or its
/// checkout's removal committed after the binding read them.
pub fn context_write_refusal(
    binding: &RunContextBinding,
    source: impl Error + Send + Sync + 'static,
) -> RunSetupGateError {
    unresolved(
        binding.workspace_id,
        root_unavailable(binding.workspace_id, source),
    )
}

/// The statement that stamps run `run_id`'s context released at `now`; it changes no row for a
/// run with no live context.
pub fn release_run_context_statement(run_id: &str, now: &WireInstant) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(RELEASE_RUN_CONTEXT_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@run_id", run_id),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: None,
    }
}

/// The statement that archives the workspace workflow run `run_id` owns at `now`, as the run ends;
/// it changes no row for a run that owns none.
pub fn archive_run_workspace_statement(run_id: &str, now: &WireInstant) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(ARCHIVE_RUN_WORKSPACE_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@archived", <&'static str>::from(WorkspaceState::Archived)),
            text_binding("@run_id", run_id),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count: None,
    }
}

/// The deletes of the workspaces the workflow runs `runs` selects own, `runs` a subquery of run
/// ids over the statement's bindings, their branch contexts first so the foreign keys hold; a
/// write runs them once those runs' context rows, which name the branch contexts, are gone. They
/// change no row for a run that owns none.
pub fn run_workspace_delete_sql(runs: &str) -> [String; 2] {
    [
        format!(
            "DELETE FROM branch_contexts WHERE workspace_id IN
  (SELECT id FROM workspaces WHERE workflow_run_id IN ({runs}))"
        ),
        format!("DELETE FROM workspaces WHERE workflow_run_id IN ({runs})"),
    ]
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
                workflow_run_id: None,
            };
            let Some(before) = self.read_workspace(&run).await? else {
                return Err(self.refuse_no_live_workspace(session_id).await);
            };
            self.bind_run(&run, &before)
                .await
                .and_then(|(binding, _hold)| {
                    binding.ok_or_else(|| failed(RunWorkspaceAbsence::Managed(session_id)))
                })
                .map_err(|cause| unresolved(before.id, cause))
        })
    }

    fn bind_project_run<'a>(
        &'a self,
        session_id: SessionId,
        workflow_run_id: WorkflowRunId,
        root: &'a AttachedProjectRoot,
    ) -> BoxFuture<'a, Result<RunContextBinding, RunSetupGateError>> {
        Box::pin(async move {
            let workspace_id = self
                .workspaces
                .bind_run_workspace(
                    session_id,
                    root.repo_mount_id,
                    &root.canonical_root,
                    workflow_run_id,
                )
                .await
                .map_err(|error| cause_of_root(error.into()))?;
            let run_id = workflow_run_id.text();
            let run = RunToBind {
                session_id,
                run_id: run_id.as_str(),
                agent_run_id: None,
                opening_words: None,
                workspace_id: Some(workspace_id),
                workflow_run_id: Some(workflow_run_id),
            };
            // The workspace is the run's alone, so no sweep and no move of the session's touch it.
            let hold = self.execution_roots.hold_preparation(workspace_id).await;
            self.bind_held(&run, &hold)
                .await
                .and_then(|binding| {
                    binding.ok_or_else(|| failed(RunWorkspaceAbsence::Managed(session_id)))
                })
                .map_err(|cause| unresolved(workspace_id, cause))
        })
    }

    fn discard_project_run(
        &self,
        workflow_run_id: WorkflowRunId,
    ) -> BoxFuture<'_, Result<(), RunSetupGateError>> {
        Box::pin(async move {
            self.workspaces
                .discard_run_workspace(workflow_run_id)
                .await
                .map_err(failed)
        })
    }

    fn hold_checkout<'a>(
        &'a self,
        binding: &'a RunContextBinding,
    ) -> BoxFuture<'a, KeyHold<'a, PathBuf>> {
        Box::pin(self.lock_checkout(binding))
    }

    fn note_context_changed(&self, session_id: SessionId) {
        self.list_feed.refresh_sessions(&[session_id]);
    }

    fn sweep_released_run(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), RunSetupGateError>> {
        Box::pin(async move {
            self.moves
                .sweep_from_removed_tree(&session_id, None)
                .await
                .map_err(RunSetupGateError::Failed)
        })
    }
}
