//! The `daemon` commands, which read and drive the background service itself. Its install and
//! uninstall join them only on a system whose service manager registers the service, and refuse
//! under a `HOME` other than the account's own.

mod ending;
pub(crate) mod install;
pub(crate) mod registration;
mod restart;
mod secrets_place;
pub(crate) mod start;
pub(crate) mod status;
mod stop;
pub(crate) mod uninstall;

use std::io::Write;

use clap::Subcommand;
use sidekicks_platforms::ServiceRegistration;

use crate::command_context::CommandContext;
use crate::commands::daemon::install::{InstallArgs, install};
use crate::commands::daemon::registration::refuse_other_home;
use crate::commands::daemon::restart::{RestartArgs, restart};
use crate::commands::daemon::start::{STARTED_LINE, StartArgs, start_and_report};
use crate::commands::daemon::status::{StatusArgs, show_status};
use crate::commands::daemon::stop::{StopArgs, stop};
use crate::commands::daemon::uninstall::uninstall;
use crate::exit_codes::ExitCode;

/// The `daemon` commands.
#[derive(Debug, Subcommand)]
pub(crate) enum DaemonCommand {
    /// Stop the background service and start it again, asking first.
    Restart(RestartArgs),
    /// Start the background service unless it is running, and wait until it answers.
    Start(StartArgs),
    /// Show whether the background service is running, and how it stands.
    Status(StatusArgs),
    /// Stop the background service, asking first.
    Stop(StopArgs),
    /// A command over this system's registration of the service, which the program's arguments
    /// offer only where there is one.
    #[command(skip)]
    Registration(ServiceRegistration, ServiceRegistrationCommand),
}

/// The `daemon` commands over the service's registration with the system's service manager.
#[derive(Debug, Subcommand)]
pub(crate) enum ServiceRegistrationCommand {
    /// Register the background service to start at login, and start it.
    Install(InstallArgs),
    /// Stop the background service and remove its start at login; your data is kept.
    Uninstall,
}

/// Runs a `daemon` command and answers its exit code; fails as the command does.
pub(crate) fn run_daemon_command<Output: Write, ErrorOutput: Write>(
    command: &DaemonCommand,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    match command {
        DaemonCommand::Restart(args) => restart(args, context),
        DaemonCommand::Start(args) => start_and_report(args, STARTED_LINE, context),
        DaemonCommand::Status(args) => show_status(args, context),
        DaemonCommand::Stop(args) => stop(args, context),
        DaemonCommand::Registration(registration, ServiceRegistrationCommand::Install(args)) => {
            refuse_other_home(registration)?;
            install(args, *registration, context)
        }
        DaemonCommand::Registration(registration, ServiceRegistrationCommand::Uninstall) => {
            refuse_other_home(registration)?;
            uninstall(registration, context)
        }
    }
}
