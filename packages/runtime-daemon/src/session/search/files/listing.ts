// Lists a working folder's files as paths relative to it, `/`-separated: the repository's own
// view through `git ls-files` inside a git working tree, and outside one a walk of the folder
// that honors its `.gitignore`. A read that fails for a reason the system clears on its own is
// tried once more.

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { fdir } from "fdir";
import ignore, { type Ignore } from "ignore";

import type { GitCommand, GitInvocationFailure } from "../../../git/process.js";

// Errors a moment's wait clears: a busy or interrupted call, or a process or system short of file
// handles. Any other failure is the answer.
const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "EAGAIN",
  "EBUSY",
  "EINTR",
  "EMFILE",
  "ENFILE",
]);

// What git prints, in the C locale the runner sets, for a folder outside any working tree.
const OUTSIDE_WORKING_TREE_STDERR = "not a git repository";

// The repository's own folder is never a file of the working folder.
const GIT_DIRECTORY_NAME = ".git";

/** Lists `folder`'s files, retrying once a read the system may clear; throws any other failure. */
export async function listWorkingFolder(folder: string, git: GitCommand): Promise<string[]> {
  try {
    return await readWorkingFolder(folder, git);
  } catch (error) {
    if (!isRetryable(error)) {
      throw error;
    }
    return readWorkingFolder(folder, git);
  }
}

async function readWorkingFolder(folder: string, git: GitCommand): Promise<string[]> {
  let listed: Buffer;
  try {
    // Tracked files and untracked ones the repository does not ignore, each once.
    listed = (
      await git([
        "-C",
        folder,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--deduplicate",
      ])
    ).stdout;
  } catch (error) {
    if ((error as GitInvocationFailure).stderr?.includes(OUTSIDE_WORKING_TREE_STDERR) === true) {
      return walkFolder(folder);
    }
    throw error;
  }
  return listed
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

async function walkFolder(folder: string): Promise<string[]> {
  const ignored = await readIgnoreRules(folder);
  const paths = await new fdir()
    .withRelativePaths()
    .withPathSeparator("/")
    .withErrors()
    .exclude((directoryName, directoryPath) => {
      if (directoryName === GIT_DIRECTORY_NAME) {
        return true;
      }
      const relativePath = relative(folder, directoryPath).replaceAll("\\", "/");
      return relativePath.length > 0 && ignored.ignores(`${relativePath}/`);
    })
    .crawl(folder)
    .withPromise();
  return ignored.filter(paths);
}

async function readIgnoreRules(folder: string): Promise<Ignore> {
  const rules = ignore();
  try {
    rules.add(await readFile(join(folder, ".gitignore"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return rules;
}

function isRetryable(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_ERROR_CODES.has(code);
}
