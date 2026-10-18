//! The daemon's own program path, the one its hook commands name.

use std::io;
use std::path::PathBuf;

/// The daemon's own program, every link resolved, read once at the daemon's start so the hook
/// commands name the program as it started even after an update moves it (on Linux the running
/// program's path reads `… (deleted)` once its file is replaced). Fails when the system cannot
/// name the running program or the path cannot be resolved.
pub(crate) fn read_daemon_program_path() -> io::Result<PathBuf> {
    sidekicks_platforms::real_path(&std::env::current_exe()?)
}
