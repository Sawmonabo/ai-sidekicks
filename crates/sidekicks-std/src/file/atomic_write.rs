//! Replaces a file so that a crash at any moment leaves the old contents or the new, never half of
//! either and never neither: the platform's crash-safe replace writes and renames it, and then the
//! folder itself is flushed where the system can flush one, since until then the rename lives only
//! in memory and a power loss can undo it. [`write_without_flush`] flushes neither, for a record
//! read only while its process lives, which a process crash leaves whole or as it was.

use std::io;
use std::path::{Path, PathBuf};

use sidekicks_platforms::LeftoverSweep;
use tokio::task::JoinError;

use crate::cleanup_failures::CleanupFailures;
use crate::missing_entry::is_missing_entry;

/// Why a crash-safe write failed.
#[derive(Debug, thiserror::Error)]
pub enum AtomicWriteError {
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
/// Windows), durably and all at once. `file_path` is absolute and its folder must exist. A failure
/// before the rename removes the temporary file `<name>.<random>.tmp` and leaves the old file in
/// place. `contents` is moved to the write and dropped there, so a buffer that wipes itself on drop
/// leaves no copy behind.
pub async fn write_file_atomically(
    file_path: &Path,
    contents: impl AsRef<[u8]> + Send + 'static,
    mode: u32,
) -> Result<(), AtomicWriteError> {
    let target = file_path.to_path_buf();
    match tokio::task::spawn_blocking(move || write_and_flush(&target, contents.as_ref(), mode))
        .await
    {
        Ok(written) => written,
        Err(failure) => Err(AtomicWriteError::Interrupted {
            path: file_path.to_path_buf(),
            failure,
        }),
    }
}

/// Replaces the file `file_path` reaches, through any link to it, with `contents` as
/// [`write_file_atomically`] does, the new file taking that file's mode less the umask, so a
/// person's own file keeps its link and its mode; a file not there yet is made with
/// `new_file_mode`. Fails as [`write_file_atomically`] does, a failed resolve or mode read included
/// as [`AtomicWriteError::Write`].
pub async fn rewrite_file_in_place(
    file_path: &Path,
    contents: impl AsRef<[u8]> + Send + 'static,
    new_file_mode: u32,
) -> Result<(), AtomicWriteError> {
    let path = file_path.to_path_buf();
    match tokio::task::spawn_blocking(move || {
        let resolved = sidekicks_platforms::real_path(&path).and_then(|target| {
            let mode = sidekicks_platforms::file_mode(&target)?;
            Ok((target, mode))
        });
        let (target, mode) = match resolved {
            Ok(resolved) => resolved,
            Err(failure) if is_missing_entry(&failure) => (path, new_file_mode),
            Err(failure) => {
                return Err(AtomicWriteError::Write {
                    path,
                    failure: CleanupFailures::new(failure, Vec::new(), "reading the file's mode"),
                });
            }
        };
        write_and_flush(&target, contents.as_ref(), mode)
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

/// Replaces `file_path` with `contents` as [`write_file_atomically`] does, unless it already holds
/// exactly them with exactly `mode`, so a reader that has the file open never meets a rewrite it
/// did not need. A file that cannot be read is replaced. Fails as [`write_file_atomically`] does.
pub async fn write_file_atomically_if_changed(
    file_path: &Path,
    contents: &'static [u8],
    mode: u32,
) -> Result<(), AtomicWriteError> {
    let held_path = file_path.to_path_buf();
    let is_held = tokio::task::spawn_blocking(move || {
        std::fs::read(&held_path).is_ok_and(|held| held == contents)
            && matches!(
                sidekicks_platforms::has_file_mode(&held_path, mode),
                Ok(true)
            )
    })
    .await
    .map_err(|failure| AtomicWriteError::Interrupted {
        path: file_path.to_path_buf(),
        failure,
    })?;
    if is_held {
        return Ok(());
    }
    write_file_atomically(file_path, contents, mode).await
}

/// Replaces `target` with `contents` as [`write_file_atomically`] does, on the calling thread: the
/// file replaced, then its folder flushed. Fails as [`write_file_atomically`] does, never with
/// [`AtomicWriteError::Interrupted`].
pub fn write_and_flush(target: &Path, contents: &[u8], mode: u32) -> Result<(), AtomicWriteError> {
    // No sweep of leftovers runs in the folders these writes go to, the person's own among them.
    sidekicks_platforms::replace_file_atomically(target, contents, mode, LeftoverSweep::Unswept)
        .map_err(|error| write_failure(target, error))?;
    flush_folder_of(target)
}

/// Replaces `target` with `contents` as [`write_and_flush`] does, but flushes neither the file nor
/// its folder, so a system crash or power loss may leave it empty, partial or as it was; for a
/// record its readers take only while its process lives. Fails as [`write_and_flush`] does, never
/// with [`AtomicWriteError::FlushFolder`].
pub fn write_without_flush(
    target: &Path,
    contents: &[u8],
    mode: u32,
) -> Result<(), AtomicWriteError> {
    // No sweep of leftovers runs in the folders these writes go to.
    sidekicks_platforms::replace_file_atomically_without_flush(
        target,
        contents,
        mode,
        LeftoverSweep::Unswept,
    )
    .map_err(|error| write_failure(target, error))
}

/// Replaces the existing file `target` with `contents` as [`write_and_flush`] does, the new file
/// keeping the old one's permissions, but only while `is_current`, asked just before the rename,
/// answers `true`; on `false` nothing is written and the call answers `false`. Fails as
/// [`write_and_flush`] does, and with `is_current`'s own error as a write failure.
pub fn write_and_flush_while(
    target: &Path,
    contents: &[u8],
    is_current: impl FnOnce() -> io::Result<bool>,
) -> Result<bool, AtomicWriteError> {
    let is_written = sidekicks_platforms::replace_file_atomically_while(
        target,
        contents,
        LeftoverSweep::Unswept,
        is_current,
    )
    .map_err(|error| write_failure(target, error))?;
    if is_written {
        flush_folder_of(target)?;
    }
    Ok(is_written)
}

// The platform write's failure, with any failure to remove its temporary file, as the write of
// `target`.
fn write_failure(target: &Path, error: sidekicks_platforms::AtomicWriteError) -> AtomicWriteError {
    AtomicWriteError::Write {
        path: target.to_path_buf(),
        failure: CleanupFailures::new(
            error.failure,
            error.removal_failure.into_iter().collect(),
            "writing the file",
        ),
    }
}

// Flushes the folder `target` was just renamed into, so a power loss cannot undo the rename.
fn flush_folder_of(target: &Path) -> Result<(), AtomicWriteError> {
    let folder = target
        .parent()
        .expect("a path ending in a file name has the folder before it");
    sidekicks_platforms::flush_folder(folder).map_err(|failure| AtomicWriteError::FlushFolder {
        path: target.to_path_buf(),
        failure,
    })
}

#[cfg(test)]
mod tests {
    use sidekicks_platforms::{has_file_mode, make_file_link};

    use super::{rewrite_file_in_place, write_file_atomically, write_file_atomically_if_changed};

    // Fails when only the bytes are compared, so a file holding the app's contents under a wider
    // mode keeps it.
    #[tokio::test]
    async fn a_file_with_the_same_bytes_and_another_mode_is_rewritten_with_the_mode() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let file = folder.path().join("script");
        write_file_atomically(&file, b"contents", 0o644)
            .await
            .expect("the open file is written");

        write_file_atomically_if_changed(&file, b"contents", 0o600)
            .await
            .expect("the file is checked");

        assert!(has_file_mode(&file, 0o600).expect("the file's mode reads"));
    }

    // Fails when the rewrite takes the new-file mode over the file's own, so a file the person
    // keeps private is left readable to others.
    #[tokio::test]
    async fn a_rewrite_keeps_the_files_own_mode_and_a_new_file_takes_the_given_one() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let kept = folder.path().join("kept.json");
        write_file_atomically(&kept, b"{}", 0o600)
            .await
            .expect("the private file is written");

        rewrite_file_in_place(&kept, b"{\"a\":1}", 0o644)
            .await
            .expect("the file is rewritten");
        let made = folder.path().join("made.json");
        rewrite_file_in_place(&made, b"{}", 0o640)
            .await
            .expect("the new file is written");

        assert_eq!(std::fs::read(&kept).expect("the file reads"), b"{\"a\":1}");
        assert!(has_file_mode(&kept, 0o600).expect("the file's mode reads"));
        assert!(has_file_mode(&made, 0o640).expect("the new file's mode reads"));
    }

    // Fails when the rewrite replaces the link with a file of its own, so a settings file linked
    // into the person's dotfiles stops following them.
    #[tokio::test]
    async fn a_rewrite_through_a_link_writes_its_target_and_keeps_the_link() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let target = folder.path().join("dotfiles.json");
        write_file_atomically(&target, b"{}", 0o600)
            .await
            .expect("the target is written");
        let link = folder.path().join("settings.json");
        make_file_link(&target, &link).expect("the link is made");

        rewrite_file_in_place(&link, b"{\"a\":1}", 0o644)
            .await
            .expect("the file is rewritten through its link");

        let link_metadata = std::fs::symlink_metadata(&link).expect("the link reads");
        assert!(link_metadata.file_type().is_symlink());
        assert_eq!(
            std::fs::read(&target).expect("the target reads"),
            b"{\"a\":1}"
        );
    }
}
