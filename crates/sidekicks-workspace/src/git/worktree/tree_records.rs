//! Git's records of a tree the daemon made, found by the `.git` their `gitdir` names rather than
//! from inside the tree, so a tree git left without its `.git` file, or one already removed, still
//! has its records found. A record naming any other tree is never touched.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_platforms::real_path;

use crate::git::worktree::folder_names::read_folder_names;
use crate::git::worktree::reads::{LINKED_RECORDS_FOLDER_NAME, read_record_git_file};
use crate::git::worktree::service::remove_folder;
use crate::trust_envelope::is_contained_within;

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
    let real_folder = match real_tree_folder(tree_folder).await {
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

// `tree_folder` as git's records name it, from real paths: its parent's real path joined with its
// name, so a tree already removed still resolves.
async fn real_tree_folder(tree_folder: &Path) -> io::Result<PathBuf> {
    let (Some(parent), Some(name)) = (tree_folder.parent(), tree_folder.file_name()) else {
        return Ok(tree_folder.to_path_buf());
    };
    let parent = parent.to_path_buf();
    let real_parent = tokio::task::spawn_blocking(move || real_path(&parent))
        .await
        .map_err(io::Error::other)??;
    Ok(real_parent.join(name))
}
