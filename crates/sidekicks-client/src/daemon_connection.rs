//! A connection to the daemon, opened the one way every client opens it: open a stream to it,
//! checked as the daemon's own before any byte is written, read the session token the daemon wrote
//! at its current start, then `connection.initialize` with that token before any other call,
//! answered within [`HANDSHAKE_DEADLINE`]. The token is read at every connect, because each daemon
//! start writes a new one, and once more when the daemon refuses it. A supervisor then watches the
//! link: after 5 s with no frame it sends `daemon.ping` and reports the link quiet, and after 20 s
//! with no frame it counts the link lost. A lost link is opened again on the client's own schedule,
//! [`LINK_REOPEN_BACKOFF_MS`], for [`LINK_REOPEN_WINDOW`], calls made meanwhile held for it; once
//! the window has passed with every attempt failed the connection is down, every call settles
//! `connection.unavailable` at once, and only `retry` starts the schedule again. A daemon repairing
//! its database file refuses the handshake as `daemon.repairing`; the repairing form of the connect
//! keeps that link, which serves the lifecycle verbs, so the repair can be stopped or restarted.

pub mod handshake_wait;

use std::future::Future;
use std::io;
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::daemon::lifecycle::{
    DaemonLifecycleAccepted, DaemonPing, DaemonRestart, DaemonStop,
};
use sidekicks_contracts::daemon::recovery::DaemonRepairingDetails;
use sidekicks_contracts::jsonrpc::message::ConnectionUnavailableReason;
use sidekicks_contracts::jsonrpc::negotiation::{
    CURRENT_PROTOCOL_VERSION, ConnectionInitializeRequest, ConnectionInitializeResponse,
    NegotiationText, ProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_platforms::{DaemonRunFolder, check_private_run_folder, daemon_run_folder};
use subtle::ConstantTimeEq as _;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep_until, timeout};

use crate::error::{ClientError, LinkFault};
use crate::transport::json_rpc::{HandshakeAnswer, JsonRpcClient};
use crate::transport::link::Link;
use crate::transport::local_socket::{LocalSocketStream, connect_local_socket};

/// The client's own schedule for a lost link: the wait before each attempt to open it again, in
/// milliseconds, the last one repeated between attempts until [`LINK_REOPEN_WINDOW`] has passed.
pub const LINK_REOPEN_BACKOFF_MS: [u64; 5] = [100, 300, 1_000, 3_000, 10_000];

/// How long after a loss, or after a `retry`, the client keeps opening the link again: an attempt
/// starts only within it, and the connection is down once it has passed with every attempt failed.
pub const LINK_REOPEN_WINDOW: Duration = Duration::from_secs(120);

/// How long a connect waits for the daemon's answer to `connection.initialize`; a daemon that
/// accepts the stream and never answers fails the attempt as `connection.unavailable`.
pub const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);

/// How long the link may carry no frame before the supervisor sends `daemon.ping`.
const QUIET_AFTER: Duration = Duration::from_secs(5);

/// How long the link may carry no frame before it counts as lost.
const LOST_AFTER: Duration = Duration::from_secs(20);

/// Where the daemon on this machine is reached: its run folder, which holds its token file, and its
/// socket.
#[derive(Clone, Debug)]
pub struct DaemonEndpoint {
    run_folder: DaemonRunFolder,
}

impl DaemonEndpoint {
    /// The endpoint in `run_folder`.
    pub fn new(run_folder: DaemonRunFolder) -> Self {
        Self { run_folder }
    }

    /// The endpoint of the daemon this account runs on this machine. Fails with the system's error
    /// when the run folder cannot be resolved: on Windows, when the account's local application
    /// data folder or its id cannot be read.
    pub fn this_machine() -> io::Result<Self> {
        daemon_run_folder().map(Self::new)
    }
}

/// How a client reaches the daemon: a stream to it, checked as the daemon's own before any byte is
/// written, and the session token the daemon wrote at its current start.
pub trait DaemonConnector: Send + Sync + 'static {
    /// The stream a connection runs over.
    type Stream: AsyncRead + AsyncWrite + Send + 'static;

    /// Opens a stream to the daemon. Fails with `ClientError::Unavailable` when nothing answers,
    /// and `RunFolder` when the stream reaches no daemon of this account's alone.
    fn open_stream(&self) -> impl Future<Output = Result<Self::Stream, ClientError>> + Send;

    /// Reads the session token the daemon wrote at its current start. Fails with
    /// `ClientError::Token` when it cannot be read.
    fn read_token(&self) -> impl Future<Output = Result<NegotiationText, ClientError>> + Send;
}

/// The daemon on this machine through its run folder: its socket, and its token file. Connecting
/// first makes a daemon that is not running read as `Unavailable` rather than a missing folder or
/// token file.
impl DaemonConnector for DaemonEndpoint {
    type Stream = LocalSocketStream;

    async fn open_stream(&self) -> Result<LocalSocketStream, ClientError> {
        let stream = connect_local_socket(&self.run_folder.socket_path).await?;
        // A folder another account made or can write could hold a token of its own, and on macOS
        // and Linux a socket of its own, which would then prove nothing.
        check_private_run_folder(&self.run_folder.folder_path)?;
        Ok(stream)
    }

    /// Reads the token file; a file whose text is no token is refused as invalid data.
    async fn read_token(&self) -> Result<NegotiationText, ClientError> {
        let path = &self.run_folder.token_path;
        let token_error = |source: io::Error| ClientError::Token {
            path: path.clone(),
            source,
        };
        let text = tokio::fs::read_to_string(path).await.map_err(token_error)?;
        NegotiationText::new(text).ok_or_else(|| {
            token_error(io::Error::new(
                io::ErrorKind::InvalidData,
                "the token file holds no session token",
            ))
        })
    }
}

/// How the connection to the daemon stands, as the supervisor reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionState {
    /// The link is open and frames arrive.
    Open,
    /// The link is open but no frame came for a while; a `daemon.ping` is out.
    Quiet,
    /// The link was lost and is being opened again on the schedule, for the whole reopen window;
    /// calls are held for it.
    Reconnecting,
    /// The reopen window passed with every attempt failed; calls settle `connection.unavailable`
    /// at once until `retry`.
    Down,
}

/// An open daemon connection: the client past its handshake, the daemon's answer to the
/// handshake, and the supervisor that watches the link and opens it again.
pub struct DaemonConnection {
    client: JsonRpcClient,
    initialize_response: ConnectionInitializeResponse,
    state: Arc<watch::Sender<ConnectionState>>,
    retry: Arc<Notify>,
    supervisor: JoinHandle<()>,
}

impl DaemonConnection {
    /// Connects to the daemon through `connector` and completes `connection.initialize`. Fails
    /// as the connector does, with `ClientError::Unavailable` when the handshake passes
    /// [`HANDSHAKE_DEADLINE`], and with `Remote` and `auth.token.invalid` when the daemon refuses
    /// the token and the connector still reads the one presented.
    pub async fn connect<C: DaemonConnector>(connector: C) -> Result<Self, ClientError> {
        let client = JsonRpcClient::new();
        let (initialize_response, link) = open_link(&client, &connector).await?;
        Ok(Self::supervised(
            client,
            connector,
            initialize_response,
            link,
        ))
    }

    /// `connect`, except that a daemon repairing its database file answers the link it refused
    /// beside the refusal's details rather than failing, so the repair can be stopped or restarted
    /// on it. Fails as `connect` does on every other failure.
    pub async fn connect_or_repairing<C: DaemonConnector>(
        connector: C,
    ) -> Result<OpenedConnection, ClientError> {
        let client = JsonRpcClient::new();
        match open_link_answering_repair(&client, &connector).await? {
            (HandshakeAnswer::Initialized(initialize_response), link) => {
                Ok(OpenedConnection::Open(Self::supervised(
                    client,
                    connector,
                    initialize_response,
                    link,
                )))
            }
            (HandshakeAnswer::Repairing(refusal), link) => {
                // A fresh client holds no call, so installing the link sends nothing on it.
                client.install(&link)?;
                Ok(OpenedConnection::Repairing(RepairingConnection {
                    details: refusal.read_repairing_details(),
                    client,
                }))
            }
        }
    }

    /// The connection over `link`, just opened on `client`, with its supervisor started.
    fn supervised<C: DaemonConnector>(
        client: JsonRpcClient,
        connector: C,
        initialize_response: ConnectionInitializeResponse,
        link: Link,
    ) -> Self {
        let state = Arc::new(watch::Sender::new(ConnectionState::Open));
        let retry = Arc::new(Notify::new());
        let supervisor = tokio::spawn(supervise(
            client.clone(),
            connector,
            link,
            Arc::clone(&state),
            Arc::clone(&retry),
        ));
        Self {
            client,
            initialize_response,
            state,
            retry,
            supervisor,
        }
    }

    /// The client every call and subscription goes through.
    pub fn client(&self) -> &JsonRpcClient {
        &self.client
    }

    /// The daemon's answer to the first handshake. When `compatible` is false the daemon refuses
    /// every mutating call and read calls still work.
    pub fn initialize_response(&self) -> &ConnectionInitializeResponse {
        &self.initialize_response
    }

    /// How the connection stands now.
    pub fn state(&self) -> ConnectionState {
        *self.state.borrow()
    }

    /// The connection's state as it changes.
    pub fn state_changes(&self) -> watch::Receiver<ConnectionState> {
        self.state.subscribe()
    }

    /// Starts the reconnect schedule again from its first wait once the connection is down,
    /// holding calls for it again; does nothing in any other state, so a second press while the
    /// schedule runs starts nothing more.
    pub fn retry(&self) {
        let is_restarted = self.state.send_if_modified(|state| {
            if *state != ConnectionState::Down {
                return false;
            }
            *state = ConnectionState::Reconnecting;
            self.client.hold_calls();
            true
        });
        if is_restarted {
            self.retry.notify_one();
        }
    }

    /// Stops the supervisor, waiting until it has stopped so no reopen lands after, then closes
    /// the link; every call still waiting settles `ClientError::Unavailable`.
    pub async fn close(mut self) {
        self.supervisor.abort();
        match (&mut self.supervisor).await {
            Err(error) if error.is_panic() => tracing::error!(
                error = &error as &(dyn std::error::Error + 'static),
                "The connection's supervisor failed"
            ),
            Ok(()) | Err(_) => {}
        }
        self.client.close().await;
    }
}

impl Drop for DaemonConnection {
    fn drop(&mut self) {
        self.supervisor.abort();
    }
}

/// What the repairing form of the connect opened.
pub enum OpenedConnection {
    /// The daemon answered the handshake: an open connection, as `connect` answers it.
    Open(DaemonConnection),
    /// The daemon is repairing its database file.
    Repairing(RepairingConnection),
}

/// A link to a daemon repairing its database file, which serves only the lifecycle verbs on it;
/// dropped, it closes the link. It is never opened again.
pub struct RepairingConnection {
    details: DaemonRepairingDetails,
    client: JsonRpcClient,
}

impl RepairingConnection {
    /// The repair's progress, as the refusal carried it.
    pub fn details(&self) -> DaemonRepairingDetails {
        self.details
    }

    /// Sends `daemon.stop`, which ends the repair and the daemon, then closes the link. Fails with
    /// the link's fault where it ended before the answer.
    pub async fn stop(self) -> Result<(), ClientError> {
        self.send::<DaemonStop>().await
    }

    /// Sends `daemon.restart`, which ends the repair and the daemon as a stop does, then closes
    /// the link. Fails with the link's fault where it ended before the answer.
    pub async fn restart(self) -> Result<(), ClientError> {
        self.send::<DaemonRestart>().await
    }

    async fn send<M>(self) -> Result<(), ClientError>
    where
        M: Method<Params = EmptyPayload, Result = DaemonLifecycleAccepted> + 'static,
    {
        let answer = self.client.call::<M>(&EmptyPayload {}).await;
        self.client.close().await;
        answer.map(|DaemonLifecycleAccepted { accepted: _ }| ())
    }
}

/// Watches each link until it ends, then opens it again on the schedule; once the reopen window
/// passed it takes the client down and waits for a `retry`, which holds calls again and starts the
/// schedule again.
async fn supervise<C: DaemonConnector>(
    client: JsonRpcClient,
    connector: C,
    first_link: Link,
    state: Arc<watch::Sender<ConnectionState>>,
    retry: Arc<Notify>,
) {
    let mut link = first_link;
    loop {
        let fault = watch_link(&client, &link, &state).await;
        state.send_replace(ConnectionState::Reconnecting);
        link = loop {
            if let Some(reopened) = reopen_on_schedule(&client, &connector).await {
                break reopened;
            }
            client.abandon(fault.clone());
            state.send_replace(ConnectionState::Down);
            retry.notified().await;
        };
        state.send_replace(ConnectionState::Open);
    }
}

/// Tries to open the link after each wait of [`LINK_REOPEN_BACKOFF_MS`], then after its last wait
/// again and again, while the attempt starts within [`LINK_REOPEN_WINDOW`]; answers the first link
/// that opens, or `None` once the window has passed with every attempt failed.
async fn reopen_on_schedule<C: DaemonConnector>(
    client: &JsonRpcClient,
    connector: &C,
) -> Option<Link> {
    let gives_up_at = Instant::now() + LINK_REOPEN_WINDOW;
    let mut waits = LINK_REOPEN_BACKOFF_MS.iter().copied();
    let last_wait = LINK_REOPEN_BACKOFF_MS[LINK_REOPEN_BACKOFF_MS.len() - 1];
    loop {
        let wait = waits.next().unwrap_or(last_wait);
        let attempt_at = Instant::now() + Duration::from_millis(wait);
        if attempt_at >= gives_up_at {
            sleep_until(gives_up_at).await;
            return None;
        }
        sleep_until(attempt_at).await;
        match open_link(client, connector).await {
            Ok((_initialize_response, link)) => return Some(link),
            Err(error) => tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "The connection to the background service could not be opened again"
            ),
        }
    }
}

/// Watches one link until it ends, answering why: after [`QUIET_AFTER`] with no frame it reports
/// the link quiet and sends `daemon.ping`, which takes no call slot; a frame, the ping's answer or
/// the daemon's refusal of it reports it open again, and once [`LOST_AFTER`] has passed with no
/// frame it closes the link as silent.
async fn watch_link(
    client: &JsonRpcClient,
    link: &Link,
    state: &watch::Sender<ConnectionState>,
) -> LinkFault {
    loop {
        tokio::select! {
            fault = link.ended() => return fault,
            () = sleep_until(link.last_frame_at() + QUIET_AFTER) => {}
        }
        // A frame that came while the timer ran moves the deadline on, and shows the link live.
        if Instant::now() < link.last_frame_at() + QUIET_AFTER {
            state.send_if_modified(|current| {
                let is_changed = *current != ConnectionState::Open;
                *current = ConnectionState::Open;
                is_changed
            });
            continue;
        }
        state.send_replace(ConnectionState::Quiet);
        let ping = pin!(client.call::<DaemonPing>(&EmptyPayload {}));
        tokio::select! {
            fault = link.ended() => return fault,
            answer = ping => {
                match answer {
                    // A refusal is the daemon's own frame, so the link is live too.
                    Ok(EmptyPayload {}) | Err(ClientError::Remote(_)) => {
                        state.send_replace(ConnectionState::Open);
                    }
                    // The link's end, which the next round reads, is the failure that counts.
                    Err(error) => tracing::debug!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "The link watch's ping failed"
                    ),
                }
            }
            () = sleep_until(link.last_frame_at() + LOST_AFTER) => {
                if Instant::now() >= link.last_frame_at() + LOST_AFTER {
                    link.close(LinkFault::Silent);
                    return LinkFault::Silent;
                }
                // A frame came while the timer ran: the link is live, and watched afresh.
                state.send_replace(ConnectionState::Open);
            }
        }
    }
}

/// Opens one link the client takes; a daemon repairing its database file fails it as
/// `ClientError::Remote` with the `daemon.repairing` refusal, its link closed.
async fn open_link<C: DaemonConnector>(
    client: &JsonRpcClient,
    connector: &C,
) -> Result<(ConnectionInitializeResponse, Link), ClientError> {
    match open_link_answering_repair(client, connector).await? {
        (HandshakeAnswer::Initialized(initialize_response), link) => {
            Ok((initialize_response, link))
        }
        (HandshakeAnswer::Repairing(refusal), link) => {
            link.close(LinkFault::Closed);
            Err(ClientError::Remote(refusal))
        }
    }
}

/// Opens one link, answering a repairing daemon's refusal with the link it refused, not yet the
/// client's: a refused token is read again, and when it has changed since it was presented the
/// link is opened once more on a new stream with the new token, since a daemon writes its token
/// just after it binds and the refused connection serves nothing more.
async fn open_link_answering_repair<C: DaemonConnector>(
    client: &JsonRpcClient,
    connector: &C,
) -> Result<(HandshakeAnswer, Link), ClientError> {
    let (presented_token, outcome) = open_link_with_token(client, connector, None).await;
    match outcome {
        Err(ClientError::Remote(refusal)) if refusal.is_refusal(RefusalCode::AuthTokenInvalid) => {
            let current_token = connector.read_token().await?;
            let is_unchanged = presented_token.as_ref().is_some_and(|presented| {
                bool::from(
                    presented
                        .as_str()
                        .as_bytes()
                        .ct_eq(current_token.as_str().as_bytes()),
                )
            });
            if is_unchanged {
                return Err(ClientError::Remote(refusal));
            }
            open_link_with_token(client, connector, Some(current_token))
                .await
                .1
        }
        outcome => outcome,
    }
}

/// Opens a stream, reads the token unless one is given, and opens the link with it, the
/// handshake held to [`HANDSHAKE_DEADLINE`]; answers the token presented beside the outcome.
async fn open_link_with_token<C: DaemonConnector>(
    client: &JsonRpcClient,
    connector: &C,
    token: Option<NegotiationText>,
) -> (
    Option<NegotiationText>,
    Result<(HandshakeAnswer, Link), ClientError>,
) {
    let stream = match connector.open_stream().await {
        Ok(stream) => stream,
        Err(error) => return (None, Err(error)),
    };
    let token = match token {
        Some(token) => token,
        None => match connector.read_token().await {
            Ok(token) => token,
            Err(error) => return (None, Err(error)),
        },
    };
    let request = initialize_request(&token);
    let handshake = client.open_link(stream, &request);
    let outcome = match timeout(HANDSHAKE_DEADLINE, handshake).await {
        Ok(outcome) => outcome,
        // The handshake's link ends as its future is dropped.
        Err(_elapsed) => Err(ClientError::Unavailable {
            reason: ConnectionUnavailableReason::Unreachable,
            cause: LinkFault::Silent,
        }),
    };
    (Some(token), outcome)
}

/// The handshake: this build's version, every version it speaks, and the session token.
fn initialize_request(token: &NegotiationText) -> ConnectionInitializeRequest {
    let versions = SUPPORTED_PROTOCOL_VERSIONS
        .iter()
        .map(|version| {
            ProtocolVersion::new((*version).to_owned()).expect("this build's versions are dates")
        })
        .collect();
    ConnectionInitializeRequest {
        protocol_version: ProtocolVersion::new(CURRENT_PROTOCOL_VERSION.to_owned())
            .expect("this build's version is a date"),
        supported_protocols: Some(
            BoundedVec::new(versions).expect("this build speaks one to 32 versions"),
        ),
        client_id: None,
        session_token: Some(token.clone()),
        capabilities: None,
    }
}
