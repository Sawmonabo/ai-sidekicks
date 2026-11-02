//! `sidekicks daemon stop`: asks first, naming for each provider how many of its sessions typed in
//! a terminal the stop disconnects, then ends the background service through the one ending.
//! Nothing answering is a service already stopped, and a service repairing its database file is
//! stopped on the link it refused.

use std::io::Write;
use std::pin::pin;
use std::time::Duration;

use anyhow::Context as _;
use clap::Args;
use futures::FutureExt as _;
use sidekicks_client::daemon_connection::handshake_wait::is_not_ready_yet;
use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint, OpenedConnection};
use sidekicks_client::daemon_ending::{DaemonEnd, DaemonEndingVerb};
use sidekicks_client::error::ClientError;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::session::controls::methods::{
    ProviderTerminalSessionList, ProviderTerminalSessionListResponse,
};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::command_context::CommandContext;
use crate::commands::daemon::ending::end_running_daemon;
use crate::confirmation::{ConfirmationArgs, confirm};
use crate::connected_command::{cancel_on_ctrl_c, run_listening_for_ctrl_c};
use crate::exit_codes::ExitCode;
use crate::local::number::LocalNumberFormat;

/// The question the stop asks before it ends anything.
const STOP_QUESTION: &str = "Stop the background service? Work in flight stops, and nothing new \
                             starts until it is running again.";

/// The question's line in place of the counts when the sessions typed in a terminal could not be
/// read in time.
const COUNT_UNREAD_LINE: &str =
    "Could not count the sessions typed in a terminal. Any there will disconnect.";

/// How long the question waits for the sessions typed in a terminal before it asks without them.
const TERMINAL_SESSION_READ_BOUND: Duration = Duration::from_secs(3);

/// The line for a service that was not running.
const NOT_RUNNING_LINE: &str = "The background service is not running.\n";

/// `daemon stop`'s option.
#[derive(Debug, Args)]
pub(crate) struct StopArgs {
    #[command(flatten)]
    confirmation: ConfirmationArgs,
}

/// What the stop's question found out.
enum StopAnswer {
    /// Nothing answered, so nothing was asked.
    NotRunning,
    /// The person said no.
    Declined,
    /// The person said yes, or `--yes` said it.
    Confirmed,
}

/// The sessions typed in a terminal the question names.
enum TerminalSessionCount {
    /// Not read: `--yes` skips the question, and a service repairing its database file runs none.
    NotRead,
    /// The read failed or passed its bound.
    Unread,
    /// The service's answer.
    Read(ProviderTerminalSessionListResponse),
}

/// Stops the background service once the person confirms, and answers 0: the outcome's line on
/// stdout, nothing for a no. Fails with `CommandFailure::ConfirmationUnavailable` with no terminal and no
/// `--yes`, `ClientError::Canceled` after a Ctrl-C, as the connect fails other than as a stopped
/// or starting service's does, and as the ending or a write fails.
pub(crate) fn stop<Output: Write, ErrorOutput: Write>(
    args: &StopArgs,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let prompt = &mut context.stderr;
    let ended = run_listening_for_ctrl_c(async |ctrl_c| {
        let cancel = CancellationToken::new();
        let answer = tokio::select! {
            asked = ask_to_stop(&args.confirmation, prompt, &cancel) => asked?,
            () = cancel_on_ctrl_c(ctrl_c, &cancel) => return Err(ClientError::Canceled.into()),
        };
        match answer {
            StopAnswer::NotRunning => Ok(Some(DaemonEnd::NotRunning)),
            StopAnswer::Declined => Ok(None),
            StopAnswer::Confirmed => end_running_daemon(
                DaemonEndingVerb::Stop,
                "could not stop the background service",
                ctrl_c,
            )
            .await
            .map(Some),
        }
    })?;
    let line = match ended {
        None => return Ok(ExitCode::Success),
        Some(DaemonEnd::NotRunning) => NOT_RUNNING_LINE,
        Some(
            DaemonEnd::StoppedWhileRepairing
            | DaemonEnd::Exited
            | DaemonEnd::Ended(_)
            | DaemonEnd::ProcessNotFound,
        ) => "Stopped the background service.\n",
    };
    context.stdout.write_all(line.as_bytes())?;
    context.stdout.flush()?;
    Ok(ExitCode::Success)
}

/// Opens one connection to see whether the service answers, reads its sessions typed in a
/// terminal unless `--yes` skips the question, closes it, then asks. Fails with
/// `ClientError::Canceled` once `cancel` is canceled, as the connect fails other than as a stopped
/// or starting service's does, and as [`confirm`] does.
async fn ask_to_stop(
    args: &ConfirmationArgs,
    prompt: &mut impl Write,
    cancel: &CancellationToken,
) -> anyhow::Result<StopAnswer> {
    let endpoint = DaemonEndpoint::this_machine()
        .context("could not find where the background service listens")?;
    let opened = tokio::select! {
        opened = DaemonConnection::connect_or_repairing(endpoint) => opened,
        () = cancel.cancelled() => return Err(ClientError::Canceled.into()),
    };
    let count = match opened {
        Err(failure) if is_not_ready_yet(&failure) => return Ok(StopAnswer::NotRunning),
        Err(failure) => return Err(failure.into()),
        // Dropped, the repairing link closes; the ending opens its own.
        Ok(OpenedConnection::Repairing(_repairing)) => TerminalSessionCount::NotRead,
        Ok(OpenedConnection::Open(connection)) if args.yes => {
            connection.close().await;
            TerminalSessionCount::NotRead
        }
        Ok(OpenedConnection::Open(connection)) => {
            let count = read_terminal_sessions(&connection, cancel).await;
            connection.close().await;
            count
        }
    };
    if cancel.is_cancelled() {
        return Err(ClientError::Canceled.into());
    }
    let question = write_stop_question(&count, &LocalNumberFormat::read());
    Ok(if confirm(&question, args, prompt, cancel).await? {
        StopAnswer::Confirmed
    } else {
        StopAnswer::Declined
    })
}

/// Reads the sessions typed in a terminal within [`TERMINAL_SESSION_READ_BOUND`], canceled with
/// `cancel` or once the bound passes. A read that fails or passes its bound is unread, since the
/// stop never waits on its count.
async fn read_terminal_sessions(
    connection: &DaemonConnection,
    cancel: &CancellationToken,
) -> TerminalSessionCount {
    let bound = cancel.child_token();
    let mut listed = pin!(
        connection
            .client()
            .call_until::<ProviderTerminalSessionList>(&EmptyPayload {}, &bound)
    );
    let listed = match timeout(TERMINAL_SESSION_READ_BOUND, &mut listed).await {
        Ok(listed) => Some(listed),
        Err(_elapsed) => {
            bound.cancel();
            // One more poll sends the daemon the cancel; its answer is not waited on.
            listed.now_or_never()
        }
    };
    match listed {
        Some(Ok(sessions)) => TerminalSessionCount::Read(sessions),
        None | Some(Err(_)) => TerminalSessionCount::Unread,
    }
}

/// The stop's question: its sentence, then one line for each provider with sessions typed in a
/// terminal, its count in `numbers`' format and the provider's own name and resume command, or one
/// line saying they could not be counted.
fn write_stop_question(count: &TerminalSessionCount, numbers: &LocalNumberFormat) -> String {
    let count_lines = match count {
        TerminalSessionCount::NotRead => Vec::new(),
        TerminalSessionCount::Unread => vec![COUNT_UNREAD_LINE.to_owned()],
        TerminalSessionCount::Read(listed) => listed
            .providers
            .iter()
            .map(|provider| {
                let sessions = listed
                    .sessions
                    .iter()
                    .filter(|session| session.provider == provider.provider)
                    .count();
                let sessions = u64::try_from(sessions).expect("a count of sessions fits 64 bits");
                let noun = if sessions == 1 { "session" } else { "sessions" };
                format!(
                    "{} {} {noun} in a terminal will disconnect. To use one again, run {} in its \
                     terminal.",
                    numbers.count(sessions),
                    provider.name.as_str(),
                    provider.resume_command.as_str(),
                )
            })
            .collect(),
    };
    std::iter::once(STOP_QUESTION.to_owned())
        .chain(count_lines)
        .collect::<Vec<_>>()
        .join("\n")
}
