// The tree list read from the newline-separated porcelain output every supported git prints:
// records split by a blank line, and a value git quoted read back as it was recorded.

import { describe, expect, it } from "vitest";

import type { GitCommand } from "../../process.js";
import { readListedWorktrees } from "../reads.js";

// As git 2.31 prints it, with a lock reason quoted the way a newer git quotes one.
const PORCELAIN_LISTING = [
  "worktree /repository",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /trees/a tree",
  "HEAD 2222222222222222222222222222222222222222",
  "detached",
  "locked",
  "",
  "worktree /trees/unborn",
  "HEAD 0000000000000000000000000000000000000000",
  "branch refs/heads/new",
  'locked "held \\"here\\" \\303\\251"',
  "prunable gitdir file points to non-existent location",
  "",
].join("\n");

describe("readListedWorktrees", () => {
  it("reads every record of the newline-separated listing, without asking git for -z", async () => {
    const asked: (readonly string[])[] = [];
    const git: GitCommand = async (argv) => {
      asked.push(argv);
      return { stdout: Buffer.from(PORCELAIN_LISTING, "utf8"), stderr: "" };
    };

    const listed = await readListedWorktrees(git, "/repository");

    expect(asked).toEqual([
      ["--no-optional-locks", "-C", "/repository", "worktree", "list", "--porcelain"],
    ]);
    expect(listed).toEqual([
      {
        path: "/repository",
        branchName: "main",
        headCommit: "1111111111111111111111111111111111111111",
        isMainCheckout: true,
        isBare: false,
        isPrunable: false,
        isLocked: false,
        lockReason: null,
      },
      {
        path: "/trees/a tree",
        branchName: null,
        headCommit: "2222222222222222222222222222222222222222",
        isMainCheckout: false,
        isBare: false,
        isPrunable: false,
        isLocked: true,
        lockReason: null,
      },
      {
        path: "/trees/unborn",
        branchName: "new",
        headCommit: null,
        isMainCheckout: false,
        isBare: false,
        isPrunable: true,
        isLocked: true,
        lockReason: 'held "here" é',
      },
    ]);
  });
});
