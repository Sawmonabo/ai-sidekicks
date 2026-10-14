//! A folder only its owner can read, write or enter, made with any missing parents on macOS and
//! Linux.

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
    DirBuilder::new()
        .recursive(true)
        .mode(PRIVATE_FOLDER_MODE)
        .create(folder)?;
    fs::set_permissions(folder, Permissions::from_mode(PRIVATE_FOLDER_MODE))
}

#[cfg(test)]
mod tests {
    use std::fs::{self, Permissions};
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    use super::create_private_folder;

    fn mode_of(folder: &Path) -> u32 {
        fs::symlink_metadata(folder)
            .expect("the folder reads")
            .permissions()
            .mode()
            & 0o777
    }

    #[test]
    fn an_existing_open_folder_and_a_fresh_nested_one_both_end_private() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let existing = scratch.path().join("existing");
        fs::create_dir(&existing).expect("the existing folder is made");
        fs::set_permissions(&existing, Permissions::from_mode(0o755)).expect("the mode is set");
        let fresh = scratch.path().join("fresh");
        let nested = fresh.join("nested");

        create_private_folder(&existing).expect("the existing folder is made private");
        create_private_folder(&nested).expect("the nested folder is made");

        assert_eq!(mode_of(&existing), 0o700);
        assert_eq!(mode_of(&fresh), 0o700);
        assert_eq!(mode_of(&nested), 0o700);
    }
}
