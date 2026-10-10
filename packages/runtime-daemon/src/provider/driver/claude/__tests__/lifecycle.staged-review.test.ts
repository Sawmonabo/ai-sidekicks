// A review of the staged set runs in a temporary worktree of the session's folder that the daemon's
// git code makes on a real repository: it holds the staged changes and nothing else, it leaves the
// person's checkout and index as they were, and it is removed once the review ends, even when the
// review's turn fails.

import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildFixtureEnvironment, runFixtureGit } from "../../../../git/__fixtures__/command.js";
import { StagedChangesWorktrees } from "../../../../git/worktree/staged-changes.js";
import { TEST_SESSION_ID } from "../__fixtures__/transport-doubles.js";
import { buildHarness, createLiveSession, SANDBOXED_POSTURE } from "./lifecycle.test-support.js";

// What the review's turn found in its worktree when it was opened.
interface OpenedWorktree {
  readonly folder: string;
  readonly status: string;
  readonly trackedFile: string;
}

describe("a review of the staged set", () => {
  it("runs on the staged changes alone and removes its worktree after a failed turn", async () => {
    // Unstaged or untracked work in the review would report on changes nobody staged, and a worktree
    // left behind stays registered in the person's repository.
    const root = await realpath(await mkdtemp(join(tmpdir(), "aisk-staged-review-")));
    try {
      const environment = buildFixtureEnvironment(root);
      const repository = join(root, "repository");
      await runFixtureGit(["init", "--quiet", repository], environment, root);
      await writeFile(join(repository, "tracked.txt"), "committed\n");
      await writeFile(join(repository, "edited.txt"), "committed\n");
      await runFixtureGit(["add", "."], environment, repository);
      await runFixtureGit(["commit", "--quiet", "-m", "base"], environment, repository);
      await writeFile(join(repository, "tracked.txt"), "staged\n");
      await writeFile(join(repository, "added.txt"), "staged new file\n");
      await runFixtureGit(["add", "tracked.txt", "added.txt"], environment, repository);
      await writeFile(join(repository, "tracked.txt"), "unstaged over the staged change\n");
      await writeFile(join(repository, "edited.txt"), "unstaged\n");
      await writeFile(join(repository, "untracked.txt"), "untracked\n");
      const readPersonsWork = async (): Promise<string[]> => [
        await runFixtureGit(["status", "--porcelain"], environment, repository),
        await runFixtureGit(["diff", "--cached", "--binary"], environment, repository),
      ];
      const personsWorkBefore = await readPersonsWork();

      const worktrees = new StagedChangesWorktrees({
        worktreesDirectory: join(root, "worktrees"),
      });
      let opened: OpenedWorktree | undefined;
      const harness = buildHarness({
        stagedChanges: {
          openStagedWorktree: async (workingDirectory) => {
            const worktree = await worktrees.openStagedWorktree(workingDirectory);
            opened = {
              folder: worktree.folder,
              status: await runFixtureGit(["status", "--porcelain"], environment, worktree.folder),
              trackedFile: await readFile(join(worktree.folder, "tracked.txt"), "utf8"),
            };
            return worktree;
          },
        },
        spawnContext: {
          resolveSpawnContext: async () => {
            await Promise.resolve();
            return {
              workingDirectory: repository,
              environmentRows: undefined,
              accountFolders: undefined,
              memoryFolders: [],
              advisorModel: null,
              outputStyle: null,
            };
          },
        },
      });
      harness.transport.oneTurnFailure = new Error("the review's turn failed");
      const channel = await createLiveSession(harness, { executionPosture: SANDBOXED_POSTURE });
      channel.emitStreamFrame("system/init", {
        handshake: {
          slashCommands: [],
          skills: ["code-review"],
          terminalSlashCommands: [],
          capabilities: [],
          permissionMode: null,
          fastModeState: "off",
          fastModeDisabledReason: "sdk_opt_in_required",
        },
      });

      await harness.lifecycle.startReview({ sessionId: TEST_SESSION_ID, target: "staged" });
      // Real git runs behind it, so the wait allows for a loaded machine.
      await vi.waitFor(
        () => {
          expect(harness.sessionNotices.map((notice) => notice.kind)).toContain("review_finished");
        },
        { timeout: 10_000 },
      );

      // Staged in the index and the files, with no unstaged or untracked work beside it.
      expect(opened?.status).toBe("A  added.txt\nM  tracked.txt\n");
      expect(opened?.trackedFile).toBe("staged\n");
      expect(harness.runMoves.at(-1)?.newState).toBe("failed");
      const folder = opened?.folder ?? "";
      await expect(access(folder)).rejects.toThrow();
      expect(
        await runFixtureGit(["worktree", "list", "--porcelain"], environment, repository),
      ).not.toContain(folder);
      expect(await readPersonsWork()).toStrictEqual(personsWorkBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
