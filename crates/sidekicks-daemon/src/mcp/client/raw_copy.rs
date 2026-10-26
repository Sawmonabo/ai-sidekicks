//! The raw copy of a tool server's replies: each reply to a request the client reads raw is kept
//! by its request id, as the server wrote it, below rmcp's typed decoding, whose result union reads
//! a 2025-11-25 reply as a newer shape and drops what that shape lacks (`capabilities.tasks`,
//! `execution.taskSupport`, a task's `ttl` and `pollInterval`).
//!
//! - Only a reply some caller waits to read raw is kept: the client's own requests (rmcp's
//!   `CustomRequest`) and `initialize`, each noted as it is sent, so a reply nobody takes is never
//!   held.
//! - The stdio tee and the HTTP client both feed it, before rmcp sees the reply, so a reply is
//!   kept before the call waiting on it resolves; both hand rmcp the same repaired text they keep,
//!   so a lone surrogate escape a server writes never fails rmcp's own read of the message.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, ready};

use rmcp::RoleClient;
use rmcp::model::{ClientJsonRpcMessage, ClientRequest, RequestId};
use rmcp::transport::Transport;
use rmcp::transport::async_rw::DEFAULT_MAX_LINE_LENGTH;
use serde_json::Value;
use tokio::io::{AsyncRead, ReadBuf};

use crate::mutex_lock::lock;
use crate::process_exit::OUTPUT_CHUNK_BYTES;
use crate::provider::inbound_json::decode_inbound_json;

/// The method of the one request rmcp sends itself whose reply the client reads raw.
pub(super) const INITIALIZE_METHOD: &str = "initialize";

/// The replies the client reads raw, shared by a connection's transport and its calls.
#[derive(Clone, Default)]
pub(super) struct RawReplyCopy {
    replies: Arc<Mutex<RawReplies>>,
}

#[derive(Default)]
struct RawReplies {
    /// Each request whose reply is to be kept, with its method.
    awaited: HashMap<RequestId, String>,
    /// Each kept reply, the whole message as the server wrote it, with its request's method.
    kept: HashMap<RequestId, (String, Value)>,
}

impl RawReplyCopy {
    /// Notes `message` as it goes out: a request the client reads raw has its reply kept.
    pub(super) fn note_sent(&self, message: &ClientJsonRpcMessage) {
        let ClientJsonRpcMessage::Request(request) = message else {
            return;
        };
        // Only these two sends read their reply raw; every other request reads rmcp's types.
        let method = if let ClientRequest::CustomRequest(custom) = &request.request {
            custom.method.as_str()
        } else if matches!(request.request, ClientRequest::InitializeRequest(_)) {
            INITIALIZE_METHOD
        } else {
            return;
        };
        lock(&self.replies)
            .awaited
            .insert(request.id.clone(), method.to_owned());
    }

    /// Keeps the reply the repaired `text` holds when its request is awaited; any other text is
    /// passed over.
    pub(super) fn keep_text(&self, text: &str) {
        if lock(&self.replies).awaited.is_empty() {
            return;
        }
        if let Ok(message) = serde_json::from_str::<Value>(text) {
            self.keep_message(message);
        }
    }

    /// Keeps `message` when it is the reply to an awaited request.
    fn keep_message(&self, message: Value) {
        let is_reply = message.get("result").is_some() || message.get("error").is_some();
        let Some(id) = message
            .get("id")
            .filter(|_| is_reply)
            .and_then(|id| serde_json::from_value::<RequestId>(id.clone()).ok())
        else {
            return;
        };
        let mut replies = lock(&self.replies);
        if let Some(method) = replies.awaited.remove(&id) {
            replies.kept.insert(id, (method, message));
        }
    }

    /// The kept reply to request `id`, taken out of the copy; `None` when none came.
    pub(super) fn take(&self, id: &RequestId) -> Option<Value> {
        let mut replies = lock(&self.replies);
        replies.awaited.remove(id);
        replies.kept.remove(id).map(|(_, message)| message)
    }

    /// The kept reply to the one request sent under `method`, taken out of the copy.
    pub(super) fn take_reply_to(&self, method: &str) -> Option<Value> {
        let mut replies = lock(&self.replies);
        let id = replies
            .kept
            .iter()
            .find(|(_, (kept_method, _))| kept_method == method)
            .map(|(id, _)| id.clone())?;
        replies.kept.remove(&id).map(|(_, message)| message)
    }

    /// Whether the copy holds no reply and awaits none.
    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        let replies = lock(&self.replies);
        replies.awaited.is_empty() && replies.kept.is_empty()
    }
}

/// A transport that notes each request it sends in the connection's raw copy, around the
/// transport that carries it.
pub(super) struct RawCopyTransport<T> {
    pub(super) inner: T,
    pub(super) raw: RawReplyCopy,
}

impl<T: Transport<RoleClient>> Transport<RoleClient> for RawCopyTransport<T> {
    type Error = T::Error;

    fn send(
        &mut self,
        item: ClientJsonRpcMessage,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        self.raw.note_sent(&item);
        self.inner.send(item)
    }

    fn receive(
        &mut self,
    ) -> impl Future<Output = Option<rmcp::model::ServerJsonRpcMessage>> + Send {
        self.inner.receive()
    }

    fn close(&mut self) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.inner.close()
    }
}

/// The byte order mark rmcp strips from the start of a line before it reads it.
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

/// A stdio server's standard output as rmcp reads it, one whole line at a time: each line repaired
/// as text a provider sends is, kept in the raw copy, and handed on with its newline. A line past
/// rmcp's own line bound of 16 MiB, its newline counted as rmcp counts it, is dropped, since rmcp
/// drops it too.
pub(super) struct RawLineTee<R> {
    inner: R,
    raw: RawReplyCopy,
    /// The line read so far.
    line: Vec<u8>,
    is_discarding: bool,
    /// Repaired lines not yet handed on, from `handed_on`.
    pending: Vec<u8>,
    handed_on: usize,
    is_ended: bool,
}

impl<R> RawLineTee<R> {
    /// A tee over `inner` feeding `raw`.
    pub(super) fn new(inner: R, raw: RawReplyCopy) -> Self {
        Self {
            inner,
            raw,
            line: Vec::new(),
            is_discarding: false,
            pending: Vec::new(),
            handed_on: 0,
            is_ended: false,
        }
    }

    fn offer(&mut self, bytes: &[u8]) {
        for piece in bytes.split_inclusive(|byte| *byte == b'\n') {
            let (body, is_line_end) = match piece.split_last() {
                Some((b'\n', body)) => (body, true),
                _ => (piece, false),
            };
            if !self.is_discarding {
                if self.line.len() + piece.len() > DEFAULT_MAX_LINE_LENGTH {
                    tracing::warn!("a tool server wrote a line past the client's bound; dropped");
                    self.line.clear();
                    self.is_discarding = true;
                } else {
                    self.line.extend_from_slice(body);
                }
            }
            if is_line_end {
                if !self.is_discarding {
                    self.hand_on_line(true);
                }
                self.line.clear();
                self.is_discarding = false;
            }
        }
    }

    // Repairs the line read so far, keeps it in the raw copy and queues it for rmcp.
    fn hand_on_line(&mut self, is_line_end: bool) {
        let line = self.line.strip_prefix(UTF8_BOM).unwrap_or(&self.line);
        let text = decode_inbound_json(line);
        self.raw.keep_text(&text);
        self.pending.extend_from_slice(text.as_bytes());
        if is_line_end {
            self.pending.push(b'\n');
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for RawLineTee<R> {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let tee = self.get_mut();
        loop {
            if tee.handed_on < tee.pending.len() {
                let waiting = &tee.pending[tee.handed_on..];
                let count = waiting.len().min(buffer.remaining());
                buffer.put_slice(&waiting[..count]);
                tee.handed_on += count;
                if tee.handed_on == tee.pending.len() {
                    tee.pending.clear();
                    tee.handed_on = 0;
                }
                return Poll::Ready(Ok(()));
            }
            if tee.is_ended {
                return Poll::Ready(Ok(()));
            }
            let mut chunk = [0_u8; OUTPUT_CHUNK_BYTES];
            let mut read = ReadBuf::new(&mut chunk);
            ready!(Pin::new(&mut tee.inner).poll_read(context, &mut read))?;
            if read.filled().is_empty() {
                // The output ended: a last line without its newline is handed on as it stands.
                if !tee.is_discarding && !tee.line.is_empty() {
                    tee.hand_on_line(false);
                }
                tee.is_ended = true;
            } else {
                tee.offer(read.filled());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::mcp::client::requests::RequestWait;
    use crate::mcp::client::test_server::{
        Reply, method_not_found, open_test_server, test_client, v1_initialize_result,
    };

    // Mutation: in `RawLineTee::hand_on_line`, hand rmcp the line without `decode_inbound_json`;
    // rmcp then fails to read the reply and the request times out.
    #[tokio::test(start_paused = true)]
    async fn a_reply_holding_a_lone_surrogate_escape_reaches_its_request() {
        let (client, _card) = test_client();
        let (connection, _server) = open_test_server(
            &client,
            Box::new(|method, _params| match method {
                "initialize" => Reply::Answer(json!({ "result": v1_initialize_result() })),
                "tools/list" => Reply::Answer(json!({ "result": { "tools": [] } })),
                "tasks/get" => Reply::Raw(
                    concat!(
                        r#"{"jsonrpc":"2.0","id":{id},"#,
                        r#""result":{"status":"working","statusMessage":"\ud800 queued"}}"#,
                    )
                    .to_owned(),
                ),
                _ => method_not_found(),
            }),
        )
        .await;

        let result = connection
            .requests
            .send_raw(
                "tasks/get",
                Some(json!({ "taskId": "task-1" })),
                RequestWait::Ordinary,
            )
            .await
            .expect("the reply reads");

        assert_eq!(result["statusMessage"], "\u{fffd} queued");
    }
}
