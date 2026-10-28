//! The start of a command in a terminal of its own on macOS and Linux, as its own session's leader,
//! which takes the terminal as its controlling one itself.

use std::ffi::OsStr;
use std::io;
use std::path::Path;

use alacritty_terminal::event::WindowSize;
use nix::sys::stat::fstat;
use rustix_openpty::rustix::termios::Winsize;

use crate::posix::spawn::inherited_environment;
use crate::posix::terminal::pty::{TerminalProgram, open_terminal, spawn_in_terminal};
use crate::terminal::{InnerTerminal, TerminalDevice};

/// Whether [`start_inner_terminal`] starts a command: yes on macOS and Linux.
#[cfg(any(test, feature = "test-support"))]
pub const CAN_START_AN_INNER_TERMINAL: bool = true;

/// Opens a terminal of `window_size` and starts `program` in it, named `argument_zero`, with
/// `arguments` and this process's environment, as the leader of a session of its own; the program
/// takes the terminal as its controlling one itself, as the command wrapper's inner form does. The
/// terminal keeps a handle of its own on the program side. Blocking; fails with the system's error
/// when the terminal cannot be opened or read, and as the spawn fails, the error naming the
/// program.
pub fn start_inner_terminal(
    program: &Path,
    argument_zero: &OsStr,
    arguments: &[String],
    window_size: WindowSize,
) -> io::Result<InnerTerminal> {
    let terminal = open_terminal(&Winsize {
        ws_row: window_size.num_lines,
        ws_col: window_size.num_cols,
        ws_xpixel: window_size.num_cols.saturating_mul(window_size.cell_width),
        ws_ypixel: window_size
            .num_lines
            .saturating_mul(window_size.cell_height),
    })?;
    let device = terminal_device(fstat(&terminal.follower).map_err(io::Error::from)?.st_rdev)?;
    // Close-on-exec, so the program inherits only the follower the spawn puts on its streams.
    let program_side = terminal.follower.try_clone()?;
    let pty = spawn_in_terminal(
        terminal,
        &TerminalProgram {
            program,
            argument_zero,
            arguments,
            environment: inherited_environment(&[]),
            folder: None,
            inherited: None,
        },
    )?;
    Ok(InnerTerminal {
        _program_side: program_side,
        process_id: pty.process_id(),
        pty,
        device,
    })
}

// The device number `rdev` as the terminal device every platform's reading compares.
fn terminal_device(rdev: libc::dev_t) -> io::Result<TerminalDevice> {
    #[cfg_attr(
        target_os = "linux",
        expect(
            clippy::useless_conversion,
            reason = "Linux's device number is already unsigned and 64 bits; macOS's is signed"
        )
    )]
    let device = u64::try_from(rdev).map_err(io::Error::other)?;
    Ok(TerminalDevice(device))
}

/// The 80 by 24 window the tests' terminals open at.
#[cfg(test)]
const TEST_WINDOW_SIZE: WindowSize = WindowSize {
    num_lines: 24,
    num_cols: 80,
    cell_width: 0,
    cell_height: 0,
};

/// Starts `program` in an 80 by 24 terminal of its own through the stand-in in this file's tests,
/// which takes the terminal as its controlling one and then becomes `program`. Fails as
/// [`start_inner_terminal`] fails.
#[cfg(test)]
pub(crate) fn start_test_terminal(
    program: &crate::terminal::TestProgram,
) -> io::Result<InnerTerminal> {
    use crate::test_program::terminal_taking_start;

    let start = terminal_taking_start(&tests::terminal_taking_stand_in(), program);
    start_inner_terminal(
        Path::new(&start.program),
        OsStr::new(&start.program),
        &start.arguments,
        TEST_WINDOW_SIZE,
    )
}

/// What `pty`'s program printed until it printed `marker`, read within `deadline`; what it printed
/// instead when the marker does not come.
#[cfg(test)]
pub(crate) fn read_until_marker(
    pty: &crate::Pty,
    marker: &str,
    deadline: std::time::Duration,
) -> Result<String, String> {
    use std::io::{ErrorKind, Read};
    use std::time::Instant;

    let started = Instant::now();
    let mut output = Vec::new();
    let mut buffer = [0_u8; 4_096];
    let mut master = pty.file();
    while !String::from_utf8_lossy(&output).contains(marker) {
        if started.elapsed() >= deadline {
            return Err(String::from_utf8_lossy(&output).into_owned());
        }
        match master.read(&mut buffer) {
            Ok(count) => output.extend_from_slice(&buffer[..count]),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            Err(error) => return Err(format!("the output could not be read: {error}")),
        }
    }
    Ok(String::from_utf8_lossy(&output).into_owned())
}

/// Ends the command `terminal` started and its group as a test's teardown, closing the terminal's
/// own handle on the program side and reading what the command still prints until that side
/// closes, since a process's exit waits for its terminal's output to drain. A group already gone
/// is left as it is, so the test's own failure is the one reported.
#[cfg(test)]
pub(crate) fn end_inner_terminal(terminal: InnerTerminal) {
    use std::io::{ErrorKind, Read};
    use std::time::{Duration, Instant};

    use nix::errno::Errno;
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    let InnerTerminal {
        _program_side: program_side,
        pty,
        ..
    } = terminal;
    let leader = i32::try_from(pty.process_id()).expect("a process id");
    match killpg(Pid::from_raw(leader), Signal::SIGKILL) {
        Ok(()) => {}
        Err(Errno::ESRCH) => return,
        Err(errno) => panic!("the command's group is not killed: {errno}"),
    }
    // Closed first, so the read below ends at the command's close rather than its 10 s bound.
    drop(program_side);
    let started = Instant::now();
    let mut master = pty.file();
    let mut buffer = [0_u8; 4_096];
    while started.elapsed() < Duration::from_secs(10) {
        match master.read(&mut buffer) {
            Ok(0) => break,
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_closed) => break,
        }
    }
    drop(pty);
}

#[cfg(test)]
mod tests {
    use std::sync::Once;
    use std::time::Duration;

    use nix::sys::stat::stat;

    use super::{end_inner_terminal, read_until_marker, start_test_terminal, terminal_device};
    use crate::posix::terminal::pty::run_terminal_taking_stand_in;
    use crate::posix::terminal::read_terminal_master;
    use crate::posix::terminal::test_programs::shell_script;
    use crate::test_program::harness_test_name;

    /// The harness name of the ignored test the tests' inner terminals start their programs
    /// through.
    pub(super) fn terminal_taking_stand_in() -> String {
        harness_test_name(
            module_path!(),
            "the_terminal_taking_stand_in_runs_its_program",
        )
    }

    #[test]
    #[ignore = "run only as the inner terminal's stand-in, in a test's terminal"]
    fn the_terminal_taking_stand_in_runs_its_program() {
        let error = run_terminal_taking_stand_in();
        panic!("the stand-in did not run its program: {error:?}");
    }

    // Fails when the command is not its own session's leader with the terminal as its controlling
    // one, which leaves the terminal no session or foreground group, or when the device is read
    // from the master rather than the program's side.
    #[test]
    fn inner_terminal_runs_its_command_as_the_leader_of_its_own_session() {
        let terminal = start_test_terminal(&shell_script("echo \"path:$(tty):end\"; sleep 20"))
            .expect("the terminal starts");
        let output = read_until_marker(&terminal.pty, ":end", Duration::from_secs(10));
        // The device is read while the terminal is open: macOS removes its node at the close.
        let device = output.as_ref().ok().and_then(|output| {
            let path = output.split("path:").nth(1)?.split(':').next()?;
            Some(stat(path).map(|status| status.st_rdev))
        });
        let reading = read_terminal_master(&terminal.pty, &Once::new());
        let child_id = terminal.pty.process_id();
        let device_read = terminal.device;
        end_inner_terminal(terminal);

        output.expect("the command printed its terminal");
        let device = device
            .expect("the command printed its terminal's path")
            .expect("the terminal's path reads");
        let reading = reading.expect("the master reads");
        assert_eq!(terminal_device(device).ok(), Some(device_read));
        assert_eq!(reading.session_leader, child_id);
        assert_eq!(reading.foreground_group, child_id);
    }
}
