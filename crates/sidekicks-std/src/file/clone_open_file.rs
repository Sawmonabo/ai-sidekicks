//! An open file cloned to a new path and never byte-copied, so the copy shares the file's blocks
//! and costs no room, and a clone the system refuses says why.

use std::fs::File;
use std::io;
use std::path::Path;

use sidekicks_platforms::{CloneRefusal, read_clone_refusal};

use crate::cleanup_failures::CleanupFailures;
use crate::file::removal_after_failure::remove_file_after_failure;

/// Why an open file was not cloned.
#[derive(Debug, thiserror::Error)]
pub enum CloneOpenFileError {
    /// The system refused the clone: the copy's place is on another volume, or the volume makes no
    /// clones.
    #[error("the clone was refused: {0}")]
    Refused(CloneRefusal),
    /// The clone failed for any other reason, an entry already at the path or a missing folder
    /// among them.
    #[error("the clone failed")]
    Failed(#[source] io::Error),
}

// What a failed clone names as its operation when removing what it left fails too.
const CLONING: &str = "cloning the file";

/// Clones the open file `source` into a new file at `destination`, which takes the source's
/// permissions, never as a byte copy and never over an entry already there; a failed clone leaves
/// nothing at the path unless removing what it left there fails. Fails with
/// [`CloneOpenFileError::Refused`] when the copy's place is on another volume or the volume makes
/// no clones, else with [`CloneOpenFileError::Failed`] holding the clone's error, of its own kind.
/// The removal runs after every failure but an entry already at the path, so it also runs when the
/// clone made no file at all; when it fails (the clone was made and setting its permissions failed,
/// or the folder refuses the removal), the answer is `Failed`, a refused clone's included, wrapping
/// the removal's failure beside the clone's. `source` is a regular file: on Linux and Windows the
/// clone answers any other kind of source with `InvalidInput`, which hides an entry already at the
/// path, so that entry would be removed.
pub fn clone_open_file(source: &File, destination: &Path) -> Result<(), CloneOpenFileError> {
    reflink_copy::reflink_file_to_path(source, destination).map_err(|error| {
        // The entry already there is another's, so it stays.
        if error.kind() == io::ErrorKind::AlreadyExists {
            return CloneOpenFileError::Failed(error);
        }
        // The clone's permissions are set once its file is made, so a failure there, refusal or
        // not, leaves that file at `destination` for this removal.
        let (error, removal_failures, operation) =
            remove_file_after_failure(error, destination, CLONING).into_parts();
        if !removal_failures.is_empty() {
            return CloneOpenFileError::Failed(
                CleanupFailures::new(error, removal_failures, operation).into_io_error(),
            );
        }
        match read_clone_refusal(source, destination, error) {
            Ok(refusal) => CloneOpenFileError::Refused(refusal),
            Err(error) => CloneOpenFileError::Failed(error),
        }
    })
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::io;
    use std::path::Path;

    use sidekicks_platforms::{CloneRefusal, harness_test_name, scratch_volume};

    use super::{CloneOpenFileError, clone_open_file};

    // Fails when a byte copy stands in for the clone, since a copy crosses volumes where a clone
    // cannot, when the refusal goes unread, and when a failed clone leaves a file at the path.
    #[test]
    fn a_clone_across_volumes_is_refused_and_leaves_nothing_at_the_path() {
        let Some(volume) = scratch_volume(
            &harness_test_name(
                module_path!(),
                "a_clone_across_volumes_is_refused_and_leaves_nothing_at_the_path",
            ),
            Path::new("scratch"),
        ) else {
            return;
        };
        let source_path = volume.root().join("source");
        fs::write(&source_path, b"the source's bytes").expect("the source is written");
        let source = File::open(&source_path).expect("the source opens");
        let destination = volume.mount_point().join("copy");

        let refusal =
            clone_open_file(&source, &destination).expect_err("a clone never crosses volumes");
        assert!(
            matches!(
                refusal,
                CloneOpenFileError::Refused(CloneRefusal::AcrossVolumes)
            ),
            "{refusal:?}"
        );
        assert_eq!(
            fs::symlink_metadata(&destination)
                .expect_err("nothing is at the path")
                .kind(),
            io::ErrorKind::NotFound
        );
        assert_eq!(
            fs::read(&source_path).expect("the source reads"),
            b"the source's bytes"
        );
    }
}
