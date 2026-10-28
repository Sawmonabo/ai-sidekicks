//! The caller's side of a helper mode's child: started on the spawner's thread, prepared as every
//! child of the caller is (on Linux armed to end with it) and ended if its handle drops, its
//! standard input held for its life so that closing it stops the mode, and its error output's tail
//! kept for its failure.

use std::io;
use std::process::{ExitStatus, Stdio};

use sidekicks_platforms::{Spawner, prepare_child_command};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

use crate::helper_mode::error_output::read_error_output_tail;

/// How a helper mode's child ended.
pub enum HelperModeEnd {
    /// The child exited 0.
    Succeeded,
    /// The stop came first: the child's standard input was closed and it has exited, or it was
    /// never started.
    Stopped,
    /// The child exited with a failure.
    Failed {
        /// How the child ended.
        status: ExitStatus,
        /// The tail of its error output.
        error_output: String,
    },
}

/// Why a helper mode's child could not be run to its end.
pub enum HelperModeChildError {
    /// The child could not start.
    Start(io::Error),
    /// The wait for the child, or the read of its error output, failed.
    Wait(io::Error),
}

/// Starts `command`, a run of the calling program in a helper mode, on `spawner`'s thread, prepared
/// as [`prepare_child_command`] prepares a child (on Linux armed to end with the caller) and killed
/// if the returned handle drops. Fails with the spawn's error, or with the spawner's when its
/// thread has ended.
pub async fn start_helper_mode_child(spawner: &Spawner, mut command: Command) -> io::Result<Child> {
    command.kill_on_drop(true);
    prepare_child_command(&mut command, std::process::id());
    spawner
        .run(move || command.spawn())
        .await
        .and_then(|spawned| spawned)
}

/// Runs `command`, the calling program in a helper mode that ends with its standard input, to its
/// end: started as [`start_helper_mode_child`] starts it, its output discarded, its standard input
/// held until it exits or `stop` fires, when the input is closed and its exit waited for. Keeps
/// the last `error_output_kept_bytes` of its error output. Fails when it cannot start, or when the
/// wait or the read of its error output fails.
pub async fn run_helper_mode_child(
    spawner: &Spawner,
    mut command: Command,
    stop: &CancellationToken,
    error_output_kept_bytes: usize,
) -> Result<HelperModeEnd, HelperModeChildError> {
    if stop.is_cancelled() {
        return Ok(HelperModeEnd::Stopped);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = start_helper_mode_child(spawner, command)
        .await
        .map_err(HelperModeChildError::Start)?;
    // Held until the child ends or the stop fires: the mode ends once its standard input ends.
    let standard_input = child.stdin.take();
    let standard_error = child
        .stderr
        .take()
        .expect("the child's standard error is piped");
    let waiting = async {
        tokio::select! {
            biased;
            status = child.wait() => (status, false),
            () = stop.cancelled() => {
                drop(standard_input);
                (child.wait().await, true)
            }
        }
    };
    let ((status, is_stopped), tail) = tokio::join!(
        waiting,
        read_error_output_tail(standard_error, error_output_kept_bytes)
    );
    let status = status.map_err(HelperModeChildError::Wait)?;
    let error_output = tail.map_err(HelperModeChildError::Wait)?;
    Ok(if status.success() {
        HelperModeEnd::Succeeded
    } else if is_stopped {
        HelperModeEnd::Stopped
    } else {
        HelperModeEnd::Failed {
            status,
            error_output,
        }
    })
}
