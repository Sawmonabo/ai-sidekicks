//! One run of a helper program to its end, bounded in time and in output, leading a process tree
//! of its own that ends whole when the run fails.

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use sidekicks_platforms::{
    ChildTree, ChildTreeOutput, ChildTreeOutputError, Spawner, start_child_tree,
};
use tokio::process::Command;

use crate::spawned_version::start_resolved_build;

/// What to run: the program, its arguments, its whole environment and the folder it runs in.
pub(crate) struct ProgramRunRequest {
    /// The program's path.
    pub(crate) program: PathBuf,
    /// The arguments, after any a command shim puts first.
    pub(crate) arguments: Vec<OsString>,
    /// The program's whole environment, set over a cleared one.
    pub(crate) environment: Vec<(String, String)>,
    /// The folder the program runs in, or the daemon's own when `None`.
    pub(crate) working_folder: Option<PathBuf>,
}

/// Why a program did not run to its end within its bounds.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ProgramRunError {
    /// The program could not be started.
    #[error("the program could not be started")]
    Start(#[source] io::Error),
    /// Its output could not be read, or one stream passed its bound.
    #[error("the program's output could not be read")]
    Output(#[source] ChildTreeOutputError),
    /// It did not exit within its deadline.
    #[error("the program did not exit within its deadline")]
    TimedOut,
}

/// Runs `request` to its end and answers what it printed and how it exited, whatever the exit
/// status, which the caller reads. The program starts from the spawner thread as the system starts
/// it, a command shim through its Node script, with standard input null, both outputs piped and a
/// process tree of its own; it must exit within `deadline`, each output stream held to
/// `output_bound` bytes. On any failure its whole tree is dropped, which ends it on a blocking
/// thread, so no process holds the caller past the deadline.
pub(crate) async fn run_program_to_end(
    spawner: &Spawner,
    request: ProgramRunRequest,
    deadline: Duration,
    output_bound: usize,
) -> Result<ChildTreeOutput, ProgramRunError> {
    let daemon_pid = std::process::id();
    let mut child = spawner
        .run(move || -> io::Result<ChildTree> {
            let start = start_resolved_build(&request.program, &request.environment)?;
            let mut command = Command::new(&start.program);
            command
                .args(&start.leading_arguments)
                .args(&request.arguments)
                .env_clear()
                .envs(request.environment)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some(folder) = &request.working_folder {
                command.current_dir(folder);
            }
            start_child_tree(command, daemon_pid)
        })
        .await
        .map_err(ProgramRunError::Start)?
        .map_err(ProgramRunError::Start)?;
    // A failed run returns with `child` unreaped, whose drop ends its tree.
    match tokio::time::timeout(deadline, child.wait_with_output(None, output_bound)).await {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(ProgramRunError::Output(error)),
        Err(_elapsed) => Err(ProgramRunError::TimedOut),
    }
}
