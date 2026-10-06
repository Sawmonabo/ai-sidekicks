// The filesystem seam the snapshot service mutates through, and the real filesystem behind it.

import { mkdir, rm } from "node:fs/promises";

/**
 * The filesystem-mutation seam; both verbs are idempotent, so cleanup in a `finally` cannot turn a
 * capture failure into a second one.
 */
export interface TurnSnapshotFilesystem {
  createDirectory(path: string): Promise<void>;
  removePath(path: string): Promise<void>;
}

/** The real filesystem behind the snapshot service's filesystem seam. */
export const DEFAULT_TURN_SNAPSHOT_FILESYSTEM: TurnSnapshotFilesystem = {
  async createDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async removePath(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};
