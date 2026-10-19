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

    use nix::fcntl::{FcntlArg, OFlag, fcntl};
    use nix::sys::signal::{Signal, kill};
    use nix::unistd::Pid;

    use super::{ctrl_c, end_as_ctrl_c};
    use crate::test_program::this_test_program;

    /// The command stand-in's test.
    const COMMAND_STAND_IN: &str =
        "posix::ctrl_c::tests::the_command_stand_in_ends_as_a_ctrl_c_does";

    /// What the command stand-in prints once it listens for Ctrl-C.
    const LISTENING: &str = "listening for Ctrl-C";

    /// What the test writes to the command stand-in just before it sends the Ctrl-C.
    const GO: &str = "go";

    /// What the command stand-in prints when its listener answers after the Ctrl-C was sent.
    const CAUGHT: &str = "caught Ctrl-C";

    /// What the command stand-in prints when its listener answers before the Ctrl-C was sent.
    const EARLY: &str = "answered before Ctrl-C";

    #[test]
    #[ignore = "the command stand-in, which the Ctrl-C test starts as its child"]
    fn the_command_stand_in_ends_as_a_ctrl_c_does() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("the runtime starts");
        // A read that finds nothing answers at once, so the line below tells whether the test had
        // written `GO`, and so sent the Ctrl-C, by the time the listener answered.
        fcntl(std::io::stdin(), FcntlArg::F_SETFL(OFlag::O_NONBLOCK))
            .expect("the stand-in's input stops blocking");
        runtime.block_on(async {
            let mut listener = ctrl_c().expect("the listener starts");
            writeln!(std::io::stdout(), "{LISTENING}").expect("the line is written");
            listener.recv().await.expect("a Ctrl-C arrives");
            let mut line = String::new();
            let is_sent = std::io::stdin().read_line(&mut line).is_ok() && line.trim_end() == GO;
            let marker = if is_sent { CAUGHT } else { EARLY };
            writeln!(std::io::stdout(), "{marker}").expect("the line is written");
        });
        let failure = end_as_ctrl_c();
        panic!("the Ctrl-C ending ends the process: {failure}");
    }

    #[test]
    fn a_ctrl_c_ends_the_command_as_sigint_does() {
        let mut child = this_test_program(COMMAND_STAND_IN)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("the stand-in starts");
        let mut stdin = child.stdin.take().expect("the stand-in's input is piped");
        let stdout = child.stdout.take().expect("the stand-in's output is piped");
        let mut lines = BufReader::new(stdout).lines().map_while(Result::ok);
        // libtest may print the test's name on the marker's line.
        let is_listening = lines.any(|line| line.ends_with(LISTENING));
        if !is_listening {
            child.kill().expect("the stand-in is killed");
            child.wait().expect("the stand-in is reaped");
        }
        assert!(is_listening, "the stand-in never listened for Ctrl-C");
        let child_id = i32::try_from(child.id()).expect("a process id fits a pid");

        writeln!(stdin, "{GO}").expect("the line is written");
        kill(Pid::from_raw(child_id), Signal::SIGINT).expect("the signal is sent");
        // The listener caught the Ctrl-C, so the death below is the ending's, not SIGINT's own.
        let answer = lines.find(|line| line.ends_with(CAUGHT) || line.ends_with(EARLY));
        let status = child.wait().expect("the stand-in is reaped");

        assert!(
            answer.as_deref().is_some_and(|line| line.ends_with(CAUGHT)),
            "the stand-in's listener did not wait for the Ctrl-C: {answer:?}"
        );
        assert_eq!(status.signal(), Some(libc::SIGINT), "{status:?}");
    }
}
