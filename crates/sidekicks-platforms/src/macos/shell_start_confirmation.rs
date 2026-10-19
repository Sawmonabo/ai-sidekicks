//! The macOS side of the daemon's confirmation of a shell's start, which the `shell` mode needs
//! before it starts the person's shell as its own responsible process: the mode starts the shell
//! only when its parent, the daemon its argument names, wrote the confirmation and is its own
//! responsible process. An agent's command that runs the daemon's program in the `shell` mode
//! itself has no such parent: every process it starts reads the daemon as responsible, and the
//! daemon writes no other process's id, so the mode refuses and nothing an agent runs becomes its
//! own responsible process through it.

use std::io;
use std::os::fd::{AsRawFd as _, OwnedFd};
use std::os::unix::net::UnixStream;

use crate::macos::responsibility::read_responsible_id;
use crate::posix::shell_start_confirmation::{WriterCheck, socklen_of};

/// Has a write on the daemon's end of the pair fail with `EPIPE` once the mode has ended, instead
/// of raising `SIGPIPE`. Fails with the system's error.
pub(crate) fn refuse_sigpipe(daemon_end: &OwnedFd) -> io::Result<()> {
    let is_on: libc::c_int = 1;
    // SAFETY: the descriptor is open and the value is a live int of the length given.
    let status = unsafe {
        libc::setsockopt(
            daemon_end.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            (&raw const is_on).cast(),
            socklen_of::<libc::c_int>(),
        )
    };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Checks that the confirmation on `end` came from this process's parent, the daemon `daemon_pid`,
/// which for [`WriterCheck::Daemon`] is also its own responsible process, as the daemon is and no
/// process an agent runs is. Fails with `PermissionDenied` when another process wrote it, the
/// parent is not `daemon_pid` or not its own responsible process, or it ended while it was read,
/// and with the system's error otherwise.
pub(crate) fn check_confirming_writer(
    end: &UnixStream,
    daemon_pid: u32,
    check: WriterCheck,
) -> io::Result<()> {
    let writer = read_peer_id(end)?;
    let parent = std::os::unix::process::parent_id();
    if parent != daemon_pid {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the parent {parent} is not the daemon {daemon_pid}"),
        ));
    }
    let is_own_root = match check {
        WriterCheck::Daemon => read_responsible_id(parent)? == Some(parent),
        #[cfg(any(test, feature = "test-support"))]
        WriterCheck::Parent => true,
    };
    check_confirming_parent(writer, parent, std::os::unix::process::parent_id())?;
    if !is_own_root {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the parent {parent} is not its own responsible process"),
        ));
    }
    Ok(())
}

/// Checks that the confirmation's writer is this process's parent, read as `parent` before the
/// parent's responsible read and as `parent_after` after it. A parent that ended re-parents this
/// process, so an unchanged parent is the one read, never another process given its id. Fails with
/// `PermissionDenied` when another process wrote it or the parent changed between the reads.
fn check_confirming_parent(writer: u32, parent: u32, parent_after: u32) -> io::Result<()> {
    if writer != parent {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("process {writer}, not the parent {parent}, wrote the confirmation"),
        ));
    }
    if parent_after != parent {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("the parent {parent} ended while the confirmation was read"),
        ));
    }
    Ok(())
}

/// The id of the process that last used the other end of `end`. Fails with the system's error.
fn read_peer_id(end: &UnixStream) -> io::Result<u32> {
    let mut peer: libc::pid_t = 0;
    let mut length = socklen_of::<libc::pid_t>();
    // SAFETY: the socket is open, and `peer` is a live, writable `pid_t` of the length given.
    let status = unsafe {
        libc::getsockopt(
            end.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&raw mut peer).cast(),
            &raw mut length,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    u32::try_from(peer).map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::io::Write as _;
    use std::os::fd::OwnedFd;
    use std::process::{Command, Output, Stdio};

    use super::check_confirming_parent;
    use crate::macos::responsibility::{read_responsible_id, rerun_test_as_own_root};
    use crate::posix::shell_start_confirmation::{
        ShellStartConfirmation, WriterCheck, receive_launch,
    };
    use crate::shell_start::{ShellLaunch, ShellStart};
    use crate::test_program::this_test_program;

    /// The `shell` mode stand-in's test.
    const SHELL_MODE_STAND_IN: &str =
        "macos::shell_start_confirmation::tests::the_shell_mode_stand_in_receives_its_confirmation";

    /// What the `shell` mode stand-in prints once its confirmation is received.
    const RECEIVED: &str = "the shell start was confirmed";

    /// What the own-root parent stand-in prints once every start it confirmed went as expected.
    const PARENT_CHECKED: &str = "the own-root parent's starts went as expected";

    /// Who writes the confirmation of the `shell` mode stand-in this process starts.
    enum Writer {
        /// This process, naming the child's own id.
        ThisProcessNamingTheChild,
        /// This process, naming `id`.
        ThisProcessNaming(u32),
        /// Another process, a child of this one, naming the stand-in's own id on this process's
        /// end, which this process keeps open.
        AnotherProcessNamingTheChild,
    }

    /// Starts the `shell` mode stand-in as this process's child, has `writer` confirm it and
    /// answers its output.
    fn start_confirmed(writer: &Writer) -> Output {
        let mut confirmation = ShellStartConfirmation::new().expect("the pair opens");
        let (name, value) = confirmation
            .environment_entry()
            .expect("macOS confirms a shell's start");
        let child = this_test_program(SHELL_MODE_STAND_IN)
            .env(name, value)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("the stand-in starts");
        let frame = launch_frame();
        match writer {
            Writer::ThisProcessNamingTheChild => confirmation.confirm(child.id()),
            Writer::ThisProcessNaming(id) => confirmation.confirm(*id),
            Writer::AnotherProcessNamingTheChild => {
                drop(confirmation.shell_end.take());
                let mut written = child.id().to_ne_bytes().to_vec();
                written.extend_from_slice(&frame);
                write_from_another_process(&confirmation, &written);
                Ok(())
            }
        }
        .expect("the confirmation is written");
        if !matches!(writer, Writer::AnotherProcessNamingTheChild) {
            confirmation
                .daemon_end
                .write_all(&frame)
                .expect("the launch is written");
        }
        // Kept open until the stand-in ends, as the daemon keeps it for the shell's life.
        let output = child.wait_with_output().expect("the stand-in ends");
        drop(confirmation);
        output
    }

    /// A launch frame for a shell the stand-in never starts.
    fn launch_frame() -> Vec<u8> {
        let start = || ShellStart {
            program: "/bin/sh".to_owned(),
            arguments: Vec::new(),
            raw_command_tail: None,
            folder: "/".into(),
            environment: Vec::new(),
        };
        ShellLaunch {
            shell: start(),
            fallback: start(),
        }
        .encode()
        .expect("the launch encodes")
    }

    /// Has a shell, this process's child, write `bytes` on a copy of the daemon's end of
    /// `confirmation`.
    fn write_from_another_process(confirmation: &ShellStartConfirmation, bytes: &[u8]) {
        let daemon_end = OwnedFd::from(
            confirmation
                .daemon_end
                .try_clone()
                .expect("the daemon's end copies"),
        );
        let mut escaped = String::new();
        for byte in bytes {
            write!(escaped, "\\{byte:03o}").expect("a string takes every write");
        }
        let status = Command::new("/bin/sh")
            .args(["-c", "printf \"$1\"", "sh", &escaped])
            .stdout(Stdio::from(daemon_end))
            .status()
            .expect("the writer runs");
        assert!(status.success(), "the writer wrote the id");
    }

    /// Whether the stand-in that printed `output` received its confirmation.
    fn was_received(output: &Output) -> bool {
        output.status.success() && String::from_utf8_lossy(&output.stdout).contains(RECEIVED)
    }

    #[test]
    #[ignore = "the `shell` mode's stand-in, which the confirmation tests start as their child"]
    fn the_shell_mode_stand_in_receives_its_confirmation() {
        receive_launch(std::os::unix::process::parent_id(), WriterCheck::Daemon)
            .expect("the confirmation is received");
        writeln!(std::io::stdout(), "{RECEIVED}").expect("the stand-in writes its output");
    }

    #[test]
    #[ignore = "the daemon's stand-in, which the confirmation test starts as its own responsible \
                process"]
    fn an_own_root_parent_confirms_only_the_process_it_started() {
        let own_id = std::process::id();
        assert_eq!(
            read_responsible_id(own_id).expect("the read answers"),
            Some(own_id),
            "the stand-in started as its own responsible process"
        );
        let own_child = start_confirmed(&Writer::ThisProcessNamingTheChild);
        assert!(
            was_received(&own_child),
            "{}",
            String::from_utf8_lossy(&own_child.stderr)
        );
        assert!(!was_received(&start_confirmed(&Writer::ThisProcessNaming(
            own_id
        ))));
        // A process other than the parent writing the stand-in's own id on a held end is refused.
        assert!(!was_received(&start_confirmed(
            &Writer::AnotherProcessNamingTheChild
        )));
        writeln!(std::io::stdout(), "{PARENT_CHECKED}").expect("the stand-in writes its output");
    }

    #[test]
    fn a_parent_that_changed_while_it_was_read_is_refused() {
        // The parent wrote the confirmation and ended before its responsible read, so this process
        // was re-parented and the id read may name another process.
        let error = check_confirming_parent(500, 500, 1).expect_err("the confirmation is refused");
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn a_shell_start_is_confirmed_only_by_an_own_root_parent_naming_it() {
        // The test runs under its runner, which is responsible for it, as the daemon is for every
        // process an agent runs: its confirmation of its own child is refused.
        assert!(!was_received(&start_confirmed(
            &Writer::ThisProcessNamingTheChild
        )));
        let (has_passed, output) = rerun_test_as_own_root(concat!(
            "macos::shell_start_confirmation::tests::",
            "an_own_root_parent_confirms_only_the_process_it_started",
        ));
        assert!(
            has_passed && output.contains(PARENT_CHECKED),
            "the own-root parent's checks pass: {output}"
        );
    }
}
