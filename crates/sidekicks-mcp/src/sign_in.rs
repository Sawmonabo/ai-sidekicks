//! The sign-in to an MCP server reached at an address: what it keeps, the credentials in the
//! keychain and which client each server admitted, both under the server's canonical address, the
//! filtered HTTP its OAuth calls go through, which client each sign-in goes through, the launch
//! and the life of each server's one open attempt, the browser's return and the code's redemption,
//! the sign-in through a provider's own client where the server does not admit the daemon's, the
//! one completion event each settled sign-in appends, the authorizer that presents and
//! renews its token on each request, and the sign-out that forgets and revokes it.

pub(crate) mod admitted_client;
pub(crate) mod authorizer;
pub(crate) mod completion_event;
pub(crate) mod credential_store;
pub(crate) mod oauth_http_client;
pub(crate) mod provider_flow;
pub(crate) mod redemption;
pub mod registration;
pub(crate) mod service;
pub(crate) mod sign_out;
#[cfg(test)]
mod test_keychain;
#[cfg(test)]
mod test_service;

use sidekicks_contracts::mcp::server::config::McpServerAddress;

/// The canonical form of `address` that a server's sign-in is kept under: the URL standard's
/// serialization, so two spellings of one server (`HTTPS://Docs.Example.com/mcp` and
/// `https://docs.example.com/mcp`) name one sign-in.
pub(crate) fn canonical_server_address(address: &McpServerAddress) -> String {
    url::Url::parse(address.as_str())
        .expect("a server address parses as a web address")
        .into()
}
