//! The slow tick of a working folder too large for the machine's watch limit: what `git status`
//! lists there, with each listed path's length and modified time, since a change to a file already
//! changed leaves the listing as it was.

use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use sidekicks_contracts::place::Place;

use crate::git::process::{GitError, GitRunner};
use crate::git::worktree::reads::read_uncommitted_paths;
use crate::missing_entry::is_gone;

/// One listed path and what its entry holds: its length and modified time, `None` for a path
/// status lists that names nothing (a deleted file).
pub(super) type StatusEntry = (PathBuf, Option<(u64, SystemTime)>);

/// Why a tick's reading could not be taken.
#[derive(Debug, thiserror::Error)]
pub(super) enum StatusDigestError {
    /// `git status` failed.
    #[error("the working folder's status could not be read")]
    Status(#[source] GitError),
    /// A listed path's entry could not be read for another reason than naming nothing.
    #[error("a changed file in the working folder could not be read")]
    Entry(#[source] io::Error),
    /// The entry reads did not finish.
    #[error("the reads of a working folder's changed files did not finish")]
    Interrupted(#[source] tokio::task::JoinError),
}

/// What a tick compares: every path `git status` lists in `folder` at `place` with its entry, in
/// path order. Fails with [`StatusDigestError`].
pub(super) async fn read_status_digest(
    git: &GitRunner,
    place: Option<&Place>,
    folder: &Path,
) -> Result<Vec<StatusEntry>, StatusDigestError> {
    let mut paths = read_uncommitted_paths(git, place, folder)
        .await
        .map_err(StatusDigestError::Status)?;
    paths.sort();
    let folder = folder.to_path_buf();
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let entry = match std::fs::symlink_metadata(folder.join(&path)) {
                    Ok(metadata) => Some((metadata.len(), metadata.modified()?)),
                    Err(error) if is_gone(&error) => None,
                    Err(error) => return Err(error),
                };
                Ok((path, entry))
            })
            .collect::<io::Result<Vec<_>>>()
    })
    .await
    .map_err(StatusDigestError::Interrupted)?
    .map_err(StatusDigestError::Entry)
}
