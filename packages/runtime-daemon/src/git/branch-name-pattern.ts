// The check a branch-name pattern passes before it is saved, for the machine's `Branch names` and a
// project's own pattern alike: `{title}` exactly once, then git's own branch-name rule over the
// name the pattern fills in. `check-ref-format --branch` needs no repository; the filled name
// always holds the title, so it is never the bare `@{-N}` that git would expand to an earlier
// branch.

import {
  branchPatternPlaceholderRefusal,
  fillBranchNamePattern,
  type BranchNamePatternValues,
  type BranchPatternRefusalReason,
} from "@ai-sidekicks/contracts/machine-settings";

import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  readGitExitStatus,
  runGitWithExecFile,
  type GitRunner,
} from "./git-process.js";

// What a pattern is filled with at save, before any session exists: a short id's shape (8 hex
// characters) and a tail's (lowercase letters), so git judges the parts the person typed.
const SAMPLE_PATTERN_VALUES: BranchNamePatternValues = { title: "title", session: "0123abcd" };

// Git's exit status for a name its rule refuses.
const GIT_REFUSED_EXIT_STATUS = 128;

/**
 * Why `pattern` cannot be saved, or `null` when it can. Throws when git could not be run, which is
 * never read as a refusal.
 */
export async function findBranchPatternRefusal(
  pattern: string,
  git: GitRunner = runGitWithExecFile,
): Promise<BranchPatternRefusalReason | null> {
  const placeholderRefusal = branchPatternPlaceholderRefusal(pattern);
  if (placeholderRefusal !== null) {
    return placeholderRefusal;
  }
  const branchName = fillBranchNamePattern(pattern, SAMPLE_PATTERN_VALUES);
  // A leading `-` would reach git as an option rather than a name.
  if (branchName.startsWith("-")) {
    return "not_a_branch_name";
  }
  try {
    await git(["check-ref-format", "--branch", branchName], {
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
  } catch (refusal) {
    if (readGitExitStatus(refusal) === GIT_REFUSED_EXIT_STATUS) {
      return "not_a_branch_name";
    }
    throw refusal;
  }
  return null;
}
