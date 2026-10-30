//! `sidekicks daemon start`: a daemon that answers the handshake, or answers that it is repairing
//! its database file, is already running; otherwise its program starts as a lasting child and the
//! command waits for its handshake. A started daemon that never answers is ended, and one that
//! exits first is named with its exit and why its start failed; either exits 69.

use std::fs::OpenOptions;
use std::future::Future;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::ExitStatus;
use std::time::Duration;

use anyhow::Context as _;
use clap::Args;
use sidekicks_client::daemon_connection::handshake_wait::{
    HandshakeWaitEnd, is_not_ready_yet, wait_for_handshake,
};
use sidekicks_client::daemon_connection::{
    DaemonConnection, DaemonEndpoint, HANDSHAKE_DEADLINE, OpenedConnection,
};
use sidekicks_client::daemon_ending::{DaemonEndingTerms, end_unanswered_process};
use sidekicks_client::error::ClientError;
use sidekicks_contracts::daemon::recovery::DaemonRepairingDetails;
use sidekicks_platforms::{
    LastingChild, LastingCommand, NULL_DEVICE_PATH, PinnedProcess, leave_daemon_scope,
    read_child_exit, spawn_lasting_child,
};

use crate::command_context::CommandContext;
use crate::commands::daemon::status::read_cannot_start;
use crate::connected_command::run_listening_for_ctrl_c;
use crate::daemon_program::daemon_program;
use crate::exit_codes::{CommandFailure, ExitCode};
use crate::program::describe_repairing;

/// `daemon start`'s options.
#[derive(Debug, Args)]
pub(crate) struct StartArgs {
    /// The background service's program to start, in place of the one installed beside this
    /// program.
    #[arg(long, value_name = "PATH")]
    daemon_path: Option<PathBuf>,
    /// How long to wait for the started background service to answer, in milliseconds [default:
    /// 10000].
    #[arg(long, value_name = "MS")]
    timeout: Option<u64>,
}

/// How a start ended without failing.
#[derive(Debug)]
pub(crate) enum DaemonStart {
    /// A daemon was already running, or another start's daemon answered first.
    AlreadyRunning,
    /// The started daemon answered the handshake.
    Started {
        /// Why the daemon could not leave this command's login scope, where it could not; it then
        /// ends with that scope.
        scope_refused: Option<io::Error>,
    },
}

/// The started daemon's exit, answered once it has exited and been reaped.
type DaemonExit = Pin<Box<dyn Future<Output = io::Result<ExitStatus>> + Send>>;

/// Starts the background service unless it is running, and answers 0 once it answers: the repair's
/// line on stderr while it repairs its database file, then the outcome's line on stdout. Fails as
/// [`start_daemon`] does, or as a write does.
pub(crate) fn start<Output: Write, ErrorOutput: Write>(
    args: &StartArgs,
    context: &mut CommandContext<Output, ErrorOutput>,
) -> anyhow::Result<ExitCode> {
    let deadline = args
        .timeout
        .map_or(HANDSHAKE_DEADLINE, Duration::from_millis);
    let mut repair_line = RepairLine::new(&mut context.stderr);
    let started = start_daemon(args.daemon_path.as_deref(), deadline, |details| {
        repair_line.show(details);
    });
    repair_line.finish()?;
    let line = match started? {
        DaemonStart::AlreadyRunning => "The background service is already running.\n",
        DaemonStart::Started { scope_refused } => {
            if let Some(refusal) = scope_refused {
                writeln!(
                    context.stderr,
                    "warning: the background service stops when this login ends, since it could \
                     not leave this login's scope: {refusal}"
                )?;
            }
            "Started the background service.\n"
        }
    };
    context.stdout.write_all(line.as_bytes())?;
    context.stdout.flush()?;
    Ok(ExitCode::Success)
}

/// The repair's line on stderr, written once however often a waited-for daemon answers that it is
/// repairing its database file; a failed write is kept for [`RepairLine::finish`].
pub(crate) struct RepairLine<'a, ErrorOutput: Write> {
    stderr: &'a mut ErrorOutput,
    is_shown: bool,
    written: io::Result<()>,
}

impl<'a, ErrorOutput: Write> RepairLine<'a, ErrorOutput> {
    /// A repair line not yet written to `stderr`.
    pub(crate) fn new(stderr: &'a mut ErrorOutput) -> Self {
        Self {
            stderr,
            is_shown: false,
            written: Ok(()),
        }
    }

    /// Writes the line for `details` unless it was written already.
    pub(crate) fn show(&mut self, details: DaemonRepairingDetails) {
        if !self.is_shown {
            self.is_shown = true;
            self.written = writeln!(self.stderr, "{}", describe_repairing(details));
        }
    }

    /// Ends the line's use; fails with its write's error where the write failed.
    pub(crate) fn finish(self) -> io::Result<()> {
        self.written
    }
}

/// Starts this machine's background service unless one answers, on a runtime of its own, and
/// answers once a daemon answers the handshake: `daemon start` calls it, and so does an account
/// command that needs the service running. The program is `daemon_path`, else the one installed
/// beside this program; the wait for its handshake lasts `deadline`, moved on by each answer that
/// the daemon is repairing its database file, whose details go to `on_repairing`. Fails with
/// [`CommandFailure::StartTimedOut`] when the started daemon does not answer in time, which is then
/// ended; [`CommandFailure::DaemonExited`] when it exits first and no other daemon answers;
/// `ClientError::Canceled` after a Ctrl-C; and as the program's resolution, its start or a
/// handshake that fails other than as a starting daemon's does.
pub(crate) fn start_daemon(
    daemon_path: Option<&Path>,
    deadline: Duration,
    mut on_repairing: impl FnMut(DaemonRepairingDetails),
) -> anyhow::Result<DaemonStart> {
    run_listening_for_ctrl_c(async |ctrl_c| {
        tokio::select! {
            started = start_and_wait(daemon_path, deadline, &mut on_repairing) => started,
            _ = ctrl_c.recv() => Err(ClientError::Canceled.into()),
        }
    })
}

/// [`start_daemon`]'s body on its runtime.
async fn start_and_wait(
    daemon_path: Option<&Path>,
    deadline: Duration,
    mut on_repairing: impl FnMut(DaemonRepairingDetails),
) -> anyhow::Result<DaemonStart> {
    let endpoint = DaemonEndpoint::this_machine()
        .context("could not find where the background service listens")?;
    if is_daemon_answering(&endpoint, &mut on_repairing).await? {
        return Ok(DaemonStart::AlreadyRunning);
    }
    let LastingChild {
        process, mut exit, ..
    } = spawn_daemon(daemon_path).await?;
    let scope_refused = leave_daemon_scope(process.id()).await.err();
    let waited =
        wait_for_handshake(endpoint.clone(), deadline, &mut on_repairing, exit.as_mut()).await;
    match waited {
        Ok(HandshakeWaitEnd::Connected(connection)) => {
            connection.close().await;
            Ok(DaemonStart::Started { scope_refused })
        }
        Ok(HandshakeWaitEnd::Ended(exited)) => {
            let status =
                exited.context("could not read how the background service's process ended")?;
            // Another start's daemon may have taken the data folder this one exited on.
            if is_daemon_answering(&endpoint, &mut on_repairing).await? {
                return Ok(DaemonStart::AlreadyRunning);
            }
            let exit = read_child_exit(&status, None);
            Err(match read_cannot_start() {
                Ok(cannot_start) => CommandFailure::DaemonExited { exit, cannot_start }.into(),
                Err(unread) => anyhow::Error::from(CommandFailure::DaemonExited {
                    exit,
                    cannot_start: None,
                })
                .context(format!("{unread:#}")),
            })
        }
        Err(failure) => {
            // A daemon this command started and cannot vouch for would hold the socket against
            // every later start.
            end_unanswered_daemon(process, exit).await?;
            Err(if is_not_ready_yet(&failure) {
                CommandFailure::StartTimedOut {
                    waited: deadline,
                    last_failure: failure,
                }
                .into()
            } else {
                failure.into()
            })
        }
    }
}

/// Whether a daemon answers one handshake at `endpoint`, a daemon repairing its database file
/// among them, whose details go to `on_repairing`. Fails as the handshake does other than as a
/// starting daemon's does.
async fn is_daemon_answering(
    endpoint: &DaemonEndpoint,
    on_repairing: &mut impl FnMut(DaemonRepairingDetails),
) -> Result<bool, ClientError> {
    match DaemonConnection::connect_or_repairing(endpoint.clone()).await {
        Ok(OpenedConnection::Open(connection)) => {
            connection.close().await;
            Ok(true)
        }
        Ok(OpenedConnection::Repairing(repairing)) => {
            on_repairing(repairing.details());
            Ok(true)
        }
        Err(failure) if is_not_ready_yet(&failure) => Ok(false),
        Err(failure) => Err(failure),
    }
}

/// Starts the daemon's program as a lasting child in this command's folder and environment, its
/// error output discarded, on a blocking thread. Fails as the program's resolution, the current
/// folder's read or the start does.
async fn spawn_daemon(daemon_path: Option<&Path>) -> anyhow::Result<LastingChild> {
    let program = daemon_program(daemon_path)?;
    // Opened for writing too, since the child writes its error output to it.
    let error_output = OpenOptions::new()
        .read(true)
        .write(true)
        .open(NULL_DEVICE_PATH)
        .context("could not open the null device for the background service's error output")?;
    let command = LastingCommand {
        program: program.clone(),
        arguments: Vec::new(),
        environment: std::env::vars_os().collect(),
        working_folder: std::env::current_dir().context("could not read the current folder")?,
        error_output,
    };
    tokio::task::spawn_blocking(move || spawn_lasting_child(command))
        .await
        .context("the background service's start stopped before it answered")?
        .with_context(|| {
            format!(
                "could not start the background service's program {}",
                program.display()
            )
        })
}

/// Ends the started daemon `process` as one that never answered, then reaps it through `exit`.
/// Fails as the ending or the reap does.
async fn end_unanswered_daemon(process: PinnedProcess, exit: DaemonExit) -> anyhow::Result<()> {
    end_unanswered_process(&DaemonEndingTerms::default(), process)
        .await
        .context("could not stop the background service that did not answer")?;
    exit.await
        .context("could not read how the background service's process ended")?;
    Ok(())
}
