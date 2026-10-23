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
    use std::io::Write;
    use std::sync::Once;
    use std::thread;
    use std::time::{Duration, Instant};

    use alacritty_terminal::event::WindowSize;
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;
    use rstest::rstest;

    use super::{InputTerminal, InputWaitReading};
    use crate::posix::inner_terminal::{
        end_inner_terminal, read_until_marker, start_inner_terminal,
    };
    use crate::posix::terminal::{read_terminal_master, terminal_options};
    use crate::read_input_wait;

    // How long after its prompt a waiting command must read as waiting, and how long a command
    // that waits on nothing keeps reading as not waiting.
    const WAIT_BOUND: Duration = Duration::from_millis(500);

    // How long a command that waits on nothing settles before it is read.
    const SETTLE: Duration = Duration::from_millis(300);

    // Whether a `select` reader is seen: Linux reads its descriptor set, macOS cannot.
    const IS_SELECT_SEEN: bool = cfg!(target_os = "linux");

    // Fails when a thread's run state is taken as a wait (`sleep 30` and the shell waiting on it
    // after `read -t` wait in the kernel too), when input typed ahead does not rule a wait out,
    // when echo is read as off only with canonical input on (`vim` turns both off), when echo off
    // alone reads as a password prompt (`stty -echo -icanon`), or when a read on the terminal, a
    // `kevent` on a read knote, a `select` on Linux or a read through `/dev/tty` is missed.
    #[rstest]
    #[case::node_readline(
        "node -e \"require('readline').createInterface({input: process.stdin, \
         output: process.stdout}).question('ready> ', () => {})\"",
        "ready>",
        "",
        reading(true, Echo::Off)
    )]
    #[case::cat("echo ready; exec cat", "ready", "", reading(true, Echo::On))]
    // It reads a named pipe while its standard input is the terminal, so on macOS only the line
    // typed ahead and left unread tells its read is not the terminal's.
    #[case::typed_ahead_elsewhere_reader(
        "pipe=$(mktemp -u); mkfifo \"$pipe\"; exec python3 -c \"import os, sys; \
         pipe = os.open(sys.argv[1], os.O_RDWR); os.unlink(sys.argv[1]); \
         print('ready', flush=True); os.read(pipe, 1)\" \"$pipe\"",
        "ready",
        "a line\n",
        reading(false, Echo::On)
    )]
    #[case::raw_cat(
        "stty -echo -icanon; echo ready; exec cat",
        "ready",
        "",
        reading(true, Echo::Off)
    )]
    #[case::read_with_time_limit(
        "read -t 1 line; echo ready; sleep 30",
        "ready",
        "",
        reading(false, Echo::On)
    )]
    #[case::sleep("echo ready; exec sleep 30", "ready", "", reading(false, Echo::On))]
    #[case::python_select(
        "exec python3 -c \"import select, sys; print('ready', flush=True); \
         select.select([sys.stdin], [], [])\"",
        "ready",
        "",
        reading(IS_SELECT_SEEN, Echo::On)
    )]
    // Its standard streams are away from the terminal, so `/dev/tty` is its only way to it.
    #[case::controlling_terminal_reader(
        "exec python3 -c \"import os; terminal = os.open('/dev/tty', os.O_RDWR); \
         os.write(terminal, b'ready\\n'); os.read(terminal, 1)\" < /dev/null > /dev/null 2>&1",
        "ready",
        "",
        reading(true, Echo::On)
    )]
    #[case::hidden_read(
        "echo ready; exec /bin/bash -c 'read -s line'",
        "ready",
        "",
        reading(true, Echo::OffAtPasswordPrompt)
    )]
    #[case::vim("exec vim -u NONE -N -n", "~", "", reading(IS_SELECT_SEEN, Echo::Off))]
    fn input_wait_reads_each_kind_of_reader(
        #[case] script: &str,
        #[case] marker: &str,
        #[case] typed: &str,
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
        let typing = prompt
            .is_ok()
            .then(|| terminal.pty.file().write_all(typed.as_bytes()));
        if prompt.is_ok() && !expected.is_waiting {
            thread::sleep(SETTLE);
        }
        let peer_failure_noted = Once::new();
        let read = || {
            read_input_wait(&InputTerminal {
                device: terminal.device,
                master: read_terminal_master(&terminal.pty, &peer_failure_noted)?,
            })
        };
        // A waiting command is read until it reads as waiting; one that waits on nothing is read
        // across the whole bound, and must never read as waiting.
        let window_start = Instant::now();
        let mut readings = Vec::new();
        while prompt.is_ok() {
            let reading = read();
            let is_settled = reading
                .as_ref()
                .map_or(true, |reading| expected.is_waiting && *reading == expected);
            readings.push(reading);
            if is_settled || window_start.elapsed() >= WAIT_BOUND {
                break;
            }
        }
        end_inner_terminal(terminal);

        prompt.expect("the command prompts");
        typing
            .expect("the command prompted")
            .expect("the typed input is written");
        let readings = readings
            .into_iter()
            .collect::<std::io::Result<Vec<_>>>()
            .expect("the wait reads");
        if expected.is_waiting {
            assert_eq!(readings.last(), Some(&expected), "{script}");
        } else {
            assert!(
                readings.iter().all(|reading| *reading == expected),
                "{script}: {readings:?}"
            );
        }
    }

    // Fails when the count is read where the program's input is not, as the master on Linux, whose
    // count is the program's output, or when it does not follow the program's read of the line.
    #[test]
    fn queued_input_counts_a_typed_line_until_the_program_reads_it() {
        let options = terminal_options(
            "/bin/sh".to_owned(),
            vec![
                "-c".to_owned(),
                "stty -echo; printf ready; kill -STOP $$; read line; printf done; sleep 30"
                    .to_owned(),
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
        let peer_failure_noted = Once::new();
        let read_master = || read_terminal_master(&terminal.pty, &peer_failure_noted);
        let leader = Pid::from_raw(i32::try_from(terminal.pty.child().id()).expect("a process id"));
        let prompt = read_until_marker(&terminal.pty, "ready", Duration::from_secs(20));
        let before_typing = prompt.is_ok().then(read_master);
        // The line stays queued: the program stops itself before its read.
        let typing = prompt
            .is_ok()
            .then(|| terminal.pty.file().write_all(b"hello\n"));
        // Linux hands the written line to the program's side a step after the write.
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut typed = None;
        while prompt.is_ok() {
            let reading = read_master();
            let is_settled = reading.as_ref().map_or(true, |reading| {
                reading.queued_input_bytes == Some(6) || Instant::now() >= deadline
            });
            typed = Some(reading);
            if is_settled {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        let continued = prompt.is_ok().then(|| killpg(leader, Signal::SIGCONT));
        let ending = prompt
            .is_ok()
            .then(|| read_until_marker(&terminal.pty, "done", Duration::from_secs(20)));
        let after_reading = ending.as_ref().is_some_and(Result::is_ok).then(read_master);
        end_inner_terminal(terminal);

        prompt.expect("the command prompts");
        let before_typing = before_typing
            .expect("the command prompted")
            .expect("the master reads");
        typing
            .expect("the command prompted")
            .expect("the line is written");
        let typed = typed
            .expect("the master is read after the typing")
            .expect("the master reads");
        continued
            .expect("the command prompted")
            .expect("the command's group continues");
        ending
            .expect("the command prompted")
            .expect("the command reads its line");
        let after_reading = after_reading
            .expect("the command read its line")
            .expect("the master reads");
        #[cfg(target_os = "linux")]
        assert_eq!(before_typing.unread_output_bytes, 0);
        assert_eq!(before_typing.queued_input_bytes, Some(0));
        assert_eq!(typed.queued_input_bytes, Some(6));
        assert_eq!(after_reading.queued_input_bytes, Some(0));
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
