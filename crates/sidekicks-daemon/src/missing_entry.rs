//! Reading an entry that may be missing: a `NotFound` failure read as nothing there, every other
//! failure kept.

use std::io;

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
