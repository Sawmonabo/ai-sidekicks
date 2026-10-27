//! The one ordered branch list both base pickers draw: the project's default branch first, then
//! the branches its recent bases were picked from, most recent first, then every other branch by
//! its newest commit. Each row carries its distance from its upstream as of the background fetch
//! and the tree that has it checked out, git's answer for any tree: the repository's own checkout,
//! a tree the person made, or one this daemon made, which also carries its id. The order is the
//! daemon's; a picker filters the list and never reorders it.

use std::cmp::Reverse;
use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use rusqlite::{Connection, OptionalExtension};
use sidekicks_contracts::git::shared::GitRefName;
use sidekicks_contracts::place::Place;
use sidekicks_contracts::repo::git_reads::{
    BranchHolder, ProjectBranchListEntry, ProjectBranchListResponse,
};
use sidekicks_contracts::repo::mount::{RepoMountId, RepoMountState};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::text::TextError;
use sidekicks_contracts::worktree::lifecycle::WorktreeId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::stored_column::{optional_text_column, text_column};

use crate::folder::canonical_path::canonical_folder_path;
use crate::git::process::{GitError, GitRunner};
use crate::git::worktree::fetch::read_counts_as_of;
use crate::git::worktree::reads::{
    BranchFigures, commit_count, read_branch_figures, read_current_branch,
    read_remote_default_branch, tree_name_of,
};
use crate::git::worktree::rows::LIVE_WORKTREE_STATE_PREDICATE;
use crate::repo::errors::RepoRefusal;

static SELECT_ATTACHED_MOUNT_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT canonical_root, place FROM repo_mounts WHERE id = ? AND state = '{}'",
        <&'static str>::from(RepoMountState::Attached)
    )
});

// Every base a tree of this project was cut from, across each mount the project has had, newest
// pick first.
const SELECT_RECENT_BASES_SQL: &str = "SELECT bc.base_branch, MAX(bc.created_at) AS picked_at
  FROM branch_contexts AS bc
  JOIN worktrees AS wt ON wt.id = bc.worktree_id
  JOIN repo_mounts AS m ON m.id = wt.repo_mount_id
 WHERE m.project_id = (SELECT project_id FROM repo_mounts WHERE id = ?)
 GROUP BY bc.base_branch
 ORDER BY picked_at DESC, bc.base_branch";

// The trees this daemon made that still stand on the mount.
static SELECT_LIVE_WORKTREES_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT id, fs_root FROM worktrees WHERE repo_mount_id = ? AND {}",
        LIVE_WORKTREE_STATE_PREDICATE.as_str()
    )
});

/// Why the branch list could not be read.
#[derive(Debug, thiserror::Error)]
pub enum BranchListError {
    /// The mount is not attached (`repoMount.notFound`).
    #[error(transparent)]
    Refused(#[from] RepoRefusal),
    /// The read did not reach the database.
    #[error("the branch list's rows could not be read")]
    Pool(#[from] DatabaseReadError),
    /// The rows could not be read.
    #[error("the branch list's rows could not be read")]
    Database(#[from] rusqlite::Error),
    /// A git read failed.
    #[error("the repository's branches could not be read")]
    Git(#[from] GitError),
    /// A tree's folder could not be resolved (a permission refusal).
    #[error("a tree's folder could not be resolved")]
    Folder(#[source] io::Error),
    /// No remote names a default branch and the checkout is on no branch.
    #[error(
        "the repository names no default branch: no remote names one and its checkout is on no \
         branch"
    )]
    NoDefaultBranch,
    /// A branch or tree name git printed is no text the list can carry.
    #[error("a branch or tree name git printed cannot be listed")]
    Name(#[source] TextError),
}

impl From<BranchListError> for HandlerError {
    /// A mount that is not attached refuses the call; every other failure is a fault.
    fn from(error: BranchListError) -> Self {
        match error {
            BranchListError::Refused(refusal) => Self::Refused(DomainError::from(refusal)),
            other @ (BranchListError::Pool(_)
            | BranchListError::Database(_)
            | BranchListError::Git(_)
            | BranchListError::Folder(_)
            | BranchListError::NoDefaultBranch
            | BranchListError::Name(_)) => Self::Internal(Box::new(other)),
        }
    }
}

// What the rows say about the mount's branches.
struct BranchListRows {
    repository_root: PathBuf,
    place: Option<Place>,
    recent_bases: Vec<String>,
    live_worktrees: Vec<(WorktreeId, PathBuf)>,
    counts_as_of: Option<WireInstant>,
}

/// Answers `project.branch.list` for a project's mount.
pub struct BranchListReader {
    git: GitRunner,
    reads: Arc<DatabaseReadPool>,
}

impl BranchListReader {
    /// A reader running git through `git` and reading its rows on `reads`.
    pub fn new(git: GitRunner, reads: Arc<DatabaseReadPool>) -> Self {
        Self { git, reads }
    }

    /// Reads the ordered list of `repo_mount_id`'s branches. Fails with
    /// [`BranchListError::Refused`] (`repoMount.notFound`) for a mount that is not attached,
    /// [`BranchListError::NoDefaultBranch`] when the repository names no default, and with a
    /// read's failure.
    pub async fn read(
        &self,
        repo_mount_id: &RepoMountId,
    ) -> Result<ProjectBranchListResponse, BranchListError> {
        let mount = *repo_mount_id;
        let rows = self
            .reads
            .read(ReadLength::Short, move |connection| {
                read_rows(connection, &mount)
            })
            .await?
            .ok_or(RepoRefusal::MountNotFound {
                repo_mount_id: *repo_mount_id,
            })?;
        let git = &self.git;
        let place = rows.place.as_ref();
        let root = rows.repository_root.as_path();
        let (branches, remote_default, checkout_branch) = tokio::try_join!(
            read_branch_figures(git, place, root),
            read_remote_default_branch(git, place, root),
            read_current_branch(git, place, root),
        )?;
        // A repository no remote names a default for takes its checkout's own branch.
        let default_branch = remote_default
            .or(checkout_branch)
            .ok_or(BranchListError::NoDefaultBranch)?;

        let mut app_tree_by_folder = HashMap::new();
        for (worktree_id, folder) in rows.live_worktrees {
            app_tree_by_folder.insert(
                canonical_folder_path(&folder)
                    .await
                    .map_err(BranchListError::Folder)?,
                worktree_id,
            );
        }
        let mut entries = Vec::new();
        for branch in in_list_order(branches, &default_branch, &rows.recent_bases) {
            let held_by = match &branch.checked_out_at {
                Some(folder) => Some(BranchHolder {
                    worktree_id: app_tree_by_folder
                        .get(
                            &canonical_folder_path(folder)
                                .await
                                .map_err(BranchListError::Folder)?,
                        )
                        .copied(),
                    name: tree_name_of(folder).map_err(BranchListError::Name)?,
                }),
                None => None,
            };
            entries.push(ProjectBranchListEntry {
                name: GitRefName::new(branch.name).map_err(BranchListError::Name)?,
                ahead: branch.ahead.map(commit_count),
                behind: branch.behind.map(commit_count),
                held_by,
            });
        }
        Ok(ProjectBranchListResponse {
            default_branch: GitRefName::new(default_branch).map_err(BranchListError::Name)?,
            branches: entries,
            counts_as_of: rows.counts_as_of,
        })
    }
}

// The mount's rows, `None` when it is not attached.
fn read_rows(
    connection: &Connection,
    repo_mount_id: &RepoMountId,
) -> Result<Option<BranchListRows>, BranchListError> {
    let mount_id = repo_mount_id.to_string();
    let Some((repository_root, place)) = connection
        .prepare_cached(SELECT_ATTACHED_MOUNT_SQL.as_str())?
        .query_row([&mount_id], |row| {
            Ok((
                PathBuf::from(row.get::<_, String>(0)?),
                // The column holds the place's wire JSON.
                optional_text_column(row, 1, |text| serde_json::from_str::<Place>(&text))?,
            ))
        })
        .optional()?
    else {
        return Ok(None);
    };
    let recent_bases = connection
        .prepare_cached(SELECT_RECENT_BASES_SQL)?
        .query_map([&mount_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let live_worktrees = connection
        .prepare_cached(SELECT_LIVE_WORKTREES_SQL.as_str())?
        .query_map([&mount_id], |row| {
            Ok((
                text_column(row, 0, |text| WorktreeId::new(&text))?,
                PathBuf::from(row.get::<_, String>(1)?),
            ))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Some(BranchListRows {
        repository_root,
        place,
        recent_bases,
        live_worktrees,
        counts_as_of: read_counts_as_of(connection, repo_mount_id)?,
    }))
}

// The branches in the list's order: the default, then each recent base, then the rest by their
// newest commit, newest first; a name no branch holds is passed over.
fn in_list_order(
    branches: Vec<BranchFigures>,
    default_branch: &str,
    recent_bases: &[String],
) -> Vec<BranchFigures> {
    let mut by_newest_commit = branches;
    by_newest_commit.sort_by_key(|branch| Reverse(branch.newest_commit_seconds));
    let lead_names: Vec<&str> = std::iter::once(default_branch)
        .chain(recent_bases.iter().map(String::as_str))
        .collect();
    let mut lead: Vec<Option<BranchFigures>> = lead_names.iter().map(|_| None).collect();
    let mut rest = Vec::with_capacity(by_newest_commit.len());
    for branch in by_newest_commit {
        match lead_names.iter().position(|name| *name == branch.name) {
            Some(place) => lead[place] = Some(branch),
            None => rest.push(branch),
        }
    }
    lead.into_iter().flatten().chain(rest).collect()
}

#[cfg(test)]
mod tests;
