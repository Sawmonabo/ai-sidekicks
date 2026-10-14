//! The lookups the session verbs and the sessions list share: whether a session has a directory
//! row, and the project it sits in. A session's project is the project of the attached mount its
//! latest workspace binds, or, before its workspace is bound (its project still cloning), the
//! project its create named; a chat's managed mount is no project, and a forgotten project is none.

use std::borrow::Cow;

use sidekicks_contracts::session::id::SessionId;

use crate::database::statement::{StatementBindings, WriteStatement, text_binding};

/// The subquery answering the project id of the session whose id `session_id_sql` reads (a bound
/// parameter such as `@sessionId`, or a column such as `s.id`), or NULL for a chat, a session whose
/// project was forgotten, or one not bound to a project yet.
pub(crate) fn session_project_sql(session_id_sql: &str) -> String {
    format!(
        "(SELECT project.id FROM projects AS project
    WHERE project.id = COALESCE(
      (SELECT mount.project_id
         FROM workspaces AS workspace
         JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
        WHERE workspace.session_id = {session_id_sql} AND mount.origin = 'attached'
        ORDER BY workspace.created_at DESC, workspace.id DESC
        LIMIT 1),
      (SELECT request.project_id
         FROM session_create_requests AS request
        WHERE request.session_id = {session_id_sql})))"
    )
}

/// Reads a row only while the session the `@sessionId` parameter names has a directory row.
pub(crate) const SESSION_EXISTS_SQL: &str = "SELECT 1 FROM sessions WHERE id = @sessionId";

/// Holds only while the session has a directory row: the write refuses and rolls back otherwise.
pub(crate) fn session_exists_statement(session_id: &SessionId) -> WriteStatement {
    WriteStatement {
        sql: Cow::Borrowed(SESSION_EXISTS_SQL),
        bindings: StatementBindings::Named(vec![text_binding(
            "@sessionId",
            session_id.text().as_str(),
        )]),
        expected_row_count: Some(1),
    }
}
