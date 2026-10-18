//! The desktop's Node-API addon, loaded in its client helper: one connection to the daemon, one
//! generic call and one generic subscribe that check a request against its method's contract
//! before it is sent, a pane's typing into a shell, and the link's state as it changes. Every
//! failure reaches JavaScript in the wire's own error shape, so the page branches on `data.type`
//! whether the daemon or this addon refused.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use bytes::Bytes;
use futures::StreamExt as _;
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde_json::Value;
use sidekicks_client::daemon_connection::{DaemonConnection, DaemonEndpoint, LinkState};
use sidekicks_client::error::ClientError;
use sidekicks_client::terminal_write::{ShellInput, ShellTarget};
use sidekicks_client::transport::json_rpc::{JsonRpcClient, RawReply, RawRequest};
use sidekicks_client::transport::subscription::Subscription;
use sidekicks_client::untyped_call;
use sidekicks_contracts::jsonrpc::message::JsonRpcError;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::terminal::TerminalId;
use tokio_util::sync::CancellationToken;

/// A JavaScript callback the addon calls from its own threads, its value passed as the one
/// argument and its return awaited, so a stream waits for the page before it takes the next value.
type Callback<T> = ThreadsafeFunction<T, (), T, napi::Status, false>;

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
    client: JsonRpcClient,
    connection: tokio::sync::Mutex<Option<DaemonConnection>>,
    /// The cancel of each call the page may still cancel, by the page's call id.
    calls: Mutex<HashMap<u32, CancellationToken>>,
    /// The cancel of each open stream, by the id the addon gave it; a stream leaves it as it ends.
    streams: Arc<Mutex<HashMap<u32, CancellationToken>>>,
    next_stream_id: AtomicU32,
}

/// Connects to the daemon on this machine and completes its handshake; `on_link_state` hears
/// `connected`, `quiet` and `lost` as the link changes. Fails with the wire-shaped error's text
/// when the daemon cannot be reached or refuses the handshake.
#[napi]
pub async fn connect(on_link_state: Callback<String>) -> napi::Result<DaemonClient> {
    let endpoint = DaemonEndpoint::this_machine().map_err(|error| {
        napi::Error::from_reason(format!(
            "This system has no run folder for the service: {error}"
        ))
    })?;
    let connection = DaemonConnection::connect(endpoint)
        .await
        .map_err(|error| napi::Error::from_reason(wire_error(&error).to_string()))?;
    let mut link_state = connection.link_state();
    tokio::spawn(async move {
        while link_state.changed().await.is_ok() {
            let state = match *link_state.borrow_and_update() {
                LinkState::Connected => "connected",
                LinkState::Quiet => "quiet",
                LinkState::Lost => "lost",
            };
            let status =
                on_link_state.call(state.to_owned(), ThreadsafeFunctionCallMode::NonBlocking);
            if status != napi::Status::Ok {
                tracing::warn!(?status, "The page did not take the link's state");
            }
        }
    });
    Ok(DaemonClient {
        client: connection.client().clone(),
        connection: tokio::sync::Mutex::new(Some(connection)),
        calls: Mutex::new(HashMap::new()),
        streams: Arc::new(Mutex::new(HashMap::new())),
        next_stream_id: AtomicU32::new(0),
    })
}

#[napi]
impl DaemonClient {
    /// Calls `method` with `params_json` and its attachments, after checking the params against the
    /// method's contract; `call_id` is the page's own, for `cancel_call`. A refused check answers
    /// `request.paramsInvalid` without sending anything.
    #[napi]
    pub async fn call(
        &self,
        call_id: u32,
        method: String,
        params_json: String,
        attachments: Vec<Buffer>,
    ) -> CallOutcome {
        let request = match checked_request(method, params_json, attachments, false) {
            Ok(request) => request,
            Err(error) => {
                return CallOutcome {
                    reply: None,
                    error: Some(error),
                };
            }
        };
        let cancel = CancellationToken::new();
        lock(&self.calls).insert(call_id, cancel.clone());
        let answer = self.client.call_raw(request, &cancel).await;
        lock(&self.calls).remove(&call_id);
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
        on_event: Callback<StreamEvent>,
    ) -> SubscribeOutcome {
        let refused = |error| SubscribeOutcome {
            stream_id: None,
            acknowledgment: None,
            error: Some(error),
        };
        let request = match checked_request(method, params_json, attachments, true) {
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
    /// error shape. Fails when an id is malformed.
    #[napi]
    pub fn open_shell_input(
        &self,
        session_id: String,
        terminal_id: String,
        output_subscription_id: String,
        on_failure: Callback<Value>,
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

    /// Opens a lost link again now.
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
    input: ShellInput,
}

#[napi]
impl ShellInputHandle {
    /// Types `keys` into the shell, in order with every earlier key.
    #[napi(catch_unwind)]
    pub fn type_keys(&self, keys: String) {
        self.input.type_keys(&keys);
    }
}

/// Hands each value of `subscription` to `on_event`, waiting for the page's callback each time,
/// until it ends or `cancel` fires, then sends the end.
async fn forward_stream(
    mut subscription: Subscription<RawReply>,
    on_event: Callback<StreamEvent>,
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

fn wire_value(error: &JsonRpcError) -> Value {
    serde_json::to_value(error).expect("a JSON-RPC error writes as JSON")
}

/// The request for `method`, checked against its contract, or its refusal as the page reads it.
fn checked_request(
    method: String,
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

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
