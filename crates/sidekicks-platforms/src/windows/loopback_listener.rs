//! The loopback TCP listener on Windows that keeps its port from one start to the next. Every
//! bind takes its address for itself alone (`SO_EXCLUSIVEADDRUSE`) and none reuses one
//! (`SO_REUSEADDR`), which on Windows lets a later socket bind a port another socket holds.

use std::io::{self, ErrorKind};
use std::net::{Ipv4Addr, SocketAddr};
use std::os::windows::io::AsRawSocket as _;

use tokio::net::{TcpListener, TcpSocket};
use windows_sys::Win32::Networking::WinSock::{
    SO_EXCLUSIVEADDRUSE, SOCKET, SOCKET_ERROR, SOL_SOCKET, WSAEACCES, WSAGetLastError, setsockopt,
};

/// How many connections the listener queues before it accepts them, as Tokio's own bind does.
const LISTEN_BACKLOG: u32 = 1024;

/// A listener on `127.0.0.1:<port>`, `0` for a port the system picks, bound for its address alone.
/// A kept port is first bound alone on the wildcard address and let go, since a bind on loopback
/// alone shares the port of the same user's wildcard holder. The port's own closing connections
/// hold it until they end, so `passes_closing_connections` binds the same way. Runs inside a tokio
/// runtime. Fails with `AddrInUse` where the port is held, and with the bind's error otherwise.
pub fn bind_loopback_listener(
    port: u16,
    _passes_closing_connections: bool,
) -> io::Result<TcpListener> {
    if port != 0 {
        drop(bind_alone((Ipv4Addr::UNSPECIFIED, port).into())?);
    }
    bind_alone((Ipv4Addr::LOCALHOST, port).into())?.listen(LISTEN_BACKLOG)
}

// A socket bound at `address` for that address alone. Another account's holder refuses the bind
// with `WSAEACCES` where the same account's would answer `WSAEADDRINUSE`, so both read as
// `AddrInUse`.
fn bind_alone(address: SocketAddr) -> io::Result<TcpSocket> {
    let socket = TcpSocket::new_v4()?;
    // `SOCKET` is pointer-sized, so on the 64-bit Windows the daemon builds for every handle fits.
    let handle = SOCKET::try_from(socket.as_raw_socket())
        .expect("a socket handle fits in the system's socket type");
    let is_exclusive: i32 = 1;
    // SAFETY: the socket is open for the call, and the option's value is a live `i32` of the size
    // given, which the call only reads.
    let status = unsafe {
        setsockopt(
            handle,
            SOL_SOCKET,
            SO_EXCLUSIVEADDRUSE,
            (&raw const is_exclusive).cast(),
            i32::try_from(size_of::<i32>()).expect("an i32's size fits in an i32"),
        )
    };
    if status == SOCKET_ERROR {
        // SAFETY: the call takes nothing and reads this thread's last socket error.
        return Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() }));
    }
    socket.bind(address).map_err(|error| {
        if error.raw_os_error() == Some(WSAEACCES) {
            io::Error::new(ErrorKind::AddrInUse, error)
        } else {
            error
        }
    })?;
    Ok(socket)
}
