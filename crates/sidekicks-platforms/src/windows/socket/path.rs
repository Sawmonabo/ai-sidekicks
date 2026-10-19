//! A local socket's path checked against `SOCKADDR_UN`'s `sun_path` on Windows, and what stands
//! there read, before a bind.

use std::io;
use std::path::Path;

use windows_sys::Win32::Networking::WinSock::SOCKADDR_UN;

use crate::socket::path::{SocketPathEntry, SocketPathRefused};

// The longest path a socket address holds: `sun_path`'s 108 bytes less the NUL that ends it; the
// struct is not padded, so `sun_path` runs from its offset to the end.
const SOCKET_PATH_LIMIT: usize =
    size_of::<SOCKADDR_UN>() - std::mem::offset_of!(SOCKADDR_UN, sun_path) - 1;

/// Checks that `path` names a local socket: UTF-8, as the socket address takes it, no longer than
/// 107 bytes and with no NUL. Fails with [`SocketPathRefused::TooLong`] for a longer path, measured
/// first, and with [`SocketPathRefused::Invalid`] for any other refusal.
pub fn check_socket_path(path: &Path) -> Result<(), SocketPathRefused> {
    if let Some(text) = path.to_str()
        && text.len() > SOCKET_PATH_LIMIT
    {
        return Err(SocketPathRefused::TooLong {
            limit: SOCKET_PATH_LIMIT,
            observed: text.len(),
        });
    }
    uds_windows::from_path(path).map_err(SocketPathRefused::Invalid)?;
    Ok(())
}

/// What stands at the daemon's socket path: always [`SocketPathEntry::Socket`], since the path
/// names a pipe, which holds no file, so the connect alone tells a served name from a free one.
/// Never fails.
pub fn read_socket_path_entry(_path: &Path) -> io::Result<SocketPathEntry> {
    Ok(SocketPathEntry::Socket)
}
