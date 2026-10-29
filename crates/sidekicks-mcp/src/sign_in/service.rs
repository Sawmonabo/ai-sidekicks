//! The sign-in's launch and each attempt's life.
//!
//! - **The launch.** A binding reached at an address signs in; a program the provider starts or a
//!   connector of a provider account is refused before anything is sent or bound. Then, in order:
//!   the server's metadata is discovered, the redirect receiver is bound so the redirect carries its
//!   port, the client is chosen, a `DPoP` key is made for this attempt when the server takes `DPoP`
//!   proofs, and the authorization address is built, pushed where the server takes pushed requests.
//!   The address goes back to the caller and nothing here keeps it.
//! - **One attempt per server.** Attempts are kept by the server's canonical address. A new launch
//!   ends the attempt before it, an attempt ends 15 minutes after it opened, and `close` ends
//!   every attempt at the daemon's stop; each closes its listener, appends nothing, and marks that
//!   the daemon's own client did not finish, so the next press goes to a provider's flow.

use std::collections::HashMap;
use std::ops::ControlFlow;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use reqwest::Url;
use rmcp::transport::auth::{AuthorizationManager, OAuthHttpClient};
use secrecy::SecretBox;
use sidekicks_contracts::dpop::DPOP_PROOF_ALGORITHM;
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::binding_store::McpBindingKey;
use crate::errors::McpRefusal;
use crate::oauth::dpop_proof::DpopKey;
use crate::oauth::pushed_authorization::{AuthorizationRequestEndpoints, PushedAuthorizationError};
use crate::oauth::redirect_receiver::{CallbackPath, RedirectListener, RedirectReceiverError};
use crate::sign_in::admitted_client::AdmittedClientStore;
use crate::sign_in::canonical_server_address;
use crate::sign_in::credential_store::SignInCustody;
use crate::sign_in::oauth_http_client::{BrowserAddressError, OAuthHttpPools};
use crate::sign_in::registration::{
    ClientRequest, RelayAddress, SignInClient, choose_client, classify_pushed_authorization_refusal,
};

/// How long an attempt waits for the browser's return before it ends.
const ATTEMPT_LIFETIME: Duration = Duration::from_secs(15 * 60);

/// The metadata field (RFC 9449 §5.1) listing the proof algorithms the server takes.
const DPOP_SIGNING_ALGORITHMS: &str = "dpop_signing_alg_values_supported";

/// The metadata field (RFC 9207 §3) saying the server returns `iss` with every response.
const ISSUER_IN_RESPONSE: &str = "authorization_response_iss_parameter_supported";

/// The binding a sign-in is asked for and how its server is reached.
#[derive(Clone)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the mcp.server.signIn handler builds it from the binding"
    )
)]
pub(crate) struct SignInTarget {
    /// The binding: its provider, scope and server name name the sign-in to a person and on the
    /// completion event.
    pub(crate) binding: McpServerBindingRef,
    /// How the binding's server is reached.
    pub(crate) server: SignInServer,
}

/// How a binding's server is reached, as the provider's declaration says.
#[derive(Clone)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the mcp.server.signIn handler reads it from the binding"
    )
)]
pub(crate) enum SignInServer {
    /// A program the provider starts, which no sign-in reaches.
    Stdio,
    /// A server reached at an address.
    Address(AddressedServer),
}

/// A server reached at an address, with the client its owner issued when the entry names one.
#[derive(Clone)]
pub(crate) struct AddressedServer {
    address: McpServerAddress,
    canonical_address: String,
    owner_client: Option<OwnerIssuedClient>,
}

impl AddressedServer {
    /// The server at `address`, signed in to as `owner_client` when its owner issued one.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the mcp.server.signIn handler builds it from the binding"
        )
    )]
    pub(crate) fn new(address: McpServerAddress, owner_client: Option<OwnerIssuedClient>) -> Self {
        Self {
            canonical_address: canonical_server_address(&address),
            address,
            owner_client,
        }
    }
}

/// A client the server's owner issued for it: the id to sign in as and the callback address
/// registered with it.
#[derive(Clone)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the mcp.server.signIn handler reads it from the entry"
    )
)]
pub(crate) struct OwnerIssuedClient {
    /// The `client_id` the owner issued.
    pub(crate) client_id: String,
    /// The callback address registered with that client.
    pub(crate) callback_url: Url,
}

/// What a launch answers when it refuses nothing.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the mcp.server.signIn handler answers with it")
)]
pub(crate) enum SignInLaunch {
    /// The browser opens this address; the attempt waits for the browser's return. Nothing else
    /// holds the address.
    Browser(Url),
    /// The daemon's own client is not the one to use: `provider`'s own flow signs in.
    ProviderFlow {
        /// The provider whose client signs in: the one the server admitted, else the binding's.
        provider: ProviderId,
    },
}

/// The daemon's sign-ins to MCP servers: the launch, and the one open attempt per server.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds it for the sign-in handlers"
    )
)]
pub(crate) struct SignInService {
    custody: Arc<SignInCustody>,
    admitted_clients: Arc<AdmittedClientStore>,
    pools: OAuthHttpPools,
    relay: &'static PortRegistration<RelayAddress>,
    attempts: Mutex<Attempts>,
}

// The open attempts by canonical server address.
#[derive(Default)]
struct Attempts {
    by_address: HashMap<String, SignInAttempt>,
    next_id: u64,
    is_closed: bool,
}

// One attempt waiting for the browser's return; dropping it closes its listener and stops its
// timer. Every attempt kept is the daemon's own client's.
#[expect(
    dead_code,
    reason = "the callback's redemption drives the receiver and redeems through the manager"
)]
struct SignInAttempt {
    id: u64,
    // The binding, which the completion event names.
    binding: McpServerBindingRef,
    server: AddressedServer,
    // The manager holding the client, the code verifier, the attempt's credential store (the
    // attempt's key saved with the tokens) and the server's OAuth client (the key and nonce slots).
    manager: AuthorizationManager,
    // The bound receiver, not yet serving: it serves once the redemption owns it.
    listener: RedirectListener,
    // The `state` the browser's return must carry.
    expected_state: String,
    _timer: DropGuard,
}

impl SignInAttempt {
    // Ends the attempt, closing its listener and stopping its timer, and answers its server's
    // address.
    fn end(self) -> McpServerAddress {
        self.server.address
    }
}

// Why a launch that finished after the daemon's stop began opened nothing.
#[derive(Debug, thiserror::Error)]
#[error("the daemon is stopping, so no sign-in opens")]
struct SignInServiceClosed;

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start and the sign-in handlers call it"
    )
)]
impl SignInService {
    /// The service over `custody`, `admitted_clients` and the OAuth `pools`, offering the relay's
    /// client metadata document when `relay` holds the relay's address.
    pub(crate) fn new(
        custody: Arc<SignInCustody>,
        admitted_clients: Arc<AdmittedClientStore>,
        pools: OAuthHttpPools,
        relay: &'static PortRegistration<RelayAddress>,
    ) -> Arc<Self> {
        Arc::new(Self {
            custody,
            admitted_clients,
            pools,
            relay,
            attempts: Mutex::new(Attempts::default()),
        })
    }

    /// Launches a sign-in to `target` asking for `scopes`, ending the server's open attempt
    /// first. Answers the address the browser opens, or the provider whose flow signs in; refuses
    /// with `mcp.server.signInUnsupported` when the binding or the server offers no sign-in the
    /// daemon can run, and `mcp.server.signInFailed` when one could not be started.
    pub(crate) async fn launch(
        self: &Arc<Self>,
        target: &SignInTarget,
        scopes: &[String],
    ) -> Result<SignInLaunch, McpRefusal> {
        let unsupported = || McpRefusal::ServerSignInUnsupported {
            binding: target.binding.clone(),
        };
        let failed =
            |source: Box<dyn std::error::Error + Send + Sync>| McpRefusal::ServerSignInFailed {
                binding: target.binding.clone(),
                source,
            };
        let Some(server) = addressed_server(target) else {
            return Err(unsupported());
        };
        if let Some(replaced) = self.take_attempt(&server.canonical_address, None) {
            self.admitted_clients
                .mark_own_client_unfinished(&replaced.end())
                .await
                .map_err(|error| failed(Box::new(error)))?;
        }

        let http_client = Arc::new(self.pools.server_client(&server.address));
        let mut manager = AuthorizationManager::new_with_oauth_http_client(
            server.address.as_str(),
            Arc::clone(&http_client) as Arc<dyn OAuthHttpClient>,
        )
        .await
        .map_err(|error| failed(Box::new(error)))?;
        let resolution = manager
            .resolve_metadata()
            .await
            .map_err(|error| failed(Box::new(error)))?;
        let metadata = &resolution.metadata;
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
        // An owner-issued callback is registered as it is, so it never takes the server's id.
        let callback_path = if server.owner_client.is_some()
            || metadata
                .additional_fields
                .get(ISSUER_IN_RESPONSE)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        {
            CallbackPath::Shared
        } else {
            CallbackPath::PerServer(&server.canonical_address)
        };

        let owner_callback = server
            .owner_client
            .as_ref()
            .map(|owner| &owner.callback_url);
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
                .map(|owner| owner.client_id.as_str()),
            scopes,
        };
        let client = choose_client(
            &request,
            &self.admitted_clients,
            self.relay,
            &mut manager,
            &http_client,
            resolution,
        )
        .await;
        if let ControlFlow::Break(answer) = self.answer_other_client(target, server, client).await {
            return answer;
        }
        // The daemon's own client with an owner's callback it cannot serve.
        let Some(listener) = listener else {
            return Err(unsupported());
        };
        let endpoints = match endpoints {
            Ok(endpoints) => endpoints,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the authorization server's metadata names endpoints the sign-in cannot use"
                );
                return Err(unsupported());
            }
        };

        let dpop_key =
            is_dpop.then(|| Arc::new(SecretBox::new(Box::new(DpopKey::generate().to_scalar()))));
        if let Some(dpop_key) = &dpop_key {
            http_client.set_dpop_key(Arc::clone(dpop_key));
        }
        manager.set_credential_store(
            self.custody
                .attempt_credential_store(&server.address, dpop_key),
        );
        let scope_names: Vec<&str> = scopes.iter().map(String::as_str).collect();
        let authorization_url = manager
            .get_authorization_url(&scope_names)
            .await
            .map_err(|error| failed(Box::new(error)))?;
        let authorization_url =
            Url::parse(&authorization_url).map_err(|error| failed(Box::new(error)))?;
        let expected_state = authorization_url
            .query_pairs()
            .find_map(|(name, value)| (name == "state").then(|| value.into_owned()))
            .expect("rmcp's authorization address carries the request's state");
        let browser_url = match http_client
            .browser_authorization_url(&endpoints, &authorization_url)
            .await
        {
            Ok(browser_url) => browser_url,
            Err(BrowserAddressError::Push(PushedAuthorizationError::Refused(refusal))) => {
                let client = classify_pushed_authorization_refusal(refusal);
                return match self.answer_other_client(target, server, client).await {
                    ControlFlow::Break(answer) => answer,
                    ControlFlow::Continue(()) => Err(unsupported()),
                };
            }
            Err(error) => return Err(failed(Box::new(error))),
        };

        self.open_attempt(target, server, manager, listener, expected_state)
            .await
            .map_err(failed)?;
        Ok(SignInLaunch::Browser(browser_url))
    }

    /// Ends every open attempt for the daemon's stop, each closing its listener and appending
    /// nothing, and opens none after. A mark that does not keep is logged, since the stop goes on.
    #[cfg_attr(test, expect(dead_code, reason = "the daemon's stop calls it"))]
    pub(crate) async fn close(&self) {
        let ended: Vec<SignInAttempt> = {
            let mut attempts = lock(&self.attempts);
            attempts.is_closed = true;
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

    // The launch's answer for every client but the daemon's own, which continues the launch. A
    // provider's flow records the client it goes through as the one the server admits.
    async fn answer_other_client(
        &self,
        target: &SignInTarget,
        server: &AddressedServer,
        client: SignInClient,
    ) -> ControlFlow<Result<SignInLaunch, McpRefusal>> {
        let binding = target.binding.clone();
        ControlFlow::Break(match client {
            SignInClient::OwnClient(_) => return ControlFlow::Continue(()),
            SignInClient::Unsupported => Err(McpRefusal::ServerSignInUnsupported { binding }),
            SignInClient::Failed { source } => {
                Err(McpRefusal::ServerSignInFailed { binding, source })
            }
            SignInClient::ProviderFlow {
                admitted_provider: Some(provider),
            } => Ok(SignInLaunch::ProviderFlow { provider }),
            SignInClient::ProviderFlow {
                admitted_provider: None,
            } => {
                let provider = McpBindingKey::of(&target.binding).provider;
                match self
                    .admitted_clients
                    .record_admitted_provider(&server.address, &provider)
                    .await
                {
                    Ok(()) => Ok(SignInLaunch::ProviderFlow { provider }),
                    Err(error) => Err(McpRefusal::ServerSignInFailed {
                        binding,
                        source: Box::new(error),
                    }),
                }
            }
        })
    }

    // Keeps the attempt, its timer started, ending any attempt a racing launch kept for the same
    // server. Fails once the daemon's stop has begun, the attempt dropped.
    async fn open_attempt(
        self: &Arc<Self>,
        target: &SignInTarget,
        server: &AddressedServer,
        manager: AuthorizationManager,
        listener: RedirectListener,
        expected_state: String,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let replaced = {
            let mut attempts = lock(&self.attempts);
            if attempts.is_closed {
                return Err(Box::new(SignInServiceClosed));
            }
            let id = attempts.next_id;
            attempts.next_id += 1;
            let attempt = SignInAttempt {
                id,
                binding: target.binding.clone(),
                server: server.clone(),
                manager,
                listener,
                expected_state,
                _timer: self.start_timer(server.canonical_address.clone(), id),
            };
            attempts
                .by_address
                .insert(server.canonical_address.clone(), attempt)
        };
        if let Some(replaced) = replaced {
            self.mark_unfinished_logged(&replaced.end()).await;
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

    // Takes the attempt kept at `canonical_address`, only when it is attempt `id` if one is named.
    fn take_attempt(&self, canonical_address: &str, id: Option<u64>) -> Option<SignInAttempt> {
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

    // Marks that the daemon's own client did not finish at `address`, logging a mark that does not
    // keep where no caller waits on it.
    async fn mark_unfinished_logged(&self, address: &McpServerAddress) {
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

// The target's server when its binding is one a sign-in reaches: an address, never a connector.
fn addressed_server(target: &SignInTarget) -> Option<&AddressedServer> {
    if matches!(target.binding, McpServerBindingRef::Connector { .. }) {
        return None;
    }
    match &target.server {
        SignInServer::Stdio => None,
        SignInServer::Address(server) => Some(server),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use axum::Router;
    use axum::body::{Body, Bytes};
    use axum::extract::Request;
    use axum::http::StatusCode;
    use axum::middleware::{self, Next};
    use axum::response::Response;
    use axum::routing::{get, post};
    use reqwest::Url;
    use rstest::rstest;
    use serde_json::{Value, json};
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
    use sidekicks_contracts::provider::account::record::ProviderAccountId;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
    use sidekicks_store::database::writer::test_file::TestDatabase;
    use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
    use tempfile::TempDir;

    use super::{
        ATTEMPT_LIFETIME, AddressedServer, SignInLaunch, SignInServer, SignInService, SignInTarget,
    };
    use crate::errors::McpRefusal;
    use crate::schema::schema_parts;
    use crate::sign_in::admitted_client::{
        AdmittedClientStore, MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY,
    };
    use crate::sign_in::credential_store::SignInCustody;
    use crate::sign_in::oauth_http_client::OAuthHttpPools;
    use crate::sign_in::registration::RELAY_ADDRESS;
    use crate::sign_in::test_keychain::test_keychain;

    /// A service over a test database and keychain, with the folders and database it needs kept
    /// alive beside it.
    struct Harness {
        service: Arc<SignInService>,
        admitted_clients: Arc<AdmittedClientStore>,
        _data_folder: TempDir,
        _database: TestDatabase,
    }

    async fn harness() -> Harness {
        let database = TestDatabase::new(schema_parts());
        let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
            .await
            .expect("the writer opens its database");
        let admitted_clients = Arc::new(AdmittedClientStore::new(
            Arc::new(DatabaseReadPool::new(
                database.path(),
                MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY,
            )),
            Arc::new(writer),
        ));
        let (data_folder, _platform_store, keychain) = test_keychain();
        let service = SignInService::new(
            SignInCustody::new(keychain),
            Arc::clone(&admitted_clients),
            OAuthHttpPools::new().expect("the pools build"),
            &RELAY_ADDRESS,
        );
        Harness {
            service,
            admitted_clients,
            _data_folder: data_folder,
            _database: database,
        }
    }

    // A fake authorization server on a loopback port that publishes its metadata and registers
    // every client, returning its address and the count of requests it got.
    async fn serve_authorization_server() -> (String, Arc<AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a local port");
        let base = format!(
            "http://{}",
            listener.local_addr().expect("the port's address")
        );
        let metadata = json!({
            "issuer": base,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
            "registration_endpoint": format!("{base}/register"),
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
        })
        .to_string();
        let requests = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&requests);
        let router = Router::new()
            .route(
                "/.well-known/oauth-authorization-server",
                get(move || async move { answer(200, metadata) }),
            )
            .route(
                "/register",
                post(|body: Bytes| async move {
                    let request: Value =
                        serde_json::from_slice(&body).expect("a JSON registration");
                    let client = json!({
                        "client_id": "registered-client",
                        "redirect_uris": request["redirect_uris"],
                    });
                    answer(201, client.to_string())
                }),
            )
            .fallback(|| async { answer(404, "{}".to_owned()) })
            .layer(middleware::from_fn(move |request: Request, next: Next| {
                counted.fetch_add(1, Ordering::SeqCst);
                next.run(request)
            }));
        tokio::spawn(async move { axum::serve(listener, router).await });
        (base, requests)
    }

    fn answer(status: u16, body: String) -> Response {
        Response::builder()
            .status(StatusCode::from_u16(status).expect("a status"))
            .header("content-type", "application/json")
            .body(Body::from(body))
            .expect("a response")
    }

    fn provider() -> ProviderId {
        ProviderId::new("provider-a".to_owned()).expect("a provider id")
    }

    fn server_name() -> McpServerName {
        McpServerName::new("docs".to_owned()).expect("a server name")
    }

    fn addressed_target(base: &str) -> SignInTarget {
        SignInTarget {
            binding: McpServerBindingRef::User {
                provider: provider(),
                server_name: server_name(),
            },
            server: SignInServer::Address(AddressedServer::new(
                McpServerAddress::new(base).expect("a server address"),
                None,
            )),
        }
    }

    // The loopback port the receiver of the attempt behind `browser_url` listens on.
    fn receiver_port(browser_url: &Url) -> u16 {
        let redirect_uri = browser_url
            .query_pairs()
            .find_map(|(name, value)| (name == "redirect_uri").then(|| value.into_owned()))
            .expect("the address names its redirect");
        Url::parse(&redirect_uri)
            .expect("the redirect is a URL")
            .port()
            .expect("the redirect carries its port")
    }

    async fn is_listening(port: u16) -> bool {
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
    }

    async fn launch_to_browser(harness: &Harness, target: &SignInTarget) -> u16 {
        match harness.service.launch(target, &[]).await {
            Ok(SignInLaunch::Browser(browser_url)) => receiver_port(&browser_url),
            Ok(SignInLaunch::ProviderFlow { .. }) => {
                unreachable!("a server that registers every client opens the browser")
            }
            Err(refusal) => unreachable!("the launch was refused: {refusal}"),
        }
    }

    #[tokio::test]
    async fn a_second_launch_for_a_server_closes_the_first_attempts_listener() {
        let (base, _requests) = serve_authorization_server().await;
        let harness = harness().await;
        let target = addressed_target(&base);
        let first_port = launch_to_browser(&harness, &target).await;
        assert!(is_listening(first_port).await);

        let second = harness.service.launch(&target, &[]).await;

        assert!(!is_listening(first_port).await);
        // The first attempt ended unfinished, so the second press goes to the provider's flow.
        assert!(matches!(
            second,
            Ok(SignInLaunch::ProviderFlow { provider: handed }) if handed == provider()
        ));
    }

    #[tokio::test]
    async fn an_attempt_ends_when_its_life_runs_out() {
        let (base, _requests) = serve_authorization_server().await;
        let harness = harness().await;
        let target = addressed_target(&base);
        let port = launch_to_browser(&harness, &target).await;
        let SignInServer::Address(server) = &target.server else {
            unreachable!("the target is reached at an address")
        };

        tokio::time::pause();
        tokio::time::advance(ATTEMPT_LIFETIME + Duration::from_secs(1)).await;
        let mut is_marked = false;
        for _ in 0..1_000 {
            tokio::task::yield_now().await;
            is_marked = harness
                .admitted_clients
                .read(&server.address)
                .await
                .expect("the admitted client reads")
                .is_some_and(|admitted| admitted.is_own_client_unfinished);
            if is_marked {
                break;
            }
        }

        assert!(is_marked);
        assert!(!is_listening(port).await);
        assert!(super::lock(&harness.service.attempts).by_address.is_empty());
    }

    #[rstest]
    #[case::a_program_the_provider_starts(false)]
    #[case::a_connector(true)]
    #[tokio::test]
    async fn a_binding_no_sign_in_reaches_is_refused_before_anything_is_sent(
        #[case] is_connector: bool,
    ) {
        let (base, requests) = serve_authorization_server().await;
        let harness = harness().await;
        let target = if is_connector {
            SignInTarget {
                binding: McpServerBindingRef::Connector {
                    provider: provider(),
                    scope_ref: ProviderAccountId::new("account-1".to_owned())
                        .expect("an account id"),
                    server_name: server_name(),
                },
                ..addressed_target(&base)
            }
        } else {
            SignInTarget {
                server: SignInServer::Stdio,
                ..addressed_target(&base)
            }
        };

        let refusal = harness.service.launch(&target, &[]).await;

        assert!(matches!(
            refusal,
            Err(McpRefusal::ServerSignInUnsupported { .. })
        ));
        assert_eq!(requests.load(Ordering::SeqCst), 0);
        assert!(super::lock(&harness.service.attempts).by_address.is_empty());
    }
}
