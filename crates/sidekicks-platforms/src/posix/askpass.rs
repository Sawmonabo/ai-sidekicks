//! The askpass program's listener on macOS and Linux: a local socket in the run folder, which the
//! caller made private, at a fixed name.

use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use interprocess::local_socket::tokio::Listener;

use crate::posix::socket::listener::bind_socket_listener;
use crate::posix::socket::path::check_socket_path;
use crate::run_folder::askpass_socket_path;
use crate::socket::listener::ExistingSocket;

/// Binds the askpass program's listener at [`askpass_socket_path`] in `folder` and returns it with
/// the socket's path, which git's askpass program is given. Runs inside a tokio runtime. Fails
/// with `InvalidInput`, holding the [`SocketPathRefused`](crate::SocketPathRefused), when the path
/// cannot name a socket, with `AddrInUse` when a socket file is already there, and with the bind's
/// error otherwise.
pub fn askpass_listener(folder: &Path) -> io::Result<(Listener, PathBuf)> {
    let socket_path = askpass_socket_path(folder);
    check_socket_path(&socket_path)
        .map_err(|refusal| io::Error::new(ErrorKind::InvalidInput, refusal))?;
    // One run folder can serve two data folders (one runtime folder per account on Linux), so a
    // file already there may be another daemon's; the start removed one nobody answers on.
    let listener = bind_socket_listener(&socket_path, ExistingSocket::Refuse)?;
    Ok((listener, socket_path))
}
