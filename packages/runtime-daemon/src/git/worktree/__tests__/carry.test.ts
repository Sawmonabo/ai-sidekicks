// Carrying a session's uncommitted work onto a new worktree on real git: a carry onto a base other
// than the branch the work sits on is refused before any tree is made, and a carry that fails, at
// the apply, once the tree that took the work could not be recorded, or once the session could not
// adopt it, keeps the work in a stash the refusal names.

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { WorktreeCreateFailedError } from "../errors.js";
import { openWorktreeFixture, type WorktreeFixture } from "../__fixtures__/services.js";
import { snapshotCheckout } from "../__fixtures__/repository.js";

vi.setConfig({ testTimeout: 60_000 });

let fixture: WorktreeFixture;

beforeEach(async () => {
  fixture = await openWorktreeFixture();
  // The session's uncommitted work in the repository's own checkout: a change and a new file.
  await fixture.repository.write(fixture.repository.root, "README.md", "# work in progress\n");
  await fixture.repository.write(fixture.repository.root, "notes.txt", "untracked work\n");
});

afterEach(async () => {
  await fixture.close();
});

// The refusal is `carry_failed`, names the stash's commit, and that stash holds both files.
async function expectWorkKeptInNamedStash(refusal: unknown): Promise<void> {
  expect(refusal).toBeInstanceOf(WorktreeCreateFailedError);
  expect(refusal).toMatchObject({ reason: "carry_failed" });
  const stashCommit = await fixture.repository.git(["rev-parse", "refs/stash"]);
  expect((refusal as Error).message).toContain(`git stash apply --index ${stashCommit}`);
  const stashed = (
    await fixture.repository.git([
      "stash",
      "show",
      "--include-untracked",
      "--name-only",
      stashCommit,
    ])
  ).split("\n");
  expect(stashed.sort()).toEqual(["README.md", "notes.txt"]);
}

function carry(baseRef: string) {
  return captureRejection(() =>
    fixture.creator.create({
      repoMountId: fixture.repoMountId,
      sessionId: fixture.seedSession(),
      name: { kind: "tail", tail: "carried" },
      onCollision: "refuse",
      baseRef,
      carryUncommittedFrom: fixture.repository.root,
    }),
  );
}

describe("carrying uncommitted work", () => {
  it("refuses a base other than the branch the work sits on, before any tree or stash", async () => {
    await fixture.repository.git(["branch", "other"]);
    const before = await snapshotCheckout(fixture.repository, fixture.repository.root);

    const refusal = await carry("other");

    expect(refusal).toBeInstanceOf(WorktreeCreateFailedError);
    expect(refusal).toMatchObject({ reason: "carry_base_mismatch" });
    expect(await snapshotCheckout(fixture.repository, fixture.repository.root)).toEqual(before);
    expect(await fixture.repository.git(["stash", "list"])).toBe("");
    expect(fixture.db.prepare("SELECT count(*) FROM worktrees").pluck().get()).toBe(0);
  });

  it("keeps the work in the stash it names when the new tree cannot take it", async () => {
    // The repository's own hook writes a file the stash also holds, so applying it in the new
    // tree fails.
    const hookPath = join(fixture.repository.root, ".git", "hooks", "post-checkout");
    writeFileSync(hookPath, "#!/bin/sh\necho hook > notes.txt\n");
    chmodSync(hookPath, 0o755);

    const refusal = await carry("main");

    await expectWorkKeptInNamedStash(refusal);
    // The tree the carry failed into is undone, its branch with it, and no row records it.
    expect(fixture.db.prepare("SELECT count(*) FROM worktrees").pluck().get()).toBe(0);
    expect(await fixture.repository.git(["branch", "--list", "sidekicks/*"])).toBe("");
    expect(await fixture.repository.git(["worktree", "list", "--porcelain"])).not.toContain(
      fixture.worktreesDirectory,
    );
  });
});

describe("a carry whose tree cannot be recorded", () => {
  it("keeps the stash and names the command that puts the work back", async () => {
    // Every tree takes one id, so the second tree's row collides with the first after its carry.
    const worktreeId = mintUuidV7();
    await fixture.close();
    fixture = await openWorktreeFixture({ newWorktreeId: () => worktreeId });
    await fixture.creator.create({
      repoMountId: fixture.repoMountId,
      sessionId: fixture.seedSession(),
      name: { kind: "tail", tail: "first" },
      onCollision: "refuse",
    });
    await fixture.repository.write(fixture.repository.root, "README.md", "# work in progress\n");
    await fixture.repository.write(fixture.repository.root, "notes.txt", "untracked work\n");

    const refusal = await carry("main");

    await expectWorkKeptInNamedStash(refusal);
  });
});

describe("a carry whose tree the session cannot adopt", () => {
  it("keeps the stash and names it when the branch context cannot be written", async () => {
    const root = fixture.repository.root;
    const workspaceId = fixture.seedWorkspace({
      sessionId: fixture.seedSession(),
      executionMode: "bound-root",
      state: "ready",
      fsRoot: root,
      boundRoot: root,
      checkoutRoot: root,
    });
    fixture.db.exec(
      `CREATE TRIGGER refuse_branch_context BEFORE INSERT ON branch_contexts
       BEGIN SELECT RAISE(ABORT, 'branch context refused'); END`,
    );

    const refusal = await captureRejection(() =>
      fixture.executionRoots.prepare({
        workspaceId,
        branchName: "carried",
        carryUncommitted: true,
      }),
    );

    await expectWorkKeptInNamedStash(refusal);
  });
});
