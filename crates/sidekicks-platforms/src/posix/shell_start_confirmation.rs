//! The daemon's word that it started a terminal's `shell` mode, and the shell's launch that follows
//! it, on macOS and Linux: the daemon opens a socket pair, hands one end to the mode it starts,
//! writes the id of the process it started on the other, then the launch frame; the mode starts a
//! shell only when the id is its own and the system vouches for the daemon its argument names. On
//! macOS that daemon is the mode's parent and the process that last wrote on the pair; on Linux
//! it made the pair, whose end is no socket a listener's connection gave, and runs as this account.
//! An agent's command that runs the daemon's program in the `shell` mode itself inherits no such
//! end, so the mode starts nothing for it.

use std::io::{self, Read as _, Write as _};
use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd, RawFd};
use std::os::unix::net::UnixStream;

use tokio::io::AsyncWriteExt as _;

#[cfg(target_os = "linux")]
use crate::linux::shell_start_confirmation::check_confirming_writer;
#[cfg(target_os = "macos")]
use crate::macos::shell_start_confirmation::check_confirming_writer;
use crate::shell_start::{SHELL_START_CONFIRMATION, ShellLaunch};

/// The bytes the confirmation carries: the started process's id.
type ConfirmedId = [u8; size_of::<u32>()];

/// Whether the mode also requires its confirming parent to be its own responsible process, as the
/// daemon is on macOS; a test's stand-in for the mode, whose parent runs under the test runner,
/// does not.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WriterCheck {
    /// The writer is the daemon the mode's argument names, and on macOS its own responsible
    /// process.
    Daemon,
    /// The writer is the parent the stand-in's argument names.
    #[cfg(any(test, feature = "test-support"))]
    Parent,
}

/// The daemon's side of one shell start's confirmation: the socket pair, its shell end inherited
/// by the `shell` mode the daemon starts next. The daemon keeps it until that shell has ended,
/// since the mode reads who wrote the confirmation only while the daemon's end is open.
pub struct ShellStartConfirmation {
    /// The end the daemon writes the started process's id and the launch on; closed on exec, and
    /// when this drops.
    pub(crate) daemon_end: UnixStream,
    /// The end the `shell` mode inherits; closed in the daemon once the confirmation is written.
    pub(crate) shell_end: Option<OwnedFd>,
}

impl ShellStartConfirmation {
    /// Opens the pair for the next shell's start. Runs on the daemon's spawner thread, which
    /// starts every child the daemon starts, right before the shell's start; the shell's end stays
    /// open across an exec, and that thread starts no other child before [`Self::confirm`] closes
    /// it, so no other child inherits it. Fails with the system's error.
    pub fn new() -> io::Result<Self> {
        let mut ends: [RawFd; 2] = [0; 2];
        // SAFETY: `ends` is a live array of the two descriptors the call fills.
        let status =
            unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, ends.as_mut_ptr()) };
        if status != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: the call succeeded, so both descriptors are new and owned here alone.
        let (daemon_end, shell_end) =
            unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
        // SAFETY: the descriptor is open; the call only sets its close-on-exec flag.
        if unsafe { libc::fcntl(daemon_end.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } != 0 {
            return Err(io::Error::last_os_error());
        }
        #[cfg(target_os = "macos")]
        crate::macos::shell_start_confirmation::refuse_sigpipe(&daemon_end)?;
        Ok(Self {
            daemon_end: UnixStream::from(daemon_end),
            shell_end: Some(shell_end),
        })
    }

    /// The variable and value the `shell` mode's environment carries so the mode finds its end;
    /// `None` once the confirmation is written.
    pub fn environment_entry(&self) -> Option<(String, String)> {
        self.shell_end.as_ref().map(|shell_end| {
            (
                SHELL_START_CONFIRMATION.to_owned(),
                shell_end.as_raw_fd().to_string(),
            )
        })
    }

    /// Closes the daemon's copy of the shell's end and confirms that the daemon started process
    /// `shell_process_id`; a write of four bytes, which the empty socket takes at once. Fails with
    /// the system's error, `EPIPE` when the mode has already ended.
    pub fn confirm(&mut self, shell_process_id: u32) -> io::Result<()> {
        drop(self.shell_end.take());
        self.daemon_end.write_all(&shell_process_id.to_ne_bytes())
    }

    /// The writer of the shell's launch, on a copy of the daemon's end the runtime watches, so a
    /// launch past the socket's buffer waits for the mode's read without holding a thread. Called
    /// from inside the runtime once the start is confirmed. Fails with the system's error.
    pub fn launch_writer(&mut self) -> io::Result<ShellLaunchWriter> {
        let end = self.daemon_end.try_clone()?;
        end.set_nonblocking(true)?;
        Ok(ShellLaunchWriter(tokio::net::UnixStream::from_std(end)?))
    }
}

/// The daemon's writer of one shell's launch frame, after its start's confirmation.
pub struct ShellLaunchWriter(tokio::net::UnixStream);

impl ShellLaunchWriter {
    /// Writes the launch frame `frame` for the `shell` mode to read. Fails with the system's error,
    /// `EPIPE` when the mode has ended.
    pub async fn write(mut self, frame: &[u8]) -> io::Result<()> {
        self.0.write_all(frame).await
    }
}

/// Reads the daemon's confirmation that this process is the `shell` mode it started, then the
/// shell's launch: the end the variable names is a local socket on which the daemon `daemon_pid`
/// wrote this process's id and the frame. The writer and the id are checked before the frame is
/// read. Closes that end. Fails with `NotFound` when no end is named, `InvalidData` when it is not
/// a socket, the id is not this process's or the frame is malformed, `PermissionDenied` when the
/// system does not vouch for `daemon_pid` as the writer (on macOS also when it is not its own
/// responsible process or ended while it was read; on Linux also when the end came from a
/// listener), `UnexpectedEof` when the other end closed early, and the system's error otherwise.
pub(crate) fn receive_launch(daemon_pid: u32, check: WriterCheck) -> io::Result<ShellLaunch> {
    let descriptor = std::env::var(SHELL_START_CONFIRMATION)
        .map_err(|error| io::Error::new(io::ErrorKind::NotFound, error))?
        .parse::<RawFd>()
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let mut end = UnixStream::from(take_socket(descriptor)?);
    let mut confirmed: ConfirmedId = [0; size_of::<u32>()];
    end.read_exact(&mut confirmed)?;
    // The writer and the id are checked before the frame is read, so an unchecked writer never has
    // its frame's bytes taken in.
    check_confirming_writer(&end, daemon_pid, check)?;
    if u32::from_ne_bytes(confirmed) != std::process::id() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the confirmation names another process",
        ));
    }
    ShellLaunch::read_from(&mut end)
}

/// The open socket `descriptor` names, taken over so it closes with the value. Fails with
/// `InvalidData` for a standard stream's descriptor or one that is not a socket, and with the
/// system's error for one that is not open.
fn take_socket(descriptor: RawFd) -> io::Result<OwnedFd> {
    if descriptor <= libc::STDERR_FILENO {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the confirmation names a standard stream",
        ));
    }
    // SAFETY: `stat` is a C struct of integers, for which all zero bytes are valid.
    let mut status: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `status` is a live, writable `stat` the call fills; a closed descriptor fails.
    if unsafe { libc::fstat(descriptor, &raw mut status) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if status.st_mode & libc::S_IFMT != libc::S_IFSOCK {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "the confirmation's descriptor is not a socket",
        ));
    }
    // SAFETY: the descriptor is open, and nothing else in this process uses it: it was inherited
    // for this read alone.
    Ok(unsafe { OwnedFd::from_raw_fd(descriptor) })
}

/// The size of `T` as a socket call takes it.
pub(crate) fn socklen_of<T>() -> libc::socklen_t {
    libc::socklen_t::try_from(size_of::<T>()).expect("a socket value's size fits a socklen_t")
}
