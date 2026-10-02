/** The worktree service's filesystem seam and the real filesystem behind it. */

import { mkdir, rm } from "node:fs/promises";

/**
 * Two idempotent verbs: create tolerates an existing directory, remove a missing one. The sweep
 * retries removal until `cleaned_at` is stamped, so the tolerance is load-bearing.
 */
export interface WorktreeFilesystem {
  createDirectory(path: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
}

/** The real filesystem the worktree service uses unless a test injects another. */
export const DEFAULT_WORKTREE_FILESYSTEM: WorktreeFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};
