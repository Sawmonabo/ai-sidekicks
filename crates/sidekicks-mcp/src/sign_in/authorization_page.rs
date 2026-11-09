//! The page a sign-in's browser opens: rmcp's authorization address for the scopes asked for,
//! naming the entry's resource beside rmcp's own and pushed where the server takes pushed
//! requests. A server that sends the browser back with an error after the daemon picked the
//! scopes, none of them pinned by the entry, gets one more page asking for no scope, since a
//! server may refuse scopes its own metadata lists.

use std::sync::Arc;

use reqwest::Url;
use rmcp::transport::auth::{AuthError, AuthorizationManager};
use secrecy::SecretString;

use crate::oauth::pushed_authorization::AuthorizationRequestEndpoints;
use crate::sign_in::oauth_http_client::{BrowserAddressError, ServerOAuthHttpClient};

/// The authorization request's parameter (RFC 8707 §2) naming a resource the token is for.
const RESOURCE_PARAMETER: &str = "resource";

/// The page for one authorization request: where the browser goes, and the `state` its return
/// carries.
pub(crate) struct AuthorizationPage {
    /// The address the browser opens.
    pub(crate) browser_url: Url,
    /// The `state` the browser's return carries, which the code's exchange is keyed by.
    pub(crate) expected_state: String,
}

/// Why no page came out of an authorization request.
#[derive(Debug, thiserror::Error)]
pub(crate) enum AuthorizationPageError {
    /// rmcp built no authorization address.
    #[error(transparent)]
    Authorization(#[from] AuthError),
    /// rmcp's authorization address does not parse.
    #[error(transparent)]
    Address(#[from] url::ParseError),
    /// The pushed request failed, or the client could not make it.
    #[error(transparent)]
    Browser(#[from] BrowserAddressError),
}

/// What one more page asking for no scope needs, kept by an attempt whose scopes the daemon
/// picked, and taken by the first return that carries an error.
pub(crate) struct ScopeRetry {
    /// The server's filtered OAuth client, the attempt's proof key in its slot.
    pub(crate) http_client: Arc<ServerOAuthHttpClient>,
    /// The authorization server's endpoints.
    pub(crate) endpoints: AuthorizationRequestEndpoints,
    /// The resource the entry names, sent beside rmcp's own.
    pub(crate) oauth_resource: Option<String>,
    /// The secret the server issued the attempt's client, for a pushed request.
    pub(crate) client_secret: Option<SecretString>,
}

impl ScopeRetry {
    /// The page asking for no scope, through `manager`, which keeps the new request's code
    /// verifier beside the first's. Fails as [`open_authorization_page`] fails.
    pub(crate) async fn open_page(
        &self,
        manager: &AuthorizationManager,
    ) -> Result<AuthorizationPage, AuthorizationPageError> {
        open_authorization_page(
            manager,
            &self.http_client,
            &self.endpoints,
            &[],
            self.oauth_resource.as_deref(),
            self.client_secret.as_ref(),
        )
        .await
    }
}

/// The page asking for `scopes` through `manager`, naming `oauth_resource` once beside rmcp's own
/// resource where it differs, pushed through `http_client` with `client_secret` where `endpoints`
/// name a pushed-request endpoint. Fails with [`AuthorizationPageError`] when rmcp builds no
/// address or the pushed request fails.
pub(crate) async fn open_authorization_page(
    manager: &AuthorizationManager,
    http_client: &ServerOAuthHttpClient,
    endpoints: &AuthorizationRequestEndpoints,
    scopes: &[String],
    oauth_resource: Option<&str>,
    client_secret: Option<&SecretString>,
) -> Result<AuthorizationPage, AuthorizationPageError> {
    let scope_names: Vec<&str> = scopes.iter().map(String::as_str).collect();
    let mut authorization_url = Url::parse(&manager.get_authorization_url(&scope_names).await?)?;
    if let Some(resource) = oauth_resource
        && !authorization_url
            .query_pairs()
            .any(|(name, value)| name == RESOURCE_PARAMETER && value == resource)
    {
        authorization_url
            .query_pairs_mut()
            .append_pair(RESOURCE_PARAMETER, resource);
    }
    let expected_state = authorization_url
        .query_pairs()
        .find_map(|(name, value)| (name == "state").then(|| value.into_owned()))
        .expect("rmcp's authorization address carries the request's state");
    let browser_url = http_client
        .browser_authorization_url(endpoints, &authorization_url, client_secret)
        .await?;
    Ok(AuthorizationPage {
        browser_url,
        expected_state,
    })
}
