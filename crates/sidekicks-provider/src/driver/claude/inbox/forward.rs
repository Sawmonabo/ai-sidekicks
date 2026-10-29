//! How a frame crosses a session's inbox to its live process, and how Claude Code's answers find
//! their way back: each frame goes on with the daemon's own inbox as its sender, since Claude Code
//! sends a receipt only to a sender socket the writing process itself listens on, and each receipt,
//! idle notice or artifact reply that names a forwarded frame is passed to that frame's original
//! sender, from the session's inbox.

use std::num::NonZeroUsize;
use std::path::PathBuf;
use std::sync::Mutex;

use lru::LruCache;
use serde_json::{Map, Value};
use sidekicks_std::mutex_lock::lock;

use crate::inbound_json::decode_inbound_json;

/// How many forwarded frames' senders are kept for their receipts; a frame older than that gets
/// its receipt no more, as Claude Code's own sender gives up waiting long before.
const RECEIPT_ROUTE_MEMORY: NonZeroUsize = NonZeroUsize::new(4096).expect("the memory is not zero");

/// The prefix of a sender address on a local socket.
const SOCKET_ADDRESS_PREFIX: &str = "uds:";

/// The `type` of the line a sender proves itself with, which the daemon's own connection to the
/// live process does not need.
const AUTH_FRAME_TYPE: &str = "auth";

/// The member Claude Code names a frame it answers by.
const ANSWERED_FRAME_MEMBER: &str = "orig_msg_id";

/// Where an answer to one forwarded frame goes: the frame's original sender, written to from the
/// session's inbox it was sent to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ClaudeReceiptRoute {
    /// The original sender's socket.
    pub(crate) sender_socket: PathBuf,
    /// The session inbox's address, the answer's sender.
    pub(crate) session_inbox: String,
}

/// The senders of the frames forwarded lately, by the frame's message id, which Claude Code's
/// answers name.
pub(crate) struct ClaudeInboxForwarding {
    daemon_inbox: String,
    receipt_routes: Mutex<LruCache<String, ClaudeReceiptRoute>>,
}

impl ClaudeInboxForwarding {
    /// The forwarding whose frames name `daemon_inbox`, the daemon's own inbox, as their sender.
    pub(crate) fn new(daemon_inbox: String) -> Self {
        Self {
            daemon_inbox,
            receipt_routes: Mutex::new(LruCache::new(RECEIPT_ROUTE_MEMORY)),
        }
    }

    /// The line to write to the live process for one line `session_inbox` received: a frame with
    /// a sender and a message id goes on with the daemon's inbox as its sender, its sender kept for
    /// the answers; a sender's proof is dropped, `None`; any other line goes on as it came.
    pub(crate) fn forward_line(&self, line: &[u8], session_inbox: &str) -> Option<Vec<u8>> {
        let Ok(Value::Object(mut frame)) =
            serde_json::from_str::<Value>(&decode_inbound_json(line))
        else {
            return Some(line.to_vec());
        };
        if frame.get("type").and_then(Value::as_str) == Some(AUTH_FRAME_TYPE) {
            return None;
        }
        let sender_socket = frame
            .get("from")
            .and_then(Value::as_str)
            .and_then(sender_socket_of);
        let message_id = frame.get("msg_id").and_then(Value::as_str);
        let (Some(sender_socket), Some(message_id)) = (sender_socket, message_id) else {
            return Some(line.to_vec());
        };
        lock(&self.receipt_routes).put(
            message_id.to_owned(),
            ClaudeReceiptRoute {
                sender_socket,
                session_inbox: session_inbox.to_owned(),
            },
        );
        frame.insert(
            "from".to_owned(),
            Value::String(format!("{SOCKET_ADDRESS_PREFIX}{}", self.daemon_inbox)),
        );
        Some(serialize_frame(&frame))
    }

    /// Where one line the daemon's inbox received goes, and the line to write there: an answer
    /// naming a forwarded frame goes to that frame's sender from the session's inbox; `None` for
    /// any other line, which names no frame the daemon forwarded.
    pub(crate) fn route_answer(&self, line: &[u8]) -> Option<(PathBuf, Vec<u8>)> {
        let Ok(Value::Object(mut answer)) =
            serde_json::from_str::<Value>(&decode_inbound_json(line))
        else {
            return None;
        };
        let message_id = answer.get(ANSWERED_FRAME_MEMBER)?.as_str()?;
        let route = lock(&self.receipt_routes).get(message_id)?.clone();
        answer.insert(
            "from".to_owned(),
            Value::String(format!("{SOCKET_ADDRESS_PREFIX}{}", route.session_inbox)),
        );
        Some((route.sender_socket, serialize_frame(&answer)))
    }
}

// The socket a sender address names: `uds:<path>` or a bare absolute path. An address on another
// transport, or one whose path Claude Code escaped, names no socket the daemon can reach.
fn sender_socket_of(address: &str) -> Option<PathBuf> {
    let path = address
        .strip_prefix(SOCKET_ADDRESS_PREFIX)
        .unwrap_or(address);
    (path.starts_with('/') && !path.contains('%')).then(|| PathBuf::from(path))
}

// One frame as a line, its newline added by the writer.
fn serialize_frame(frame: &Map<String, Value>) -> Vec<u8> {
    serde_json::to_vec(frame).expect("a JSON object serializes")
}
