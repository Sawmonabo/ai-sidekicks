//! The `daemon` commands, which read and drive the background service itself.

pub(crate) mod status;

use std::io::Write;

use clap::Subcommand;

use crate::command_context::CommandContext;
use crate::commands::daemon::status::{StatusArgs, show_status};
use crate::exit_codes::ExitCode;

/// The `daemon` commands.
#[derive(Debug, Subcommand)]
pub(crate) enum DaemonCommand {
    /// Show whether the background service is running, and how it stands.
    Status(StatusArgs),
}

/// Runs a `daemon` command and answers its exit code; fails as the command does.
pub(crate) fn run_daemon_command<Output: Write, ErrorOutput: Write>(
    command: &DaemonCommand,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    match command {
        DaemonCommand::Status(args) => show_status(args, context),
    }
}
