//! A connection to the daemon on this machine, opened the one way every client opens it: connect
//! to its socket, check that the run folder is this account's alone, read the session token the
//! daemon wrote at its current start, then `connection.initialize` with that token before any other
//! call, answered within [`HANDSHAKE_DEADLINE`]. The token is read at every connect, because each
//! daemon start writes a new one, and once more when the daemon refuses it. A supervisor then
//! watches the link: after 5 s with no frame it sends `daemon.ping` and reports the link quiet, and
//! after 20 s with no frame it counts the link lost. A lost link is opened again on the client's
//! own schedule, [`LINK_REOPEN_BACKOFF_MS`], calls made meanwhile held for it; once every attempt
//! failed the connection is down, every call settles `connection.unavailable` at once, and only
//! `retry` starts the schedule again.

use std::io;
use std::path::Path;
use std::pin::pin;
use std::sync::Arc;
use std::time::Duration;

use sidekicks_contracts::daemon::lifecycle::DaemonPing;
use sidekicks_contracts::jsonrpc::message::ConnectionUnavailableReason;
use sidekicks_contracts::jsonrpc::negotiation::{
    CURRENT_PROTOCOL_VERSION, ConnectionInitializeRequest, ConnectionInitializeResponse,
    NegotiationText, ProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method_descriptor::EmptyPayload;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_platforms::{DaemonRunFolder, check_private_run_folder, daemon_run_folder};
use subtle::ConstantTimeEq as _;
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, sleep, sleep_until, timeout};

use crate::error::{ClientError, LinkFault, RemoteError};
use crate::transport::json_rpc::JsonRpcClient;
use crate::transport::link::Link;
use crate::transport::local_socket::connect_local_socket;

/// The client's own schedule for a lost link: the wait before each attempt to open it again, in
/// milliseconds. Once the attempt after the last wait fails the connection is down until `retry`,
/// which starts the schedule again from its first wait.
pub const LINK_REOPEN_BACKOFF_MS: [u64; 5] = [100, 300, 1_000, 3_000, 10_000];

/// How long a connect waits for the daemon's answer to `connection.initialize`; a daemon that
/// accepts the socket and never answers fails the attempt as `connection.unavailable`.
pub const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(10);

/// How long the link may carry no frame before the supervisor sends `daemon.ping`.
const QUIET_AFTER: Duration = Duration::from_secs(5);

/// How long the link may carry no frame before it counts as lost.
const LOST_AFTER: Duration = Duration::from_secs(20);

/// Where the daemon on this machine is reached: its run folder, which holds its socket and its
/// token file.
#[derive(Clone, Debug)]
pub struct DaemonEndpoint {
    run_folder: DaemonRunFolder,
}

impl DaemonEndpoint {
    /// The endpoint in `run_folder`.
    pub fn new(run_folder: DaemonRunFolder) -> Self {
        Self { run_folder }
    }

    /// The endpoint of the daemon this account runs on this machine. Fails where the running
    /// system has no run folder.
    pub fn this_machine() -> io::Result<Self> {
        daemon_run_folder().map(Self::new)
    }
}

/// How the connection to the daemon stands, as the supervisor reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectionState {
    /// The link is open and frames arrive.
    Open,
    /// The link is open but no frame came for a while; a `daemon.ping` is out.
    Quiet,
    /// The link was lost and is being opened again on the schedule; calls are held for it.
    Reconnecting,
    /// Every attempt on the schedule failed; calls settle `connection.unavailable` at once until
    /// `retry`.
    Down,
}

/// An open daemon connection: the client past its handshake, the daemon's answer to the
/// handshake, and the supervisor that watches the link and opens it again.
pub struct DaemonConnection {
    client: JsonRpcClient,
    initialize_response: ConnectionInitializeResponse,
    state: watch::Receiver<ConnectionState>,
    retry: Arc<Notify>,
    supervisor: JoinHandle<()>,
}

impl DaemonConnection {
    /// Connects to the daemon at `endpoint` and completes `connection.initialize`. Fails with
    /// `ClientError::Unavailable` when nothing answers on the socket or the handshake passes
    /// [`HANDSHAKE_DEADLINE`], `RunFolder` when the run folder is not this account's alone,
    /// `Token` when the token file cannot be read (`NotFound` while a daemon that has bound its
    /// socket has not yet written it), and `Remote` with `auth.token.invalid` when the daemon
    /// refuses the token and the file still holds the one presented.
    pub async fn connect(endpoint: DaemonEndpoint) -> Result<Self, ClientError> {
        let client = JsonRpcClient::new();
        let (initialize_response, link) = open_link(&client, &endpoint.run_folder).await?;
        let (state_sender, state) = watch::channel(ConnectionState::Open);
        let retry = Arc::new(Notify::new());
        let supervisor = tokio::spawn(supervise(
            client.clone(),
            endpoint,
            link,
            state_sender,
            Arc::clone(&retry),
        ));
        Ok(Self {
            client,
            initialize_response,
            state,
            retry,
            supervisor,
        })
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
        self.state.clone()
    }

    /// Starts the reconnect schedule again from its first wait once the connection is down; does
    /// nothing in any other state.
    pub fn retry(&self) {
        if self.state() == ConnectionState::Down {
            self.retry.notify_one();
        }
    }

    /// Stops the supervisor and closes the link; every call still waiting settles
    /// `ClientError::Unavailable`.
    pub async fn close(self) {
        self.supervisor.abort();
        self.client.close().await;
    }
}

impl Drop for DaemonConnection {
    fn drop(&mut self) {
        self.supervisor.abort();
    }
}

/// Watches each link until it ends, then opens it again on the schedule; once the schedule failed
/// it takes the client down and waits for a `retry`, which starts the schedule again.
async fn supervise(
    client: JsonRpcClient,
    endpoint: DaemonEndpoint,
    first_link: Link,
    state: watch::Sender<ConnectionState>,
    retry: Arc<Notify>,
) {
    let mut link = first_link;
    loop {
        let fault = watch_link(&client, &link, &state).await;
        state.send_replace(ConnectionState::Reconnecting);
        link = loop {
            if let Some(reopened) = reopen_on_schedule(&client, &endpoint.run_folder).await {
                break reopened;
            }
            client.abandon(fault.clone());
            state.send_replace(ConnectionState::Down);
            retry.notified().await;
            client.hold_calls();
            state.send_replace(ConnectionState::Reconnecting);
        };
        state.send_replace(ConnectionState::Open);
    }
}

/// Waits each step of [`LINK_REOPEN_BACKOFF_MS`] and then tries to open the link; answers the
/// first link that opens, or `None` once the attempt after the last wait failed.
async fn reopen_on_schedule(client: &JsonRpcClient, run_folder: &DaemonRunFolder) -> Option<Link> {
    for wait in LINK_REOPEN_BACKOFF_MS {
        sleep(Duration::from_millis(wait)).await;
        match open_link(client, run_folder).await {
            Ok((_initialize_response, link)) => return Some(link),
            Err(error) => tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "The connection to the background service could not be opened again"
            ),
        }
    }
    None
}

/// Watches one link until it ends, answering why: after [`QUIET_AFTER`] with no frame it reports
/// the link quiet and sends `daemon.ping`, which takes no call slot, and once [`LOST_AFTER`] has
/// passed with no frame it closes the link as silent.
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
        // A frame that came while the timer ran moves the deadline on.
        if Instant::now() < link.last_frame_at() + QUIET_AFTER {
            continue;
        }
        state.send_replace(ConnectionState::Quiet);
        let mut ping = pin!(client.call::<DaemonPing>(&EmptyPayload {}));
        loop {
            tokio::select! {
                fault = link.ended() => return fault,
                answer = &mut ping => {
                    match answer {
                        Ok(EmptyPayload {}) => {
                            state.send_replace(ConnectionState::Open);
                        }
                        // The link's end, which the next round reads, is the failure that counts.
                        Err(error) => tracing::debug!(
                            error = &error as &(dyn std::error::Error + 'static),
                            "The link watch's ping failed"
                        ),
                    }
                    break;
                }
                () = sleep_until(link.last_frame_at() + LOST_AFTER) => {
                    // A frame that came while the timer ran moves the deadline on.
                    if Instant::now() >= link.last_frame_at() + LOST_AFTER {
                        link.close(LinkFault::Silent);
                        return LinkFault::Silent;
                    }
                }
            }
        }
    }
}

/// Opens one link: a refused token is read again, and when the file has changed since it was
/// presented the link is opened once more on a new connection with the new token, since a daemon
/// writes its token just after it binds and the refused connection serves nothing more.
async fn open_link(
    client: &JsonRpcClient,
    run_folder: &DaemonRunFolder,
) -> Result<(ConnectionInitializeResponse, Link), ClientError> {
    let (presented_token, outcome) = open_link_with_token(client, run_folder, None).await;
    match outcome {
        Err(ClientError::Remote(refusal)) if is_token_refusal(&refusal) => {
            let current_token = read_token(&run_folder.token_path).await?;
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
            open_link_with_token(client, run_folder, Some(current_token))
                .await
                .1
        }
        outcome => outcome,
    }
}

/// Connects, checks the run folder before any byte is written, reads the token unless one is
/// given, and opens the link with it; answers the token presented beside the outcome. Connecting
/// first makes a daemon that is not running read as `Unavailable` rather than a missing folder or
/// token file.
async fn open_link_with_token(
    client: &JsonRpcClient,
    run_folder: &DaemonRunFolder,
    token: Option<NegotiationText>,
) -> (
    Option<NegotiationText>,
    Result<(ConnectionInitializeResponse, Link), ClientError>,
) {
    let stream = match connect_local_socket(&run_folder.socket_path).await {
        Ok(stream) => stream,
        Err(error) => return (None, Err(error)),
    };
    // A folder another account made could hold its own socket and token, which would then prove
    // nothing.
    if let Err(refused) = check_private_run_folder(&run_folder.folder_path) {
        return (None, Err(refused.into()));
    }
    let token = match token {
        Some(token) => token,
        None => match read_token(&run_folder.token_path).await {
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

/// Whether `refusal` is the daemon refusing the session token.
fn is_token_refusal(refusal: &RemoteError) -> bool {
    refusal
        .data
        .as_ref()
        .is_some_and(|data| data.refusal == RefusalCode::AuthTokenInvalid.as_str())
}

/// Reads the session token; a file whose text is no token is refused as invalid data.
async fn read_token(path: &Path) -> Result<NegotiationText, ClientError> {
    let token_error = |source: io::Error| ClientError::Token {
        path: path.to_path_buf(),
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
