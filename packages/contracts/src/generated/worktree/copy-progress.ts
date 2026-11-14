// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The copies across volumes a removal or a put-back makes, while they run.

import type { ProjectId } from "../project.js";
import type { RemovedWorktreeId, WorktreeId } from "./lifecycle.js";

/**
 * One copy under way, by the row it draws on: a worktree being removed, by its `repoMount.list`
 * and `worktree.status.read` id, or a kept worktree being put back, by its
 * `worktree.removed.list` id. The bytes written count the file being copied.
 */
export type WorktreeCopy =
  | {
      kind: "removing";
      /**
       * The worktree.
       */
      worktreeId: WorktreeId;
      /**
       * Its project.
       */
      projectId: ProjectId;
      /**
       * The name its row shows.
       */
      name: string;
      /**
       * Bytes written so far.
       */
      copiedBytes: number;
      /**
       * Bytes of every file it makes.
       */
      totalBytes: number;
    }
  | {
      kind: "puttingBack";
      /**
       * The kept worktree.
       */
      removedWorktreeId: RemovedWorktreeId;
      /**
       * Its project.
       */
      projectId: ProjectId;
      /**
       * The name its row shows.
       */
      name: string;
      /**
       * Bytes written so far.
       */
      copiedBytes: number;
      /**
       * Bytes of every file it makes.
       */
      totalBytes: number;
    };

/**
 * `worktree.copy.subscribe`: one project's copies under way, or every project's.
 */
export interface WorktreeCopySubscribeRequest {
  /**
   * The project; absent follows every project.
   */
  projectId?: ProjectId;
}
/**
 * One `worktree.copy.subscribe` emission: every copy under way, sent whole on each change.
 */
export interface WorktreeCopyProgress {
  /**
   * The copies.
   */
  copies: WorktreeCopy[];
}

export {
  validateWorktreeCopy,
  validateWorktreeCopyProgress,
  validateWorktreeCopySubscribeRequest,
} from "../checks/worktree/copy-progress.js";
