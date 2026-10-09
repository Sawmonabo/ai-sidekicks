// The cleanup sweep on real git: a retired tree's folder and git's own record of it go before its
// row is stamped while every other tree's record stays, a tree an agent still runs in waits, one
// holding only what its retirement recorded goes while one holding anything new is kept aside for
// the person, a mount no longer attached has its trees retired with their folders left on disk,
// and a stored folder no name plan made is never removed.

import { appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorktreeIdSchema } from "@ai-sidekicks/contracts/worktree/lifecycle";

import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { openWorktreeFixture, type WorktreeFixture } from "../__fixtures__/services.js";
import { KEPT_TREE_ENTRY } from "../kept-copy.js";
import { REMOVED_WORKTREES_FOLDER_NAME } from "../naming.js";

vi.setConfig({ testTimeout: 60_000 });

let fixture: WorktreeFixture;

beforeEach(async () => {
  fixture = await openWorktreeFixture();
});

afterEach(async () => {
  await fixture.close();
});

async function createTree(tail: string): Promise<{ worktreeId: string; fsRoot: string }> {
  return fixture.creator.create({
    repoMountId: fixture.repoMountId,
    sessionId: fixture.seedSession(),
    name: { kind: "tail", tail },
    onCollision: "refuse",
  });
}

function readCleanedAt(worktreeId: string): string | null {
  return fixture.db
    .prepare("SELECT cleaned_at FROM worktrees WHERE id = ?")
    .pluck()
    .get(worktreeId) as string | null;
}

// Marks a tree retired with an agent still running in it, as when the run started after the
// retirement was read.
function retireWithRunningAgent(worktreeId: string, fsRoot: string): void {
  fixture.db.prepare("UPDATE worktrees SET state = 'retired' WHERE id = ?").run(worktreeId);
  const sessionId = fixture.seedSession();
  const workspaceId = fixture.seedWorkspace({
    sessionId,
    executionMode: "provisioned-worktree",
    state: "ready",
    fsRoot: fixture.repository.root,
    boundRoot: fixture.repository.root,
    checkoutRoot: fixture.repository.root,
  });
  const branchContextId = mintUuidV7();
  fixture.db
    .prepare(
      `INSERT INTO branch_contexts (id, workspace_id, worktree_id, base_branch, head_branch,
         created_at, updated_at) VALUES (?, ?, ?, 'main', 'main', 'now', 'now')`,
    )
    .run(branchContextId, workspaceId, worktreeId);
  fixture.db
    .prepare(
      `INSERT INTO run_execution_contexts (run_id, session_id, workspace_id, execution_mode,
         execution_root, checkout_root, git_common_dir, worktree_id, branch_context_id, created_at)
       VALUES (?, ?, ?, 'provisioned-worktree', ?, ?, ?, ?, ?, 'now')`,
    )
    .run(mintUuidV7(), sessionId, workspaceId, fsRoot, fsRoot, fsRoot, worktreeId, branchContextId);
}

describe("the cleanup sweep", () => {
  it("removes a retired tree and git's record before stamping it, and waits on one an agent runs in", async () => {
    const removed = await createTree("removed");
    const running = await createTree("running");
    await fixture.removal.retire({
      worktreeId: WorktreeIdSchema.parse(removed.worktreeId),
      discard: false,
    });
    retireWithRunningAgent(running.worktreeId, running.fsRoot);

    const pass = await fixture.worktrees.cleanupPass(fixture.removal, new AbortController().signal);

    expect(pass.cleanedWorktreeIds).toEqual([removed.worktreeId]);
    expect(existsSync(removed.fsRoot)).toBe(false);
    expect(await fixture.repository.git(["worktree", "list", "--porcelain"])).not.toContain(
      removed.fsRoot,
    );
    expect(readCleanedAt(removed.worktreeId)).not.toBeNull();
    expect(existsSync(running.fsRoot)).toBe(true);
    expect(readCleanedAt(running.worktreeId)).toBeNull();
  });

  it("keeps every other tree's record, one whose folder is away included", async () => {
    const removed = await createTree("removed");
    // A tree the person made, its folder on a drive that is not mounted right now.
    const personTree = join(fixture.repository.fixtureRoot, "person-tree");
    await fixture.repository.git(["worktree", "add", "-q", "-b", "person", personTree]);
    renameSync(personTree, `${personTree}-away`);
    await fixture.removal.retire({
      worktreeId: WorktreeIdSchema.parse(removed.worktreeId),
      discard: false,
    });

    await fixture.worktrees.cleanupPass(fixture.removal, new AbortController().signal);

    const listed = await fixture.repository.git(["worktree", "list", "--porcelain"]);
    expect(listed).not.toContain(removed.fsRoot);
    expect(listed).toContain(personTree);
  });

  it("deletes a tree holding only what its retirement recorded, and keeps aside one holding more", async () => {
    // Setup output the repository ignores, as an install or a build writes it.
    const infoFolder = join(fixture.repository.root, ".git", "info");
    mkdirSync(infoFolder, { recursive: true });
    appendFileSync(join(infoFolder, "exclude"), "node_modules/\n");
    const setupOnly = await createTree("setup-only");
    const writtenSince = await createTree("written-since");
    for (const tree of [setupOnly, writtenSince]) {
      await fixture.repository.write(tree.fsRoot, "node_modules/left-pad/index.js", "pad\n");
      await fixture.worktrees.retireUnadopted(tree.worktreeId);
    }
    await fixture.repository.write(writtenSince.fsRoot, "notes.txt", "written after retirement\n");

    const pass = await fixture.worktrees.cleanupPass(fixture.removal, new AbortController().signal);

    expect(pass.cleanedWorktreeIds).toEqual([setupOnly.worktreeId]);
    expect(existsSync(setupOnly.fsRoot)).toBe(false);
    expect(pass.keptWorktreeIds).toEqual([writtenSince.worktreeId]);
    expect(readCleanedAt(writtenSince.worktreeId)).not.toBeNull();
    const [kept, ...others] = (await fixture.removedWorktrees.list({})).removedWorktrees;
    expect(others).toEqual([]);
    expect(kept?.name).toBe(basename(writtenSince.fsRoot));
    const keptTree = join(
      dirname(writtenSince.fsRoot),
      REMOVED_WORKTREES_FOLDER_NAME,
      `${basename(writtenSince.fsRoot)}-${kept?.removedWorktreeId ?? ""}`,
      KEPT_TREE_ENTRY,
    );
    expect(existsSync(join(keptTree, "notes.txt"))).toBe(true);
    expect(existsSync(join(keptTree, "node_modules", "left-pad", "index.js"))).toBe(true);
  });

  it("retires the trees of a mount no longer attached and leaves their folders on disk", async () => {
    // A tree with nothing to lose, so only the detach's own stamp keeps its folder.
    const tree = await createTree("detached");
    fixture.db.prepare("UPDATE repo_mounts SET state = 'detached'").run();

    const pass = await fixture.worktrees.cleanupPass(fixture.removal, new AbortController().signal);
    const nextPass = await fixture.worktrees.cleanupPass(
      fixture.removal,
      new AbortController().signal,
    );

    expect(pass.retiredWorktreeIds).toEqual([tree.worktreeId]);
    expect([...pass.cleanedWorktreeIds, ...nextPass.cleanedWorktreeIds]).toEqual([]);
    expect(existsSync(tree.fsRoot)).toBe(true);
    expect(readCleanedAt(tree.worktreeId)).not.toBeNull();
  });

  it("refuses to remove a stored folder no name plan made, the repository's own checkout included", async () => {
    const tree = await createTree("rewritten");
    fixture.db
      .prepare("UPDATE worktrees SET state = 'retired', fs_root = ? WHERE id = ?")
      .run(fixture.repository.root, tree.worktreeId);

    expect(
      await captureRejection(() =>
        fixture.worktrees.cleanupPass(fixture.removal, new AbortController().signal),
      ),
    ).toBeInstanceOf(Error);
    expect(existsSync(fixture.repository.root)).toBe(true);
    expect(readCleanedAt(tree.worktreeId)).toBeNull();
  });
});
