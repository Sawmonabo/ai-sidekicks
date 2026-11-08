//! Claude Code commands that run once and exit: started as every child of the daemon starts, in
//! their resolved build's environment alone, every exporter off, with their exit read and, where
//! asked, the tail of their error output.

use std::io;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use sidekicks_contracts::error::ERROR_MESSAGE_MAX_LEN;
use sidekicks_platforms::{ChildExit, Spawner, read_child_exit, wrap_child_command};
use sidekicks_std::output_tail::{OutputTail, read_output_chunks};

use super::command::compose_claude_command;
use super::settings::compose_claude_export_off_settings;
use crate::spawned_version::ResolvedProviderExecutable;

/// The longest one write of Claude Code's MCP config runs: the wait for Claude Code's lock and
/// every `claude` command the write runs share one deadline this far from the write's start.
pub(crate) const CLAUDE_MCP_WRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// How a one-shot command ended.
pub(crate) struct ClaudeOneShotExit {
    /// Its exit code, or the signal that ended it.
    pub(crate) exit: ChildExit,
    /// The tail of what it wrote to its error output, where the caller kept it.
    pub(crate) error_output: Option<String>,
}

impl ClaudeOneShotExit {
    /// Whether it exited with code 0, which an end by a signal never is.
    pub(crate) fn is_success(&self) -> bool {
        self.exit.signal_number.is_none() && self.exit.exit_code == 0
    }
}

/// Why a one-shot command's exit was not read.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeOneShotError {
    /// The command could not start.
    #[error("the Claude Code command could not start")]
    Start(#[source] io::Error),
    /// The wait for its exit failed.
    #[error("the Claude Code command's exit could not be waited for")]
    Wait(#[source] io::Error),
}

/// The command line of a Claude Code subcommand run outside the launcher: the export-off settings
/// document inline, then `subcommand`. The document goes first, since the root parser takes its own
/// options only before a subcommand, and Claude Code reads it before any command runs.
pub(crate) fn compose_claude_subcommand_arguments(subcommand: &[&str]) -> Vec<String> {
    [
        "--settings".to_owned(),
        compose_claude_export_off_settings(),
    ]
    .into_iter()
    .chain(subcommand.iter().map(|argument| (*argument).to_owned()))
    .collect()
}

/// Runs `executable` with `arguments` after the export-off settings in `working_folder`, in the
/// build's environment alone, started on `spawner`'s thread as every child of the daemon starts,
/// and reads its exit. Its
/// output is never read; its error output is read to its end and kept to its tail where
/// `is_error_output_kept`. A caller bounds the run by dropping it, which kills the command. Fails
/// as the command cannot start or the wait for its exit fails.
pub(crate) async fn run_claude_one_shot(
    spawner: &Spawner,
    executable: &ResolvedProviderExecutable,
    arguments: &[&str],
    working_folder: &Path,
    is_error_output_kept: bool,
) -> Result<ClaudeOneShotExit, ClaudeOneShotError> {
    let mut command = compose_claude_command(
        &executable.start,
        &compose_claude_subcommand_arguments(arguments),
        &executable.environment,
        working_folder,
    );
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(if is_error_output_kept {
            Stdio::piped()
        } else {
            Stdio::null()
        });
    let daemon_pid = std::process::id();
    let mut child = spawner
        .run(move || wrap_child_command(command, daemon_pid).spawn())
        .await
        .and_then(|spawned| spawned)
        .map_err(ClaudeOneShotError::Start)?;
    let error_output = child.stderr().take();
    // The error output is read beside the wait, so a command that fills its pipe still exits.
    let read_error_output = async {
        let error_output = error_output?;
        let mut tail = OutputTail::<ERROR_MESSAGE_MAX_LEN>::new();
        read_output_chunks(
            error_output,
            "a Claude Code command's error output",
            |chunk| tail.push(chunk),
        )
        .await;
        Some(tail.into_text())
    };
    let (status, error_output) = tokio::join!(child.wait(), read_error_output);
    let status = status.map_err(ClaudeOneShotError::Wait)?;
    Ok(ClaudeOneShotExit {
        exit: read_child_exit(&status, None),
        error_output,
    })
}
