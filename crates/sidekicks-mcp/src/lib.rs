//! MCP: the client a session's tool servers are reached through, the tool calls it runs, the
//! receipts of a tool call's two phases, the governance store's binding rows and the resolver
//! that attributes a reported server to its binding, the server inventory that joins each
//! provider's bindings with their status and what the store keeps, the `mcp.*` refusals, each
//! binding's live status and the notices it sends, and the crate's part of the daemon's schema. It
//! sits over std, store, ipc, workspace and provider and is taken by session and the daemon.

pub mod binding;
pub(crate) mod client;
pub(crate) mod command_receipts;
pub(crate) mod errors;
pub mod inventory_service;
pub mod schema;
pub mod status;
pub(crate) mod tool_calls;
