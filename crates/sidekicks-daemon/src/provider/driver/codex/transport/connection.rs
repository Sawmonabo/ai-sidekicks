//! One JSON-RPC connection to a Codex service over its WebSocket: requests matched to their answers
//! under a deadline, the requests the service sends answered or held for the person, notifications
//! handed up, and a close that leaves no request waiting.

mod asks;
#[cfg(test)]
pub(crate) mod scripted_service;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures::future::BoxFuture;
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::value::RawValue;
use sidekicks_contracts::app_identity::APP_DISPLAY_NAME;
use sidekicks_contracts::jsonrpc::message::JsonRpcId;
use tokio::sync::{Mutex as AsyncMutex, oneshot};
use tokio::task::JoinHandle;

use crate::error_description::describe_error;
use crate::provider::driver::codex::event_normalizer::CODEX_OPT_OUT_NOTIFICATION_METHODS;
use crate::provider::driver::codex::server_requests::{
    CodexAskKind, CodexRoutedMethod, CodexServerRequestResponder,
};
use crate::provider::driver::codex::session::errors::{CodexError, CodexUnansweredCause};
use crate::provider::driver::codex::transport::connection::asks::{
    HeldServerRequest, read_dropped_request,
};
use crate::provider::driver::codex::transport::diagnostics::{
    CodexTransportDiagnostic, CodexUnparsableMessageReason,
};
use crate::provider::driver::codex::transport::socket::{
    CodexServiceSocketReceiver, CodexServiceSocketSender, CodexSocketEvent,
};
use crate::provider::inbound_json::decode_inbound_json;

/// How long a request waits for its answer before it fails with `CodexError::Unanswered`.
pub(crate) const CODEX_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The JSON-RPC version every message names.
const JSON_RPC_VERSION: &str = "2.0";

/// A held ask the connection let go of, so its card is withdrawn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexForgottenRequest {
    /// The service's request id, as its JSON.
    pub(crate) request_id: String,
    /// Who the ask was for.
    pub(crate) ask_kind: CodexAskKind,
    /// The conversation the ask names, or `None` when it names none.
    pub(crate) thread_id: Option<String>,
}

/// Where one connection hands what the service sends it that is no answer to the daemon's own
/// requests. The connection routes nothing by conversation: every frame goes up.
pub(crate) trait CodexConnectionEvents: Send + Sync {
    /// A notification, with its params as sent (`null` when it sent none). Called on the
    /// connection's reader, in arrival order.
    fn notification(&self, method: &str, params: Box<RawValue>);

    /// The socket closed without the daemon closing it: the connection dropped or the service
    /// ended. `reason` says how, in words.
    fn dropped(&self, reason: &str);

    /// The connection closed holding asks for the person. Nothing can answer them on it now, and
    /// Codex asks again, under a new id, on the connection that next resumes their conversation.
    fn held_requests_dropped(&self, dropped: Vec<CodexForgottenRequest>);

    /// The service answered a request that it drains toward its exit, in `message`, its own words:
    /// it takes no new work, while its running turns, reads and interrupts go on until it closes
    /// the connection. Called once per such answer, off the reader.
    fn service_draining(&self, message: &str);
}

/// What one connection hands up: notifications and its close to `events`, routed asks to
/// `responder`. With no responder, every routed ask answers its own refusal.
pub(crate) struct CodexConnectionHandlers {
    /// Notifications, the drop and the held asks let go of.
    pub(crate) events: Arc<dyn CodexConnectionEvents>,
    /// Answers or holds each routed ask.
    pub(crate) responder: Option<Arc<dyn CodexServerRequestResponder>>,
}

/// The sending half of the socket a connection writes to.
trait ServiceMessageWriter: Send {
    /// The largest message the service takes, in UTF-8 bytes.
    fn sent_message_byte_limit(&self) -> usize;

    /// Sends `text`, the encoded message of `method`; refused unsent past the limit.
    fn send_text<'call>(
        &'call mut self,
        method: &'call str,
        text: String,
    ) -> BoxFuture<'call, Result<(), CodexError>>;

    /// Closes the socket with the closing handshake.
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), CodexError>>;
}

/// The receiving half of the socket a connection reads from.
trait ServiceMessageReader: Send {
    /// The next message or the close.
    fn receive(&mut self) -> BoxFuture<'_, Result<CodexSocketEvent, CodexError>>;
}

impl ServiceMessageWriter for CodexServiceSocketSender {
    fn sent_message_byte_limit(&self) -> usize {
        CodexServiceSocketSender::sent_message_byte_limit(self)
    }

    fn send_text<'call>(
        &'call mut self,
        method: &'call str,
        text: String,
    ) -> BoxFuture<'call, Result<(), CodexError>> {
        Box::pin(CodexServiceSocketSender::send_text(self, method, text))
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), CodexError>> {
        Box::pin(CodexServiceSocketSender::close(*self))
    }
}

impl ServiceMessageReader for CodexServiceSocketReceiver {
    fn receive(&mut self) -> BoxFuture<'_, Result<CodexSocketEvent, CodexError>> {
        Box::pin(CodexServiceSocketReceiver::receive(self))
    }
}

/// Starts a connection on a service's open socket halves and runs the `initialize` handshake
/// under `client_name`, answering the connection and the handshake's reply, which carries the
/// service's version. Fails as a request does when the handshake fails or outlives
/// `handshake_timeout`; the connection is let go of then, which closes the socket.
pub(crate) async fn open_codex_connection(
    sender: CodexServiceSocketSender,
    receiver: CodexServiceSocketReceiver,
    handlers: CodexConnectionHandlers,
    client_name: &str,
    handshake_timeout: Duration,
) -> Result<(CodexAppServerConnection, Box<RawValue>), CodexError> {
    let connection =
        CodexAppServerConnection::start(Box::new(sender), Box::new(receiver), handlers);
    // On because `thread/settings/update`, `thread/backgroundTerminals/*`, the thread's
    // `permissions` member and `thread/turns/list` answer only then. One service has one opt-out
    // list, so it is every notification no conversation on it reads.
    let initialize = json!({
        "clientInfo": { "name": client_name, "title": APP_DISPLAY_NAME, "version": "1" },
        "capabilities": {
            "experimentalApi": true,
            "requestAttestation": false,
            "optOutNotificationMethods": CODEX_OPT_OUT_NOTIFICATION_METHODS.as_slice(),
        },
    });
    let reply = connection
        .request_within("initialize", &initialize, handshake_timeout)
        .await?;
    connection.notify_initialized().await;
    Ok((connection, reply))
}

/// One WebSocket connection to a Codex service. The pending requests and held asks sit behind a
/// lock never held across an await; the socket's sending half, whose send awaits, sits behind an
/// async lock, so writers queue on the socket itself with no unbounded queue or extra task. One
/// reader task owns the receiving half and ends when the socket closes; letting go of the
/// connection closes it and ends that task.
pub(crate) struct CodexAppServerConnection {
    /// What the connection and its reader share.
    shared: Arc<ConnectionShared>,
    /// The reader task, ended when the connection is let go of.
    reader: JoinHandle<()>,
}

/// What a connection, its reader and its answer tasks share.
struct ConnectionShared {
    /// The pending requests, the held asks and whether the connection closed.
    state: Mutex<ConnectionState>,
    /// The socket's sending half; `None` once closed.
    writer: AsyncMutex<Option<Box<dyn ServiceMessageWriter>>>,
    /// The largest message the service takes, in UTF-8 bytes.
    sent_message_byte_limit: usize,
    /// Where notifications, the drop and the held asks let go of go.
    events: Arc<dyn CodexConnectionEvents>,
    /// Answers or holds each routed ask.
    responder: Option<Arc<dyn CodexServerRequestResponder>>,
}

/// The connection's bookkeeping, changed only under its lock.
struct ConnectionState {
    /// The id the next request takes.
    next_request_id: u64,
    /// Each request waiting for its answer, by its id.
    pending: HashMap<u64, oneshot::Sender<RequestAnswer>>,
    /// Each ask the responder held for the person, by its request id as its JSON.
    held: HashMap<String, HeldServerRequest>,
    /// Held asks whose answer is being sent, so a second answer cannot send another.
    answering: HashSet<String>,
    /// How the connection closed; `None` while it is open.
    close_reason: Option<String>,
}

/// What the service answered one request: its `result`, or the code and message of its error,
/// which the request names its method beside.
type RequestAnswer = Result<Box<RawValue>, ErrorAnswer>;

/// The members of an error answer the request reports; `0` and empty when it sent none usable,
/// and the `reason` its `data` names as text, when it names one.
struct ErrorAnswer {
    code: i64,
    message: String,
    reason: Option<String>,
}

// The members of a frame the connection reads, each kept raw so one unreadable member never
// drops the frame; absent and `null` both read as `None`.
#[derive(Deserialize)]
struct InboundFrame {
    id: Option<Box<RawValue>>,
    method: Option<Box<RawValue>>,
    params: Option<Box<RawValue>>,
    result: Option<Box<RawValue>>,
    error: Option<Box<RawValue>>,
}

// The members of an error answer the connection reads.
#[derive(Deserialize)]
struct InboundError {
    code: Option<Box<RawValue>>,
    message: Option<Box<RawValue>>,
    data: Option<Box<RawValue>>,
}

// The member of an error answer's `data` the connection reads.
#[derive(Deserialize)]
struct InboundErrorData {
    reason: Option<Box<RawValue>>,
}

#[derive(Serialize)]
struct OutboundRequest<'message, Params> {
    jsonrpc: &'static str,
    id: u64,
    method: &'message str,
    params: &'message Params,
}

impl CodexAppServerConnection {
    // Starts the reader on `reader` and answers the connection that writes to `writer`.
    fn start(
        writer: Box<dyn ServiceMessageWriter>,
        mut reader: Box<dyn ServiceMessageReader>,
        handlers: CodexConnectionHandlers,
    ) -> Self {
        let shared = Arc::new(ConnectionShared {
            state: Mutex::new(ConnectionState {
                next_request_id: 1,
                pending: HashMap::new(),
                held: HashMap::new(),
                answering: HashSet::new(),
                close_reason: None,
            }),
            sent_message_byte_limit: writer.sent_message_byte_limit(),
            writer: AsyncMutex::new(Some(writer)),
            events: handlers.events,
            responder: handlers.responder,
        });
        let reader_shared = Arc::clone(&shared);
        let reader = tokio::spawn(async move {
            loop {
                match reader.receive().await {
                    Ok(CodexSocketEvent::Message(bytes)) => reader_shared.receive(&bytes),
                    Ok(CodexSocketEvent::Closed { reason }) => {
                        reader_shared.handle_socket_closed(&reason);
                        return;
                    }
                    Err(error) => {
                        reader_shared.handle_socket_closed(&describe_error(&error));
                        return;
                    }
                }
            }
        });
        Self { shared, reader }
    }

    /// Sends a request and answers its `result`, waiting at most [`CODEX_REQUEST_TIMEOUT`]. Fails
    /// as [`Self::request_within`] does.
    pub(crate) async fn request<Params: Serialize + Sync>(
        &self,
        method: &str,
        params: &Params,
    ) -> Result<Box<RawValue>, CodexError> {
        self.request_within(method, params, CODEX_REQUEST_TIMEOUT)
            .await
    }

    /// Sends a request and answers its `result` (`null` when the answer carried none), waiting at
    /// most `timeout`. Fails with `CodexError::ProviderRequest` when the service answered with an
    /// error, `CodexError::RequestTooLarge`, nothing sent, past the largest message the service
    /// takes, `CodexError::Transport` when the connection was closed or the write failed, so
    /// nothing reached the service, and `CodexError::Unanswered` once the request was written and
    /// no answer came in time or the connection closed first.
    pub(crate) async fn request_within<Params: Serialize + Sync>(
        &self,
        method: &str,
        params: &Params,
        timeout: Duration,
    ) -> Result<Box<RawValue>, CodexError> {
        let (answer_sender, answer) = oneshot::channel();
        let slot = self.shared.reserve_request(method, answer_sender)?;
        let text = serde_json::to_string(&OutboundRequest {
            jsonrpc: JSON_RPC_VERSION,
            id: slot.request_id,
            method,
            params,
        })
        .map_err(|error| CodexError::Transport {
            detail: format!("The \"{method}\" request could not be encoded."),
            cause: Some(Box::new(error)),
        })?;
        self.shared.send_text(method, text).await?;
        let outcome = match tokio::time::timeout(timeout, answer).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(ErrorAnswer {
                code,
                message,
                reason,
            }))) => {
                let refusal = CodexError::ProviderRequest {
                    method: method.to_owned(),
                    code,
                    message,
                    reason,
                };
                if let CodexError::ProviderRequest { message, .. } = &refusal
                    && refusal.is_service_draining()
                {
                    self.shared.events.service_draining(message);
                }
                Err(refusal)
            }
            // The close dropped every waiting request's sender.
            Ok(Err(_closed)) => Err(CodexError::Unanswered {
                method: method.to_owned(),
                cause: CodexUnansweredCause::ConnectionClosed {
                    reason: self.shared.close_reason(),
                },
            }),
            Err(_elapsed) => Err(CodexError::Unanswered {
                method: method.to_owned(),
                cause: CodexUnansweredCause::Deadline { timeout },
            }),
        };
        drop(slot);
        outcome
    }

    /// Closes the socket, failing every request in flight and letting go of every held ask;
    /// closing again does nothing. Fails with `CodexError::Transport` when the closing handshake
    /// could not be sent; the connection is closed either way.
    pub(crate) async fn close(&self) -> Result<(), CodexError> {
        self.shared.mark_closed("the daemon closed the connection");
        let writer = self.shared.writer.lock().await.take();
        match writer {
            Some(writer) => writer.close().await,
            None => Ok(()),
        }
    }

    // Sends `initialized`; a failure is reported, not returned, since the handshake answered and
    // the next request's failure is the one a caller acts on.
    async fn notify_initialized(&self) {
        const METHOD: &str = "initialized";
        let text = json!({ "jsonrpc": JSON_RPC_VERSION, "method": METHOD, "params": {} });
        if let Err(error) = self.shared.send_text(METHOD, text.to_string()).await {
            CodexTransportDiagnostic::NotificationWriteFailed {
                method: METHOD.to_owned(),
                error: Box::new(error),
            }
            .report();
        }
    }
}

impl Drop for CodexAppServerConnection {
    fn drop(&mut self) {
        // Held asks are withdrawn as on a close; the reader's end drops the socket's halves.
        self.shared
            .mark_closed("the daemon let go of the connection");
        self.reader.abort();
    }
}

/// A request's place among the pending ones, given up when the request ends however it ends.
struct PendingRequestSlot<'connection> {
    shared: &'connection ConnectionShared,
    request_id: u64,
}

impl Drop for PendingRequestSlot<'_> {
    fn drop(&mut self) {
        self.shared.lock_state().pending.remove(&self.request_id);
    }
}

impl ConnectionShared {
    fn lock_state(&self) -> MutexGuard<'_, ConnectionState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn close_reason(&self) -> String {
        self.lock_state()
            .close_reason
            .clone()
            .unwrap_or_else(|| "it closed".to_owned())
    }

    // Takes the next request id with `answer_sender` waiting on it; fails once closed.
    fn reserve_request(
        &self,
        method: &str,
        answer_sender: oneshot::Sender<RequestAnswer>,
    ) -> Result<PendingRequestSlot<'_>, CodexError> {
        let mut state = self.lock_state();
        if let Some(reason) = &state.close_reason {
            return Err(CodexError::Transport {
                detail: format!(
                    "Cannot send \"{method}\": the Codex service connection is closed: {reason}"
                ),
                cause: None,
            });
        }
        let request_id = state.next_request_id;
        state.next_request_id += 1;
        state.pending.insert(request_id, answer_sender);
        Ok(PendingRequestSlot {
            shared: self,
            request_id,
        })
    }

    async fn send_text(&self, method: &str, text: String) -> Result<(), CodexError> {
        let mut writer = self.writer.lock().await;
        let Some(writer) = writer.as_mut() else {
            return Err(CodexError::Transport {
                detail: format!(
                    "Cannot send \"{method}\": the Codex service connection is closed: {}",
                    self.close_reason()
                ),
                cause: None,
            });
        };
        writer.send_text(method, text).await
    }

    // Marks the connection closed with `reason`: every waiting request's sender is dropped, which
    // fails it with a transport error, and every held ask is reported let go of. Answers whether
    // this call closed it.
    fn mark_closed(&self, reason: &str) -> bool {
        let (pending, dropped) = {
            let mut state = self.lock_state();
            if state.close_reason.is_some() {
                return false;
            }
            state.close_reason = Some(reason.to_owned());
            state.answering.clear();
            let dropped: Vec<CodexForgottenRequest> = state
                .held
                .drain()
                .map(|(request_id, held)| read_dropped_request(request_id, &held))
                .collect();
            (std::mem::take(&mut state.pending), dropped)
        };
        drop(pending);
        if !dropped.is_empty() {
            self.events.held_requests_dropped(dropped);
        }
        true
    }

    // The socket closed: a close the daemon did not ask for is a drop.
    fn handle_socket_closed(&self, reason: &str) {
        if self.mark_closed(reason) {
            self.events.dropped(reason);
        }
    }

    // Reads one message and hands it on; one that is no JSON-RPC message is reported by why and
    // how long it is, never by its content.
    fn receive(self: &Arc<Self>, bytes: &[u8]) {
        if self.lock_state().close_reason.is_some() {
            return;
        }
        let text = decode_inbound_json(bytes);
        let frame = match read_frame(&text) {
            Ok(frame) => frame,
            Err(reason) => {
                report_unparsable(reason, &text);
                return;
            }
        };
        let Some(method) = read_member::<String>(frame.method.as_deref()) else {
            self.receive_response(frame, &text);
            return;
        };
        let params = frame.params.unwrap_or_else(|| RawValue::NULL.to_owned());
        let Some(id) = frame.id else {
            self.events.notification(&method, params);
            return;
        };
        match CodexRoutedMethod::from_method(&method) {
            Some(routed) => {
                // Handed to the responder here, on the reader, so the ask reaches its session in
                // its place among the frames around it; only the wait for its answer is spawned.
                let decision = self.decide_routed_request(&id, routed, &params);
                tokio::spawn(Arc::clone(self).answer_routed_request(id, routed, params, decision));
            }
            None => {
                tokio::spawn(Arc::clone(self).refuse_unrouted_request(id, method));
            }
        }
    }

    fn receive_response(&self, frame: InboundFrame, text: &str) {
        let id = frame
            .id
            .and_then(|id| serde_json::from_str::<JsonRpcId>(id.get()).ok());
        let response_id = match id {
            Some(JsonRpcId::Number(number)) => number.to_string(),
            Some(JsonRpcId::String(id_text)) => id_text,
            Some(JsonRpcId::Null) | None => {
                report_unparsable(CodexUnparsableMessageReason::ResponseWithoutId, text);
                return;
            }
        };
        // Matched as text, so an id the service sent back as a string still finds its request.
        let answer_sender = response_id
            .parse::<u64>()
            .ok()
            .filter(|request_id| request_id.to_string() == response_id)
            .and_then(|request_id| self.lock_state().pending.remove(&request_id));
        let Some(answer_sender) = answer_sender else {
            CodexTransportDiagnostic::UnknownResponseId { response_id }.report();
            return;
        };
        let answer = match frame.error {
            Some(error) => {
                let error = read_codex_object::<InboundError>(error.get());
                let reason = error
                    .as_ref()
                    .and_then(|error| error.data.as_deref())
                    .and_then(|data| read_codex_object::<InboundErrorData>(data.get()))
                    .and_then(|data| read_member::<String>(data.reason.as_deref()));
                Err(ErrorAnswer {
                    code: error
                        .as_ref()
                        .and_then(|error| read_member::<i64>(error.code.as_deref()))
                        .unwrap_or(0),
                    message: error
                        .and_then(|error| read_member::<String>(error.message.as_deref()))
                        .unwrap_or_default(),
                    reason,
                })
            }
            None => Ok(frame.result.unwrap_or_else(|| RawValue::NULL.to_owned())),
        };
        if answer_sender.send(answer).is_err() {
            // The request stopped waiting between its answer's arrival and its delivery.
            CodexTransportDiagnostic::UnknownResponseId { response_id }.report();
        }
    }
}

/// Reads `json`, text the service sent, into `Shape` when it is a JSON object, and `None`
/// otherwise: serde would read an array into a struct by position, so anything but an object, or
/// an object whose members do not read as `Shape` names them, is none.
pub(crate) fn read_codex_object<Shape: DeserializeOwned>(json: &str) -> Option<Shape> {
    let text = decode_inbound_json(json.as_bytes());
    if !is_json_object_text(&text) {
        return None;
    }
    serde_json::from_str(&text).ok()
}

// Whether `text` holds a JSON object, by its first byte past JSON's whitespace.
fn is_json_object_text(text: &str) -> bool {
    text.trim_start_matches([' ', '\t', '\n', '\r'])
        .starts_with('{')
}

// One member read as `Member`, `None` when absent or of another type.
fn read_member<Member: DeserializeOwned>(raw: Option<&RawValue>) -> Option<Member> {
    raw.and_then(|raw| serde_json::from_str(raw.get()).ok())
}

// A message read as a frame, or why it is none. serde's own error is dropped on purpose: it can
// quote the frame's content, which no diagnostic carries.
fn read_frame(text: &str) -> Result<InboundFrame, CodexUnparsableMessageReason> {
    if !is_json_object_text(text) {
        return Err(match serde_json::from_str::<IgnoredAny>(text) {
            Ok(_) => CodexUnparsableMessageReason::NotAnObject,
            Err(_not_json) => CodexUnparsableMessageReason::NotJson,
        });
    }
    match serde_json::from_str(text) {
        Ok(frame) => Ok(frame),
        Err(_not_json) => Err(CodexUnparsableMessageReason::NotJson),
    }
}

fn report_unparsable(reason: CodexUnparsableMessageReason, text: &str) {
    CodexTransportDiagnostic::UnparsableMessage {
        reason,
        character_count: text.chars().count(),
    }
    .report();
}

#[cfg(test)]
mod tests;
