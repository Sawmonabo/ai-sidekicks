// Carrying a session's uncommitted work onto a new tree: stashed in the folder the session works
// in, untracked files included, applied on the new tree with its staged set, and dropped only once
// the session has adopted the new tree. Until then every failure keeps the stash and names the
// command that recovers it.

import { withCleanupFailures } from "../../cleanup-failures.js";
import type { GitCommand } from "../process.js";
import { WorktreeCreateFailedError } from "./errors.js";
import { readCurrentBranch } from "./reads.js";

const CARRY_STASH_MESSAGE = "uncommitted work carried to a new worktree";
const LOCAL_BRANCH_PREFIX = "refs/heads/";

/** The stash a carry made, by its commit and the folder it was pushed in, kept until adoption. */
export interface CarriedStash {
  readonly commit: string;
  readonly folder: string;
}

/**
 * Refuses the carry unless `baseRef` is the branch `folder` is on: the work was made against that
 * branch, so only a tree cut from it takes the work as it stands. Runs before any tree is made.
 */
export async function requireCarryOntoCurrentBranch(
  runGit: GitCommand,
  folder: string,
  baseRef: string,
): Promise<void> {
  let currentBranch: string | null;
  try {
    currentBranch = await readCurrentBranch(runGit, folder);
  } catch (gitFailure) {
    throw new WorktreeCreateFailedError("git_invocation_failed", gitFailure);
  }
  const baseBranch = baseRef.startsWith(LOCAL_BRANCH_PREFIX)
    ? baseRef.slice(LOCAL_BRANCH_PREFIX.length)
    : baseRef;
  // A detached HEAD is on no branch, so no base matches it.
  if (currentBranch === null || currentBranch !== baseBranch) {
    throw new WorktreeCreateFailedError("carry_base_mismatch");
  }
}

/**
 * Stashes `fromFolder`'s uncommitted work, untracked files included, and applies it on `toFolder`
 * with its staged set; the stash is kept. Nothing to carry is no stash and `null`. The stash is
 * found by a message naming `worktreeId`, so another stash pushed in the same repository at the
 * same moment is never taken for it. Throws `carry_failed`, whose message names the command that
 * recovers the kept stash, when a push that saved still fails, the stash cannot be found again or
 * the apply fails; the caller undoes the new tree.
 */
export async function carryUncommittedWork(
  runGit: GitCommand,
  fromFolder: string,
  toFolder: string,
  worktreeId: string,
): Promise<CarriedStash | null> {
  const message = `${CARRY_STASH_MESSAGE} (${worktreeId})`;
  const isCarryStash = (entry: StashEntry): boolean => entry.subject.endsWith(`: ${message}`);
  try {
    await runGit(["-C", fromFolder, "stash", "push", "--include-untracked", "--message", message]);
  } catch (gitFailure) {
    // A push can save the stash and still fail after, so a stash it left is named.
    let leftStash: StashEntry | null;
    try {
      leftStash = await findStash(runGit, fromFolder, isCarryStash);
    } catch (lookupFailure) {
      throw withCleanupFailures(
        new WorktreeCreateFailedError("git_invocation_failed", gitFailure),
        [lookupFailure],
        "carrying the uncommitted work",
      );
    }
    throw leftStash === null
      ? new WorktreeCreateFailedError("git_invocation_failed", gitFailure)
      : keptStashError(leftStash, gitFailure);
  }
  let stash: StashEntry | null;
  try {
    stash = await findStash(runGit, fromFolder, isCarryStash);
  } catch (lookupFailure) {
    // The push took the work out of the folder, so the person is told which stash holds it.
    throw keptStashError({ message }, lookupFailure);
  }
  if (stash === null) {
    return null;
  }
  try {
    await runGit(["-C", toFolder, "stash", "apply", "--index", stash.commit]);
  } catch (applyFailure) {
    throw keptStashError(stash, applyFailure);
  }
  return { commit: stash.commit, folder: fromFolder };
}

/**
 * The failure of a step after the carry's stash was pushed, carrying `failure` as its cause:
 * `carry_failed`, its message naming the kept stash by its commit, or by its message when the
 * commit could not be read, and how to put it back.
 */
export function keptStashError(
  stash: { readonly commit: string } | { readonly message: string },
  failure: unknown,
): WorktreeCreateFailedError {
  const recovery =
    "commit" in stash
      ? `\`git stash apply --index ${stash.commit}\` in the session's folder puts it back`
      : `\`git stash list\` in the session's folder shows it as "${stash.message}", and ` +
        "`git stash apply --index` with that entry's `stash@{n}` puts it back";
  return new WorktreeCreateFailedError(
    "carry_failed",
    "carrying the uncommitted work to the new worktree failed; the work is kept in a stash, " +
      `and ${recovery}`,
    failure,
  );
}

/** Drops the carry's stash, wherever another stash has pushed it in the list; throws on failure. */
export async function dropCarriedStash(runGit: GitCommand, stash: CarriedStash): Promise<void> {
  const entry = await findStash(runGit, stash.folder, (listed) => listed.commit === stash.commit);
  if (entry !== null) {
    await runGit(["-C", stash.folder, "stash", "drop", entry.selector]);
  }
}

interface StashEntry {
  readonly commit: string;
  /** `stash@{n}`, its place in the list now. */
  readonly selector: string;
  /** The reflog subject, `On <branch>: <message>`. */
  readonly subject: string;
}

// The first stash entry `matches` accepts, or `null`; a repository with no stash has none.
async function findStash(
  runGit: GitCommand,
  folder: string,
  matches: (entry: StashEntry) => boolean,
): Promise<StashEntry | null> {
  let listing: string;
  try {
    const result = await runGit([
      "--no-optional-locks",
      "-C",
      folder,
      "stash",
      "list",
      "-z",
      "--format=%H%x00%gd%x00%gs",
    ]);
    listing = result.stdout.toString("utf8");
  } catch (gitFailure) {
    throw new WorktreeCreateFailedError("git_invocation_failed", gitFailure);
  }
  const fields = listing.split("\0");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const entry: StashEntry = {
      commit: (fields[index] ?? "").trim(),
      selector: fields[index + 1] ?? "",
      subject: fields[index + 2] ?? "",
    };
    if (matches(entry)) {
      return entry;
    }
  }
  return null;
}
