/**
 * The `worktrees` row and statement shapes the worktree modules read and write, the statements more
 * than one of them writes, the predicates that say a row is live and that an agent runs in a tree,
 * and what a refused compare-and-swap on one of its transitions means. Type arguments on
 * `prepare<Bind, Result>` make query and shape drift a type error, not a cast.
 */

import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError } from "../../database/writer.js";

/** The `worktrees` columns a removal reads: the row, its mount, creator, folder, branch, state. */
export interface WorktreeRow {
  readonly id: string;
  readonly repo_mount_id: string;
  readonly created_by_session_id: string;
  readonly branch_name: string;
  readonly base_ref: string;
  readonly fs_root: string;
  readonly state: string;
}

/** An `attached` repo mount, the only kind a worktree is provisioned from, and its project. */
export interface AttachedMountRow {
  readonly id: string;
  readonly canonical_root: string;
  readonly project_id: string;
}

/** A worktree id alone, for the live-branch confirmation read. */
export interface WorktreeIdRow {
  readonly id: string;
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
  readonly base_ref: string;
  readonly fs_root: string;
  readonly now: string;
}

/** A state transition on one row. */
export interface WorktreeTransitionParams {
  readonly worktree_id: string;
  readonly now: string;
}

/**
 * The SQL condition that the `worktrees` row read as `table` is live, on disk and holding its
 * branch; spelled to match `idx_worktrees_active_branch` exactly, so "live" reads agree with it.
 */
export function liveWorktreeStatePredicate(table: string): string {
  return `${table}.state NOT IN ('retired', 'failed')`;
}

/** {@link liveWorktreeStatePredicate} for a query that reads the table by its own name. */
export const LIVE_WORKTREE_STATE_PREDICATE: string = liveWorktreeStatePredicate("worktrees");

/** `creating -> ready`, the one transition both a new tree and a put-back tree take. */
export const MARK_READY_SQL = `UPDATE worktrees
    SET state = 'ready', updated_at = @now
  WHERE id = @worktree_id AND state = 'creating'`;

// `state` is left to the column DEFAULT ('creating'); naming it would copy that fact.
const INSERT_WORKTREE_SQL = `INSERT INTO worktrees (
    id, repo_mount_id, created_by_session_id, created_by_run_id,
    branch_name, base_ref, fs_root, created_at, updated_at
  ) VALUES (
    @id, @repo_mount_id, @created_by_session_id, @created_by_run_id,
    @branch_name, @base_ref, @fs_root, @now, @now
  )`;

/** The `creating` row's insert, for a write that also appends its `worktree.created`. */
export function insertWorktreeStatement(params: InsertWorktreeParams): WriteStatement {
  return { sql: INSERT_WORKTREE_SQL, bindings: { ...params } };
}

/** A transition statement on one worktree row, guarded on its row count when one is given. */
export function transitionStatement(
  sql: string,
  params: WorktreeTransitionParams,
  expectedRowCount?: number,
): WriteStatement {
  // Spread, because an interface carries no index signature for the bindings' record.
  const bindings = { ...params };
  return expectedRowCount === undefined ? { sql, bindings } : { sql, bindings, expectedRowCount };
}

/**
 * The run contexts of the given worktree whose run has not ended, matched as stored: an agent runs
 * in the tree when its context names the tree or roots at its folder or below it, under either
 * platform's separator. The retirement's write checks this inside its transaction; a run recorded
 * under another spelling of the folder is caught before the write by the resolved-path read over
 * {@link UNRELEASED_RUNS_SQL}.
 */
export const UNRELEASED_RUN_IN_WORKTREE_SQL = `SELECT run.session_id
    FROM worktrees
    JOIN run_execution_contexts AS run
      ON run.worktree_id = worktrees.id
      OR run.execution_root = worktrees.fs_root
      OR substr(run.execution_root, 1, length(worktrees.fs_root) + 1)
         IN (worktrees.fs_root || '/', worktrees.fs_root || '\\')
   WHERE worktrees.id = @worktree_id
     AND run.released_at IS NULL
   ORDER BY run.created_at ASC
   LIMIT 1`;

/** Every run context whose run has not ended, oldest first, for a resolved-path comparison. */
export const UNRELEASED_RUNS_SQL = `SELECT session_id, worktree_id, execution_root
    FROM run_execution_contexts
   WHERE released_at IS NULL
   ORDER BY created_at ASC, run_id ASC`;

/** One run context whose run has not ended. */
export interface UnreleasedRunRow {
  readonly session_id: string;
  readonly worktree_id: string | null;
  readonly execution_root: string;
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
