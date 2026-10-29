//! A Codex service the tests script: a connection started on in-memory socket halves, what it sends
//! read back as JSON, and what the service sends written in.

use futures::future::BoxFuture;
#[cfg(test)]
use serde_json::Value;
use tokio::sync::mpsc;
#[cfg(test)]
use tokio_tungstenite::tungstenite::Bytes;

use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::{
    CodexAppServerConnection, CodexConnectionHandlers, ServiceMessageReader, ServiceMessageWriter,
};
use crate::driver::codex::transport::socket::CodexSocketEvent;

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
