//! Making, renaming and removing entries on Windows: `create_new_file` makes a file only where
//! nothing stands, `rename_replacing` renames over a file at the destination and is on disk when it
//! returns, and `remove_tree` removes a path and everything under it, as `rm -rf` does.

use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::windows::fs::FileTypeExt;
use std::path::Path;

use walkdir::WalkDir;
use windows_sys::Win32::Storage::FileSystem::{
    MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
};

use crate::windows::real_path::verbatim_path;

/// Whether a rename of a folder replaces an empty folder already at its destination: never, since
/// the system refuses any folder there.
pub const CAN_RENAME_REPLACE_EMPTY_FOLDER: bool = false;

/// Makes a new file at `path`, open for writing; `mode` is unused, since every mode a caller passes
/// leaves the file writable. Fails with `AlreadyExists` when anything is at `path`, or with the
/// open's error.
pub fn create_new_file(path: &Path, _mode: u32) -> io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

/// Whether the entry at `path` has the mode `mode`: always, since Windows keeps no mode and
/// [`create_new_file`] takes none. Never fails.
pub fn has_file_mode(_path: &Path, _mode: u32) -> io::Result<bool> {
    Ok(true)
}

/// Renames `from` to `to` in one step, written through to disk before it returns: a file at `to` is
/// replaced, and a folder at `to` is refused, empty or not. Fails with `InvalidInput` when a path
/// holds a NUL, or with the system's error, a move across volumes among them.
pub fn rename_replacing(from: &Path, to: &Path) -> io::Result<()> {
    let mut from_units = verbatim_path(from)?;
    from_units.push(0);
    let mut to_units = verbatim_path(to)?;
    to_units.push(0);
    // SAFETY: both paths are NUL-terminated UTF-16 vectors that live until the call returns, and
    // the call reads them only up to their NUL.
    let moved = unsafe {
        MoveFileExW(
            from_units.as_ptr(),
            to_units.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Removes `path` and everything under it, as `rm -rf` does: a link or a junction is removed and
/// never followed, and a read-only entry goes too, on a volume without POSIX deletes as well. A
/// path already gone is `Ok`; fails with the stat's or the removal's error, and a failed walk
/// clearing read-only entries is logged while the removal's own refusal returns.
pub fn remove_tree(path: &Path) -> io::Result<()> {
    let removed = match remove_entry(path) {
        // A volume without POSIX deletes (FAT, exFAT) refuses a read-only entry; it is made
        // writable and removed once more.
        Err(failure) if failure.kind() == io::ErrorKind::PermissionDenied => {
            match clear_read_only(path) {
                Ok(()) => remove_entry(path),
                // The removal's own refusal, a held file's among them, is what the caller reads.
                Err(walk_failure) => {
                    tracing::warn!(
                        error = &walk_failure as &(dyn Error + 'static),
                        "clearing read-only entries before a removal failed, so the removal's \
                         refusal stands"
                    );
                    Err(failure)
                }
            }
        }
        removed => removed,
    };
    match removed {
        // Missing at the start, or removed meanwhile by another remover.
        Err(failure) if failure.kind() == io::ErrorKind::NotFound => Ok(()),
        removed => removed,
    }
}

// std's folder removal deletes each entry with its read-only attribute ignored where the volume
// takes POSIX deletes, and never follows a link inside.
fn remove_entry(path: &Path) -> io::Result<()> {
    let file_type = fs::symlink_metadata(path)?.file_type();
    if file_type.is_symlink_dir() {
        // A link to a folder or a junction is a folder entry, removed as one.
        fs::remove_dir(path)
    } else if file_type.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

// Clears the read-only attribute on every entry under `path` that has it, links left alone, so a
// volume without POSIX deletes removes them.
fn clear_read_only(path: &Path) -> io::Result<()> {
    for entry in WalkDir::new(path).follow_root_links(false) {
        let entry = entry?;
        if entry.path_is_symlink() {
            continue;
        }
        let mut permissions = entry.metadata()?.permissions();
        if permissions.readonly() {
            #[expect(
                clippy::permissions_set_readonly_false,
                reason = "Windows clears only the read-only attribute"
            )]
            permissions.set_readonly(false);
            fs::set_permissions(entry.path(), permissions)?;
        }
    }
    Ok(())
}

/// A file whose removal, and so its folder's, the system refuses until this is dropped: it is held
/// open with no sharing, so no other handle may delete it.
#[cfg(any(test, feature = "test-support"))]
pub struct UnremovableFile {
    path: std::path::PathBuf,
    _handle: File,
}

#[cfg(any(test, feature = "test-support"))]
impl UnremovableFile {
    /// Makes the file `name` in `folder` and refuses its removal. Fails with the open's error.
    pub fn create_in(folder: &Path, name: &str) -> io::Result<Self> {
        use std::os::windows::fs::OpenOptionsExt;

        let path = folder.join(name);
        let handle = OpenOptions::new()
            .write(true)
            .create_new(true)
            .share_mode(0)
            .open(&path)?;
        Ok(Self {
            path,
            _handle: handle,
        })
    }

    /// Where the file is.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::rename_replacing;

    // A put-back claims its destination with an empty folder; the rename must not replace it.
    #[test]
    fn a_folder_renamed_onto_an_empty_folder_is_refused_and_both_stay() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let moved = scratch.path().join("moved");
        fs::create_dir(&moved).expect("the moved folder is made");
        fs::write(moved.join("kept"), b"kept").expect("the moved folder's file is written");
        let claimed = scratch.path().join("claimed");
        fs::create_dir(&claimed).expect("the claimed folder is made");

        rename_replacing(&moved, &claimed).expect_err("the rename is refused");

        assert!(moved.join("kept").is_file());
        assert!(claimed.is_dir());
        assert!(
            fs::read_dir(&claimed)
                .expect("the claimed folder reads")
                .next()
                .is_none()
        );
    }
}
