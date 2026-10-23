//! Whether a command waits on its terminal's input: the terminal a wait is read on and the reading
//! every platform answers; each platform's module reads it the way that platform shows it.

use crate::terminal::{TerminalDevice, TerminalMasterReading};

/// The terminal a command's wait is read on: the device of its program side and what its master
/// shows, read by whoever holds the master.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputTerminal {
    /// The device number of the terminal's program side.
    pub device: TerminalDevice,
    /// What the terminal's master showed when the wait was read.
    pub master: TerminalMasterReading,
}

/// Whether a command waits on its terminal's input, whether it takes input at all, and whether
/// what is typed to it is echoed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each is a separate fact the command's line reads: its wait, its input, its echo and \
              its masking"
)]
pub struct InputWaitReading {
    /// Whether a process of the terminal's foreground group is blocked reading the terminal.
    pub is_waiting: bool,
    /// Whether a process of the terminal's foreground group holds the terminal open for reading.
    pub accepts_input: bool,
    /// Whether the terminal's echo is off, the echo setting alone: a full-screen program turns it
    /// off as a password prompt does, so masking what is typed keys on `is_password_prompt`.
    pub is_echo_off: bool,
    /// Whether the terminal is set as a password prompt: a line at a time with echo off, so what is
    /// typed is masked.
    pub is_password_prompt: bool,
}

#[cfg(all(test, unix))]
mod tests {
    use std::collections::HashMap;
    use std::thread;
    use std::time::{Duration, Instant};

    use alacritty_terminal::event::WindowSize;
    use rstest::rstest;

    use super::{InputTerminal, InputWaitReading};
    use crate::posix::inner_terminal::{
        end_inner_terminal, read_until_marker, start_inner_terminal,
    };
    use crate::posix::terminal::{read_terminal_master, terminal_options};
    use crate::read_input_wait;

    // How long after its prompt a waiting command must read as waiting.
    const WAIT_BOUND: Duration = Duration::from_millis(500);

    // How long a command that waits on nothing settles before it is read.
    const SETTLE: Duration = Duration::from_millis(300);

    // Whether a `select` reader is seen: Linux reads its descriptor set, macOS cannot.
    const IS_SELECT_SEEN: bool = cfg!(target_os = "linux");

    // Fails when a thread's run state is taken as a wait (`sleep 30` and the shell after `read -t`
    // wait in the kernel too), when echo is read as off only with canonical input on (`vim` turns
    // both off), when echo off alone reads as a password prompt (`stty -echo -icanon`), or when a
    // read on the terminal, a `kevent` on a read knote or a `select` on Linux is missed.
    #[rstest]
    #[case::node_readline(
        "node -e \"require('readline').createInterface({input: process.stdin, \
         output: process.stdout}).question('ready> ', () => {})\"",
        "ready>",
        reading(true, Echo::Off)
    )]
    #[case::cat("echo ready; exec cat", "ready", reading(true, Echo::On))]
    #[case::raw_cat(
        "stty -echo -icanon; echo ready; exec cat",
        "ready",
        reading(true, Echo::Off)
    )]
    #[case::read_with_time_limit(
        "read -t 1 line; echo ready; exec sleep 30",
        "ready",
        reading(false, Echo::On)
    )]
    #[case::sleep("echo ready; exec sleep 30", "ready", reading(false, Echo::On))]
    #[case::python_select(
        "exec python3 -c \"import select, sys; print('ready', flush=True); \
         select.select([sys.stdin], [], [])\"",
        "ready",
        reading(IS_SELECT_SEEN, Echo::On)
    )]
    #[case::hidden_read(
        "echo ready; exec /bin/bash -c 'read -s line'",
        "ready",
        reading(true, Echo::OffAtPasswordPrompt)
    )]
    #[case::vim("exec vim -u NONE -N -n", "~", reading(IS_SELECT_SEEN, Echo::Off))]
    fn input_wait_reads_each_kind_of_reader(
        #[case] script: &str,
        #[case] marker: &str,
        #[case] expected: InputWaitReading,
    ) {
        let options = terminal_options(
            "/bin/sh".to_owned(),
            vec!["-c".to_owned(), script.to_owned()],
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
        let prompt = read_until_marker(&terminal.pty, marker, Duration::from_secs(20));
        let prompted = Instant::now();
        if prompt.is_ok() && !expected.is_waiting {
            thread::sleep(SETTLE);
        }
        let read = || {
            read_input_wait(&InputTerminal {
                device: terminal.device,
                master: read_terminal_master(&terminal.pty)?,
            })
        };
        let mut reading = prompt.is_ok().then(read);
        while prompted.elapsed() < WAIT_BOUND
            && reading
                .as_ref()
                .is_some_and(|reading| reading.as_ref().is_ok_and(|read| *read != expected))
        {
            reading = Some(read());
        }
        end_inner_terminal(terminal);

        prompt.expect("the command prompts");
        let reading = reading.expect("the wait was read").expect("the wait reads");
        assert_eq!(reading, expected, "{script}");
    }

    // How a case's terminal echoes.
    #[derive(Clone, Copy)]
    enum Echo {
        On,
        // Off with line input off too, as a full-screen program sets it.
        Off,
        // Off with line input on, as a password prompt sets it.
        OffAtPasswordPrompt,
    }

    // A command holding its terminal for reading, waiting or not, with its echo as given.
    const fn reading(is_waiting: bool, echo: Echo) -> InputWaitReading {
        InputWaitReading {
            is_waiting,
            accepts_input: true,
            is_echo_off: !matches!(echo, Echo::On),
            is_password_prompt: matches!(echo, Echo::OffAtPasswordPrompt),
        }
    }
}
