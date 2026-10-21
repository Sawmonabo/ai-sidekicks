//! The `worktrees` rows the worktree modules read back and the statements more than one of them
//! writes, the conditions that say a row is live and that an agent runs in a tree, and what a
//! refused compare-and-swap on one of its transitions means.

use std::borrow::Cow;
use std::fmt;
use std::sync::LazyLock;

use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidText;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::worktree::lifecycle::{WorktreeId, WorktreeState};

use crate::database::statement::{
    StatementBindings, WriteStatement, nullable_text_binding, text_binding,
};
use crate::database::writer::WriteError;
use crate::git::worktree::schema::BRANCH_RELEASING_STATE_LIST;

/// The `worktrees` columns a removal reads: the row, its mount, creator, folder, branch and state,
/// each parsed to its type where the row is read.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(dead_code, reason = "worktree removal")]
pub(crate) struct WorktreeRow {
    /// `worktrees.id`.
    pub(crate) id: WorktreeId,
    /// The mount the tree belongs to.
    pub(crate) repo_mount_id: RepoMountId,
    /// The session that made it.
    pub(crate) created_by_session_id: SessionId,
    /// Its branch.
    pub(crate) branch_name: GitRefName,
    /// The base its branch was cut from, as given.
    pub(crate) base_ref: GitRefName,
    /// The tree's folder.
    pub(crate) fs_root: FilesystemPath,
    /// Its state.
    pub(crate) state: WorktreeState,
}

/// An `attached` repo mount, the only kind a worktree is made from, and its project.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(dead_code, reason = "the worktree lifecycle")]
pub(crate) struct AttachedMountRow {
    /// `repo_mounts.id`.
    pub(crate) id: RepoMountId,
    /// The repository's root folder.
    pub(crate) canonical_root: FilesystemPath,
    /// The project the mount belongs to.
    pub(crate) project_id: ProjectId,
}

/// One run context whose run has not ended.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(dead_code, reason = "worktree retirement")]
pub(crate) struct UnreleasedRunRow {
    /// The session the run belongs to.
    pub(crate) session_id: SessionId,
    /// The tree the run works in; `None` for a run in the mount's own checkout.
    pub(crate) worktree_id: Option<WorktreeId>,
    /// The folder the run works in, as recorded.
    pub(crate) execution_root: FilesystemPath,
}

/// The values of a `creating` row's insert.
#[derive(Clone, Debug)]
#[expect(dead_code, reason = "worktree creation and a put-back tree's record")]
pub(crate) struct NewWorktreeRow {
    /// The new tree.
    pub(crate) id: WorktreeId,
    /// The mount it is made on.
    pub(crate) repo_mount_id: RepoMountId,
    /// The session that makes it.
    pub(crate) created_by_session_id: SessionId,
    /// The run that makes it; `None` for a prepare before any run.
    pub(crate) created_by_run_id: Option<RunId>,
    /// Its branch.
    pub(crate) branch_name: GitRefName,
    /// The base its branch is cut from, as given.
    pub(crate) base_ref: GitRefName,
    /// The tree's folder.
    pub(crate) fs_root: FilesystemPath,
    /// When it is made, written as both its creation and its last change.
    pub(crate) now: WireInstant,
}

/// The SQL condition that the `worktrees` row read as `table` is live, on disk and holding its
/// branch; built from the same state list as `idx_worktrees_active_branch`, so live reads agree
/// with it.
pub(crate) fn live_worktree_state_predicate(table: &str) -> String {
    format!(
        "{table}.state NOT IN ({})",
        BRANCH_RELEASING_STATE_LIST.as_str()
    )
}

/// [`live_worktree_state_predicate`] for a query that reads the table by its own name.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "worktree creation, the worktree lifecycle, the branch list, worktree claims, \
                  the removed-worktrees store and the workspace's reattach, folder-usage and \
                  trust envelope reads"
    )
)]
pub(crate) static LIVE_WORKTREE_STATE_PREDICATE: LazyLock<String> =
    LazyLock::new(|| live_worktree_state_predicate("worktrees"));

/// `creating -> ready`, the one transition both a new tree and a put-back tree take.
#[expect(dead_code, reason = "worktree creation and a put-back tree's record")]
pub(crate) static MARK_READY_SQL: LazyLock<String> = LazyLock::new(|| {
    let ready = <&'static str>::from(WorktreeState::Ready);
    let creating = <&'static str>::from(WorktreeState::Creating);
    format!(
        "UPDATE worktrees
    SET state = '{ready}', updated_at = @now
  WHERE id = @worktree_id AND state = '{creating}'"
    )
});

// `state` is left to the column DEFAULT ('creating'); naming it would copy that fact.
#[expect(dead_code, reason = "worktree creation and a put-back tree's record")]
const INSERT_WORKTREE_SQL: &str = "INSERT INTO worktrees (
    id, repo_mount_id, created_by_session_id, created_by_run_id,
    branch_name, base_ref, fs_root, created_at, updated_at
  ) VALUES (
    @id, @repo_mount_id, @created_by_session_id, @created_by_run_id,
    @branch_name, @base_ref, @fs_root, @now, @now
  )";

/// The `creating` row's insert, for a write that also appends its `worktree.created`.
#[expect(dead_code, reason = "worktree creation and a put-back tree's record")]
pub(crate) fn insert_worktree_statement(row: &NewWorktreeRow) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(INSERT_WORKTREE_SQL),
        bindings: StatementBindings::Named(vec![
            text_binding("@id", row.id.text().as_str()),
            text_binding("@repo_mount_id", row.repo_mount_id.text().as_str()),
            text_binding(
                "@created_by_session_id",
                row.created_by_session_id.text().as_str(),
            ),
            nullable_text_binding(
                "@created_by_run_id",
                row.created_by_run_id
                    .map(|run_id| run_id.text())
                    .as_ref()
                    .map(UuidText::as_str),
            ),
            text_binding("@branch_name", row.branch_name.as_str()),
            text_binding("@base_ref", row.base_ref.as_str()),
            text_binding("@fs_root", row.fs_root.as_str()),
            text_binding("@now", row.now.as_str()),
        ]),
        expected_row_count: None,
    }
}

/// A transition statement `sql` on the worktree row `worktree_id`, binding `@worktree_id` and
/// `@now`; the write is refused unless it changes `expected_row_count` rows, when one is given.
#[expect(dead_code, reason = "worktree creation and retirement")]
pub(crate) fn transition_statement(
    sql: &'static str,
    worktree_id: &WorktreeId,
    now: &WireInstant,
    expected_row_count: Option<usize>,
) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(sql),
        bindings: StatementBindings::Named(vec![
            text_binding("@worktree_id", worktree_id.text().as_str()),
            text_binding("@now", now.as_str()),
        ]),
        expected_row_count,
    }
}

/// The run contexts of the worktree `@worktree_id` whose run has not ended, matched as stored: an
/// agent runs in the tree when its context names the tree or roots at its folder or below it,
/// under either platform's separator. The retirement's write checks this inside its transaction;
/// a run recorded under another spelling of the folder is caught before the write by the
/// resolved-path read over [`UNRELEASED_RUNS_SQL`].
#[expect(dead_code, reason = "worktree retirement")]
pub(crate) const UNRELEASED_RUN_IN_WORKTREE_SQL: &str = "SELECT run.session_id
    FROM worktrees
    JOIN run_execution_contexts AS run
      ON run.worktree_id = worktrees.id
      OR run.execution_root = worktrees.fs_root
      OR substr(run.execution_root, 1, length(worktrees.fs_root) + 1)
         IN (worktrees.fs_root || '/', worktrees.fs_root || '\\')
   WHERE worktrees.id = @worktree_id
     AND run.released_at IS NULL
   ORDER BY run.created_at ASC
   LIMIT 1";

/// Every run context whose run has not ended, oldest first, for a resolved-path comparison; its
/// columns are [`UnreleasedRunRow`]'s, in order.
#[expect(dead_code, reason = "worktree retirement")]
pub(crate) const UNRELEASED_RUNS_SQL: &str = "SELECT session_id, worktree_id, execution_root
    FROM run_execution_contexts
   WHERE released_at IS NULL
   ORDER BY created_at ASC, run_id ASC";

/// The worktree row changes whose compare-and-swap a refusal names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[expect(dead_code, reason = "worktree creation and retirement")]
pub(crate) enum WorktreeRowChange {
    /// The retirement's write.
    Retire,
    /// `creating -> ready`.
    MarkReady,
}

// The change in words, as a refusal names it.
impl fmt::Display for WorktreeRowChange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Retire => "retire",
            Self::MarkReady => "mark ready",
        })
    }
}

/// A refused compare-and-swap on one worktree row: the row left its expected state before the
/// write committed. An internal consistency failure with no caller repair.
#[derive(Debug, thiserror::Error)]
#[expect(dead_code, reason = "worktree creation and retirement")]
#[error(
    "cannot {change} worktree \"{worktree_id}\": it left its expected state before the write \
     committed"
)]
pub(crate) struct WorktreeRowRefusal {
    /// The worktree whose row moved.
    pub(crate) worktree_id: WorktreeId,
    /// The change that was refused.
    pub(crate) change: WorktreeRowChange,
    /// The writer's refusal.
    #[source]
    pub(crate) write: WriteError,
}

impl WorktreeRowRefusal {
    /// What `failure` means for the `change` of `worktree_id`'s row: the refusal when the writer
    /// refused the write, else `failure` unchanged as the error.
    #[expect(dead_code, reason = "worktree creation and retirement")]
    pub(crate) fn explain(
        failure: WriteError,
        worktree_id: WorktreeId,
        change: WorktreeRowChange,
    ) -> Result<Self, WriteError> {
        if !matches!(failure, WriteError::Refused { .. }) {
            return Err(failure);
        }
        Ok(Self {
            worktree_id,
            change,
            write: failure,
        })
    }
}
