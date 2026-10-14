//! Which process is at the other end of a local connection on macOS and Linux, read from the
//! socket's peer credentials.

use std::io;

use interprocess::local_socket::tokio::Stream;

/// The id of the process at the other end of `stream`: on Linux the one that connected (or
/// listened, on a socket the daemon dialed), recorded at the connect and kept after it closes; on
/// macOS the one that last used that end (its effective id, the same unless a privileged process
/// delegated the socket). `None` on macOS once that end has closed; fails with the system's error
/// otherwise.
pub fn read_peer_process_id(stream: &Stream) -> io::Result<Option<u32>> {
    let Stream::UdSocket(socket) = stream;
    match socket.inner().peer_cred() {
        Ok(credentials) => {
            let process_id = credentials
                .pid()
                .ok_or_else(|| io::Error::other("the system named no peer process"))?;
            u32::try_from(process_id)
                .map(Some)
                .map_err(io::Error::other)
        }
        // macOS answers `ENOTCONN` once the other end has closed.
        #[cfg(target_os = "macos")]
        Err(error) if error.kind() == io::ErrorKind::NotConnected => Ok(None),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use interprocess::local_socket::tokio::Stream;
    use interprocess::os::unix::uds_local_socket::tokio::Stream as UnixSocketStream;

    use super::read_peer_process_id;
    use crate::read_parent_process_id;

    #[test]
    fn reads_this_process_as_its_own_peer_until_it_closes_and_its_parent_and_no_parent_for_a_free_id()
     {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .expect("a runtime");
        let _entered = runtime.enter();
        let (near, far) = tokio::net::UnixStream::pair().expect("a connected socket pair");
        let stream = Stream::from(UnixSocketStream::from(near));

        assert_eq!(
            read_peer_process_id(&stream).expect("the peer reads"),
            Some(std::process::id())
        );
        // Once the other end closes, Linux keeps the id recorded at the connect; macOS has none.
        drop(far);
        let peer_after_close = (!cfg!(target_os = "macos")).then(std::process::id);
        assert_eq!(
            read_peer_process_id(&stream).expect("a closed peer reads"),
            peer_after_close
        );
        assert_eq!(
            read_parent_process_id(std::process::id()).expect("the parent reads"),
            Some(std::os::unix::process::parent_id())
        );
        // Past Linux's highest process id and refused by macOS as no process (`ESRCH`).
        assert_eq!(
            read_parent_process_id(i32::MAX.cast_unsigned()).expect("a free id reads"),
            None
        );
    }
}
