//! Wire types for the daemon-to-sidecar JSON envelope.
//!
//! Every message that crosses the framing layer is one [`Envelope`] variant, internally tagged on
//! `kind` with the snake_case variant name.
//!
//! ## Field shapes
//!
//! - `SpawnRequest.env` is `Vec<(String, String)>`, not a map: process spawning preserves order and
//!   accepts duplicate keys, which a map would dedupe and reorder.
//! - `DataFrame.bytes` and `WriteRequest.bytes` are base64 strings on the wire (standard alphabet,
//!   padded).
//! - `PingRequest` and `PingResponse` are empty structs with no correlation field.
//! - `SpawnResponse`, `ResizeResponse`, `WriteResponse` and `KillResponse` carry
//!   `error: Option<String>`, omitted from the JSON when `None`. Absent means the handler
//!   succeeded; present means it failed and the daemon rejects the awaiting request with the
//!   message. `ExitCodeNotification.signal_code` differs on purpose: it serializes as `null` when
//!   absent.
//! - When a spawn fails, the sidecar sends a `SpawnResponse` with an empty `session_id` and an
//!   `error`. No session was created, so the daemon must not track it.

use serde::{Deserialize, Serialize};
use serde_with::{base64::Base64, serde_as};

/// POSIX signal name in `KillRequest.signal`, serialized verbatim (`"SIGINT"`, `"SIGTERM"`, ...).
///
/// Unix delivers it with `kill(2)`. The Windows path is not wired yet; `kill_translation` holds the
/// mapping it will use.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtySignal {
    #[serde(rename = "SIGINT")]
    Sigint,
    #[serde(rename = "SIGTERM")]
    Sigterm,
    #[serde(rename = "SIGKILL")]
    Sigkill,
    #[serde(rename = "SIGHUP")]
    Sighup,
}

/// Which standard stream a [`DataFrame`] carries.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DataStream {
    Stdout,
    Stderr,
}

/// Spawns a new PTY session.
///
/// The daemon has already translated `cwd` (including WSL paths); the sidecar forwards it verbatim
/// to `portable-pty`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SpawnRequest {
    pub command: String,
    pub args: Vec<String>,
    /// Ordered key/value pairs; see the module docs.
    pub env: Vec<(String, String)>,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
}

/// Reply to a [`SpawnRequest`]: the minted session id, or `error` when the spawn failed (a missing
/// or non-executable command, or any `portable-pty` failure).
///
/// On failure `session_id` is empty.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SpawnResponse {
    pub session_id: String,
    /// Failure message; absent on the success path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Adjust the PTY window dimensions for an existing session.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ResizeRequest {
    pub session_id: String,
    pub rows: u16,
    pub cols: u16,
}

/// Reply to a [`ResizeRequest`].
///
/// `error` is set when the resize failed, most often
/// [`crate::pty_session::PtySessionError::UnknownSession`] because the session exited between the
/// request and its dispatch.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ResizeResponse {
    pub session_id: String,
    /// Failure message; absent on the success path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Writes bytes to a session's stdin; `bytes` is base64 on the wire.
#[serde_as]
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct WriteRequest {
    pub session_id: String,
    #[serde_as(as = "Base64")]
    pub bytes: Vec<u8>,
}

/// Reply to a [`WriteRequest`].
///
/// `error` is set on failure, typically [`crate::pty_session::PtySessionError::UnknownSession`]
/// (the session exited) or [`crate::pty_session::PtySessionError::WriterUnavailable`] (the writer
/// was already taken).
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct WriteResponse {
    pub session_id: String,
    /// Failure message; absent on the success path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Signals a session's child process.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct KillRequest {
    pub session_id: String,
    pub signal: PtySignal,
}

/// Reply to a [`KillRequest`]. It acknowledges the signal, not the child's exit;
/// [`ExitCodeNotification`] carries the terminal status.
///
/// `error` is set when the kill failed, most often
/// [`crate::pty_session::PtySessionError::UnknownSession`] because the session exited just before
/// the request arrived. That race cannot be avoided: the `ExitCodeNotification` may still be in
/// flight to the daemon.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct KillResponse {
    pub session_id: String,
    /// Failure message; absent on the success path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Emitted once per session when the child exits. After it, the session id is no longer valid.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ExitCodeNotification {
    pub session_id: String,
    pub exit_code: i32,
    /// Always `None` today: `portable-pty` does not expose the signal number.
    pub signal_code: Option<i32>,
}

/// Liveness probe. It carries no correlation field; the daemon matches responses to requests by
/// order.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PingRequest {}

/// Reply to a [`PingRequest`].
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PingResponse {}

/// One chunk of session output.
///
/// `seq` increases per `(session_id, stream)`, so consumers reassemble a stream in `seq` order.
#[serde_as]
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct DataFrame {
    pub session_id: String,
    pub stream: DataStream,
    pub seq: u64,
    #[serde_as(as = "Base64")]
    pub bytes: Vec<u8>,
}

/// Every message that crosses the framing layer. An unknown `kind` fails deserialization.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Envelope {
    SpawnRequest(SpawnRequest),
    SpawnResponse(SpawnResponse),
    ResizeRequest(ResizeRequest),
    ResizeResponse(ResizeResponse),
    WriteRequest(WriteRequest),
    WriteResponse(WriteResponse),
    KillRequest(KillRequest),
    KillResponse(KillResponse),
    ExitCodeNotification(ExitCodeNotification),
    PingRequest(PingRequest),
    PingResponse(PingResponse),
    DataFrame(DataFrame),
}
