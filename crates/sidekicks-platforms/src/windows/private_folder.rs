//! A folder for its owner, made with any missing parents on Windows.

use std::io;
use std::path::Path;

/// Makes `folder` and every missing folder above it; each inherits the access list of the folder
/// it is made in, so one under the account's profile keeps the profile's. Fails with the system's
/// error from the make.
pub fn create_private_folder(folder: &Path) -> io::Result<()> {
    create_missing_private_folders(folder)
}

/// Makes `folder` and every missing folder above it, each inheriting the access list of the folder
/// it is made in, and leaves the access list of each one that already exists as it is; the same
/// as [`create_private_folder`], since Windows sets nothing again on an existing folder. Fails
/// with the system's error from the make.
pub fn create_missing_private_folders(folder: &Path) -> io::Result<()> {
    std::fs::create_dir_all(folder)
}
