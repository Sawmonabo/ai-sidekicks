//! The rows outside the workflow tables that a run's execution context points at, for tests that
//! keep foreign keys on: a project, its mount, a workspace on it, a live worktree and that
//! worktree's branch context, in the workspace and worktree tables.

use rusqlite::Connection;
use sidekicks_contracts::project::ProjectState;
use sidekicks_contracts::repo::mount::ExecutionMode;
use sidekicks_contracts::worktree::lifecycle::WorktreeState;

use crate::git::worktree::schema::WORKTREE_SCHEMA_SQL;
use crate::workspace::schema::WORKSPACE_SCHEMA_SQL;

/// When every parent row was made.
pub(crate) const PARENT_ROWS_AT: &str = "2026-10-14T09:30:00.000Z";

/// The live worktree the parent branch context names.
pub(crate) const PARENT_WORKTREE_ID: &str = "parent-worktree";

/// Creates the workspace and worktree tables the parent rows sit in. Fails as SQLite does.
pub(crate) fn create_parent_tables(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(&WORKSPACE_SCHEMA_SQL)?;
    connection.execute_batch(&WORKTREE_SCHEMA_SQL)
}

/// Stores the parent rows: the project `project`, its mount `mount`, the workspace `workspace` of
/// session `session`, the worktree [`PARENT_WORKTREE_ID`] and the branch context `branch-context`.
pub(crate) fn insert_parent_rows(connection: &Connection) {
    let active = <&'static str>::from(ProjectState::Active);
    let provisioned = <&'static str>::from(ExecutionMode::ProvisionedWorktree);
    let ready = <&'static str>::from(WorktreeState::Ready);
    let rows = [
        format!(
            "INSERT INTO projects (id, name, slug, folder_path, state, setup, created_at, \
             updated_at) VALUES ('project', 'app', 'app', '/repos/app', '{active}', '{{}}', \
             '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
        ),
        format!(
            "INSERT INTO repo_mounts (id, machine_id, local_path, canonical_root, project_id, \
             attached_at, updated_at) VALUES ('mount', 'machine', '/repos/app', '/repos/app', \
             'project', '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
        ),
        format!(
            "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, \
             created_at, updated_at) VALUES ('workspace', 'session', 'mount', '{provisioned}', \
             '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
        ),
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
            .expect("a parent row is admitted");
    }
}

/// The insert of worktree `id` on the parent mount, on `branch_name`, at the state text `state`.
pub(crate) fn worktree_row(id: &str, branch_name: &str, state: &str) -> String {
    format!(
        "INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, base_ref, \
         fs_root, state, created_at, updated_at) VALUES ('{id}', 'mount', 'session', \
         '{branch_name}', 'main', '/worktrees/{id}', '{state}', '{PARENT_ROWS_AT}', \
         '{PARENT_ROWS_AT}')"
    )
}
