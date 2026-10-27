//! The worktree rows that run rows point at, for tests that keep foreign keys on: the workspace
//! rows, a live worktree on their mount and that worktree's branch context, and a run's execution
//! context on it.

use rusqlite::{Connection, named_params};
use sidekicks_contracts::worktree::lifecycle::WorktreeState;

use crate::git::worktree::schema::WORKTREE_SCHEMA_SQL;
use crate::test_rows::{PARENT_ROWS_AT, create_workspace_tables, insert_workspace_rows};

/// The live worktree the parent branch context names.
pub(crate) const PARENT_WORKTREE_ID: &str = "parent-worktree";

/// Creates the workspace and worktree tables the rows sit in. Fails as SQLite does.
pub fn create_worktree_tables(connection: &Connection) -> rusqlite::Result<()> {
    create_workspace_tables(connection)?;
    connection.execute_batch(&WORKTREE_SCHEMA_SQL)
}

/// Stores the workspace rows, the worktree [`PARENT_WORKTREE_ID`] on mount `mount` and its branch
/// context `branch-context` in workspace `workspace`.
pub fn insert_worktree_rows(connection: &Connection) {
    insert_workspace_rows(connection);
    let ready = <&'static str>::from(WorktreeState::Ready);
    let rows = [
        worktree_row(PARENT_WORKTREE_ID, "parent", ready),
        format!(
            "INSERT INTO branch_contexts (id, workspace_id, worktree_id, base_branch, \
             head_branch, created_at, updated_at) VALUES ('branch-context', 'workspace', \
             '{PARENT_WORKTREE_ID}', 'main', 'parent', '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
        ),
    ];
    for row in rows {
        connection
            .execute_batch(&row)
            .expect("a worktree row is admitted");
    }
}

/// The insert of worktree `id` on mount `mount`, on `branch_name`, at the state text `state`.
pub(crate) fn worktree_row(id: &str, branch_name: &str, state: &str) -> String {
    format!(
        "INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, base_ref, \
         fs_root, state, created_at, updated_at) VALUES ('{id}', 'mount', 'session', \
         '{branch_name}', 'main', '/worktrees/{id}', '{state}', '{PARENT_ROWS_AT}', \
         '{PARENT_ROWS_AT}')"
    )
}

/// A run's execution context row on the parent branch context in workspace `workspace`, made at
/// [`PARENT_ROWS_AT`]; [`RunContextRow::BOUND_ROOT`] fills the fields a test leaves alone.
#[derive(Clone, Copy, Debug)]
pub struct RunContextRow<'a> {
    /// The run.
    pub run_id: &'a str,
    /// The mode's text, any text, so a test can store one outside the set.
    pub execution_mode: &'a str,
    /// Where the run executes.
    pub execution_root: &'a str,
    /// The checkout's top level.
    pub checkout_root: Option<&'a str>,
    /// The repository's common git folder.
    pub git_common_dir: Option<&'a str>,
    /// The worktree the run executes in.
    pub worktree_id: Option<&'a str>,
    /// When the run let its context go.
    pub released_at: Option<&'a str>,
}

impl RunContextRow<'_> {
    /// The unreleased bound-root run `run` in the checkout `/repos/app`.
    pub const BOUND_ROOT: RunContextRow<'static> = RunContextRow {
        run_id: "run",
        execution_mode: "boundRoot",
        execution_root: "/repos/app",
        checkout_root: Some("/repos/app"),
        git_common_dir: Some("/repos/app/.git"),
        worktree_id: None,
        released_at: None,
    };

    /// Stores the row. Fails as SQLite does, a constraint's refusal among them.
    pub fn insert(&self, connection: &Connection) -> rusqlite::Result<()> {
        connection
            .execute(
                "INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, \
                 execution_mode, execution_root, checkout_root, git_common_dir, worktree_id, \
                 branch_context_id, created_at, released_at) VALUES (:run_id, 'session', \
                 'workspace', :execution_mode, :execution_root, :checkout_root, :git_common_dir, \
                 :worktree_id, 'branch-context', :created_at, :released_at)",
                named_params! {
                    ":run_id": self.run_id,
                    ":execution_mode": self.execution_mode,
                    ":execution_root": self.execution_root,
                    ":checkout_root": self.checkout_root,
                    ":git_common_dir": self.git_common_dir,
                    ":worktree_id": self.worktree_id,
                    ":created_at": PARENT_ROWS_AT,
                    ":released_at": self.released_at,
                },
            )
            .map(drop)
    }
}
