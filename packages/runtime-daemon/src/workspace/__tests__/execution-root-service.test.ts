// The execution-root service on real git: a bound checkout is bound as it stands and never
// changed, a wire prepare without a branch is refused before git runs, a move into a tree the
// person made binds it without the daemon's record, a move into the daemon's tree keeps one
// branch context per workspace, and a failed preparation parks the workspace with its cause.

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureRejection } from "../../__fixtures__/capture-failure.js";
import { WorkspaceBranchNameRequiredError } from "../../git/worktree/errors.js";
import {
  openWorktreeFixture,
  type WorktreeFixture,
} from "../../git/worktree/__fixtures__/services.js";
import { snapshotCheckout } from "../../git/worktree/__fixtures__/repository.js";
import type { GitRunner } from "../../git/process.js";
import { ExecutionRootService } from "../execution-root-service.js";
import { requireWorkspaceRow } from "../__fixtures__/rows.js";

vi.setConfig({ testTimeout: 60_000 });

let fixture: WorktreeFixture;

beforeEach(async () => {
  fixture = await openWorktreeFixture();
});

afterEach(async () => {
  await fixture.close();
});

// A tree the person made with `git worktree add`, which no row of the daemon's records.
async function addPersonTree(): Promise<string> {
  const folder = join(fixture.repository.fixtureRoot, "person-tree");
  await fixture.repository.git(["worktree", "add", "-q", "-b", "person/tree", folder]);
  return folder;
}

function seedReadyWorkspace(
  executionMode: "bound-root" | "provisioned-worktree",
  folder: string = fixture.repository.root,
): { sessionId: string; workspaceId: string } {
  const sessionId = fixture.seedSession();
  const workspaceId = fixture.seedWorkspace({
    sessionId,
    executionMode,
    state: "ready",
    fsRoot: folder,
    boundRoot: folder,
    checkoutRoot: folder,
  });
  return { sessionId, workspaceId };
}

function readContexts(workspaceId: string): readonly { worktree_id: string | null }[] {
  return fixture.db
    .prepare<
      [string],
      { worktree_id: string | null }
    >("SELECT worktree_id FROM branch_contexts WHERE workspace_id = ? ORDER BY created_at, id")
    .all(workspaceId);
}

function countWorktreeRows(): number {
  return fixture.db.prepare("SELECT count(*) FROM worktrees").pluck().get() as number;
}

describe("a bound-root prepare", () => {
  it("binds a linked worktree on its own branch and changes neither it nor the main checkout", async () => {
    const personTree = await addPersonTree();
    const sessionId = fixture.seedSession();
    const workspaceId = fixture.seedWorkspace({
      sessionId,
      executionMode: "bound-root",
      state: "preparing",
      fsRoot: null,
      boundRoot: personTree,
      checkoutRoot: personTree,
    });
    const branches = () =>
      fixture.repository.git(["for-each-ref", "--format=%(refname) %(objectname)"]);
    const before = {
      main: await snapshotCheckout(fixture.repository, fixture.repository.root),
      linked: await snapshotCheckout(fixture.repository, personTree),
      branches: await branches(),
    };

    const prepared = await fixture.executionRoots.prepare({ workspaceId });

    expect(prepared).toMatchObject({
      executionMode: "bound-root",
      executionRoot: personTree,
      branchName: "person/tree",
    });
    expect({
      main: await snapshotCheckout(fixture.repository, fixture.repository.root),
      linked: await snapshotCheckout(fixture.repository, personTree),
      branches: await branches(),
    }).toEqual(before);
    expect(countWorktreeRows()).toBe(0);
  });
});

describe("a provisioned-worktree prepare", () => {
  it("refuses branch_name_required before any git call when no branch is named", async () => {
    const { workspaceId } = seedReadyWorkspace("provisioned-worktree");
    const gitCalls: (readonly string[])[] = [];
    const countingGit: GitRunner = (argv, options) => {
      gitCalls.push(argv);
      return fixture.repository.runner(argv, options);
    };
    const executionRoots = new ExecutionRootService({
      database: fixture.scratch,
      workspaces: fixture.workspaces,
      worktrees: {
        create: (input) => fixture.creator.create(input),
        dropCarriedStash: (stash, worktreeId) =>
          fixture.creator.dropCarriedStash(stash, worktreeId),
        retireUnadopted: (worktreeId) => fixture.worktrees.retireUnadopted(worktreeId),
      },
      git: countingGit,
    });

    const refusal = await captureRejection(() => executionRoots.prepare({ workspaceId }));

    expect(refusal).toBeInstanceOf(WorkspaceBranchNameRequiredError);
    expect(gitCalls).toEqual([]);
    expect(requireWorkspaceRow(fixture.db, workspaceId).state).toBe("ready");
  });

  it("parks the workspace stale with the cause when git refuses the branch", async () => {
    const { workspaceId } = seedReadyWorkspace("provisioned-worktree");
    await fixture.repository.git(["branch", "taken"]);

    const refusal = await captureRejection(() =>
      fixture.executionRoots.prepare({ workspaceId, branchName: "taken" }),
    );

    expect(refusal).toMatchObject({ reason: "branch_name_taken" });
    const workspace = requireWorkspaceRow(fixture.db, workspaceId);
    expect(workspace.state).toBe("stale");
    expect(JSON.parse(workspace.metadata)).toMatchObject({
      lastError: expect.stringContaining("worktree.create_failed"),
    });
    expect(countWorktreeRows()).toBe(0);
  });
});

describe("a move into a tree", () => {
  it("binds a tree the person made as an existing checkout, never as one the daemon made", async () => {
    const personTree = await addPersonTree();
    const { workspaceId } = seedReadyWorkspace("bound-root");

    const moved = await fixture.executionRoots.moveToFolder({ workspaceId, folder: personTree });

    expect(moved).toMatchObject({ executionMode: "bound-root", executionRoot: personTree });
    expect(moved.worktreeId).toBeUndefined();
    expect(requireWorkspaceRow(fixture.db, workspaceId).fs_root).toBe(personTree);
    expect(countWorktreeRows()).toBe(0);
    expect(readContexts(workspaceId).at(-1)).toEqual({ worktree_id: null });
  });

  it("keeps one branch context per workspace and tree, leaving the tree's own row as it was", async () => {
    const owner = seedReadyWorkspace("provisioned-worktree");
    const tree = await fixture.executionRoots.prepare({
      workspaceId: owner.workspaceId,
      branchName: "feature/shared",
    });
    const ownerContextsBefore = fixture.db
      .prepare("SELECT * FROM branch_contexts WHERE workspace_id = ?")
      .all(owner.workspaceId);
    const mover = seedReadyWorkspace("bound-root");

    await fixture.executionRoots.moveToFolder({
      workspaceId: mover.workspaceId,
      folder: tree.executionRoot,
    });
    await fixture.executionRoots.moveToFolder({
      workspaceId: mover.workspaceId,
      folder: fixture.repository.root,
    });
    const movedBack = await fixture.executionRoots.moveToFolder({
      workspaceId: mover.workspaceId,
      folder: tree.executionRoot,
    });

    expect(movedBack).toMatchObject({
      executionMode: "provisioned-worktree",
      worktreeId: tree.worktreeId,
      branchName: "feature/shared",
    });
    expect(
      readContexts(mover.workspaceId).filter((context) => context.worktree_id === tree.worktreeId),
    ).toHaveLength(1);
    expect(
      fixture.db
        .prepare("SELECT * FROM branch_contexts WHERE workspace_id = ?")
        .all(owner.workspaceId),
    ).toEqual(ownerContextsBefore);
    expect(countWorktreeRows()).toBe(1);
  });
});
