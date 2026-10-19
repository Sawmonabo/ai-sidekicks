//! One git run whose standard error is read as git writes it, for a command that reports progress
//! (a clone, a large-files pull) or one the service's stop must end (the background fetch), with a
//! stop that asks git and every helper it started to end, then ends them all after a grace.
//!
//! Removing what git left behind, a clone's staged folder among them, is the caller's whatever git
//! did: git removes its own partial clone only when it is asked to stop while it downloads, never
//! when it is ended outright, as the grace's end and every stop on Windows end it.

use std::io;
use std::process::ExitStatus;
use std::time::Duration;

use sidekicks_contracts::daemon::lifecycle::DAEMON_STOP_TERMINAL_DRAIN_MS;
use sidekicks_contracts::place::Place;
use sidekicks_platforms::{ChildEnd, ChildExit, ChildTree, read_child_exit};
use tokio::io::AsyncReadExt as _;
use tokio::process::ChildStderr;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::git::process::{GitCall, GitError, GitRunner};
use crate::utf8_stream::Utf8StreamDecoder;

/// How long git has to end after a person's cancel before it and its helpers are ended: long
/// enough for git to remove what it was writing, short enough that a cancel is felt.
pub(crate) const CANCEL_STOP_GRACE: Duration = Duration::from_secs(5);

/// How long git has to end at the service's stop: the window the stop gives its terminals.
pub(crate) const SHUTDOWN_STOP_GRACE: Duration =
    Duration::from_millis(DAEMON_STOP_TERMINAL_DRAIN_MS);

// The most one read of git's standard error takes.
const STDERR_READ_CHUNK: usize = 8 * 1024;

/// How a streamed git run ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StreamedGitExit {
    /// Its exit code, or the name of the signal that ended it, or on Windows of the end the stop
    /// asked.
    pub(crate) exit: ChildExit,
    /// Whether git exited 0.
    pub(crate) has_succeeded: bool,
}

/// Why a streamed git run could not be followed to its end.
#[derive(Debug, thiserror::Error)]
pub(crate) enum StreamedGitError {
    /// git could not be started: a project in a WSL 2 distribution, no git found, or the start
    /// failed.
    #[error("git could not be started")]
    Start(#[source] GitError),
    /// git's standard error could not be read.
    #[error("git's standard error could not be read")]
    Read(#[source] io::Error),
    /// git's exit could not be read.
    #[error("git's exit could not be read")]
    Wait(#[source] io::Error),
    /// git's tree could not be asked to stop, so it was ended at once.
    #[error("git could not be asked to stop, so it was ended at once")]
    Stop(#[source] io::Error),
    /// git's tree could not be asked to stop, nor ended.
    #[error("git could not be asked to stop ({asked}), nor ended")]
    NotEnded {
        /// Why the ask failed.
        asked: io::Error,
        /// Why the end failed.
        #[source]
        end: io::Error,
    },
    /// git did not end within its grace, and its tree could not be ended.
    #[error("git did not end within its grace and could not be ended")]
    End(#[source] io::Error),
}

/// Runs `call` for a project at `place`, its standard error decoded as it arrives (a character a
/// chunk cuts waits for the next chunk; bytes that are not UTF-8 read as U+FFFD once) and handed
/// to `on_stderr`, nothing of it kept. On `cancel` git's tree is asked to stop and ended after
/// [`CANCEL_STOP_GRACE`], on `shutdown` after [`SHUTDOWN_STOP_GRACE`]; the exit comes once git
/// has exited and its standard error has ended. Fails with the start's, the read's, the wait's or
/// the stop's error.
#[expect(dead_code, reason = "the clone service's git and the background fetch")]
pub(crate) async fn run_streamed_git(
    git: &GitRunner,
    place: Option<&Place>,
    call: GitCall,
    cancel: &CancellationToken,
    shutdown: &CancellationToken,
    mut on_stderr: impl FnMut(&str),
) -> Result<StreamedGitExit, StreamedGitError> {
    let mut tree = git
        .start(place, call)
        .await
        .map_err(StreamedGitError::Start)?;
    let stderr = tree
        .take_stderr()
        .expect("a started git's standard error is piped");
    let read_ended = CancellationToken::new();
    let read_abandoned = CancellationToken::new();
    let reading = async {
        let read = read_stderr(stderr, &read_abandoned, &mut on_stderr).await;
        read_ended.cancel();
        read
    };
    let ending = async {
        let ended = wait_or_stop(&mut tree, cancel, shutdown).await;
        if ended.is_err() {
            // The run has failed, so nothing waits on the rest of its standard error.
            read_abandoned.cancel();
            return ended;
        }
        // A helper git left behind may hold its standard error open past its exit; a stop then
        // ends the read instead of waiting on it.
        tokio::select! {
            biased;
            () = read_ended.cancelled() => {}
            () = shutdown.cancelled() => read_abandoned.cancel(),
            () = cancel.cancelled() => read_abandoned.cancel(),
        }
        ended
    };
    let (read, ended) = tokio::join!(reading, ending);
    let (status, asked_end) = ended?;
    read.map_err(StreamedGitError::Read)?;
    Ok(StreamedGitExit {
        exit: read_child_exit(&status, asked_end),
        has_succeeded: status.success(),
    })
}

// Waits for git's exit, or on a stop asks its tree to stop and ends it once the stop's grace has
// passed; the exit comes with the end the stop asked, if any.
async fn wait_or_stop(
    tree: &mut ChildTree,
    cancel: &CancellationToken,
    shutdown: &CancellationToken,
) -> Result<(ExitStatus, Option<ChildEnd>), StreamedGitError> {
    let grace = tokio::select! {
        biased;
        status = tree.wait() => return Ok((status.map_err(StreamedGitError::Wait)?, None)),
        () = shutdown.cancelled() => SHUTDOWN_STOP_GRACE,
        () = cancel.cancelled() => CANCEL_STOP_GRACE,
    };
    // Armed before the ask, so the end keeps to the grace however long the ask takes.
    let deadline = Instant::now() + grace;
    if let Err(asked) = tree.ask_tree_to_stop().await {
        // git may still be running, so it is ended at once rather than after the grace.
        return Err(match tree.end_tree().await {
            Ok(()) => StreamedGitError::Stop(asked),
            Err(end) => StreamedGitError::NotEnded { asked, end },
        });
    }
    match tokio::time::timeout_at(deadline, tree.wait()).await {
        Ok(status) => Ok((
            status.map_err(StreamedGitError::Wait)?,
            Some(ChildEnd::Stop),
        )),
        Err(_elapsed) => {
            tree.end_tree().await.map_err(StreamedGitError::End)?;
            // The end reaped git, so this wait answers at once with the exit it kept.
            let status = tree.wait().await.map_err(StreamedGitError::Wait)?;
            Ok((status, Some(ChildEnd::Kill)))
        }
    }
}

// Reads `stderr` to its end, or until `abandoned` while no output waits, decoding it across
// chunks into `on_stderr`.
async fn read_stderr(
    mut stderr: ChildStderr,
    abandoned: &CancellationToken,
    on_stderr: &mut impl FnMut(&str),
) -> io::Result<()> {
    let mut decoder = Utf8StreamDecoder::default();
    let mut buffer = vec![0; STDERR_READ_CHUNK];
    loop {
        let count = tokio::select! {
            biased;
            read = stderr.read(&mut buffer) => read?,
            () = abandoned.cancelled() => 0,
        };
        if count == 0 {
            decoder.finish(&mut *on_stderr);
            return Ok(());
        }
        decoder.push(&buffer[..count], &mut *on_stderr);
    }
}
