//! The `database copy` mode and the daemon's side of it: one file copied, replacing the copy's
//! path, as a clone where the file system makes one and then flushed to disk, in a child process
//! of the daemon's own program. The copy never runs in the service: it would open the database
//! file and close it, and closing any descriptor on a file releases every POSIX lock the process
//! holds on it, the writer's included. The mode ends when its standard input does, which the
//! daemon holds open for the copy's life, so a stop ends it at once.

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{ExitCode, ExitStatus};

use sidekicks_platforms::{Spawner, flush_file};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::file::clone_or_copy::clone_or_copy;
use crate::helper_mode::child::{HelperModeChildError, HelperModeEnd, run_helper_mode_child};
use crate::helper_mode::input_watch::run_until_input_ends;
use crate::missing_entry::MissingEntry as _;
use crate::recovery::database_file::ERROR_OUTPUT_KEPT_BYTES;

/// The arguments the daemon's own program is started with to copy one file; the source and the
/// copy's path follow them.
pub const DATABASE_COPY_MODE: [&str; 2] = ["database", "copy"];

/// Why a copy in the `database copy` mode failed.
#[derive(Debug, thiserror::Error)]
pub enum DatabaseCopyError {
    /// The mode's process could not start.
    #[error("the file copy could not start")]
    Start(#[source] io::Error),
    /// The wait for the mode's process, or the read of its error output, failed.
    #[error("the file copy's process could not be waited for")]
    Wait(#[source] io::Error),
    /// A stop ended the copy before it finished.
    #[error("the file copy was stopped")]
    Stopped,
    /// The copy failed, as its error output says.
    #[error("the file copy failed ({status}): {error_output}")]
    Failed {
        /// How the mode's process ended.
        status: ExitStatus,
        /// The end of its error output.
        error_output: String,
    },
}

/// Why the mode's own copy failed.
#[derive(Debug, thiserror::Error)]
enum CopyModeError {
    /// The mode was not started with the source and the copy's path.
    #[error("the file copy is started with the file and the path of its copy")]
    Arguments,
    /// The copy itself failed.
    #[error("copying the file failed")]
    Copy(#[source] io::Error),
}

/// Starts the daemon's own program in the `database copy` mode, each child on one spawner.
pub struct DatabaseFileCopier {
    program: PathBuf,
    spawner: Spawner,
}

impl DatabaseFileCopier {
    /// A copier starting `program`, the daemon's own, on `spawner`'s thread.
    pub fn new(program: PathBuf, spawner: Spawner) -> Self {
        Self { program, spawner }
    }

    /// Copies `source` to `destination`, replacing it, as a clone where the file system makes one,
    /// and flushes the copy to disk, all in the mode's child process, since a copy in the service
    /// would release the writer's locks on the file; answers once the child has exited. Fails with
    /// [`DatabaseCopyError::Failed`] naming the copy's own error, and with
    /// [`DatabaseCopyError::Stopped`] once `stop` fires and the child has exited.
    pub(crate) async fn copy_file(
        &self,
        source: &Path,
        destination: &Path,
        stop: &CancellationToken,
    ) -> Result<(), DatabaseCopyError> {
        let mut command = Command::new(&self.program);
        command
            .args(DATABASE_COPY_MODE)
            .arg(source)
            .arg(destination);
        let ended = run_helper_mode_child(&self.spawner, command, stop, ERROR_OUTPUT_KEPT_BYTES)
            .await
            .map_err(|failure| match failure {
                HelperModeChildError::Start(failure) => DatabaseCopyError::Start(failure),
                HelperModeChildError::Wait(failure) => DatabaseCopyError::Wait(failure),
            })?;
        match ended {
            HelperModeEnd::Succeeded => Ok(()),
            HelperModeEnd::Stopped => Err(DatabaseCopyError::Stopped),
            HelperModeEnd::Failed {
                status,
                error_output,
            } => Err(DatabaseCopyError::Failed {
                status,
                error_output,
            }),
        }
    }
}

/// Runs the `database copy` mode on the arguments after the mode's own: the source and the copy's
/// path. Exits 0 once the copy is made and on disk, 1 with why on standard error when it fails,
/// and 1 as soon as standard input ends, the copy's thread ending with the process.
pub fn run_database_copy() -> ExitCode {
    run_until_input_ends(|| copy_from_arguments(env::args_os().skip(1 + DATABASE_COPY_MODE.len())))
}

/// Copies `source` to `destination`, replacing it: a file already at `destination` is removed
/// first, since the copy refuses an existing target; then the copy is made, as a clone where the
/// file system makes one, and flushed to disk. Fails with the removal's, the copy's or the
/// flush's error.
pub(crate) fn copy_file_replacing(source: &Path, destination: &Path) -> io::Result<()> {
    fs::remove_file(destination).none_if_missing()?;
    clone_or_copy(source, destination)?;
    flush_file(destination)
}

// Copies the file the arguments name.
fn copy_from_arguments(mut arguments: impl Iterator<Item = OsString>) -> Result<(), CopyModeError> {
    let (Some(source), Some(destination)) = (arguments.next(), arguments.next()) else {
        return Err(CopyModeError::Arguments);
    };
    copy_file_replacing(Path::new(&source), Path::new(&destination)).map_err(CopyModeError::Copy)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::copy_file_replacing;

    #[test]
    fn replaces_a_copy_a_cut_short_repair_left_behind() {
        let scratch = tempfile::tempdir().expect("a scratch folder");
        let source = scratch.path().join("daemon.db.backup");
        let destination = scratch.path().join("daemon.db.backup-read");
        fs::write(&source, b"the backup's pages").expect("the source is written");
        fs::write(&destination, b"a leftover copy, longer than the source").expect("written");

        copy_file_replacing(&source, &destination).expect("the copy replaces the leftover");

        assert_eq!(
            fs::read(&destination).expect("the copy reads"),
            b"the backup's pages"
        );
    }
}
