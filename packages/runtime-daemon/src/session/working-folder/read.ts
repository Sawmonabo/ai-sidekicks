// A session's working folder: the root of its newest workspace in a state that carries a live
// root. The `@` file search lists it and every shell of the session starts in it.

import type { Database, Statement } from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionShape } from "@ai-sidekicks/contracts/session/methods";

import { sqlListOf } from "../../database/sql-list.js";
import { PROBE_BEARING_WORKSPACE_STATES } from "../../workspace/projector.js";
import { sessionNotFound } from "../not-found.js";

const WORKING_FOLDER_SQL = `
  SELECT shape,
         (SELECT fs_root FROM workspaces
           WHERE session_id = sessions.id AND fs_root IS NOT NULL
             AND state IN (${sqlListOf(PROBE_BEARING_WORKSPACE_STATES)})
           ORDER BY created_at DESC, id DESC
           LIMIT 1) AS fs_root
    FROM sessions
   WHERE id = ?`;

/** A session's shape and its working folder, `null` while no workspace root is in place. */
export interface SessionWorkingFolder {
  readonly shape: SessionShape;
  readonly workingFolder: string | null;
}

/**
 * Prepares the read of a session's working folder on the daemon's read connection. The read throws
 * `session.not_found` for a session this daemon holds no row for.
 */
export function prepareWorkingFolderRead(
  reader: Database,
): (sessionId: SessionId) => SessionWorkingFolder {
  const select: Statement<
    [string],
    { readonly shape: SessionShape; readonly fs_root: string | null }
  > = reader.prepare(WORKING_FOLDER_SQL);
  return (sessionId) => {
    const row = select.get(sessionId);
    if (row === undefined) {
      throw sessionNotFound(sessionId);
    }
    return { shape: row.shape, workingFolder: row.fs_root };
  };
}
