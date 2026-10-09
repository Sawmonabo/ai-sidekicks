// The temporary worktree a review of a folder's staged changes runs in: a detached checkout of the
// folder's `HEAD` under the daemon's worktrees folder, holding the index's staged changes
// and none of the unstaged or untracked work, removed and pruned by its `close`. The folder's own
// checkout and index are only read. One a stopped daemon left behind is removed at the next start.

import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { withCleanupFailures } from "../../cleanup-failures.js";
import { mintUuidV7 } from "../../uuid-v7.js";
import { DEFAULT_GIT_FILESYSTEM, type GitFilesystem } from "../filesystem.js";
import {
  createGitCommand,
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  readGitCommonFolder,
  runGitWithExecFile,
  type GitCommand,
  type GitRunner,
} from "../process.js";

// A dotted sibling of the project folders, which a slug never names and no sweep reads.
const STAGED_CHANGES_SEGMENT = ".staged-changes";

/** Dependencies of {@link StagedChangesWorktrees}; only the folder is required. */
export interface StagedChangesWorktreesDeps {
  /** The daemon's worktrees folder, absolute; the temporary worktrees go under it. */
  readonly worktreesDirectory: string;
  /** Git process seam; defaults to `execFile` against `git`. */
  readonly git?: GitRunner;
  /** Filesystem seam; defaults to `node:fs/promises`. */
  readonly filesystem?: GitFilesystem;
  /** Per-invocation git timeout; defaults to two minutes. */
  readonly gitCommandTimeoutMs?: number;
  /** The worktree folder's name; defaults to `mintUuidV7`. */
  readonly newWorktreeId?: () => string;
}

/** A temporary worktree holding only a folder's staged changes, removed by `close`. */
export interface StagedChangesWorktree {
  /** The worktree's folder, absolute. */
  readonly folder: string;
  /** Removes the worktree and prunes its record from the repository. */
  close(): Promise<void>;
}

/** Opens temporary worktrees of a folder's staged changes. */
export class StagedChangesWorktrees {
  readonly #worktreesFolder: string;
  readonly #runGit: GitCommand;
  readonly #filesystem: GitFilesystem;
  readonly #newWorktreeId: () => string;

  constructor(deps: StagedChangesWorktreesDeps) {
    this.#worktreesFolder = join(deps.worktreesDirectory, STAGED_CHANGES_SEGMENT);
    this.#filesystem = deps.filesystem ?? DEFAULT_GIT_FILESYSTEM;
    this.#runGit = createGitCommand({
      git: deps.git ?? runGitWithExecFile,
      timeoutMs: deps.gitCommandTimeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    this.#newWorktreeId = deps.newWorktreeId ?? mintUuidV7;
  }

  /**
   * Opens a worktree of `workingDirectory`'s repository, detached at its `HEAD`, holding exactly
   * the staged changes in its index and working files. Throws when the folder is no git working
   * tree, its `HEAD` names no commit, or git refuses a step; a worktree made before the failure is
   * removed first.
   */
  async openStagedWorktree(workingDirectory: string): Promise<StagedChangesWorktree> {
    const repositoryRoot = (
      await this.#runGit(["-C", workingDirectory, "rev-parse", "--show-toplevel"])
    ).stdout
      .toString("utf8")
      .trim();
    // The person's diff settings never shape it: fixed prefixes, no external or text-converting
    // driver, no color, so `apply` reads exactly the index's change.
    const stagedPatch = (
      await this.#runGit([
        "-C",
        repositoryRoot,
        "diff",
        "--cached",
        "--binary",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
      ])
    ).stdout;
    await this.#filesystem.createDirectory(this.#worktreesFolder);
    const folder = join(this.#worktreesFolder, this.#newWorktreeId());
    const worktree: StagedChangesWorktree = {
      folder,
      close: async () => {
        await this.#remove(repositoryRoot, folder, { isWorktreeMade: true });
      },
    };
    try {
      await this.#runGit(["-C", repositoryRoot, "worktree", "add", "--detach", folder, "HEAD"]);
      // `apply` refuses an empty patch, and with nothing staged the checkout is already the set.
      // Whitespace warnings are off: the patch is the index's own change, applied as staged.
      if (stagedPatch.length > 0) {
        await this.#runGit(["-C", folder, "apply", "--index", "--whitespace=nowarn"], {
          stdin: stagedPatch,
        });
      }
    } catch (openingFailure) {
      // Whatever step failed, a folder and a record `worktree add` left go too.
      const cleanupFailures: unknown[] = [];
      await this.#remove(repositoryRoot, folder, { isWorktreeMade: false }).catch(
        (closeFailure: unknown) => {
          cleanupFailures.push(closeFailure);
        },
      );
      throw withCleanupFailures(openingFailure, cleanupFailures, "staged worktree opening");
    }
    return worktree;
  }

  /**
   * Removes every worktree a stopped daemon left in the staged-changes folder, each from its
   * repository's records too, before any review opens one. Never throws: resolves with the
   * failures, each entry tried.
   */
  async sweepLeftWorktrees(): Promise<unknown[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#worktreesFolder);
    } catch (cause) {
      return isMissingFolder(cause) ? [] : [cause];
    }
    const failures: unknown[] = [];
    for (const entry of entries) {
      const folder = join(this.#worktreesFolder, entry);
      // Read before the folder goes, since its `.git` file is what names the repository.
      const repositoryGitFolder = await readGitCommonFolder(this.#runGit, folder).catch(
        (cause: unknown) => {
          failures.push(cause);
          return undefined;
        },
      );
      await this.#filesystem.removePath(folder).catch((cause: unknown) => {
        failures.push(cause);
      });
      if (repositoryGitFolder !== undefined) {
        await this.#runGit(["-C", repositoryGitFolder, "worktree", "prune"]).catch(
          (cause: unknown) => {
            failures.push(cause);
          },
        );
      }
    }
    return failures;
  }

  // `--force` because the worktree holds the staged changes, which git would otherwise refuse to
  // discard; a worktree whose making failed has no record git could remove by name, so its folder
  // goes and the prune drops any record. Every step runs whatever failed before it, and the first
  // failure is thrown carrying the rest.
  async #remove(
    repositoryRoot: string,
    folder: string,
    { isWorktreeMade }: { readonly isWorktreeMade: boolean },
  ): Promise<void> {
    const failures: unknown[] = [];
    const steps: ReadonlyArray<() => Promise<unknown>> = [
      ...(isWorktreeMade
        ? [
            async () =>
              await this.#runGit(["-C", repositoryRoot, "worktree", "remove", "--force", folder]),
          ]
        : []),
      async () => {
        await this.#filesystem.removePath(folder);
      },
      async () => await this.#runGit(["-C", repositoryRoot, "worktree", "prune"]),
    ];
    for (const step of steps) {
      await step().catch((cause: unknown) => {
        failures.push(cause);
      });
    }
    const [firstFailure, ...laterFailures] = failures;
    if (firstFailure !== undefined) {
      throw withCleanupFailures(firstFailure, laterFailures, "staged worktree removal");
    }
  }
}

// Whether a read failed only because the folder does not exist yet.
function isMissingFolder(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
