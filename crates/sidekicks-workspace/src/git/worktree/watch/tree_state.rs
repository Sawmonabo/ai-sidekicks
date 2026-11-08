//! The worktree state moves the working-folder watch writes: the daemon's standing tree at a
//! watched folder moves `-> dirty` when uncommitted work is seen there, `dirty -> ready` once it
//! reads clean again, `ready -> merged` once its branch has merged back and `merged -> ready` once
//! its branch gains commits of its own again, each with its event in the row's own write.
//!
//! - Whether the tree is clean is one `git status` on each change burst, read before the burst's
//!   change goes out; a folder holding no standing tree costs one row read and runs no git.
//! - Whether its branch merged back, or a merged one gained commits of its own again, is read
//!   after the change goes out, so no subscriber waits for it: at the watch's start, after a change
//!   in the tree's git folder, which every commit, merge, fetch or ref move makes, and after the
//!   tree reads clean again, never after a burst of file changes alone that leaves it as it was
//!   ([`super::merged`]).
//! - Every failure is logged, and the folder's next change checks again.

use std::error::Error;
use std::path::Path;
use std::sync::LazyLock;

use rusqlite::{OptionalExtension, named_params};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::worktree::lifecycle::WorktreeState;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_store::events::session::appender::SessionEventLinkage;

use super::merged::{MergedCheck, own_work_commit_statement};
use super::{WatchTarget, WatcherShared};
use crate::git::worktree::event_emitter::EmitWorktreeEventInput;
use crate::git::worktree::reads::has_uncommitted_work;
use crate::git::worktree::rows::{
    WorktreeRow, newest_branch_context_join, standing_worktree_state_predicate,
    transition_statement,
};
use crate::git::worktree::service::{WORKTREE_ROW_COLUMNS, worktree_row_of};

// The newest standing tree the daemon made at a folder, with the base its newest branch context
// names, else its own, and the commit that holds its branch's own work.
static SELECT_STANDING_TREE_AT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {WORKTREE_ROW_COLUMNS}, COALESCE(newest.base_branch, wt.base_ref),
        wt.own_work_commit
   FROM worktrees AS wt
   {newest}
  WHERE wt.fs_root = @fs_root AND {standing}
  ORDER BY wt.created_at DESC, wt.id DESC
  LIMIT 1",
        newest = newest_branch_context_join("wt"),
        standing = standing_worktree_state_predicate("wt"),
    )
});

// `-> dirty`, from `ready` or `merged`.
static MARK_DIRTY_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE worktrees SET state = '{dirty}', updated_at = @now
  WHERE id = @worktree_id AND state IN ('{ready}', '{merged}')",
        dirty = <&'static str>::from(WorktreeState::Dirty),
        ready = <&'static str>::from(WorktreeState::Ready),
        merged = <&'static str>::from(WorktreeState::Merged),
    )
});

// `dirty -> ready`.
static MARK_CLEANED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE worktrees SET state = '{ready}', updated_at = @now
  WHERE id = @worktree_id AND state = '{dirty}'",
        ready = <&'static str>::from(WorktreeState::Ready),
        dirty = <&'static str>::from(WorktreeState::Dirty),
    )
});

// `ready -> merged`.
static MARK_MERGED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE worktrees SET state = '{merged}', updated_at = @now
  WHERE id = @worktree_id AND state = '{ready}'",
        merged = <&'static str>::from(WorktreeState::Merged),
        ready = <&'static str>::from(WorktreeState::Ready),
    )
});

// `merged -> ready`.
static MARK_REOPENED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE worktrees SET state = '{ready}', updated_at = @now
  WHERE id = @worktree_id AND state = '{merged}'",
        ready = <&'static str>::from(WorktreeState::Ready),
        merged = <&'static str>::from(WorktreeState::Merged),
    )
});

/// The daemon's standing tree at a watched folder that reads clean, `ready` or `merged`, which the
/// merged check reads, and whether this check moved it back from `dirty`.
pub(super) struct CleanTree {
    /// The tree.
    pub(super) tree: StandingTree,
    /// Whether this check wrote its `dirty -> ready` move.
    pub(super) is_cleaned: bool,
}

/// The daemon's standing tree at a watched folder, as the state moves read it.
pub(super) struct StandingTree {
    /// Its row.
    pub(super) row: WorktreeRow,
    /// The base its branch merges back into: its newest branch context's, else its own as given.
    pub(super) base: String,
    /// The commit that holds its branch's own work: the newest commit a check saw on the branch
    /// that changes a path, is no merge commit and neither the base nor its upstream holds, the tip
    /// where that commit lacks some of that work, or the reflog's seed, which the base or its
    /// upstream holds; `None` while none was seen.
    pub(super) own_work_commit: Option<String>,
}

// The move a check found due; a reopened tree's row records the commit that holds its new work.
#[derive(Clone, Copy, Debug)]
enum TreeMove<'commit> {
    Dirtied,
    Cleaned,
    Merged,
    Reopened { commit: &'commit str },
}

// Why the standing tree at a folder could not be read.
#[derive(Debug, thiserror::Error)]
enum StandingTreeReadError {
    #[error("the worktree rows did not reach the database")]
    Pool(#[from] DatabaseReadError),
    #[error("the worktree row at a working folder could not be read")]
    Row(#[from] rusqlite::Error),
}

/// Reads the daemon's standing tree at `target`'s folder and writes its `-> dirty` or
/// `dirty -> ready` move where the folder at `key` makes one due, with its event in the same write;
/// answers the tree when it reads clean, `ready` or `merged`. A write the row refused, its tree
/// retired or moved meanwhile, appends nothing.
pub(super) async fn check_uncommitted_work(
    shared: &WatcherShared,
    key: &Path,
    target: &WatchTarget,
) -> Option<CleanTree> {
    let tree = match read_standing_tree(shared, target).await {
        Ok(Some(tree)) => tree,
        Ok(None) => return None,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the worktree at a working folder could not be read, so its state is not written \
                 yet"
            );
            return None;
        }
    };
    let is_dirty = match has_uncommitted_work(&shared.deps.git, target.place.as_ref(), key).await {
        Ok(is_dirty) => is_dirty,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a worktree's uncommitted work could not be read, so its state is not written yet"
            );
            return None;
        }
    };
    if is_dirty {
        if tree.row.state != WorktreeState::Dirty {
            write_move(shared, &tree.row, TreeMove::Dirtied).await;
        }
        return None;
    }
    let is_cleaned = match tree.row.state {
        WorktreeState::Dirty => {
            if !write_move(shared, &tree.row, TreeMove::Cleaned).await {
                return None;
            }
            true
        }
        WorktreeState::Ready | WorktreeState::Merged => false,
        WorktreeState::Creating | WorktreeState::Retired | WorktreeState::Failed => return None,
    };
    Some(CleanTree { tree, is_cleaned })
}

/// Writes `tree`'s `ready -> merged` move once its branch, checked out at `key`, has merged back,
/// or its `merged -> ready` move once a merged branch gains commits of its own again, with its
/// event in the same write. A write the row refused appends nothing.
pub(super) async fn check_merged_back(
    shared: &WatcherShared,
    key: &Path,
    target: &WatchTarget,
    merged: &mut MergedCheck,
    tree: &StandingTree,
) {
    if tree.row.state == WorktreeState::Merged {
        match merged
            .reopened_commit(&shared.deps.git, target.place.as_ref(), key, tree)
            .await
        {
            Ok(Some(commit)) => {
                write_move(shared, &tree.row, TreeMove::Reopened { commit: &commit }).await;
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "whether a merged worktree's branch gained commits of its own could not be read; \
                 the next change in its git folder reads it again"
            ),
        }
        return;
    }
    match merged
        .has_merged_back(&shared.deps, target.place.as_ref(), key, tree)
        .await
    {
        Ok(true) => {
            write_move(shared, &tree.row, TreeMove::Merged).await;
        }
        Ok(false) => {}
        Err(error) => tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "whether a worktree's branch merged back could not be read; the next change in its git \
             folder reads it again"
        ),
    }
}

async fn read_standing_tree(
    shared: &WatcherShared,
    target: &WatchTarget,
) -> Result<Option<StandingTree>, StandingTreeReadError> {
    let fs_root = target.folder.to_string_lossy().into_owned();
    shared
        .deps
        .reads
        .read(ReadLength::Short, move |connection| {
            Ok(connection
                .prepare_cached(&SELECT_STANDING_TREE_AT_SQL)?
                .query_row(named_params! { "@fs_root": fs_root }, |row| {
                    Ok(StandingTree {
                        row: worktree_row_of(row)?,
                        base: row.get(7)?,
                        own_work_commit: row.get(8)?,
                    })
                })
                .optional()?)
        })
        .await
}

// Writes the row's move and its event in one write, the move guarded on its legal predecessor;
// whether the move was written.
async fn write_move(shared: &WatcherShared, tree: &WorktreeRow, due: TreeMove<'_>) -> bool {
    let now = WireInstant::now();
    let sql = match due {
        TreeMove::Dirtied => MARK_DIRTY_SQL.as_str(),
        TreeMove::Cleaned => MARK_CLEANED_SQL.as_str(),
        TreeMove::Merged => MARK_MERGED_SQL.as_str(),
        TreeMove::Reopened { .. } => MARK_REOPENED_SQL.as_str(),
    };
    let mut prelude = vec![transition_statement(sql, &tree.id, &now, Some(1))];
    if let TreeMove::Reopened { commit } = due {
        prelude.push(own_work_commit_statement(&tree.id, commit, &now));
    }
    // The row's own session: the event belongs to its maker, and the watch acts for no one.
    let input = EmitWorktreeEventInput {
        session_id: tree.created_by_session_id,
        worktree_id: tree.id,
        repo_mount_id: Some(tree.repo_mount_id),
        workspace_id: None,
        actor: None,
    };
    let linkage = SessionEventLinkage {
        occurred_at: Some(now.clone()),
        transactional_prelude: prelude,
        ..SessionEventLinkage::default()
    };
    let events = &shared.deps.events;
    let written = match due {
        TreeMove::Dirtied => events.emit_worktree_dirtied(input, linkage).await,
        TreeMove::Cleaned => events.emit_worktree_cleaned(input, linkage).await,
        TreeMove::Merged => events.emit_worktree_merged(input, linkage).await,
        TreeMove::Reopened { .. } => events.emit_worktree_reopened(input, linkage).await,
    };
    match written {
        Ok(_) => true,
        Err(error) if error.refused_statement_index() == Some(0) => {
            tracing::debug!(
                "a worktree left the state its move expected before the move was written"
            );
            false
        }
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a worktree's state move could not be written; the folder's next change tries again"
            );
            false
        }
    }
}
