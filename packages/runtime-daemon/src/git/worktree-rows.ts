/**
 * The `worktrees` row and statement-parameter shapes the worktree service reads and writes, and
 * the compare-and-swap check its transitions run. Type arguments on `prepare<Bind, Result>` make
 * query and shape drift a type error, not a cast.
 */

/** A full `worktrees` row as the service selects it. */
export interface WorktreeRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly created_by_run_id: string | null;
  readonly branch_name: string;
  readonly fs_root: string;
  readonly state: string;
  readonly cleaned_at: string | null;
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
 * Asserts a compare-and-swap moved exactly one row. Called inside a `transactionalPrelude`, where
 * a throw aborts the transaction and the event row with it. A plain `Error`: an internal
 * consistency failure with no caller repair.
 */
export function assertSingleWorktreeRowChanged(
  result: { readonly changes: number },
  worktreeId: string,
  attemptedAction: string,
): void {
  if (result.changes !== 1) {
    throw new Error(
      `cannot ${attemptedAction} worktree "${worktreeId}": it left its expected state before ` +
        `the write committed`,
    );
  }
}
