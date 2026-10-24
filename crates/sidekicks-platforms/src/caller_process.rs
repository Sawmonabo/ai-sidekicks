//! A pinned process's parent and its responsible process: what the daemon reads of the caller of a
//! local connection to tell its own descendants from everyone else's; and the process listening on
//! a Unix-domain socket path, read through a connection to it.

use std::io;
#[cfg(unix)]
use std::path::Path;

use crate::PinnedProcess;
#[cfg(unix)]
use crate::{connect_unix_domain_socket, found_no_listener, read_peer_process};

/// How many times a parent read starts over when the parent it pinned was no longer the process's
/// parent by the time it checked; a process re-parented that often during one read is refused.
#[cfg(unix)]
pub(crate) const PARENT_READ_ATTEMPTS: usize = 16;

/// A pinned process's parent, or why a walk up from it ends there.
#[derive(Clone, Debug)]
pub enum ParentProcess {
    /// The parent, pinned, so a later read names that same process.
    Pinned(PinnedProcess),
    /// The process has no parent the system names: the first process, or one whose parent lies
    /// outside this process's view.
    Root,
    /// The process has ended, so it has no parent to read.
    Ended,
}

/// The process the system holds responsible for a pinned process: on macOS the one it charges with
/// the privacy prompts of everything that process started, inherited by each process started from
/// it unless the start disclaims it.
#[derive(Clone, Debug)]
pub enum ResponsibleProcess {
    /// This process: the pinned process is one it started, or a descendant of one.
    ThisProcess,
    /// The pinned process is responsible for itself.
    Itself,
    /// Another process, pinned.
    Another(PinnedProcess),
    /// The system keeps no responsible process, as every system but macOS.
    Untracked,
    /// The pinned process has ended, so nothing vouches for it.
    Ended,
}

/// The process the system holds responsible for `process`: always
/// [`ResponsibleProcess::Untracked`], since this system keeps none. Never fails.
#[cfg(not(target_os = "macos"))]
pub fn read_responsible_process(_process: &PinnedProcess) -> io::Result<ResponsibleProcess> {
    Ok(ResponsibleProcess::Untracked)
}

/// The process listening on the Unix-domain socket at `socket_path`, pinned: the socket is
/// connected to and asked for its peer, since no system names a listener without a connection.
/// `None` when nothing listens there (no socket, a refused connect) or the listener has ended;
/// fails with the connect's other errors and the peer read's.
#[cfg(unix)]
pub async fn unix_domain_listener_process(socket_path: &Path) -> io::Result<Option<PinnedProcess>> {
    let stream = match connect_unix_domain_socket(socket_path).await {
        Ok(stream) => stream,
        Err(error) if found_no_listener(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    // The read can touch the process table, so it runs on the blocking pool.
    tokio::task::spawn_blocking(move || read_peer_process(&stream))
        .await
        .map_err(io::Error::other)?
}

#[cfg(all(test, unix))]
mod tests {
    use crate::{ExistingSocket, bind_socket_listener, pin_running_process};

    use super::unix_domain_listener_process;

    // Fails when the listener is read as anything but its own pinned identity, such as a compare
    // by process id alone, or when a path with nothing listening on it reads as a listener.
    #[tokio::test]
    async fn the_listener_of_a_socket_path_is_read_as_its_pinned_process() {
        // The socket path must fit the system's bound on socket paths.
        let folder = tempfile::tempdir_in("/tmp").expect("a scratch folder");
        let socket = folder.path().join("listening.sock");
        let _listener =
            bind_socket_listener(&socket, ExistingSocket::Refuse).expect("the listener binds");

        let listener = unix_domain_listener_process(&socket)
            .await
            .expect("the listener reads")
            .expect("a listener answers");
        let nothing = unix_domain_listener_process(&folder.path().join("nothing.sock"))
            .await
            .expect("an empty path reads");

        let own = pin_running_process(std::process::id())
            .expect("this process reads")
            .expect("this process runs")
            .record()
            .expect("this process's record reads")
            .expect("this process has a record");
        assert_eq!(
            listener.record().expect("the listener's record reads"),
            Some(own)
        );
        assert!(nothing.is_none(), "an empty path names a listener");
    }
}
