//! A local socket listener on macOS and Linux, bound at a path the caller has already checked.

use std::io;
use std::path::Path;

use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName};

/// Binds a listener at `socket_path`, which the caller checked with
/// [`check_socket_path`](crate::check_socket_path). The file is removed when the listener drops.
/// Runs inside a tokio runtime. Fails with `AddrInUse` when a socket file is already there,
/// whether a listener serves it or a stopped one left it, and with the bind's error otherwise.
pub fn bind_socket_listener(socket_path: &Path) -> io::Result<Listener> {
    ListenerOptions::new()
        .name(socket_path.to_fs_name::<GenericFilePath>()?)
        .create_tokio()
}
