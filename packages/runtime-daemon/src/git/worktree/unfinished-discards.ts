// The discards a crash cut short: kept copies whose row has no `removed_at` yet, each with the live
// tree it was moving while that tree's row is still live, for the daemon's start to finish or undo.

import type { Database } from "better-sqlite3";

import { liveWorktreeStatePredicate, type WorktreeRow } from "./rows.js";

const SELECT_UNFINISHED_SQL = `SELECT kept.id, kept.mount_id, kept.original_path, kept.kept_path,
       kept.record_folder, repo_mounts.canonical_root,
       tree.id AS worktree_id, tree.created_by_session_id, tree.branch_name, tree.base_ref,
       tree.state
  FROM removed_worktrees AS kept
  JOIN repo_mounts ON repo_mounts.id = kept.mount_id
  LEFT JOIN worktrees AS tree
    ON tree.repo_mount_id = kept.mount_id
   AND tree.fs_root = kept.original_path
   AND ${liveWorktreeStatePredicate("tree")}
 WHERE kept.removed_at IS NULL
 ORDER BY kept.id`;

interface UnfinishedRow {
  readonly id: string;
  readonly mount_id: string;
  readonly original_path: string;
  readonly kept_path: string;
  readonly record_folder: string | null;
  readonly canonical_root: string;
  readonly worktree_id: string | null;
  readonly created_by_session_id: string | null;
  readonly branch_name: string | null;
  readonly base_ref: string | null;
  readonly state: string | null;
}

/** A kept copy whose discard a crash cut short, and the tree it was moving while still live. */
export interface UnfinishedKeptWorktree {
  readonly removedWorktreeId: string;
  readonly originalPath: string;
  readonly keptFolder: string;
  readonly canonicalRoot: string;
  /**
   * Git's record of the tree as git named it, written with what the copy records just before the
   * tree moves; `null` until then.
   */
  readonly recordFolder: string | null;
  /** The tree's row as the discard read it, or `null` when no live row is at its folder. */
  readonly worktree: WorktreeRow | null;
}

/**
 * Prepares the read of every discard a crash cut short once through `reader`, and answers the
 * listing, which reads the daemon's database afresh each call.
 */
export function prepareUnfinishedDiscardListing(
  reader: Database,
): () => readonly UnfinishedKeptWorktree[] {
  const selectUnfinished = reader.prepare<[], UnfinishedRow>(SELECT_UNFINISHED_SQL);
  return () =>
    selectUnfinished.all().map((row) => ({
      removedWorktreeId: row.id,
      originalPath: row.original_path,
      keptFolder: row.kept_path,
      canonicalRoot: row.canonical_root,
      recordFolder: row.record_folder,
      worktree:
        row.worktree_id === null ||
        row.created_by_session_id === null ||
        row.branch_name === null ||
        row.base_ref === null ||
        row.state === null
          ? null
          : {
              id: row.worktree_id,
              repo_mount_id: row.mount_id,
              created_by_session_id: row.created_by_session_id,
              branch_name: row.branch_name,
              base_ref: row.base_ref,
              fs_root: row.original_path,
              state: row.state,
            },
    }));
}
