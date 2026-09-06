// The one inference the two reads license, and the three the module refuses.
//
// Every case here is about a PAIR that no reply states, so the assertions are about
// what is absent as much as what is present: an unpaired root keeps its row and loses
// its subject, which is what stops a gate being asked under a guessed workspace.

import { describe, expect, it } from "vitest";

import type { RepoWorkspaceRow } from "../mounts/repo-mounts-model.js";
import type { WorktreeStatusRecord } from "../mounts/worktree-model.js";
import { workspaceRow } from "../mounts/repo-mounts.test-support.js";
import {
  MOUNTLESS_WORKTREE_COPY,
  UNPAIRED_WORKTREE_COPY,
  unpairedWorktreeCopy,
  worktreeGateRowSubjects,
} from "./worktree-gate-pairing.js";

const GIT_MOUNT = "019b7b30-0280-7c11-8420-b1a5c0de2003";
const OTHER_MOUNT = "019b7b30-0280-7c11-8420-b1a5c0de2004";

function workspace(
  id: string,
  repoMountId: string,
  executionMode: RepoWorkspaceRow["executionMode"] = "worktree",
): RepoWorkspaceRow {
  return workspaceRow({ id, repoMountId, executionMode });
}

function worktree(worktreeId: string, repoMountId: string): WorktreeStatusRecord {
  return {
    worktreeId,
    repoMountId,
    branchName: `sidekicks/${worktreeId}`,
    fsRoot: `/Users/dev/roots/${worktreeId}`,
    state: "ready",
    createdBySessionId: "019b7b30-0280-7c11-8420-b1a5c0de2001",
    createdAt: "2026-01-01T09:05:00.700Z",
    updatedAt: "2026-01-01T09:05:00.700Z",
  } as WorktreeStatusRecord;
}

describe("worktreeGateRowSubjects", () => {
  it("pairs every root of a mount that has exactly one workspace", () => {
    const rows = worktreeGateRowSubjects(
      [worktree("root-a", GIT_MOUNT), worktree("root-b", GIT_MOUNT)],
      [workspace("workspace-1", GIT_MOUNT, "branch")],
      GIT_MOUNT,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.subject).toStrictEqual({
      kind: "worktree",
      workspaceId: "workspace-1",
      // The mount an act is sent under, from the workspace row rather than the worktree
      // record: both are filtered on it, so the two are the same value and reading one
      // of them is what keeps it one fact.
      repoMountId: GIT_MOUNT,
      worktreeId: "root-a",
      // The workspace's own mode, wire-verbatim, so the gate's refusal arm names the
      // mode the row above it is showing.
      executionMode: "branch",
    });
    expect(rows[1]?.subject?.worktreeId).toBe("root-b");
  });

  it("keeps the row and drops the subject where a mount has more than one workspace", () => {
    const rows = worktreeGateRowSubjects(
      [worktree("root-a", GIT_MOUNT)],
      [workspace("workspace-1", GIT_MOUNT), workspace("workspace-2", GIT_MOUNT)],
      GIT_MOUNT,
    );
    // The root exists and is reported; only the question about it is not put.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBeUndefined();
  });

  it("names the mount the subject was paired under, never the other one", () => {
    // Without this the mount could be read off whichever row came first and every case
    // here would still pass, because the fixtures above put one mount on both sides.
    // A subject naming the wrong mount sends an act against a repository the gate was
    // never drawn for.
    const rows = worktreeGateRowSubjects(
      [worktree("root-a", GIT_MOUNT), worktree("root-b", OTHER_MOUNT)],
      [workspace("workspace-1", GIT_MOUNT), workspace("workspace-2", OTHER_MOUNT)],
      OTHER_MOUNT,
    );
    expect(rows[0]?.subject?.repoMountId).toBe(OTHER_MOUNT);
    expect(rows[0]?.subject?.worktreeId).toBe("root-b");
  });

  it("negative control: the same two workspaces on DIFFERENT mounts still pair", () => {
    // Without this, the case above would pass against a function that refused to pair
    // whenever the session held two workspaces, rather than whenever one MOUNT did.
    const rows = worktreeGateRowSubjects(
      [worktree("root-a", GIT_MOUNT)],
      [workspace("workspace-1", GIT_MOUNT), workspace("workspace-2", OTHER_MOUNT)],
      GIT_MOUNT,
    );
    expect(rows[0]?.subject?.workspaceId).toBe("workspace-1");
  });

  it("returns only the roots of the mount it was asked about", () => {
    const rows = worktreeGateRowSubjects(
      [worktree("root-a", GIT_MOUNT), worktree("root-b", OTHER_MOUNT)],
      [workspace("workspace-1", GIT_MOUNT)],
      GIT_MOUNT,
    );
    expect(rows.map((row) => row.record.worktreeId)).toStrictEqual(["root-a"]);
  });
});

describe("unpairedWorktreeCopy", () => {
  it("says which of the two absences it is", () => {
    expect(unpairedWorktreeCopy([workspace("workspace-1", GIT_MOUNT)], GIT_MOUNT)).toBe(
      UNPAIRED_WORKTREE_COPY,
    );
    expect(unpairedWorktreeCopy([], GIT_MOUNT)).toBe(MOUNTLESS_WORKTREE_COPY);
  });
});
