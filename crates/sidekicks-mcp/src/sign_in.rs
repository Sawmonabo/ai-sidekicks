//! The sign-in to an MCP server reached at an address: what it keeps, the credentials in the
//! keychain and which client each server admitted, both under the server's keyed digest, the
//! filtered HTTP its OAuth calls go through, which client each sign-in goes through, the launch
//! and the life of each server's one open attempt, the browser's return and the code's redemption,
//! the sign-in through a provider's own client where the server does not admit the daemon's, the
//! one completion event each settled sign-in appends, the authorizer that presents and
//! renews its token on each request, the sign-out that forgets and revokes it, and the sign-outs a
//! binding's removal owes; the target read from a binding, and the receipted sign-in and sign-out
//! commands the daemon's handlers forward to.

pub(crate) mod address_digest;
pub mod admitted_client;
pub(crate) mod authorization_page;
pub(crate) mod authorizer;
pub mod commands;
pub(crate) mod completion_event;
pub mod credential_store;
pub mod oauth_http_client;
pub(crate) mod provider_flow;
pub(crate) mod redemption;
pub mod registration;
pub mod server;
pub mod service;
pub mod sign_out;
#[cfg(test)]
mod test_service;
