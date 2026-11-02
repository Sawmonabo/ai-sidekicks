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

use anyhow::Context as _;
use clap::Subcommand;
use sidekicks_platforms::{ServiceRegistration, service_registration};

use crate::command_context::CommandContext;
use crate::commands::daemon::install::{InstallArgs, install};
use crate::commands::daemon::registration::{refuse_other_home, this_program_as_account};
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

/// Runs a `daemon` command and answers its exit code; under root's rights, as under `sudo`, a
/// command that reaches the running service runs again as the account, since the service answers
/// its own account alone. Fails as the command does.
pub(crate) fn run_daemon_command<Output: Write, ErrorOutput: Write>(
    command: &DaemonCommand,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    if !matches!(command, DaemonCommand::Registration(..))
        && let Some(registration) = service_registration()
        && registration.runs_as_root()
    {
        return run_as_account(&registration);
    }
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

/// Runs this program again with this run's own arguments as the account through `registration`,
/// on this run's terminal, and answers the exit code it ended with. Fails when this program or the
/// account cannot be named or the run cannot start, and with `ClientError::Canceled` for a run a
/// Ctrl-C ended.
fn run_as_account(registration: &ServiceRegistration) -> anyhow::Result<ExitCode> {
    let (program, mut command) =
        this_program_as_account(|program| registration.account_command(program))?;
    let status = command
        .args(std::env::args_os().skip(1))
        .status()
        .with_context(|| format!("could not run {} as this account", program.display()))?;
    ExitCode::of_program_run(&status)
}
