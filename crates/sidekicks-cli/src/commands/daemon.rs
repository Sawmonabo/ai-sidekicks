//! The `daemon` commands, which read and drive the background service itself.

pub(crate) mod install;
pub(crate) mod registration;
pub(crate) mod start;
pub(crate) mod status;
pub(crate) mod uninstall;

use std::io::Write;

use clap::Subcommand;

use crate::command_context::CommandContext;
use crate::commands::daemon::install::{InstallArgs, install};
use crate::commands::daemon::start::{StartArgs, start};
use crate::commands::daemon::status::{StatusArgs, show_status};
use crate::commands::daemon::uninstall::uninstall;
use crate::exit_codes::ExitCode;

/// The `daemon` commands.
#[derive(Debug, Subcommand)]
pub(crate) enum DaemonCommand {
    /// Register the background service to start at login, and start it.
    Install(InstallArgs),
    /// Start the background service unless it is running, and wait until it answers.
    Start(StartArgs),
    /// Show whether the background service is running, and how it stands.
    Status(StatusArgs),
    /// Stop the background service and remove its start at login; your data is kept.
    Uninstall,
}

/// Runs a `daemon` command and answers its exit code; fails as the command does.
pub(crate) fn run_daemon_command<Output: Write, ErrorOutput: Write>(
    command: &DaemonCommand,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    match command {
        DaemonCommand::Install(args) => install(args, context),
        DaemonCommand::Start(args) => start(args, context),
        DaemonCommand::Status(args) => show_status(args, context),
        DaemonCommand::Uninstall => uninstall(context),
    }
}
