//! The workspace rows that worktree and run rows point at, for tests that keep foreign keys on: a
//! project, its mount and a workspace on it.

use rusqlite::Connection;
use sidekicks_contracts::project::ProjectState;
use sidekicks_contracts::repo::mount::ExecutionMode;

use crate::schema::WORKSPACE_SCHEMA_SQL;

/// When every parent row was made.
pub const PARENT_ROWS_AT: &str = "2026-10-14T09:30:00.000Z";

/// Creates the workspace tables the rows sit in. Fails as SQLite does.
pub fn create_workspace_tables(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(&WORKSPACE_SCHEMA_SQL)
}

/// The rows of a project `id` and its attached mount `id` of `/repos/app` in `place`, `NULL` with
/// none; each project is its own, since a project has one attached mount.
pub fn project_and_mount_rows(id: &str, place: Option<&str>) -> [String; 2] {
    let active = <&'static str>::from(ProjectState::Active);
    let place = place.map_or_else(|| "NULL".to_owned(), |place| format!("'{place}'"));
    [
        format!(
            "INSERT INTO projects (id, name, slug, folder_path, state, setup, place, created_at, \
             updated_at) VALUES ('{id}', 'app', '{id}', '/repos/app', '{active}', '{{}}', {place}, \
             '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
        ),
        format!(
            "INSERT INTO repo_mounts (id, machine_id, local_path, canonical_root, place, \
             project_id, attached_at, updated_at) VALUES ('{id}', 'machine', '/repos/app', \
             '/repos/app', {place}, '{id}', '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
        ),
    ]
}

/// Stores the project and its mount `mount` of `/repos/app` and the workspace `workspace` of
/// session `session` on that mount.
pub(crate) fn insert_workspace_rows(connection: &Connection) {
    let provisioned = <&'static str>::from(ExecutionMode::ProvisionedWorktree);
    let workspace = format!(
        "INSERT INTO workspaces (id, session_id, repo_mount_id, execution_mode, created_at, \
         updated_at) VALUES ('workspace', 'session', 'mount', '{provisioned}', \
         '{PARENT_ROWS_AT}', '{PARENT_ROWS_AT}')"
    );
    for row in project_and_mount_rows("mount", None)
        .iter()
        .chain([&workspace])
    {
        connection
            .execute_batch(row)
            .expect("a workspace row is admitted");
    }
}
