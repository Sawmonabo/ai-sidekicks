//! A short Codex command the daemon runs to its end for what it prints.

use std::io;
use std::process::Stdio;
use std::time::Duration;

use process_wrap::tokio::ChildWrapper;
use sidekicks_platforms::{Spawner, read_child_exit, wrap_child_command};
use tokio::io::AsyncReadExt;
use tokio::process::ChildStdout;

use crate::driver::codex::service::process::CodexProcessLaunch;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::service::supervisor::start::compose_codex_native_launch;
use crate::driver::codex::session::errors::CodexError;

/// The most a short command may print; the catalog dump, the largest, measured near 660 KB.
const CODEX_COMMAND_MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;

/// How long `codex debug models` may run: Codex bounds its models fetch at 5 s, and the command's
/// own start measured at most 119.5 ms over 20 signed-out runs.
const CODEX_CATALOG_READ_DEADLINE: Duration = Duration::from_millis(5_120);

/// Why a short Codex command gave no output.
#[derive(Debug, thiserror::Error)]
pub(crate) enum CodexCommandError {
    /// The command could not start.
    #[error("the Codex command could not start")]
    Start(#[source] io::Error),
    /// Its output could not be read.
    #[error("the Codex command's output could not be read")]
    Read(#[source] io::Error),
    /// The wait for its exit failed.
    #[error("the Codex command's exit could not be waited for")]
    Wait(#[source] io::Error),
    /// It printed more than the cap.
    #[error("the Codex command printed more than {limit} bytes")]
    OutputTooLarge {
        /// The cap, in bytes.
        limit: usize,
    },
    /// Its deadline passed before it ended.
    #[error("the Codex command did not end within {deadline:?}")]
    DeadlinePassed {
        /// The deadline it was given.
        deadline: Duration,
        /// The timer's end.
        #[source]
        elapsed: tokio::time::error::Elapsed,
    },
    /// It could not be ended once past its deadline or its cap.
    #[error("the Codex command could not be ended")]
    End(#[source] io::Error),
    /// It exited with a failure code.
    #[error("the Codex command exited with code {exit_code}")]
    Failed {
        /// The exit code, a Windows code read as its unsigned 32-bit value.
        exit_code: i64,
    },
    /// A signal ended it.
    #[error("the Codex command was ended by {signal}")]
    Signaled {
        /// The signal's name.
        signal: String,
    },
    /// What it printed is not UTF-8 text.
    #[error("the Codex command's output is not UTF-8 text")]
    NotText(#[source] std::string::FromUtf8Error),
}

/// Runs a short Codex command to its end on `spawner`'s thread, prepared as every child of the
/// daemon is, and answers its standard output; its input is closed and its error output discarded.
/// Fails with [`CodexCommandError`] when it cannot start, prints past 16 MiB, outlives `deadline`
/// (both of which kill it), exits with a failure code or a signal, or prints anything but UTF-8
/// text.
pub(crate) async fn run_codex_command(
    spawner: &Spawner,
    launch: CodexProcessLaunch,
    deadline: Duration,
) -> Result<String, CodexCommandError> {
    let mut command = launch.into_command();
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let daemon_pid = std::process::id();
    let mut child = spawner
        .run(move || wrap_child_command(command, daemon_pid).spawn())
        .await
        .and_then(|spawned| spawned)
        .map_err(CodexCommandError::Start)?;
    let standard_output = child
        .stdout()
        .take()
        .expect("the command's standard output is piped");
    let ran =
        tokio::time::timeout(deadline, read_to_end_and_wait(&mut *child, standard_output)).await;
    let (output, status) = match ran {
        Ok(ended) => ended?,
        Err(elapsed) => {
            end_command(&mut *child).await?;
            return Err(CodexCommandError::DeadlinePassed { deadline, elapsed });
        }
    };
    if !status.success() {
        let exit = read_child_exit(&status, None);
        return Err(match exit.signal_name {
            Some(signal) => CodexCommandError::Signaled { signal },
            None => CodexCommandError::Failed {
                exit_code: exit.exit_code,
            },
        });
    }
    String::from_utf8(output).map_err(CodexCommandError::NotText)
}

/// The model catalog of `service`'s home as `codex debug models` prints it, run by the Codex
/// command resolved now for that home. Fails with the resolve's driver error, as the launch's
/// composition fails, and with `CodexError::Transport` carrying the command's failure.
pub(crate) async fn read_codex_model_catalog_dump(
    service: &CodexService,
) -> Result<String, CodexError> {
    let dependencies = service.dependencies();
    let executable = dependencies
        .program
        .resolve(service.home())
        .await
        .map_err(CodexError::Driver)?;
    let launch = compose_codex_native_launch(
        &dependencies.data_folder,
        &executable,
        vec!["debug".to_owned(), "models".to_owned()],
    )
    .await?;
    run_codex_command(&dependencies.spawner, launch, CODEX_CATALOG_READ_DEADLINE)
        .await
        .map_err(|error| CodexError::Transport {
            detail: "Codex's model catalog could not be read.".to_owned(),
            cause: Some(Box::new(error)),
        })
}

// Reads the command's output to its end, killing it past the cap, then waits for its exit.
async fn read_to_end_and_wait(
    child: &mut dyn ChildWrapper,
    standard_output: ChildStdout,
) -> Result<(Vec<u8>, std::process::ExitStatus), CodexCommandError> {
    let limit = u64::try_from(CODEX_COMMAND_MAX_OUTPUT_BYTES).expect("the output cap fits 64 bits");
    let mut output = Vec::new();
    standard_output
        .take(limit + 1)
        .read_to_end(&mut output)
        .await
        .map_err(CodexCommandError::Read)?;
    if output.len() > CODEX_COMMAND_MAX_OUTPUT_BYTES {
        end_command(child).await?;
        return Err(CodexCommandError::OutputTooLarge {
            limit: CODEX_COMMAND_MAX_OUTPUT_BYTES,
        });
    }
    let status = child.wait().await.map_err(CodexCommandError::Wait)?;
    Ok((output, status))
}

// Kills a command past its deadline or its cap and reaps it.
async fn end_command(child: &mut dyn ChildWrapper) -> Result<(), CodexCommandError> {
    child.start_kill().map_err(CodexCommandError::End)?;
    child.wait().await.map_err(CodexCommandError::End)?;
    Ok(())
}
