//! The terminal's Ctrl-C on macOS and Linux: the wait for SIGINT, through tokio's signal driver,
//! and the ending a command takes after it, SIGINT's default action put back and raised, so the
//! shell that ran the command reads it as ended by Ctrl-C (`130`) and a script running it stops
//! too.

use std::io;

use tokio::signal::unix::{Signal, SignalKind, signal};

/// The terminal's Ctrl-C, listened for from [`ctrl_c`] until the listener drops; the command
/// holds it for its whole life, so every Ctrl-C reaches it rather than ending the process early.
#[derive(Debug)]
pub struct CtrlCListener(Signal);

impl CtrlCListener {
    /// Waits for the next Ctrl-C. Answers `None` only once the runtime is shutting down, when no
    /// Ctrl-C can arrive any more.
    pub async fn recv(&mut self) -> Option<()> {
        self.0.recv().await
    }
}

/// Starts listening for the terminal's Ctrl-C (SIGINT), from inside a tokio runtime. tokio keeps
/// its handler for the rest of the process's life, so a Ctrl-C no longer ends the process by
/// itself, and the command ends through [`end_as_ctrl_c`]. Fails when the handler cannot be
/// installed.
pub fn ctrl_c() -> io::Result<CtrlCListener> {
    signal(SignalKind::interrupt()).map(CtrlCListener)
}

/// Ends the process the way a Ctrl-C does: puts SIGINT's default action back and raises it, so
/// the shell reads the exit as `130`; the caller flushes its output first, since no destructor
/// runs. Returns only on failure, with the error that kept SIGINT's default action from being put
/// back.
pub fn end_as_ctrl_c() -> io::Error {
    match signal_hook::low_level::emulate_default_handler(libc::SIGINT) {
        // SIGINT's default action ends the process, and the call aborts if it somehow survives.
        Ok(()) => io::Error::other("SIGINT's default action did not end the process"),
        Err(error) => error,
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead as _, BufReader, Write as _};
    use std::os::unix::process::ExitStatusExt as _;
    use std::process::Stdio;

    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    use super::{ctrl_c, end_as_ctrl_c};
    use crate::posix::this_test_program;

    /// The command stand-in's test.
    const COMMAND_STAND_IN: &str =
        "posix::ctrl_c::tests::the_command_stand_in_ends_as_a_ctrl_c_does";

    /// What the command stand-in prints once it listens for Ctrl-C.
    const LISTENING: &str = "listening for Ctrl-C";

    /// What the command stand-in prints once its listener caught the Ctrl-C.
    const CAUGHT: &str = "caught Ctrl-C";

    #[test]
    #[ignore = "the command stand-in, which the Ctrl-C test starts as its child"]
    fn the_command_stand_in_ends_as_a_ctrl_c_does() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("the runtime starts");
        runtime.block_on(async {
            let mut listener = ctrl_c().expect("the listener starts");
            writeln!(std::io::stdout(), "{LISTENING}").expect("the line is written");
            listener.recv().await.expect("a Ctrl-C arrives");
            writeln!(std::io::stdout(), "{CAUGHT}").expect("the line is written");
        });
        let failure = end_as_ctrl_c();
        Err::<(), _>(failure).expect("the Ctrl-C ending ends the process");
    }

    #[test]
    fn a_ctrl_c_ends_the_command_as_sigint_does() {
        let mut child = this_test_program(COMMAND_STAND_IN)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the stand-in starts");
        let stdout = child.stdout.take().expect("the stand-in's output is piped");
        let mut lines = BufReader::new(stdout).lines().map_while(Result::ok);
        // libtest may print the test's name on the marker's line.
        let is_listening = lines.any(|line| line.ends_with(LISTENING));
        if !is_listening {
            child.kill().expect("the stand-in is killed");
            child.wait().expect("the stand-in is reaped");
        }
        assert!(is_listening, "the stand-in never listened for Ctrl-C");
        // Still running, so the listener waits for the Ctrl-C rather than answering at once.
        let early_end = child.try_wait().expect("the stand-in's state reads");
        assert!(
            early_end.is_none(),
            "the stand-in ended before the Ctrl-C: {early_end:?}"
        );
        let child_id = i32::try_from(child.id()).expect("a process id fits a pid");

        kill(Pid::from_raw(child_id), Signal::SIGINT).expect("the signal is sent");
        // The listener caught the Ctrl-C, so the death below is the ending's, not SIGINT's own.
        let has_caught = lines.any(|line| line.ends_with(CAUGHT));
        let status = child.wait().expect("the stand-in is reaped");

        assert!(
            has_caught,
            "the stand-in's listener never caught the Ctrl-C"
        );
        assert_eq!(status.signal(), Some(libc::SIGINT), "{status:?}");
    }
}
