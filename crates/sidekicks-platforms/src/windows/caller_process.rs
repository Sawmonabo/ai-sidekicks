//! Which process is at the other end of a local connection, and a process's parent, on Windows:
//! the peer of an `AF_UNIX` connection is read from the socket, while the daemon's named pipe and a
//! process's parent are not read yet.

use std::io::{self, ErrorKind};
use std::ptr;
use std::sync::Arc;

use interprocess::local_socket::tokio::Stream;
use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
use windows_sys::Win32::Networking::WinSock::{
    SIO_AF_UNIX_GETPEERPID, SOCKET, SOCKET_ERROR, WSAGetLastError, WSAIoctl,
};
use windows_sys::Win32::System::Threading::{
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};

use crate::caller_process::ParentProcess;
use crate::windows::error_codes::win32_code;
use crate::windows::pinned_process::{PinnedProcess, open_process};
use crate::windows::socket::unix_domain::UnixDomainStream;

/// Reads no peer: Windows has no caller check yet. Always fails with `Unsupported`.
pub fn read_peer_process(_stream: &Stream) -> io::Result<Option<PinnedProcess>> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows reads no local connection's peer process yet",
    ))
}

/// The process at the other end of the `AF_UNIX` `stream`, as the socket names it, pinned by an open
/// handle opened after the read, so a peer that ended in between and whose id passed on names the
/// new process. `None` once that process has ended. Fails with the system's error, and with
/// `Other` when the socket names no process.
pub fn unix_domain_peer_process(stream: &UnixDomainStream) -> io::Result<Option<PinnedProcess>> {
    let mut process_id = 0_u32;
    let mut written = 0_u32;
    // `SOCKET` is pointer-sized, so on the 64-bit Windows the daemon builds for every handle fits.
    let socket = SOCKET::try_from(stream.as_raw_socket())
        .expect("a socket handle fits in the system's socket type");
    // SAFETY: the socket is open for the call; the output buffer is a live `u32` of the size
    // given, which the call fills, with no input buffer, no overlapped operation and no
    // completion routine.
    let status = unsafe {
        WSAIoctl(
            socket,
            SIO_AF_UNIX_GETPEERPID,
            ptr::null(),
            0,
            (&raw mut process_id).cast(),
            u32::try_from(size_of::<u32>()).expect("a u32's size fits in a u32"),
            &raw mut written,
            ptr::null_mut(),
            None,
        )
    };
    if status == SOCKET_ERROR {
        // SAFETY: the call takes nothing and reads this thread's last socket error.
        return Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() }));
    }
    if process_id == 0 {
        return Err(io::Error::other("the socket names no peer process"));
    }
    match open_process(
        process_id,
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
    ) {
        Ok(process) => Ok(Some(PinnedProcess {
            id: process_id,
            process: Some(Arc::new(process)),
            job: None,
            job_handle: None,
        })),
        Err(error) if win32_code(&error) == Some(ERROR_INVALID_PARAMETER) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Reads no parent: Windows has no caller check yet. Always fails with `Unsupported`.
pub fn read_parent_process(_process: &PinnedProcess) -> io::Result<ParentProcess> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "Windows reads no process's parent yet",
    ))
}
