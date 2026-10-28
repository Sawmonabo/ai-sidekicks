//! Git's records of a tree the daemon made, found by the `.git` their `gitdir` names rather than
//! from inside the tree, so a tree git left without its `.git` file, or one already removed, still
//! has its records found. A record naming any other tree is never touched. The daemon's own adds
//! and its scan for records a crash left take one hold per repository, so the scan never reads an
//! add's record between git's writes.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use sidekicks_std::file::real_location::resolve_real_location;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};

use crate::git::worktree::folder_names::read_folder_names;
use crate::git::worktree::reads::{LINKED_RECORDS_FOLDER_NAME, read_record_git_file};
use crate::git::worktree::service::remove_folder;
use crate::trust_envelope::is_contained_within;

// Held on a repository's resolved git common folder, however each caller spells it.
static RECORD_WRITES: LazyLock<KeyedLock<PathBuf>> = LazyLock::new(KeyedLock::new);

/// Holds the records of the repository whose git common folder is `common_git_folder` until the
/// hold drops, against the daemon's other `worktree add`s and record scans there. Fails when the
/// folder cannot be resolved.
pub(crate) async fn hold_records(
    common_git_folder: &Path,
) -> io::Result<KeyHold<'static, PathBuf>> {
    let key = resolve_real_location(common_git_folder).await?;
    Ok(RECORD_WRITES.acquire(key).await)
}

/// A record, or the folder holding them, that could not be read or removed.
#[derive(Debug, thiserror::Error)]
#[error("git's worktree record {} could not be read or removed", path.display())]
pub struct TreeRecordRemovalError {
    /// The record, the records folder, or the tree whose path could not be resolved.
    pub path: PathBuf,
    /// The file system's failure.
    #[source]
    pub source: io::Error,
}

/// Removes every record in `common_git_folder` whose `gitdir` names a `.git` in `tree_folder`,
/// locked or not, since a `worktree add` ended mid-way leaves its record locked. Every record is
/// tried; the answer is every failure.
pub(crate) async fn remove_records_naming(
    common_git_folder: &Path,
    tree_folder: &Path,
) -> Vec<TreeRecordRemovalError> {
    let records_folder = common_git_folder.join(LINKED_RECORDS_FOLDER_NAME);
    let real_folder = match resolve_real_location(tree_folder).await {
        Ok(real_folder) => real_folder,
        Err(source) => {
            return vec![TreeRecordRemovalError {
                path: tree_folder.to_path_buf(),
                source,
            }];
        }
    };
    let names = match read_folder_names(&records_folder).await {
        Ok(names) => names,
        Err(source) => {
            return vec![TreeRecordRemovalError {
                path: records_folder,
                source,
            }];
        }
    };
    let mut failures = Vec::new();
    for name in names {
        let record_folder = records_folder.join(name);
        let is_tree_record = match read_record_git_file(&record_folder).await {
            Ok(Some(git_file)) => is_contained_within(&git_file, &real_folder),
            Ok(None) => false,
            Err(source) if source.kind() == io::ErrorKind::InvalidData => {
                skip_unreadable_record(&source);
                false
            }
            Err(source) => {
                failures.push(TreeRecordRemovalError {
                    path: record_folder,
                    source,
                });
                continue;
            }
        };
        if is_tree_record && let Err(source) = remove_folder(&record_folder).await {
            failures.push(TreeRecordRemovalError {
                path: record_folder,
                source,
            });
        }
    }
    failures
}

/// Whether a record in `common_git_folder` names a `.git` in `tree_folder`, as one a crash left
/// for a tree whose folder is gone does. Fails with a listing's or a record's read.
pub(crate) async fn has_record_naming(
    common_git_folder: &Path,
    tree_folder: &Path,
) -> io::Result<bool> {
    let records_folder = common_git_folder.join(LINKED_RECORDS_FOLDER_NAME);
    let real_folder = resolve_real_location(tree_folder).await?;
    for name in read_folder_names(&records_folder).await? {
        let record_folder = records_folder.join(name);
        let git_file = match read_record_git_file(&record_folder).await {
            Ok(git_file) => git_file,
            Err(source) if source.kind() == io::ErrorKind::InvalidData => {
                skip_unreadable_record(&source);
                None
            }
            Err(source) => return Err(source),
        };
        if git_file.is_some_and(|git_file| is_contained_within(&git_file, &real_folder)) {
            return Ok(true);
        }
    }
    Ok(false)
}

// A record whose `gitdir` cannot be resolved names no tree the daemon made, since the daemon's
// trees have paths it can resolve, so it is left as the person's and passed over.
fn skip_unreadable_record(source: &io::Error) {
    tracing::debug!(
        error = source as &(dyn std::error::Error + 'static),
        "a worktree record whose gitdir cannot be resolved is passed over"
    );
}
