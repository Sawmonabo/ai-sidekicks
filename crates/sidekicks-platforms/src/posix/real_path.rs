//! A path with every link resolved on macOS and Linux.

use std::io;
use std::path::{Path, PathBuf};

/// The absolute path `path` names with every symbolic link resolved, the one way every crate
/// resolves a path, so each platform answers what Node's `realpath` answers. Fails with the
/// system's error, `NotFound` when the path is missing.
pub fn real_path(path: &Path) -> io::Result<PathBuf> {
    std::fs::canonicalize(path)
}
