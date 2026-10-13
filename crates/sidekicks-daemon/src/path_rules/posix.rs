//! How macOS and Linux spell paths: `/` between components, one root, names compared exactly and a
//! line ended by a line feed alone.

use typed_path::Utf8UnixPath;

/// The separator between a POSIX path's components.
pub(super) const SEPARATOR: char = '/';

/// Whether `path` starts at the root.
pub(super) fn is_absolute(path: &str) -> bool {
    Utf8UnixPath::new(path).is_absolute()
}
