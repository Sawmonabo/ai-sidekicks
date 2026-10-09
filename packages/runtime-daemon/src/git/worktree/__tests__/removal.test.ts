// Removing a worktree on real git: a refused removal deletes nothing, a discard that the system
// cannot move aside removes nothing either, a move across volumes that cannot remove the original
// keeps both copies, and a discard a crash cut short is put right, one that cannot be blocking no
// other tree.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectIdSchema } from "@ai-sidekicks/contracts/project";
import { WorktreeIdSchema, type WorktreeId } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import {
  WorktreeRetireConflictError,
  WorktreeRetireFolderHeldError,
  WorktreeRetireIncompleteError,
} from "../errors.js";
import { DEFAULT_GIT_FILESYSTEM } from "../../filesystem.js";
import { moveWorktreeAside } from "../kept-copy.js";
import { REMOVED_WORKTREES_FOLDER_NAME } from "../naming.js";
import {
  openWorktreeFixture,
  FIXTURE_PROJECT_SLUG,
  type WorktreeFixture,
} from "../__fixtures__/services.js";
import { hashEntries, snapshotCheckout } from "../__fixtures__/repository.js";

vi.setConfig({ testTimeout: 60_000 });

let fixture: WorktreeFixture;

afterEach(async () => {
  await fixture.close();
});

async function createTree(
  sessionId: string,
  tail = "fix-login",
): Promise<{ worktreeId: WorktreeId; fsRoot: string }> {
  const created = await fixture.creator.create({
    repoMountId: fixture.repoMountId,
    sessionId,
    name: { kind: "tail", tail },
    onCollision: "refuse",
  });
  return { worktreeId: WorktreeIdSchema.parse(created.worktreeId), fsRoot: created.fsRoot };
}

function readTreeState(worktreeId: string): string | undefined {
  return (
    fixture.db.prepare("SELECT state FROM worktrees WHERE id = ?").get(worktreeId) as
      | { state: string }
      | undefined
  )?.state;
}

function countRemovedRows(): number {
  return (fixture.db.prepare("SELECT count(*) AS n FROM removed_worktrees").get() as { n: number })
    .n;
}

function keptFolders(): readonly string[] {
  const folder = join(
    fixture.worktreesDirectory,
    FIXTURE_PROJECT_SLUG,
    REMOVED_WORKTREES_FOLDER_NAME,
  );
  return existsSync(folder) ? readdirSync(folder) : [];
}

// An agent runs in the tree: a workspace rooted there, its branch context, and a run context the
// run has not released.
function seedRunningAgent(sessionId: string, worktreeId: string, fsRoot: string): void {
  const workspaceId = fixture.seedWorkspace({
    sessionId,
    executionMode: "provisioned-worktree",
    state: "ready",
    fsRoot,
    boundRoot: fixture.repository.root,
    checkoutRoot: fsRoot,
  });
  const branchContextId = mintUuidV7();
  fixture.db
    .prepare(
      `INSERT INTO branch_contexts (id, workspace_id, worktree_id, base_branch, head_branch,
         created_at, updated_at) VALUES (?, ?, ?, 'main', 'sidekicks/x', 'now', 'now')`,
    )
    .run(branchContextId, workspaceId, worktreeId);
  fixture.db
    .prepare(
      `INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, execution_mode,
         execution_root, checkout_root, git_common_dir, worktree_id, branch_context_id, created_at)
       VALUES (?, ?, ?, 'provisioned-worktree', ?, ?, ?, ?, ?, 'now')`,
    )
    .run(
      mintUuidV7(),
      sessionId,
      workspaceId,
      join(fsRoot, "src"),
      fsRoot,
      join(fixture.repository.root, ".git"),
      worktreeId,
      branchContextId,
    );
}

describe("a refused removal", () => {
  beforeEach(async () => {
    fixture = await openWorktreeFixture();
  });

  it("refuses root_busy while an agent runs in the tree, discard or not, and deletes nothing", async () => {
    const sessionId = fixture.seedSession();
    const tree = await createTree(sessionId);
    seedRunningAgent(sessionId, tree.worktreeId, tree.fsRoot);
    const before = await snapshotCheckout(fixture.repository, tree.fsRoot);

    for (const discard of [false, true]) {
      const refusal = await captureRejection(() =>
        fixture.removal.retire({ worktreeId: tree.worktreeId, discard }),
      );
      expect(refusal).toBeInstanceOf(WorktreeRetireConflictError);
      expect((refusal as WorktreeRetireConflictError).details).toMatchObject({
        reason: "root_busy",
        runningSessionId: sessionId,
      });
    }

    expect(await snapshotCheckout(fixture.repository, tree.fsRoot)).toEqual(before);
    expect(readTreeState(tree.worktreeId)).toBe("ready");
    expect(countRemovedRows()).toBe(0);
    expect(keptFolders()).toEqual([]);
    expect(fixture.endedProcessFolders).toEqual([]);
  });

  it("refuses has_changes with the current risks for an ignored file alone, and deletes nothing", async () => {
    const sessionId = fixture.seedSession();
    const tree = await createTree(sessionId);
    await fixture.repository.write(tree.fsRoot, ".env", "SECRET=1\n");
    const before = await snapshotCheckout(fixture.repository, tree.fsRoot);

    const refusal = await captureRejection(() =>
      fixture.removal.retire({ worktreeId: tree.worktreeId, discard: false }),
    );

    expect(refusal).toBeInstanceOf(WorktreeRetireConflictError);
    expect((refusal as WorktreeRetireConflictError).details).toEqual({
      worktreeId: tree.worktreeId,
      reason: "has_changes",
      risks: {
        uncommittedFileCount: 0,
        ignoredFileCount: 1,
        unpushedCommitCount: 0,
        occupyingSessionIds: [],
      },
    });
    expect(await snapshotCheckout(fixture.repository, tree.fsRoot)).toEqual(before);
    expect(readTreeState(tree.worktreeId)).toBe("ready");
    expect(fixture.endedProcessFolders).toEqual([]);
  });
});

describe("a discard the system cannot move aside", () => {
  beforeEach(async () => {
    // The system refuses the move out of a tree while a program holds a file in it open; a missing
    // source still fails as it does on disk.
    fixture = await openWorktreeFixture({
      rename: async (fromPath) => {
        if (!existsSync(fromPath)) {
          throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
        }
        throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
      },
    });
  });

  it("refuses retire_folder_held and leaves the tree, its record, its row and the repository as they were", async () => {
    const sessionId = fixture.seedSession();
    const tree = await createTree(sessionId);
    await fixture.repository.write(tree.fsRoot, "src/new.ts", "export {};\n");
    await fixture.repository.git(["add", "src/new.ts"], tree.fsRoot);
    const before = await snapshotCheckout(fixture.repository, tree.fsRoot);
    const listedBefore = await fixture.repository.git(["worktree", "list", "--porcelain"]);

    const refusal = await captureRejection(() =>
      fixture.removal.retire({ worktreeId: tree.worktreeId, discard: true }),
    );

    expect(refusal).toBeInstanceOf(WorktreeRetireFolderHeldError);
    expect(await snapshotCheckout(fixture.repository, tree.fsRoot)).toEqual(before);
    expect(await fixture.repository.git(["worktree", "list", "--porcelain"])).toBe(listedBefore);
    expect(
      await fixture.repository.git(["for-each-ref", "--format=%(refname)", "refs/sidekicks/"]),
    ).toBe("");
    expect(readTreeState(tree.worktreeId)).toBe("ready");
    expect(countRemovedRows()).toBe(0);
    expect(keptFolders()).toEqual([]);
  });
});

describe("a discard across volumes whose original cannot be removed", () => {
  let treeFolder = "";

  beforeEach(async () => {
    // The tree's folder moves to another volume, and removing the original after the copy fails.
    fixture = await openWorktreeFixture({
      rename: async (fromPath, toPath) => {
        if (fromPath === treeFolder) {
          throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
        }
        await DEFAULT_GIT_FILESYSTEM.rename(fromPath, toPath);
      },
      removePath: async (path) => {
        if (path === treeFolder) {
          throw Object.assign(new Error("i/o error"), { code: "EIO" });
        }
        await DEFAULT_GIT_FILESYSTEM.removePath(path);
      },
    });
  });

  it("keeps the complete copy and the original, lists the copy and leaves the tree live", async () => {
    const sessionId = fixture.seedSession();
    const tree = await createTree(sessionId);
    treeFolder = tree.fsRoot;
    await fixture.repository.write(tree.fsRoot, "src/new.ts", "export const kept = true;\n");
    await fixture.repository.write(tree.fsRoot, ".env", "SECRET=1\n");
    const before = await snapshotCheckout(fixture.repository, tree.fsRoot);

    const failure = await captureRejection(() =>
      fixture.removal.retire({ worktreeId: tree.worktreeId, discard: true }),
    );

    expect(failure).toBeInstanceOf(WorktreeRetireIncompleteError);
    expect(await snapshotCheckout(fixture.repository, tree.fsRoot)).toEqual(before);
    const [kept] = (await fixture.removedWorktrees.list({})).removedWorktrees;
    expect(kept).toBeDefined();
    expect((failure as WorktreeRetireIncompleteError).details).toEqual({
      worktreeId: tree.worktreeId,
      removedWorktreeId: kept?.removedWorktreeId,
    });
    const keptPath = fixture.db
      .prepare("SELECT kept_path FROM removed_worktrees WHERE id = ?")
      .pluck()
      .get(kept?.removedWorktreeId) as string;
    expect(hashEntries(join(keptPath, "worktree"))).toEqual(before.entries);
    expect(readTreeState(tree.worktreeId)).toBe("ready");
  });
});

// The discard's steps up to the move, then the crash: the tree is kept aside, no retirement is
// written. Answers the kept copy's id and folder.
async function crashAfterMove(
  worktreeId: string,
): Promise<{ removedWorktreeId: string; keptFolder: string }> {
  const row = fixture.worktrees.requireWorktree(worktreeId);
  const removedWorktreeId = mintUuidV7();
  const keptFolder = fixture.removedWorktrees.keptFolderFor(row, removedWorktreeId);
  const mount = fixture.worktrees.requireAttachedMount(row.repo_mount_id);
  await moveWorktreeAside(
    {
      runGit: fixture.runGit,
      filesystem: DEFAULT_GIT_FILESYSTEM,
      copies: fixture.copies,
    },
    {
      worktreeId: WorktreeIdSchema.parse(row.id),
      projectId: ProjectIdSchema.parse(mount.project_id),
      treeFolder: row.fs_root,
      canonicalRoot: fixture.repository.root,
      keptFolder,
      removedWorktreeId,
    },
    {
      recordPending: () =>
        fixture.removedWorktrees.recordPending({ removedWorktreeId, worktree: row, keptFolder }),
      recordState: (state) => fixture.removedWorktrees.recordKeptState(removedWorktreeId, state),
      forgetPending: () => fixture.removedWorktrees.forgetPending(removedWorktreeId),
    },
  );
  return { removedWorktreeId, keptFolder };
}

function countUnfinishedRows(): number {
  return (
    fixture.db
      .prepare("SELECT count(*) AS n FROM removed_worktrees WHERE removed_at IS NULL")
      .get() as { n: number }
  ).n;
}

describe("a discard a crash cut short", () => {
  beforeEach(async () => {
    fixture = await openWorktreeFixture();
  });

  it("is finished: the kept copy listed whole and the tree retired", async () => {
    const sessionId = fixture.seedSession();
    const tree = await createTree(sessionId);
    await fixture.repository.write(tree.fsRoot, "notes.txt", "uncommitted\n");
    const before = await snapshotCheckout(fixture.repository, tree.fsRoot);
    const { removedWorktreeId, keptFolder } = await crashAfterMove(tree.worktreeId);
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toEqual([]);

    expect(
      await fixture.removal.finishInterruptedKeptCopies(new AbortController().signal),
    ).toMatchObject({ failures: [], leftoverCopyFailures: [] });

    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toMatchObject([
      { removedWorktreeId, headCommit: before.headCommit },
    ]);
    expect(readTreeState(tree.worktreeId)).toBe("retired");
    expect(hashEntries(join(keptFolder, "worktree"))).toEqual(before.entries);
  });
});

describe("a discard a crash cut short that cannot be put right", () => {
  let heldKeptFolder = "";

  beforeEach(async () => {
    // Deleting one kept folder fails, as it does while a program holds a file in it open.
    fixture = await openWorktreeFixture({
      removePath: async (path) => {
        if (path === heldKeptFolder) {
          throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
        }
        await DEFAULT_GIT_FILESYSTEM.removePath(path);
      },
    });
  });

  it("blocks no other tree's repair or discard, refuses its own tree's removal, and is tried again", async () => {
    const sessionId = fixture.seedSession();
    // The held tree's discard was cut short before its tree moved: its row, what the copy records
    // and an empty kept folder are written, and undoing them fails.
    const held = await createTree(sessionId, "held");
    const heldBefore = await snapshotCheckout(fixture.repository, held.fsRoot);
    const heldRow = fixture.worktrees.requireWorktree(held.worktreeId);
    const heldRemovedWorktreeId = mintUuidV7();
    const heldKeptPath = fixture.removedWorktrees.keptFolderFor(heldRow, heldRemovedWorktreeId);
    heldKeptFolder = heldKeptPath;
    await fixture.removedWorktrees.recordPending({
      removedWorktreeId: heldRemovedWorktreeId,
      worktree: heldRow,
      keptFolder: heldKeptPath,
    });
    await fixture.removedWorktrees.recordKeptState(heldRemovedWorktreeId, {
      headCommit: heldBefore.headCommit,
      branch: null,
      recordFolder: await fixture.repository.git(
        ["rev-parse", "--path-format=absolute", "--git-dir"],
        held.fsRoot,
      ),
    });
    mkdirSync(heldKeptPath, { recursive: true });
    // Another tree's discard was cut short after its move.
    const moved = await createTree(sessionId, "moved");
    await fixture.repository.write(moved.fsRoot, "notes.txt", "uncommitted\n");
    const movedBefore = await snapshotCheckout(fixture.repository, moved.fsRoot);
    const movedKept = await crashAfterMove(moved.worktreeId);
    // A third tree, discarded once the repair has run.
    const other = await createTree(sessionId, "other");
    await fixture.repository.write(other.fsRoot, "notes.txt", "other work\n");
    const otherBefore = await snapshotCheckout(fixture.repository, other.fsRoot);

    const { failures } = await fixture.removal.finishInterruptedKeptCopies(
      new AbortController().signal,
    );

    expect(failures.map((entry) => entry.removedWorktreeId)).toEqual([heldRemovedWorktreeId]);
    expect(readTreeState(moved.worktreeId)).toBe("retired");
    expect(hashEntries(join(movedKept.keptFolder, "worktree"))).toEqual(movedBefore.entries);

    const otherRetired = await fixture.removal.retire({
      worktreeId: other.worktreeId,
      discard: true,
    });
    expect(readTreeState(other.worktreeId)).toBe("retired");
    const otherKeptPath = fixture.db
      .prepare("SELECT kept_path FROM removed_worktrees WHERE id = ?")
      .pluck()
      .get(otherRetired.kept?.removedWorktreeId) as string;
    expect(hashEntries(join(otherKeptPath, "worktree"))).toEqual(otherBefore.entries);

    const refusal = await captureRejection(() =>
      fixture.removal.retire({ worktreeId: held.worktreeId, discard: true }),
    );
    expect(refusal).toMatchObject({ code: "EBUSY" });
    expect(await snapshotCheckout(fixture.repository, held.fsRoot)).toEqual(heldBefore);
    expect(readTreeState(held.worktreeId)).toBe("ready");
    expect(countUnfinishedRows()).toBe(1);

    heldKeptFolder = "";
    expect(
      await fixture.removal.finishInterruptedKeptCopies(new AbortController().signal),
    ).toMatchObject({ failures: [], leftoverCopyFailures: [] });
    expect(countUnfinishedRows()).toBe(0);
    expect(existsSync(heldKeptPath)).toBe(false);
  });
});
