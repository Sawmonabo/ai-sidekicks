//! The command every Claude Code process starts from: the build's program and leading arguments,
//! the caller's arguments, the given environment alone and the folder it runs in.

use std::ffi::OsStr;
use std::path::Path;

use sidekicks_platforms::ProgramStart;
use tokio::process::Command;

/// A command running Claude Code's build `start` with `arguments` in `working_folder`, in
/// `environment` alone, nothing inherited from the daemon; its streams are the caller's to set.
pub(crate) fn compose_claude_command(
    start: &ProgramStart,
    arguments: &[impl AsRef<OsStr>],
    environment: &[(String, String)],
    working_folder: &Path,
) -> Command {
    let mut command = Command::new(&start.program);
    command
        .args(&start.leading_arguments)
        .args(arguments)
        .env_clear()
        .envs(environment.iter().map(|(name, value)| (name, value)))
        .current_dir(working_folder);
    command
}
