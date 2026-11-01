//! What opening a regular file through no link found: the file open for reading, or what stood at
//! the path instead, and the check that keeps the path under its folder.

use std::fs::File;
use std::io;
use std::path::{Component, Path};

/// What a no-follow open of a path for reading found.
#[derive(Debug)]
pub enum RegularFileOpen {
    /// A regular file, open for reading.
    Opened(File),
    /// A link, which was not followed.
    Link,
    /// A pipe, a socket, a device or a folder.
    SpecialFile,
    /// Nothing, or a folder on its way that is no folder.
    Gone,
}

/// Refuses with `InvalidInput` a `relative` that could leave the folder it is opened under: an
/// absolute one, one naming a drive, or one holding a `..`.
pub(crate) fn check_stays_beneath(relative: &Path) -> io::Result<()> {
    let leaves = relative.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir
        )
    });
    if leaves {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} leaves the folder it is opened under",
                relative.display()
            ),
        ));
    }
    Ok(())
}
