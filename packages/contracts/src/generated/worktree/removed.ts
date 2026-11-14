// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The copies Discard and remove keeps: listing them, putting one back and deleting one.

import type { WireInstant } from "../internal/wire-scalars.js";
import type { ProjectId } from "../project.js";
import type { GitObjectId } from "../repo/git-reads.js";
import type { RemovedWorktreeId, WorktreeId } from "./lifecycle.js";

/**
 * Why a put-back was refused; a refused put-back keeps the copy.
 */
export type WorktreeRestoreRefusal =
  | {
      reason: "projectNotAttached";
    }
  | {
      reason: "repositoryMissing";
      /**
       * Where the repository was.
       */
      path: string;
    }
  | {
      reason: "keptTreeMissing";
    };
/**
 * The `worktree.restore` result: the tree made again, or the refusal.
 */
export type WorktreeRestoreResponse =
  | {
      outcome: "restored";
      /**
       * The new worktree.
       */
      worktreeId: WorktreeId;
      /**
       * Its folder.
       */
      path: string;
      /**
       * Its branch.
       */
      branch: string;
      /**
       * Whether the branch is a new one.
       */
      onNewBranch: boolean;
    }
  | {
      outcome: "refused";
      /**
       * Why.
       */
      refusal: WorktreeRestoreRefusal;
    };

/**
 * `worktree.removed.list`: one project's kept worktrees, or every project's, plus what is left
 * of a copy put back while it is the one source to rebuild a live tree git cannot read.
 */
export interface WorktreeRemovedListRequest {
  /**
   * The project; absent lists every project's.
   */
  projectId?: ProjectId;
}
/**
 * One kept worktree. Its size is read once after the discard, so `sizeBytes` and `sizeReadAt` are
 * `null` until that read has run.
 */
export interface RemovedWorktree {
  /**
   * The kept worktree.
   */
  removedWorktreeId: RemovedWorktreeId;
  /**
   * Its project.
   */
  projectId: ProjectId;
  /**
   * The tree's name.
   */
  name: string;
  /**
   * Its branch.
   */
  branch: string;
  /**
   * The commit it stood on.
   */
  headCommit: GitObjectId;
  /**
   * When it was removed.
   */
  removedAt: WireInstant;
  /**
   * Its size in bytes, or `null`.
   */
  sizeBytes: number | null;
  /**
   * When its size was read, or `null`.
   */
  sizeReadAt: WireInstant | null;
  /**
   * The folder of the live tree put back from this copy that git cannot read, the one case a
   * copy put back is listed; `null` otherwise.
   */
  unreadablePutBackFolder: string | null;
}
/**
 * The `worktree.removed.list` result.
 */
export interface WorktreeRemovedListResponse {
  /**
   * The kept worktrees.
   */
  removedWorktrees: RemovedWorktree[];
}
/**
 * `worktree.restore` and `worktree.removed.delete`: the kept worktree to put back or
 * delete.
 */
export interface RemovedWorktreeRequest {
  /**
   * The kept worktree.
   */
  removedWorktreeId: RemovedWorktreeId;
}
