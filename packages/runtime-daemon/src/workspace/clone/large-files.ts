// Git LFS for a clone: whether it is installed, the filter settings a clone runs with so large
// files arrive whole without the person's global git config being written, and whether a
// repository keeps files in it.

import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { readGitExitStatus, type GitCommand } from "../../git/process.js";

/**
 * The four filter settings `git lfs install` writes, passed to the clone as `-c` options so its
 * checkout fetches large files; the clone's own config gets them from `git lfs install --local`.
 */
export const LARGE_FILES_CLONE_OPTIONS: readonly string[] = [
  "-c",
  "filter.lfs.required=true",
  "-c",
  "filter.lfs.clean=git-lfs clean -- %f",
  "-c",
  "filter.lfs.smudge=git-lfs smudge -- %f",
  "-c",
  "filter.lfs.process=git-lfs filter-process",
];

// A `.gitattributes` line that sends files through Git LFS.
const LARGE_FILES_ATTRIBUTE = /\bfilter=lfs\b/;

/**
 * Whether Git LFS is installed: `git lfs version` runs. A git that refuses the command means no;
 * a git that could not run at all is thrown.
 */
export async function isLargeFilesInstalled(git: GitCommand): Promise<boolean> {
  try {
    await git(["lfs", "version"]);
    return true;
  } catch (error) {
    if (readGitExitStatus(error) !== null) return false;
    throw error;
  }
}

/**
 * Whether the repository at `root` keeps files in Git LFS, read from its top `.gitattributes`. A
 * missing file means no; any other read failure is thrown.
 */
export async function keepsLargeFiles(root: string): Promise<boolean> {
  try {
    return LARGE_FILES_ATTRIBUTE.test(await readFile(path.join(root, ".gitattributes"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
