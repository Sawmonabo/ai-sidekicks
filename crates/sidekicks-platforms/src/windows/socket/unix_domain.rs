//! A connection to an `AF_UNIX` socket on Windows, the kind a provider's own service listens on:
//! `uds_windows`' blocking connect run on the blocking pool, then the socket driven by `async-io`
//! and handed to tokio through `tokio_util`'s compatibility layer.

use std::io::{self, Read, Write};
use std::os::windows::io::{AsRawSocket as _, AsSocket, BorrowedSocket, RawSocket};
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};

use async_io::{Async, IoSafe};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt as _};

/// An open `AF_UNIX` stream to a local socket, read and written as tokio's streams are.
#[derive(Debug)]
pub struct UnixDomainStream(Compat<Async<AfUnixSocket>>);

impl UnixDomainStream {
    /// The socket's raw handle, for a system call that reads the socket itself.
    pub(crate) fn as_raw_socket(&self) -> RawSocket {
        self.0.get_ref().get_ref().0.as_raw_socket()
    }
}

/// Connects to the `AF_UNIX` socket at `socket_path`. Fails with the system's error: `NotFound` or
/// `ConnectionRefused` when no socket or no listener is there, `PermissionDenied` when the socket
/// may not be opened.
pub async fn connect_unix_domain_socket(socket_path: &Path) -> io::Result<UnixDomainStream> {
    let socket_path = socket_path.to_path_buf();
    let socket = tokio::task::spawn_blocking(move || uds_windows::UnixStream::connect(socket_path))
        .await
        .map_err(io::Error::other)??;
    Ok(UnixDomainStream(Async::new(AfUnixSocket(socket))?.compat()))
}

impl AsyncRead for UnixDomainStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(context, buffer)
    }
}

impl AsyncWrite for UnixDomainStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(context, buffer)
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(context)
    }
}

/// The connected socket `async-io` drives: `uds_windows`' stream, which reads and writes the
/// socket and nothing else.
#[derive(Debug)]
struct AfUnixSocket(uds_windows::UnixStream);

impl AsSocket for AfUnixSocket {
    fn as_socket(&self) -> BorrowedSocket<'_> {
        self.0.as_socket()
    }
}

impl Read for AfUnixSocket {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.read(buffer)
    }
}

impl Write for AfUnixSocket {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

// SAFETY: its reads and writes only read and write the socket; none of them closes, replaces or
// moves the socket `async-io` registered, which is what `IoSafe` asks.
unsafe impl IoSafe for AfUnixSocket {}
