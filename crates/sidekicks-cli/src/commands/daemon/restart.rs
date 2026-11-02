//! `sidekicks daemon restart`: asks first, ends the background service with `daemon.restart`
//! through the one ending, then starts it through the one start. Nothing answering is a start
//! with no question; a service repairing its database file is stopped on the link it refused, and
//! the start then waits on the repair. Where this account's system service runs the service while
//! the person is logged out, only root can start it again, so a run without root's rights refuses
//! before it asks or stops anything; under `sudo` it asks, stops the service as the account, which
//! the service alone answers, and starts it as root with no wait, since root cannot reach it.

use std::io::Write;
use std::process::Stdio;

use anyhow::Context as _;
use clap::Args;
use sidekicks_client::daemon_connection::DaemonEndpoint;
use sidekicks_client::daemon_ending::DaemonEndingVerb;
use sidekicks_client::error::ClientError;
use sidekicks_platforms::{ServiceRegistration, SystemServiceKickstart, service_registration};
use tokio_util::sync::CancellationToken;

use crate::command_context::CommandContext;
use crate::commands::daemon::ending::end_running_daemon;
use crate::commands::daemon::install::system_service::write_line;
use crate::commands::daemon::registration::run_as_account;
use crate::commands::daemon::start::{
    STARTED_LINE, StartArgs, has_system_service_to_start, is_daemon_answering,
    kickstart_system_service, refuse_other_system_program, start_and_report,
    wait_for_system_service,
};
use crate::confirmation::{ConfirmationArgs, confirm};
use crate::connected_command::{cancel_on_ctrl_c, run_listening_for_ctrl_c};
use crate::exit_codes::{CommandFailure, ExitCode};

/// The question the restart asks before it ends anything.
const RESTART_QUESTION: &str =
    "Restart the background service? Work in flight continues once it is back.";

/// The line for a service the restart stopped and started again.
const RESTARTED_LINE: &str = "Restarted the background service.\n";

/// `daemon restart`'s options.
#[derive(Debug, Args)]
pub(crate) struct RestartArgs {
    #[command(flatten)]
    confirmation: ConfirmationArgs,
    #[command(flatten)]
    start: StartArgs,
}

/// What the restart's first half did.
enum RestartEnding {
    /// Nothing answered, so nothing was asked or ended.
    NotRunning,
    /// The person said no.
    Declined,
    /// The running service was ended.
    Ended,
}

/// Restarts the background service once the person confirms, and answers 0 once the new one
/// answers, its line on stdout; a service not running is started with no question, and a no
/// prints nothing. Fails with [`CommandFailure::SystemServiceRestartNeedsRoot`] where this
/// account's system service runs the service, as [`has_system_service_to_start`] fails, both with
/// nothing asked or stopped, with `CommandFailure::ConfirmationUnavailable` with no terminal and no
/// `--yes`, `ClientError::Canceled` after a Ctrl-C, as the handshake fails other than as a stopped
/// or starting service's does, and as the ending or [`start_and_report`] fails.
pub(crate) fn restart<Output: Write, ErrorOutput: Write>(
    args: &RestartArgs,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    if let Some(registration) = service_registration()
        && has_system_service_to_start(registration)?
    {
        return Err(CommandFailure::SystemServiceRestartNeedsRoot.into());
    }
    let prompt = &mut context.stderr;
    // Its own runtime, ended before the start, which runs on a runtime of its own.
    let ending = run_listening_for_ctrl_c(async |ctrl_c| {
        let cancel = CancellationToken::new();
        let is_confirmed = tokio::select! {
            asked = ask_to_restart(&args.confirmation, prompt, &cancel) => asked?,
            () = cancel_on_ctrl_c(ctrl_c, &cancel) => return Err(ClientError::Canceled.into()),
        };
        match is_confirmed {
            None => Ok(RestartEnding::NotRunning),
            Some(false) => Ok(RestartEnding::Declined),
            Some(true) => {
                end_running_daemon(
                    DaemonEndingVerb::Restart,
                    "could not stop the background service to restart it",
                    ctrl_c,
                )
                .await?;
                Ok(RestartEnding::Ended)
            }
        }
    })?;
    match ending {
        RestartEnding::NotRunning => start_and_report(&args.start, STARTED_LINE, context),
        RestartEnding::Declined => Ok(ExitCode::Success),
        RestartEnding::Ended => start_and_report(&args.start, RESTARTED_LINE, context),
    }
}

/// Restarts this account's system service with root's rights through `registration` once the
/// person confirms, and answers 0 with the restarted line on stdout, nothing for a no. Root cannot
/// reach the service, so the question is asked whether or not it runs, its stop runs this
/// program's `daemon stop --yes` as the account, whose failure lines show and whose exit code this
/// run then answers, and the start is waited for as [`wait_for_system_service`] waits. Fails as
/// [`refuse_other_system_program`] does with nothing asked, with
/// `CommandFailure::ConfirmationUnavailable` with no terminal and no `--yes`,
/// `ClientError::Canceled` after a Ctrl-C, and as the stop's run, the start, its wait or a write
/// fails.
pub(crate) fn restart_system_service<Output: Write, ErrorOutput: Write>(
    args: &RestartArgs,
    registration: ServiceRegistration,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    refuse_other_system_program(args.start.daemon_path.as_deref(), registration)?;
    let prompt = &mut context.stderr;
    let is_confirmed = run_listening_for_ctrl_c(async |ctrl_c| {
        let cancel = CancellationToken::new();
        tokio::select! {
            asked = confirm(RESTART_QUESTION, &args.confirmation, prompt, &cancel) => asked,
            () = cancel_on_ctrl_c(ctrl_c, &cancel) => Err(ClientError::Canceled.into()),
        }
    })?;
    if !is_confirmed {
        return Ok(ExitCode::Success);
    }
    // Its own line is dropped for the restart's.
    let stopped = run_as_account(registration, ["daemon", "stop", "--yes"], Stdio::null())?;
    if stopped != ExitCode::Success {
        return Ok(stopped);
    }
    // The stop half returns once the process ended, which launchd may not have read yet, so the
    // start ends whatever it still counts as running.
    kickstart_system_service(registration, SystemServiceKickstart::Restart)?;
    wait_for_system_service(registration, &args.start)?;
    write_line(context, RESTARTED_LINE)
}

/// Asks the restart's question where a service answers one handshake, a repairing one among
/// them, and answers the person's yes or no; `None` where nothing answers. Fails with
/// `ClientError::Canceled` once `cancel` is canceled, as the handshake fails other than as a
/// stopped or starting service's does, and as [`confirm`] does.
async fn ask_to_restart(
    args: &ConfirmationArgs,
    prompt: &mut impl Write,
    cancel: &CancellationToken,
) -> anyhow::Result<Option<bool>> {
    let endpoint = DaemonEndpoint::this_machine()
        .context("could not find where the background service listens")?;
    // The start's own line names a repair, so it is not shown here.
    let mut on_repairing = |_| {};
    let is_answering = tokio::select! {
        answering = is_daemon_answering(&endpoint, &mut on_repairing) => answering?,
        () = cancel.cancelled() => return Err(ClientError::Canceled.into()),
    };
    if !is_answering {
        return Ok(None);
    }
    confirm(RESTART_QUESTION, args, prompt, cancel)
        .await
        .map(Some)
}
