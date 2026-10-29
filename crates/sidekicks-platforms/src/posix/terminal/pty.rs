//! A terminal's PTY on macOS and Linux and the start of a program in it with no fork: the PTY
//! opened at its window size, its master set to read input as UTF-8 and not to block, and the
//! program spawned as the leader of a session of its own with the terminal on its standard streams.
//! The program takes the terminal as its controlling one itself, since a spawn cannot hand it one
//! on macOS.

use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::fd::{AsFd as _, BorrowedFd, OwnedFd};
use std::path::Path;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};

use nix::fcntl::{FcntlArg, OFlag, fcntl};
use nix::sys::signal::Signal;
use nix::sys::termios::{InputFlags, SetArg, tcgetattr, tcsetattr};
use rustix_openpty::openpty;
use rustix_openpty::rustix::termios::Winsize;

use crate::posix::spawn::{
    SessionLeaderSpawn, SpawnStream, inherited_environment, reap_exited_child, reap_spawned_child,
    spawn_session_leader,
};
use crate::posix::terminal::send_signal;
use crate::terminal::{TerminalSignal, TerminalStart};

/// The signals a program started in a terminal begins with at their default action, as a shell
/// expects them whatever the daemon ignores.
const TERMINAL_DEFAULT_SIGNALS: &[Signal] = &[
    Signal::SIGPIPE,
    Signal::SIGCHLD,
    Signal::SIGHUP,
    Signal::SIGINT,
    Signal::SIGQUIT,
    Signal::SIGTERM,
    Signal::SIGALRM,
];

/// An open PTY and the program started in it, the leader of the terminal's session. Dropped while
/// its program is unreaped, it sends the program a hangup and waits for its exit, so a program
/// that ignores the hangup holds the drop: its owner ends the program first.
pub struct Pty {
    /// The PTY's master, non-blocking.
    master: File,
    /// The program's process id, its session's and its group's.
    process_id: u32,
    /// Set once the program is reaped, after which its id may name another process.
    is_reaped: AtomicBool,
}

impl Pty {
    /// The PTY's master, which reads the program's output and takes its input without blocking.
    pub(crate) fn file(&self) -> &File {
        &self.master
    }

    /// The program's process id, which stays its own until it is reaped.
    pub(crate) fn process_id(&self) -> u32 {
        self.process_id
    }

    /// Whether the program has been reaped.
    pub(crate) fn is_reaped(&self) -> bool {
        self.is_reaped.load(Ordering::SeqCst)
    }

    /// Reaps the program when the system reports its exit, never waiting, and answers how it
    /// ended; `None` while it runs, before the system reports the exit to a wait, or once it is
    /// reaped. Fails with the system's error from the wait.
    pub(crate) fn reap_if_exited(&self) -> io::Result<Option<ExitStatus>> {
        if self.is_reaped() {
            return Ok(None);
        }
        let status = reap_exited_child(self.process_id)?;
        if status.is_some() {
            self.is_reaped.store(true, Ordering::SeqCst);
        }
        Ok(status)
    }

    /// Waits for the program's exit and reaps it, answering how it ended; blocking, and past a
    /// stop. Fails with `NotFound` once it is reaped, since its id may then name another child,
    /// and with the system's error from the wait.
    pub(crate) fn reap(&self) -> io::Result<ExitStatus> {
        if self.is_reaped() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "the terminal's program is already reaped",
            ));
        }
        let status = reap_spawned_child(self.process_id)?;
        self.is_reaped.store(true, Ordering::SeqCst);
        Ok(status)
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        if self.is_reaped() {
            return;
        }
        // Unreaped, the program keeps its id, so the hangup reaches no other process.
        if let Err(error) = send_signal(self.process_id, TerminalSignal::Hangup) {
            tracing::warn!(
                process_id = self.process_id,
                error = &error as &(dyn Error + 'static),
                "a dropped terminal's program got no hangup"
            );
        }
        if let Err(error) = self.reap() {
            tracing::warn!(
                process_id = self.process_id,
                error = &error as &(dyn Error + 'static),
                "a dropped terminal's program could not be reaped"
            );
        }
    }
}

/// A PTY opened and not yet given a program: its master and its program's side.
pub(crate) struct OpenedTerminal {
    /// The master, set to read input as UTF-8 and not to block.
    pub(crate) controller: OwnedFd,
    /// The program's side, which belongs to no session yet.
    pub(crate) follower: OwnedFd,
}

/// Opens a PTY at `size`, both ends closed on exec and its follower in no session, its line
/// discipline reading input as UTF-8 so an erase takes a whole character, its master not blocking.
/// Fails with the system's error.
pub(crate) fn open_terminal(size: Winsize) -> io::Result<OpenedTerminal> {
    // Both close-on-exec from the open (atomically on Linux), so a child another thread starts
    // meanwhile inherits neither and cannot hold the terminal open past its program's end.
    let rustix_openpty::Pty { controller, user } = openpty(None, Some(&size))?;
    let mut settings = tcgetattr(&controller).map_err(io::Error::from)?;
    settings.input_flags.insert(InputFlags::IUTF8);
    tcsetattr(&controller, SetArg::TCSANOW, &settings).map_err(io::Error::from)?;
    let flags =
        OFlag::from_bits_retain(fcntl(&controller, FcntlArg::F_GETFL).map_err(io::Error::from)?);
    fcntl(&controller, FcntlArg::F_SETFL(flags | OFlag::O_NONBLOCK)).map_err(io::Error::from)?;
    Ok(OpenedTerminal {
        controller,
        follower: user,
    })
}

/// What [`spawn_in_terminal`] starts.
pub(crate) struct TerminalProgram<'a> {
    /// The program, an absolute path.
    pub(crate) program: &'a Path,
    /// The first word of its command line, the name it reads as its own.
    pub(crate) argument_zero: &'a OsStr,
    /// The words after the first.
    pub(crate) arguments: &'a [String],
    /// Its whole environment, each entry `NAME=VALUE`.
    pub(crate) environment: Vec<OsString>,
    /// The folder it starts in; `None` keeps this process's.
    pub(crate) folder: Option<&'a Path>,
    /// One more descriptor it keeps open beside the terminal.
    pub(crate) inherited: Option<BorrowedFd<'a>>,
}

/// Starts `program` in `terminal` as the leader of a session of its own, the terminal's follower
/// on its three standard streams, the signals a shell expects at their default, by `posix_spawn`,
/// which runs no fork handler; the program takes the terminal as its controlling one itself. Closes
/// this process's follower, so the master reads the end once the program's side all closes.
/// Blocking. Fails as the spawn fails, the error naming the program.
pub(crate) fn spawn_in_terminal(
    terminal: OpenedTerminal,
    program: &TerminalProgram<'_>,
) -> io::Result<Pty> {
    let follower = terminal.follower.as_fd();
    let process_id = spawn_session_leader(&SessionLeaderSpawn {
        program: program.program,
        argument_zero: program.argument_zero,
        arguments: program.arguments,
        environment: program.environment.clone(),
        working_folder: program.folder,
        streams: [
            SpawnStream::Descriptor(follower),
            SpawnStream::Descriptor(follower),
            SpawnStream::Descriptor(follower),
        ],
        inherited: program.inherited,
        default_signals: TERMINAL_DEFAULT_SIGNALS,
    })
    .map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "the program {} could not be started: {error}",
                program.program.display()
            ),
        )
    })?;
    Ok(Pty {
        master: File::from(terminal.controller),
        process_id,
        is_reaped: AtomicBool::new(false),
    })
}

/// Opens a shell's terminal at `start`'s size and starts the daemon's `shell` mode in it, in
/// `start`'s folder, with the daemon's own environment, the confirmation's entry set over it, and
/// the confirmation's end inherited. Blocking; runs on the daemon's spawner thread, which starts no
/// other child before the confirmation is written. Fails with the system's error when the terminal
/// cannot be opened, and as the spawn fails, the error naming the program, a folder that cannot be
/// entered among them.
pub fn start_terminal(start: &TerminalStart<'_>) -> io::Result<Pty> {
    let terminal = open_terminal(Winsize {
        ws_row: start.rows,
        ws_col: start.columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    })?;
    let added: Vec<(String, String)> = start.confirmation.environment_entry().into_iter().collect();
    spawn_in_terminal(
        terminal,
        &TerminalProgram {
            program: start.program,
            argument_zero: start.program.as_os_str(),
            arguments: start.arguments,
            environment: inherited_environment(&added),
            folder: Some(start.folder),
            inherited: start
                .confirmation
                .shell_end
                .as_ref()
                .map(|shell_end| shell_end.as_fd()),
        },
    )
}

/// The inner terminal's stand-in tests start commands through: takes the terminal on its standard
/// input as its controlling one, as the command wrapper's inner form does, then replaces itself
/// with the program and words that follow `--` among its own arguments. Returns only on failure,
/// with the error that stopped it.
#[cfg(any(test, feature = "test-support"))]
pub fn run_terminal_taking_stand_in() -> io::Error {
    use std::os::unix::process::CommandExt as _;

    if let Err(error) = crate::posix::shell_start::take_controlling_terminal() {
        return error;
    }
    let mut words = std::env::args_os().skip_while(|word| word != "--").skip(1);
    let Some(program) = words.next() else {
        return io::Error::new(io::ErrorKind::InvalidInput, "no program follows `--`");
    };
    std::process::Command::new(program).args(words).exec()
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    use nix::errno::Errno;
    use nix::sys::signal::{Signal, killpg};
    use nix::sys::termios::tcgetsid;
    use nix::unistd::{Pid, tcgetpgrp};

    use super::start_terminal;
    use crate::posix::shell_start::run_shell_start_stand_in;
    use crate::posix::shell_start_confirmation::ShellStartConfirmation;
    use crate::shell_start::{ShellLaunch, ShellStart};
    use crate::terminal::TerminalStart;
    use crate::test_program::{harness_test_name, pass_through_start};

    /// The `shell` mode's stand-in, run by the test below in the terminal it starts.
    const SHELL_MODE_STAND_IN: &str = "the_shell_mode_stand_in_starts_the_launched_shell";

    #[test]
    #[ignore = "run only as the shell mode's stand-in, in a test's terminal"]
    fn the_shell_mode_stand_in_starts_the_launched_shell() {
        let error = run_shell_start_stand_in();
        panic!("the stand-in did not start the launched shell: {error:?}");
    }

    // A launch of `/bin/sleep 30` in `folder`, a program that never takes a terminal itself.
    fn sleep_launch(folder: &Path) -> ShellStart {
        ShellStart {
            program: "/bin/sleep".to_owned(),
            arguments: vec!["30".to_owned()],
            raw_command_tail: None,
            folder: folder.to_path_buf(),
            environment: Vec::new(),
        }
    }

    // Fails when the started program does not lead the terminal's session and foreground group,
    // which leaves the signal keys, the input wait and the group end nothing to reach. The program
    // run is `/bin/sleep`, which takes no terminal itself, so only the mode's own step can make it
    // the controlling terminal. Mutation: delete the `TIOCSCTTY` call in the mode's exec step.
    #[test]
    fn the_shell_mode_takes_its_terminal_as_its_controlling_one() {
        let stand_in = pass_through_start(&harness_test_name(module_path!(), SHELL_MODE_STAND_IN));
        let folder: PathBuf = std::env::current_dir().expect("the test runs in a folder");
        let mut confirmation = ShellStartConfirmation::new().expect("the pair opens");
        let pty = start_terminal(&TerminalStart {
            program: Path::new(&stand_in.program),
            arguments: &stand_in.arguments,
            folder: &folder,
            rows: 24,
            columns: 80,
            confirmation: &confirmation,
        })
        .expect("the terminal starts");
        let process_id = pty.process_id();
        confirmation
            .confirm(process_id)
            .expect("the start is confirmed");
        let frame = ShellLaunch {
            shell: sleep_launch(&folder),
            fallback: sleep_launch(&folder),
        }
        .encode()
        .expect("the launch encodes");
        confirmation
            .daemon_end
            .write_all(&frame)
            .expect("the launch is written");

        let leader = i32::try_from(process_id).expect("a process id");
        let started = Instant::now();
        let reading = loop {
            let session = tcgetsid(pty.file()).ok().map(Pid::as_raw);
            let foreground = tcgetpgrp(pty.file()).ok().map(Pid::as_raw);
            if foreground == Some(leader) || started.elapsed() >= Duration::from_secs(20) {
                break (session, foreground);
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        // A stand-in that failed has ended already, so its group is gone and the assert reports.
        match killpg(Pid::from_raw(leader), Signal::SIGKILL) {
            Ok(()) | Err(Errno::ESRCH) => {}
            Err(errno) => panic!("the terminal's group is not killed: {errno}"),
        }
        drop(pty);
        drop(confirmation);

        assert_eq!(reading, (Some(leader), Some(leader)));
    }
}
