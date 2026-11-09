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

#[cfg(test)]
mod tests {
    use sidekicks_client::error::ClientError;
    use sidekicks_contracts::daemon::mode_outcome::DaemonModeOutcome;
    use sidekicks_platforms::{StandInAnswer, StandInProgram, write_stand_in_program};

    use super::run_offline_mode;

    // Runs a stand-in for the daemon's program that prints `standard_output` and exits with
    // `exit_code`, and answers how `run_offline_mode` failed.
    async fn run_stand_in(standard_output: String, exit_code: u8) -> anyhow::Error {
        let folder = tempfile::tempdir().expect("a scratch folder is made");
        let program = write_stand_in_program(
            folder.path(),
            "daemon",
            &StandInProgram {
                answers_by_argument: Vec::new(),
                otherwise: StandInAnswer {
                    standard_output,
                    exit_code,
                    argument_record: None,
                    ..StandInAnswer::default()
                },
                first_call_wait: None,
            },
        )
        .expect("the stand-in is written");
        run_offline_mode(&program, Vec::new())
            .await
            .expect_err("the stand-in's run fails")
    }

    // The mode's own refusal is the service's answer, which the install reads as a move the mode
    // put back itself. Killed by reading the printed refusal as anything but `Remote`.
    #[tokio::test]
    async fn a_mode_that_answers_its_refusal_fails_as_the_services_answer() {
        let refusal = serde_json::to_string(&DaemonModeOutcome::<()>::failed(
            "the keychain is locked".to_owned(),
        ))
        .expect("the refusal is written as JSON");
        let failure = run_stand_in(refusal, 1).await;
        assert!(
            matches!(failure.downcast_ref::<ClientError>(), Some(ClientError::Remote(remote))
                if remote.message == "the keychain is locked"),
            "{failure:?}"
        );
    }

    // A program that ended with no answer did not put anything back, so its failure must not read
    // as the mode's own refusal. Killed by mapping the unread answer to `Remote`, and by a failure
    // that drops how the program ended.
    #[tokio::test]
    async fn a_mode_that_ends_with_no_answer_fails_naming_its_ending() {
        let failure = run_stand_in(String::new(), 3).await;
        assert!(
            !failure
                .chain()
                .any(|cause| matches!(cause.downcast_ref(), Some(ClientError::Remote(_)))),
            "{failure:?}"
        );
        assert!(
            failure.to_string().contains("with exit code 3"),
            "{failure}"
        );
    }
}
