// The lookups the session verbs and the sessions list share: whether a session has a directory
// row, and the project it sits in. A session's project is the project of the attached mount its
// latest workspace binds, or, before its workspace is bound (its project still cloning), the
// project its create named; a chat's managed mount is no project, and a forgotten project is none.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../../database/statement.js";

/**
 * The subquery answering the project id of the session whose id `sessionIdSql` reads (a bound
 * parameter such as `@sessionId`, or a column such as `s.id`), or NULL for a chat, a session whose
 * project was forgotten, or one not bound to a project yet.
 */
export function sessionProjectSql(sessionIdSql: string): string {
  return `(SELECT project.id FROM projects AS project
    WHERE project.id = COALESCE(
      (SELECT mount.project_id
         FROM workspaces AS workspace
         JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
        WHERE workspace.session_id = ${sessionIdSql} AND mount.origin = 'attached'
        ORDER BY workspace.created_at DESC, workspace.id DESC
        LIMIT 1),
      (SELECT request.project_id
         FROM session_create_requests AS request
        WHERE request.session_id = ${sessionIdSql})))`;
}

/** Reads a row only while the session the `@sessionId` parameter names has a directory row. */
export const SESSION_EXISTS_SQL = "SELECT 1 FROM sessions WHERE id = @sessionId";

/** Holds only while the session has a directory row. */
export function sessionExistsStatement(sessionId: SessionId): WriteStatement {
  return {
    sql: SESSION_EXISTS_SQL,
    bindings: { sessionId },
    expectedRowCount: 1,
  };
}
