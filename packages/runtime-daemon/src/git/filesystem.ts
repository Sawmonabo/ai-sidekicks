// The filesystem seam the git services create and remove folders through, and the real filesystem
// behind it. A snapshot's scratch-index lock and copy go to `node:fs/promises` directly.

import { mkdir, rm } from "node:fs/promises";

/**
 * Two idempotent verbs: create tolerates an existing directory, remove a missing path. The
 * worktree sweep retries removal until `cleaned_at` is stamped, and a snapshot's scratch-index
 * cleanup runs in a `finally`, where a second failure would hide the first.
 */
export interface GitFilesystem {
  createDirectory(path: string): Promise<void>;
  removePath(path: string): Promise<void>;
}

/** The real filesystem the git services use unless a test injects another. */
export const DEFAULT_GIT_FILESYSTEM: GitFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removePath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};
