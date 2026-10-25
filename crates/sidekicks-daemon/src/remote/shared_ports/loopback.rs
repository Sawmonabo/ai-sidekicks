//! The one loopback connect every forward to a shared port goes through. It takes a port and
//! nothing else, so no caller can name another host or address, and it reaches only this machine's
//! two loopback addresses, never a name a hosts file could point elsewhere.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use sidekicks_contracts::wire::integer::Port;
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

/// How long both loopback attempts together may take: Linux waits about two minutes on a
/// listener whose backlog is full, macOS refuses at once.
const LOOPBACK_CONNECT_LIMIT: Duration = Duration::from_secs(10);

/// An open connection to a shared port's server, with the signal that fires when the port stops
/// being shared, the person removes it or this machine is removed. Its owner ends the forward when
/// the signal fires, by dropping the stream.
#[derive(Debug)]
pub(crate) struct SharedPortConnection {
    stream: TcpStream,
    closed: CancellationToken,
}

impl SharedPortConnection {
    /// The stream and its close signal, for the forward's owner to pump one and watch the other.
    /// The signal is this connection's own: canceling it ends nothing else on the port.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the port tunnel and the web address's forward pump the stream"
        )
    )]
    pub(crate) fn into_parts(self) -> (TcpStream, CancellationToken) {
        (self.stream, self.closed)
    }
}

/// Why a shared port's connection did not open.
#[derive(Debug, thiserror::Error)]
pub(crate) enum SharedPortConnectError {
    /// The port is not on the shared list, so nothing was dialed.
    #[error("port {} is not shared", port.get())]
    NotShared {
        /// The port asked for.
        port: Port,
    },
    /// Neither loopback address took the connection: nothing listens on the port, or a family is
    /// off.
    #[error("nothing on this machine's loopback took the connection (IPv6: {ipv6}; IPv4: {ipv4})")]
    Unreachable {
        /// Why `[::1]` failed.
        ipv6: io::Error,
        /// Why `127.0.0.1` failed.
        ipv4: io::Error,
    },
    /// The loopback attempts took longer than their limit together.
    #[error("the connection to the shared port took longer than its limit")]
    TimedOut,
}

/// Whether a listener bound to `address` is one the loopback connect reaches: this machine's
/// loopback addresses, every address, or IPv4's loopback as IPv6 writes it. Never the rest of
/// `127.0.0.0/8`, which the connect does not dial.
pub(crate) fn is_reached_by_loopback_connect(address: IpAddr) -> bool {
    const IPV4_LOOPBACK_AS_IPV6: Ipv6Addr = Ipv4Addr::LOCALHOST.to_ipv6_mapped();
    match address {
        IpAddr::V4(address) => address == Ipv4Addr::LOCALHOST || address == Ipv4Addr::UNSPECIFIED,
        IpAddr::V6(address) => {
            address == Ipv6Addr::LOCALHOST
                || address == Ipv6Addr::UNSPECIFIED
                || address == IPV4_LOOPBACK_AS_IPV6
        }
    }
}

/// Connects to `port` on `[::1]`, then on `127.0.0.1` after any failure there, one after the other
/// within one limit, with no-delay set on the stream that opens, and hands it over with `closed`.
/// A dev server binds `localhost`, which lists `::1` first on macOS and Linux, and a refused
/// family answers in under a millisecond, so racing the two buys nothing. The one case it loses:
/// on Linux a `[::1]` listener whose backlog is full holds the whole limit, so a second server on
/// the same port on `127.0.0.1` alone is never tried. Fails with `Unreachable` or `TimedOut`.
pub(super) async fn connect_loopback(
    port: Port,
    closed: CancellationToken,
) -> Result<SharedPortConnection, SharedPortConnectError> {
    let attempts = async {
        let ipv6 = match connect_without_delay(Ipv6Addr::LOCALHOST.into(), port).await {
            Ok(stream) => return Ok(stream),
            Err(error) => error,
        };
        connect_without_delay(Ipv4Addr::LOCALHOST.into(), port)
            .await
            .map_err(|ipv4| SharedPortConnectError::Unreachable { ipv6, ipv4 })
    };
    let stream = tokio::time::timeout(LOOPBACK_CONNECT_LIMIT, attempts)
        .await
        .map_err(|_elapsed| SharedPortConnectError::TimedOut)??;
    Ok(SharedPortConnection { stream, closed })
}

// A forward relays a person's keystrokes and a dev server's small frames, which Nagle's delay
// would hold back.
async fn connect_without_delay(address: IpAddr, port: Port) -> io::Result<TcpStream> {
    let stream = TcpStream::connect(SocketAddr::new(address, port.get())).await?;
    stream.set_nodelay(true)?;
    Ok(stream)
}
