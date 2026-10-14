//! The askpass program's listener on macOS and Linux: a local socket in the folder the caller made
//! private, at a fixed name.

use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};

use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::{GenericFilePath, ListenerOptions, ToFsName};

use crate::posix::socket_path::check_socket_path;

// The socket's name in the folder.
const SOCKET_NAME: &str = "askpass.sock";

/// Binds the askpass program's listener at `askpass.sock` in `folder`, replacing a socket file a
/// stopped daemon left there, and returns it with the socket's path, which git's askpass program is
/// given. Runs inside a tokio runtime. Fails with `InvalidInput`, holding the
/// [`SocketPathRefused`](crate::SocketPathRefused), when the path cannot name a socket, and with
/// the bind's error otherwise.
pub fn askpass_listener(folder: &Path) -> io::Result<(Listener, PathBuf)> {
    let socket_path = folder.join(SOCKET_NAME);
    check_socket_path(&socket_path)
        .map_err(|refusal| io::Error::new(ErrorKind::InvalidInput, refusal))?;
    // The data folder's hold makes this daemon the only one, so a socket file already there is a
    // stopped daemon's and is replaced.
    let listener = ListenerOptions::new()
        .name(socket_path.as_path().to_fs_name::<GenericFilePath>()?)
        .try_overwrite(true)
        .create_tokio()?;
    Ok((listener, socket_path))
}
