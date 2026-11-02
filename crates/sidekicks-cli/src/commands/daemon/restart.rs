//! `sidekicks daemon restart`: asks first, ends the background service with `daemon.restart`
//! through the one ending, then starts it through the one start. Nothing answering is a start
//! with no question; a service repairing its database file is stopped on the link it refused, and
//! the start then waits on the repair.

use std::io::Write;

use anyhow::Context as _;
use clap::Args;
use sidekicks_client::daemon_connection::DaemonEndpoint;
use sidekicks_client::daemon_ending::DaemonEndingVerb;
use sidekicks_client::error::ClientError;
use tokio_util::sync::CancellationToken;

use crate::command_context::CommandContext;
use crate::commands::daemon::ending::end_running_daemon;
use crate::commands::daemon::start::{
    STARTED_LINE, StartArgs, is_daemon_answering, start_and_report,
};
use crate::confirmation::{ConfirmationArgs, confirm};
use crate::connected_command::{cancel_on_ctrl_c, run_listening_for_ctrl_c};
use crate::exit_codes::ExitCode;

/// The question the restart asks before it ends anything.
const RESTART_QUESTION: &str =
    "Restart the background service? Work in flight continues once it is back.";

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
/// prints nothing. Fails with `CommandFailure::ConfirmationUnavailable` with no terminal and no
/// `--yes`, `ClientError::Canceled` after a Ctrl-C, as the handshake fails other than as a stopped
/// or starting service's does, and as the ending or [`start_and_report`] fails.
pub(crate) fn restart<Output: Write, ErrorOutput: Write>(
    args: &RestartArgs,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
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
        RestartEnding::Ended => {
            start_and_report(&args.start, "Restarted the background service.\n", context)
        }
    }
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
