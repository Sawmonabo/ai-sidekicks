//! Replaces a file so that a crash at any moment leaves the old contents or the new, never half of
//! either and never neither: a temporary file beside it is written and flushed to disk, renamed
//! over it, and then the folder itself is flushed where the system can flush one, since until then
//! the rename lives only in memory and a power loss can undo it.

use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use tempfile::TempPath;
use tokio::task::JoinError;

use crate::cleanup_failures::CleanupFailures;
use crate::missing_entry::MissingEntry;

/// Why a crash-safe write failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum AtomicWriteError {
    /// Making, writing, flushing or renaming the temporary file failed, so the target keeps its
    /// old contents; the temporary file's removal failure, if any, rides beside it.
    #[error("writing {} failed", path.display())]
    Write {
        /// The file written.
        path: PathBuf,
        /// The file system's failure, with any failure to remove the temporary file.
        #[source]
        failure: CleanupFailures<io::Error>,
    },
    /// The target already holds its new contents, but flushing its folder to disk failed, so a
    /// power loss could still bring the old contents back.
    #[error("{} was written, but flushing its folder to disk failed", path.display())]
    FlushFolder {
        /// The file written.
        path: PathBuf,
        /// The folder flush's own failure.
        #[source]
        failure: io::Error,
    },
    /// The blocking task that wrote the file ended before it finished.
    #[error("the write of {} ended before it finished", path.display())]
    Interrupted {
        /// The file written.
        path: PathBuf,
        /// Why the task ended.
        #[source]
        failure: JoinError,
    },
}

/// Replaces `file_path` with `contents`, a new file made with `mode` less the umask (unused on
/// Windows), durably and all at once. `file_path` ends in a file name and its folder must exist. A
/// failure before the rename removes the temporary file `<name>.<random>.tmp` and leaves the old
/// file in place.
pub(crate) async fn write_file_atomically(
    file_path: &Path,
    contents: impl Into<Vec<u8>>,
    mode: u32,
) -> Result<(), AtomicWriteError> {
    let file_name = file_path
        .file_name()
        .expect("every caller joins a fixed file name onto its folder");
    let folder = file_path
        .parent()
        .expect("a path ending in a file name has the folder before it");
    let mut prefix = file_name.to_os_string();
    prefix.push(".");
    let target = file_path.to_path_buf();
    let folder = folder.to_path_buf();
    let contents = contents.into();
    match tokio::task::spawn_blocking(move || {
        write_and_replace(&target, &folder, &prefix, &contents, mode)
    })
    .await
    {
        Ok(written) => written,
        Err(failure) => Err(AtomicWriteError::Interrupted {
            path: file_path.to_path_buf(),
            failure,
        }),
    }
}

// The whole write, blocking: the temporary file made, written and flushed, renamed over the target,
// then the folder flushed.
fn write_and_replace(
    target: &Path,
    folder: &Path,
    prefix: &OsStr,
    contents: &[u8],
    mode: u32,
) -> Result<(), AtomicWriteError> {
    let write_failure = |failure: CleanupFailures<io::Error>| AtomicWriteError::Write {
        path: target.to_path_buf(),
        failure,
    };
    let mut temporary = tempfile::Builder::new()
        .prefix(prefix)
        .suffix(".tmp")
        .make_in(folder, |path| {
            sidekicks_platforms::create_new_file(path, mode)
        })
        .map_err(|failure| write_failure(CleanupFailures::new(failure, Vec::new(), WRITING)))?;
    let written = temporary
        .as_file_mut()
        .write_all(contents)
        .and_then(|()| sidekicks_platforms::flush_open_file(temporary.as_file()));
    // The handle closes here, before any removal, which Windows needs to remove the file.
    let mut temporary_path = temporary.into_temp_path();
    if let Err(failure) = written {
        return Err(write_failure(remove_temporary_after(
            failure,
            temporary_path,
        )));
    }
    if let Err(failure) = sidekicks_platforms::rename_replacing(&temporary_path, target) {
        return Err(write_failure(remove_temporary_after(
            failure,
            temporary_path,
        )));
    }
    // The temporary name is the target's now, so nothing is left to remove.
    temporary_path.disable_cleanup(true);
    sidekicks_platforms::flush_folder(folder).map_err(|failure| AtomicWriteError::FlushFolder {
        path: target.to_path_buf(),
        failure,
    })
}

// Removes the temporary file after `failure`, keeping the removal's own failure beside it; a file
// already gone is no failure.
fn remove_temporary_after(
    failure: io::Error,
    temporary_path: TempPath,
) -> CleanupFailures<io::Error> {
    let removal_failures = match temporary_path.close().none_if_missing() {
        Ok(_) => Vec::new(),
        Err(removal_failure) => vec![removal_failure],
    };
    CleanupFailures::new(failure, removal_failures, WRITING)
}

// What a write's failure names as its operation.
const WRITING: &str = "writing the file";

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{AtomicWriteError, write_file_atomically};

    // A rename that cannot replace its target must leave the old target whole and no temporary
    // file beside it.
    #[tokio::test]
    async fn a_failed_replace_leaves_the_old_target_and_no_temporary_file() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let target = scratch.path().join("target");
        fs::create_dir(&target).expect("the target folder is made");
        fs::write(target.join("kept"), b"kept").expect("the target's file is written");

        let failure = write_file_atomically(&target, "new", 0o600)
            .await
            .expect_err("a file cannot replace a folder");

        assert!(matches!(failure, AtomicWriteError::Write { .. }));
        assert_eq!(
            fs::read(target.join("kept")).expect("the target's file reads"),
            b"kept"
        );
        let leftovers = fs::read_dir(scratch.path())
            .expect("the scratch folder lists")
            .map(|entry| {
                entry
                    .expect("an entry reads")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .filter(|name| name.starts_with("target.") && name.ends_with(".tmp"))
            .collect::<Vec<_>>();
        assert_eq!(leftovers, Vec::<String>::new());
    }
}
