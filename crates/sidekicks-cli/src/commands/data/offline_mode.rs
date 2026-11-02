//! The run of a `data` command that acts with the background service stopped: a service that
//! answers refuses the command before it asks anything, then the person's yes, then the daemon's
//! own program run in one of its offline modes, whose one JSON answer on its standard output says
//! how the act went.

use std::ffi::OsString;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::Context as _;
use sidekicks_client::daemon_connection::DaemonEndpoint;
use sidekicks_client::error::{ClientError, RemoteError};
use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
use sidekicks_platforms::read_child_exit;
use tokio_util::sync::CancellationToken;

use crate::commands::daemon::start::is_daemon_answering;
use crate::connected_command::{cancel_on_ctrl_c, run_listening_for_ctrl_c};
use crate::daemon_program::daemon_program;
use crate::exit_codes::{CommandFailure, describe_child_ending};

/// Runs the `data` command named `command`: refuses it while the service answers, then asks
/// through `ask`, which answers whether the person said yes, then runs the daemon's program with
/// `mode_arguments`. Answers whether the mode ran, false when the person said no. Fails with
/// [`CommandFailure::ServiceRunning`] while the service answers, with `ClientError::Canceled`
/// after a Ctrl-C before the mode starts, as `ask` fails, when the daemon's program beside this
/// one cannot be found, and as [`run_offline_mode`] does.
pub(crate) fn run_offline_command(
    command: &'static str,
    ask: impl AsyncFnOnce(&CancellationToken) -> anyhow::Result<bool>,
    mode_arguments: Vec<OsString>,
) -> anyhow::Result<bool> {
    run_listening_for_ctrl_c(async |ctrl_c| {
        let cancel = CancellationToken::new();
        let is_confirmed = tokio::select! {
            asked = async {
                refuse_while_running(command, &cancel).await?;
                ask(&cancel).await
            } => asked?,
            () = cancel_on_ctrl_c(ctrl_c, &cancel) => return Err(ClientError::Canceled.into()),
        };
        if !is_confirmed {
            return Ok(false);
        }
        // The listener stays held but unwatched from here: a Ctrl-C reaches the mode, which shares
        // the terminal, and the command still reads how the mode ended.
        run_offline_mode(&daemon_program(None)?, mode_arguments).await?;
        Ok(true)
    })
}

/// Refuses the `data` command named `command` when one handshake finds a service: any answer,
/// a repairing one or a refusal among them. Fails with [`CommandFailure::ServiceRunning`] then,
/// with `ClientError::Canceled` once `cancel` is canceled, and as the handshake fails other than
/// as a stopped or starting service's does.
async fn refuse_while_running(
    command: &'static str,
    cancel: &CancellationToken,
) -> anyhow::Result<()> {
    let endpoint = DaemonEndpoint::this_machine()
        .context("could not find where the background service listens")?;
    // A repairing service is running too, so its details are not shown.
    let mut on_repairing = |_| {};
    let answered = tokio::select! {
        answered = is_daemon_answering(&endpoint, &mut on_repairing) => answered,
        () = cancel.cancelled() => return Err(ClientError::Canceled.into()),
    };
    match answered {
        Ok(true) | Err(ClientError::Remote(_)) => {
            Err(CommandFailure::ServiceRunning { command }.into())
        }
        Ok(false) => Ok(()),
        Err(failure) => Err(failure.into()),
    }
}

/// Runs the daemon's program `program` with `arguments`, its input empty and its error output on
/// this command's, on a blocking thread, and reads its one answer from its standard output. Fails
/// with the mode's refusal or failure as a `ClientError::Remote`, so the command ends as it would
/// on the service's own answer; as the program's start fails; and, naming how the program ended,
/// when its answer does not read.
pub(crate) async fn run_offline_mode(
    program: &Path,
    arguments: Vec<OsString>,
) -> anyhow::Result<()> {
    let run_program = program.to_owned();
    let output = tokio::task::spawn_blocking(move || {
        Command::new(run_program)
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .output()
    })
    .await
    .context("the background service's program stopped before it answered")?
    .with_context(|| {
        format!(
            "could not run the background service's program {}",
            program.display()
        )
    })?;
    match serde_json::from_slice::<DaemonModeOutcome<()>>(&output.stdout) {
        Ok(DaemonModeOutcome::Result(())) => Ok(()),
        Ok(DaemonModeOutcome::Error(error)) => {
            Err(ClientError::Remote(RemoteError::from(error)).into())
        }
        Err(unread) => Err(anyhow::Error::from(unread).context(format!(
            "the background service's program ended {} with no answer that reads",
            describe_child_ending(&read_child_exit(&output.status, None))
        ))),
    }
}
