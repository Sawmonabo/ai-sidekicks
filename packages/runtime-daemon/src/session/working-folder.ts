// A session's pending working-folder move: a move asked for while a run is live waits on the
// session's own row, never in a queue, until the run reaches a boundary. The row holds at most one,
// so a later request replaces it, and a request for the folder the session already works in
// clears it.

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionSetWorkingFolderResponse } from "@ai-sidekicks/contracts/session/directory";
import type { WorktreeId } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { WriteRefusedError, type DatabaseWriter } from "../database/writer.js";
import { SessionNotFoundError } from "../ipc/session-errors.js";

const SET_PENDING_MOVE_SQL = `UPDATE sessions
    SET pending_move = @pendingMove, pending_worktree_id = @pendingWorktreeId
  WHERE id = @sessionId`;

/** A move asked for while the session's run is live. */
export interface PendingWorkingFolderMoveRequest {
  readonly sessionId: SessionId;
  /** The worktree asked for; `null` is the project's own checkout. */
  readonly worktreeId: WorktreeId | null;
  /** The worktree the session works in now; `null` is the project's own checkout. */
  readonly currentWorktreeId: WorktreeId | null;
}

/**
 * Records the request as the session's one pending move, replacing any earlier one, and answers
 * `pending`; a request naming the folder the session works in clears the pending move and answers
 * `applied`. Throws {@link SessionNotFoundError} for a session this daemon holds no row for.
 */
export async function recordPendingWorkingFolderMove(
  writer: Pick<DatabaseWriter, "write">,
  request: PendingWorkingFolderMoveRequest,
): Promise<SessionSetWorkingFolderResponse["disposition"]> {
  const isCancel = request.worktreeId === request.currentWorktreeId;
  try {
    await writer.write([
      {
        sql: SET_PENDING_MOVE_SQL,
        bindings: {
          sessionId: request.sessionId,
          pendingMove: isCancel ? 0 : 1,
          pendingWorktreeId: isCancel ? null : request.worktreeId,
        },
        expectedRowCount: 1,
      },
    ]);
  } catch (error) {
    if (error instanceof WriteRefusedError) {
      throw new SessionNotFoundError("This daemon holds no such session.", {
        sessionId: request.sessionId,
      });
    }
    throw error;
  }
  return isCancel ? "applied" : "pending";
}
