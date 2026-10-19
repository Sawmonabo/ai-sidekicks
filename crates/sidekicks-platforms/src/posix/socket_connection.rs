//! A connection to a local socket on macOS and Linux: the socket file at its path, opened by
//! `interprocess`.

use std::io;
use std::path::Path;

use interprocess::local_socket::tokio::Stream;
use interprocess::local_socket::traits::tokio::Stream as _;
use interprocess::local_socket::{GenericFilePath, ToFsName as _};

/// Connects to the local socket at `socket_path`. Fails with the system's error: `NotFound` or
/// `ConnectionRefused` when no socket or no listener is there, `PermissionDenied` when the socket
/// may not be opened.
pub async fn connect_socket(socket_path: &Path) -> io::Result<Stream> {
    Stream::connect(socket_path.to_fs_name::<GenericFilePath>()?).await
}
