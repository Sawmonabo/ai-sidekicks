//! The removal of a temporary file once the operation writing it failed, so a failure leaves no
//! temporary file behind unless the removal fails too, and then says so.

use std::fs;
use std::io;
use std::path::Path;

use crate::cleanup_failures::CleanupFailures;

/// Removes `temporary` after `failure`, which `operation` ended with, and answers `failure` with
/// the removal's own failure beside it; a temporary file already gone counts as removed.
pub fn remove_temporary_after(
    failure: io::Error,
    temporary: &Path,
    operation: &'static str,
) -> CleanupFailures<io::Error> {
    let removal_failures = match fs::remove_file(temporary) {
        Ok(()) => Vec::new(),
        Err(removal_failure) if removal_failure.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(removal_failure) => vec![removal_failure],
    };
    CleanupFailures::new(failure, removal_failures, operation)
}
