//! Reading an entry that may be missing: a `NotFound` failure read as nothing there, every other
//! failure kept, and the wider test of a path that names nothing.

use std::io;

/// Whether `error` says the path names nothing: no entry there (`NotFound`), a component that is
/// a file and not a folder (`NotADirectory`), or a name the system cannot hold
/// (`InvalidFilename`), each of which every system reports for a path that cannot exist.
pub(crate) fn is_missing_entry(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory | io::ErrorKind::InvalidFilename
    )
}

/// A file-system result whose `NotFound` failure means nothing is at the path.
pub(crate) trait MissingEntry<T> {
    /// The value, `None` when the call failed with `NotFound`, or any other failure as it came.
    fn none_if_missing(self) -> io::Result<Option<T>>;
}

impl<T> MissingEntry<T> for io::Result<T> {
    fn none_if_missing(self) -> io::Result<Option<T>> {
        match self {
            Ok(value) => Ok(Some(value)),
            Err(failure) if failure.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(failure) => Err(failure),
        }
    }
}
