//! The worktree rows that run rows point at, for tests that keep foreign keys on: the workspace
//! rows, a live worktree on their mount and that worktree's branch context.

use rusqlite::Connection;
use sidekicks_contracts::worktree::lifecycle::WorktreeState;

use crate::git::worktree::schema::WORKTREE_SCHEMA_SQL;
use crate::workspace::test_rows::{PARENT_ROWS_AT, create_workspace_tables, insert_workspace_rows};

/// The live worktree the parent branch context names.
pub(crate) const PARENT_WORKTREE_ID: &str = "parent-worktree";

/// Creates the workspace and worktree tables the rows sit in. Fails as SQLite does.
pub(crate) fn create_worktree_tables(connection: &Connection) -> rusqlite::Result<()> {
    create_workspace_tables(connection)?;
    connection.execute_batch(&WORKTREE_SCHEMA_SQL)
}

/// Stores the workspace rows, the worktree [`PARENT_WORKTREE_ID`] on mount `mount` and its branch
/// context `branch-context` in workspace `workspace`.
pub(crate) fn insert_worktree_rows(connection: &Connection) {
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
