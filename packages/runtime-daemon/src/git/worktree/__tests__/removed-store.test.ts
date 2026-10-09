// A discarded worktree kept whole and put back on real git: after the repository's own garbage
// collection the tree returns with every entry, its staged set, its ignored files, its sparse
// rules, its own config and its HEAD as they were, on its own branch even with its old record left
// behind, a record another tree took under that name is left alone, and a copy of it a crash left
// set aside goes back under that name while it is free, goes as a duplicate once the same tree's
// record has it, and stays while another tree's has it; a branch of the same name another
// repository's live tree is on leaves the tree on its own; a branch that moved since returns as
// `<branch>-restored`, and a taken name takes the next number; a refused put-back keeps the copy,
// and so does one whose record write fails or that a crash cuts short at any step, and a crash
// after the answer leaves the kept copy for the repair to delete once the tree put back stands
// sound or its row is retired, listed only while git cannot read that tree; one across volumes
// whose kept copy cannot be removed afterwards still succeeds, what is left hidden while that tree
// is sound, rebuilt from while git cannot read it, and deleted by the repair once that tree is
// gone; what is left after one on a single volume refuses as its files are gone; a `Delete now`
// that fails part way leaves no tree that reads as whole.

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RemovedWorktreeIdSchema,
  WorktreeIdSchema,
  type RemovedWorktreeId,
  type WorktreeId,
} from "@ai-sidekicks/contracts/worktree/lifecycle";

import { captureRejection } from "../../../__fixtures__/capture-failure.js";
import { KeyedLock } from "../../../keyed-lock.js";
import { mintUuidV7 } from "../../../uuid-v7.js";
import { attachedMountRowStatements } from "../../../workspace/__fixtures__/rows.js";
import { DEFAULT_GIT_FILESYSTEM } from "../../filesystem.js";
import { RemovedWorktreeNotFoundError } from "../errors.js";
import { KEPT_TREE_ENTRY } from "../kept-copy.js";
import { RemovedWorktreeStore } from "../removed-store.js";
import { openWorktreeFixture, type WorktreeFixture } from "../__fixtures__/services.js";
import {
  hashEntries,
  snapshotCheckout,
  type CheckoutSnapshot,
} from "../__fixtures__/repository.js";

vi.setConfig({ testTimeout: 60_000 });

let fixture: WorktreeFixture;

beforeEach(async () => {
  fixture = await openWorktreeFixture();
});

afterEach(async () => {
  await fixture.close();
});

interface Tree {
  readonly worktreeId: WorktreeId;
  readonly fsRoot: string;
  readonly branchName: string;
}

async function createTree(): Promise<Tree> {
  const created = await fixture.creator.create({
    repoMountId: fixture.repoMountId,
    sessionId: fixture.seedSession("Fix login"),
    name: { kind: "tail", tail: "fix-login" },
    onCollision: "refuse",
  });
  return {
    worktreeId: WorktreeIdSchema.parse(created.worktreeId),
    fsRoot: created.fsRoot,
    branchName: created.branchName,
  };
}

async function discard(tree: Tree): Promise<RemovedWorktreeId> {
  const retired = await fixture.removal.retire({ worktreeId: tree.worktreeId, discard: true });
  if (retired.kept === undefined) {
    throw new Error("expected the discard to keep the tree");
  }
  // The one size read walks the kept folder; a put-back must not move it from under the walk.
  await fixture.removedWorktrees.settle();
  return RemovedWorktreeIdSchema.parse(retired.kept.removedWorktreeId);
}

function readPinRefs(): Promise<string> {
  return fixture.repository.git(["for-each-ref", "--format=%(refname)", "refs/sidekicks/"]);
}

/** Everything a put-back must return: the checkout, its own config and its sparse rules. */
async function readTreeState(
  tree: Tree,
): Promise<CheckoutSnapshot & { worktreeConfig: string; sparseRules: string }> {
  return {
    ...(await snapshotCheckout(fixture.repository, tree.fsRoot)),
    worktreeConfig: await fixture.repository.git(
      ["config", "--worktree", "--get", "fixture.marker"],
      tree.fsRoot,
    ),
    sparseRules: await fixture.repository.git(["sparse-checkout", "list"], tree.fsRoot),
  };
}

describe("a discard and its put-back", () => {
  it("returns the tree identical after the repository's garbage collection", async () => {
    await fixture.repository.write(fixture.repository.root, "docs/guide.md", "# guide\n");
    await fixture.repository.git(["add", "docs/guide.md"]);
    await fixture.repository.git(["commit", "-q", "-m", "add docs"]);
    const tree = await createTree();
    // A sparse checkout and a value in the tree's own config, both kept in git's record of it.
    await fixture.repository.git(
      ["sparse-checkout", "set", "--no-cone", "/*", "!/docs/"],
      tree.fsRoot,
    );
    await fixture.repository.git(["config", "--worktree", "fixture.marker", "kept"], tree.fsRoot);
    // A staged blob no commit holds, which garbage collection deletes once nothing names it.
    await fixture.repository.write(tree.fsRoot, "src/new.ts", "export const staged = true;\n");
    await fixture.repository.git(["add", "src/new.ts"], tree.fsRoot);
    await fixture.repository.write(tree.fsRoot, "README.md", "# changed, not staged\n");
    await fixture.repository.write(tree.fsRoot, "notes.txt", "untracked\n");
    await fixture.repository.write(tree.fsRoot, ".env", "SECRET=1\n");
    const before = await readTreeState(tree);
    const recordFolder = await fixture.repository.git(
      ["rev-parse", "--path-format=absolute", "--git-dir"],
      tree.fsRoot,
    );
    const recordAside = join(fixture.repository.fixtureRoot, "record-aside");
    cpSync(recordFolder, recordAside, { recursive: true });

    const removedWorktreeId = await discard(tree);
    expect(existsSync(tree.fsRoot)).toBe(false);
    await fixture.repository.git(["gc", "-q", "--prune=now"]);
    // Removing git's record failed once the copy was listed, so the record stays behind, still
    // holding the tree's branch and naming its old folder.
    cpSync(recordAside, recordFolder, { recursive: true });

    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toMatchObject([
      {
        removedWorktreeId,
        branch: tree.branchName,
        headCommit: before.headCommit,
        sizeBytes: expect.any(Number),
        sizeReadAt: expect.any(String),
      },
    ]);
    const restored = await fixture.removedWorktrees.restore(removedWorktreeId);

    expect(restored).toMatchObject({
      outcome: "restored",
      path: tree.fsRoot,
      branch: tree.branchName,
      onNewBranch: false,
    });
    expect(await readTreeState(tree)).toEqual(before);
    expect(readdirSync(join(fixture.repository.root, ".git", "worktrees"))).toEqual([
      basename(recordFolder),
    ]);
    // The kept copy is deleted once the put-back has answered.
    await fixture.removedWorktrees.settle();
    expect(await readPinRefs()).toBe("");
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toEqual([]);
    expect(
      fixture.db
        .prepare("SELECT state, fs_root, branch_name FROM worktrees WHERE id = ?")
        .get(restored.outcome === "restored" ? restored.worktreeId : ""),
    ).toEqual({ state: "ready", fs_root: tree.fsRoot, branch_name: tree.branchName });

    // Discarded again, and a tree of the same folder name elsewhere, locked on a drive that is
    // then taken away, takes the record's name the kept tree still names: that record is the
    // other tree's, so no stale check removes it.
    if (restored.outcome !== "restored") {
      throw new Error("expected the tree put back");
    }
    const keptAgainId = await discard({ ...tree, worktreeId: restored.worktreeId });
    const drive = join(fixture.repository.fixtureRoot, "drive");
    const driveTree = join(drive, basename(tree.fsRoot));
    await fixture.repository.git(["worktree", "add", "-q", "-b", "on-drive", driveTree]);
    // A removal of that record a crash cut short left it set aside, and a third tree of the same
    // folder name took the free name since: the kept copy's look leaves the copy set aside.
    const readDriveRecord = (): Promise<string> =>
      fixture.repository.git(["rev-parse", "--absolute-git-dir"], driveTree);
    const driveRecord = await readDriveRecord();
    const asideFolders = [mintUuidV7(), mintUuidV7()].map((id) => `${recordFolder}.removing-${id}`);
    renameSync(recordFolder, asideFolders[0]!);
    const otherTree = join(fixture.repository.fixtureRoot, "other", basename(tree.fsRoot));
    await fixture.repository.git(["worktree", "add", "-q", "--detach", otherTree]);
    const serviceLogLines: string[] = [];
    // Each store looks at a kept copy's record once, so every look takes a new one.
    const lookAtStaleRecord = (): Promise<void> =>
      new RemovedWorktreeStore({
        database: fixture.scratch,
        copies: fixture.copies,
        runGit: fixture.runGit,
        filesystem: DEFAULT_GIT_FILESYSTEM,
        worktrees: fixture.worktrees,
        worktreesDirectory: fixture.worktreesDirectory,
        keptCopyLock: new KeyedLock<string>(),
        writeServiceLog: (line) => {
          serviceLogLines.push(line);
        },
      }).removeStaleRecordOf(keptAgainId);
    await lookAtStaleRecord();
    expect(existsSync(asideFolders[0]!)).toBe(true);
    expect(serviceLogLines).toHaveLength(1);
    // Once that tree is gone, two copies set aside: the look puts one back under the free name,
    // and removes the other, a duplicate git would list holding the branch.
    await fixture.repository.git(["worktree", "remove", otherTree]);
    cpSync(asideFolders[0]!, asideFolders[1]!, { recursive: true });
    await lookAtStaleRecord();
    expect(await readDriveRecord()).toBe(driveRecord);
    expect(asideFolders.filter((asideFolder) => existsSync(asideFolder))).toEqual([]);
    expect(serviceLogLines).toHaveLength(1);
    await fixture.repository.git(["worktree", "lock", "--reason", "on a drive", driveTree]);
    renameSync(drive, `${drive}-away`);
    await fixture.removal.finishInterruptedKeptCopies(new AbortController().signal);
    expect(existsSync(recordFolder)).toBe(true);
  });

  it("puts a tree back on its own branch while another repository's live tree has its name", async () => {
    const tree = await createTree();
    const removedWorktreeId = await discard(tree);
    // Another repository attached on this machine, with a live tree on a branch of the same name.
    const otherMountId = mintUuidV7();
    const otherRoot = join(fixture.repository.fixtureRoot, "other-repository");
    for (const statement of attachedMountRowStatements({
      id: otherMountId,
      canonicalRoot: otherRoot,
      commonDir: join(otherRoot, ".git"),
    })) {
      fixture.db.prepare(statement.sql).run(statement.bindings ?? {});
    }
    const now = new Date().toISOString();
    fixture.db
      .prepare(
        `INSERT INTO worktrees (id, repo_mount_id, created_by_session_id, branch_name, base_ref,
           fs_root, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'main', ?, 'ready', ?, ?)`,
      )
      .run(
        mintUuidV7(),
        otherMountId,
        fixture.seedSession(),
        tree.branchName,
        join(fixture.repository.fixtureRoot, "other-tree"),
        now,
        now,
      );

    expect(await fixture.removedWorktrees.restore(removedWorktreeId)).toMatchObject({
      outcome: "restored",
      path: tree.fsRoot,
      branch: tree.branchName,
      onNewBranch: false,
    });
  });

  it("puts a tree whose branch moved since back on <branch>-restored, at the kept commit", async () => {
    const tree = await createTree();
    const keptCommit = await fixture.repository.git(["rev-parse", "HEAD"], tree.fsRoot);
    const removedWorktreeId = await discard(tree);
    await fixture.repository.write(fixture.repository.root, "later.txt", "later\n");
    await fixture.repository.git(["add", "later.txt"]);
    await fixture.repository.git(["commit", "-q", "-m", "later"]);
    await fixture.repository.git(["branch", "-f", tree.branchName, "main"]);
    const movedCommit = await fixture.repository.git(["rev-parse", tree.branchName]);

    const restored = await fixture.removedWorktrees.restore(removedWorktreeId);

    expect(restored).toMatchObject({
      outcome: "restored",
      branch: `${tree.branchName}-restored`,
      onNewBranch: true,
    });
    expect(await fixture.repository.git(["symbolic-ref", "HEAD"], tree.fsRoot)).toBe(
      `refs/heads/${tree.branchName}-restored`,
    );
    expect(await fixture.repository.git(["rev-parse", "HEAD"], tree.fsRoot)).toBe(keptCommit);
    expect(await fixture.repository.git(["rev-parse", tree.branchName])).toBe(movedCommit);
  });

  it("keeps the copy, its pins and its row when the put-back is refused, until Delete now", async () => {
    const tree = await createTree();
    const removedWorktreeId = await discard(tree);
    const keptFolder = fixture.db
      .prepare("SELECT kept_path FROM removed_worktrees WHERE id = ?")
      .pluck()
      .get(removedWorktreeId) as string;
    const pinsBefore = await readPinRefs();
    const setMountState = (state: string): void => {
      fixture.db
        .prepare("UPDATE repo_mounts SET state = ? WHERE id = ?")
        .run(state, fixture.repoMountId);
    };
    setMountState("detached");

    const refused = await fixture.removedWorktrees.restore(removedWorktreeId);

    expect(refused).toEqual({ outcome: "refused", refusal: { reason: "project_not_attached" } });
    expect(existsSync(keptFolder)).toBe(true);
    expect(pinsBefore).not.toBe("");
    expect(await readPinRefs()).toBe(pinsBefore);
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toHaveLength(1);
    setMountState("attached");

    // A `Delete now` whose pins stay and whose folder goes only in part leaves no tree that reads
    // as whole, and a second one finishes it.
    const partlyDeletingStore = new RemovedWorktreeStore({
      database: fixture.scratch,
      copies: fixture.copies,
      runGit: (argv, options) =>
        argv.includes("update-ref")
          ? Promise.reject(new Error("cannot lock ref"))
          : fixture.runGit(argv, options),
      filesystem: {
        rename: DEFAULT_GIT_FILESYSTEM.rename,
        removePath: async (path) => {
          if (path !== keptFolder) {
            await DEFAULT_GIT_FILESYSTEM.removePath(path);
            return;
          }
          // Part of the tree goes, under whichever name it has, before the removal fails.
          for (const entry of readdirSync(keptFolder)) {
            if (entry.startsWith(KEPT_TREE_ENTRY)) {
              await DEFAULT_GIT_FILESYSTEM.removePath(join(keptFolder, entry, "README.md"));
            }
          }
          throw Object.assign(new Error("i/o error"), { code: "EIO" });
        },
      },
      worktrees: fixture.worktrees,
      worktreesDirectory: fixture.worktreesDirectory,
      keptCopyLock: new KeyedLock<string>(),
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
    });
    await captureRejection(() => partlyDeletingStore.delete(removedWorktreeId));
    expect(await fixture.removedWorktrees.restore(removedWorktreeId)).toEqual({
      outcome: "refused",
      refusal: { reason: "kept_tree_missing" },
    });

    await fixture.removedWorktrees.delete(removedWorktreeId);

    expect(existsSync(keptFolder)).toBe(false);
  });
});

describe("a put-back whose names are taken", () => {
  it("takes the next number free for both the folder and the new branch", async () => {
    const tree = await createTree();
    const removedWorktreeId = await discard(tree);
    // The branch moves on, and the tree's folder and its first numbered folder are taken.
    await fixture.repository.write(fixture.repository.root, "later.txt", "later\n");
    await fixture.repository.git(["add", "later.txt"]);
    await fixture.repository.git(["commit", "-q", "-m", "later"]);
    await fixture.repository.git(["branch", "-f", tree.branchName, "main"]);
    mkdirSync(tree.fsRoot, { recursive: true });
    mkdirSync(`${tree.fsRoot}-restored`, { recursive: true });

    const restored = await fixture.removedWorktrees.restore(removedWorktreeId);

    expect(restored).toMatchObject({
      outcome: "restored",
      path: `${tree.fsRoot}-restored-2`,
      branch: `${tree.branchName}-restored-2`,
      onNewBranch: true,
    });
    expect(
      await fixture.repository.git(["symbolic-ref", "HEAD"], `${tree.fsRoot}-restored-2`),
    ).toBe(`refs/heads/${tree.branchName}-restored-2`);
  });
});

describe("a put-back whose record write fails once the tree is back", () => {
  it("keeps none of the record and undoes every step, so a second put-back succeeds", async () => {
    const tree = await createTree();
    await fixture.repository.write(tree.fsRoot, "src/new.ts", "export const staged = true;\n");
    await fixture.repository.git(["add", "src/new.ts"], tree.fsRoot);
    const before = await snapshotCheckout(fixture.repository, tree.fsRoot);
    const removedWorktreeId = await discard(tree);
    // The branch moves on, so the put-back makes `<branch>-restored`.
    await fixture.repository.write(fixture.repository.root, "later.txt", "later\n");
    await fixture.repository.git(["add", "later.txt"]);
    await fixture.repository.git(["commit", "-q", "-m", "later"]);
    await fixture.repository.git(["branch", "-f", tree.branchName, "main"]);
    const pinsBefore = await readPinRefs();
    const recordsBefore = readdirSync(join(fixture.repository.root, ".git", "worktrees"));
    // The tree's record write fails at its last row, `worktree.ready`, as on a full disk, after
    // every git and folder step ran.
    fixture.db.exec(`CREATE TRIGGER fail_ready_event BEFORE INSERT ON session_events
      WHEN NEW.type = 'worktree.ready' BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);

    const restoreFailure = await captureRejection(() =>
      fixture.removedWorktrees.restore(removedWorktreeId),
    );
    expect(restoreFailure).toBeInstanceOf(Error);

    fixture.db.exec("DROP TRIGGER fail_ready_event");
    expect(
      fixture.db
        .prepare("SELECT count(*) FROM worktrees WHERE fs_root = ? AND state <> 'retired'")
        .pluck()
        .get(tree.fsRoot),
    ).toBe(0);
    expect(existsSync(tree.fsRoot)).toBe(false);
    expect(await readPinRefs()).toBe(pinsBefore);
    expect(readdirSync(join(fixture.repository.root, ".git", "worktrees"))).toEqual(recordsBefore);
    expect(await fixture.repository.git(["branch", "--list", `${tree.branchName}-restored`])).toBe(
      "",
    );
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toHaveLength(1);
    const restored = await fixture.removedWorktrees.restore(removedWorktreeId);
    expect(restored).toMatchObject({ outcome: "restored", onNewBranch: true });
    expect(await snapshotCheckout(fixture.repository, tree.fsRoot)).toEqual({
      ...before,
      headRef: `refs/heads/${tree.branchName}-restored`,
    });
  });
});

describe("a put-back a crash cut short", () => {
  it("is undone by the next repair whatever steps ran, so a later put-back returns the tree whole", async () => {
    const tree = await createTree();
    await fixture.repository.write(tree.fsRoot, "src/new.ts", "export const staged = true;\n");
    await fixture.repository.git(["add", "src/new.ts"], tree.fsRoot);
    await fixture.repository.write(tree.fsRoot, "notes.txt", "untracked\n");
    const before = await snapshotCheckout(fixture.repository, tree.fsRoot);
    const removedWorktreeId = await discard(tree);
    const keptTree = join(
      fixture.db
        .prepare("SELECT kept_path FROM removed_worktrees WHERE id = ?")
        .pluck()
        .get(removedWorktreeId) as string,
      KEPT_TREE_ENTRY,
    );
    // The branch moves on, so the put-back makes `<branch>-restored`.
    await fixture.repository.write(fixture.repository.root, "later.txt", "later\n");
    await fixture.repository.git(["add", "later.txt"]);
    await fixture.repository.git(["commit", "-q", "-m", "later"]);
    await fixture.repository.git(["branch", "-f", tree.branchName, "main"]);
    const recordsBefore = readdirSync(join(fixture.repository.root, ".git", "worktrees"));
    // The daemon dies while it records the put-back tree: every step before ran, none after does.
    const isRecording = Promise.withResolvers<void>();
    const crashingStore = new RemovedWorktreeStore({
      database: fixture.scratch,
      copies: fixture.copies,
      runGit: fixture.runGit,
      filesystem: DEFAULT_GIT_FILESYSTEM,
      worktrees: {
        recordRestoredWorktree: () => {
          isRecording.resolve();
          return new Promise<string>(() => {});
        },
      },
      worktreesDirectory: fixture.worktreesDirectory,
      keptCopyLock: new KeyedLock<string>(),
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
    });
    void crashingStore.restore(removedWorktreeId);
    await isRecording.promise;
    expect(existsSync(keptTree)).toBe(false);

    const repair = await fixture.removal.finishInterruptedKeptCopies(new AbortController().signal);

    expect(repair).toMatchObject({
      repairedRemovedWorktreeIds: [removedWorktreeId],
      failures: [],
      leftoverCopyFailures: [],
    });
    expect(hashEntries(keptTree)).toEqual(before.entries);
    expect(existsSync(tree.fsRoot)).toBe(false);
    expect(readdirSync(join(fixture.repository.root, ".git", "worktrees"))).toEqual(recordsBefore);
    expect(await fixture.repository.git(["branch", "--list", `${tree.branchName}-restored`])).toBe(
      "",
    );

    // The daemon dies while the tree's rename hangs, once the steps beside it wrote the record and
    // made the branch.
    const recordFolder = join(fixture.repository.root, ".git", "worktrees", basename(tree.fsRoot));
    const hangingStore = new RemovedWorktreeStore({
      database: fixture.scratch,
      copies: fixture.copies,
      runGit: fixture.runGit,
      filesystem: {
        rename: (fromPath, toPath) =>
          fromPath === keptTree
            ? new Promise<void>(() => {})
            : DEFAULT_GIT_FILESYSTEM.rename(fromPath, toPath),
        removePath: DEFAULT_GIT_FILESYSTEM.removePath,
      },
      worktrees: fixture.worktrees,
      worktreesDirectory: fixture.worktreesDirectory,
      keptCopyLock: new KeyedLock<string>(),
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
    });
    void hangingStore.restore(removedWorktreeId);
    const restoredBranch = `${tree.branchName}-restored`;
    await vi.waitFor(
      async () => {
        expect(readFileSync(join(recordFolder, "gitdir"), "utf8")).toBe(
          `${join(tree.fsRoot, ".git")}\n`,
        );
        expect(existsSync(join(recordFolder, "commondir"))).toBe(true);
        expect(readFileSync(join(recordFolder, "HEAD"), "utf8")).toBe(
          `ref: refs/heads/${restoredBranch}\n`,
        );
        expect(await fixture.repository.git(["branch", "--list", restoredBranch])).not.toBe("");
      },
      { timeout: 10_000 },
    );

    expect(
      await fixture.removal.finishInterruptedKeptCopies(new AbortController().signal),
    ).toMatchObject({ repairedRemovedWorktreeIds: [removedWorktreeId], failures: [] });
    expect(hashEntries(keptTree)).toEqual(before.entries);
    expect(readdirSync(join(fixture.repository.root, ".git", "worktrees"))).toEqual(recordsBefore);
    expect(await fixture.repository.git(["branch", "--list", restoredBranch])).toBe("");

    // The daemon dies once the put-back has answered, before the kept copy's deletion runs.
    const keptFolder = dirname(keptTree);
    let markPinDeleteReached = (): void => {};
    const pinDeleteReached = new Promise<void>((resolve) => {
      markPinDeleteReached = resolve;
    });
    const answeringStore = new RemovedWorktreeStore({
      database: fixture.scratch,
      copies: fixture.copies,
      runGit: (argv, options) => {
        if (!argv.includes("update-ref")) {
          return fixture.runGit(argv, options);
        }
        markPinDeleteReached();
        return new Promise<never>(() => {});
      },
      filesystem: {
        rename: DEFAULT_GIT_FILESYSTEM.rename,
        removePath: (path) =>
          path === keptFolder
            ? new Promise<void>(() => {})
            : DEFAULT_GIT_FILESYSTEM.removePath(path),
      },
      worktrees: fixture.worktrees,
      worktreesDirectory: fixture.worktreesDirectory,
      keptCopyLock: new KeyedLock<string>(),
      writeServiceLog: (line) => {
        throw new Error(`unexpected service log line: ${line}`);
      },
    });
    const restored = await answeringStore.restore(removedWorktreeId);
    expect(restored).toMatchObject({ outcome: "restored", path: tree.fsRoot, onNewBranch: true });
    expect(await snapshotCheckout(fixture.repository, tree.fsRoot)).toEqual({
      ...before,
      headRef: `refs/heads/${tree.branchName}-restored`,
    });

    // The deletion after the answer has passed its check of the tree and hangs at the pins.
    await pinDeleteReached;

    // While the tree put back is live and names no record, its kept copy stays.
    const gitFile = join(tree.fsRoot, ".git");
    renameSync(gitFile, `${gitFile}-aside`);
    expect(
      await fixture.removal.finishInterruptedKeptCopies(new AbortController().signal),
    ).toMatchObject({ failures: [{ removedWorktreeId }] });
    expect(existsSync(keptFolder)).toBe(true);
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toMatchObject([
      { removedWorktreeId, unreadablePutBackFolder: tree.fsRoot },
    ]);
    // Once that tree has gone through its own removal, its row retired, the kept copy goes.
    fixture.db
      .prepare("UPDATE worktrees SET state = 'retired' WHERE id = ?")
      .run(restored.outcome === "restored" ? restored.worktreeId : "");

    expect(
      await fixture.removal.finishInterruptedKeptCopies(new AbortController().signal),
    ).toMatchObject({ repairedRemovedWorktreeIds: [], failures: [] });
    expect(existsSync(keptFolder)).toBe(false);
    expect(await readPinRefs()).toBe("");
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toEqual([]);
  });
});

// The kept folder of a discarded tree.
function readKeptFolder(removedWorktreeId: RemovedWorktreeId): string {
  return fixture.db
    .prepare("SELECT kept_path FROM removed_worktrees WHERE id = ?")
    .pluck()
    .get(removedWorktreeId) as string;
}

// A store whose put-back of the kept tree to the tree's own folder copies across volumes when
// `isCrossVolume`, and in which a file in the kept copy is held open, so the cleanup after the
// answer fails before it deletes anything and what is left of the copy stays.
function openHeldCopyStore(
  tree: Tree,
  keptFolder: string,
  isCrossVolume: boolean,
  serviceLogLines: string[],
): RemovedWorktreeStore {
  const keptTree = join(keptFolder, KEPT_TREE_ENTRY);
  const heldFile = (): Error =>
    Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
  return new RemovedWorktreeStore({
    database: fixture.scratch,
    copies: fixture.copies,
    runGit: fixture.runGit,
    filesystem: {
      rename: async (fromPath, toPath) => {
        if (fromPath === keptTree && toPath === tree.fsRoot && isCrossVolume) {
          throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
        }
        if (fromPath === keptTree && toPath !== tree.fsRoot) {
          throw heldFile();
        }
        await DEFAULT_GIT_FILESYSTEM.rename(fromPath, toPath);
      },
      removePath: async (path) => {
        if (path === keptFolder || path.startsWith(`${keptFolder}${sep}`)) {
          throw heldFile();
        }
        await DEFAULT_GIT_FILESYSTEM.removePath(path);
      },
    },
    worktrees: fixture.worktrees,
    worktreesDirectory: fixture.worktreesDirectory,
    keptCopyLock: new KeyedLock<string>(),
    writeServiceLog: (line) => {
      serviceLogLines.push(line);
    },
  });
}

describe("a put-back across volumes whose kept copy cannot be removed afterwards", () => {
  it("leaves the tree restored and what is left hidden, for the repair to delete once that tree is gone", async () => {
    const tree = await createTree();
    await fixture.repository.write(tree.fsRoot, "src/new.ts", "export const staged = true;\n");
    await fixture.repository.git(["add", "src/new.ts"], tree.fsRoot);
    await fixture.repository.write(tree.fsRoot, "notes.txt", "untracked\n");
    const before = await snapshotCheckout(fixture.repository, tree.fsRoot);
    const removedWorktreeId = await discard(tree);
    const keptFolder = readKeptFolder(removedWorktreeId);
    const serviceLogLines: string[] = [];
    const crossVolumeStore = openHeldCopyStore(tree, keptFolder, true, serviceLogLines);

    const restored = await crossVolumeStore.restore(removedWorktreeId);
    await crossVolumeStore.settle();

    expect(restored).toMatchObject({
      outcome: "restored",
      path: tree.fsRoot,
      branch: tree.branchName,
      onNewBranch: false,
    });
    expect(await snapshotCheckout(fixture.repository, tree.fsRoot)).toEqual(before);
    if (restored.outcome !== "restored") {
      throw new Error("expected the tree put back");
    }
    expect(
      fixture.db
        .prepare("SELECT state, fs_root FROM worktrees WHERE id = ?")
        .get(restored.worktreeId),
    ).toEqual({ state: "ready", fs_root: tree.fsRoot });
    expect(serviceLogLines).toEqual([expect.stringContaining(removedWorktreeId)]);
    // The tree put back is live and sound, so what is left of the copy is hidden: not listed, and
    // not found by a second put-back.
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toEqual([]);
    expect(
      await captureRejection(() => fixture.removedWorktrees.restore(removedWorktreeId)),
    ).toBeInstanceOf(RemovedWorktreeNotFoundError);

    // Once the tree put back has gone through its own removal, nothing lists or puts back what is
    // left, and the repair deletes it.
    await fixture.repository.git(["worktree", "remove", "--force", tree.fsRoot]);
    fixture.db
      .prepare("UPDATE worktrees SET state = 'retired', cleaned_at = ? WHERE id = ?")
      .run(new Date().toISOString(), restored.worktreeId);
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toEqual([]);
    expect(
      await captureRejection(() => fixture.removedWorktrees.restore(removedWorktreeId)),
    ).toBeInstanceOf(RemovedWorktreeNotFoundError);

    expect(
      await fixture.removal.finishInterruptedKeptCopies(new AbortController().signal),
    ).toMatchObject({ failures: [] });

    expect(existsSync(keptFolder)).toBe(false);
    expect(await readPinRefs()).toBe("");
    expect(
      fixture.db
        .prepare("SELECT count(*) FROM removed_worktrees WHERE id = ?")
        .pluck()
        .get(removedWorktreeId),
    ).toBe(0);
  });
});

describe("what is left of a copy whose tree put back git cannot read", () => {
  it("is put back again from its files while they are whole, the copy then following the new tree", async () => {
    const tree = await createTree();
    const removedWorktreeId = await discard(tree);
    const keptFolder = readKeptFolder(removedWorktreeId);
    const crossVolumeStore = openHeldCopyStore(tree, keptFolder, true, []);
    const first = await crossVolumeStore.restore(removedWorktreeId);
    await crossVolumeStore.settle();
    if (first.outcome !== "restored") {
      throw new Error("expected the tree put back");
    }
    renameSync(join(tree.fsRoot, ".git"), join(tree.fsRoot, ".git-aside"));
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toMatchObject([
      { removedWorktreeId, unreadablePutBackFolder: tree.fsRoot },
    ]);

    const rebuilt = await fixture.removedWorktrees.restore(removedWorktreeId);

    expect(rebuilt).toMatchObject({ outcome: "restored", path: `${tree.fsRoot}-restored` });
    // The unreadable tree stays for the person to remove, while the copy, linked to the sound new
    // tree, is deleted after the answer.
    expect(
      fixture.db.prepare("SELECT state FROM worktrees WHERE id = ?").pluck().get(first.worktreeId),
    ).toBe("ready");
    await fixture.removedWorktrees.settle();
    expect(existsSync(keptFolder)).toBe(false);
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toEqual([]);
  });

  it("refuses as its files are gone once they went into that tree on one volume", async () => {
    const tree = await createTree();
    const removedWorktreeId = await discard(tree);
    const keptFolder = readKeptFolder(removedWorktreeId);
    const oneVolumeStore = openHeldCopyStore(tree, keptFolder, false, []);
    expect(await oneVolumeStore.restore(removedWorktreeId)).toMatchObject({ outcome: "restored" });
    await oneVolumeStore.settle();
    renameSync(join(tree.fsRoot, ".git"), join(tree.fsRoot, ".git-aside"));
    expect((await fixture.removedWorktrees.list({})).removedWorktrees).toMatchObject([
      { removedWorktreeId, unreadablePutBackFolder: tree.fsRoot },
    ]);

    expect(await fixture.removedWorktrees.restore(removedWorktreeId)).toEqual({
      outcome: "refused",
      refusal: { reason: "kept_tree_missing" },
    });
    expect(existsSync(keptFolder)).toBe(true);
  });
});
