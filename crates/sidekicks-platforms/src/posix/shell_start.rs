//! The macOS and Linux pieces of the `shell` mode: the default shell, the parent check that
//! keeps a shell from outliving the daemon, the launch the daemon confirms it started the mode
//! with, the terminal the mode takes as its controlling one, the exec on the program's resolved path, on macOS as its own responsible process, and the
//! plain words a failed exec reads as.

use std::convert::Infallible;
use std::ffi::{CString, OsStr};
use std::io;
use std::path::{Path, PathBuf};

use nix::errno::Errno;
#[cfg(target_os = "linux")]
use nix::sys::prctl::{set_pdeathsig, set_thp_disable};
use nix::sys::signal::{SigHandler, Signal, signal};
#[cfg(target_os = "linux")]
use nix::unistd::execve;
use nix::unistd::{Pid, chdir, getppid};

#[cfg(target_os = "macos")]
use crate::macos::responsibility::OwnRootStart;
use crate::posix::c_string::c_string;
use crate::posix::executable_file::is_executable_file;
use crate::posix::process::id::system_process_id;
use crate::posix::shell_start_confirmation::{WriterCheck, receive_launch};
use crate::shell_start::{ShellLaunch, ShellStart, ShellStartError};

// zsh, the system's own shell on macOS.
#[cfg(target_os = "macos")]
const DEFAULT_SHELL: &str = "/bin/zsh";

// `/bin/sh`, which Linux starts for an account that names no shell.
#[cfg(target_os = "linux")]
const DEFAULT_SHELL: &str = "/bin/sh";

/// The arguments that start a shell as a login shell.
pub const LOGIN_SHELL_ARGUMENTS: &[&str] = &["-l"];

// Where a bare program name is looked up when the environment holds no `PATH`: the system's own
// default search path, so a shell starts as it would from a login with no `PATH` set.
const DEFAULT_SEARCH_PATH: &str = "/usr/bin:/bin";

// No such process: the daemon, once another process is the parent.
#[cfg(target_os = "linux")]
const DAEMON_GONE_ERRNO: Errno = Errno::ESRCH;

enum ArmingFailure {
    DaemonGone,
    // Only Linux makes a call the system can refuse.
    #[cfg(target_os = "linux")]
    Refused(Errno),
}

/// The platform's default shell, started where the account's login shell cannot be.
pub fn default_shell() -> PathBuf {
    PathBuf::from(DEFAULT_SHELL)
}

/// Whether a shell's end with the daemon follows the thread that started it rather than the
/// daemon's process: on Linux, whose parent-death signal fires when that thread ends; not on
/// macOS, whose check follows the daemon's process.
#[cfg(any(test, feature = "test-support"))]
pub const DOES_PARENT_DEATH_FOLLOW_STARTING_THREAD: bool = cfg!(target_os = "linux");

/// The POSIX shell every Unix has, which runs a line no other shell is named for: `/bin/sh`.
pub const POSIX_SHELL: &str = "/bin/sh";

/// Whether [`POSIX_SHELL`] knows no `builtin`: on Linux, whose `/bin/sh` is dash on the
/// distributions the tests run on; not on macOS, whose `/bin/sh` is bash.
#[cfg(any(test, feature = "test-support"))]
pub const DOES_POSIX_SHELL_LACK_BUILTIN: bool = cfg!(target_os = "linux");

/// Arms the process to end with the daemon `daemon_pid`, checks the daemon is still its parent and
/// clears the huge-page switch the daemon set for itself. Async-signal-safe and allocation-free, so
/// a `Command`'s `pre_exec` calls it. Fails with `ESRCH` when the daemon is no longer the parent,
/// and with the system's error when a call is refused.
#[cfg(target_os = "linux")]
pub(crate) fn arm_parent_death(daemon_pid: u32) -> io::Result<()> {
    arm(daemon_pid).map_err(|failure| match failure {
        ArmingFailure::DaemonGone => io::Error::from(DAEMON_GONE_ERRNO),
        #[cfg(target_os = "linux")]
        ArmingFailure::Refused(errno) => io::Error::from(errno),
    })
}

/// Prepares the `shell` mode's own process for its exec and answers the launch the daemon sent:
/// arms it to end with the daemon and checks the daemon is still its parent (on macOS, which has no
/// parent-death signal, the check alone); reads the daemon's confirmation that it started this
/// process and the shell's launch after it, written by the daemon `daemon_pid` (on macOS also its
/// own responsible process, without which no program starts as its own responsible process);
/// takes its terminal as its controlling one, so the shell's jobs and signal keys reach it; enters
/// the shell's folder, which the shell inherits across the exec; then sets `SIGPIPE` back to its
/// default, since an ignored signal survives `execve`. Fails with [`ShellStartError::DaemonGone`]
/// when the daemon is no longer the parent, [`ShellStartError::Unconfirmed`] when the confirmation
/// or the launch does not come from it, [`ShellStartError::FolderRefused`] when the folder cannot
/// be entered, and with the variant naming the call the system refused.
pub fn prepare_shell_start(daemon_pid: u32) -> Result<ShellLaunch, ShellStartError> {
    arm(daemon_pid).map_err(|failure| match failure {
        ArmingFailure::DaemonGone => ShellStartError::DaemonGone,
        #[cfg(target_os = "linux")]
        ArmingFailure::Refused(errno) => ShellStartError::ArmingRefused(io::Error::from(errno)),
    })?;
    let launch =
        receive_launch(daemon_pid, WriterCheck::Daemon).map_err(ShellStartError::Unconfirmed)?;
    prepare_exec(&launch.shell.folder)?;
    Ok(launch)
}

/// The `shell` mode's stand-in tests start shells through: reads the launch its parent wrote, as
/// the mode does but with no parent-death signal and no responsible-process check, takes its
/// terminal, enters the shell's folder and starts the shell. Returns only on failure, with the error that stopped it.
#[cfg(any(test, feature = "test-support"))]
pub fn run_shell_start_stand_in() -> io::Error {
    let parent = std::os::unix::process::parent_id();
    let launch = match receive_launch(parent, WriterCheck::Parent) {
        Ok(launch) => launch,
        Err(error) => return error,
    };
    if let Err(error) = prepare_exec(&launch.shell.folder) {
        return io::Error::other(error);
    }
    start_program(&launch.shell)
}

// `TIOCSCTTY`, which makes a terminal the calling session leader's controlling terminal; through
// nix's macro, since `libc` types the request differently on macOS and Linux.
nix::ioctl_write_int_bad!(set_controlling_terminal, libc::TIOCSCTTY);

/// Makes the terminal on standard input this process's controlling terminal, as a session leader
/// that has none takes it; argument 0, so a terminal another session holds is refused, never
/// stolen. The spawn that made this process a session leader cannot do it: macOS runs a spawn's
/// file actions before its new session. Fails with the system's error.
pub(crate) fn take_controlling_terminal() -> io::Result<()> {
    // SAFETY: `TIOCSCTTY` reads only its integer argument, and descriptor 0 is this process's own.
    unsafe { set_controlling_terminal(libc::STDIN_FILENO, 0) }
        .map(drop)
        .map_err(io::Error::from)
}

// Readies this process for the shell's exec: takes the terminal on its standard input as its
// controlling one, enters `folder`, then sets `SIGPIPE` back to its default.
fn prepare_exec(folder: &Path) -> Result<(), ShellStartError> {
    take_controlling_terminal().map_err(ShellStartError::TerminalRefused)?;
    chdir(folder).map_err(|errno| ShellStartError::FolderRefused(io::Error::from(errno)))?;
    // SAFETY: the default disposition installs no handler, so no code of this program can run
    // inside a signal.
    unsafe { signal(Signal::SIGPIPE, SigHandler::SigDfl) }
        .map(drop)
        .map_err(|errno| ShellStartError::SignalResetRefused(io::Error::from(errno)))
}

/// Replaces the process with `start`'s program, with exactly its arguments, its raw tail as one
/// last argument, and its environment, in the folder [`prepare_shell_start`] entered, and
/// returns only on failure: `InvalidInput` for a NUL in the program, an argument or the
/// environment, `ENOENT` for a bare name no `PATH` folder holds as a program, and otherwise the
/// error the exec answers. A bare name is looked up on the environment's own `PATH`, and the exec
/// runs the resolved path, never through `execvp`, which runs a file the kernel refuses through
/// `/bin/sh`. On macOS the program starts as its own responsible process, so nothing it starts
/// reads as the daemon's; Linux execs with `execve`.
pub fn start_program(start: &ShellStart) -> io::Error {
    let Err(error) = exec_program(start);
    error
}

fn exec_program(start: &ShellStart) -> io::Result<Infallible> {
    let program = start.program.as_bytes();
    let mut argv = Vec::with_capacity(start.arguments.len() + 2);
    argv.push(CString::new(program)?);
    for argument in start.arguments.iter().chain(&start.raw_command_tail) {
        argv.push(CString::new(argument.as_str())?);
    }
    let envp = start
        .environment
        .iter()
        .map(|(name, value)| CString::new(format!("{name}={value}")))
        .collect::<Result<Vec<_>, _>>()?;
    let path = if program.contains(&b'/') {
        CString::new(program)?
    } else {
        let resolved = find_program(OsStr::new(&start.program), search_path(start))?;
        c_string(resolved.as_os_str())?
    };
    #[cfg(target_os = "linux")]
    return execve(&path, &argv, &envp).map_err(io::Error::from);
    #[cfg(target_os = "macos")]
    return Err(OwnRootStart::new(path, argv, envp)?.exec());
}

// The plain words a failed exec's error reads as, where the system's own text is not shown: a
// missing file or interpreter, a refusal, a file the system cannot run, a path past the system's
// limit and a disk that failed to read.
const START_FAILURE_WORDS: &[(i32, &str)] = &[
    (libc::ENOENT, "no such file"),
    (libc::EACCES, "not allowed to run"),
    (libc::EPERM, "not allowed to run"),
    (libc::EISDIR, "not allowed to run"),
    (libc::ENOEXEC, "not a program for this computer"),
    #[cfg(target_os = "macos")]
    (libc::EBADARCH, "not a program for this computer"),
    #[cfg(target_os = "macos")]
    (libc::EBADEXEC, "not a program for this computer"),
    #[cfg(target_os = "macos")]
    (libc::EBADMACHO, "not a program for this computer"),
    #[cfg(target_os = "macos")]
    (libc::ESHLIBVERS, "not a program for this computer"),
    #[cfg(target_os = "linux")]
    (libc::ELIBBAD, "not a program for this computer"),
    (libc::ENAMETOOLONG, "its path is too long"),
    (libc::EIO, "the disk could not be read"),
];

/// The plain words a failed exec's error `code` reads as; `None` for an error shown in the
/// system's own text.
pub(crate) fn start_failure_words(code: i32) -> Option<&'static str> {
    START_FAILURE_WORDS
        .iter()
        .find_map(|&(listed, words)| (listed == code).then_some(words))
}

fn search_path(start: &ShellStart) -> &str {
    start
        .environment
        .iter()
        .find(|(name, _)| name == "PATH")
        .map_or(DEFAULT_SEARCH_PATH, |(_, value)| value.as_str())
}

// The first folder holding `name` as a regular file the user may run; an empty entry is the
// current folder, as `execvp` reads it.
fn find_program(name: &OsStr, search_path: &str) -> io::Result<PathBuf> {
    search_path
        .split(':')
        .map(|folder| Path::new(if folder.is_empty() { "." } else { folder }).join(name))
        .find(|candidate| is_executable_file(candidate))
        .ok_or_else(|| io::Error::from(Errno::ENOENT))
}

#[cfg(target_os = "linux")]
fn arm(daemon_pid: u32) -> Result<(), ArmingFailure> {
    set_pdeathsig(Signal::SIGHUP).map_err(ArmingFailure::Refused)?;
    // Checked after arming, so a daemon that ended before the signal was armed is still caught.
    check_parent(daemon_pid)?;
    set_thp_disable(false).map_err(ArmingFailure::Refused)
}

// macOS has no parent-death signal, so the parent check is all there is.
#[cfg(target_os = "macos")]
fn arm(daemon_pid: u32) -> Result<(), ArmingFailure> {
    check_parent(daemon_pid)
}

// A pid of 0 or past `i32::MAX` is never the parent.
fn check_parent(daemon_pid: u32) -> Result<(), ArmingFailure> {
    let is_parent =
        system_process_id(daemon_pid).is_ok_and(|pid| getppid() == Pid::from_raw(pid.get()));
    if is_parent {
        Ok(())
    } else {
        Err(ArmingFailure::DaemonGone)
    }
}
