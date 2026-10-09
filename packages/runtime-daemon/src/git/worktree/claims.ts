// What live trees and put-backs under way hold in a repository: the folders live worktree rows
// stand at, the records put-backs are making and the branches either is on. A kept copy's stale
// record removal and a put-back's undo read them, so neither takes another tree's record or branch.
// A branch is claimed only in its own repository, known by its git common folder: another
// repository's branch of the same name is another branch.

import * as nodePath from "node:path";

import type { Database } from "better-sqlite3";

import { COMMON_DIR_METADATA_PATH } from "../../workspace/row-guards.js";
import { componentsEqual, toComparableComponents } from "../../workspace/trust-envelope.js";
import { commonFolderOfRecord } from "./reads.js";
import { LIVE_WORKTREE_STATE_PREDICATE } from "./rows.js";

const SELECT_LIVE_TREE_AT_FOLDER_SQL = `SELECT 1 FROM worktrees
  WHERE fs_root = @fs_root AND ${LIVE_WORKTREE_STATE_PREDICATE} LIMIT 1`;

const SELECT_RESTORING_RECORDS_SQL = `SELECT restoring_record FROM removed_worktrees
  WHERE restoring_record IS NOT NULL`;

// The common folder of each live tree's mount on the branch, `NULL` for a mount that records none.
const SELECT_LIVE_TREE_COMMON_FOLDERS_ON_BRANCH_SQL = `SELECT
    json_extract(mount.metadata, '${COMMON_DIR_METADATA_PATH}') AS common_dir
  FROM worktrees JOIN repo_mounts AS mount ON mount.id = worktrees.repo_mount_id
  WHERE worktrees.branch_name = @branch AND ${LIVE_WORKTREE_STATE_PREDICATE}`;

const SELECT_OTHER_RESTORING_RECORDS_ON_BRANCH_SQL = `SELECT restoring_record FROM removed_worktrees
  WHERE restoring_branch = @branch AND restoring_record <> @record_folder`;

/**
 * Reads of what live trees and put-backs under way hold, so a kept copy never removes another
 * tree's record or branch.
 */
export interface KeptCopyClaims {
  /** Whether a live worktree row has its folder at `folder`, as stored. */
  isLiveTreeAt(folder: string): boolean;
  /** The records the put-backs under way are making, as their marks name them. */
  listRestoringRecords(): readonly string[];
  /**
   * Whether, in the repository whose git common folder is `commonFolder`, a live worktree row is on
   * `branch` or a put-back other than the one making `recordFolder` is making it.
   */
  isBranchClaimed(branch: string, commonFolder: string, recordFolder: string): boolean;
}

/** The claims, each read afresh from the daemon's database through `reader` when asked. */
export function prepareKeptCopyClaims(reader: Database): KeptCopyClaims {
  const selectLiveTreeAtFolder = reader.prepare<{ fs_root: string }, unknown>(
    SELECT_LIVE_TREE_AT_FOLDER_SQL,
  );
  const selectRestoringRecords = reader.prepare<[], string>(SELECT_RESTORING_RECORDS_SQL).pluck();
  const selectLiveTreeCommonFolders = reader
    .prepare<{ branch: string }, string | null>(SELECT_LIVE_TREE_COMMON_FOLDERS_ON_BRANCH_SQL)
    .pluck();
  const selectOtherRestoringRecords = reader
    .prepare<
      { branch: string; record_folder: string },
      string
    >(SELECT_OTHER_RESTORING_RECORDS_ON_BRANCH_SQL)
    .pluck();
  return {
    isLiveTreeAt: (folder) => selectLiveTreeAtFolder.get({ fs_root: folder }) !== undefined,
    listRestoringRecords: () => selectRestoringRecords.all(),
    isBranchClaimed: (branch, commonFolder, recordFolder) => {
      const repository = toComparableComponents(commonFolder, nodePath);
      // A live tree whose mount records no common folder may be in this repository, so it claims.
      const isThisRepository = (claimCommonFolder: string | null): boolean =>
        claimCommonFolder === null ||
        componentsEqual(toComparableComponents(claimCommonFolder, nodePath), repository);
      return (
        selectLiveTreeCommonFolders.all({ branch }).some(isThisRepository) ||
        selectOtherRestoringRecords
          .all({ branch, record_folder: recordFolder })
          .map(commonFolderOfRecord)
          .some(isThisRepository)
      );
    },
  };
}
