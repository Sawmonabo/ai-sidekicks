//! The sign-in to an MCP server through a provider's own client: what the daemon asks a driver,
//! where the browser comes back to, and the credentials the driver reads back from the
//! folder of the daemon's own that the provider saved them in; and the read of the whole address
//! a server's entry declares. Nothing here prints a credential or that address.

use std::fmt;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use secrecy::SecretString;
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use tokio::sync::oneshot;
use url::Url;

/// The token type both providers present their saved access tokens as, the one they keep.
pub const BEARER_TOKEN_TYPE: &str = "Bearer";

/// What the daemon asks a driver to sign in to through its provider's own client. Its `Debug`
/// prints no server address, no environment row and no secret.
pub struct ProviderSignInTakeoverRequest {
    /// The account whose provider runs the flow.
    pub provider_account_id: ProviderAccountId,
    /// The binding signed in to; the provider's config declares its server under the binding's
    /// server name.
    pub binding: McpServerBindingRef,
    /// The folder on this computer the binding's project root is read at; `None` for a binding
    /// with no project root.
    pub root_folder: Option<PathBuf>,
    /// The whole address the server's entry declares, its user name and query kept, which the
    /// driver matches against the provider's entry and its saved sign-in. It is held only in
    /// memory, and is never the stripped address the inventory serves.
    pub server_address: McpServerAddress,
    /// The machine's `Every project` rows, which fill a variable in the entry's address.
    pub every_project_rows: Vec<EnvironmentRow>,
    /// The binding's project's own rows, which fill a variable in the entry's address over an
    /// `Every project` row of the same name; none for a binding with no project.
    pub project_rows: Vec<EnvironmentRow>,
    /// The secret of the client the server's owner issued, as the driver's own read answered it,
    /// for a provider whose own client reads it only where the driver puts it; `None` where the
    /// entry names no such client or no secret is kept for it.
    pub owner_client_secret: Option<SecretString>,
    /// How long the flow waits for the person in the browser before it ends unfinished.
    pub lifetime: Duration,
    /// Takes the authorization address the person's browser opens, sent once.
    pub authorization_url: oneshot::Sender<Url>,
    /// Where the browser comes back to once the person has signed in.
    pub browser_return: ProviderSignInReturn,
}

impl fmt::Debug for ProviderSignInTakeoverRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderSignInTakeoverRequest")
            .field("provider_account_id", &self.provider_account_id)
            .field("binding", &self.binding)
            .field("root_folder", &self.root_folder)
            .field("lifetime", &self.lifetime)
            .field("browser_return", &self.browser_return)
            .finish_non_exhaustive()
    }
}

/// Where the browser comes back to from a provider's own sign-in, chosen by the driver's
/// descriptor.
#[derive(Debug)]
pub enum ProviderSignInReturn {
    /// To the daemon's loopback receiver, for a driver whose descriptor says its flow can return
    /// there.
    ThroughDaemonReceiver {
        /// The receiver's redirect address, which the driver hands its provider.
        redirect_url: Url,
        /// The whole address the browser came back on at `redirect_url`. A driver whose
        /// provider's own listener takes the return after all drops it and does not wait for it.
        browser_return: oneshot::Receiver<Url>,
    },
    /// To the provider's own listener, for a driver whose descriptor says its flow cannot return
    /// to the daemon's receiver.
    OwnListener,
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
    pub client_secret: Option<SecretString>,
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

/// Why a provider's own flow ended without a sign-in, each a kind in the daemon's own words, so
/// no authorization server's or provider's text crosses the driver.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProviderSignInFailure {
    /// The browser came back carrying the authorization server's error instead of a code.
    #[error("the authorization server sent back an error")]
    CallbackCarriedError,
    /// The authorization server did not exchange the code for tokens.
    #[error("the authorization server did not accept the sign-in code")]
    CodeNotRedeemed,
    /// The tokens came back but the provider did not save them where the driver reads them.
    #[error("the provider did not save the sign-in")]
    SignInNotSaved,
    /// The flow did not finish within its lifetime.
    #[error("the sign-in did not finish in time")]
    DidNotFinishInTime,
    /// The provider's reply could not be read, or named a failure the driver does not read.
    #[error("the provider's reply could not be read")]
    ReplyUnreadable,
}

/// A takeover or an address read asked for a binding that has no entry of the person's to read: a
/// connector, whose sign-in is the account's own, or a server the person's config no longer
/// declares at the request's address or declares with no remote address, so this provider's flow
/// cannot sign in to it.
#[derive(Debug, thiserror::Error)]
#[error("the MCP server's binding has no entry of the person's to sign in through")]
pub struct NoPersonServerEntry {
    /// The binding asked for.
    pub binding: McpServerBindingRef,
}

/// What the daemon asks a driver for to read the whole address a server's entry declares.
#[derive(Clone, Debug)]
pub struct McpServerAddressRead {
    /// The binding whose entry is read; its server name names the entry.
    pub binding: McpServerBindingRef,
    /// The account whose organization's servers a managed binding is read from; `None` reads no
    /// organization's server.
    pub provider_account_id: Option<ProviderAccountId>,
    /// The folder on this computer the binding's project root is read at; `None` for a binding
    /// with no project root.
    pub root_folder: Option<PathBuf>,
    /// The machine's `Every project` rows, which fill a variable in the entry's address.
    pub every_project_rows: Vec<EnvironmentRow>,
    /// The binding's project's own rows, which fill a variable in the entry's address over an
    /// `Every project` row of the same name; none for a binding with no project.
    pub project_rows: Vec<EnvironmentRow>,
}

/// The whole address a server's entry declares, as its provider connects to it. Its `Debug` names
/// only the arm, never the address.
pub enum McpServerAddressReading {
    /// The whole address, its user name and query kept and its variables filled.
    Declared(McpServerAddress),
    /// The entry's `url`, once filled, still names a variable with no value or is not a web
    /// address.
    Unreadable,
}

impl fmt::Debug for McpServerAddressReading {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Declared(_address) => "Declared",
            Self::Unreadable => "Unreadable",
        })
    }
}

/// What a sign-in to one server reads from its entry in one read of the provider's config. Its
/// `Debug` names no address and no secret.
pub struct McpSignInEntryReading {
    /// The whole address the entry declares.
    pub address: McpServerAddressReading,
    /// The redirect the provider's own client sends, where the provider's rule sets one.
    pub callback: Option<McpSignInCallback>,
    /// The secret of the client the server's owner issued, where it was asked for and is kept.
    pub owner_client_secret: Option<SecretString>,
}

impl fmt::Debug for McpSignInEntryReading {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpSignInEntryReading")
            .field("address", &self.address)
            .field("callback", &self.callback)
            .field(
                "has_owner_client_secret",
                &self.owner_client_secret.is_some(),
            )
            .finish()
    }
}

/// The redirect a provider's own client sends at a sign-in to one server, in the two forms its
/// rule picks between by whether the authorization server says it returns `iss` (RFC 9207), so
/// an owner who registered the provider's redirect finds the daemon's identical. A form on a
/// loopback IP literal with no port is sent with the port of a free loopback listener in it, as
/// RFC 8252 §7.3 has a server accept.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpSignInCallback {
    /// The redirect sent where the server returns `iss`.
    pub with_issuer: RedirectAddress,
    /// The redirect sent where it does not.
    pub without_issuer: RedirectAddress,
}

/// A redirect address as a sign-in sends it: its text byte for byte, which a server that matches
/// redirects exactly compares, beside the address it parses to, where the receiver listens.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RedirectAddress {
    text: String,
    url: Url,
}

impl RedirectAddress {
    /// The redirect `text` writes, sent as written. Fails where `text` is no address.
    pub fn parse(text: &str) -> Result<Self, url::ParseError> {
        Ok(Self {
            url: Url::parse(text)?,
            text: text.to_owned(),
        })
    }

    /// The redirect `url` names, sent as it serializes.
    pub fn from_url(url: Url) -> Self {
        Self {
            text: url.as_str().to_owned(),
            url,
        }
    }

    /// The text sent.
    pub fn as_str(&self) -> &str {
        &self.text
    }

    /// The address the text parses to.
    pub fn url(&self) -> &Url {
        &self.url
    }
}
