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

use sidekicks_contracts::place::Place;
use sidekicks_platforms::{
    ChildEnd, ChildExit, ChildTree, ChildTreeOutputError, read_child_exit, read_stderr_left_at_exit,
};
use tokio::io::AsyncReadExt as _;
use tokio::process::ChildStderr;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::git::process::{GitCall, GitError, GitRunner, SHUTDOWN_STOP_GRACE};
use sidekicks_std::process_exit::OUTPUT_CHUNK_BYTES;
use sidekicks_std::utf8_stream::Utf8StreamDecoder;

/// How long git has to end after a person's cancel before it and its helpers are ended: long
/// enough for git to remove what it was writing, short enough that a cancel is felt.
pub(crate) const CANCEL_STOP_GRACE: Duration = Duration::from_secs(5);

// The most of git's standard error read at its exit, past which a process it left behind floods
// the pipe and the read fails.
const STDERR_LEFT_AT_EXIT_MAX_BYTES: usize = 1024 * 1024;

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
/// has exited and what it wrote before is read, without waiting on a process it left behind that
/// holds its standard error open. Fails with the start's, the read's, the wait's or the stop's
/// error.
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
    let git_exited = CancellationToken::new();
    let read_abandoned = CancellationToken::new();
    let reading = read_stderr(stderr, &git_exited, &read_abandoned, &mut on_stderr);
    let ending = async {
        let ended = wait_or_stop(&mut tree, cancel, shutdown).await;
        if ended.is_err() {
            // The run has failed, so nothing waits on the rest of its standard error.
            read_abandoned.cancel();
        } else {
            // A helper git left behind may hold its standard error open past its exit, so the
            // read takes what git wrote and ends.
            git_exited.cancel();
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

// Reads `stderr` to its end, or once `exited` while no output waits, what the pipe holds then; or
// until `abandoned` while no output waits. Decodes it across chunks into `on_stderr`. Fails with a
// read's error, or once what is read at the exit passes its bound.
async fn read_stderr(
    mut stderr: ChildStderr,
    exited: &CancellationToken,
    abandoned: &CancellationToken,
    on_stderr: &mut impl FnMut(&str),
) -> io::Result<()> {
    let mut decoder = Utf8StreamDecoder::default();
    let mut buffer = vec![0; OUTPUT_CHUNK_BYTES];
    loop {
        let count = tokio::select! {
            biased;
            read = stderr.read(&mut buffer) => read?,
            () = exited.cancelled() => {
                let mut left = Vec::new();
                read_stderr_left_at_exit(&mut stderr, &mut left, STDERR_LEFT_AT_EXIT_MAX_BYTES)
                    .await
                    .map_err(|error| match error {
                        ChildTreeOutputError::Io(error) => error,
                        too_large @ ChildTreeOutputError::TooLarge { .. } => {
                            io::Error::other(too_large)
                        }
                    })?;
                decoder.push(&left, &mut *on_stderr);
                0
            }
            () = abandoned.cancelled() => 0,
        };
        if count == 0 {
            decoder.finish(&mut *on_stderr);
            return Ok(());
        }
        decoder.push(&buffer[..count], &mut *on_stderr);
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;
    use std::time::{Duration, Instant};

    use tokio_util::sync::CancellationToken;

    use super::run_streamed_git;
    use crate::git::process::{GitCall, test_git_runner};
    use sidekicks_std::file::atomic_write::write_file_atomically;

    // Fails when the run waits past git's exit for the end of a standard error a hook's process
    // still holds, or loses what the hook wrote before git exited.
    #[tokio::test]
    async fn a_streamed_run_ends_at_git_exit_while_a_hook_child_holds_its_stderr() {
        let git = test_git_runner();
        let temporary = tempfile::tempdir().expect("the temporary folder is made");
        let repository = temporary.path().join("repository");
        let hooks = temporary.path().join("hooks");
        let stop_file = temporary.path().join("stop");
        git.run(
            None,
            GitCall::read([OsStr::new("init"), repository.as_os_str()]),
        )
        .await
        .expect("the repository is made");
        tokio::fs::create_dir(&hooks)
            .await
            .expect("the hooks folder is made");
        write_file_atomically(
            &hooks.join("post-checkout"),
            // The waiter holds the hook's standard error until the test makes the stop file, or
            // its temporary folder is gone after a failed assertion.
            format!(
                "#!/bin/sh\necho held >&2\n(while [ ! -e '{}' ] && [ -d '{}' ]; do sleep 0.1; \
                 done) &\n",
                stop_file.display(),
                hooks.display()
            ),
            0o755,
        )
        .await
        .expect("the hook is written");
        let hooks_path = format!("core.hooksPath={}", hooks.display());
        let call = GitCall::write([
            OsStr::new("-c"),
            OsStr::new(&hooks_path),
            OsStr::new("-C"),
            repository.as_os_str(),
            OsStr::new("hook"),
            OsStr::new("run"),
            OsStr::new("post-checkout"),
        ]);
        let mut stderr = String::new();
        let started_at = Instant::now();

        let ran = run_streamed_git(
            &git,
            None,
            call,
            &CancellationToken::new(),
            &CancellationToken::new(),
            |text| stderr.push_str(text),
        )
        .await;
        let elapsed = started_at.elapsed();
        // The waiter sees the stop file and ends, so it outlives nothing.
        std::fs::write(&stop_file, "").expect("the stop file is made");

        let exit = ran.expect("the run is followed to its end");
        assert!(exit.has_succeeded);
        assert_eq!(stderr, "held\n");
        assert!(elapsed < Duration::from_secs(10), "{elapsed:?}");
    }
}
