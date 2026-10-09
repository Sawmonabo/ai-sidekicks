// The lookups the session verbs and the sessions list share: whether a session has a directory
// row, and the project it sits in. A session's project is the attached mount its latest workspace
// binds; a chat's managed mount is no project.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { WriteStatement } from "../../database/statement.js";

/**
 * The subquery answering the project of the session whose id `sessionIdSql` reads (a bound
 * parameter such as `@sessionId`, or a column such as `s.id`), or NULL for a chat or a session
 * not bound yet.
 */
export function sessionProjectSql(sessionIdSql: string): string {
  return `(SELECT workspace.repo_mount_id
     FROM workspaces AS workspace
     JOIN repo_mounts AS mount ON mount.id = workspace.repo_mount_id
    WHERE workspace.session_id = ${sessionIdSql} AND mount.origin = 'attached'
    ORDER BY workspace.created_at DESC, workspace.id DESC
    LIMIT 1)`;
}

/** Holds only while the session has a directory row. */
export function sessionExistsStatement(sessionId: SessionId): WriteStatement {
  return {
    sql: "SELECT 1 FROM sessions WHERE id = @sessionId",
    bindings: { sessionId },
    expectedRowCount: 1,
  };
}
