//! The macOS and Linux pieces of the `shell` mode: the default shell, the parent check that
//! keeps a shell from outliving the daemon, and the exec on the program's resolved path, on macOS
//! as its own responsible process once the daemon confirms it started the mode.

use std::convert::Infallible;
use std::ffi::{CString, OsStr};
use std::io;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
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
#[cfg(target_os = "macos")]
use crate::macos::shell_start_confirmation::receive_confirmation;
use crate::posix::executable_file::is_executable_file;
use crate::posix::process::id::system_process_id;
use crate::shell_start::{ShellStart, ShellStartError};

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

/// Arms the process to end with the daemon `daemon_pid` and checks the daemon is still its parent;
/// on Linux also clears the huge-page switch the daemon set for itself. Async-signal-safe and
/// allocation-free, so a `Command`'s `pre_exec` calls it. Fails with `ESRCH` when the daemon is no
/// longer the parent, and with the system's error when a call is refused.
pub fn arm_parent_death(daemon_pid: u32) -> io::Result<()> {
    arm(daemon_pid).map_err(|failure| match failure {
        ArmingFailure::DaemonGone => io::Error::from(DAEMON_GONE_ERRNO),
        #[cfg(target_os = "linux")]
        ArmingFailure::Refused(errno) => io::Error::from(errno),
    })
}

/// Prepares the `shell` mode's own process for its exec: arms it as [`arm_parent_death`]
/// does; on macOS waits for the daemon's confirmation that it started this process, without which
/// no program starts as its own responsible process; enters `folder`, which the shell inherits
/// across the exec; then sets `SIGPIPE` back to its default, since an ignored signal survives
/// `execve`. Fails with [`ShellStartError::DaemonGone`] when the daemon is no longer the parent,
/// [`ShellStartError::Unconfirmed`] when the confirmation does not come,
/// [`ShellStartError::FolderRefused`] when the folder cannot be entered, and with the variant
/// naming the call the system refused.
pub fn prepare_shell_start(daemon_pid: u32, folder: &Path) -> Result<(), ShellStartError> {
    arm(daemon_pid).map_err(|failure| match failure {
        ArmingFailure::DaemonGone => ShellStartError::DaemonGone,
        #[cfg(target_os = "linux")]
        ArmingFailure::Refused(errno) => ShellStartError::ArmingRefused(io::Error::from(errno)),
    })?;
    #[cfg(target_os = "macos")]
    receive_confirmation().map_err(ShellStartError::Unconfirmed)?;
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
        argv.push(CString::new(argument.as_bytes())?);
    }
    let envp = start
        .environment
        .iter()
        .map(|(name, value)| CString::new(format!("{name}={value}")))
        .collect::<Result<Vec<_>, _>>()?;
    let path = if program.contains(&b'/') {
        CString::new(program)?
    } else {
        let resolved = find_program(&start.program, search_path(start))?;
        CString::new(resolved.into_os_string().into_vec())?
    };
    #[cfg(target_os = "linux")]
    return execve(&path, &argv, &envp).map_err(io::Error::from);
    #[cfg(target_os = "macos")]
    return Err(OwnRootStart::new(path, argv, envp)?.exec());
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
