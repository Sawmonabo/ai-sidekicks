//! One file copied to a new path, as a clone where the file system makes one, never over an entry
//! already there and never leaving a partial copy at the path.

use std::ffi::OsString;
use std::fs::{self, File, Permissions};
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_platforms::create_new_file;

use crate::cleanup_failures::CleanupFailures;
use crate::file::clone_open_file::{CloneOpenFileError, NEW_COPY_MODE, clone_open_file};
use crate::file::publish_without_replacing::{PublishOutcome, blocking_publish_without_replacing};
use crate::file::removal_after_failure::remove_file_after_failure;
use crate::random_hex::random_hex;

// The random bytes in a fallback copy's temporary name, so two copies to one path never meet.
const TEMPORARY_NAME_RANDOM_BYTES: usize = 8;

// What a fallback copy's failure names as its operation.
const COPYING: &str = "copying the file";

/// Copies `source` to `destination`, keeping its mode: a clone where the file system makes one,
/// else a byte copy into a temporary file beside `destination` that takes its name only whole, so
/// a copy that fails partway, or is cut by a crash, never carries the name. Fails with the source's
/// open error, unchanged and before `destination` is touched, `AlreadyExists` when anything is at
/// `destination`, which is never replaced or removed, `NotFound` when the folder is missing, else
/// with the copy's or the naming's error; when removing a clone or a copy that failed partway fails
/// too, the error keeps the failure's kind and wraps a
/// [`CleanupFailures`](crate::cleanup_failures::CleanupFailures) holding both. `source` is a
/// regular file.
pub fn clone_or_copy(source: &Path, destination: &Path) -> io::Result<()> {
    let file = File::open(source)?;
    match clone_open_file(&file, destination) {
        Ok(()) => Ok(()),
        Err(CloneOpenFileError::Failed(failure))
            if matches!(
                failure.kind(),
                io::ErrorKind::AlreadyExists | io::ErrorKind::NotFound
            ) || is_cleanup_failure(&failure) =>
        {
            Err(failure)
        }
        // A file system that makes no clone, or refuses this one, still takes a byte copy; a
        // real problem fails the copy with its own error.
        Err(_clone_refused) => copy_then_publish(source, destination),
    }
}

// Whether `failure` carries a failed removal of what the clone made, which a byte copy would
// then find at the path.
fn is_cleanup_failure(failure: &io::Error) -> bool {
    failure
        .get_ref()
        .is_some_and(|inner| inner.is::<CleanupFailures<io::Error>>())
}

// Copies `source`'s bytes into a new temporary file beside `destination`, gives it `destination`'s
// name unless something has that name, then `source`'s mode, which a read-only source would
// otherwise carry onto the temporary name the publish removes; a failure removes the temporary
// file, and only that file.
fn copy_then_publish(source: &Path, destination: &Path) -> io::Result<()> {
    let temporary = temporary_path_beside(destination)?;
    let permissions = match copy_into_new_file(source, &temporary) {
        Ok(permissions) => permissions,
        Err(error) => {
            return Err(remove_file_after_failure(error, &temporary, COPYING).into_io_error());
        }
    };
    match blocking_publish_without_replacing(&temporary, destination)
        .map_err(CleanupFailures::into_io_error)?
    {
        PublishOutcome::Published => fs::set_permissions(destination, permissions),
        PublishOutcome::TargetExists => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "an entry is already at the copy's path",
        )),
    }
}

// A new name beside `destination`: `.<its name>.<random>.copying`.
fn temporary_path_beside(destination: &Path) -> io::Result<PathBuf> {
    let name = destination.file_name().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "the copy's path has no name")
    })?;
    let mut temporary_name = OsString::from(".");
    temporary_name.push(name);
    temporary_name.push(format!(
        ".{}.copying",
        random_hex(TEMPORARY_NAME_RANDOM_BYTES).map_err(io::Error::other)?
    ));
    Ok(destination.with_file_name(temporary_name))
}

// Copies `source`'s bytes into a file made new at `path`; answers `source`'s mode.
fn copy_into_new_file(source: &Path, path: &Path) -> io::Result<Permissions> {
    let mut reader = File::open(source)?;
    let permissions = reader.metadata()?.permissions();
    let mut copy = create_new_file(path, NEW_COPY_MODE)?;
    io::copy(&mut reader, &mut copy)?;
    Ok(permissions)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;

    use sidekicks_platforms::{is_superuser, make_unreadable};

    use super::{clone_or_copy, copy_then_publish};

    // Kills the truncating byte copy the clone falls back to.
    #[test]
    fn a_failed_copy_leaves_no_target_and_an_existing_target_keeps_its_bytes() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let unreadable = scratch.path().join("folder");
        fs::create_dir(&unreadable).expect("a folder whose read fails is made");
        let destination = scratch.path().join("destination");

        assert!(copy_then_publish(&unreadable, &destination).is_err());
        assert!(
            !destination.exists(),
            "a failed copy leaves nothing at the target"
        );
        assert_eq!(
            fs::read_dir(scratch.path())
                .expect("the scratch folder lists")
                .count(),
            1,
            "nor a temporary file beside it"
        );

        let source = scratch.path().join("source");
        fs::write(&source, b"the source's bytes").expect("the source is written");
        fs::write(&destination, b"written since").expect("the target is written");
        for copy in [clone_or_copy, copy_then_publish] {
            let refusal = copy(&source, &destination).expect_err("an entry is never replaced");
            assert_eq!(refusal.kind(), io::ErrorKind::AlreadyExists);
            assert_eq!(
                fs::read(&destination).expect("the target reads"),
                b"written since"
            );
        }

        fs::remove_file(&destination).expect("the target is removed");
        copy_then_publish(&source, &destination).expect("the copy is made");
        assert_eq!(
            fs::read(&destination).expect("the copy reads"),
            b"the source's bytes"
        );
    }

    // Fails when the target is removed before the source has opened, as a removal ahead of the
    // byte copy would remove it whenever the source cannot be read.
    #[test]
    fn a_source_that_does_not_open_leaves_an_existing_target_whole() {
        if is_superuser() {
            return;
        }
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let source = scratch.path().join("source");
        fs::write(&source, b"the source's bytes").expect("the source is written");
        let destination = scratch.path().join("destination");
        fs::write(&destination, b"written before").expect("the target is written");
        let _unreadable = make_unreadable(&source).expect("the source is made unreadable");

        let refusal =
            clone_or_copy(&source, &destination).expect_err("an unreadable source is not copied");
        assert_eq!(refusal.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            fs::read(&destination).expect("the target reads"),
            b"written before"
        );
    }
}
