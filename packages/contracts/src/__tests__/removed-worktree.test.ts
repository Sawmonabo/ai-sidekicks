// `removed-worktree.ts`: the kept copies a discard leaves, and putting one back.
import { describe, expect, it } from "vitest";

import {
  RemovedWorktreeListResponseSchema,
  WorktreeRestoreResponseSchema,
} from "../removed-worktree.js";

const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const PROJECT_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f20";
const REMOVED_WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f22";
const HEAD_COMMIT = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";
const REMOVED_AT = "2026-07-26T09:30:00.000Z";

describe("repo.removedWorktreeList and repo.worktreeRestore", () => {
  const removed = (headCommit: string) => ({
    removedWorktrees: [
      {
        removedWorktreeId: REMOVED_WORKTREE_ID,
        projectId: PROJECT_ID,
        name: "fix-login",
        branch: "sidekicks/fix-login",
        headCommit,
        removedAt: REMOVED_AT,
        sizeBytes: null,
        sizeReadAt: null,
      },
    ],
  });

  it("lists a kept copy by the commit it was at, and refuses a name that is not a commit", () => {
    expect(RemovedWorktreeListResponseSchema.safeParse(removed(HEAD_COMMIT)).success).toBe(true);
    expect(RemovedWorktreeListResponseSchema.safeParse(removed("main")).success).toBe(false);
  });

  it("restores to a path and says when the branch had to be renamed", () => {
    expect(
      WorktreeRestoreResponseSchema.safeParse({
        worktreeId: WORKTREE_ID,
        path: "/Users/dev/.ai-sidekicks/worktrees/beacon/fix-login",
        branch: "sidekicks/fix-login-restored",
        onNewBranch: true,
      }).success,
    ).toBe(true);
  });
});
