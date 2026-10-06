/**
 * The `worktrees` row and statement-parameter shapes the worktree service reads and writes, and
 * what a refused compare-and-swap on one of its transitions means. Type arguments on
 * `prepare<Bind, Result>` make query and shape drift a type error, not a cast.
 */

import { WriteRefusedError } from "../../database/writer.js";

/** The `worktrees` columns a retirement reads: the row, its mount, its creator and its state. */
export interface WorktreeRetirementRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly state: string;
}

/** An `attached` repo mount, the only kind a worktree is provisioned from. */
export interface AttachedMountRow {
  readonly id: string;
  readonly canonical_root: string;
}

/** A worktree id alone, for the live-branch confirmation read. */
export interface WorktreeIdRow {
  readonly id: string;
}

/** A retired, uncleaned worktree and the mount root its prune runs in. */
export interface WorktreeRootRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly fs_root: string;
  /** The owning mount's root for the prune; nullable because the read LEFT-joins. */
  readonly canonical_root: string | null;
}

/** The `busy` workspace holding a worktree's root. */
export interface HoldingWorkspaceRow {
  readonly workspace_id: string;
}

/** Binds a mount id. */
export interface MountLookupParams {
  readonly repo_mount_id: string;
}

/** Binds a worktree id. */
export interface WorktreeLookupParams {
  readonly worktree_id: string;
}

/** Binds a (mount, branch) pair, the unique index's key. */
export interface BranchLookupParams {
  readonly repo_mount_id: string;
  readonly branch_name: string;
}

/** The `creating` row's insert. */
export interface InsertWorktreeParams {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
  readonly now: string;
}

/** A state transition on one row. */
export interface WorktreeTransitionParams {
  readonly worktree_id: string;
  readonly now: string;
}

/**
 * What a refused compare-and-swap on one worktree row means: the row left its expected state
 * before the write committed. Any other failure is returned unchanged. The refusal becomes a plain
 * `Error`: an internal consistency failure with no caller repair.
 */
export function explainWorktreeRowRefusal(
  failure: unknown,
  worktreeId: string,
  attemptedAction: string,
): unknown {
  if (!(failure instanceof WriteRefusedError)) {
    return failure;
  }
  return new Error(
    `cannot ${attemptedAction} worktree "${worktreeId}": it left its expected state before ` +
      `the write committed`,
    { cause: failure },
  );
}
