//! Writes a file so that a crash at any moment leaves it whole or as it was, never half written: a
//! temporary file beside it is written and flushed to disk, then renamed over the target, or linked
//! to the target's name only where no file stands there. Flushing the folder, which makes the
//! rename or link itself durable, is the caller's.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::Path;

use tempfile::TempPath;

use crate::{create_new_file, flush_open_file, rename_replacing};

/// Why a crash-safe write failed; the target keeps its old contents, or stays absent.
#[derive(Debug, thiserror::Error)]
#[error("{failure}{}", removal_note(.removal_failure.as_ref()))]
pub struct AtomicWriteError {
    /// Making, locking, writing, flushing, renaming or linking the temporary file failed.
    #[source]
    pub failure: io::Error,
    /// Removing the temporary file after that failure failed too.
    pub removal_failure: Option<io::Error>,
}

/// Replaces `target` with `contents`, a new file made with `mode` less the umask (unused on
/// Windows), written through a temporary file `<name>.<random>.tmp` beside it. `target` ends in a
/// file name and its folder exists. Blocks; a failure removes the temporary file and leaves the old
/// file in place.
pub fn replace_file_atomically(
    target: &Path,
    contents: &[u8],
    mode: u32,
) -> Result<(), AtomicWriteError> {
    let mut temporary_path = write_temporary(target, contents, mode, <File as Write>::write_all)?;
    if let Err(failure) = rename_replacing(&temporary_path, target) {
        return Err(remove_temporary_after(failure, temporary_path));
    }
    // The temporary name is the target's now, so nothing is left to remove.
    temporary_path.disable_cleanup(true);
    Ok(())
}

/// Makes `target` holding `contents` as [`replace_file_atomically`] writes it, unless a file
/// already stands there: then it fails with `io::ErrorKind::AlreadyExists` and leaves that file as
/// it is. Blocks; a failure removes the temporary file.
pub fn create_file_atomically(
    target: &Path,
    contents: &[u8],
    mode: u32,
) -> Result<(), AtomicWriteError> {
    create_file_atomically_through(target, contents, mode, <File as Write>::write_all)
}

/// Removes every temporary file a write left in `folder` to a target whose file name `is_target`
/// takes, as a process ended mid-write leaves one, running on past a removal that fails. It takes
/// a live write's temporary file too, so it runs only while no write to such a target does.
/// Blocks; answers the folder's listing failure or each removal's, none once every leftover is
/// gone.
pub fn remove_atomic_write_leftovers(
    folder: &Path,
    is_target: impl Fn(&str) -> bool,
) -> Vec<io::Error> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(missing) if missing.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(failure) => return vec![failure],
    };
    let mut failures = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(failure) => {
                failures.push(failure);
                break;
            }
        };
        let name = entry.file_name();
        let is_leftover = name
            .to_str()
            .and_then(atomic_write_target_of)
            .is_some_and(&is_target);
        if is_leftover
            && let Err(failure) = fs::remove_file(entry.path())
            && failure.kind() != io::ErrorKind::NotFound
        {
            failures.push(failure);
        }
    }
    failures
}

/// The file name of the target a crash-safe write's temporary file named `file_name` is for, as
/// [`replace_file_atomically`] names it; `None` for a name no such write makes.
pub fn atomic_write_target_of(file_name: &str) -> Option<&str> {
    let (target, random) = file_name.strip_suffix(TEMPORARY_SUFFIX)?.rsplit_once('.')?;
    (!target.is_empty() && !random.is_empty()).then_some(target)
}

// The suffix of a temporary file a write makes.
const TEMPORARY_SUFFIX: &str = ".tmp";

// `create_file_atomically`, its temporary file filled by `write`.
fn create_file_atomically_through(
    target: &Path,
    contents: &[u8],
    mode: u32,
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> Result<(), AtomicWriteError> {
    let temporary_path = write_temporary(target, contents, mode, write)?;
    temporary_path
        .persist_noclobber(target)
        .map_err(|refused| remove_temporary_after(refused.error, refused.path))
}

// The folder a write to `target` makes its temporary file in, and the file's name up to its random
// part.
fn temporary_place(target: &Path) -> (&Path, String) {
    let file_name = target
        .file_name()
        .expect("the caller's target ends in a file name");
    let folder = target
        .parent()
        .expect("a path ending in a file name has the folder before it");
    (folder, format!("{}.", file_name.to_string_lossy()))
}

// A temporary file beside `target` filled with `contents` by `write` and flushed to disk, its
// handle closed; a failure removes it.
fn write_temporary(
    target: &Path,
    contents: &[u8],
    mode: u32,
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> Result<TempPath, AtomicWriteError> {
    let (folder, prefix) = temporary_place(target);
    let mut temporary = tempfile::Builder::new()
        .prefix(&prefix)
        .suffix(TEMPORARY_SUFFIX)
        .make_in(folder, |path| create_new_file(path, mode))
        .map_err(|failure| AtomicWriteError {
            failure,
            removal_failure: None,
        })?;
    let written = write(temporary.as_file_mut(), contents)
        .and_then(|()| flush_open_file(temporary.as_file()));
    // The handle closes here, before any removal, which Windows needs to remove the file.
    let temporary_path = temporary.into_temp_path();
    match written {
        Ok(()) => Ok(temporary_path),
        Err(failure) => Err(remove_temporary_after(failure, temporary_path)),
    }
}

// Removes the temporary file after `failure`, keeping the removal's own failure beside it; a file
// already gone is no failure.
fn remove_temporary_after(failure: io::Error, temporary_path: TempPath) -> AtomicWriteError {
    let removal_failure = match temporary_path.close() {
        Ok(()) => None,
        Err(removal_failure) if removal_failure.kind() == io::ErrorKind::NotFound => None,
        Err(removal_failure) => Some(removal_failure),
    };
    AtomicWriteError {
        failure,
        removal_failure,
    }
}

fn removal_note(removal_failure: Option<&io::Error>) -> String {
    removal_failure.map_or_else(String::new, |removal_failure| {
        format!(", and removing the temporary file failed: {removal_failure}")
    })
}

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::io::{self, Write};

    use rstest::rstest;

    use super::{
        create_file_atomically_through, remove_atomic_write_leftovers, replace_file_atomically,
    };

    // A rename that cannot replace its target must leave the old target whole and no temporary
    // file beside it.
    #[test]
    fn a_failed_replace_leaves_the_old_target_and_no_temporary_file() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let target = scratch.path().join("target");
        fs::create_dir(&target).expect("the target folder is made");
        fs::write(target.join("kept"), b"kept").expect("the target's file is written");

        let failure = replace_file_atomically(&target, b"new", 0o600)
            .expect_err("a file cannot replace a folder");

        assert!(failure.removal_failure.is_none());
        assert_eq!(
            fs::read(target.join("kept")).expect("the target's file reads"),
            b"kept"
        );
        let entries = fs::read_dir(scratch.path())
            .expect("the scratch folder lists")
            .map(|entry| entry.expect("an entry reads").file_name())
            .collect::<Vec<_>>();
        assert_eq!(entries, ["target"]);
    }

    // A write the disk refuses partway: half the contents, then a failure.
    fn write_half_then_fail(file: &mut File, contents: &[u8]) -> io::Result<()> {
        file.write_all(&contents[..contents.len() / 2])?;
        Err(io::Error::from(io::ErrorKind::StorageFull))
    }

    // A file that stands is answered `AlreadyExists` and kept, and a write that fails partway
    // leaves neither the target nor a temporary file, so a reader never meets a short file. Killed
    // by writing at the target's own name, by replacing a file that stands, and by a temporary
    // file left behind.
    #[rstest]
    #[case::a_file_stands(Some(&b"standing"[..]), <File as Write>::write_all)]
    #[case::the_write_fails(None, write_half_then_fail)]
    fn a_file_is_created_whole_or_not_at_all(
        #[case] standing: Option<&[u8]>,
        #[case] write: fn(&mut File, &[u8]) -> io::Result<()>,
    ) {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let target = scratch.path().join("target");
        if let Some(standing) = standing {
            fs::write(&target, standing).expect("the standing file is written");
        }

        let failure = create_file_atomically_through(&target, b"made", 0o600, write)
            .expect_err("the create is refused");

        assert!(failure.removal_failure.is_none());
        assert_eq!(
            failure.failure.kind() == io::ErrorKind::AlreadyExists,
            standing.is_some(),
            "{failure}"
        );
        let entries: Vec<_> = fs::read_dir(scratch.path())
            .expect("the scratch folder lists")
            .map(|entry| entry.expect("an entry reads").file_name())
            .collect();
        assert_eq!(
            entries.len(),
            usize::from(standing.is_some()),
            "{entries:?}"
        );
        assert_eq!(fs::read(&target).ok().as_deref(), standing);
    }

    // The temporary files a write to a target left are removed, and nothing else beside them.
    // Killed by a sweep that misses a leftover or removes another file.
    #[test]
    fn the_leftovers_of_a_write_are_removed_and_nothing_else() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        for name in [
            "target.key",
            "target.key.a1b2c3.tmp",
            "other.key.a1b2c3.tmp",
        ] {
            fs::write(scratch.path().join(name), b"bytes").expect("written");
        }

        let failures = remove_atomic_write_leftovers(scratch.path(), |name| name == "target.key");

        assert!(failures.is_empty(), "{failures:?}");

        let mut entries: Vec<_> = fs::read_dir(scratch.path())
            .expect("the scratch folder lists")
            .map(|entry| entry.expect("an entry reads").file_name())
            .collect();
        entries.sort();
        assert_eq!(entries, ["other.key.a1b2c3.tmp", "target.key"]);
    }
}
