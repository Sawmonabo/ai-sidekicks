//! Which client a sign-in goes through, and what the server's answers mean.
//!
//! - **The order.** What is known of the server's admitted client comes first: a provider's
//!   client it admitted, or the daemon's own client's last attempt that did not finish, goes to
//!   the provider's flow with no request sent. A redirect address whose host is not loopback is
//!   never signed in by the daemon's own client, nor is a server whose metadata does not list the
//!   `S256` PKCE method, since the daemon's client never opens a browser without it: both go to the
//!   provider's flow, the latter refused as such only where no provider's flow admits the server.
//!   Then a client the server's owner issued; else dynamic registration, with one adjusted retry
//!   when the server refuses the redirect or the metadata; else, where the server offers no
//!   registration, the client metadata document this deployment's relay serves, when the server
//!   takes one for a public client on a loopback redirect; else the provider's flow.
//! - **The classification.** A registration that got no answer or a server error failed and may
//!   be tried again; a server that publishes no metadata offers no sign-in; a definite refusal of
//!   registration, or of the pushed authorization request, goes to the provider's flow. It is read
//!   from what the server's OAuth client saw and the typed refusal, never from rmcp's error text.

use std::error::Error;

use reqwest::StatusCode;
use rmcp::transport::auth::{AuthorizationManager, AuthorizationMetadata, OAuthClientConfig};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_std::port_registration::PortRegistration;
use url::{Host, Url};

use crate::errors::SignInUnsupportedReason;
use crate::oauth::address::is_loopback_address;
use crate::oauth::client_authentication::TOKEN_ENDPOINT_AUTH_METHODS;
use crate::oauth::pushed_authorization::PushedAuthorizationRefusal;
use crate::sign_in::admitted_client::{AdmittedClient, AdmittedClientStore};
use crate::sign_in::oauth_http_client::{RegistrationOutcome, ServerOAuthHttpClient};

/// Where this deployment's relay is reached, registered by the account once it is signed in to
/// one; absent, this computer has no relay and the sign-in never offers the relay's client
/// metadata document.
pub static RELAY_ADDRESS: PortRegistration<RelayAddress> = PortRegistration::new("relay address");

/// The name the daemon registers its own client under, which the server shows on its consent
/// page.
const CLIENT_NAME: &str = "Sidekicks";

/// The PKCE method the daemon's client always challenges with (RFC 7636 §4.2).
const PKCE_METHOD: &str = "S256";

/// The OIDC `application_type` the one adjusted registration asks for in place of rmcp's
/// `native`.
const ADJUSTED_APPLICATION_TYPE: &str = "web";

/// The RFC 7591 errors that earn the one adjusted registration: the server refused the redirect
/// address or a metadata value for this application type.
const ADJUSTABLE_REGISTRATION_ERRORS: [&str; 2] =
    ["invalid_redirect_uri", "invalid_client_metadata"];

/// The base address of this deployment's relay, under which it serves the daemon's client
/// metadata documents.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayAddress(Url);

impl RelayAddress {
    /// The relay reached at `address`.
    pub fn new(address: Url) -> Self {
        Self(address)
    }
}

/// What a sign-in asks of its client: the server, the redirect address its receiver listens on
/// (an owner-issued one or the daemon's loopback one), the client the server's owner issued for
/// it, if any, and the scopes it asks for.
pub(crate) struct ClientRequest<'a> {
    /// The server signed in to.
    pub(crate) server_address: &'a McpServerAddress,
    /// The redirect address registered and listened on.
    pub(crate) redirect_address: &'a Url,
    /// The `client_id` the server's owner issued, when the entry names one.
    pub(crate) owner_client_id: Option<&'a str>,
    /// The scopes the sign-in asks for.
    pub(crate) scopes: &'a [String],
}

/// The client a sign-in goes through, or why the daemon's own cannot: what the launch and the
/// provider's flow act on.
#[derive(Debug)]
pub(crate) enum SignInClient {
    /// The daemon's own client, configured on the manager; the launch builds the authorization
    /// address from it.
    OwnClient(OAuthClientConfig),
    /// The server could not be reached or failed; the sign-in may be tried again
    /// (`mcp.server.signInFailed`).
    Failed {
        /// What failed.
        source: Box<dyn Error + Send + Sync>,
    },
    /// The server publishes no sign-in metadata, or metadata the daemon cannot use
    /// (`mcp.server.signInUnsupported`).
    Unsupported {
        /// Why, which the refusal names.
        reason: SignInUnsupportedReason,
    },
    /// The daemon's own client's last attempt here did not finish, so a provider's own flow signs
    /// in, and where none admits the server the daemon's own client is chosen again.
    OwnClientUnfinished,
    /// The daemon's own client is not the one to use; a provider's own flow signs in.
    ProviderFlow {
        /// The provider whose client the server admitted before, when one did.
        admitted_provider: Option<ProviderId>,
        /// Why the sign-in is refused where no provider's flow admits the server.
        refusal_if_none_admits: SignInUnsupportedReason,
    },
}

/// The client the sign-in described by `request` goes through, its own client configured on
/// `manager` when it is the daemon's: `manager` sends through `http_client`, `metadata` is the
/// authorization server's, and `is_published` says whether the server published it (discovered,
/// or read at the address its entry names) rather than rmcp making its endpoints up. The relay's
/// client metadata document is offered only when `relay` holds the relay's address.
pub(crate) async fn choose_client(
    request: &ClientRequest<'_>,
    admitted_clients: &AdmittedClientStore,
    relay: &PortRegistration<RelayAddress>,
    manager: &mut AuthorizationManager,
    http_client: &ServerOAuthHttpClient,
    metadata: AuthorizationMetadata,
    is_published: bool,
) -> SignInClient {
    match admitted_clients.read(request.server_address).await {
        Err(error) => {
            return SignInClient::Failed {
                source: Box::new(error),
            };
        }
        Ok(Some(AdmittedClient {
            provider: Some(provider),
            ..
        })) => {
            return SignInClient::ProviderFlow {
                admitted_provider: Some(provider),
                refusal_if_none_admits: SignInUnsupportedReason::NoProviderFlow,
            };
        }
        Ok(Some(AdmittedClient {
            is_own_client_unfinished: true,
            ..
        })) => return SignInClient::OwnClientUnfinished,
        Ok(_) => {}
    }
    // Endpoints rmcp made up from the server's address are no sign-in the server publishes.
    if !is_published {
        return SignInClient::Unsupported {
            reason: SignInUnsupportedReason::NoSignInRoute,
        };
    }
    if !is_loopback_address(request.redirect_address) {
        return provider_flow();
    }
    // A server that does not list `S256` may ignore the challenge, so the daemon's own client never
    // opens a browser for it, the field's absence included; a provider's own flow may still admit
    // it.
    let takes_s256 = metadata
        .code_challenge_methods_supported
        .as_ref()
        .is_some_and(|methods| methods.iter().any(|method| method == PKCE_METHOD));
    if !takes_s256 {
        return SignInClient::ProviderFlow {
            admitted_provider: None,
            refusal_if_none_admits: SignInUnsupportedReason::NoS256Challenge,
        };
    }
    let has_registration_endpoint = metadata.registration_endpoint.is_some();
    let document_client_id = relay
        .port()
        .and_then(|relay| client_document_address(&metadata, relay, request.redirect_address));
    manager.set_metadata(metadata);
    if let Some(client_id) = request.owner_client_id {
        configure(manager, own_client_config(client_id, request))
    } else if has_registration_endpoint {
        register(manager, http_client, request).await
    } else if let Some(client_id) = document_client_id {
        configure(manager, own_client_config(&client_id, request))
    } else {
        provider_flow()
    }
}

/// What a refusal of the pushed authorization request means for the sign-in: the server does
/// not admit the daemon's own client (`invalid_client`, `unauthorized_client`), so a provider's
/// flow signs in; any other refusal failed it.
pub(crate) fn classify_pushed_authorization_refusal(
    refusal: PushedAuthorizationRefusal,
) -> SignInClient {
    match refusal {
        PushedAuthorizationRefusal::InvalidClient
        | PushedAuthorizationRefusal::UnauthorizedClient => provider_flow(),
        PushedAuthorizationRefusal::Other { .. } => SignInClient::Failed {
            source: Box::new(refusal),
        },
    }
}

// Registers the daemon's own client, once more as a web application when the server refuses
// the redirect or a metadata value, and classifies a refusal by what the server answered.
async fn register(
    manager: &mut AuthorizationManager,
    http_client: &ServerOAuthHttpClient,
    request: &ClientRequest<'_>,
) -> SignInClient {
    let redirect_address = request.redirect_address.as_str();
    let scopes: Vec<&str> = request.scopes.iter().map(String::as_str).collect();
    let mut registered = manager
        .register_client(CLIENT_NAME, redirect_address, &scopes)
        .await;
    if registered.is_err() && is_adjustable(&http_client.registration_outcome()) {
        // rmcp takes the registration's application type only from a client configuration; the
        // registration that follows replaces this client with the one the server issues.
        let adjusted = OAuthClientConfig::new(String::new(), redirect_address)
            .with_application_type(ADJUSTED_APPLICATION_TYPE);
        if let unsupported @ SignInClient::Unsupported { .. } = configure(manager, adjusted) {
            return unsupported;
        }
        registered = manager
            .register_client(CLIENT_NAME, redirect_address, &scopes)
            .await;
    }
    match registered {
        Ok(config) => SignInClient::OwnClient(config),
        Err(error) => match http_client.registration_outcome() {
            // The metadata names no flow the daemon's client can run: no `code` response.
            RegistrationOutcome::NotSent => {
                tracing::warn!(
                    error = &error as &(dyn Error + 'static),
                    "the authorization server's metadata names no flow the sign-in can run"
                );
                SignInClient::Unsupported {
                    reason: SignInUnsupportedReason::UnusableMetadata,
                }
            }
            RegistrationOutcome::Answered { status, .. } if is_refusal(status) => provider_flow(),
            // No answer, a server error, or a success whose body rmcp could not read.
            RegistrationOutcome::Unanswered | RegistrationOutcome::Answered { .. } => {
                SignInClient::Failed {
                    source: Box::new(error),
                }
            }
        },
    }
}

// A provider's own flow, for a server that admitted none before, refused as offering no provider's
// flow where none admits it.
fn provider_flow() -> SignInClient {
    SignInClient::ProviderFlow {
        admitted_provider: None,
        refusal_if_none_admits: SignInUnsupportedReason::NoProviderFlow,
    }
}

// Configures the daemon's own client `config` on `manager`; metadata whose endpoints are not web
// addresses is metadata the daemon cannot use, its cause logged.
fn configure(manager: &mut AuthorizationManager, config: OAuthClientConfig) -> SignInClient {
    match manager.configure_client(config.clone()) {
        Ok(()) => SignInClient::OwnClient(config),
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "the authorization server's metadata names endpoints the sign-in cannot use"
            );
            SignInClient::Unsupported {
                reason: SignInUnsupportedReason::UnusableMetadata,
            }
        }
    }
}

// The configuration of the daemon's own client named `client_id` for `request`.
fn own_client_config(client_id: &str, request: &ClientRequest<'_>) -> OAuthClientConfig {
    OAuthClientConfig::new(client_id, request.redirect_address.as_str())
        .with_scopes(request.scopes.to_vec())
}

// Whether the registration's answer earns the one adjusted retry.
fn is_adjustable(outcome: &RegistrationOutcome) -> bool {
    matches!(
        outcome,
        RegistrationOutcome::Answered { status, error: Some(error) }
            if *status == StatusCode::BAD_REQUEST
                && ADJUSTABLE_REGISTRATION_ERRORS.contains(&error.as_str())
    )
}

// Whether `status` refuses the registration for good: a client error other than a timeout or a
// rate limit, which say only "not now".
fn is_refusal(status: StatusCode) -> bool {
    status.is_client_error()
        && status != StatusCode::REQUEST_TIMEOUT
        && status != StatusCode::TOO_MANY_REQUESTS
}

// The address of the relay's client metadata document to offer as `client_id`, when the server
// takes one for a public client and the document lists `redirect_address`: the shared callback's
// document, or the per-server one for a callback carrying the server's id.
fn client_document_address(
    metadata: &AuthorizationMetadata,
    relay: &RelayAddress,
    redirect_address: &Url,
) -> Option<String> {
    let fields = &metadata.additional_fields;
    let takes_documents = fields
        .get("client_id_metadata_document_supported")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let takes_public_clients = fields
        .get(TOKEN_ENDPOINT_AUTH_METHODS)
        .and_then(serde_json::Value::as_array)
        .is_some_and(|methods| methods.iter().any(|method| method.as_str() == Some("none")));
    if !takes_documents || !takes_public_clients {
        return None;
    }
    let callback = listed_callback(redirect_address)?;
    let mut document = relay.0.clone();
    {
        let mut segments = document.path_segments_mut().ok()?;
        segments.pop_if_empty().extend(["oauth", "mcp"]);
        if let ListedCallback::Own(callback_id) = callback {
            segments.push(callback_id);
        }
        segments.push("client.json");
    }
    Some(document.into())
}

// A callback the relay's document lists: the shared `http://127.0.0.1:<port>/callback`, or
// `/callback/<id>` with its own id.
enum ListedCallback<'address> {
    Shared,
    Own(&'address str),
}

// The callback a redirect the relay's document lists carries; nothing for any other address,
// which the document does not list.
fn listed_callback(redirect_address: &Url) -> Option<ListedCallback<'_>> {
    let is_listed_form = redirect_address.scheme() == "http"
        && redirect_address.host() == Some(Host::Ipv4(std::net::Ipv4Addr::LOCALHOST))
        && redirect_address.port().is_some_and(|port| port > 0)
        && redirect_address.username().is_empty()
        && redirect_address.password().is_none()
        && redirect_address.query().is_none()
        && redirect_address.fragment().is_none();
    if !is_listed_form {
        return None;
    }
    let mut segments = redirect_address.path_segments()?;
    if segments.next()? != "callback" {
        return None;
    }
    match (segments.next(), segments.next()) {
        (None, _) => Some(ListedCallback::Shared),
        (Some(id), None) if !id.is_empty() => Some(ListedCallback::Own(id)),
        (Some(_), _) => None,
    }
}

#[cfg(test)]
mod tests;
