//! MCP: the client a session's tool servers are reached through, the tool calls it runs, the
//! receipts of a tool call's two phases, and the crate's part of the daemon's schema. It sits over
//! std, store and provider and is taken by session.

pub(crate) mod client;
pub(crate) mod command_receipts;
pub mod schema;
pub(crate) mod tool_calls;
