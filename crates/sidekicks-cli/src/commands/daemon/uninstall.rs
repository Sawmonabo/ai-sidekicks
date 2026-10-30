//! `sidekicks daemon uninstall`: removes the command line's registration of the background service,
//! the running service stopped first so it writes everything it holds; the data folder stays.
//! Where the app's own registration runs the service, nothing is removed and the person is told
//! where to turn it off.

use std::io::Write;

use anyhow::Context as _;
use sidekicks_client::daemon_connection::DaemonEndpoint;
use sidekicks_client::daemon_ending::{DaemonEndingTerms, DaemonEndingVerb, end_daemon};
use sidekicks_client::error::ClientError;
use sidekicks_platforms::{ServiceOwner, service_registration};

use crate::command_context::CommandContext;
use crate::commands::daemon::registration::{LoginRegistration, read_owner, registration_failure};
use crate::connected_command::run_listening_for_ctrl_c;
use crate::exit_codes::{CommandFailure, ExitCode};

/// Removes the background service's registration on this computer, and answers 0 with the
/// outcome's line on stdout. Fails with [`CommandFailure::ServiceRegistrationMissing`] on a system
/// with no such registration, and as [`uninstall_with`] does.
pub(crate) fn uninstall<Output: Write, ErrorOutput: Write>(
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let registration = service_registration().ok_or(CommandFailure::ServiceRegistrationMissing)?;
    uninstall_with(&registration, context)
}

/// Removes the registration through `registration`, its owner read first. Fails with
/// [`CommandFailure::AppOwnsService`] where the app's registration runs the service,
/// `ClientError::Canceled` after a Ctrl-C while the service stops, and as the owner's read, the
/// service's stop or the removal fails, a step the service manager refused as
/// [`CommandFailure::RegistrationRefused`].
fn uninstall_with<Output: Write, ErrorOutput: Write>(
    registration: &impl LoginRegistration,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let owner = read_owner(registration)?;
    let line = match owner {
        ServiceOwner::App => return Err(CommandFailure::AppOwnsService.into()),
        ServiceOwner::None => "The background service is not installed.\n",
        ServiceOwner::CommandLine => {
            stop_running_daemon()?;
            registration.uninstall().map_err(|failure| {
                registration_failure(failure, "could not remove the background service")
            })?;
            "Removed the background service. Your data is kept.\n"
        }
    };
    context.stdout.write_all(line.as_bytes())?;
    context.stdout.flush()?;
    Ok(ExitCode::Success)
}

/// Stops the running service through the one ending, its flush first, so the removal's own stop
/// finds nothing unwritten; a service not running is already stopped. Fails as the ending does,
/// and with `ClientError::Canceled` after a Ctrl-C.
fn stop_running_daemon() -> anyhow::Result<()> {
    run_listening_for_ctrl_c(async |ctrl_c| {
        let endpoint = DaemonEndpoint::this_machine()
            .context("could not find where the background service listens")?;
        let terms = DaemonEndingTerms::default();
        tokio::select! {
            ended = end_daemon(endpoint, DaemonEndingVerb::Stop, &terms) => {
                ended.context("could not stop the background service before removing it")?;
                Ok(())
            }
            _ = ctrl_c.recv() => Err(ClientError::Canceled.into()),
        }
    })
}
