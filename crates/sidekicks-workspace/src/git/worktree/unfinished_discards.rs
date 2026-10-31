//! The discards a crash cut short: kept copies whose row has no `removed_at` yet, each with the
//! live tree it was moving while that tree's row is still live, for the daemon's start to finish
//! or undo.

use std::sync::LazyLock;

use rusqlite::{Connection, Row};
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::RepoMountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::worktree::lifecycle::{RemovedWorktreeId, WorktreeId};
use sidekicks_store::database::stored_column::{closed_word, optional_text_column, text_column};

use crate::git::worktree::rows::{WorktreeRow, live_worktree_state_predicate};
use crate::git::worktree::service::place_of;

/// The statements `read_unfinished_discards` runs: the one listing read.
pub const UNFINISHED_DISCARD_STATEMENT_CAPACITY: usize = 1;

static SELECT_UNFINISHED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT kept.id, kept.mount_id, kept.original_path, kept.kept_path,
       kept.record_folder, repo_mounts.canonical_root,
       tree.id AS worktree_id, tree.created_by_session_id, tree.branch_name, tree.base_ref,
       tree.state, repo_mounts.place
  FROM removed_worktrees AS kept
  JOIN repo_mounts ON repo_mounts.id = kept.mount_id
  LEFT JOIN worktrees AS tree
    ON tree.repo_mount_id = kept.mount_id
   AND tree.fs_root = kept.original_path
   AND {}
 WHERE kept.removed_at IS NULL
 ORDER BY kept.id",
        live_worktree_state_predicate("tree")
    )
});

/// A kept copy whose discard a crash cut short, and the tree it was moving while still live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct UnfinishedKeptWorktree {
    /// The kept copy.
    pub(crate) removed_worktree_id: RemovedWorktreeId,
    /// Where the tree lived.
    pub(crate) original_path: FilesystemPath,
    /// The kept folder under the project's `.removed/`.
    pub(crate) kept_folder: FilesystemPath,
    /// The repository's root folder.
    pub(crate) canonical_root: FilesystemPath,
    /// Where the repository is, for its git calls; absent on macOS and Linux.
    pub(crate) place: Option<Place>,
    /// Git's record of the tree as git named it, written with what the copy records just before
    /// the tree moves; `None` until then.
    pub(crate) record_folder: Option<FilesystemPath>,
    /// The tree's row as the discard read it, or `None` when no live row is at its folder.
    pub(crate) worktree: Option<WorktreeRow>,
}

/// Every discard a crash cut short, in kept-copy id order, read afresh on `reader`, the daemon's
/// read-only connection. Fails with SQLite's error, or with a conversion failure when a stored
/// value does not read as its type.
pub(crate) fn read_unfinished_discards(
    reader: &Connection,
) -> rusqlite::Result<Vec<UnfinishedKeptWorktree>> {
    reader
        .prepare_cached(&SELECT_UNFINISHED_SQL)?
        .query_map([], unfinished_kept_worktree_of)?
        .collect()
}

fn unfinished_kept_worktree_of(row: &Row<'_>) -> rusqlite::Result<UnfinishedKeptWorktree> {
    let original_path = text_column(row, 2, FilesystemPath::new)?;
    Ok(UnfinishedKeptWorktree {
        removed_worktree_id: text_column(row, 0, |text| RemovedWorktreeId::new(&text))?,
        kept_folder: text_column(row, 3, FilesystemPath::new)?,
        canonical_root: text_column(row, 5, FilesystemPath::new)?,
        place: place_of(row, 11)?,
        record_folder: optional_text_column(row, 4, FilesystemPath::new)?,
        worktree: live_tree_of(row, &original_path)?,
        original_path,
    })
}

// The live tree the left join found at the kept copy's original folder `fs_root`, `None` when it
// found none.
fn live_tree_of(row: &Row<'_>, fs_root: &FilesystemPath) -> rusqlite::Result<Option<WorktreeRow>> {
    let (Some(id), Some(created_by_session_id), Some(branch_name), Some(base_ref), Some(state)) = (
        optional_text_column(row, 6, |text| WorktreeId::new(&text))?,
        optional_text_column(row, 7, |text| SessionId::new(&text))?,
        optional_text_column(row, 8, GitRefName::new)?,
        optional_text_column(row, 9, GitRefName::new)?,
        optional_text_column(row, 10, closed_word)?,
    ) else {
        return Ok(None);
    };
    Ok(Some(WorktreeRow {
        id,
        repo_mount_id: text_column(row, 1, |text| RepoMountId::new(&text))?,
        created_by_session_id,
        branch_name,
        base_ref,
        fs_root: fs_root.clone(),
        state,
    }))
}
