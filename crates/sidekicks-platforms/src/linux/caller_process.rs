//! The process at the other end of a local connection on Linux, pinned by a process descriptor the
//! kernel recorded at the connect, and a pinned process's parent, pinned the same way, each read
//! checked against the pinned process's descriptor, so a reused process id is never read.

use std::io::{self, ErrorKind};
use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};
use std::sync::Arc;

use interprocess::local_socket::tokio::Stream;

use crate::caller_process::{PARENT_READ_ATTEMPTS, ParentProcess};
use crate::linux::pinned_process::{PinnedProcess, descriptor_process_id, open_process_descriptor};
use crate::linux::read_process_stat_field;

// The stat file's field holding the parent's id.
const PARENT_FIELD: usize = 4;

/// The process at the other end of `stream`, the one that connected (or listened, on a socket the
/// daemon dialed), pinned by the descriptor the kernel took at the connect. `None` when that
/// process has been reaped; fails with the system's error otherwise, `ENOPROTOOPT` on a kernel
/// before 6.5, which records no descriptor, and `Other` for a process outside this pid namespace.
pub fn read_peer_process(stream: &Stream) -> io::Result<Option<PinnedProcess>> {
    let Stream::UdSocket(socket) = stream;
    let mut descriptor: libc::c_int = -1;
    let mut length = libc::socklen_t::try_from(size_of::<libc::c_int>())
        .expect("an int's size fits in a socklen_t");
    // SAFETY: the socket is open for the call, and the buffer is a live `c_int` of the length
    // given, which the call fills with a new descriptor this process then owns.
    let status = unsafe {
        libc::getsockopt(
            socket.inner().as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERPIDFD,
            (&raw mut descriptor).cast(),
            &raw mut length,
        )
    };
    if status != 0 {
        let error = io::Error::last_os_error();
        // Kernels before 6.16 refuse a peer already reaped with `EINVAL`.
        if error.raw_os_error() == Some(libc::EINVAL) {
            return Ok(None);
        }
        return Err(error);
    }
    // SAFETY: the call succeeded, so `descriptor` is a new open descriptor nothing else owns.
    let descriptor = unsafe { OwnedFd::from_raw_fd(descriptor) };
    let Some(id) = descriptor_process_id(descriptor.as_raw_fd())? else {
        return Ok(None);
    };
    Ok(Some(PinnedProcess {
        id,
        descriptor: Arc::new(descriptor),
    }))
}

/// `process`'s parent, pinned: its id is read, the parent's descriptor opened, then the
/// process's parent read again, and only an unchanged id is taken, since a parent's exit moves its
/// children to another parent before its id can be reused. Fails with the system's error, and with
/// `Other` when the parent kept changing.
pub fn read_parent_process(process: &PinnedProcess) -> io::Result<ParentProcess> {
    for _ in 0..PARENT_READ_ATTEMPTS {
        let Some(parent_id) = read_parent_id(process)? else {
            return Ok(ParentProcess::Ended);
        };
        if parent_id == 0 {
            return Ok(ParentProcess::Root);
        }
        let parent = match open_process_descriptor(parent_id) {
            Ok(parent) => parent,
            // The parent ended between the reads; the process has a new one.
            Err(error) if error.raw_os_error() == Some(libc::ESRCH) => continue,
            Err(error) => return Err(error),
        };
        match read_parent_id(process)? {
            None => return Ok(ParentProcess::Ended),
            Some(again) if again == parent_id => {
                return Ok(ParentProcess::Pinned(PinnedProcess {
                    id: parent_id,
                    descriptor: Arc::new(parent),
                }));
            }
            Some(_) => {}
        }
    }
    Err(io::Error::other(
        "the process's parent kept changing while it was read",
    ))
}

/// `process`'s parent's id from its stat file, `None` once it has been reaped. The read names
/// `process` only if its descriptor still names a live process after it, so that is checked.
fn read_parent_id(process: &PinnedProcess) -> io::Result<Option<u32>> {
    let Some(parent) = read_process_stat_field(process.id, PARENT_FIELD)? else {
        return Ok(None);
    };
    if descriptor_process_id(process.descriptor.as_raw_fd())?.is_none() {
        return Ok(None);
    }
    parent
        .parse()
        .map(Some)
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
}

#[cfg(test)]
mod tests {
    use interprocess::local_socket::tokio::Stream;
    use interprocess::os::unix::uds_local_socket::tokio::Stream as UnixSocketStream;

    use std::sync::Arc;

    use super::{read_parent_process, read_peer_process};
    use crate::caller_process::ParentProcess;
    use crate::linux::pinned_process::{PinnedProcess, open_process_descriptor};

    #[test]
    fn pins_this_process_as_its_own_peer_and_its_parent_until_each_ends() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_io()
            .build()
            .expect("a runtime");
        let _entered = runtime.enter();
        let (near, far) = tokio::net::UnixStream::pair().expect("a connected socket pair");
        let stream = Stream::from(UnixSocketStream::from(near));

        let peer = read_peer_process(&stream)
            .expect("the peer reads")
            .expect("the peer runs");
        assert_eq!(peer.id(), std::process::id());
        // The descriptor recorded at the connect outlives the other end.
        drop(far);
        assert!(
            read_peer_process(&stream)
                .expect("a closed peer reads")
                .is_some()
        );
        match read_parent_process(&peer).expect("the parent reads") {
            ParentProcess::Pinned(parent) => {
                assert_eq!(parent.id(), std::os::unix::process::parent_id());
            }
            other @ (ParentProcess::Root | ParentProcess::Ended) => {
                panic!("expected the parent, got {other:?}")
            }
        }

        // A descriptor whose process was reaped pins nothing, though the id beside it still runs.
        let mut child = std::process::Command::new("/bin/true")
            .spawn()
            .expect("the child starts");
        let descriptor = open_process_descriptor(child.id()).expect("the child's descriptor opens");
        child.wait().expect("the child is reaped");
        let reaped = PinnedProcess {
            id: std::process::id(),
            descriptor: Arc::new(descriptor),
        };
        assert!(matches!(
            read_parent_process(&reaped).expect("a reaped process reads"),
            ParentProcess::Ended
        ));
    }
}
