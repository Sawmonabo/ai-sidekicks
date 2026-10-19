//! The Linux side of the daemon's confirmation of a shell's start: the kernel records who made the
//! socket pair, so the `shell` mode starts a shell only when its end is one of a pair, never a
//! connection to a listener, and the daemon its argument names, running as this account, made it.
//! The inherited end alone proves nothing on Linux: the daemon reaps the orphans below it, so a
//! mode whose parent ended reads the daemon as its parent. A connection to one of the daemon's own
//! listeners carries the daemon's credentials too, which is why its named peer is refused.

use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::net::UnixStream;

use nix::unistd::getuid;

use crate::posix::shell_start_confirmation::{WriterCheck, socklen_of};

/// Checks that `end`'s other end is unnamed, as one of a socket pair is and an accepted
/// connection's never is, and that the process the kernel recorded there is the daemon
/// `daemon_pid` running as this process's account. Fails with `PermissionDenied` when the end came
/// from a listener or another process or account made it, and with the system's error otherwise.
pub(crate) fn check_confirming_writer(
    end: &UnixStream,
    daemon_pid: u32,
    _check: WriterCheck,
) -> io::Result<()> {
    if !is_peer_unnamed(end)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the confirmation came on a connection to a listener, not on a socket pair",
        ));
    }
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

// Whether `end`'s other end has no address: unix(7) answers only the address family for an
// unnamed socket, one a socket pair made, where a listener's accepted end carries its path or
// abstract name.
fn is_peer_unnamed(end: &UnixStream) -> io::Result<bool> {
    // SAFETY: `sockaddr_un` is a C struct of integers and bytes, for which all zero bytes are
    // valid.
    let mut address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    let mut length = socklen_of::<libc::sockaddr_un>();
    // SAFETY: the socket is open, and `address` is a live, writable `sockaddr_un` of the length
    // given, which the call fills and whose filled length it writes back.
    let status =
        unsafe { libc::getpeername(end.as_raw_fd(), (&raw mut address).cast(), &raw mut length) };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(length == socklen_of::<libc::sa_family_t>())
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::{UnixListener, UnixStream};

    use super::check_confirming_writer;
    use crate::posix::shell_start_confirmation::WriterCheck;

    // Fails when the writer check reads only the credentials, which a connection to a listener
    // this process made carries as its own, so the mode would take such an end as the daemon's
    // pair.
    #[test]
    fn a_shell_mode_handed_a_listener_s_connection_refuses_it_and_takes_a_pair() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let listener =
            UnixListener::bind(folder.path().join("listener.sock")).expect("the listener binds");
        let connected = UnixStream::connect(
            listener
                .local_addr()
                .expect("the listener's address reads")
                .as_pathname()
                .expect("the listener has a path"),
        )
        .expect("the connection opens");
        let (pair_end, _other_end) = UnixStream::pair().expect("the pair opens");

        let refused = check_confirming_writer(&connected, std::process::id(), WriterCheck::Daemon);
        let taken = check_confirming_writer(&pair_end, std::process::id(), WriterCheck::Daemon);

        assert_eq!(
            refused
                .expect_err("a listener's connection is refused")
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );
        taken.expect("a pair this process made is taken");
    }
}
