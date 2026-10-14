//! A folder for its owner, made with any missing parents on Windows.

use std::io;
use std::path::Path;

/// Makes `folder` and every missing folder above it; each inherits the access list of the folder
/// it is made in, so one under the account's profile keeps the profile's. Fails with the system's
/// error from the make.
pub fn create_private_folder(folder: &Path) -> io::Result<()> {
    std::fs::create_dir_all(folder)
}
