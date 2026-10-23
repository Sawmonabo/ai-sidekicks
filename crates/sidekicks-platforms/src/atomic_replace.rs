//! Replaces a file so that a crash at any moment leaves the old contents or the new, never half of
//! either and never neither: a temporary file beside it is written and flushed to disk, then
//! renamed over it. Flushing the folder, which makes the rename itself durable, is the caller's.

use std::io::{self, Write};
use std::path::Path;

use tempfile::TempPath;

use crate::{create_new_file, flush_open_file, rename_replacing};

/// The suffix of the temporary file a replace writes before its rename, which a watch for renamed
/// records leaves out.
pub(crate) const TEMPORARY_FILE_SUFFIX: &str = ".tmp";

/// Why a crash-safe replace failed; the target keeps its old contents.
#[derive(Debug, thiserror::Error)]
#[error("{failure}{}", removal_note(.removal_failure.as_ref()))]
pub struct ReplaceFileError {
    /// Making, writing, flushing or renaming the temporary file failed.
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
) -> Result<(), ReplaceFileError> {
    let file_name = target
        .file_name()
        .expect("the caller's target ends in a file name");
    let folder = target
        .parent()
        .expect("a path ending in a file name has the folder before it");
    let mut prefix = file_name.to_os_string();
    prefix.push(".");
    let mut temporary = tempfile::Builder::new()
        .prefix(&prefix)
        .suffix(TEMPORARY_FILE_SUFFIX)
        .make_in(folder, |path| create_new_file(path, mode))
        .map_err(|failure| ReplaceFileError {
            failure,
            removal_failure: None,
        })?;
    let written = temporary
        .as_file_mut()
        .write_all(contents)
        .and_then(|()| flush_open_file(temporary.as_file()));
    // The handle closes here, before any removal, which Windows needs to remove the file.
    let mut temporary_path = temporary.into_temp_path();
    if let Err(failure) = written {
        return Err(remove_temporary_after(failure, temporary_path));
    }
    if let Err(failure) = rename_replacing(&temporary_path, target) {
        return Err(remove_temporary_after(failure, temporary_path));
    }
    // The temporary name is the target's now, so nothing is left to remove.
    temporary_path.disable_cleanup(true);
    Ok(())
}

// Removes the temporary file after `failure`, keeping the removal's own failure beside it; a file
// already gone is no failure.
fn remove_temporary_after(failure: io::Error, temporary_path: TempPath) -> ReplaceFileError {
    let removal_failure = match temporary_path.close() {
        Ok(()) => None,
        Err(removal_failure) if removal_failure.kind() == io::ErrorKind::NotFound => None,
        Err(removal_failure) => Some(removal_failure),
    };
    ReplaceFileError {
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
    use std::fs;

    use super::replace_file_atomically;

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
}
