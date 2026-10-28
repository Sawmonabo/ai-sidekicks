//! The reads of the project records. A session's project is the project of the attached mount its
//! latest workspace binds, or, before its workspace is bound (its project still cloning), the
//! project its create named; a chat's managed mount is no project, and a forgotten project is none.

use crate::schema::MountOrigin;

/// The subquery answering the project id of the session whose id `session_id_sql` reads (a bound
/// parameter such as `@sessionId`, or a column such as `s.id`), or NULL for a chat, a session whose
/// project was forgotten, or one not bound to a project yet.
pub fn session_project_sql(session_id_sql: &str) -> String {
    let attached = <&'static str>::from(MountOrigin::Attached);
    format!(
        "(SELECT project.id FROM projects AS project
    WHERE project.id = COALESCE(
      (SELECT mount.project_id
         FROM workspaces AS workspace
         JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
        WHERE workspace.session_id = {session_id_sql} AND mount.origin = '{attached}'
        ORDER BY workspace.created_at DESC, workspace.id DESC
        LIMIT 1),
      (SELECT request.project_id
         FROM session_create_requests AS request
        WHERE request.session_id = {session_id_sql})))"
    )
}
