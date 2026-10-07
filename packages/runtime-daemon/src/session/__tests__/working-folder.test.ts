// A session's row holds at most one pending working-folder move: a later request replaces it, a
// request for the folder the session works in clears it, and an unknown session is refused. Written
// through the real writer and read back from the row.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { WorktreeId } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { openScratchDatabase, type ScratchDatabase } from "../../database/__fixtures__/scratch.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { mintSessionId, seedSessionRow } from "../groups/__fixtures__/directory-rows.js";
import { recordPendingWorkingFolderMove } from "../working-folder.js";

const CURRENT_TREE = "worktree-current" as WorktreeId;
const FIRST_TREE = "worktree-first" as WorktreeId;
const SECOND_TREE = "worktree-second" as WorktreeId;

let scratch: ScratchDatabase;
let sessionId: SessionId;

beforeEach(async () => {
  scratch = await openScratchDatabase();
  sessionId = mintSessionId();
  await seedSessionRow(scratch.writer, sessionId);
});

afterEach(async () => {
  await scratch.close();
});

function pendingMove(): { pending_move: number; pending_worktree_id: string | null } | undefined {
  return scratch.reader
    .prepare("SELECT pending_move, pending_worktree_id FROM sessions WHERE id = ?")
    .get(sessionId) as { pending_move: number; pending_worktree_id: string | null } | undefined;
}

describe("a session's pending working-folder move", () => {
  it("is replaced by a later request, the project's checkout included", async () => {
    const move = (worktreeId: WorktreeId | null) =>
      recordPendingWorkingFolderMove(scratch.writer, {
        sessionId,
        worktreeId,
        currentWorktreeId: CURRENT_TREE,
      });

    expect(await move(FIRST_TREE)).toBe("pending");
    expect(pendingMove()).toEqual({ pending_move: 1, pending_worktree_id: FIRST_TREE });
    expect(await move(SECOND_TREE)).toBe("pending");
    expect(pendingMove()).toEqual({ pending_move: 1, pending_worktree_id: SECOND_TREE });
    expect(await move(null)).toBe("pending");
    expect(pendingMove()).toEqual({ pending_move: 1, pending_worktree_id: null });
  });

  it("is cleared by a request naming the folder the session works in", async () => {
    await recordPendingWorkingFolderMove(scratch.writer, {
      sessionId,
      worktreeId: FIRST_TREE,
      currentWorktreeId: null,
    });

    const disposition = await recordPendingWorkingFolderMove(scratch.writer, {
      sessionId,
      worktreeId: null,
      currentWorktreeId: null,
    });

    expect(disposition).toBe("applied");
    expect(pendingMove()).toEqual({ pending_move: 0, pending_worktree_id: null });
  });

  it("refuses a session the daemon holds no row for", async () => {
    const unknownSessionId = mintSessionId();

    await expect(
      recordPendingWorkingFolderMove(scratch.writer, {
        sessionId: unknownSessionId,
        worktreeId: FIRST_TREE,
        currentWorktreeId: null,
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});
