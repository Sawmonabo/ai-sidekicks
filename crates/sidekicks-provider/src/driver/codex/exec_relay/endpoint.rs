//! The loopback WebSocket the Codex service reaches the relay on: one listener for the relay's
//! life, each connection admitted by the token of one environment and attached onto the executor
//! beside the others as that environment's, its messages handed to the relay one by one while the
//! executor's messages are written to it apart, so neither side's full queue holds up the other's.
//! A connection closes once the executor lets its queue go, and its socket's end is the relay's to
//! let go.

use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::{SinkExt as _, StreamExt as _};
use sidekicks_std::mutex_lock::lock;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode, header};
use tokio_util::sync::CancellationToken;

use crate::bearer_token::BearerToken;
use crate::driver::codex::exec_relay::CodexExecRelay;

/// How many of the executor's messages wait for one client before more wait in its spill.
const CLIENT_QUEUE_CAPACITY: usize = 256;

/// The first wait after a failed accept, doubled at each failure in a row up to the longest.
const ACCEPT_RETRY_FIRST: Duration = Duration::from_millis(10);
const ACCEPT_RETRY_LONGEST: Duration = Duration::from_secs(1);

// One environment the relay admits: the token its connections present and its id.
struct AdmittedEnvironment {
    token: BearerToken,
    environment_id: Arc<str>,
}

// The environments the relay admits now, each by its own token.
type AdmittedEnvironments = Arc<Mutex<Vec<AdmittedEnvironment>>>;

/// The relay's listener and the token each environment's connections present now.
pub(super) struct RelayEndpoint {
    address: SocketAddr,
    environments: AdmittedEnvironments,
    accepting: JoinHandle<()>,
}

impl RelayEndpoint {
    /// Listens on a free loopback port, admitting no environment yet and handing each admitted
    /// connection to `relay`. Fails with the system's error when no port can be bound.
    pub(super) async fn listen(relay: Weak<CodexExecRelay>) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let address = listener.local_addr()?;
        let environments = AdmittedEnvironments::default();
        let accepting = tokio::spawn(accept_connections(
            listener,
            Arc::clone(&environments),
            relay,
        ));
        Ok(Self {
            address,
            environments,
            accepting,
        })
    }

    /// The address `environment/add` names, `ws://127.0.0.1:<port>`.
    pub(super) fn url(&self) -> String {
        format!("ws://{}", self.address)
    }

    /// Admits the environment `environment_id` by `token` from now on, in place of any token it
    /// was admitted by before.
    pub(super) fn admit(&self, environment_id: &str, token: BearerToken) {
        let mut environments = lock(&self.environments);
        environments.retain(|admitted| &*admitted.environment_id != environment_id);
        environments.push(AdmittedEnvironment {
            token,
            environment_id: environment_id.into(),
        });
    }

    /// Retires every environment's token, which no later connection presents.
    pub(super) fn retire_every_token(&self) {
        lock(&self.environments).clear();
    }
}

impl Drop for RelayEndpoint {
    fn drop(&mut self) {
        self.accepting.abort();
    }
}

// Accepts connections until the relay is gone, serving each on a task of its own; a failed
// accept, such as one past the open-file limit, is retried after a wait that grows while they
// keep failing.
async fn accept_connections(
    listener: TcpListener,
    environments: AdmittedEnvironments,
    relay: Weak<CodexExecRelay>,
) {
    let mut retry_wait = ACCEPT_RETRY_FIRST;
    loop {
        let stream = match listener.accept().await {
            Ok((stream, _peer)) => {
                retry_wait = ACCEPT_RETRY_FIRST;
                stream
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the Codex relay could not accept a connection"
                );
                tokio::time::sleep(retry_wait).await;
                retry_wait = (retry_wait * 2).min(ACCEPT_RETRY_LONGEST);
                continue;
            }
        };
        if relay.strong_count() == 0 {
            return;
        }
        tokio::spawn(serve_connection(
            stream,
            Arc::clone(&environments),
            relay.clone(),
        ));
    }
}

// Admits one connection by the token of the environment it serves, read at its handshake, and
// carries messages both ways until either side closes; the relay then lets it go.
async fn serve_connection(
    stream: TcpStream,
    environments: AdmittedEnvironments,
    relay: Weak<CodexExecRelay>,
) {
    let mut admitted = None;
    #[expect(
        clippy::result_large_err,
        reason = "the WebSocket handshake's callback fixes this return type"
    )]
    let admit = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let authorization = request
            .headers()
            .get(header::AUTHORIZATION)
            .map(HeaderValue::as_bytes);
        // Each token is compared in constant time.
        admitted = lock(&environments)
            .iter()
            .find(|environment| environment.token.admits(authorization))
            .map(|environment| Arc::clone(&environment.environment_id));
        if admitted.is_some() {
            return Ok(response);
        }
        let mut refusal =
            ErrorResponse::new(Some("The relay's token is missing or wrong.".to_owned()));
        *refusal.status_mut() = StatusCode::UNAUTHORIZED;
        Err(refusal)
    };
    let socket = match accept_hdr_async(stream, admit).await {
        Ok(socket) => socket,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "the Codex relay refused a connection"
            );
            return;
        }
    };
    let (Some(attached), Some(environment)) = (relay.upgrade(), admitted) else {
        return;
    };
    let (to_client, mut for_client) = mpsc::channel::<String>(CLIENT_QUEUE_CAPACITY);
    let closed = CancellationToken::new();
    // The executor keeps the queue's only sender, so its detach or end closes the connection.
    let Some((executor, connection)) =
        attached.attach_client(to_client, closed.clone(), environment)
    else {
        return;
    };
    drop(attached);
    let (mut sink, mut source) = socket.split();
    let mut writing = tokio::spawn(async move {
        while let Some(outgoing) = for_client.recv().await {
            if let Err(error) = sink.send(Message::text(outgoing)).await {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the Codex relay's client could not be written"
                );
                return;
            }
        }
        if let Err(error) = sink.close().await {
            tracing::debug!(
                error = &error as &(dyn std::error::Error + 'static),
                "the Codex relay's client could not be closed"
            );
        }
    });
    loop {
        let incoming = tokio::select! {
            incoming = source.next() => incoming,
            // The executor let the queue go or the client can no longer be written.
            _written = &mut writing => break,
            // The client fell its queue's bound behind.
            () = closed.cancelled() => break,
        };
        let text = match incoming {
            Some(Ok(Message::Text(text))) => text.as_str().to_owned(),
            Some(Ok(Message::Binary(bytes))) => match String::from_utf8(bytes.to_vec()) {
                Ok(text) => text,
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "the Codex relay's client sent no text"
                    );
                    continue;
                }
            },
            Some(Ok(Message::Close(_))) | None => break,
            Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
            Some(Err(error)) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the Codex relay's client could not be read"
                );
                break;
            }
        };
        let Some(relay) = relay.upgrade() else { break };
        relay.take_client_message(&executor, connection, text).await;
    }
    match relay.upgrade() {
        Some(relay) => relay.let_go(&executor, connection),
        None => {
            executor.detach_client(connection);
        }
    }
    writing.abort();
}
