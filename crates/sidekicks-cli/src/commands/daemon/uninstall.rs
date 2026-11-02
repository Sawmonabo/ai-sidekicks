//! `sidekicks daemon uninstall`: removes the command line's registration of the background service,
//! the running service stopped first so it writes everything it holds; the data folder stays.
//! Where the app's own registration runs the service, nothing is removed and the person is told
//! where to turn it off. Where this account's system service runs it while the person is logged
//! out, that service is removed and the login agent put back; and where an earlier such uninstall
//! stopped with the secrets still in the system service's files, this run moves them back first.

pub(crate) mod system_service;

use std::io::Write;

use anyhow::Context as _;
use sidekicks_client::daemon_ending::DaemonEndingVerb;
use sidekicks_platforms::{ServiceOwner, SystemServiceOwner};

use crate::command_context::CommandContext;
use crate::commands::daemon::ending::end_running_daemon;
use crate::commands::daemon::install::system_service::write_line;
use crate::commands::daemon::registration::{read_owner, registration_failure};
use crate::commands::daemon::uninstall::system_service::{
    LoggedOutServiceUninstall, are_secrets_in_files, finish_moving_secrets_back, put_agent_back,
    uninstall_logged_out_service,
};
use crate::connected_command::run_listening_for_ctrl_c;
use crate::daemon_program::daemon_program;
use crate::exit_codes::{CommandFailure, ExitCode};

/// Removes the background service's registration on this computer through `registration`, and
/// answers 0 with the outcome's line on stdout. The system service's owner and the login agent's
/// are read first: this account's system service is removed as [`uninstall_logged_out_service`]
/// removes it, else the login agent, the secrets moved back first where the record still names the
/// system service's files; the daemon's program is resolved only on the paths that start it.
/// Fails with [`CommandFailure::AppOwnsService`] where the app's registration runs the service, as
/// [`finish_moving_secrets_back`] fails, `ClientError::Canceled` after a Ctrl-C while the service
/// stops, and as the program's resolution, the reads, the service's stop, the removal or the
/// agent's put-back fails, a step the service manager refused as
/// [`CommandFailure::RegistrationRefused`].
pub(crate) fn uninstall<Output: Write, ErrorOutput: Write>(
    registration: &impl LoggedOutServiceUninstall,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let system_service_owner = registration.system_service_owner(None).map_err(|failure| {
        registration_failure(
            failure,
            "could not read which account runs the background service while logged out",
        )
    })?;
    let owner = read_owner(registration)?;
    match system_service_owner {
        SystemServiceOwner::ThisAccount | SystemServiceOwner::ThisAccountOtherProgram => {
            let program = daemon_program(None)?;
            return uninstall_logged_out_service(registration, owner, &program, context);
        }
        SystemServiceOwner::NotInstalled | SystemServiceOwner::OtherAccount => {}
    }
    match owner {
        ServiceOwner::App => return Err(CommandFailure::AppOwnsService.into()),
        ServiceOwner::None | ServiceOwner::CommandLine => {}
    }
    if are_secrets_in_files(registration)? {
        // An uninstall of the system service stopped after its removal. With no agent loaded it
        // is finished here; a loaded agent's service is ended for the move and the agent removed
        // below, as asked.
        let is_agent_loaded = owner == ServiceOwner::CommandLine
            && registration.is_agent_loaded().map_err(|failure| {
                registration_failure(failure, "could not read whether the login agent is loaded")
            })?;
        let program = daemon_program(None)?;
        finish_moving_secrets_back(registration, &program, is_agent_loaded)?;
        if !is_agent_loaded {
            let line = put_agent_back(registration, owner, &program, &mut context.stderr).context(
                "moved the secrets back into the login keychain, but could not put the login \
                     agent back",
            )?;
            return write_line(context, line);
        }
    }
    let line = if owner == ServiceOwner::CommandLine {
        // Stopped through the one ending, its flush first, so the removal's own stop finds
        // nothing unwritten; a service not running is already stopped.
        run_listening_for_ctrl_c(async |ctrl_c| {
            end_running_daemon(
                DaemonEndingVerb::Stop,
                "could not stop the background service before removing it",
                ctrl_c,
            )
            .await
        })?;
        registration.uninstall().map_err(|failure| {
            registration_failure(failure, "could not remove the background service")
        })?;
        "Removed the background service. Your data is kept.\n"
    } else {
        "The background service is not installed.\n"
    };
    write_line(context, line)
}
