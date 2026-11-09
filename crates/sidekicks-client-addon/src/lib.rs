//! The desktop's Node-API addon, loaded in its client helper: one connection to the daemon, one
//! generic call and one generic subscribe that check a request against its method's contract
//! before it is sent, a pane's typing into a shell, and the link's state as it changes; and, for
//! main, the client's one ending of the daemon's process and the bounds a start waits within.
//! Every failure reaches JavaScript in the wire's own error shape, so the page branches on
//! `data.type` whether the daemon or this addon refused.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use bytes::Bytes;
use futures::StreamExt as _;
use napi::Env;
use napi::bindgen_prelude::{AsyncBlock, AsyncBlockBuilder, Buffer};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde_json::Value;
use sidekicks_client::DAEMON_FLUSH_WAIT;
use sidekicks_client::daemon_connection::handshake_wait::{FIRST_PAUSE, LONGEST_PAUSE};
use sidekicks_client::daemon_connection::{
    ConnectionState, DaemonConnection, DaemonEndpoint, HANDSHAKE_DEADLINE,
};
use sidekicks_client::daemon_ending::{
    self, DaemonEnd, DaemonEndingError, DaemonEndingTerms, DaemonEndingVerb, end_unanswered_process,
};
use sidekicks_client::error::ClientError;
use sidekicks_client::terminal_write::{ShellInput, ShellTarget};
use sidekicks_client::transport::json_rpc::{JsonRpcClient, RawReply, RawRequest};
use sidekicks_client::transport::subscription::Subscription;
use sidekicks_client::untyped_call;
use sidekicks_contracts::jsonrpc::message::JsonRpcError;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::process_identity::ProcessIdentity;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::TerminalId;
use sidekicks_platforms::{ChildEnd, pin_identified_process};
use tokio_util::sync::CancellationToken;

/// How long a connect waits for the daemon's answer to its handshake, in milliseconds; a start
/// waits this long for a daemon it started.
#[napi]
pub const HANDSHAKE_DEADLINE_MS: u32 = millis(HANDSHAKE_DEADLINE);

/// The first pause, in milliseconds, between handshakes tried with a daemon that is starting;
/// each pause after it doubles, up to [`HANDSHAKE_RETRY_LONGEST_PAUSE_MS`].
#[napi]
pub const HANDSHAKE_RETRY_FIRST_PAUSE_MS: u32 = millis(FIRST_PAUSE);

/// The longest pause, in milliseconds, between handshakes tried with a daemon that is starting.
#[napi]
pub const HANDSHAKE_RETRY_LONGEST_PAUSE_MS: u32 = millis(LONGEST_PAUSE);

/// How long a quit, a stop or a restart waits for the daemon's answer to `daemon.flush`, in
/// milliseconds, before it goes ahead without it.
#[napi]
pub const DAEMON_FLUSH_WAIT_MS: u32 = millis(DAEMON_FLUSH_WAIT);

/// An answer's JSON text and the attachments its `{"$bytes": n}` placeholders index.
#[napi(object)]
pub struct WireReply {
    /// The JSON text.
    pub json: String,
    /// The attachments, in placeholder order.
    pub attachments: Vec<Buffer>,
}

/// A call's outcome: its reply, or its error in the wire's shape (`code`, `message`, `data`).
#[napi(object)]
pub struct CallOutcome {
    /// The reply, when the call succeeded.
    pub reply: Option<WireReply>,
    /// The error, when it failed.
    pub error: Option<Value>,
}

/// A connect's outcome: the connection, or its error in the wire's shape.
#[napi(object, object_from_js = false)]
pub struct ConnectOutcome {
    /// The connection, when the handshake completed.
    pub client: Option<DaemonClient>,
    /// The error, when it failed.
    pub error: Option<Value>,
}

/// A subscribe's outcome: the stream's id and its acknowledgment, or its error in the wire's shape.
#[napi(object)]
pub struct SubscribeOutcome {
    /// The id `cancel_stream` takes, when the subscribe succeeded.
    pub stream_id: Option<u32>,
    /// The acknowledgment, when the subscribe succeeded.
    pub acknowledgment: Option<WireReply>,
    /// The error, when it failed.
    pub error: Option<Value>,
}

/// One event of a stream: a value, or its end, with the error it ended for when it failed.
#[napi(object)]
pub struct StreamEvent {
    /// A value the stream carried.
    pub value: Option<WireReply>,
    /// Whether the stream ended; no event follows.
    pub is_end: bool,
    /// The error the stream ended for, in the wire's shape.
    pub error: Option<Value>,
}

/// The connection to the daemon the client helper holds.
#[napi]
pub struct DaemonClient {
    /// The typed client over the connection's link.
    client: JsonRpcClient,
    /// The connection, taken out once by `close`.
    connection: tokio::sync::Mutex<Option<DaemonConnection>>,
    /// The cancel of each call the page may still cancel, by the page's call id.
    calls: Arc<Mutex<HashMap<u32, CancellationToken>>>,
    /// The cancel of each open stream, by the id the addon gave it; a stream leaves it as it ends.
    streams: Arc<Mutex<HashMap<u32, CancellationToken>>>,
    /// The id the next stream takes.
    next_stream_id: AtomicU32,
}

/// What main asks the daemon before the client ends its process.
#[napi(string_enum = "lowercase")]
pub enum DaemonEndingRequest {
    /// `daemon.stop`.
    Stop,
    /// `daemon.restart`; main starts the daemon again once it has ended.
    Restart,
}

/// Which end took effect.
#[napi(string_enum = "camelCase")]
pub enum DaemonEnded {
    /// Nothing answered at the daemon's socket: no daemon was running.
    NotRunning,
    /// A daemon repairing its database file took the request on the link it refused.
    StoppedWhileRepairing,
    /// The daemon's process ended by itself within the drain bound.
    Exited,
    /// The daemon's process ended on the terminate signal.
    Stopped,
    /// The daemon's process was killed once its grace passed.
    Killed,
    /// The process the daemon ran as is not running now, so nothing was signaled.
    ProcessNotFound,
}

/// An ending's outcome: which end took effect, or its error in the wire's shape.
#[napi(object)]
pub struct DaemonEndingOutcome {
    /// The end, when the ending succeeded.
    pub end: Option<DaemonEnded>,
    /// The error, when it failed.
    pub error: Option<Value>,
}

/// Connects to the daemon on this machine and completes its handshake, presenting the token file's
/// token when `presents_token` holds and none otherwise; `on_state` hears `open`, `quiet`,
/// `reconnecting` and `down` as the connection changes. Answers the error in the wire's shape when
/// the daemon cannot be reached or refuses the handshake.
#[napi]
pub async fn connect(
    presents_token: bool,
    on_state: ThreadsafeFunction<String, (), String, napi::Status, false>,
) -> ConnectOutcome {
    let refused = |error| ConnectOutcome {
        client: None,
        error: Some(error),
    };
    let endpoint = match this_machine(presents_token) {
        Ok(endpoint) => endpoint,
        Err(error) => return refused(error),
    };
    let connection = match DaemonConnection::connect(endpoint).await {
        Ok(connection) => connection,
        Err(error) => return refused(wire_error(&error)),
    };
    let mut states = connection.state_changes();
    tokio::spawn(async move {
        while states.changed().await.is_ok() {
            let state = match *states.borrow_and_update() {
                ConnectionState::Open => "open",
                ConnectionState::Quiet => "quiet",
                ConnectionState::Reconnecting => "reconnecting",
                ConnectionState::Down => "down",
            };
            let status = on_state.call(state.to_owned(), ThreadsafeFunctionCallMode::NonBlocking);
            if status != napi::Status::Ok {
                tracing::warn!(?status, "The page did not take the connection's state");
            }
        }
    });
    ConnectOutcome {
        client: Some(DaemonClient {
            client: connection.client().clone(),
            connection: tokio::sync::Mutex::new(Some(connection)),
            calls: Arc::new(Mutex::new(HashMap::new())),
            streams: Arc::new(Mutex::new(HashMap::new())),
            next_stream_id: AtomicU32::new(0),
        }),
        error: None,
    }
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "Node-API hands a JavaScript string to the addon as an owned String"
)]
#[napi]
impl DaemonClient {
    /// Calls `method` with `params_json` and its attachments, after checking the params against the
    /// method's contract; `call_id` is the page's own, for `cancel_call`, which reaches the call as
    /// soon as this returns. A refused check answers `request.paramsInvalid` without sending
    /// anything.
    #[napi(catch_unwind)]
    pub fn call(
        &self,
        env: Env,
        call_id: u32,
        method: String,
        params_json: String,
        attachments: Vec<Buffer>,
    ) -> napi::Result<AsyncBlock<CallOutcome>> {
        let checked = checked_request(&method, params_json, attachments, false);
        let answer = checked.map(|request| {
            let cancel = CancellationToken::new();
            lock(&self.calls).insert(call_id, cancel.clone());
            self.client.call_raw(request, &cancel)
        });
        let calls = Arc::clone(&self.calls);
        AsyncBlockBuilder::new(async move {
            let outcome = match answer {
                Err(error) => CallOutcome {
                    reply: None,
                    error: Some(error),
                },
                Ok(answer) => {
                    let answer = answer.await;
                    lock(&calls).remove(&call_id);
                    match answer {
                        Ok(reply) => CallOutcome {
                            reply: Some(wire_reply(reply)),
                            error: None,
                        },
                        Err(error) => CallOutcome {
                            reply: None,
                            error: Some(wire_error(&error)),
                        },
                    }
                }
            };
            Ok(outcome)
        })
        .build(&env)
    }

    /// Cancels the call the page numbered `call_id`: one still held settles canceled with nothing
    /// sent, and one in flight asks the daemon to stop it and settles from its answer.
    #[napi(catch_unwind)]
    pub fn cancel_call(&self, call_id: u32) {
        if let Some(cancel) = lock(&self.calls).get(&call_id) {
            cancel.cancel();
        }
    }

    /// Opens a subscription to `method` after checking its params; each value and the end go to
    /// `on_event`, the next value taken only once the page's callback returned.
    #[napi]
    pub async fn subscribe(
        &self,
        method: String,
        params_json: String,
        attachments: Vec<Buffer>,
        on_event: ThreadsafeFunction<StreamEvent, (), StreamEvent, napi::Status, false>,
    ) -> SubscribeOutcome {
        let refused = |error| SubscribeOutcome {
            stream_id: None,
            acknowledgment: None,
            error: Some(error),
        };
        let request = match checked_request(&method, params_json, attachments, true) {
            Ok(request) => request,
            Err(error) => return refused(error),
        };
        let (acknowledgment, subscription) = match self.client.subscribe_raw(request).await {
            Ok(opened) => opened,
            Err(error) => return refused(wire_error(&error)),
        };
        let stream_id = self.next_stream_id.fetch_add(1, Ordering::Relaxed);
        let cancel = CancellationToken::new();
        lock(&self.streams).insert(stream_id, cancel.clone());
        let streams = Arc::clone(&self.streams);
        tokio::spawn(async move {
            forward_stream(subscription, on_event, cancel).await;
            lock(&streams).remove(&stream_id);
        });
        SubscribeOutcome {
            stream_id: Some(stream_id),
            acknowledgment: Some(wire_reply(acknowledgment)),
            error: None,
        }
    }

    /// Cancels the stream `stream_id` on the daemon; its end event follows.
    #[napi(catch_unwind)]
    pub fn cancel_stream(&self, stream_id: u32) {
        if let Some(cancel) = lock(&self.streams).remove(&stream_id) {
            cancel.cancel();
        }
    }

    /// Opens a pane's input to one shell; a write that fails goes to `on_failure` in the wire's
    /// error shape. Fails when an id is malformed. It runs inside the addon's runtime, which every
    /// write's answer is awaited on.
    #[napi(catch_unwind, async_runtime)]
    pub fn open_shell_input(
        &self,
        session_id: String,
        terminal_id: String,
        output_subscription_id: String,
        on_failure: ThreadsafeFunction<Value, (), Value, napi::Status, false>,
    ) -> napi::Result<ShellInputHandle> {
        let target = ShellTarget {
            session_id: SessionId::new(&session_id)
                .map_err(|error| napi::Error::from_reason(format!("session id: {error}")))?,
            terminal_id: TerminalId::new(terminal_id)
                .ok_or_else(|| napi::Error::from_reason("the terminal id is malformed"))?,
            output_subscription_id: SubscriptionId::new(&output_subscription_id)
                .map_err(|error| napi::Error::from_reason(format!("subscription id: {error}")))?,
        };
        let (input, mut failures) = ShellInput::new(self.client.clone(), target);
        tokio::spawn(async move {
            while let Some(failure) = failures.recv().await {
                if let Err(error) = on_failure.call_async(wire_error(&failure)).await {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "The page did not take a failed write to a shell"
                    );
                }
            }
        });
        Ok(ShellInputHandle { input })
    }

    /// Starts the reconnect schedule again once the connection is down.
    #[napi(catch_unwind)]
    pub fn retry(&self) {
        if let Ok(connection) = self.connection.try_lock()
            && let Some(connection) = connection.as_ref()
        {
            connection.retry();
        }
    }

    /// Closes the connection; every call still waiting settles `connection.unavailable` and every
    /// stream ends.
    #[napi]
    pub async fn close(&self) {
        if let Some(connection) = self.connection.lock().await.take() {
            connection.close().await;
        }
    }
}

/// A pane's input to one shell.
#[napi]
pub struct ShellInputHandle {
    /// The shell's input, shared with the pane's other handles.
    input: ShellInput,
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "Node-API hands a JavaScript string to the addon as an owned String"
)]
#[napi]
impl ShellInputHandle {
    /// Types `keys` into the shell, in order with every earlier key.
    #[napi(catch_unwind)]
    pub fn type_keys(&self, keys: String) {
        self.input.type_keys(&keys);
    }
}

/// Ends the daemon on this machine through the client's one ending: a flush, then `request`, then
/// the daemon's own drain bound, then the terminate signal, and the kill once its grace passes;
/// the handshake presents the token as `connect` does. Answers which end took effect, or the
/// error in the wire's shape.
#[napi]
pub async fn end_daemon(request: DaemonEndingRequest, presents_token: bool) -> DaemonEndingOutcome {
    let verb = match request {
        DaemonEndingRequest::Stop => DaemonEndingVerb::Stop,
        DaemonEndingRequest::Restart => DaemonEndingVerb::Restart,
    };
    let ended = match this_machine(presents_token) {
        Ok(endpoint) => daemon_ending::end_daemon(endpoint, verb, &DaemonEndingTerms::default())
            .await
            .map_err(|error| ending_error(&error)),
        Err(error) => Err(error),
    };
    ending_outcome(ended.map(|end| match end {
        DaemonEnd::NotRunning => DaemonEnded::NotRunning,
        DaemonEnd::StoppedWhileRepairing => DaemonEnded::StoppedWhileRepairing,
        DaemonEnd::Exited => DaemonEnded::Exited,
        DaemonEnd::Ended(end) => child_ended(end),
        DaemonEnd::ProcessNotFound => DaemonEnded::ProcessNotFound,
    }))
}

/// Ends the daemon's process `process_identity_json` names, for a link that died: the terminate
/// signal at once, and the kill once the drain bound and the grace have passed. A process that
/// is not running, or holds the id but is another, is never signaled. Answers which end took
/// effect, or the error in the wire's shape.
#[napi]
pub async fn end_daemon_process(process_identity_json: String) -> DaemonEndingOutcome {
    let ended = async {
        let identity = serde_json::from_str::<ProcessIdentity>(&process_identity_json)
            .map_err(|error| ending_error(&DaemonEndingError::Identity(error)))?;
        let Some(process) = pin_identified_process(&identity)
            .map_err(|error| ending_error(&DaemonEndingError::Pin(error)))?
        else {
            return Ok(DaemonEnded::ProcessNotFound);
        };
        end_unanswered_process(&DaemonEndingTerms::default(), process)
            .await
            .map(child_ended)
            .map_err(|error| ending_error(&error))
    };
    ending_outcome(ended.await)
}

/// The endpoint of the daemon on this machine, presenting the token when `presents_token` holds,
/// or its failure in the wire's shape.
fn this_machine(presents_token: bool) -> Result<DaemonEndpoint, Value> {
    DaemonEndpoint::this_machine()
        .map(|endpoint| endpoint.presenting_token(presents_token))
        .map_err(|error| {
            wire_value(&JsonRpcError::internal(format!(
                "This system has no run folder for the service: {error}"
            )))
        })
}

/// How the system ended a process, as JavaScript reads it.
fn child_ended(end: ChildEnd) -> DaemonEnded {
    match end {
        ChildEnd::Stop => DaemonEnded::Stopped,
        ChildEnd::Kill => DaemonEnded::Killed,
    }
}

/// An ending's failure in the wire's shape: a failed call as the client reads it, any other
/// failure as an internal error with its causes in the message.
fn ending_error(error: &DaemonEndingError) -> Value {
    match error {
        DaemonEndingError::Client(error) => wire_error(error),
        DaemonEndingError::Identity(_)
        | DaemonEndingError::Pin(_)
        | DaemonEndingError::Wait(_)
        | DaemonEndingError::End(_)
        | DaemonEndingError::EndTask(_)
        | DaemonEndingError::RepairingNotEnded { .. } => {
            wire_value(&JsonRpcError::internal(untyped_call::error_text(error)))
        }
    }
}

/// An ending's result as JavaScript reads it.
fn ending_outcome(ended: Result<DaemonEnded, Value>) -> DaemonEndingOutcome {
    match ended {
        Ok(end) => DaemonEndingOutcome {
            end: Some(end),
            error: None,
        },
        Err(error) => DaemonEndingOutcome {
            end: None,
            error: Some(error),
        },
    }
}

/// `duration` in whole milliseconds, as JavaScript reads a wait.
const fn millis(duration: Duration) -> u32 {
    #[expect(
        clippy::cast_possible_truncation,
        reason = "every bound exported is seconds long, far below u32's range"
    )]
    let millis = duration.as_millis() as u32;
    millis
}

/// Hands each value of `subscription` to `on_event`, waiting for the page's callback each time,
/// until it ends or `cancel` fires, then sends the end.
async fn forward_stream(
    mut subscription: Subscription<RawReply>,
    on_event: ThreadsafeFunction<StreamEvent, (), StreamEvent, napi::Status, false>,
    cancel: CancellationToken,
) {
    let end_error = loop {
        let next = tokio::select! {
            () = cancel.cancelled() => break cancel_subscription(&subscription).await,
            next = subscription.next() => next,
        };
        let event = match next {
            None => break None,
            Some(Err(error)) => break Some(wire_error(&error)),
            Some(Ok(value)) => StreamEvent {
                value: Some(wire_reply(value)),
                is_end: false,
                error: None,
            },
        };
        if let Err(error) = on_event.call_async(event).await {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "The page did not take a stream's value; the stream is canceled"
            );
            break cancel_subscription(&subscription).await;
        }
    };
    let end = StreamEvent {
        value: None,
        is_end: true,
        error: end_error,
    };
    let status = on_event.call(end, ThreadsafeFunctionCallMode::NonBlocking);
    if status != napi::Status::Ok {
        tracing::warn!(?status, "The page did not take a stream's end");
    }
}

/// Cancels `subscription` on the daemon, answering the cancel's failure in the wire's shape.
async fn cancel_subscription(subscription: &Subscription<RawReply>) -> Option<Value> {
    subscription
        .cancel()
        .await
        .err()
        .map(|error| wire_error(&error))
}

/// A client failure as the wire-shaped JSON value the page reads.
fn wire_error(error: &ClientError) -> Value {
    wire_value(&untyped_call::wire_error(error))
}

/// A JSON-RPC error as the JSON value the page reads.
fn wire_value(error: &JsonRpcError) -> Value {
    serde_json::to_value(error).expect("a JSON-RPC error writes as JSON")
}

/// The request for `method`, checked against its contract, or its refusal as the page reads it.
fn checked_request(
    method: &str,
    params_json: String,
    attachments: Vec<Buffer>,
    is_subscription: bool,
) -> Result<RawRequest, Value> {
    let attachments = attachments
        .into_iter()
        .map(|attachment| Bytes::from(Vec::<u8>::from(attachment)))
        .collect();
    untyped_call::checked_request(method, params_json, attachments, is_subscription)
        .map_err(|refusal| wire_value(&refusal))
}

/// A reply's JSON text and attachments as the page reads them.
fn wire_reply(reply: RawReply) -> WireReply {
    WireReply {
        json: reply.json.get().to_owned(),
        attachments: reply
            .attachments
            .into_iter()
            .map(|attachment| Buffer::from(attachment.to_vec()))
            .collect(),
    }
}

/// The mutex's guard, a poisoned one included: the maps hold only cancel tokens.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
