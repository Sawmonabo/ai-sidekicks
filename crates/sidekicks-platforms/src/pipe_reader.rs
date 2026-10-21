//! A pipe's read end read without a thread waiting on it where the system allows, so a process
//! that keeps the pipe's write end open costs no thread, and dropping the reader closes the read
//! end, after which that process's next write fails.

use std::io;

use tokio::io::AsyncRead;

/// Turns `reader`, a pipe's read end, into an async reader: on macOS and Linux registered with
/// the runtime, so no thread waits on it; on Windows, where tokio reads no anonymous pipe, read on
/// a blocking thread. Dropping it closes the read end. Must be called within the runtime. Fails
/// with the system's error from the registration.
pub fn async_pipe_reader(
    reader: io::PipeReader,
) -> io::Result<impl AsyncRead + Send + Unpin + 'static> {
    #[cfg(unix)]
    return tokio::net::unix::pipe::Receiver::from_owned_fd(std::os::fd::OwnedFd::from(reader));
    #[cfg(windows)]
    return Ok(tokio::fs::File::from_std(std::fs::File::from(
        std::os::windows::io::OwnedHandle::from(reader),
    )));
}
