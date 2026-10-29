//! What opening a regular file through no link found: the file open for reading, or what stood at
//! the path instead.

use std::fs::File;

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
