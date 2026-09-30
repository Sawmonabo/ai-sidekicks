// `repo-git-reads.ts`: git object names, the branch list, file reads and the
// working-folder change signal.
import { describe, expect, it } from "vitest";

import {
  GitObjectIdSchema,
  RepoBranchListResponseSchema,
  RepoFileReadRequestSchema,
  RepoFileReadResponseSchema,
  WorkingTreeChangeSchema,
} from "../repo-git-reads.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const WORKTREE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f12";
const CHECKED_AT = "2026-07-24T19:14:35.000Z";
const BLOB_ID_SHA1 = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";
const BLOB_ID_SHA256 = "a".repeat(64);

describe("GitObjectIdSchema (a git object name as git prints it)", () => {
  it("accepts a SHA-1 and a SHA-256 name and refuses anything else", () => {
    expect(GitObjectIdSchema.safeParse(BLOB_ID_SHA1).success).toBe(true);
    expect(GitObjectIdSchema.safeParse(BLOB_ID_SHA256).success).toBe(true);
    expect(GitObjectIdSchema.safeParse(BLOB_ID_SHA1.toUpperCase()).success).toBe(false);
    expect(GitObjectIdSchema.safeParse(BLOB_ID_SHA1.slice(1)).success).toBe(false);
    expect(GitObjectIdSchema.safeParse("main").success).toBe(false);
  });
});

describe("repo.branchList, repo.fileRead, repo.workingTreeSubscribe", () => {
  it("lists branches with their upstream figures and the tree holding each", () => {
    expect(
      RepoBranchListResponseSchema.safeParse({
        defaultBranch: "main",
        branches: [
          { name: "main", ahead: 0, behind: 14 },
          { name: "fix-login", ahead: 2, heldBy: { worktreeId: WORKTREE_ID, name: "fix-login" } },
          { name: "spike" },
        ],
        countsAsOf: CHECKED_AT,
      }).success,
    ).toBe(true);
    expect(
      RepoBranchListResponseSchema.safeParse({
        defaultBranch: "main",
        branches: [],
        countsAsOf: "yesterday",
      }).success,
    ).toBe(false);
  });

  it("reads a file by path, or a gap by path, blob and side together", () => {
    const read = (extra: Record<string, unknown>) =>
      RepoFileReadRequestSchema.safeParse({ sessionId: SESSION_ID, path: "src/app.ts", ...extra })
        .success;
    expect(read({})).toBe(true);
    expect(
      read({ blobId: BLOB_ID_SHA1, side: "working-tree", lines: { from: 40, count: 30 } }),
    ).toBe(true);
    expect(read({ blobId: BLOB_ID_SHA1 })).toBe(false);
    expect(read({ side: "committed" })).toBe(false);
    expect(read({ lines: { from: 0, count: 30 } })).toBe(false);
  });

  it("answers the lines, stale when the working file moved on, or binary", () => {
    expect(
      RepoFileReadResponseSchema.safeParse({
        outcome: "lines",
        path: "src/app.ts",
        lines: ["", "  return value;"],
        firstLine: 40,
        totalLines: 120,
      }).success,
    ).toBe(true);
    expect(RepoFileReadResponseSchema.safeParse({ outcome: "stale" }).success).toBe(true);
    expect(RepoFileReadResponseSchema.safeParse({ outcome: "binary" }).success).toBe(true);
    expect(
      RepoFileReadResponseSchema.safeParse({ outcome: "stale", lines: ["stale"] }).success,
    ).toBe(false);
  });

  it("marks a working-folder change with the way the daemon noticed it", () => {
    const change = { sessionId: SESSION_ID, changedAt: CHECKED_AT, mode: "slow_tick" };
    expect(WorkingTreeChangeSchema.safeParse(change).success).toBe(true);
    expect(WorkingTreeChangeSchema.safeParse({ ...change, mode: "poll" }).success).toBe(false);
  });
});
