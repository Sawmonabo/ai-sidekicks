//! Wire protocol types for the daemon ↔ sidecar JSON envelope.
//!
//! Every message that crosses the Content-Length framing layer is one
//! variant of [`Envelope`]. The envelope is internally-tagged on `kind`
//! (per F-024-1-02), so the on-wire JSON for any variant carries
//! `{"kind": "<snake_case_variant>", ...payload fields...}`. Mirror types
//! live in `packages/contracts/src/pty-host-protocol.ts` and are
//! hand-authored parity — there is no code-gen in V1 (Plan-024
//! §Implementation Step 3; trade-off accepted: two-sided hand edit vs
//! adding a schema compiler).
//!
//! ## Field-shape decisions
//!
//! - **`SpawnRequest.env`** is `Vec<(String, String)>`, not `HashMap`.
//!   POSIX `execve` and Windows `CreateProcess` both preserve insertion
//!   order and accept duplicate keys (last-wins by convention). A
//!   `HashMap` would silently dedupe and reorder, which a caller cannot
//!   recover. The TS mirror is `Array<[string, string]>`.
//!
//! - **`DataFrame.bytes` and `WriteRequest.bytes`** are `Vec<u8>` with
//!   `#[serde_as(as = "Base64")]` (per F-024-1-01). On the wire they
//!   serialize as standard-alphabet base64 strings (no padding stripping;
//!   the `serde_with` 3.x default is `STANDARD`). The TS mirror declares
//!   `bytes: string` — decoder is the consumer's responsibility.
//!
//! - **`PingRequest` / `PingResponse`** are empty structs. The plan does
//!   not pin a correlation field at this layer; `#[serde(tag = "kind")]`
//!   internally-tagged enums require structs or newtypes (unit variants
//!   would serialize as bare strings, not as `{"kind": "ping_request"}`).
//!
//! Plan-024 Phase 1 / T-024-1-3.

use serde::{Deserialize, Serialize};
use serde_with::{base64::Base64, serde_as};

/// POSIX signal name accepted by `KillRequest.signal`.
///
/// On Windows the sidecar translates these to console-control events and
/// `taskkill` invocations per Plan-024 §Windows Implementation Gotchas;
/// this enum is the on-wire shape only. Variants serialize verbatim
/// (`"SIGINT"`, `"SIGTERM"`, etc.) so the JSON value matches the symbol
/// a POSIX user expects, not the lowercase `snake_case` mass-rename.
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

/// Spawn a new PTY session.
///
/// The daemon-layer [`spawn-cwd-translator`](../../../docs/plans/024-rust-pty-sidecar.md#5-spawn-locks-cwd-on-windows)
/// rewrites `cwd` to a stable parent directory before this struct reaches
/// the sidecar (per I-024-5); the sidecar forwards `cwd` verbatim to
/// `portable-pty`.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SpawnRequest {
    pub command: String,
    pub args: Vec<String>,
    /// Ordered key/value pairs. Process-spawn surfaces on every supported
    /// platform preserve order and accept duplicate keys; a map would
    /// dedupe and reorder. See module docs.
    pub env: Vec<(String, String)>,
    pub cwd: String,
    pub rows: u16,
    pub cols: u16,
}

/// Reply to a [`SpawnRequest`] — carries the sidecar-minted session id.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SpawnResponse {
    pub session_id: String,
}

/// Adjust the PTY window dimensions for an existing session.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ResizeRequest {
    pub session_id: String,
    pub rows: u16,
    pub cols: u16,
}

/// Acknowledgment of [`ResizeRequest`]. Explicit response per F-024-1-03
/// so request-correlation is symmetric across every control-message
/// kind.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ResizeResponse {
    pub session_id: String,
}

/// Write payload to a session's stdin.
///
/// `bytes` is base64-encoded on the wire per F-024-1-01. The Rust type
/// stays `Vec<u8>` — `serde_with::Base64` handles encoding both
/// directions transparently.
#[serde_as]
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct WriteRequest {
    pub session_id: String,
    #[serde_as(as = "Base64")]
    pub bytes: Vec<u8>,
}

/// Acknowledgment of [`WriteRequest`]. Explicit response per F-024-1-03.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct WriteResponse {
    pub session_id: String,
}

/// Signal a session's child process.
///
/// On Windows the sidecar translates per Plan-024 §Gotcha 1 + 2:
/// `SIGINT` → `CTRL_C_EVENT`, `SIGTERM` → `CTRL_BREAK_EVENT` then
/// `taskkill /T /F` on bounded timeout, `SIGKILL` → `taskkill /T /F`
/// directly, `SIGHUP` → ditto-treat-as-hard-stop.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct KillRequest {
    pub session_id: String,
    pub signal: PtySignal,
}

/// Acknowledgment of [`KillRequest`]. Explicit response per F-024-1-03;
/// the sidecar acks once it has begun the kill cascade, NOT when the
/// child has actually exited — [`ExitCodeNotification`] carries the
/// terminal status.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct KillResponse {
    pub session_id: String,
}

/// Terminal notification — emitted exactly once per session lifetime,
/// when the child process exits or is reaped. After this is sent the
/// sidecar drops the `PtyPair` and the session id is no longer valid.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ExitCodeNotification {
    pub session_id: String,
    pub exit_code: i32,
    /// Signal number for signal-terminated children on POSIX; `None` for
    /// children that exited normally. Windows always reports `None` here
    /// — the OS-level exit code carries the termination reason on that
    /// platform.
    pub signal_code: Option<i32>,
}

/// Liveness probe. No correlation field at this layer — the dispatcher
/// orders responses against requests on the single duplex stream.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PingRequest {}

/// Reply to a [`PingRequest`].
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PingResponse {}

/// Asynchronous stdout/stderr chunk emitted by the sidecar.
///
/// `seq` is monotonically increasing per `(session_id, stream)` pair
/// (per Plan-024 §Implementation Step 4); consumers reassemble a stream
/// in `seq` order. `bytes` is base64-encoded on the wire per
/// F-024-1-01; decoding is the consumer's responsibility.
#[serde_as]
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct DataFrame {
    pub session_id: String,
    pub stream: DataStream,
    pub seq: u64,
    #[serde_as(as = "Base64")]
    pub bytes: Vec<u8>,
}

/// The discriminated union of every message that crosses the framing
/// layer.
///
/// Internally-tagged on `kind`; on the wire each variant serializes as
/// `{"kind": "<variant_name_in_snake_case>", ...flattened payload
/// fields...}`. Unknown `kind` values fail deserialization (per serde's
/// default behavior for tagged enums) — round-trip tests in
/// `tests/protocol_roundtrip.rs` exercise both legs.
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
