//! The daemon's start as its own responsible process. macOS charges every process with a
//! responsible one, inherited by what it starts; once the daemon is its own, a caller whose
//! responsible process is the daemon is one of its own descendants. Other systems keep no
//! responsible process, so the start there changes nothing.

use std::io;

/// Why the start could not make this program its own responsible process; the daemon does not
/// start.
#[derive(Debug, thiserror::Error)]
pub enum OwnRootError {
    /// More than one thread runs, so replacing the process could lose another thread's work.
    #[error("{count} threads were running where the start must run alone")]
    ThreadsRunning {
        /// The threads the process held.
        count: i32,
    },
    /// The program re-ran itself as its own responsible process and still is not.
    #[error("the program re-ran itself and is still not its own responsible process")]
    StillNotRoot,
    /// The system could not say which process is responsible for this one, or how many threads it
    /// runs.
    #[error("this process's responsible process could not be read")]
    Read(#[source] io::Error),
    /// The system refused to re-run the program as its own responsible process.
    #[error("the program could not re-run itself as its own responsible process")]
    Exec(#[source] io::Error),
}

/// Makes this program its own responsible process before anything else starts; nothing to do on
/// this system, which keeps no responsible process. Never fails.
#[cfg(not(target_os = "macos"))]
pub fn become_own_root() -> Result<(), OwnRootError> {
    Ok(())
}
