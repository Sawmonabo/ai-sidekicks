//! A connection to a local socket on macOS and Linux: the `AF_UNIX` socket file at its path, opened
//! by `interprocess`, for the daemon's own socket and a provider's service alike.

use std::io;
use std::path::Path;

use interprocess::local_socket::tokio::Stream;
use interprocess::local_socket::traits::tokio::Stream as _;
use interprocess::local_socket::{GenericFilePath, ToFsName as _};

/// An open `AF_UNIX` stream to a local socket, read and written as tokio's streams are.
pub type UnixDomainStream = Stream;

/// Connects to the `AF_UNIX` socket at `socket_path`. Fails with the system's error: `NotFound` or
/// `ConnectionRefused` when no socket or no listener is there, `PermissionDenied` when the socket
/// may not be opened.
pub async fn connect_unix_domain_socket(socket_path: &Path) -> io::Result<UnixDomainStream> {
    Stream::connect(socket_path.to_fs_name::<GenericFilePath>()?).await
}
