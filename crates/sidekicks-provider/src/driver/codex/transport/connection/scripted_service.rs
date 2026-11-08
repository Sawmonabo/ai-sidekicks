//! A Codex service the tests script: a connection started on in-memory socket halves, what it sends
//! read back as JSON, and what the service sends written in.

use futures::future::BoxFuture;
#[cfg(test)]
use std::sync::Arc;
#[cfg(test)]
use std::time::Duration;

#[cfg(test)]
use serde_json::Value;
#[cfg(test)]
use sidekicks_std::port_registration::PortRegistration;
use tokio::sync::mpsc;
#[cfg(test)]
use tokio_tungstenite::tungstenite::Bytes;

#[cfg(test)]
use crate::driver::codex::session::detached_conversation::{
    CodexDetachedFrame, CodexDetachedFrames,
};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{
    CodexAppServerConnection, CodexConnectionHandlers, ServiceMessageReader, ServiceMessageWriter,
};
use crate::driver::codex::transport::socket::CodexSocketEvent;

/// The largest message a test's scripted service takes, far above any a test sends.
pub(crate) const SCRIPTED_MESSAGE_LIMIT: usize = 1 << 20;

/// The connection's socket as a test drives it: what the connection sent arrives on `sent`, and
/// what the service sends goes in through `inbound`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's restart test reads and answers what the service sent"
    )
)]
pub(crate) struct ScriptedService {
    /// What the connection sent, in order.
    pub(crate) sent: mpsc::UnboundedReceiver<String>,
    /// What the service sends the connection.
    inbound: mpsc::UnboundedSender<CodexSocketEvent>,
}

#[cfg(test)]
impl ScriptedService {
    /// The next message the connection sent, as JSON; panics when the connection ended first.
    pub(crate) async fn next_sent(&mut self) -> Value {
        let text = self
            .sent
            .recv()
            .await
            .expect("the connection sent a message");
        serde_json::from_str(&text).expect("the connection sends JSON")
    }

    /// The next message the connection sent within `wait`, as JSON; `None` when it sent none.
    pub(crate) async fn next_sent_within(&mut self, wait: Duration) -> Option<Value> {
        tokio::time::timeout(wait, self.next_sent()).await.ok()
    }

    /// Sends the connection `message`.
    pub(crate) fn send(&self, message: &Value) {
        self.inbound
            .send(CodexSocketEvent::Message(Bytes::from(message.to_string())))
            .expect("the connection reads");
    }

    /// Answers the request `request` the connection sent with `result`.
    pub(crate) fn answer(&self, request: &Value, result: &Value) {
        self.send(&serde_json::json!({ "jsonrpc": "2.0", "id": request["id"], "result": result }));
    }

    /// Closes the socket from the service's side with `reason`.
    pub(super) fn close(&self, reason: &str) {
        self.inbound
            .send(CodexSocketEvent::Closed {
                reason: reason.to_owned(),
            })
            .expect("the connection reads");
    }
}

/// Starts a connection on a scripted service that takes messages up to `limit` bytes.
pub(crate) fn connect_scripted_service(
    limit: usize,
    handlers: CodexConnectionHandlers,
) -> (CodexAppServerConnection, ScriptedService) {
    let (sent_sender, sent) = mpsc::unbounded_channel();
    let (inbound, inbound_receiver) = mpsc::unbounded_channel();
    let connection = CodexAppServerConnection::start(
        Box::new(ScriptedWriter {
            sent: sent_sender,
            limit,
        }),
        Box::new(ScriptedReader {
            inbound: inbound_receiver,
        }),
        handlers,
    );
    (connection, ScriptedService { sent, inbound })
}

/// A connection on a scripted service that takes messages up to [`SCRIPTED_MESSAGE_LIMIT`], with no
/// responder and no token refresher, the script, and where the connection's notifications arrive.
#[cfg(test)]
pub(crate) fn scripted_connection() -> (
    CodexAppServerConnection,
    ScriptedService,
    mpsc::UnboundedReceiver<CodexDetachedFrame>,
) {
    let (events, frames) = CodexDetachedFrames::new();
    let (connection, script) = connect_scripted_service(
        SCRIPTED_MESSAGE_LIMIT,
        CodexConnectionHandlers {
            events,
            responder: None,
            token_refresher: None,
            raw_messages: Arc::new(PortRegistration::new("raw provider messages")),
        },
    );
    (connection, script, frames)
}

struct ScriptedWriter {
    sent: mpsc::UnboundedSender<String>,
    limit: usize,
}

impl ServiceMessageWriter for ScriptedWriter {
    fn sent_message_byte_limit(&self) -> usize {
        self.limit
    }

    fn send_text<'call>(
        &'call mut self,
        _method: &'call str,
        text: String,
    ) -> BoxFuture<'call, Result<(), CodexError>> {
        Box::pin(async move {
            self.sent.send(text).map_err(|error| CodexError::Transport {
                detail: "the test's service stopped reading".to_owned(),
                cause: Some(Box::new(error)),
            })
        })
    }

    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), CodexError>> {
        Box::pin(async { Ok(()) })
    }
}

struct ScriptedReader {
    inbound: mpsc::UnboundedReceiver<CodexSocketEvent>,
}

impl ServiceMessageReader for ScriptedReader {
    fn receive(&mut self) -> BoxFuture<'_, Result<CodexSocketEvent, CodexError>> {
        Box::pin(async move {
            Ok(self
                .inbound
                .recv()
                .await
                .unwrap_or_else(|| CodexSocketEvent::Closed {
                    reason: "the test ended".to_owned(),
                }))
        })
    }
}
