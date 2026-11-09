//! Git's records of a tree the daemon made, found by the `.git` their `gitdir` names rather than
//! from inside the tree, so a tree git left without its `.git` file, or one already removed, still
//! has its records found. A record naming any other tree is never touched. The daemon's own adds,
//! its put-backs' records and the cleanup's reads and removals of records and their refs take one
//! hold per repository, so none reads a record another is between writing.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use sidekicks_std::file::real_location::resolve_real_location;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_std::missing_entry::is_missing_entry;
use tokio::io::AsyncReadExt as _;

use crate::git::worktree::folder_names::read_folder_names;
use crate::git::worktree::reads::{LINKED_RECORDS_FOLDER_NAME, read_record_git_file};
use crate::trust_envelope::is_contained_within;

/// The file in a git folder holding its index, the staging area.
pub(crate) const INDEX_FILE_NAME: &str = "index";

// Git's index header: the signature, the format's version and the count of entries, each a 32-bit
// word in network byte order.
const INDEX_SIGNATURE: &[u8; 4] = b"DIRC";
const INDEX_HEADER_LENGTH: usize = 12;

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

/// Holds the records as [`hold_records`] does, at once: `None` while another holds or waits on
/// them. Fails when the folder cannot be resolved.
pub(crate) async fn try_hold_records(
    common_git_folder: &Path,
) -> io::Result<Option<KeyHold<'static, PathBuf>>> {
    let key = resolve_real_location(common_git_folder).await?;
    Ok(RECORD_WRITES.try_acquire(key).ok())
}

/// The entries git's index in the tree's record folder `record_folder` lists, read from the index's
/// header: the files git tracks there, never untracked or ignored ones. A record with no index
/// lists none. Fails when the index cannot be read or its header is not an index's.
pub(crate) async fn read_index_entry_count(record_folder: &Path) -> io::Result<u64> {
    let mut index = match tokio::fs::File::open(record_folder.join(INDEX_FILE_NAME)).await {
        Ok(index) => index,
        Err(failure) if is_missing_entry(&failure) => return Ok(0),
        Err(failure) => return Err(failure),
    };
    let mut header = [0_u8; INDEX_HEADER_LENGTH];
    index.read_exact(&mut header).await?;
    let (signature, words) = header.split_at(INDEX_SIGNATURE.len());
    if signature != INDEX_SIGNATURE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the tree's index does not start with git's index signature",
        ));
    }
    let entry_count: [u8; 4] = words[4..].try_into().expect("the header holds three words");
    Ok(u64::from(u32::from_be_bytes(entry_count)))
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
                skip_unreadable_record(&record_folder, &source);
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
        if is_tree_record
            && let Err(source) = sidekicks_std::file::remove_tree_awaited(&record_folder).await
        {
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
                skip_unreadable_record(&record_folder, &source);
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
fn skip_unreadable_record(record_folder: &Path, source: &io::Error) {
    tracing::debug!(
        record = %record_folder.display(),
        error = source as &(dyn std::error::Error + 'static),
        "a worktree record whose gitdir cannot be resolved is passed over"
    );
}

#[cfg(test)]
mod tests {
    use sidekicks_platforms::real_path;

    use super::{INDEX_FILE_NAME, read_index_entry_count};
    use crate::git::process::test_git_runner;
    use crate::git::process::test_repository::{commit_empty, git_in, make_test_repository};

    // A linked tree's record holds an index whose header counts the files git tracks there, and
    // not the untracked or ignored ones; a record with no index counts none, and a file that is
    // not an index is refused. Killed by a word read at the wrong offset or in the wrong byte order,
    // and by a missing index read as a failure.
    #[tokio::test]
    async fn a_record_counts_the_tracked_entries_of_its_tree_index() {
        let git = test_git_runner();
        let temporary = tempfile::tempdir().expect("the temporary folder is made");
        let root = real_path(temporary.path()).expect("the temporary folder resolves");
        let repository = make_test_repository(&git, &root, "repository").await;
        for name in ["a.txt", "b.txt", "c.txt", ".gitignore"] {
            std::fs::write(repository.join(name), "ignored.txt\n").expect("a file is written");
        }
        git_in(&git, &repository, &["add", "."]).await;
        commit_empty(&git, &repository, "files").await;
        let tree = root.join("linked");
        let tree_path = tree.to_str().expect("the test's folders are UTF-8");
        git_in(
            &git,
            &repository,
            &["worktree", "add", "--quiet", "--detach", tree_path],
        )
        .await;
        std::fs::write(tree.join("untracked.txt"), "").expect("an untracked file is written");
        std::fs::write(tree.join("ignored.txt"), "").expect("an ignored file is written");
        let record_folder = repository.join(".git").join("worktrees").join("linked");

        assert_eq!(
            read_index_entry_count(&record_folder)
                .await
                .expect("the index reads"),
            4
        );

        std::fs::remove_file(record_folder.join(INDEX_FILE_NAME)).expect("the index is removed");
        assert_eq!(
            read_index_entry_count(&record_folder)
                .await
                .expect("no index reads"),
            0
        );
        std::fs::write(record_folder.join(INDEX_FILE_NAME), [0_u8; 12]).expect("a file is written");
        assert!(read_index_entry_count(&record_folder).await.is_err());
    }
}
