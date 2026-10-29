//! The sign-in to an MCP server reached at an address: what it keeps, the credentials in the
//! keychain and which client each server admitted, both under the server's canonical address, the
//! filtered HTTP its OAuth calls go through, which client each sign-in goes through, and the
//! authorizer that presents and renews its token on each request.

pub(crate) mod admitted_client;
pub(crate) mod authorizer;
pub(crate) mod credential_store;
pub(crate) mod oauth_http_client;
pub mod registration;
#[cfg(test)]
mod test_keychain;

use sidekicks_contracts::mcp::server::config::McpServerAddress;

/// The canonical form of `address` that a server's sign-in is kept under: the URL standard's
/// serialization, so two spellings of one server (`HTTPS://Docs.Example.com/mcp` and
/// `https://docs.example.com/mcp`) name one sign-in.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the sign-in keys its custody and admitted clients by it"
    )
)]
pub(crate) fn canonical_server_address(address: &McpServerAddress) -> String {
    url::Url::parse(address.as_str())
        .expect("a server address parses as a web address")
        .into()
}
