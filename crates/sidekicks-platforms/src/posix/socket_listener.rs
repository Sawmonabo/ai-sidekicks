//! A local socket listener on macOS and Linux, bound at a path the caller has already checked.

use std::io;
use std::path::Path;

use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName};

use crate::socket_listener::ExistingSocket;

/// Binds a listener at `socket_path`, which the caller checked with
/// [`check_socket_path`](crate::check_socket_path); `existing` says what happens to a socket file
/// already there. The file is removed when the listener drops. Runs inside a tokio runtime. Fails
/// with `AddrInUse` for a file `existing` keeps, and with the bind's error otherwise.
pub fn bind_socket_listener(socket_path: &Path, existing: ExistingSocket) -> io::Result<Listener> {
    ListenerOptions::new()
        .name(socket_path.to_fs_name::<GenericFilePath>()?)
        .try_overwrite(existing == ExistingSocket::Replace)
        .create_tokio()
}
