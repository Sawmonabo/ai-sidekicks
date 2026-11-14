// A worktree row reads its base, ahead, behind and uncommitted figures with a zero figure absent,
// and offers removal only on a tree the app made.

import { describe, expect, it } from "vitest";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { RepoMountId } from "@ai-sidekicks/contracts/repo/mount";
import type { WorktreeId } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { readWorktreeRow } from "./worktrees.js";

const SESSION_ID = "8f1c2c3e-5c6a-4a19-9f5f-1d2b3c4d5e6f" as SessionId;
const WORKTREE_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f" as WorktreeId;

describe("the worktree popover's rows", () => {
  it("lists an app-made tree with its base, ahead, behind and uncommitted figures", () => {
    // Mutation: drawing a zero figure, or dropping the base, fails the row.
    const row = readWorktreeRow({
      madeBy: "app",
      worktreeId: WORKTREE_ID,
      repoMountId: "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b" as RepoMountId,
      baseBranchName: "main",
      state: "dirty",
      createdBySessionId: SESSION_ID,
      createdAt: "2026-11-09T15:00:00.000Z",
      updatedAt: "2026-11-09T15:00:00.000Z",
      path: "/Users/person/.ai-sidekicks/worktrees/app/8f1c2c3e-webhooks",
      name: "webhooks",
      branchName: "sidekicks/webhooks",
      ahead: 2,
      behind: 0,
      uncommittedFileCount: 3,
      unpushedCommitCount: 2,
      occupyingSessionIds: [SESSION_ID],
      runningSessionId: null,
    });
    expect(row).toMatchObject({
      name: "webhooks",
      offBase: "off main",
      ahead: "↑2",
      behind: undefined,
      uncommitted: "3 uncommitted",
      uncommittedFileCount: 3,
      unpushedCommitCount: 2,
      runningSessionId: undefined,
      removableWorktreeId: WORKTREE_ID,
    });
  });

  it("offers no removal and no base on a tree the person made", () => {
    const row = readWorktreeRow({
      madeBy: "person",
      path: "/Users/person/code/app-hotfix",
      name: "app-hotfix",
      branchName: "hotfix",
      behind: 4,
      uncommittedFileCount: 0,
      unpushedCommitCount: 0,
      occupyingSessionIds: [],
      runningSessionId: SESSION_ID,
    });
    expect(row).toMatchObject({
      offBase: undefined,
      ahead: undefined,
      behind: "↓4",
      uncommitted: undefined,
      runningSessionId: SESSION_ID,
      removableWorktreeId: undefined,
    });
  });
});
