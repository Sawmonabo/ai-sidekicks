//! The raw copy of a tool server's replies: each reply to a request the client reads raw is kept
//! by its request id, as the server wrote it, below rmcp's typed decoding, whose result union reads
//! a 2025-11-25 reply as a newer shape and drops what that shape lacks (`capabilities.tasks`,
//! `execution.taskSupport`, a task's `ttl` and `pollInterval`).
//!
//! - Only a reply some caller waits to read raw is kept: the client's own requests (rmcp's
//!   `CustomRequest`) and `initialize`, each noted as it is sent, so a reply nobody takes is never
//!   held.
//! - The stdio tee and the HTTP client both feed it, before rmcp sees the reply, so a reply is
//!   kept before the call waiting on it resolves.

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};

use rmcp::RoleClient;
use rmcp::model::{ClientJsonRpcMessage, ClientRequest, RequestId};
use rmcp::transport::Transport;
use rmcp::transport::async_rw::DEFAULT_MAX_LINE_LENGTH;
use serde_json::Value;
use tokio::io::{AsyncRead, ReadBuf};

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
        self.lock()
            .awaited
            .insert(request.id.clone(), method.to_owned());
    }

    /// Keeps the reply `line` holds when its request is awaited; any other line is passed over.
    pub(super) fn keep_line(&self, line: &[u8]) {
        if self.lock().awaited.is_empty() {
            return;
        }
        if let Ok(message) = serde_json::from_str::<Value>(&decode_inbound_json(line)) {
            self.keep_message(message);
        }
    }

    /// Keeps `message` when it is the reply to an awaited request.
    pub(super) fn keep_message(&self, message: Value) {
        let is_reply = message.get("result").is_some() || message.get("error").is_some();
        let Some(id) = message
            .get("id")
            .filter(|_| is_reply)
            .and_then(|id| serde_json::from_value::<RequestId>(id.clone()).ok())
        else {
            return;
        };
        let mut replies = self.lock();
        if let Some(method) = replies.awaited.remove(&id) {
            replies.kept.insert(id, (method, message));
        }
    }

    /// The kept reply to request `id`, taken out of the copy; `None` when none came.
    pub(super) fn take(&self, id: &RequestId) -> Option<Value> {
        let mut replies = self.lock();
        replies.awaited.remove(id);
        replies.kept.remove(id).map(|(_, message)| message)
    }

    /// The kept reply to the one request sent under `method`, taken out of the copy.
    pub(super) fn take_reply_to(&self, method: &str) -> Option<Value> {
        let mut replies = self.lock();
        let id = replies
            .kept
            .iter()
            .find(|(_, (kept_method, _))| kept_method == method)
            .map(|(id, _)| id.clone())?;
        replies.kept.remove(&id).map(|(_, message)| message)
    }

    // No holder awaits or panics while it changes the maps, so a poisoned lock still guards whole
    // maps.
    fn lock(&self) -> MutexGuard<'_, RawReplies> {
        self.replies.lock().unwrap_or_else(PoisonError::into_inner)
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

/// A stdio server's standard output read through to rmcp unchanged, each line also offered to the
/// raw copy. A line past rmcp's own line bound is not offered, since rmcp drops it too.
pub(super) struct RawLineTee<R> {
    inner: R,
    raw: RawReplyCopy,
    line: Vec<u8>,
    is_discarding: bool,
}

impl<R> RawLineTee<R> {
    /// A tee over `inner` feeding `raw`.
    pub(super) fn new(inner: R, raw: RawReplyCopy) -> Self {
        Self {
            inner,
            raw,
            line: Vec::new(),
            is_discarding: false,
        }
    }

    fn offer(&mut self, bytes: &[u8]) {
        for piece in bytes.split_inclusive(|byte| *byte == b'\n') {
            let (body, is_line_end) = match piece.split_last() {
                Some((b'\n', body)) => (body, true),
                _ => (piece, false),
            };
            if !self.is_discarding {
                if self.line.len() + body.len() > DEFAULT_MAX_LINE_LENGTH {
                    self.line.clear();
                    self.is_discarding = true;
                } else {
                    self.line.extend_from_slice(body);
                }
            }
            if is_line_end {
                if !self.is_discarding {
                    self.raw.keep_line(&self.line);
                }
                self.line.clear();
                self.is_discarding = false;
            }
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
        let before = buffer.filled().len();
        let read = Pin::new(&mut tee.inner).poll_read(context, buffer);
        if let Poll::Ready(Ok(())) = read {
            let filled = buffer.filled()[before..].to_vec();
            tee.offer(&filled);
        }
        read
    }
}
