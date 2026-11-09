//! One run of a helper program to its end through the shared bounded runner, the program started
//! as the system starts it, a command shim through its Node script.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use sidekicks_platforms::{ChildTreeOutput, Spawner};
use sidekicks_std::child_run::{ChildRunError, run_child_to_end};
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

/// Runs `request` to its end and answers what it printed and how it exited, whatever the exit
/// status, which the caller reads, with standard input null and both outputs piped; it must exit
/// within `deadline`, each output stream held to `output_bound` bytes. On any failure its whole
/// tree is dropped, which ends it on a blocking thread, so no process holds the caller past the
/// deadline.
pub(crate) async fn run_program_to_end(
    spawner: &Spawner,
    request: ProgramRunRequest,
    deadline: Duration,
    output_bound: usize,
) -> Result<ChildTreeOutput, ChildRunError> {
    let build = move || {
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
        Ok(command)
    };
    run_child_to_end(spawner, build, None, deadline, output_bound, None).await
}
