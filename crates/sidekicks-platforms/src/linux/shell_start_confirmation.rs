//! The Linux side of the daemon's confirmation of a shell's start: the kernel records who made the
//! socket pair, so the `shell` mode starts a shell only when the daemon its argument names, running
//! as this account, made it. The inherited end alone proves nothing on Linux: the daemon reaps the
//! orphans below it, so a mode whose parent ended reads the daemon as its parent.

use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::net::UnixStream;

use nix::unistd::getuid;

use crate::posix::shell_start_confirmation::{WriterCheck, socklen_of};

/// Checks that the process the kernel recorded at the other end of `end` is the daemon
/// `daemon_pid` and runs as this process's account. Fails with `PermissionDenied` when it is
/// another process or account, and with the system's error otherwise.
pub(crate) fn check_confirming_writer(
    end: &UnixStream,
    daemon_pid: u32,
    _check: WriterCheck,
) -> io::Result<()> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = socklen_of::<libc::ucred>();
    // SAFETY: the socket is open, and `credentials` is a live, writable `ucred` of the length
    // given.
    let status = unsafe {
        libc::getsockopt(
            end.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&raw mut credentials).cast(),
            &raw mut length,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    let writer = u32::try_from(credentials.pid).map_err(io::Error::other)?;
    if writer != daemon_pid || credentials.uid != getuid().as_raw() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "process {writer} of account {}, not the daemon {daemon_pid}, wrote the \
                 confirmation",
                credentials.uid
            ),
        ));
    }
    Ok(())
}
