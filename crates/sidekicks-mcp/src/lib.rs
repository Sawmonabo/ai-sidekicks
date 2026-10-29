//! MCP: the client a session's tool servers are reached through, the tool calls it runs, the
//! receipts of a tool call's two phases, the governance store's binding rows, the `mcp.*`
//! refusals, each binding's live status and the notices it sends, and the crate's part of the
//! daemon's schema. It sits over std, store, ipc and provider and is taken by session and the
//! daemon.

pub mod binding_store;
pub(crate) mod client;
pub(crate) mod command_receipts;
pub(crate) mod errors;
pub mod schema;
pub mod status;
pub(crate) mod tool_calls;
