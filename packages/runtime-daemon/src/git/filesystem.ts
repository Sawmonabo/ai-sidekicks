// The filesystem seam the git services create, move and remove folders through, and the real
// filesystem behind it; the reads the git services make of what may be missing; and the flush
// that makes what was written survive a power loss. A snapshot's scratch-index lock and copy, and
// a kept worktree's record and object copies, go to `node:fs/promises` directly.

import type { Dirent, Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";

import { withCleanupFailures } from "../cleanup-failures.js";
import { CAN_FLUSH_FOLDER, flushPath } from "../disk-flush.js";
import { mapWithProcessorBound } from "../processor-bound.js";

/**
 * Create tolerates an existing directory and remove a missing path: the worktree sweep retries
 * removal until `cleaned_at` is stamped, and a snapshot's scratch-index cleanup runs in a
 * `finally`, where a second failure would hide the first. `rename` is the system's own, so a
 * refusal (a file held open on Windows, a move across volumes) arrives with its `code`.
 */
export interface GitFilesystem {
  createDirectory(path: string): Promise<void>;
  removePath(path: string): Promise<void>;
  rename(fromPath: string, toPath: string): Promise<void>;
}

/** The real filesystem the git services use unless a test injects another. */
export const DEFAULT_GIT_FILESYSTEM: GitFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removePath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
  async rename(fromPath: string, toPath: string): Promise<void> {
    await rename(fromPath, toPath);
  },
};

/** Whether anything is at `path`; any failure but a missing entry is thrown. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (statFailure) {
    if ((statFailure as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw statFailure;
  }
}

/**
 * The entry at `path` itself, a link's own and not its target's, or `undefined` when nothing is
 * there; any other failure is thrown.
 */
export async function lstatOptional(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (statFailure) {
    if ((statFailure as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw statFailure;
  }
}

/** A file's text, or `undefined` when it does not exist; any other failure is thrown. */
export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (readFailure) {
    if ((readFailure as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw readFailure;
  }
}

/** The entries directly in `folder`, or none when it is missing; any other failure is thrown. */
export async function readdirOptional(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch (readFailure) {
    if ((readFailure as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw readFailure;
  }
}

/** The names of the folders directly in `folder`, or none when it is missing. */
export async function readFolderNamesOptional(folder: string): Promise<string[]> {
  return (await readdirOptional(folder))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * Flushes each of `files` and `folders` to disk, one per processor at a time, so what was written
 * there survives a power loss. Every flush settles first; then the first failure is thrown with
 * the rest attached to its `cause`.
 */
export async function flushToDisk(
  files: Iterable<string>,
  folders: Iterable<string>,
): Promise<void> {
  // Folders are left out where they cannot be flushed, so on Windows only files are.
  const paths = [...new Set(files), ...(CAN_FLUSH_FOLDER ? new Set(folders) : [])];
  const failures: unknown[] = [];
  await mapWithProcessorBound(paths, async (path) => {
    try {
      await flushPath(path);
    } catch (flushFailure) {
      failures.push(flushFailure);
    }
  });
  if (failures.length > 0) {
    throw withCleanupFailures(failures[0], failures.slice(1), "flushing to disk");
  }
}
