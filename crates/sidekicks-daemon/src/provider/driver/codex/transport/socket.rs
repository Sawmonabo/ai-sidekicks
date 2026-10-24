//! The WebSocket a Codex service is reached over, on the `AF_UNIX` socket the service listens on.
//! The advertised socket path is a link to the real socket, and macOS refuses a socket path past
//! 104 bytes, so the link's target is dialed, and the process serving it is held for the daemon's
//! caller check while the socket lives. A service the daemon just started is dialed once it
//! listens, on a watch of the socket's folder rather than a poll.

use std::error::Error;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt as _, StreamExt as _};
use notify::{RecommendedWatcher, RecursiveMode, Watcher as _};
use sidekicks_platforms::{
    UnixDomainStream, connect_unix_domain_socket, create_private_folder, real_path,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use tokio_util::sync::CancellationToken;

use crate::error_description::describe_error;
use crate::ipc::caller_process::provider_services::{
    ProviderServiceHold, ProviderServiceProcesses,
};
use crate::provider::driver::codex::session::errors::CodexError;

/// The largest frame and message the daemon reads from the Codex service, in bytes: Codex's own
/// client's figure, so nothing Codex's own tools read is refused here.
const CODEX_MAX_RECEIVED_MESSAGE_BYTES: usize = 128 * 1024 * 1024;

/// The largest message the daemon sends a service that names no limit of its own, in bytes: the
/// frame size a WebSocket server takes by default, which Codex names as its own limit.
const CODEX_DEFAULT_SENT_MESSAGE_BYTES: usize = 16 * 1024 * 1024;

/// The address the service answers its app-server WebSocket at, over its socket.
const CODEX_SOCKET_ADDRESS: &str = "ws://localhost/";

/// The upgrade answer's header in which the service names the largest message it takes in one
/// frame; past it the service closes the socket.
const CODEX_MAX_UNFRAGMENTED_MESSAGE_BYTES_HEADER: &str =
    "x-codex-websocket-max-unfragmented-message-bytes";

/// Whether a dial waits for the service to listen.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexSocketWait {
    /// A service the daemon just started: the dial waits until it listens.
    UntilListening,
    /// The person's own service: the dial takes the socket as it is.
    Never,
}

/// What one read of a service's socket gives.
#[derive(Debug)]
pub(crate) enum CodexSocketEvent {
    /// One message from the service, as its bytes; a binary message is handed on too, so it
    /// reaches the unparsable-message diagnostic.
    Message(Bytes),
    /// The socket closed, from either side; later reads give it again.
    Closed {
        /// How it closed, in words.
        reason: String,
    },
}

/// The sending half of one open WebSocket to a Codex service, which refuses a message past the
/// largest the service takes before it goes.
pub(crate) struct CodexServiceSocketSender {
    /// The socket's sending half.
    sink: SplitSink<WebSocketStream<UnixDomainStream>, Message>,
    /// The largest message the service takes, in UTF-8 bytes.
    sent_message_byte_limit: usize,
    /// The serving process, held until both halves drop.
    _hold: Arc<ProviderServiceHold>,
}

/// The receiving half of one open WebSocket to a Codex service.
pub(crate) struct CodexServiceSocketReceiver {
    /// The socket's receiving half.
    frames: SplitStream<WebSocketStream<UnixDomainStream>>,
    /// The serving process, held until both halves drop.
    _hold: Arc<ProviderServiceHold>,
}

impl CodexServiceSocketSender {
    /// The largest message the service takes, in UTF-8 bytes, as it named it when the socket
    /// opened, or 16 MiB when it named none.
    pub(crate) fn sent_message_byte_limit(&self) -> usize {
        self.sent_message_byte_limit
    }

    /// Sends `text`, the encoded message of `method`, as one text frame. Fails with
    /// `CodexError::RequestTooLarge`, nothing sent, past the service's limit, and with
    /// `CodexError::Transport` when the socket did not take it.
    pub(crate) async fn send_text(&mut self, method: &str, text: String) -> Result<(), CodexError> {
        send_within_limit(&mut self.sink, self.sent_message_byte_limit, method, text).await
    }

    /// Closes the socket with the closing handshake; the receiving half reads the close. Fails
    /// with `CodexError::Transport` when the close could not be sent.
    pub(crate) async fn close(mut self) -> Result<(), CodexError> {
        self.sink.close().await.map_err(|error| {
            transport_failure("the Codex service's WebSocket could not be closed", error)
        })
    }
}

impl CodexServiceSocketReceiver {
    /// The next message from the service, or its close. Fails with `CodexError::Transport` when
    /// the socket could not be read, a message past the receive limit among them.
    pub(crate) async fn receive(&mut self) -> Result<CodexSocketEvent, CodexError> {
        receive_event(&mut self.frames).await
    }
}

/// Opens a WebSocket to the service listening on `socket_path`, holding its serving process in
/// `provider_services` until both halves drop; with `CodexSocketWait::UntilListening` it waits
/// until the service listens. Fails with `CodexError::Transport` when `cancel` fires, when the
/// socket cannot be reached (for a service the daemon just started, for another reason than not
/// listening yet), when the system cannot name the serving process, or when the upgrade fails.
pub(crate) async fn dial_codex_service_socket(
    socket_path: &Path,
    wait: CodexSocketWait,
    provider_services: &ProviderServiceProcesses,
    cancel: &CancellationToken,
) -> Result<(CodexServiceSocketSender, CodexServiceSocketReceiver), CodexError> {
    let dial = async {
        match wait {
            CodexSocketWait::UntilListening => {
                dial_when_listening(socket_path, provider_services).await
            }
            CodexSocketWait::Never => dial_once(socket_path, provider_services, None)
                .await
                .map_err(DialAttemptError::into_codex_error),
        }
    };
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(CodexError::Transport {
            detail: format!(
                "the dial to the Codex service's socket at {} was canceled",
                socket_path.display()
            ),
            cause: None,
        }),
        dialed = dial => dialed,
    }
}

/// Why one try at a service's socket failed.
enum DialAttemptError {
    /// No socket is there yet, or one a killed service left that nothing listens on.
    NotListening(io::Error),
    /// Any other failure, which ends the dial.
    Failed(CodexError),
}

impl DialAttemptError {
    fn into_codex_error(self) -> CodexError {
        match self {
            Self::NotListening(error) => {
                transport_failure("nothing listens on the Codex service's socket", error)
            }
            Self::Failed(error) => error,
        }
    }
}

// Dials a service the daemon just started once it listens. The socket's folder is watched, and the
// real socket's where the path is a link to it, and each change there tries again; a dial refused
// because nothing listens yet waits for the next change.
async fn dial_when_listening(
    socket_path: &Path,
    provider_services: &ProviderServiceProcesses,
) -> Result<(CodexServiceSocketSender, CodexServiceSocketReceiver), CodexError> {
    let socket_folder = socket_path
        .parent()
        .ok_or_else(|| CodexError::Transport {
            detail: format!(
                "the Codex service's socket path {} names no folder",
                socket_path.display()
            ),
            cause: None,
        })?
        .to_path_buf();
    // Watched before the service makes it, so the folder is made here, the daemon's own.
    let folder = socket_folder.clone();
    tokio::task::spawn_blocking(move || create_private_folder(&folder))
        .await
        .map_err(|error| {
            transport_failure("the Codex service's socket folder could not be made", error)
        })?
        .map_err(|error| {
            transport_failure("the Codex service's socket folder could not be made", error)
        })?;
    let mut changes = SocketFolderChanges::new()?;
    changes.watch_folder(&socket_folder)?;
    loop {
        let changes_seen = changes.count();
        match dial_once(socket_path, provider_services, Some(&mut changes)).await {
            Ok(halves) => return Ok(halves),
            // Nothing listens yet: the next change in a watched folder tries again.
            Err(DialAttemptError::NotListening(_)) => {}
            Err(DialAttemptError::Failed(error)) => return Err(error),
        }
        changes.wait_for_change_after(changes_seen).await?;
    }
}

// One try at the socket: the link resolved, the real socket's folder watched when the dial waits,
// the socket connected, its serving process held, then the WebSocket upgrade.
async fn dial_once(
    socket_path: &Path,
    provider_services: &ProviderServiceProcesses,
    changes: Option<&mut SocketFolderChanges>,
) -> Result<(CodexServiceSocketSender, CodexServiceSocketReceiver), DialAttemptError> {
    let link = socket_path.to_path_buf();
    let real_socket_path = tokio::task::spawn_blocking(move || real_path(&link))
        .await
        .map_err(|error| {
            DialAttemptError::Failed(transport_failure(
                "the Codex service's socket path could not be resolved",
                error,
            ))
        })?
        .map_err(classify_dial_failure)?;
    if let Some(changes) = changes
        && let Some(real_socket_folder) = real_socket_path.parent()
    {
        changes
            .watch_folder(real_socket_folder)
            .map_err(DialAttemptError::Failed)?;
    }
    let stream = connect_unix_domain_socket(&real_socket_path)
        .await
        .map_err(classify_dial_failure)?;
    let (stream, hold) = provider_services
        .hold_serving(stream)
        .await
        .map_err(|error| {
            DialAttemptError::Failed(transport_failure(
                "the process serving the Codex service's socket could not be held",
                error,
            ))
        })?;
    let (web_socket, sent_message_byte_limit) = open_codex_web_socket(stream)
        .await
        .map_err(DialAttemptError::Failed)?;
    let (sink, frames) = web_socket.split();
    let hold = Arc::new(hold);
    Ok((
        CodexServiceSocketSender {
            sink,
            sent_message_byte_limit,
            _hold: Arc::clone(&hold),
        },
        CodexServiceSocketReceiver {
            frames,
            _hold: hold,
        },
    ))
}

// A resolve or connect failure: not listening yet when no socket or no listener is there.
fn classify_dial_failure(error: io::Error) -> DialAttemptError {
    if matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
    ) {
        return DialAttemptError::NotListening(error);
    }
    DialAttemptError::Failed(transport_failure(
        "the Codex service's socket could not be reached",
        error,
    ))
}

// Upgrades `stream` to the service's WebSocket: the receive caps at what Codex's own client takes,
// no compression offered (tungstenite offers none), and the service's own limit on sent messages
// read from its upgrade answer, a positive whole number, or 16 MiB where it names none.
async fn open_codex_web_socket<Stream>(
    stream: Stream,
) -> Result<(WebSocketStream<Stream>, usize), CodexError>
where
    Stream: AsyncRead + AsyncWrite + Unpin,
{
    let config = WebSocketConfig::default()
        .max_message_size(Some(CODEX_MAX_RECEIVED_MESSAGE_BYTES))
        .max_frame_size(Some(CODEX_MAX_RECEIVED_MESSAGE_BYTES));
    let (web_socket, response) =
        tokio_tungstenite::client_async_with_config(CODEX_SOCKET_ADDRESS, stream, Some(config))
            .await
            .map_err(|error| {
                transport_failure("the Codex service refused the WebSocket upgrade", error)
            })?;
    let sent_message_byte_limit = response
        .headers()
        .get(CODEX_MAX_UNFRAGMENTED_MESSAGE_BYTES_HEADER)
        .and_then(|named| named.to_str().ok())
        .and_then(|named| named.trim().parse::<usize>().ok())
        .filter(|&limit| limit > 0)
        .unwrap_or(CODEX_DEFAULT_SENT_MESSAGE_BYTES);
    Ok((web_socket, sent_message_byte_limit))
}

// Sends `text` as one text frame, refused before it goes past `limit`: the service closes the
// socket on a larger message, and a message is never split into frames.
async fn send_within_limit<Stream>(
    sink: &mut SplitSink<WebSocketStream<Stream>, Message>,
    limit: usize,
    method: &str,
    text: String,
) -> Result<(), CodexError>
where
    Stream: AsyncRead + AsyncWrite + Unpin,
{
    if text.len() > limit {
        return Err(CodexError::RequestTooLarge {
            method: method.to_owned(),
            encoded_bytes: text.len(),
            limit,
        });
    }
    sink.send(Message::Text(text.into()))
        .await
        .map_err(|error| {
            transport_failure(
                "the Codex service's WebSocket did not take a message",
                error,
            )
        })
}

// The next message or the close; a ping is answered by tungstenite itself, and a raw frame never
// arrives on a read.
async fn receive_event<Stream>(
    frames: &mut SplitStream<WebSocketStream<Stream>>,
) -> Result<CodexSocketEvent, CodexError>
where
    Stream: AsyncRead + AsyncWrite + Unpin,
{
    loop {
        let Some(frame) = frames.next().await else {
            return Ok(CodexSocketEvent::Closed {
                reason: "the WebSocket ended".to_owned(),
            });
        };
        let message = frame.map_err(|error| {
            transport_failure("the Codex service's WebSocket could not be read", error)
        })?;
        match message {
            Message::Text(text) => return Ok(CodexSocketEvent::Message(Bytes::from(text))),
            Message::Binary(bytes) => return Ok(CodexSocketEvent::Message(bytes)),
            Message::Close(close_frame) => {
                let reason = close_frame.map_or_else(
                    || "the WebSocket closed with no code".to_owned(),
                    |close_frame| format!("the WebSocket closed: {close_frame}"),
                );
                return Ok(CodexSocketEvent::Closed { reason });
            }
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}

// A failure of the socket as the transport error the connection raises, keeping its cause.
fn transport_failure(what: &str, error: impl Into<Box<dyn Error + Send + Sync>>) -> CodexError {
    CodexError::Transport {
        detail: what.to_owned(),
        cause: Some(error.into()),
    }
}

/// The changes seen in the watched folders, counted so a change during a dial is never missed,
/// and the watch's failure, which ends the wait.
#[derive(Default)]
struct FolderChanges {
    count: u64,
    failure: Option<String>,
}

/// The watch of a dial's socket folders; each folder is watched once, until this drops.
struct SocketFolderChanges {
    watcher: RecommendedWatcher,
    watched_folders: Vec<PathBuf>,
    changes: watch::Receiver<FolderChanges>,
}

impl SocketFolderChanges {
    fn new() -> Result<Self, CodexError> {
        let (sender, changes) = watch::channel(FolderChanges::default());
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            sender.send_modify(|seen| match event {
                Ok(_) => seen.count += 1,
                Err(error) => seen.failure = Some(describe_error(&error)),
            });
        })
        .map_err(|error| {
            transport_failure(
                "the Codex service's socket folder could not be watched",
                error,
            )
        })?;
        Ok(Self {
            watcher,
            watched_folders: Vec::new(),
            changes,
        })
    }

    fn watch_folder(&mut self, folder: &Path) -> Result<(), CodexError> {
        if self.watched_folders.iter().any(|watched| watched == folder) {
            return Ok(());
        }
        self.watcher
            .watch(folder, RecursiveMode::NonRecursive)
            .map_err(|error| {
                transport_failure(
                    "the Codex service's socket folder could not be watched",
                    error,
                )
            })?;
        self.watched_folders.push(folder.to_path_buf());
        Ok(())
    }

    fn count(&self) -> u64 {
        self.changes.borrow().count
    }

    // Returns once a change past the `changes_seen`th arrived; fails when the watch failed.
    async fn wait_for_change_after(&mut self, changes_seen: u64) -> Result<(), CodexError> {
        let seen = self
            .changes
            .wait_for(|seen| seen.count > changes_seen || seen.failure.is_some())
            .await
            .map_err(|error| {
                transport_failure("the Codex service's socket folder watch ended", error)
            })?;
        match &seen.failure {
            Some(failure) => Err(CodexError::Transport {
                detail: format!("the Codex service's socket folder watch failed: {failure}"),
                cause: None,
            }),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use futures::{SinkExt as _, StreamExt as _};
    use rstest::rstest;
    use serde_json::Value;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::http::HeaderValue;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;

    use super::{
        CODEX_DEFAULT_SENT_MESSAGE_BYTES, CODEX_MAX_UNFRAGMENTED_MESSAGE_BYTES_HEADER,
        CodexSocketEvent, open_codex_web_socket, receive_event, send_within_limit,
    };
    use crate::provider::driver::codex::session::errors::CodexError;
    use crate::provider::inbound_json::decode_inbound_json;

    /// The deepest nesting `serde_json` reads: its limit is 128 levels, the 128th refused.
    const DECODE_DEPTH: usize = 127;

    /// One frame past tungstenite's own 16 MiB frame default.
    const PAST_DEFAULT_FRAME_BYTES: usize = 17 * 1024 * 1024;

    fn nested_to_decode_depth() -> String {
        format!("{}{}", "[".repeat(DECODE_DEPTH), "]".repeat(DECODE_DEPTH))
    }

    fn past_default_frame() -> String {
        format!("\"{}\"", "a".repeat(PAST_DEFAULT_FRAME_BYTES))
    }

    #[rstest]
    #[case::nested_to_the_decode_depth(nested_to_decode_depth())]
    #[case::past_the_default_frame_size(past_default_frame())]
    #[tokio::test]
    async fn a_frame_within_the_receive_caps_reads_whole_and_decodes(#[case] frame: String) {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let sent = frame.clone();
        let server = tokio::spawn(async move {
            let mut server = tokio_tungstenite::accept_async(server_side)
                .await
                .expect("the upgrade is answered");
            server
                .send(Message::Text(sent.into()))
                .await
                .expect("the frame is sent");
        });
        let (web_socket, limit) = open_codex_web_socket(client_side)
            .await
            .expect("the upgrade succeeds");
        assert_eq!(
            limit, CODEX_DEFAULT_SENT_MESSAGE_BYTES,
            "a service naming no limit"
        );
        let (_sink, mut frames) = web_socket.split();
        let CodexSocketEvent::Message(received) =
            receive_event(&mut frames).await.expect("the frame reads")
        else {
            panic!("a message arrives before any close");
        };
        assert!(&received[..] == frame.as_bytes(), "the frame arrives whole");
        serde_json::from_str::<Value>(&decode_inbound_json(&received)).expect("the frame decodes");
        server.await.expect("the server task ends");
    }

    #[tokio::test]
    async fn a_message_past_the_named_limit_is_refused_unsent_and_the_close_reads() {
        let (client_side, server_side) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move {
            #[expect(
                clippy::result_large_err,
                reason = "tungstenite's upgrade callback fixes its error type"
            )]
            let name_limit =
                |_request: &Request, mut response: Response| -> Result<Response, ErrorResponse> {
                    response.headers_mut().insert(
                        CODEX_MAX_UNFRAGMENTED_MESSAGE_BYTES_HEADER,
                        HeaderValue::from_static("8"),
                    );
                    Ok(response)
                };
            let mut server = tokio_tungstenite::accept_hdr_async(server_side, name_limit)
                .await
                .expect("the upgrade is answered");
            let first = server
                .next()
                .await
                .expect("a message arrives")
                .expect("the message reads");
            server
                .close(Some(CloseFrame {
                    code: CloseCode::Normal,
                    reason: "service stopping".into(),
                }))
                .await
                .expect("the close is sent");
            first
        });
        let (web_socket, limit) = open_codex_web_socket(client_side)
            .await
            .expect("the upgrade succeeds");
        assert_eq!(limit, 8);
        let (mut sink, mut frames) = web_socket.split();
        let refused = send_within_limit(&mut sink, limit, "turn/start", "123456789".to_owned())
            .await
            .expect_err("nine bytes are past the limit");
        assert!(matches!(
            refused,
            CodexError::RequestTooLarge {
                encoded_bytes: 9,
                limit: 8,
                ..
            }
        ));
        send_within_limit(&mut sink, limit, "turn/start", "abc".to_owned())
            .await
            .expect("three bytes are within the limit");
        let CodexSocketEvent::Closed { reason } =
            receive_event(&mut frames).await.expect("the close reads")
        else {
            panic!("the service sends nothing but its close");
        };
        assert!(reason.contains("service stopping"), "{reason}");
        let first = server.await.expect("the server task ends");
        assert_eq!(first, Message::Text("abc".into()));
    }
}
