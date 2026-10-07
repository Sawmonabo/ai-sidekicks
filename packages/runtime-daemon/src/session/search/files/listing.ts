// Lists a working folder's files as paths relative to it, `/`-separated: the repository's own
// view through `git ls-files` inside a git working tree, and outside one a walk of the folder
// that honors every `.gitignore` in it as git does. A `.gitignore` that cannot be read counts as
// holding no rules, as git counts it, and is named in the service log, git's own warning inside a
// working tree. A read that fails for a reason the system clears on its own is tried once more
// after a moment.

import * as nativeFs from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import { fdir } from "fdir";
import ignore, { type Ignore } from "ignore";

import type { ServiceLogWriter } from "../../../daemon/service-log.js";
import type {
  GitCommand,
  GitInvocationFailure,
  GitInvocationResult,
} from "../../../git/process.js";

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

// A folder's rules file. Git reads it only as a regular file, never through a link or as a folder.
const IGNORE_FILE_NAME = ".gitignore";

// The one form of `readdir` the crawl calls.
type ReadFolder = (
  directoryPath: string,
  options: { readonly withFileTypes: true },
  callback: (error: NodeJS.ErrnoException | null, entries: nativeFs.Dirent[]) => void,
) => void;

/**
 * Lists `folder`'s files, retrying once a read the system may clear; throws any other failure.
 * A rules file it lists past, unread, goes to `writeServiceLog`.
 */
export async function listWorkingFolder(
  folder: string,
  git: GitCommand,
  writeServiceLog: ServiceLogWriter,
): Promise<string[]> {
  try {
    return await readWorkingFolder(folder, git, writeServiceLog);
  } catch (error) {
    if (!isRetryable(error)) {
      throw error;
    }
    await wait(RETRY_WAIT_MS);
    return readWorkingFolder(folder, git, writeServiceLog);
  }
}

async function readWorkingFolder(
  folder: string,
  git: GitCommand,
  writeServiceLog: ServiceLogWriter,
): Promise<string[]> {
  let listed: GitInvocationResult;
  try {
    // Tracked files and untracked ones the repository does not ignore, each once.
    listed = await git([
      "-C",
      folder,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--deduplicate",
    ]);
  } catch (error) {
    if ((error as GitInvocationFailure).stderr?.includes(OUTSIDE_WORKING_TREE_STDERR) === true) {
      return walkFolder(folder, writeServiceLog);
    }
    throw error;
  }
  // A listing git answered carries only warnings on stderr, such as a rules file it could not read.
  for (const line of listed.stderr.split("\n")) {
    if (line.length > 0) {
      writeServiceLog(`The file search listed ${folder} past git's ${line}`);
    }
  }
  return listed.stdout
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

// Every folder's `.gitignore` applies to the paths below it, a deeper one's rules over a
// shallower one's, and nothing under an ignored folder is listed, as in git. A folder's rules are
// read with its listing, before the crawl meets any path in it. A rules file that cannot be read
// holds no rules, as in git, and is logged; one a moment's wait may clear fails the walk, which is
// tried once more.
async function walkFolder(folder: string, writeServiceLog: ServiceLogWriter): Promise<string[]> {
  const rulesByFolder = new Map<string, Ignore>();
  const readFolder: ReadFolder = (directoryPath, options, callback) => {
    nativeFs.readdir(directoryPath, options, (readError, entries) => {
      if (readError !== null) {
        callback(readError, []);
        return;
      }
      const rulesEntry = entries.find((entry) => entry.name === IGNORE_FILE_NAME);
      const rulesPath = join(directoryPath, IGNORE_FILE_NAME);
      if (rulesEntry?.isSymbolicLink() === true) {
        // Git warns that it cannot open a rules file through a link, and reads no rules from it.
        writeServiceLog(
          `The file search listed ${folder} past ${rulesPath}, a link, which git reads no rules ` +
            "through",
        );
      }
      if (rulesEntry?.isFile() !== true) {
        callback(null, entries);
        return;
      }
      readFile(rulesPath, "utf8")
        .then((rules) => ignore().add(rules))
        .then(
          (rules) => {
            rulesByFolder.set(relativePathOf(folder, directoryPath), rules);
            callback(null, entries);
          },
          (error: unknown) => {
            if (isRetryable(error)) {
              callback(error as NodeJS.ErrnoException, []);
              return;
            }
            writeServiceLog(
              `The file search listed ${folder} past ${rulesPath}, which it could not read, ` +
                `its rules unread: ${error instanceof Error ? error.message : String(error)}`,
            );
            callback(null, entries);
          },
        );
    });
  };
  // The crawl reads folders through `fs`; only `readdir` differs, in the one form it calls.
  const paths = await new fdir({
    fs: { ...nativeFs, readdir: readFolder as typeof nativeFs.readdir },
  })
    .withRelativePaths()
    .withPathSeparator("/")
    .withErrors()
    .exclude((directoryName, directoryPath) => {
      if (directoryName === GIT_DIRECTORY_NAME) {
        return true;
      }
      return isIgnored(rulesByFolder, `${relativePathOf(folder, directoryPath)}/`);
    })
    .crawl(folder)
    .withPromise();
  return paths.filter((path) => !isIgnored(rulesByFolder, path));
}

// A folder's path below the working folder, `/`-separated, empty for the working folder itself.
function relativePathOf(folder: string, directoryPath: string): string {
  return relative(folder, directoryPath).replaceAll("\\", "/");
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
