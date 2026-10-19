//! The connection to a Codex service: the WebSocket over its socket, the JSON-RPC correlation on
//! it, and the closed set of what the transport reports.

pub(super) mod diagnostics;
pub(super) mod socket;
