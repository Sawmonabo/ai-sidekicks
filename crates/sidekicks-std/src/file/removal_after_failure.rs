//! The removal of a file a failed operation made, a temporary file or a new file at its final
//! path, so a failure leaves nothing behind unless the removal fails too, and then says so.

use std::fs;
use std::io;
use std::path::Path;

use crate::cleanup_failures::CleanupFailures;

/// Removes `made`, the file the failed operation `operation` made, after `failure`, and answers
/// `failure` with the removal's own failure beside it; a file already gone counts as removed.
pub fn remove_file_after_failure<Failure>(
    failure: Failure,
    made: &Path,
    operation: &'static str,
) -> CleanupFailures<Failure, io::Error> {
    let removal_failures = match fs::remove_file(made) {
        Ok(()) => Vec::new(),
        Err(removal_failure) if removal_failure.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(removal_failure) => vec![removal_failure],
    };
    CleanupFailures::new(failure, removal_failures, operation)
}
