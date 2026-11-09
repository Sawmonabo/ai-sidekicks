//! `sidekicks daemon stop`: asks first, naming for each provider how many of its sessions typed in
//! a terminal the stop disconnects, then ends the background service through the one ending.
//! Nothing answering is a service already stopped, and a service repairing its database file is
//! stopped on the link it refused. Once the ending answers, the status file says whether the stop
//! happened: a stop that could not keep the person's Stop, or a step still running, is a stop that
//! did not.

use std::io::Write;
use std::path::Path;
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
use sidekicks_platforms::daemon_run_folder;
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use crate::command_context::CommandContext;
use crate::commands::daemon::ending::end_running_daemon;
use crate::commands::daemon::service_status::{describe_failed_stop, read_status_file_at};
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

/// The line for a stop that happened.
const STOPPED_LINE: &str = "Stopped the background service.\n";

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

/// What a stop that ended says.
#[derive(Debug, PartialEq, Eq)]
enum StopReport {
    /// The stop happened, or nothing was running: the line for stdout.
    Done(&'static str),
    /// The stop did not happen: `Could not stop.` over its reason, for stderr.
    CouldNotStop(String),
}

/// Stops the background service once the person confirms: the outcome's line on stdout and 0,
/// nothing for a no, and `Could not stop.` with its reason on stderr and 75 where the status file
/// says the stop did not happen. Fails with `CommandFailure::ConfirmationUnavailable` with no
/// terminal and no `--yes`, `ClientError::Canceled` after a Ctrl-C, as the connect fails other than
/// as a stopped or starting service's does, and as the ending, the status file's read or a write
/// fails.
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
    let Some(ended) = ended else {
        return Ok(ExitCode::Success);
    };
    let run_folder = daemon_run_folder()
        .context("could not find where the background service records its status")?;
    match report_stop(ended, &run_folder.status_path, &mut context.stderr)? {
        StopReport::Done(line) => {
            context.stdout.write_all(line.as_bytes())?;
            context.stdout.flush()?;
            Ok(ExitCode::Success)
        }
        StopReport::CouldNotStop(lines) => {
            context.stderr.write_all(lines.as_bytes())?;
            context.stderr.flush()?;
            Ok(ExitCode::TemporaryFailure)
        }
    }
}

/// What the stop that ended as `ended` says, read from the status file at `path`, a torn file's
/// warning written to `stderr`. Fails as that read or the record's process pin fails.
fn report_stop(
    ended: DaemonEnd,
    path: &Path,
    stderr: &mut impl Write,
) -> anyhow::Result<StopReport> {
    let failed = match read_status_file_at(path, stderr)? {
        Some(file) => describe_failed_stop(&file)
            .context("could not read whether the background service's stop happened")?,
        None => None,
    };
    Ok(match (failed, ended) {
        (Some(lines), _) => StopReport::CouldNotStop(lines),
        (None, DaemonEnd::NotRunning) => StopReport::Done(NOT_RUNNING_LINE),
        (
            None,
            DaemonEnd::StoppedWhileRepairing
            | DaemonEnd::Exited
            | DaemonEnd::Ended(_)
            | DaemonEnd::ProcessNotFound,
        ) => StopReport::Done(STOPPED_LINE),
    })
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

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::json;
    use sidekicks_client::daemon_ending::DaemonEnd;
    use sidekicks_contracts::wire::instant::WireInstant;
    use sidekicks_platforms::ChildEnd;

    use super::{NOT_RUNNING_LINE, STOPPED_LINE, StopReport, report_stop};

    /// Which process a `stopping` record names.
    #[derive(Clone, Copy, Debug)]
    enum RecordedProcess {
        /// This test's own process, which runs.
        Running,
        /// This test's process id with another start, so no process it names runs.
        Ended,
    }

    /// When a `stopping` record's stop began.
    #[derive(Clone, Copy, Debug)]
    enum StopStarted {
        /// Long before now, past the stop's bound.
        PastTheBound,
        /// Now, within the bound.
        Now,
    }

    /// What the status file holds after the ending.
    #[derive(Clone, Copy, Debug)]
    enum StatusFile {
        Missing,
        CannotStop,
        Stopping(RecordedProcess, StopStarted),
    }

    const STILL_CLOSING_THE_SEARCH_INDEX: &str =
        "Could not stop.\nThe background service is still closing the search index.\n";

    const INTENT_UNSAVED: &str = "Could not stop.\nThe background service could not save that \
                                  you stopped it, so it may resume your sessions when it starts.\n";

    fn stopping_record(process: RecordedProcess, started: StopStarted) -> String {
        let identity = sidekicks_platforms::process_identity(std::process::id())
            .expect("this process's identity reads")
            .expect("this process runs");
        let mut identity = serde_json::to_value(identity).expect("an identity writes as JSON");
        if let RecordedProcess::Ended = process {
            let start = identity["processStartTime"]
                .as_str()
                .expect("the start is text");
            identity["processStartTime"] = json!(format!("{start}0"));
        }
        let stop_started = match started {
            StopStarted::PastTheBound => "2026-11-03T23:00:00.000Z".to_owned(),
            StopStarted::Now => WireInstant::now().as_str().to_owned(),
        };
        json!({
            "stopping": { "step": "searchIndex", "stopStarted": stop_started, "process": identity }
        })
        .to_string()
    }

    /// A stop says it happened unless the status file says it did not: a Stop that could not be
    /// kept whatever the process, or a step past the bound in a process still running. A step
    /// whose process ended, or one within the bound, is a stop that happened. Killed by the file
    /// left unread, by the process check or the bound dropped, and by a wrong step's words.
    #[rstest]
    #[case::stopped(StatusFile::Missing, DaemonEnd::Exited, StopReport::Done(STOPPED_LINE))]
    #[case::killed(
        StatusFile::Missing,
        DaemonEnd::Ended(ChildEnd::Kill),
        StopReport::Done(STOPPED_LINE)
    )]
    #[case::not_running(
        StatusFile::Missing,
        DaemonEnd::NotRunning,
        StopReport::Done(NOT_RUNNING_LINE)
    )]
    #[case::intent_unsaved(
        StatusFile::CannotStop,
        DaemonEnd::Exited,
        StopReport::CouldNotStop(INTENT_UNSAVED.to_owned())
    )]
    #[case::step_still_running(
        StatusFile::Stopping(RecordedProcess::Running, StopStarted::PastTheBound),
        DaemonEnd::ProcessNotFound,
        StopReport::CouldNotStop(STILL_CLOSING_THE_SEARCH_INDEX.to_owned())
    )]
    #[case::step_of_an_ended_process(
        StatusFile::Stopping(RecordedProcess::Ended, StopStarted::PastTheBound),
        DaemonEnd::ProcessNotFound,
        StopReport::Done(STOPPED_LINE)
    )]
    #[case::step_within_the_bound(
        StatusFile::Stopping(RecordedProcess::Running, StopStarted::Now),
        DaemonEnd::ProcessNotFound,
        StopReport::Done(STOPPED_LINE)
    )]
    fn a_stop_reports_what_the_status_file_says(
        #[case] status_file: StatusFile,
        #[case] ended: DaemonEnd,
        #[case] expected: StopReport,
    ) {
        let folder = tempfile::tempdir().expect("a temporary folder");
        let path = folder.path().join("service-status.json");
        let contents = match status_file {
            StatusFile::Missing => None,
            StatusFile::CannotStop => Some(r#"{"cannotStop":{"reason":"stopIntent"}}"#.to_owned()),
            StatusFile::Stopping(process, started) => Some(stopping_record(process, started)),
        };
        if let Some(contents) = contents {
            std::fs::write(&path, contents).expect("the status file is written");
        }
        let mut stderr = Vec::new();

        let report = report_stop(ended, &path, &mut stderr).expect("the stop's report reads");

        assert_eq!(report, expected);
        assert_eq!(String::from_utf8(stderr).expect("UTF-8"), "");
    }
}
