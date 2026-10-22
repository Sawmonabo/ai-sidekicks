//! A folder only its owner can read, write or enter, made on macOS and Linux with any missing
//! parents, where a folder that already exists is either made private again or left as it is, or
//! made alone where none exists yet.

use std::fs::{self, DirBuilder, Permissions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::Path;

// Read, write and enter for the owner alone.
const PRIVATE_FOLDER_MODE: u32 = 0o700;

/// Makes `folder` and every missing folder above it readable by its owner alone, and sets that mode
/// on `folder` again, since a folder that already existed keeps its own. Fails with the system's
/// error from the make or the mode change.
pub fn create_private_folder(folder: &Path) -> io::Result<()> {
    create_missing_private_folders(folder)?;
    fs::set_permissions(folder, Permissions::from_mode(PRIVATE_FOLDER_MODE))
}

/// Makes `folder` and every missing folder above it readable by its owner alone, leaving the mode
/// of each one that already exists as it is. Fails with the system's error from the make.
pub fn create_missing_private_folders(folder: &Path) -> io::Result<()> {
    DirBuilder::new()
        .recursive(true)
        .mode(PRIVATE_FOLDER_MODE)
        .create(folder)
}

/// Makes `folder`, readable by its owner alone from the moment it exists, and nothing above it.
/// Fails with the system's error from the make, `AlreadyExists` when `folder` exists and
/// `NotFound` when its parent is missing, leaving nothing made.
pub fn create_new_private_folder(folder: &Path) -> io::Result<()> {
    DirBuilder::new().mode(PRIVATE_FOLDER_MODE).create(folder)
}

#[cfg(test)]
mod tests {
    use std::fs::{self, Permissions};
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    use super::{create_missing_private_folders, create_new_private_folder, create_private_folder};

    fn mode_of(folder: &Path) -> u32 {
        fs::symlink_metadata(folder)
            .expect("the folder reads")
            .permissions()
            .mode()
            & 0o777
    }

    // An existing open folder is made private again, fresh nested folders are made private, and a
    // folder made alone is private and refused where it exists. Killed by the private mode dropped
    // from any make.
    #[test]
    fn an_existing_open_folder_and_fresh_ones_all_end_private() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let existing = scratch.path().join("existing");
        fs::create_dir(&existing).expect("the existing folder is made");
        fs::set_permissions(&existing, Permissions::from_mode(0o755)).expect("the mode is set");
        let fresh = scratch.path().join("fresh");
        let nested = fresh.join("nested");
        let alone = scratch.path().join("alone");

        create_private_folder(&existing).expect("the existing folder is made private");
        create_private_folder(&nested).expect("the nested folder is made");
        create_new_private_folder(&alone).expect("the folder is made alone");

        assert_eq!(mode_of(&existing), 0o700);
        assert_eq!(mode_of(&fresh), 0o700);
        assert_eq!(mode_of(&nested), 0o700);
        assert_eq!(mode_of(&alone), 0o700);
        assert_eq!(
            create_new_private_folder(&alone).map_err(|error| error.kind()),
            Err(io::ErrorKind::AlreadyExists)
        );
    }

    // A folder the person chose keeps its own mode, and only what is made under it is private.
    // Killed by the mode set again on an existing folder and by the private mode dropped.
    #[test]
    fn an_existing_folder_keeps_its_mode_and_a_missing_child_is_made_private() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let existing = scratch.path().join("existing");
        fs::create_dir(&existing).expect("the existing folder is made");
        fs::set_permissions(&existing, Permissions::from_mode(0o755)).expect("the mode is set");
        let child = existing.join("child");

        create_missing_private_folders(&existing).expect("the existing folder is left");
        create_missing_private_folders(&child).expect("the child is made");

        assert_eq!(mode_of(&existing), 0o755);
        assert_eq!(mode_of(&child), 0o700);
    }
}
