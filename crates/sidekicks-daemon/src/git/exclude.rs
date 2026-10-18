//! A repository's own exclude list, `<common git folder>/info/exclude`, which git reads like a
//! `.gitignore` and never commits: a file the daemon writes into a working folder is listed there,
//! so it stays on this machine, and the person's tracked `.gitignore` is never touched.

use std::io;
use std::path::{Path, PathBuf};

use crate::file::atomic_write::{AtomicWriteError, write_file_atomically};
use crate::keyed_lock::KeyedLock;
use crate::missing_entry::MissingEntry;

// The list is the person's to read, as git leaves it.
const EXCLUDE_FILE_MODE: u32 = 0o644;

/// Why a pattern could not be added to a repository's exclude list.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ExcludeError {
    /// The list could not be read.
    #[error("reading the repository's exclude list {} failed", path.display())]
    Read {
        /// The list.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        failure: io::Error,
    },
    /// The list's folder could not be made.
    #[error("making the folder of the repository's exclude list {} failed", path.display())]
    CreateFolder {
        /// The list.
        path: PathBuf,
        /// The file system's failure.
        #[source]
        failure: io::Error,
    },
    /// The list could not be written.
    #[error("writing the repository's exclude list failed")]
    Write(#[source] AtomicWriteError),
}

/// Adds `pattern` as a line of `common_git_folder`'s exclude list unless a line already reads
/// exactly it, holding `lock` on the list's path across the read and the write, so two writers
/// never drop each other's line.
pub(crate) async fn add_repository_exclude(
    common_git_folder: &Path,
    pattern: &str,
    lock: &KeyedLock<PathBuf>,
) -> Result<(), ExcludeError> {
    let exclude_path = common_git_folder.join("info").join("exclude");
    let _hold = lock.acquire(exclude_path.clone()).await;
    let text = tokio::fs::read_to_string(&exclude_path)
        .await
        .none_if_missing()
        .map_err(|failure| ExcludeError::Read {
            path: exclude_path.clone(),
            failure,
        })?
        .unwrap_or_default();
    if text.lines().any(|line| line == pattern) {
        return Ok(());
    }
    if let Some(folder) = exclude_path.parent() {
        tokio::fs::create_dir_all(folder)
            .await
            .map_err(|failure| ExcludeError::CreateFolder {
                path: exclude_path.clone(),
                failure,
            })?;
    }
    let separator = if text.is_empty() || text.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    write_file_atomically(
        &exclude_path,
        format!("{text}{separator}{pattern}\n"),
        EXCLUDE_FILE_MODE,
    )
    .await
    .map_err(ExcludeError::Write)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::add_repository_exclude;
    use crate::keyed_lock::KeyedLock;

    #[tokio::test]
    async fn a_pattern_lands_once_after_the_lists_last_line() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let exclude_path = scratch.path().join("info").join("exclude");
        std::fs::create_dir_all(scratch.path().join("info")).expect("the info folder is made");
        std::fs::write(&exclude_path, "# git's own comment").expect("the list is written");
        let lock = KeyedLock::<PathBuf>::new();

        for _ in 0..2 {
            add_repository_exclude(scratch.path(), "/.claude/settings.local.json", &lock)
                .await
                .expect("the pattern is added");
        }

        assert_eq!(
            std::fs::read_to_string(&exclude_path).expect("the list reads"),
            "# git's own comment\n/.claude/settings.local.json\n"
        );
    }
}
