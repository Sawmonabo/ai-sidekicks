//! The dirty and merged moves: the daemon's worktree at a watched folder moves `-> dirty` when
//! uncommitted work is seen there, and `-> merged` once the tree is clean and its branch has merged
//! back into the base it was cut from, each with its event in the row's own write.
//!
//! - A tree holding uncommitted work reads dirty, from `ready` or `merged`; a clean tree whose
//!   branch merged back reads merged, from `ready` or `dirty`. A clean tree whose branch has not
//!   merged keeps its state, since no event moves a tree back to `ready`.
//! - A branch has merged back when it has commits of its own, its tip no longer the commit its
//!   reflog says it was made at, and that tip is reachable from its base. A new tree's branch is
//!   its base's commit, so it never reads merged; a squash merge leaves no ancestry, so is not
//!   seen.
//! - A folder that holds no live daemon worktree costs one row read per check, and git runs only
//!   for a tree. Every failure is logged, and the folder's next change checks again.

use std::error::Error;
use std::path::Path;
use std::sync::LazyLock;

use rusqlite::{OptionalExtension, named_params};
use sidekicks_contracts::place::Place;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::worktree::lifecycle::WorktreeState;
use sidekicks_store::database::connection::read_pool::{DatabaseReadError, ReadLength};
use sidekicks_store::events::session::appender::SessionEventLinkage;

use super::{WatchTarget, WatcherShared};
use crate::git::process::{GitCall, GitError, GitRunner, background_read};
use crate::git::worktree::event_emitter::EmitWorktreeEventInput;
use crate::git::worktree::reads::{BRANCH_REF_PREFIX, read_ref_heads, read_uncommitted_paths};
use crate::git::worktree::rows::{WorktreeRow, transition_statement};
use crate::git::worktree::service::{WORKTREE_ROW_COLUMNS, worktree_row_of};

// The newest live tree the daemon made at a folder, as stored.
static SELECT_LIVE_TREE_AT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {WORKTREE_ROW_COLUMNS} FROM worktrees AS wt
  WHERE wt.fs_root = @fs_root AND wt.state IN ('{ready}', '{dirty}', '{merged}')
  ORDER BY wt.created_at DESC, wt.id DESC
  LIMIT 1",
        ready = <&'static str>::from(WorktreeState::Ready),
        dirty = <&'static str>::from(WorktreeState::Dirty),
        merged = <&'static str>::from(WorktreeState::Merged),
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

// `-> merged`, from `ready` or `dirty`.
static MARK_MERGED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "UPDATE worktrees SET state = '{merged}', updated_at = @now
  WHERE id = @worktree_id AND state IN ('{ready}', '{dirty}')",
        merged = <&'static str>::from(WorktreeState::Merged),
        ready = <&'static str>::from(WorktreeState::Ready),
        dirty = <&'static str>::from(WorktreeState::Dirty),
    )
});

// `merge-base --is-ancestor`'s exit when the first commit is not reachable from the second.
const NOT_AN_ANCESTOR_EXIT_CODE: i32 = 1;

// The move a check found due.
#[derive(Clone, Copy, Debug)]
enum TreeMove {
    Dirtied,
    Merged,
}

// Why the live tree at a folder could not be read.
#[derive(Debug, thiserror::Error)]
enum LiveTreeReadError {
    #[error("the worktree rows did not reach the database")]
    Pool(#[from] DatabaseReadError),
    #[error("the worktree row at a working folder could not be read")]
    Row(#[from] rusqlite::Error),
}

/// Reads the daemon's live tree at `target`'s folder and, when its state is no longer what the
/// folder at `key` shows, moves it `-> dirty` or `-> merged` with its event in the same write. A
/// write the row refused, its tree retired or moved meanwhile, appends nothing.
pub(super) async fn check_dirty_or_merged(
    shared: &WatcherShared,
    key: &Path,
    target: &WatchTarget,
) {
    let tree = match read_live_tree(shared, target).await {
        Ok(Some(tree)) => tree,
        Ok(None) => return,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the worktree at a working folder could not be read, so whether it is dirty or \
                 merged is not written yet"
            );
            return;
        }
    };
    match due_move(&shared.deps.git, target.place.as_ref(), key, &tree).await {
        Ok(Some(due)) => write_move(shared, &tree, due).await,
        Ok(None) => {}
        Err(error) => tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "a worktree's uncommitted work or its branch could not be read, so whether it is dirty \
             or merged is not written yet"
        ),
    }
}

async fn read_live_tree(
    shared: &WatcherShared,
    target: &WatchTarget,
) -> Result<Option<WorktreeRow>, LiveTreeReadError> {
    let fs_root = target.folder.to_string_lossy().into_owned();
    shared
        .deps
        .reads
        .read(ReadLength::Short, move |connection| {
            Ok(connection
                .prepare_cached(&SELECT_LIVE_TREE_AT_SQL)?
                .query_row(named_params! { "@fs_root": fs_root }, worktree_row_of)
                .optional()?)
        })
        .await
}

// The move the tree at `folder` is due: dirty while it holds uncommitted work, merged once it is
// clean and its branch merged back, none when its state already says so.
async fn due_move(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    tree: &WorktreeRow,
) -> Result<Option<TreeMove>, GitError> {
    if !read_uncommitted_paths(git, place, folder).await?.is_empty() {
        return Ok((tree.state != WorktreeState::Dirty).then_some(TreeMove::Dirtied));
    }
    if tree.state == WorktreeState::Merged {
        return Ok(None);
    }
    Ok(has_merged_back(git, place, folder, tree)
        .await?
        .then_some(TreeMove::Merged))
}

// Whether the tree's branch has commits of its own, all reachable from its base. A branch gone,
// or one git keeps no reflog for, has not.
async fn has_merged_back(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
    tree: &WorktreeRow,
) -> Result<bool, GitError> {
    let ref_name = format!("{BRANCH_REF_PREFIX}{}", tree.branch_name.as_str());
    let Some(tip) = read_ref_heads(git, place, folder, &[ref_name.as_str()])
        .await?
        .remove(&ref_name)
        .map(|head| head.commit)
    else {
        return Ok(false);
    };
    // The reflog lists the branch's commits newest first; its oldest is where it was made.
    let reflog = git
        .run(
            place,
            GitCall::read(background_read(
                folder,
                &["rev-list", "--walk-reflogs", &ref_name, "--"],
            )),
        )
        .await?;
    let made_at = reflog
        .stdout
        .split(|byte| *byte == b'\n')
        .rfind(|line| !line.is_empty());
    if made_at.is_none_or(|made_at| made_at == tip.as_bytes()) {
        return Ok(false);
    }
    let ancestry = git
        .run(
            place,
            GitCall::read(background_read(
                folder,
                &["merge-base", "--is-ancestor", &tip, tree.base_ref.as_str()],
            )),
        )
        .await;
    match ancestry {
        Ok(_) => Ok(true),
        Err(error) if error.exit_code() == Some(NOT_AN_ANCESTOR_EXIT_CODE) => Ok(false),
        Err(error) => Err(error),
    }
}

// Writes the row's move and its event in one write, the move guarded on its legal predecessors.
async fn write_move(shared: &WatcherShared, tree: &WorktreeRow, due: TreeMove) {
    let now = WireInstant::now();
    let sql = match due {
        TreeMove::Dirtied => MARK_DIRTY_SQL.as_str(),
        TreeMove::Merged => MARK_MERGED_SQL.as_str(),
    };
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
        transactional_prelude: vec![transition_statement(sql, &tree.id, &now, Some(1))],
        ..SessionEventLinkage::default()
    };
    let events = &shared.deps.events;
    let written = match due {
        TreeMove::Dirtied => events.emit_worktree_dirtied(input, linkage).await,
        TreeMove::Merged => events.emit_worktree_merged(input, linkage).await,
    };
    match written {
        Ok(_) => {}
        Err(error) if error.refused_statement_index() == Some(0) => tracing::debug!(
            "a worktree left the state its dirty or merged move expected before the move was \
             written"
        ),
        Err(error) => tracing::warn!(
            error = &error as &(dyn Error + 'static),
            "a worktree's dirty or merged move could not be written; the folder's next change \
             tries again"
        ),
    }
}
