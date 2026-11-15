//! The loopback TCP listener on macOS and Linux that keeps its port from one start to the next.

use std::io;
use std::net::Ipv4Addr;

use tokio::net::{TcpListener, TcpSocket};

/// How many connections the listener queues before it accepts them, as Tokio's own bind does.
const LISTEN_BACKLOG: u32 = 1024;

/// A listener on `127.0.0.1:<port>`, `0` for a port the system picks. Bound without reusing the
/// address, the system refuses the bind wherever any socket holds the port, a wildcard holder
/// among them; with `passes_closing_connections` it reuses the address, which passes the port's
/// own closing connections and on macOS also shares the port of a wildcard holder of the same
/// user, which Linux refuses. The address is reused from the bind on in every case, before
/// `listen`: on Linux the listener's connections, and their closing connections, carry the option,
/// and a later bind that reuses the address passes them only then. Runs inside a tokio runtime.
/// Fails with `AddrInUse` where the port is held, and with the bind's error otherwise.
pub fn bind_loopback_listener(
    port: u16,
    passes_closing_connections: bool,
) -> io::Result<TcpListener> {
    let socket = TcpSocket::new_v4()?;
    socket.set_reuseaddr(passes_closing_connections)?;
    socket.bind((Ipv4Addr::LOCALHOST, port).into())?;
    if !passes_closing_connections {
        socket.set_reuseaddr(true)?;
    }
    socket.listen(LISTEN_BACKLOG)
}
