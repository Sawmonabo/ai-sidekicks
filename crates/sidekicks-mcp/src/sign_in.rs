//! The sign-in to an MCP server reached at an address: what it keeps, the credentials in the
//! keychain and which client each server admitted, both under the server's canonical address, the
//! filtered HTTP its OAuth calls go through, which client each sign-in goes through, the launch
//! and the life of each server's one open attempt, the browser's return and the code's redemption,
//! the sign-in through a provider's own client where the server does not admit the daemon's, the
//! one completion event each settled sign-in appends, the authorizer that presents and
//! renews its token on each request, the sign-out that forgets and revokes it, and the sign-outs a
//! binding's removal owes; the target read from a binding, and the receipted sign-in and sign-out
//! commands the daemon's handlers forward to.

pub mod admitted_client;
pub(crate) mod authorizer;
pub mod commands;
pub(crate) mod completion_event;
pub mod credential_store;
pub mod oauth_http_client;
pub mod owed_sign_out;
pub(crate) mod provider_flow;
pub(crate) mod redemption;
pub mod registration;
pub mod service;
pub(crate) mod sign_out;
pub mod target;
#[cfg(test)]
mod test_service;

use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_provider::driver::mcp_server::address::fold_server_address;

/// The canonical form of `address` that a server's sign-in is kept under: the fold a provider's
/// declarations tell two servers apart by, so two spellings of one server
/// (`HTTPS://Docs.Example.com/mcp/` and `https://docs.example.com/mcp`) name one sign-in.
pub(crate) fn canonical_server_address(address: &McpServerAddress) -> String {
    fold_server_address(address)
}
