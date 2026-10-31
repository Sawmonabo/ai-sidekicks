//! The loopback WebSocket the Codex service reaches the relay on: one listener for the relay's
//! life, each connection admitted by the current token and then made the one the executor answers,
//! its messages handed to the relay one by one while the executor's messages are written to it
//! apart, so neither side's full queue holds up the other's.

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

use crate::driver::codex::exec_relay::CodexExecRelay;
use crate::driver::codex::exec_relay::bearer_token::RelayBearerToken;

/// How many of the executor's messages wait for one client before the executor's reader waits.
const CLIENT_QUEUE_CAPACITY: usize = 256;

/// The first wait after a failed accept, doubled at each failure in a row up to the longest.
const ACCEPT_RETRY_FIRST: Duration = Duration::from_millis(10);
const ACCEPT_RETRY_LONGEST: Duration = Duration::from_secs(1);

/// The relay's listener and the token a connection must present now.
pub(super) struct RelayEndpoint {
    address: SocketAddr,
    token: Arc<Mutex<Arc<RelayBearerToken>>>,
    accepting: JoinHandle<()>,
}

impl RelayEndpoint {
    /// Listens on a free loopback port, handing each admitted connection to `relay`. Fails with
    /// the system's error when no port can be bound.
    pub(super) async fn listen(
        relay: Weak<CodexExecRelay>,
        token: RelayBearerToken,
    ) -> io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
        let address = listener.local_addr()?;
        let token = Arc::new(Mutex::new(Arc::new(token)));
        let accepting = tokio::spawn(accept_connections(listener, Arc::clone(&token), relay));
        Ok(Self {
            address,
            token,
            accepting,
        })
    }

    /// The address `environment/add` names, `ws://127.0.0.1:<port>`.
    pub(super) fn url(&self) -> String {
        format!("ws://{}", self.address)
    }

    /// Puts `token` in place of the one before it, which no later connection presents.
    pub(super) fn replace_token(&self, token: RelayBearerToken) {
        *lock(&self.token) = Arc::new(token);
    }

    /// The token a connection must present now.
    pub(super) fn token(&self) -> Arc<RelayBearerToken> {
        Arc::clone(&lock(&self.token))
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
    token: Arc<Mutex<Arc<RelayBearerToken>>>,
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
        let token = Arc::clone(&lock(&token));
        tokio::spawn(serve_connection(stream, token, relay.clone()));
    }
}

// Admits one connection by its token and carries messages both ways until either side closes.
async fn serve_connection(
    stream: TcpStream,
    token: Arc<RelayBearerToken>,
    relay: Weak<CodexExecRelay>,
) {
    #[expect(
        clippy::result_large_err,
        reason = "the WebSocket handshake's callback fixes this return type"
    )]
    let admit = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let authorization = request
            .headers()
            .get(header::AUTHORIZATION)
            .map(HeaderValue::as_bytes);
        if token.admits(authorization) {
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
    let Some(attached) = relay.upgrade() else {
        return;
    };
    let (to_client, mut for_client) = mpsc::channel::<String>(CLIENT_QUEUE_CAPACITY);
    let Some(executor) = attached.attach_client(to_client.clone()) else {
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
    });
    loop {
        let incoming = tokio::select! {
            incoming = source.next() => incoming,
            // The client can no longer be written, so the connection ends.
            _written = &mut writing => break,
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
        relay.take_client_message(&executor, text).await;
    }
    executor.detach_client(&to_client);
    writing.abort();
}
