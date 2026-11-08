//! The sign-in's launch and each attempt's life.
//!
//! - **The launch.** A binding reached at an address signs in; a program the provider starts or a
//!   connector of a provider account is refused before anything is sent or bound. Then, in order:
//!   the server's metadata is read at the address its entry names, with no protected-resource
//!   request, and discovered where it names none or that read fails; the scopes are chosen; the
//!   redirect receiver is bound so the redirect carries its port, the client is chosen, a `DPoP`
//!   key is made for this attempt when the server takes `DPoP` proofs, and the authorization
//!   address is built, naming the resource the entry names beside the server's own, and pushed
//!   where the server takes pushed requests. The address goes back to the caller and nothing here
//!   keeps it; the sign-in it leads to records the metadata address it was read at.
//! - **The scopes.** The entry's own where it pins any, `offline_access` added where the entry asks
//!   for it and the metadata lists it; else, where the entry names a metadata address that read,
//!   that metadata's `scopes_supported`; else rmcp's pick from discovery: the protected resource's
//!   `scopes_supported`, never the authorization server's.
//! - **One attempt per server.** Attempts are kept by the server's canonical address. A new launch
//!   ends the attempt before it, an attempt ends 15 minutes after it opened, and `close` ends
//!   every attempt at the daemon's stop; each closes its listener and appends nothing. An attempt
//!   that ran out or that the stop ended marks that the daemon's own client did not finish, so
//!   the next press goes to a provider's flow; a new launch is the person trying the same client
//!   again and marks nothing. A provider's flow running for the server ends the same way, with
//!   no mark.
//! - **After a mark.** Where no provider's flow admits the server, the daemon's own client is the
//!   only client there is: the mark clears and the same press signs in with the own client, or,
//!   where the own client would go to a provider's flow again, is refused at once. A press runs
//!   the providers' flows at most once.

use std::collections::HashMap;
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use reqwest::header::{ACCEPT, HeaderMap, HeaderValue};
use reqwest::{Method, StatusCode, Url};
use rmcp::transport::auth::{AuthorizationManager, AuthorizationMetadata, OAuthHttpClient};
use secrecy::{SecretBox, SecretString};
use sidekicks_contracts::dpop::DPOP_PROOF_ALGORITHM;
use sidekicks_contracts::machine::settings::EnvironmentRow;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::web_address::WebAddress;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::events::session::appender::SessionEventAppender;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::errors::{McpRefusal, SignInLaunchError, SignInUnsupportedReason};
use crate::oauth::dpop_proof::DpopKey;
use crate::oauth::pushed_authorization::{AuthorizationRequestEndpoints, PushedAuthorizationError};
use crate::oauth::redirect_receiver::{
    CallbackPath, RedirectListener, RedirectReceiver, RedirectReceiverError,
};
use crate::sign_in::admitted_client::AdmittedClientStore;
use crate::sign_in::canonical_server_address;
use crate::sign_in::credential_store::SignInCustody;
use crate::sign_in::oauth_http_client::{
    BrowserAddressError, CALL_TIMEOUT, OAuthCall, OAuthCallError, OAuthHttpPools,
    ServerOAuthHttpClient,
};
use crate::sign_in::provider_flow::{ProviderFlowStart, ProviderFlowsTried};
use crate::sign_in::redemption::{AttemptRedemption, ExpectedIssuer};
use crate::sign_in::registration::{
    ClientRequest, RelayAddress, SignInClient, choose_client, classify_pushed_authorization_refusal,
};

/// How long an attempt waits for the browser's return before it ends.
pub(super) const ATTEMPT_LIFETIME: Duration = Duration::from_mins(15);

/// The metadata field (RFC 9449 §5.1) listing the proof algorithms the server takes.
const DPOP_SIGNING_ALGORITHMS: &str = "dpop_signing_alg_values_supported";

/// The metadata field (RFC 9207 §3) saying the server returns `iss` with every response.
const ISSUER_IN_RESPONSE: &str = "authorization_response_iss_parameter_supported";

/// The authorization request's parameter (RFC 8707 §2) naming a resource the token is for.
const RESOURCE_PARAMETER: &str = "resource";

/// The scope (OIDC Core §11) asking for a refresh token.
const OFFLINE_ACCESS_SCOPE: &str = "offline_access";

/// Why the authorization server's metadata at the address an entry names did not read.
#[derive(Debug, thiserror::Error)]
pub(super) enum NamedMetadataError {
    /// The request got no response.
    #[error(transparent)]
    Call(#[from] OAuthCallError),
    /// The address answered a status other than success.
    #[error("the authorization server's metadata address answered {0}")]
    Refused(StatusCode),
    /// The body is not authorization server metadata; the failure names its kind, never a value.
    #[error("the authorization server's metadata did not read ({0:?})")]
    Unreadable(serde_json::error::Category),
}

/// The binding a sign-in is asked for and how its server is reached.
#[derive(Clone)]
pub(crate) struct SignInTarget {
    /// The binding: its provider, scope and server name name the sign-in to a person and on the
    /// completion event.
    pub(crate) binding: McpServerBindingRef,
    /// How the binding's server is reached.
    pub(crate) server: SignInServer,
    /// The folder on this computer the binding's project root is read at, which a provider's flow
    /// reads the server's entry under; `None` for a binding with no project root.
    pub(crate) root_folder: Option<PathBuf>,
    /// The machine's `Every project` rows, which fill a variable in the server entry's address.
    pub(crate) every_project_rows: Vec<EnvironmentRow>,
    /// The binding's project's own rows, which fill a variable in the server entry's address over
    /// an `Every project` row of the same name; none for a binding with no project.
    pub(crate) project_rows: Vec<EnvironmentRow>,
}

/// How a binding's server is reached, as the provider's declaration says.
#[derive(Clone)]
pub(crate) enum SignInServer {
    /// A program the provider starts, which no sign-in reaches.
    Stdio,
    /// A server reached at an address, boxed since it holds its addresses whole.
    Address(Box<AddressedServer>),
}

/// A server reached at an address, with the client its owner issued when the entry names either
/// half of one, the resource the entry names, where its authorization server's metadata is read
/// and whether the sign-in asks for `offline_access`.
#[derive(Clone)]
pub(crate) struct AddressedServer {
    /// The server's address as the binding declares it.
    pub(super) address: McpServerAddress,
    /// The address its sign-in is kept under.
    pub(super) canonical_address: String,
    /// The client the server's owner issued, where the entry gives either half.
    pub(super) owner_client: Option<OwnerIssuedClient>,
    oauth_resource: Option<String>,
    /// The address the entry names for its authorization server's metadata, read in place of
    /// discovery; `None` discovers it.
    pub(super) authorization_server_metadata: Option<Url>,
    asks_offline_access_where_listed: bool,
}

impl AddressedServer {
    /// The server at `address`, signed in to as `owner_client` where the entry gives either half,
    /// its authorization request also naming `oauth_resource` where the entry names one, its
    /// metadata read at `authorization_server_metadata` where the entry names one, any address
    /// taken as given, and `offline_access` added to pinned scopes where
    /// `asks_offline_access_where_listed` and the metadata lists it. `address` is the whole one the
    /// server's entry declares, its user name and query kept, held only in memory and never the
    /// stripped address the inventory serves.
    pub(crate) fn new(
        address: McpServerAddress,
        owner_client: Option<OwnerIssuedClient>,
        oauth_resource: Option<String>,
        authorization_server_metadata: Option<Url>,
        asks_offline_access_where_listed: bool,
    ) -> Self {
        Self {
            canonical_address: canonical_server_address(&address),
            address,
            owner_client,
            oauth_resource,
            authorization_server_metadata,
            asks_offline_access_where_listed,
        }
    }
}

/// A client the server's owner issued for it, from whichever half the entry gives, at least one:
/// the id to sign in as, with no registration, and the callback address the receiver listens on
/// and the client is registered with.
#[derive(Clone)]
pub(crate) struct OwnerIssuedClient {
    /// The `client_id` the owner issued; `None` takes the client the sign-in's order finds.
    pub(crate) client_id: Option<String>,
    /// The callback address registered with the client; `None` listens on a free loopback port.
    pub(crate) callback_url: Option<Url>,
}

/// The account each provider's flow runs for, by provider; a provider with no account here offers
/// no flow.
pub(crate) type ProviderAccounts = HashMap<ProviderId, ProviderAccountId>;

/// The daemon's sign-ins to MCP servers: the launch, and the one open attempt per server.
pub struct SignInService {
    /// Every server's sign-in in the keychain.
    pub(super) custody: Arc<SignInCustody>,
    /// Which client each server admitted.
    pub(super) admitted_clients: Arc<AdmittedClientStore>,
    /// The providers' drivers, whose own clients sign in where the daemon's cannot.
    pub(super) providers: Arc<ProviderRegistry>,
    /// The filtered pools every OAuth call goes through.
    pub(super) pools: OAuthHttpPools,
    relay: &'static PortRegistration<RelayAddress>,
    attempts: Mutex<Attempts>,
    /// Where each settled sign-in appends its completion event.
    pub(super) events: Arc<SessionEventAppender>,
    /// Stops every revocation still running, a sign-out's or a refused renewal's, every
    /// provider's flow, the start's seed of the signed-in servers and every settle of the owed
    /// sign-outs, at `close` or when the service drops.
    pub(super) revocations: DropGuard,
}

// The open attempts by canonical server address: the daemon's own client's, and the providers'
// flows, each kept by its id beside the guard that stops it.
#[derive(Default)]
struct Attempts {
    by_address: HashMap<String, SignInAttempt>,
    provider_flows: HashMap<String, (u64, DropGuard)>,
    next_id: u64,
    is_closed: bool,
}

/// One attempt waiting for the browser's return; dropping it closes its listener and stops its
/// timer. Every attempt kept is the daemon's own client's.
pub(super) struct SignInAttempt {
    id: u64,
    /// The binding, which the completion event names.
    pub(super) binding: McpServerBindingRef,
    server: AddressedServer,
    /// The manager holding the client, the code verifier, the attempt's credential store (the
    /// attempt's key saved with the tokens) and the server's OAuth client (the key and nonce
    /// slots).
    pub(super) manager: AuthorizationManager,
    // The serving receiver, whose callbacks the attempt's redemption answers.
    _receiver: RedirectReceiver,
    /// The `state` the browser's return carries, which the code's exchange is keyed by.
    pub(super) expected_state: String,
    _timer: DropGuard,
}

impl SignInAttempt {
    /// Ends the attempt, closing its listener and stopping its timer, and answers its server's
    /// address.
    pub(super) fn end(self) -> McpServerAddress {
        self.server.address
    }

    /// The server's address as its binding declares it.
    pub(super) fn address(&self) -> &McpServerAddress {
        &self.server.address
    }
}

/// Why a launch that finished after the daemon's stop began opened nothing.
#[derive(Debug, thiserror::Error)]
#[error("the daemon is stopping, so no sign-in opens")]
pub(super) struct SignInServiceClosed;

impl SignInService {
    /// The service over `custody`, `admitted_clients` and the OAuth `pools`, offering the relay's
    /// client metadata document when `relay` holds the relay's address, signing in through the
    /// own clients of `providers`' drivers where the server does not admit the daemon's, and
    /// appending each settled sign-in's completion event through `events`.
    pub fn new(
        custody: Arc<SignInCustody>,
        admitted_clients: Arc<AdmittedClientStore>,
        providers: Arc<ProviderRegistry>,
        pools: OAuthHttpPools,
        relay: &'static PortRegistration<RelayAddress>,
        events: Arc<SessionEventAppender>,
    ) -> Arc<Self> {
        Arc::new(Self {
            custody,
            admitted_clients,
            providers,
            pools,
            relay,
            attempts: Mutex::new(Attempts::default()),
            events,
            revocations: CancellationToken::new().drop_guard(),
        })
    }

    /// Launches a sign-in to `target` asking for `scopes`, ending the server's open attempt
    /// first, through the daemon's own client or, where the server does not admit it, a provider's
    /// own, run for that provider's account in `provider_accounts`. Answers the web address the
    /// browser opens, which nothing else holds; refuses with `mcp.server.signInUnsupported`, naming
    /// why, when the binding or the server offers no sign-in the daemon or a provider can run or
    /// the page to open is no `http:` or `https:` address, which keeps no attempt or flow open,
    /// `mcp.server.signInFailed` when one could not be started, and as the driver's error answers
    /// when a provider's driver failed before the browser opened.
    pub(crate) async fn launch(
        self: &Arc<Self>,
        target: &SignInTarget,
        scopes: &[String],
        provider_accounts: &ProviderAccounts,
    ) -> Result<WebAddress, SignInLaunchError> {
        let unsupported = |reason| {
            SignInLaunchError::from(McpRefusal::ServerSignInUnsupported {
                binding: Box::new(target.binding.clone()),
                reason,
            })
        };
        let failed = |source: Box<dyn std::error::Error + Send + Sync>| {
            SignInLaunchError::from(McpRefusal::ServerSignInFailed {
                binding: Box::new(target.binding.clone()),
                source,
            })
        };
        let Some(server) = addressed_server(target) else {
            return Err(unsupported(SignInUnsupportedReason::NotReachedAtAddress));
        };
        let since = self.custody.sign_out_generation(&server.address);
        // A press that replaces a waiting attempt tries the same client again, so it marks nothing.
        if let Some(replaced) = self.take_attempt(&server.canonical_address, None) {
            replaced.end();
        }
        self.end_provider_flow(&server.canonical_address, None);

        let http_client = Arc::new(self.pools.server_client(&server.address));
        let mut manager = AuthorizationManager::new_with_oauth_http_client(
            server.address.as_str(),
            Arc::clone(&http_client) as Arc<dyn OAuthHttpClient>,
        )
        .await
        .map_err(|error| failed(Box::new(error)))?;
        let named = match &server.authorization_server_metadata {
            Some(metadata_address) => {
                match read_named_metadata(&http_client, metadata_address).await {
                    Ok(metadata) => Some((metadata, metadata_address.clone())),
                    // Claude Code discovers the server's metadata when the named address fails.
                    Err(error) => {
                        tracing::warn!(
                            error = &error as &(dyn std::error::Error + 'static),
                            "the authorization server's metadata did not read at the address the \
                             entry names, so the sign-in discovers it"
                        );
                        None
                    }
                }
            }
            None => None,
        };
        let (metadata, is_published, metadata_address) =
            if let Some((metadata, metadata_address)) = named {
                (metadata, true, Some(metadata_address))
            } else {
                let resolution = manager
                    .resolve_metadata()
                    .await
                    .map_err(|error| failed(Box::new(error)))?;
                let is_published = resolution.source.is_discovered();
                (resolution.metadata, is_published, None)
            };
        let scopes = requested_scopes(
            &mut manager,
            server,
            scopes,
            &metadata,
            metadata_address.is_some(),
        )
        .await;
        let is_issuer_in_response = metadata
            .additional_fields
            .get(ISSUER_IN_RESPONSE)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let expected_issuer = ExpectedIssuer::new(metadata.issuer.clone(), is_issuer_in_response);
        let is_dpop = metadata
            .additional_fields
            .get(DPOP_SIGNING_ALGORITHMS)
            .and_then(serde_json::Value::as_array)
            .is_some_and(|algorithms| {
                algorithms
                    .iter()
                    .any(|algorithm| algorithm.as_str() == Some(DPOP_PROOF_ALGORITHM))
            });
        let endpoints = AuthorizationRequestEndpoints::from_metadata(
            &metadata.authorization_endpoint,
            &metadata.additional_fields,
        );
        let owner_callback = server
            .owner_client
            .as_ref()
            .and_then(|owner| owner.callback_url.as_ref());
        // An owner-issued callback is registered as it is, so it never takes the server's id; the
        // daemon's own loopback address, a client id alone's included, takes it unless the server
        // returns `iss`.
        let callback_path = if owner_callback.is_some() || is_issuer_in_response {
            CallbackPath::Shared
        } else {
            CallbackPath::PerServer(&server.canonical_address)
        };
        let (listener, redirect_address) =
            match RedirectListener::bind(owner_callback, callback_path).await {
                Ok(listener) => {
                    let redirect_address = listener.redirect_url().clone();
                    (Some(listener), redirect_address)
                }
                Err(error @ RedirectReceiverError::Bind(_)) => {
                    return Err(failed(Box::new(error)));
                }
                // An owner's callback the receiver never binds: the client is still chosen in its
                // order, which sends such a callback to a provider's flow.
                Err(
                    RedirectReceiverError::NotHttp { .. }
                    | RedirectReceiverError::NotLoopback { .. }
                    | RedirectReceiverError::UnusablePath { .. },
                ) => (
                    None,
                    owner_callback
                        .expect("the receiver refuses only an owner-issued callback")
                        .clone(),
                ),
            };
        let request = ClientRequest {
            server_address: &server.address,
            redirect_address: &redirect_address,
            owner_client_id: server
                .owner_client
                .as_ref()
                .and_then(|owner| owner.client_id.as_deref()),
            scopes: &scopes,
        };
        let mut client = choose_client(
            &request,
            &self.admitted_clients,
            self.relay,
            &mut manager,
            &http_client,
            metadata.clone(),
            is_published,
        )
        .await;
        let mut tried = ProviderFlowsTried::No;
        if matches!(client, SignInClient::OwnClientUnfinished) {
            match self
                .run_provider_flow(target, server, None, provider_accounts)
                .await?
            {
                ProviderFlowStart::Opened(browser_url) => return Ok(browser_url),
                ProviderFlowStart::NoneAdmits { failure } => {
                    self.admitted_clients
                        .clear_own_client_unfinished(&server.address)
                        .await
                        .map_err(|error| failed(Box::new(error)))?;
                    client = choose_client(
                        &request,
                        &self.admitted_clients,
                        self.relay,
                        &mut manager,
                        &http_client,
                        metadata,
                        is_published,
                    )
                    .await;
                    if let Some(failure) = &failure
                        && !matches!(client, SignInClient::ProviderFlow { .. })
                    {
                        tracing::warn!(
                            error = failure as &(dyn std::error::Error + 'static),
                            "no provider's MCP sign-in started, so the daemon's own client signs in"
                        );
                    }
                    tried = ProviderFlowsTried::NoneAdmitted(failure);
                }
            }
        }
        let own_client = match self
            .answer_other_client(target, server, client, provider_accounts, &mut tried)
            .await
        {
            ControlFlow::Break(answer) => return answer,
            ControlFlow::Continue(own_client) => own_client,
        };
        // The daemon's own client with an owner's callback it cannot serve.
        let Some(listener) = listener else {
            return Err(unsupported(SignInUnsupportedReason::OwnerCallbackUnserved));
        };
        let endpoints = match endpoints {
            Ok(endpoints) => endpoints,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the authorization server's metadata names endpoints the sign-in cannot use"
                );
                return Err(unsupported(SignInUnsupportedReason::UnusableMetadata));
            }
        };

        let dpop_key =
            is_dpop.then(|| Arc::new(SecretBox::new(Box::new(DpopKey::generate().to_scalar()))));
        http_client.set_dpop_key(dpop_key.clone());
        let client_secret = own_client.client_secret.map(SecretString::from);
        manager.set_credential_store(
            self.custody
                .attempt_credential_store(&server.address, since, dpop_key, client_secret.clone())
                .recording_metadata_address(metadata_address.as_ref()),
        );
        let scope_names: Vec<&str> = scopes.iter().map(String::as_str).collect();
        let authorization_url = manager
            .get_authorization_url(&scope_names)
            .await
            .map_err(|error| failed(Box::new(error)))?;
        let mut authorization_url =
            Url::parse(&authorization_url).map_err(|error| failed(Box::new(error)))?;
        // The entry's resource is one more beside rmcp's, sent once where it names the same one.
        if let Some(resource) = &server.oauth_resource
            && !authorization_url
                .query_pairs()
                .any(|(name, value)| name == RESOURCE_PARAMETER && value == resource.as_str())
        {
            authorization_url
                .query_pairs_mut()
                .append_pair(RESOURCE_PARAMETER, resource);
        }
        let expected_state = authorization_url
            .query_pairs()
            .find_map(|(name, value)| (name == "state").then(|| value.into_owned()))
            .expect("rmcp's authorization address carries the request's state");
        let browser_url = match http_client
            .browser_authorization_url(&endpoints, &authorization_url, client_secret.as_ref())
            .await
        {
            Ok(browser_url) => browser_url,
            Err(BrowserAddressError::Push(PushedAuthorizationError::Refused(refusal))) => {
                let client = classify_pushed_authorization_refusal(refusal);
                return match self
                    .answer_other_client(target, server, client, provider_accounts, &mut tried)
                    .await
                {
                    ControlFlow::Break(answer) => answer,
                    // A refused pushed request never leaves the daemon's own client to use.
                    ControlFlow::Continue(_own_client) => {
                        Err(unsupported(SignInUnsupportedReason::NoProviderFlow))
                    }
                };
            }
            Err(error) => return Err(failed(Box::new(error))),
        };
        // The metadata can name a page of any scheme; the receiver closes as the launch returns.
        let Some(browser_url) = WebAddress::new(browser_url.as_str()) else {
            tracing::warn!(
                "the authorization server's metadata names a sign-in page that is no web address"
            );
            return Err(unsupported(SignInUnsupportedReason::UnusableMetadata));
        };

        self.open_attempt(
            target,
            server,
            manager,
            listener,
            expected_state,
            expected_issuer,
        )
        .map_err(failed)?;
        Ok(browser_url)
    }

    /// Marks signed in, on a task that `close` or the service's drop ends, every server the
    /// keychain files a sign-in for, so a keychain call waiting on a prompt never holds the caller.
    /// A keychain that refuses to list them is logged, and the servers are marked as each is next
    /// signed in or out.
    pub fn start_signed_in_seed(&self) {
        let custody = Arc::clone(&self.custody);
        let stop = self.revocations.token().clone();
        tokio::spawn(async move {
            tokio::select! {
                () = stop.cancelled() => {}
                seeded = custody.seed_signed_in() => {
                    if let Err(refusal) = seeded {
                        tracing::warn!(
                            error = &refusal as &(dyn std::error::Error + 'static),
                            "the MCP sign-ins in the keychain were not listed, so none is marked \
                             signed in"
                        );
                    }
                }
            }
        });
    }

    /// Ends every open attempt, every provider's flow, every revocation still running, the
    /// start's seed and every settle of the owed sign-outs for the daemon's stop, each attempt
    /// closing its listener and appending nothing, and opens none after. A mark that does not keep
    /// is logged, since the stop goes on.
    pub async fn close(&self) {
        self.revocations.token().cancel();
        let ended: Vec<SignInAttempt> = {
            let mut attempts = lock(&self.attempts);
            attempts.is_closed = true;
            attempts.provider_flows.clear();
            attempts
                .by_address
                .drain()
                .map(|(_, attempt)| attempt)
                .collect()
        };
        let addresses: Vec<McpServerAddress> = ended.into_iter().map(SignInAttempt::end).collect();
        for address in addresses {
            self.mark_unfinished_logged(&address).await;
        }
    }

    /// Keeps `flow`, the guard that stops a provider's flow for the server at `canonical_address`,
    /// ending any flow kept there before, and answers the flow's id. Fails once the daemon's stop
    /// has begun, `flow` dropped.
    pub(super) fn keep_provider_flow(
        &self,
        canonical_address: &str,
        flow: DropGuard,
    ) -> Result<u64, SignInServiceClosed> {
        let (id, replaced) = {
            let mut attempts = lock(&self.attempts);
            if attempts.is_closed {
                return Err(SignInServiceClosed);
            }
            let id = attempts.next_id;
            attempts.next_id += 1;
            let replaced = attempts
                .provider_flows
                .insert(canonical_address.to_owned(), (id, flow));
            (id, replaced)
        };
        drop(replaced);
        Ok(id)
    }

    /// Ends the provider's flow kept for the server at `canonical_address`, only when it is flow
    /// `id` if one is named.
    pub(super) fn end_provider_flow(&self, canonical_address: &str, id: Option<u64>) {
        let ended = {
            let mut attempts = lock(&self.attempts);
            let is_named = attempts
                .provider_flows
                .get(canonical_address)
                .is_some_and(|(kept, _flow)| id.is_none_or(|id| *kept == id));
            if is_named {
                attempts.provider_flows.remove(canonical_address)
            } else {
                None
            }
        };
        drop(ended);
    }

    // Keeps the attempt, its receiver serving and its timer started, ending with no mark any
    // attempt a racing launch kept for the same server, a press of its own. Fails once the daemon's
    // stop has begun, the attempt dropped.
    fn open_attempt(
        self: &Arc<Self>,
        target: &SignInTarget,
        server: &AddressedServer,
        manager: AuthorizationManager,
        listener: RedirectListener,
        expected_state: String,
        expected_issuer: ExpectedIssuer,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let replaced = {
            let mut attempts = lock(&self.attempts);
            if attempts.is_closed {
                return Err(Box::new(SignInServiceClosed));
            }
            let id = attempts.next_id;
            attempts.next_id += 1;
            let redemption = AttemptRedemption::new(
                Arc::downgrade(self),
                server.canonical_address.clone(),
                id,
                expected_issuer,
            );
            let attempt = SignInAttempt {
                id,
                binding: target.binding.clone(),
                server: server.clone(),
                manager,
                _receiver: listener.receive(expected_state.clone(), Arc::new(redemption)),
                expected_state,
                _timer: self.start_timer(server.canonical_address.clone(), id),
            };
            attempts
                .by_address
                .insert(server.canonical_address.clone(), attempt)
        };
        if let Some(replaced) = replaced {
            replaced.end();
        }
        Ok(())
    }

    // Ends the attempt `id` at `canonical_address` once its life is over, unless it ended first.
    fn start_timer(self: &Arc<Self>, canonical_address: String, id: u64) -> DropGuard {
        let stop = CancellationToken::new();
        let stopped = stop.clone();
        let service: Weak<Self> = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::select! {
                () = stopped.cancelled() => {}
                () = tokio::time::sleep(ATTEMPT_LIFETIME) => {
                    let Some(service) = service.upgrade() else {
                        return;
                    };
                    if let Some(expired) = service.take_attempt(&canonical_address, Some(id)) {
                        service.mark_unfinished_logged(&expired.end()).await;
                    }
                }
            }
        });
        stop.drop_guard()
    }

    /// Takes the attempt kept at `canonical_address`, only when it is attempt `id` if one is named.
    pub(super) fn take_attempt(
        &self,
        canonical_address: &str,
        id: Option<u64>,
    ) -> Option<SignInAttempt> {
        let mut attempts = lock(&self.attempts);
        let is_named = attempts
            .by_address
            .get(canonical_address)
            .is_some_and(|attempt| id.is_none_or(|id| attempt.id == id));
        if is_named {
            attempts.by_address.remove(canonical_address)
        } else {
            None
        }
    }

    /// Marks that the daemon's own client did not finish at `address`, logging a mark that does not
    /// keep where no caller waits on it.
    pub(super) async fn mark_unfinished_logged(&self, address: &McpServerAddress) {
        if let Err(error) = self
            .admitted_clients
            .mark_own_client_unfinished(address)
            .await
        {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "an ended MCP sign-in attempt was not marked as unfinished"
            );
        }
    }
}

/// The authorization server's metadata read at `metadata_address`, the address a server's entry
/// names in place of discovery: one GET through `client`, the server's filtered OAuth client,
/// asking for JSON, its redirects followed with each hop judged by the server's filter, within the
/// OAuth call bound. Fails with [`NamedMetadataError`] when the call gets no response, answers
/// other than success or its body is not authorization server metadata.
pub(super) async fn read_named_metadata(
    client: &ServerOAuthHttpClient,
    metadata_address: &Url,
) -> Result<AuthorizationMetadata, NamedMetadataError> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    let response = client
        .call(OAuthCall {
            method: Method::GET,
            url: metadata_address.clone(),
            headers,
            body: Vec::new(),
            is_following_redirects: true,
            timeout: CALL_TIMEOUT,
        })
        .await?;
    if !response.status.is_success() {
        return Err(NamedMetadataError::Refused(response.status));
    }
    serde_json::from_slice(&response.body)
        .map_err(|error| NamedMetadataError::Unreadable(error.classify()))
}

// The scopes a sign-in to `server` asks for: `entry_scopes` where the entry pins any, else, for
// `metadata` read at the address the entry names, the scopes that document asks for, either with
// `offline_access` added where the entry asks for it and `metadata` lists it; else rmcp's pick
// from its discovery, `manager` set to `metadata` so its own `offline_access` rule reads it.
async fn requested_scopes(
    manager: &mut AuthorizationManager,
    server: &AddressedServer,
    entry_scopes: &[String],
    metadata: &AuthorizationMetadata,
    is_named_metadata: bool,
) -> Vec<String> {
    let mut scopes = if !entry_scopes.is_empty() {
        entry_scopes.to_vec()
    } else if is_named_metadata {
        named_metadata_scopes(metadata)
    } else {
        manager.set_metadata(metadata.clone());
        return manager.select_initial_scopes(&[]).await;
    };
    let is_offline_access_listed = metadata
        .scopes_supported
        .as_ref()
        .is_some_and(|listed| listed.iter().any(|scope| scope == OFFLINE_ACCESS_SCOPE));
    if server.asks_offline_access_where_listed
        && is_offline_access_listed
        && !scopes.iter().any(|scope| scope == OFFLINE_ACCESS_SCOPE)
    {
        scopes.push(OFFLINE_ACCESS_SCOPE.to_owned());
    }
    scopes
}

// The scopes a metadata document an entry names asks for: its own `scope`, else its
// `default_scope`, each a space-separated string, else every scope it lists.
fn named_metadata_scopes(metadata: &AuthorizationMetadata) -> Vec<String> {
    ["scope", "default_scope"]
        .into_iter()
        .find_map(|member| metadata.additional_fields.get(member)?.as_str())
        .map_or_else(
            || metadata.scopes_supported.clone().unwrap_or_default(),
            |scope| scope.split_whitespace().map(str::to_owned).collect(),
        )
}

/// The target's server when its binding is one a sign-in reaches: an address, never a connector.
pub(super) fn addressed_server(target: &SignInTarget) -> Option<&AddressedServer> {
    if matches!(target.binding, McpServerBindingRef::Connector { .. }) {
        return None;
    }
    match &target.server {
        SignInServer::Stdio => None,
        SignInServer::Address(server) => Some(server.as_ref()),
    }
}

#[cfg(test)]
mod tests;
