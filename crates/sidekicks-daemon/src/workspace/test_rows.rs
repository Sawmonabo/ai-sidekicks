//! The workspace rows that worktree and run rows point at, for tests that keep foreign keys on: a
//! project, its mount and a workspace on it.

use rusqlite::Connection;
use sidekicks_contracts::project::ProjectState;
use sidekicks_contracts::repo::mount::ExecutionMode;

use crate::workspace::schema::WORKSPACE_SCHEMA_SQL;

/// When every parent row was made.
pub(crate) const PARENT_ROWS_AT: &str = "2026-10-14T09:30:00.000Z";

/// Creates the workspace tables the rows sit in. Fails as SQLite does.
pub(crate) fn create_workspace_tables(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(&WORKSPACE_SCHEMA_SQL)
}

/// Stores the project `project`, its mount `mount` of `/repos/app` and the workspace `workspace`
/// of session `session` on that mount.
pub(crate) fn insert_workspace_rows(connection: &Connection) {
    let active = <&'static str>::from(ProjectState::Active);
    let provisioned = <&'static str>::from(ExecutionMode::ProvisionedWorktree);
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
    ];
    for row in rows {
        connection
            .execute_batch(&row)
            .expect("a workspace row is admitted");
    }
}
