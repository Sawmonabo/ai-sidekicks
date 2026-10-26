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
    reason = "each is a separate fact the command's line reads: its two waits, its input and its \
              echo"
)]
pub struct InputWaitReading {
    /// Whether a process of the terminal's foreground group is blocked reading the terminal.
    pub is_waiting: bool,
    /// Whether, when `is_waiting` is not set, a thread of the group waits in `select` or `poll`
    /// with the terminal among its readable descriptors as far as the read can tell, its process
    /// holding no socket, no pipe or FIFO open for reading and no kqueue, and on Linux no inotify,
    /// fanotify or epoll set, no event descriptor and no output unread on the master: a wait a
    /// consumer marks only with the output's own evidence, a prompt-like last line. It is set
    /// where the call's descriptors
    /// are hidden, as macOS hides them from every reader without root and Linux where Yama's ptrace
    /// scope is 2 or 3; elsewhere Linux reads them into `is_waiting`, and Windows never sets it.
    pub is_waiting_in_select: bool,
    /// Whether a process of the terminal's foreground group holds the terminal open for reading.
    pub accepts_input: bool,
    /// Whether the terminal's echo is off, the echo setting alone, which is what masks what is
    /// typed: a prompt in raw mode, as a Node or Inquirer password prompt reads, clears the line
    /// setting with the echo, so a full-screen program with echo off is masked too.
    pub is_echo_off: bool,
}

/// A Python reader the tests start, which prints `ready` and waits in `select` on the terminal.
#[cfg(all(unix, any(test, feature = "test-support")))]
pub const SELECT_READER_SCRIPT: &str = "exec python3 -c \"import select, sys; \
     print('ready', flush=True); select.select([sys.stdin], [], [])\"";

/// The same reader holding a pipe open for reading, which its wait may be on instead.
#[cfg(all(test, unix))]
pub(crate) const PIPE_HOLDING_SELECT_READER_SCRIPT: &str = "exec python3 -c \"import os, select, \
     sys; read_end, write_end = os.pipe(); print('ready', flush=True); \
     select.select([sys.stdin], [], [])\"";

#[cfg(all(test, unix))]
mod tests {
    use std::collections::HashMap;
    use std::io::{Read, Write};
    use std::sync::Once;
    use std::thread;
    use std::time::{Duration, Instant};

    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;
    use rstest::rstest;

    use super::{
        InputTerminal, InputWaitReading, PIPE_HOLDING_SELECT_READER_SCRIPT, SELECT_READER_SCRIPT,
    };
    use crate::posix::terminal::inner::{
        TEST_WINDOW_SIZE, end_inner_terminal, read_until_marker, start_inner_terminal,
    };
    use crate::posix::terminal::{read_terminal_master, terminal_options};
    use crate::read_input_wait;
    use crate::spawner::Spawner;
    use crate::terminal::InnerTerminal;

    // How long after its prompt a waiting command must read as waiting, and how long a command
    // that waits on nothing keeps reading as not waiting.
    const WAIT_BOUND: Duration = Duration::from_millis(500);

    // How long a command that waits on nothing settles before it is read.
    const SETTLE: Duration = Duration::from_millis(300);

    // Fails when a thread's run state is taken as a wait (`sleep 30` and the shell waiting on it
    // after `read -t` wait in the kernel too), when a stopped reader or one with input typed ahead
    // reads as waiting, when a read on a FIFO is taken for the terminal's, when echo is read as off
    // only with canonical input on (`vim` turns both off), when echo off alone reads as a password
    // prompt (`stty -echo -icanon`), when a read on the terminal, a `kevent` on a read knote, a
    // `select` or a read through `/dev/tty` is missed, when a `select` in a process holding a
    // socket, a pipe or FIFO open for reading or a kqueue is marked on macOS, or when an orphan
    // reader outside the session leader's tree is missed.
    #[rstest]
    #[case::node_readline(
        "node -e \"require('readline').createInterface({input: process.stdin, \
         output: process.stdout}).question('ready> ', () => {})\"",
        "ready>",
        AtPrompt::Nothing,
        reading(Wait::OnTerminal, Echo::Off)
    )]
    #[case::cat(
        "echo ready; exec cat",
        "ready",
        AtPrompt::Nothing,
        reading(Wait::OnTerminal, Echo::On)
    )]
    // Stopped in its read, as Ctrl+Z stops it, it reads nothing until it is continued.
    #[case::stopped_cat(
        "echo ready; exec cat",
        "ready",
        AtPrompt::Stop,
        reading(Wait::None, Echo::On)
    )]
    // Woken once for each new input, it waits again with the typed line still queued, so only the
    // queued line tells it is not waiting.
    #[case::edge_triggered_reader(
        "exec python3 -c \"import select; edge = hasattr(select, 'epoll'); \
         queue = select.epoll() if edge else select.kqueue(); \
         edge and queue.register(0, select.EPOLLIN | select.EPOLLET); \
         edge or queue.control([select.kevent(0, select.KQ_FILTER_READ, \
         select.KQ_EV_ADD | select.KQ_EV_CLEAR)], 0); \
         wait = (lambda: queue.poll()) if edge else (lambda: queue.control(None, 1)); \
         print('ready', flush=True); wait(); wait()\"",
        "ready",
        AtPrompt::Type("a line\n"),
        reading(Wait::None, Echo::On)
    )]
    // It reads a FIFO a quiet writer holds open while its standard input is the terminal, so on
    // macOS only the FIFO it holds tells its read is not the terminal's.
    #[case::fifo_reader(
        "mkfifo pipe; sleep 600 > pipe & echo ready; exec cat pipe",
        "ready",
        AtPrompt::Nothing,
        reading(Wait::None, Echo::On)
    )]
    #[case::raw_cat(
        "stty -echo -icanon; echo ready; exec cat",
        "ready",
        AtPrompt::Nothing,
        reading(Wait::OnTerminal, Echo::Off)
    )]
    #[case::read_with_time_limit(
        "read -t 1 line; echo ready; sleep 30",
        "ready",
        AtPrompt::Nothing,
        reading(Wait::None, Echo::On)
    )]
    #[case::sleep(
        "echo ready; exec sleep 30",
        "ready",
        AtPrompt::Nothing,
        reading(Wait::None, Echo::On)
    )]
    #[case::python_select(
        SELECT_READER_SCRIPT,
        "ready",
        AtPrompt::Nothing,
        reading(select_wait(Wait::InSelect), Echo::On)
    )]
    // Its `select` holds the terminal, and a pipe open for reading its wait may be on instead.
    #[case::pipe_holding_select(
        PIPE_HOLDING_SELECT_READER_SCRIPT,
        "ready",
        AtPrompt::Nothing,
        reading(select_wait(Wait::None), Echo::On)
    )]
    // The same with a FIFO a quiet writer holds open.
    #[case::fifo_holding_select(
        "mkfifo pipe; sleep 600 > pipe & exec python3 -c \"import select, sys; \
         fifo = open('pipe'); print('ready', flush=True); select.select([sys.stdin], [], [])\"",
        "ready",
        AtPrompt::Nothing,
        reading(select_wait(Wait::None), Echo::On)
    )]
    // The same with a kqueue, whose knotes its wait may be on instead; Linux has no kqueue.
    #[cfg_attr(
        target_os = "macos",
        case::kqueue_holding_select(
            "exec python3 -c \"import select, sys; queue = select.kqueue(); \
             print('ready', flush=True); select.select([sys.stdin], [], [])\"",
            "ready",
            AtPrompt::Nothing,
            reading(select_wait(Wait::None), Echo::On)
        )
    )]
    // Bound to the loopback address, which no firewall prompt guards.
    #[case::socket_server(
        "exec python3 -m http.server 0 --bind 127.0.0.1",
        "Serving HTTP",
        AtPrompt::Nothing,
        reading(Wait::None, Echo::On)
    )]
    // Its standard streams are away from the terminal, so `/dev/tty` is its only way to it.
    #[case::controlling_terminal_reader(
        "exec python3 -c \"import os; terminal = os.open('/dev/tty', os.O_RDWR); \
         os.write(terminal, b'ready\\n'); os.read(terminal, 1)\" < /dev/null > /dev/null 2>&1",
        "ready",
        AtPrompt::Nothing,
        reading(Wait::OnTerminal, Echo::On)
    )]
    // Its parent subshell exits, so it is an orphan outside the session leader's tree; on Linux
    // the test takes it in as a child subreaper, as the daemon does.
    #[case::orphan_reader(
        "( python3 -c \"print('ready', flush=True); input()\" < /dev/tty & ); exec sleep 600",
        "ready",
        AtPrompt::Nothing,
        reading(Wait::OnTerminal, Echo::On)
    )]
    #[case::hidden_read(
        "echo ready; exec /bin/bash -c 'read -s line'",
        "ready",
        AtPrompt::Nothing,
        reading(Wait::OnTerminal, Echo::Off)
    )]
    #[case::vim(
        "exec vim -u NONE -N -n",
        "~",
        AtPrompt::Nothing,
        reading(select_wait(Wait::InSelect), Echo::Off)
    )]
    #[tokio::test]
    async fn input_wait_reads_each_kind_of_reader(
        #[case] script: &str,
        #[case] marker: &str,
        #[case] at_prompt: AtPrompt,
        #[case] expected: InputWaitReading,
    ) {
        #[cfg(target_os = "linux")]
        nix::sys::prctl::set_child_subreaper(true).expect("the test takes in orphans");
        // The command's own folder, which holds what it makes and goes with the test.
        let folder = tempfile::tempdir().expect("a scratch folder");
        let options = terminal_options(
            "/bin/sh".to_owned(),
            vec!["-c".to_owned(), script.to_owned()],
            Some(folder.path().to_path_buf()),
            HashMap::new(),
        );
        let spawner = Spawner::new(tokio::runtime::Handle::current()).expect("the spawner starts");
        let terminal =
            start_inner_terminal(&options, TEST_WINDOW_SIZE).expect("the terminal starts");
        let prompt = read_until_marker(&terminal.pty, marker, Duration::from_secs(20));
        let acting = prompt.is_ok().then(|| at_prompt.apply(&terminal));
        let is_marked = expected.is_waiting || expected.is_waiting_in_select;
        if prompt.is_ok() && !is_marked {
            tokio::time::sleep(SETTLE).await;
        }
        let peer_failure_noted = Once::new();
        // A waiting command is read until it reads as waiting; one that waits on nothing is read
        // across the whole bound, and must never read as waiting.
        let window_start = Instant::now();
        let mut readings = Vec::new();
        let mut output = [0_u8; 4_096];
        while prompt.is_ok() {
            // The output is read as the daemon reads it, so a command drawing a screen never
            // blocks on a full terminal.
            while terminal
                .pty
                .file()
                .read(&mut output)
                .is_ok_and(|count| count > 0)
            {}
            let reading = match read_terminal_master(&terminal.pty, &peer_failure_noted) {
                Ok(master) => {
                    let device = terminal.device;
                    read_input_wait(&spawner, &InputTerminal { device, master }).await
                }
                Err(error) => Err(error),
            };
            let is_settled = reading
                .as_ref()
                .map_or(true, |reading| is_marked && *reading == expected);
            readings.push(reading);
            if is_settled || window_start.elapsed() >= WAIT_BOUND {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        end_inner_terminal(terminal);

        prompt.expect("the command prompts");
        acting
            .expect("the command prompted")
            .expect("the test acts on the command");
        let readings = readings
            .into_iter()
            .collect::<std::io::Result<Vec<_>>>()
            .expect("the wait reads");
        if is_marked {
            assert_eq!(readings.last(), Some(&expected), "{script}: {readings:?}");
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
        let terminal =
            start_inner_terminal(&options, TEST_WINDOW_SIZE).expect("the terminal starts");
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

    // What a case does once its command prompts.
    #[derive(Clone, Copy)]
    enum AtPrompt {
        Nothing,
        // Types these bytes.
        Type(&'static str),
        // Stops the command's group, as Ctrl+Z does.
        Stop,
    }

    impl AtPrompt {
        fn apply(self, terminal: &InnerTerminal) -> std::io::Result<()> {
            match self {
                Self::Nothing => Ok(()),
                Self::Type(typed) => terminal.pty.file().write_all(typed.as_bytes()),
                Self::Stop => {
                    let leader = i32::try_from(terminal.pty.child().id()).expect("a process id");
                    killpg(Pid::from_raw(leader), Signal::SIGSTOP).map_err(std::io::Error::from)
                }
            }
        }
    }

    // How a case's command waits.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Wait {
        OnTerminal,
        InSelect,
        None,
    }

    // How a case's terminal echoes.
    #[derive(Clone, Copy)]
    enum Echo {
        On,
        Off,
    }

    // How a `select` or `poll` reader on the terminal reads: on the terminal where Linux reads the
    // call's descriptor set, else as `hidden`, the reading where macOS, or Yama refusing the read
    // on Linux, hides it.
    fn select_wait(hidden: Wait) -> Wait {
        #[cfg(target_os = "linux")]
        if !crate::linux::input_wait::is_ptrace_admin_only().expect("the ptrace scope reads") {
            return Wait::OnTerminal;
        }
        hidden
    }

    // A command holding its terminal for reading, waiting or not, with its echo as given.
    fn reading(wait: Wait, echo: Echo) -> InputWaitReading {
        InputWaitReading {
            is_waiting: wait == Wait::OnTerminal,
            is_waiting_in_select: wait == Wait::InSelect,
            accepts_input: true,
            is_echo_off: matches!(echo, Echo::Off),
        }
    }
}
