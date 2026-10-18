//! Whether a path names a file this process may run, on Windows.

use std::path::Path;

/// Whether `path`, its links followed, is a file: Windows has no execute bit a probe can read, so
/// the `PATHEXT` names a search tries are what mark an executable. Any error reads as no, since
/// the probe answers a question and a missing or unreadable file is not one to run.
pub(crate) fn is_executable_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file())
}
