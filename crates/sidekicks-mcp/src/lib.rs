//! MCP: the client a session's tool servers are reached through, the tool calls it runs, the
//! receipts of a tool call's two phases, the governance store's binding rows and the resolver
//! that attributes a reported server to its binding, the `mcp.*` refusals, each binding's live
//! status and the notices it sends, the sign-in to a server reached at an address with its `DPoP`
//! proofs, signed sends, pushed authorization requests and the one-time redirect receiver, and
//! the crate's part of the daemon's schema. It sits over std, store, ipc, workspace and provider
//! and is taken by session and the daemon.

pub mod binding;
pub(crate) mod client;
pub(crate) mod command_receipts;
pub(crate) mod errors;
pub mod oauth;
pub mod schema;
pub mod sign_in;
pub mod status;
pub(crate) mod tool_calls;
