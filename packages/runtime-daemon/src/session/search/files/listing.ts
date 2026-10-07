// Lists a working folder's files as paths relative to it, `/`-separated: the repository's own
// view through `git ls-files` inside a git working tree, and outside one a walk of the folder
// that honors every `.gitignore` in it as git does. A read that fails for a reason the system
// clears on its own is tried once more after a moment.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

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

// The moment a retried read waits, long enough for a busy call or a handle to clear.
const RETRY_WAIT_MS = 100;

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
    await wait(RETRY_WAIT_MS);
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

// Every folder's `.gitignore` applies to the paths below it, a deeper one's rules over a
// shallower one's, and nothing under an ignored folder is listed, as in git.
async function walkFolder(folder: string): Promise<string[]> {
  const rulesByFolder = new Map<string, Ignore>();
  addIgnoreRules(rulesByFolder, folder, "");
  const paths = await new fdir()
    .withRelativePaths()
    .withPathSeparator("/")
    .withErrors()
    .exclude((directoryName, directoryPath) => {
      if (directoryName === GIT_DIRECTORY_NAME) {
        return true;
      }
      const relativePath = relative(folder, directoryPath).replaceAll("\\", "/");
      if (relativePath.length === 0) {
        return false;
      }
      if (isIgnored(rulesByFolder, `${relativePath}/`)) {
        return true;
      }
      // The crawl asks before it enters a folder and waits for the answer, so the folder's own
      // rules are read here, before any path under it is met.
      addIgnoreRules(rulesByFolder, directoryPath, relativePath);
      return false;
    })
    .crawl(folder)
    .withPromise();
  return paths.filter((path) => !isIgnored(rulesByFolder, path));
}

function addIgnoreRules(
  rulesByFolder: Map<string, Ignore>,
  directoryPath: string,
  relativePath: string,
): void {
  let rules: string;
  try {
    rules = readFileSync(join(directoryPath, ".gitignore"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  rulesByFolder.set(relativePath, ignore().add(rules));
}

// Each folder from the top down that holds rules tests the path relative to itself; the last
// that ignores or re-includes it decides.
function isIgnored(rulesByFolder: ReadonlyMap<string, Ignore>, path: string): boolean {
  let isPathIgnored = false;
  let folderEnd = -1;
  do {
    const folderPath = folderEnd === -1 ? "" : path.slice(0, folderEnd);
    const rules = rulesByFolder.get(folderPath);
    if (rules !== undefined) {
      const result = rules.test(path.slice(folderEnd + 1));
      if (result.ignored) {
        isPathIgnored = true;
      } else if (result.unignored) {
        isPathIgnored = false;
      }
    }
    folderEnd = path.indexOf("/", folderEnd + 1);
  } while (folderEnd !== -1 && folderEnd < path.length - 1);
  return isPathIgnored;
}

function isRetryable(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE_ERROR_CODES.has(code);
}
