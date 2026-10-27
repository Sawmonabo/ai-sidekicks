//! The local socket's server: the listener, which reads each connection's caller as it is accepted
//! and serves the connection with the services every call goes through, the hooks that watch the
//! listener and each connection, and the stop, which closes the listener first and then lets each
//! connection send what it holds for at most [`CONNECTION_CLOSE_WAIT`].

use std::error::Error;
use std::io;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use interprocess::local_socket::tokio::{Listener, Stream};
use interprocess::local_socket::traits::tokio::Listener as _;
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_ipc::caller_process::contract::CallerProcessReader;
use sidekicks_ipc::protocol_negotiation::ProtocolNegotiator;
use sidekicks_ipc::registry::{Dispatch, MethodRegistry, TransportId};
use sidekicks_ipc::stream::subscriptions::Subscriptions;
use sidekicks_platforms::{PinnedProcess, bind_socket_listener};
use tokio::task::{JoinError, JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use self::writer::Outbox;
use crate::bootstrap::secure_defaults::SecureDefaults;

mod connection;
#[cfg(test)]
mod tests;
mod writer;

/// How long a closing connection may send what lane 0 already holds, a stop's own reply among
/// them, before it is cut. A local socket takes a reply at once; only a client that stopped
/// reading holds a connection this long.
pub(crate) const CONNECTION_CLOSE_WAIT: Duration = Duration::from_millis(500);

/// How long the listener waits after an accept fails for a reason other than the one connection,
/// such as the process's open files running out, so a failing accept does not spin.
const ACCEPT_RETRY_WAIT: Duration = Duration::from_secs(1);

/// The next connection's id; ids are never reused while the daemon runs.
static NEXT_TRANSPORT_ID: AtomicU64 = AtomicU64::new(1);

/// Why a connection ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SupervisionDisconnectReason {
    /// The client closed its end.
    ClientClose,
    /// The daemon closed it: the stop, or a message of its own it could not write.
    ServerClose,
    /// Reading or writing the stream failed; `on_error` reported the failure first.
    TransportError,
    /// The client sent a message past its cap, answered `connection.message.tooLarge`.
    OversizedBody,
    /// The client broke the framing any other way.
    MalformedFrame,
}

/// Watches the listener and each connection. Every connection ends with exactly one
/// `on_disconnect`, and no `on_error` for that connection follows it.
pub(crate) trait SupervisionHooks: Send + Sync {
    /// The connection `transport` ended for `reason`.
    fn on_disconnect(&self, transport: TransportId, reason: SupervisionDisconnectReason);

    /// The connection `transport` failed: its caller could not be read, or its stream faulted.
    fn on_error(&self, transport: TransportId, error: &(dyn Error + 'static));

    /// The listener failed to accept a connection.
    fn on_listener_error(&self, error: &(dyn Error + 'static));
}

/// What every connection serves its calls through.
pub(crate) struct GatewayServices {
    /// The device every connection on this socket comes from; `None` while the service repairs its
    /// database file, which holds the device's row.
    pub(crate) device_id: Option<DeviceId>,
    /// The whole dispatch chain, its gates included.
    pub(crate) dispatch: Arc<dyn Dispatch>,
    /// The frozen registry, which says which methods subscribe.
    pub(crate) registry: Arc<MethodRegistry>,
    /// The handshake state, dropped per connection as it closes.
    pub(crate) negotiator: Arc<ProtocolNegotiator>,
    /// The open subscriptions, ended per connection as it closes.
    pub(crate) subscriptions: Arc<Subscriptions>,
    /// The listener's and the connections' observers.
    pub(crate) hooks: Arc<dyn SupervisionHooks>,
}

/// The local socket's listener, serving each connection on its own task until the stop.
pub(crate) struct LocalGateway {
    stop: CancellationToken,
    accepting: JoinHandle<()>,
}

impl LocalGateway {
    /// Binds the socket at the path `secure_defaults` checked, never replacing a socket file
    /// already there, and starts accepting. Fails with `AddrInUse` when a daemon listens there or
    /// a stopped one left its file, and with the bind's error otherwise.
    pub(crate) fn start(
        services: GatewayServices,
        caller_process_reader: Arc<dyn CallerProcessReader>,
        secure_defaults: &SecureDefaults,
    ) -> io::Result<Self> {
        let listener = bind_socket_listener(secure_defaults.local_ipc_path())?;
        let stop = CancellationToken::new();
        let accepting = tokio::spawn(accept_connections(
            listener,
            Arc::new(services),
            caller_process_reader,
            stop.clone(),
        ));
        Ok(Self { stop, accepting })
    }

    /// Closes the listener, then each connection, each of which sends what lane 0 holds within
    /// [`CONNECTION_CLOSE_WAIT`] and reports `ServerClose`; resolves once every connection ended.
    pub(crate) async fn stop(self) {
        self.stop.cancel();
        if let Err(error) = self.accepting.await {
            report_task_end(&error);
        }
    }
}

/// Reads the caller at the other end of `stream`. A caller nobody can name is refused at its
/// handshake, and only a failed read is logged and reported; `None` when the read could not run,
/// which loses the connection and reports its one disconnect.
async fn read_caller(
    reader: Arc<dyn CallerProcessReader>,
    stream: Stream,
    transport: TransportId,
    services: &GatewayServices,
) -> Option<(Stream, Option<PinnedProcess>)> {
    let report = |error: &io::Error| {
        tracing::warn!(
            transport = transport.0,
            error = error as &(dyn Error + 'static),
            "The caller of a local connection could not be read"
        );
        services.hooks.on_error(transport, error);
    };
    match reader.read_peer_process(stream).await {
        Ok((stream, Ok(caller_process))) => Some((stream, caller_process)),
        Ok((stream, Err(error))) => {
            report(&error);
            Some((stream, None))
        }
        Err(error) => {
            report(&error);
            services
                .hooks
                .on_disconnect(transport, SupervisionDisconnectReason::TransportError);
            None
        }
    }
}

/// Accepts connections until the stop, then closes the listener before it closes them.
async fn accept_connections(
    listener: Listener,
    services: Arc<GatewayServices>,
    caller_process_reader: Arc<dyn CallerProcessReader>,
    stop: CancellationToken,
) {
    let connections_stop = CancellationToken::new();
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            biased;
            () = stop.cancelled() => break,
            Some(joined) = connections.join_next() => {
                if let Err(error) = joined {
                    report_task_end(&error);
                }
            }
            accepted = listener.accept() => match accepted {
                Ok(stream) => {
                    let transport = next_transport_id();
                    let reader = Arc::clone(&caller_process_reader);
                    let services = Arc::clone(&services);
                    let stop = connections_stop.clone();
                    connections.spawn(async move {
                        let Some((stream, caller_process)) =
                            read_caller(reader, stream, transport, &services).await
                        else {
                            return;
                        };
                        connection::serve_connection(
                            stream,
                            Outbox::new(),
                            transport,
                            caller_process,
                            services,
                            stop,
                        )
                        .await;
                    });
                }
                Err(error) => {
                    tracing::error!(
                        error = &error as &(dyn Error + 'static),
                        "The local socket failed to accept a connection"
                    );
                    services.hooks.on_listener_error(&error);
                    if !is_connection_error(&error) {
                        tokio::select! {
                            () = stop.cancelled() => break,
                            () = tokio::time::sleep(ACCEPT_RETRY_WAIT) => {}
                        }
                    }
                }
            },
        }
    }
    drop(listener);
    connections_stop.cancel();
    while let Some(joined) = connections.join_next().await {
        if let Err(error) = joined {
            report_task_end(&error);
        }
    }
}

/// A new connection's id.
fn next_transport_id() -> TransportId {
    TransportId(NEXT_TRANSPORT_ID.fetch_add(1, Ordering::Relaxed))
}

/// Whether an accept failed for its one connection only, so the next accept goes ahead at once.
fn is_connection_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::ConnectionReset
    )
}

fn report_task_end(error: &JoinError) {
    tracing::error!(
        error = error as &(dyn Error + 'static),
        "A task of the local socket ended without finishing"
    );
}
