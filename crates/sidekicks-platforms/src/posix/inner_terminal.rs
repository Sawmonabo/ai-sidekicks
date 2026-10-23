//! The start of a command in a terminal of its own on macOS and Linux, through
//! `alacritty_terminal`'s PTY, which makes the command its own session's leader with the terminal
//! as its controlling one.

use std::io;

use alacritty_terminal::event::WindowSize;
use alacritty_terminal::tty::{self, Options};
use nix::pty::{OpenptyResult, Winsize, openpty};
use nix::sys::stat::fstat;

use crate::terminal::{InnerTerminal, TerminalDevice};

/// Opens a terminal of `window_size` and starts the program `options` names in it, a session leader
/// whose controlling terminal it is. `alacritty_terminal` adds `USER` and `HOME`, read from this
/// process's own, and `ALACRITTY_WINDOW_ID` and `WINDOWID`, which `options` can change but not
/// remove, so the program removes those two at its own start. Blocks; fails with the system's
/// error when the terminal cannot be opened or read or the program cannot be started.
pub fn start_inner_terminal(
    options: &Options,
    window_size: WindowSize,
) -> io::Result<InnerTerminal> {
    let size = Winsize {
        ws_row: window_size.num_lines,
        ws_col: window_size.num_cols,
        ws_xpixel: window_size.num_cols.saturating_mul(window_size.cell_width),
        ws_ypixel: window_size
            .num_lines
            .saturating_mul(window_size.cell_height),
    };
    let OpenptyResult { master, slave } = openpty(&size, None).map_err(io::Error::from)?;
    let device = terminal_device(fstat(&slave).map_err(io::Error::from)?.st_rdev)?;
    let pty = tty::from_fd(options, 0, master, slave)?;
    Ok(InnerTerminal { pty, device })
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

/// What `pty`'s program printed until it printed `marker`, read within `deadline`; what it printed
/// instead when the marker does not come.
#[cfg(test)]
pub(crate) fn read_until_marker(
    pty: &tty::Pty,
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

/// Ends the command `terminal` started and its group as a test's teardown, reading what it still
/// prints until its side closes, since a process's exit waits for its terminal's output to drain.
#[cfg(test)]
pub(crate) fn end_inner_terminal(terminal: InnerTerminal) {
    use std::io::{ErrorKind, Read};
    use std::time::{Duration, Instant};

    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    let leader = i32::try_from(terminal.pty.child().id()).expect("a process id");
    killpg(Pid::from_raw(leader), Signal::SIGKILL).expect("the command's group is killed");
    let started = Instant::now();
    let mut master = terminal.pty.file();
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
    drop(terminal);
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Once;
    use std::time::Duration;

    use alacritty_terminal::event::WindowSize;
    use nix::sys::stat::stat;

    use super::{end_inner_terminal, read_until_marker, start_inner_terminal, terminal_device};
    use crate::posix::terminal::{read_terminal_master, terminal_options};

    // Fails when the command is not its own session's leader with the terminal as its controlling
    // one, which leaves the terminal no session or foreground group, or when the device is read
    // from the master rather than the program's side.
    #[test]
    fn inner_terminal_runs_its_command_as_the_leader_of_its_own_session() {
        let options = terminal_options(
            "/bin/sh".to_owned(),
            vec![
                "-c".to_owned(),
                "echo \"path:$(tty):end\"; sleep 20".to_owned(),
            ],
            None,
            HashMap::new(),
        );
        let window_size = WindowSize {
            num_lines: 24,
            num_cols: 80,
            cell_width: 0,
            cell_height: 0,
        };

        let terminal = start_inner_terminal(&options, window_size).expect("the terminal starts");
        let output = read_until_marker(&terminal.pty, ":end", Duration::from_secs(10));
        // The device is read while the terminal is open: macOS removes its node at the close.
        let device = output.as_ref().ok().and_then(|output| {
            let path = output.split("path:").nth(1)?.split(':').next()?;
            Some(stat(path).map(|status| status.st_rdev))
        });
        let reading = read_terminal_master(&terminal.pty, &Once::new());
        let child_id = terminal.pty.child().id();
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
