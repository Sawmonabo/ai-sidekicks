//! The `daemon` commands, which read and drive the background service itself. Its install and
//! uninstall join them only on a system whose service manager registers the service, and refuse
//! under a `HOME` other than the account's own. Under `sudo`, root starts this account's system
//! service, and every other command that reaches the service runs again as the account.

mod ending;
pub(crate) mod install;
pub(crate) mod registration;
mod restart;
mod secrets_place;
pub(crate) mod service_status;
pub(crate) mod start;
pub(crate) mod status;
mod stop;
pub(crate) mod uninstall;

use std::io::Write;
use std::process::Stdio;

use clap::Subcommand;
use sidekicks_platforms::{ServiceRegistration, service_registration};

use crate::command_context::CommandContext;
use crate::commands::daemon::install::{InstallArgs, install};
use crate::commands::daemon::registration::{refuse_other_home, run_as_account};
use crate::commands::daemon::restart::{RestartArgs, restart, restart_system_service};
use crate::commands::daemon::start::{
    STARTED_LINE, StartArgs, has_system_service_to_start, start_and_report, start_system_service,
};
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
/// start or restart of this account's system service runs as root, which alone can start it, and
/// any other command that reaches the running service runs again as the account, since the service
/// answers its own account alone. Fails as the command does.
pub(crate) fn run_daemon_command<Output: Write, ErrorOutput: Write>(
    command: &DaemonCommand,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let root_registration = service_registration().filter(ServiceRegistration::runs_as_root);
    match command {
        DaemonCommand::Restart(args) => match root_registration {
            Some(registration) if has_system_service_to_start(registration)? => {
                restart_system_service(args, registration, context)
            }
            Some(registration) => run_again_as_account(registration),
            None => restart(args, context),
        },
        DaemonCommand::Start(args) => match root_registration {
            Some(registration) if has_system_service_to_start(registration)? => {
                start_system_service(args, registration, context)
            }
            Some(registration) => run_again_as_account(registration),
            None => start_and_report(args, STARTED_LINE, context),
        },
        DaemonCommand::Status(args) => match root_registration {
            Some(registration) => run_again_as_account(registration),
            None => show_status(args, context),
        },
        DaemonCommand::Stop(args) => match root_registration {
            Some(registration) => run_again_as_account(registration),
            None => stop(args, context),
        },
        DaemonCommand::Registration(registration, ServiceRegistrationCommand::Install(args)) => {
            refuse_other_home(*registration)?;
            install(args, *registration, context)
        }
        DaemonCommand::Registration(registration, ServiceRegistrationCommand::Uninstall) => {
            refuse_other_home(*registration)?;
            uninstall(registration, context)
        }
    }
}

/// Runs this program again with this run's own arguments as the account through `registration`,
/// on this run's terminal, and answers the exit code it ended with. Fails as [`run_as_account`]
/// does.
fn run_again_as_account(registration: ServiceRegistration) -> anyhow::Result<ExitCode> {
    run_as_account(registration, std::env::args_os().skip(1), Stdio::inherit())
}
