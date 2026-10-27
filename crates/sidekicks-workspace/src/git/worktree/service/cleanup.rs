//! The sweep of retired folders. It records its decision to delete, removes the tree's record, then
//! the folder, then stamps `cleaned_at`, so a crash between steps leaves a row the next pass
//! finishes by its path, and never a cleanup recorded that did not happen.
//!
//! - A retired tree holding what the person could lose is never deleted: it is kept aside whole
//!   and listed with the removed worktrees, or, on a mount no longer attached, left where it is.
//! - A tree an agent runs in, or a session stands in, is left for a later pass.
//! - Before a folder goes, git's built-in file-watch daemon for the tree is stopped, since nothing
//!   else would end it once its folder is gone.

use std::borrow::Cow;
use std::error::Error;
use std::io;
use std::path::{Component, Path};
use std::sync::LazyLock;
use std::time::Duration;

use futures::future::BoxFuture;
use rusqlite::Connection;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::mount::{RepoMountState, WorkspaceState};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::worktree::lifecycle::{WorktreeId, WorktreeState};
use tokio_util::sync::CancellationToken;

use super::{
    RecordRetirementOptions, WORKTREE_ROW_COLUMNS, WorktreeService, WorktreeServiceError, place_of,
    remove_folder, worktree_row_of,
};
use crate::folder::canonical_path::canonical_folder_path;
use crate::git::branch_name_pattern::last_fatal_line;
use crate::git::process::{GitCall, GitError, in_folder};
use crate::git::worktree::occupancy::OccupancyReadError;
use crate::git::worktree::reads::{LinkedTreeRecordError, read_linked_tree_record};
use crate::git::worktree::risks::{
    RemovalRiskReadError, has_something_to_lose, read_removal_risk_reading,
};
use crate::git::worktree::rows::{WorktreeRow, live_worktree_state_predicate};
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};

// The stop's own bound, just past the 30 s git's stop waits for the daemon to exit, so a wedged
// daemon holds a pass no longer than that.
const FILE_WATCH_STOP_TIMEOUT: Duration = Duration::from_secs(35);
// git's exit when its stop finds no file-watch daemon to stop.
const FILE_WATCH_STOP_NOTHING_EXIT_CODE: i32 = 128;
// git's line when no file-watch daemon runs for the tree.
const FILE_WATCH_STOP_NOT_RUNNING_LINE: &str = "fatal: fsmonitor--daemon is not running";
// git's lines, around the folder it names, when it refuses the daemon to a repository it cannot
// watch for good (bare, virtual, without Unix sockets). git makes that check before every start as
// before the stop, so such a repository has no daemon the stop could reach. A failed check is left
// out, since it can pass again and a daemon started earlier still runs; a remote repository is
// let through on the stop itself.
const FILE_WATCH_INCOMPATIBLE_LINES: [(&str, &str); 3] = [
    (
        "fatal: bare repository '",
        "' is incompatible with fsmonitor",
    ),
    (
        "fatal: virtual repository '",
        "' is incompatible with fsmonitor",
    ),
    (
        "fatal: socket directory '",
        "' is incompatible with fsmonitor due to lack of Unix sockets support",
    ),
];

// Live worktrees on a mount no longer `attached`.
static SELECT_SWEEPABLE_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {WORKTREE_ROW_COLUMNS}
  FROM worktrees AS wt JOIN repo_mounts AS mount ON mount.id = wt.repo_mount_id
 WHERE mount.state <> '{}' AND {}
 ORDER BY wt.created_at ASC, wt.id ASC",
        <&'static str>::from(RepoMountState::Attached),
        live_worktree_state_predicate("wt")
    )
});

// A tree an agent still runs in, or a session still stands in, is deferred, not excluded: a later
// pass reclaims it once the run ends or the session moves. A live tree at the same folder, one put
// back there, owns the folder now, so the retired row leaves it alone.
static SELECT_UNCLEANED_RETIRED_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT {WORKTREE_ROW_COLUMNS}, mount.place, wt.retired_risk_digest,
       wt.cleanup_started_at, mount.state = '{attached}'
  FROM worktrees AS wt JOIN repo_mounts AS mount ON mount.id = wt.repo_mount_id
 WHERE wt.state = '{retired}' AND wt.cleaned_at IS NULL
   AND NOT EXISTS (
         SELECT 1 FROM run_execution_contexts AS run
          WHERE run.released_at IS NULL
            AND (run.worktree_id = wt.id OR run.execution_root = wt.fs_root))
   AND NOT EXISTS (
         SELECT 1 FROM workspaces AS standing
          WHERE standing.state <> '{archived}' AND standing.fs_root = wt.fs_root)
   AND NOT EXISTS (
         SELECT 1 FROM worktrees AS live
          WHERE live.fs_root = wt.fs_root AND {live})
 ORDER BY wt.updated_at ASC, wt.id ASC",
        attached = <&'static str>::from(RepoMountState::Attached),
        retired = <&'static str>::from(WorktreeState::Retired),
        archived = <&'static str>::from(WorkspaceState::Archived),
        live = live_worktree_state_predicate("live"),
    )
});

const MARK_CLEANUP_STARTED_SQL: &str = "UPDATE worktrees
    SET cleanup_started_at = @now, updated_at = @now
  WHERE id = @worktree_id AND cleaned_at IS NULL AND cleanup_started_at IS NULL";

/// Keeps a retired tree whose folder holds what the person could lose, for them to decide on.
pub(crate) trait RetiredWorktreeKeeper: Send + Sync {
    /// Moves the retired tree aside whole as a kept copy the removed list shows, its row stamped
    /// cleaned in the write that lists the copy. Fails with the move's or the write's failure.
    fn keep_retired_aside<'a>(
        &'a self,
        row: &'a WorktreeRow,
    ) -> BoxFuture<'a, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// What one cleanup pass did, in the order it did it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WorktreeCleanupReport {
    /// Trees retired because their mount is no longer attached, their folders left on disk.
    pub(crate) retired: Vec<WorktreeId>,
    /// Trees whose folder was removed and whose `cleaned_at` was stamped.
    pub(crate) cleaned: Vec<WorktreeId>,
    /// Retired trees whose folder held something new, kept aside or left where they are.
    pub(crate) kept: Vec<WorktreeId>,
}

/// Why cleaning one retired tree failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorktreeCleanupError {
    /// A row read or write, a retirement or a folder's resolve failed.
    #[error(transparent)]
    Service(#[from] WorktreeServiceError),
    /// The stored folder is not `<worktrees>/<project slug>/<name>`, the only shape a name plan
    /// makes, so a recursive removal could reach a kept copy, another project or anything else.
    #[error("its stored folder is not one a name plan makes")]
    UnnamedFolder,
    /// Who stands in the tree could not be read.
    #[error(transparent)]
    Occupancy(#[from] OccupancyReadError),
    /// git's record of the tree could not be read.
    #[error(transparent)]
    Record(#[from] LinkedTreeRecordError),
    /// What the tree holds could not be read.
    #[error(transparent)]
    RiskRead(#[from] RemovalRiskReadError),
    /// The tree's git file-watch daemon could not be stopped.
    #[error("the tree's git file-watch daemon could not be stopped")]
    FileWatchStop(#[source] GitError),
    /// The tree's record or folder could not be removed.
    #[error("the tree's record or folder could not be removed")]
    Removal(#[source] io::Error),
    /// The kept worktrees' store could not keep the tree aside.
    #[error("the tree could not be kept aside")]
    KeepAside(#[source] Box<dyn Error + Send + Sync>),
}

/// One failure of a cleanup pass: the rows it would sweep could not be read, or one row failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum WorktreeCleanupFailure {
    /// The rows to sweep could not be read.
    #[error("the worktrees to clean up could not be read")]
    Rows(#[source] WorktreeServiceError),
    /// One tree's retirement or cleanup failed.
    #[error("worktree {worktree_id}: {cause}")]
    Tree {
        /// The tree.
        worktree_id: WorktreeId,
        /// Why.
        #[source]
        cause: WorktreeCleanupError,
    },
}

// A retired, uncleaned tree as the sweep reads it, with what its retirement recorded and its
// mount.
struct RetiredFolderRow {
    row: WorktreeRow,
    place: Option<Place>,
    retired_risk_digest: Option<String>,
    is_cleanup_started: bool,
    is_mount_attached: bool,
}

// What became of one retired folder.
enum RetiredFolderOutcome {
    Cleaned,
    Kept,
    Deferred,
}

impl WorktreeService {
    /// One sweep: retires live trees on a mount no longer attached, stamping them cleaned so their
    /// folders stay on disk, then empties each retired folder with no `cleaned_at` while no agent
    /// runs in it and no session stands in it. A folder whose risk read shows nothing to lose, or
    /// the same as its retirement recorded, is deleted: git's record first, then the folder, then
    /// the stamp. One holding anything more goes to `keeper`, or on a mount no longer attached is
    /// left where it is, since a detach touches nothing on disk. A row that fails does not stop
    /// the others; once every row has been tried, every failure is returned together. The pass is
    /// idempotent and re-entrant, and once `cancel` is canceled it stops between rows, leaving the
    /// rest to the next pass.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's scheduled worktree cleanup")
    )]
    pub(crate) async fn cleanup_pass(
        &self,
        keeper: &dyn RetiredWorktreeKeeper,
        cancel: &CancellationToken,
    ) -> Result<WorktreeCleanupReport, SettleFailures<WorktreeCleanupFailure>> {
        let mut report = WorktreeCleanupReport::default();
        let mut outcomes: Vec<Result<(), WorktreeCleanupFailure>> = Vec::new();
        match self
            .deps
            .reads
            .read(ReadLength::Short, read_sweepable)
            .await
        {
            Ok(sweepable) => {
                for row in sweepable {
                    if cancel.is_cancelled() {
                        break;
                    }
                    let options = RecordRetirementOptions {
                        is_folder_left_on_disk: true,
                        ..RecordRetirementOptions::default()
                    };
                    match self.record_retirement(&row, options).await {
                        Ok(()) => report.retired.push(row.id),
                        Err(WorktreeServiceError::AlreadyRetired { .. }) => {}
                        Err(failure) => outcomes.push(Err(WorktreeCleanupFailure::Tree {
                            worktree_id: row.id,
                            cause: failure.into(),
                        })),
                    }
                }
            }
            Err(failure) => outcomes.push(Err(WorktreeCleanupFailure::Rows(failure))),
        }
        match self
            .deps
            .reads
            .read(ReadLength::Short, read_uncleaned_retired)
            .await
        {
            Ok(retired) => {
                for retired in retired {
                    if cancel.is_cancelled() {
                        break;
                    }
                    match self.clean_retired_folder(&retired, keeper).await {
                        Ok(RetiredFolderOutcome::Cleaned) => {
                            report.cleaned.push(retired.row.id);
                        }
                        Ok(RetiredFolderOutcome::Kept) => {
                            report.kept.push(retired.row.id);
                        }
                        Ok(RetiredFolderOutcome::Deferred) => {}
                        Err(cause) => outcomes.push(Err(WorktreeCleanupFailure::Tree {
                            worktree_id: retired.row.id,
                            cause,
                        })),
                    }
                }
            }
            Err(failure) => outcomes.push(Err(WorktreeCleanupFailure::Rows(failure))),
        }
        settle_all(outcomes, "the worktree cleanup").map(|_| report)
    }

    // Empties one retired folder, keeps it aside, or leaves it for a later pass while it is in use.
    async fn clean_retired_folder(
        &self,
        retired: &RetiredFolderRow,
        keeper: &dyn RetiredWorktreeKeeper,
    ) -> Result<RetiredFolderOutcome, WorktreeCleanupError> {
        let row = &retired.row;
        let folder = Path::new(row.fs_root.as_str());
        if !is_named_worktree_folder(&self.deps.worktrees_folder, folder) {
            return Err(WorktreeCleanupError::UnnamedFolder);
        }
        // Decided per row, right before removal: earlier removals are waits a run can start in.
        if self.is_folder_in_use(row).await? {
            return Ok(RetiredFolderOutcome::Deferred);
        }
        // Read while git still knows the tree, which names the record only from inside it. A pass
        // after a crash that already removed the record reads none and removes the folder alone.
        let place = retired.place.as_ref();
        let is_folder_present = tokio::fs::try_exists(folder)
            .await
            .map_err(WorktreeServiceError::Folder)?;
        let record_folder = if is_folder_present {
            read_linked_tree_record(&self.deps.git, place, folder).await?
        } else {
            None
        };
        // A removal a crash cut short while git still knows the tree is checked again, since work
        // may have been added to it since that pass decided.
        if !retired.is_cleanup_started || record_folder.is_some() {
            if is_folder_present && self.holds_something_new(retired).await? {
                if retired.is_mount_attached {
                    keeper
                        .keep_retired_aside(row)
                        .await
                        .map_err(WorktreeCleanupError::KeepAside)?;
                } else {
                    self.stamp_cleaned(&row.id).await?;
                }
                return Ok(RetiredFolderOutcome::Kept);
            }
            if !retired.is_cleanup_started {
                self.mark_cleanup_started(&row.id).await?;
            }
        }
        if record_folder.is_some() {
            self.stop_file_watch(place, folder).await?;
        }
        self.remove_worktree_record(record_folder.as_deref())
            .await
            .map_err(WorktreeCleanupError::Removal)?;
        remove_folder(folder)
            .await
            .map_err(WorktreeCleanupError::Removal)?;
        self.stamp_cleaned(&row.id).await?;
        Ok(RetiredFolderOutcome::Cleaned)
    }

    // An agent runs in the tree, or a session stands in its folder.
    async fn is_folder_in_use(&self, row: &WorktreeRow) -> Result<bool, WorktreeCleanupError> {
        if self.running_session_in(row).await?.is_some() {
            return Ok(true);
        }
        let occupancy = self.deps.occupancy.read(&row.repo_mount_id).await?;
        let folder = canonical_folder_path(Path::new(row.fs_root.as_str()))
            .await
            .map_err(WorktreeServiceError::Folder)?;
        Ok(occupancy.standing_by_folder.contains_key(&folder))
    }

    // Git shows something in the tree to lose beyond what its retirement recorded: anything at all
    // for a removal the person confirmed, anything new for a tree the daemon could not hand over.
    async fn holds_something_new(
        &self,
        retired: &RetiredFolderRow,
    ) -> Result<bool, WorktreeCleanupError> {
        let reading = read_removal_risk_reading(
            &self.deps.git,
            retired.place.as_ref(),
            Path::new(retired.row.fs_root.as_str()),
        )
        .await?;
        Ok(has_something_to_lose(&reading.risks)
            && retired.retired_risk_digest.as_deref() != Some(reading.digest.as_str()))
    }

    async fn mark_cleanup_started(
        &self,
        worktree_id: &WorktreeId,
    ) -> Result<(), WorktreeServiceError> {
        let worktree_id = worktree_id.text();
        self.deps
            .writer
            .write(vec![WriteStatement {
                sql: Cow::Borrowed(MARK_CLEANUP_STARTED_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@worktree_id", worktree_id.as_str()),
                    text_binding("@now", WireInstant::now().as_str()),
                ]),
                expected_row_count: None,
            }])
            .await?;
        Ok(())
    }

    // Stops git's built-in file-watch daemon for the tree in `folder` wherever the git program has
    // one, whatever the repository sets today, since a daemon started under an earlier setting or
    // by another tool outlives its folder; git answers that none runs when none does, which is
    // nothing to stop. A remote volume is let through, so a daemon git started there is reached,
    // and a stop past its own bound fails the row for the next pass.
    async fn stop_file_watch(
        &self,
        place: Option<&Place>,
        folder: &Path,
    ) -> Result<(), WorktreeCleanupError> {
        let git = &self.deps.git;
        if !git
            .has_built_in_file_watch(place)
            .await
            .map_err(WorktreeCleanupError::FileWatchStop)?
        {
            return Ok(());
        }
        let stop = GitCall::read(in_folder(
            folder,
            &[
                "-c",
                "fsmonitor.allowRemote=true",
                "fsmonitor--daemon",
                "stop",
            ],
        ))
        .with_timeout(Some(FILE_WATCH_STOP_TIMEOUT));
        match git.run(place, stop).await {
            Ok(_) => Ok(()),
            Err(GitError::Exited {
                code: Some(FILE_WATCH_STOP_NOTHING_EXIT_CODE),
                stderr,
                ..
            }) if is_nothing_to_stop(&stderr) => Ok(()),
            Err(failure) => Err(WorktreeCleanupError::FileWatchStop(failure)),
        }
    }
}

// Whether git's stop failed because there is no daemon to stop: none runs for the tree, or the
// repository is one git refuses a daemon to for good.
fn is_nothing_to_stop(stderr: &str) -> bool {
    last_fatal_line(stderr).is_some_and(|line| {
        line == FILE_WATCH_STOP_NOT_RUNNING_LINE
            || FILE_WATCH_INCOMPATIBLE_LINES.iter().any(|(before, after)| {
                line.strip_prefix(before)
                    .and_then(|rest| rest.strip_suffix(after))
                    .is_some_and(|folder| !folder.is_empty())
            })
    })
}

// Whether `folder` is `<worktrees_folder>/<project slug>/<name>`, the only shape a name plan
// makes: the path comes from the database, and a recursive removal must not reach a project's
// kept copies under `.removed/`, another project's folder or anything outside the worktrees
// folder.
fn is_named_worktree_folder(worktrees_folder: &Path, folder: &Path) -> bool {
    let Ok(inside) = folder.strip_prefix(worktrees_folder) else {
        return false;
    };
    let parts: Vec<Component<'_>> = inside.components().collect();
    parts.len() == 2
        && parts.iter().all(|part| match part {
            Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
            Component::Prefix(_)
            | Component::RootDir
            | Component::CurDir
            | Component::ParentDir => false,
        })
}

fn read_sweepable(connection: &Connection) -> Result<Vec<WorktreeRow>, WorktreeServiceError> {
    Ok(connection
        .prepare_cached(SELECT_SWEEPABLE_SQL.as_str())?
        .query_map([], worktree_row_of)?
        .collect::<rusqlite::Result<_>>()?)
}

fn read_uncleaned_retired(
    connection: &Connection,
) -> Result<Vec<RetiredFolderRow>, WorktreeServiceError> {
    Ok(connection
        .prepare_cached(SELECT_UNCLEANED_RETIRED_SQL.as_str())?
        .query_map([], |row| {
            Ok(RetiredFolderRow {
                row: worktree_row_of(row)?,
                place: place_of(row, 7)?,
                retired_risk_digest: row.get(8)?,
                is_cleanup_started: row.get::<_, Option<String>>(9)?.is_some(),
                is_mount_attached: row.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests;
