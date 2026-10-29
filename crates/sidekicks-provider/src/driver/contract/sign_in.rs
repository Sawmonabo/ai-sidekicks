//! The sign-in to an MCP server through a provider's own client: what the daemon asks a driver,
//! the browser's two legs the caller carries, and the credentials the driver reads back from the
//! folder of the daemon's own that the provider saved them in. Nothing here prints a credential.

use std::fmt;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::sync::oneshot;
use url::Url;

/// The token type both providers present their saved access tokens as, the one they keep.
pub const BEARER_TOKEN_TYPE: &str = "Bearer";

/// What the daemon asks a driver to sign in to through its provider's own client.
#[derive(Debug)]
pub struct ProviderSignInTakeoverRequest {
    /// The account whose provider runs the flow.
    pub provider_account_id: ProviderAccountId,
    /// The binding signed in to; the provider's config declares its server under the binding's
    /// server name.
    pub binding: McpServerBindingRef,
    /// The folder on this computer the binding's project root is read at; `None` for a binding
    /// with no project root.
    pub root_folder: Option<PathBuf>,
    /// The server's canonical address, the one its sign-in is kept under.
    pub server_address: McpServerAddress,
    /// The redirect address the daemon's relay serves, sent to a provider whose flow takes one; a
    /// provider whose own listener takes the browser's return ignores it.
    pub redirect_url: Url,
    /// How long the flow waits for the person in the browser before it ends unfinished.
    pub lifetime: Duration,
    /// The browser's two legs, which the caller carries.
    pub browser: ProviderSignInBrowser,
}

/// The browser's two legs of a provider's sign-in: the driver hands the authorization address
/// out, the caller opens it, and the caller hands back where the browser returned to the
/// redirect address.
#[derive(Debug)]
pub struct ProviderSignInBrowser {
    /// Takes the authorization address the person's browser opens, sent once.
    pub authorization_url: oneshot::Sender<Url>,
    /// The whole address the browser came back on at the redirect address. It never comes where
    /// the provider's own listener took the return, and the driver then does not wait for it.
    pub browser_return: oneshot::Receiver<Url>,
}

/// The credentials a provider's own client saved for one server, as plain data: the caller keeps
/// them as its own sign-in. Its `Debug` prints no token.
pub struct ProviderSignInTakeover {
    /// The access token.
    pub access_token: String,
    /// The refresh token, where the server issued one.
    pub refresh_token: Option<String>,
    /// When the access token expires; `None` where the server named no lifetime.
    pub expires_at: Option<SystemTime>,
    /// The scopes the server granted.
    pub scopes: Vec<String>,
    /// How the access token is presented: [`BEARER_TOKEN_TYPE`] for both providers.
    pub token_type: String,
    /// The client id the provider registered or used.
    pub client_id: String,
    /// The secret of a confidential client the provider registered, where it kept one.
    pub client_secret: Option<String>,
    /// The authorization server that issued the tokens, where the provider kept it.
    pub issuer: Option<String>,
}

impl fmt::Debug for ProviderSignInTakeover {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderSignInTakeover")
            .field("has_refresh_token", &self.refresh_token.is_some())
            .field("has_client_secret", &self.client_secret.is_some())
            .field("expires_at", &self.expires_at)
            .field("scopes", &self.scopes)
            .field("token_type", &self.token_type)
            .field("issuer", &self.issuer)
            .finish_non_exhaustive()
    }
}

/// A takeover asked for a binding that has no entry of the person's to copy: a connector, whose
/// sign-in is the account's own, so no provider flow can sign in to it.
#[derive(Debug, thiserror::Error)]
#[error("the MCP server's binding has no entry of the person's to sign in through")]
pub struct NoPersonServerEntry {
    /// The binding asked for.
    pub binding: McpServerBindingRef,
}
