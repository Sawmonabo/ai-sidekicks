//! The sign-in service over a test database, event log and keychain, and a fake authorization
//! server on a loopback port, for the sign-in's tests.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use futures::FutureExt as _;
use futures::future::BoxFuture;
use reqwest::Url;
use rusqlite::params;
use secrecy::SecretString;
use serde_json::{Value, json};
use sidekicks_contracts::dpop::DPOP_PROOF_HEADER_NAME;
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::test_registry::registry_of_first_providers;
use sidekicks_store::credential_store::SecretKeychain;
use sidekicks_store::credential_store::items::os_service_name;
use sidekicks_store::credential_store::service::KeychainService;
use sidekicks_store::credential_store::test_keychain::test_keychain;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::events::log_service::test_fixture::open_log;
use sidekicks_store::events::session::appender::SessionEventAppender;
use sidekicks_store::events::session::version::SESSION_EVENT_VERSION;
use tempfile::TempDir;

use crate::schema::schema_parts;
use crate::sign_in::admitted_client::{
    AdmittedClientStore, MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY,
};
use crate::sign_in::authorizer::SignInAuthorizer;
use crate::sign_in::credential_store::SignInCustody;
use crate::sign_in::oauth_http_client::OAuthHttpPools;
use crate::sign_in::registration::RELAY_ADDRESS;
use crate::sign_in::server::OwnerClientSecretReads;
use crate::sign_in::service::{
    AddressedServer, ProviderAccounts, SignInServer, SignInService, SignInTarget,
    read_named_metadata,
};

/// A service over a test database, event log and keychain, with the folders and database it
/// needs kept alive beside it.
pub(crate) struct Harness {
    /// The service.
    pub(crate) service: Arc<SignInService>,
    /// Which client each server admitted, as the service records it.
    pub(crate) admitted_clients: Arc<AdmittedClientStore>,
    /// The database the event log and the admitted clients are kept in.
    pub(crate) database: TestDatabase,
    /// The keychain service the sign-ins are kept under.
    pub(crate) keychain: Arc<dyn SecretKeychain>,
    /// The platform store under the keychain, which can refuse a call.
    pub(crate) platform_store: PlatformCredentialStore,
    /// The name the sign-ins are filed under in the platform store.
    pub(crate) sign_in_service_name: String,
    _data_folder: TempDir,
}

/// An owner's client secret read that finds none, for a test whose sign-ins hold no owner's client.
pub(crate) struct NoOwnerClientSecrets;

impl OwnerClientSecretReads for NoOwnerClientSecrets {
    fn read_owner_client_secret<'read>(
        &'read self,
        _binding: &'read McpServerBindingRef,
    ) -> BoxFuture<'read, Result<Option<SecretString>, HandlerError>> {
        async { Ok(None) }.boxed()
    }
}

/// A fresh [`Harness`] whose registry holds no provider.
pub(crate) async fn harness() -> Harness {
    harness_with(Vec::new()).await
}

/// A fresh [`Harness`] whose registry holds the table's first providers, one answered by each of
/// `drivers` in order.
pub(crate) async fn harness_with(drivers: Vec<Arc<dyn ProviderDriver>>) -> Harness {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let admitted_clients = Arc::new(AdmittedClientStore::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY,
        )),
        log.writer,
    ));
    let (data_folder, platform_store, keychain) = test_keychain(KeychainService::McpSignIns);
    let service = SignInService::new(
        SignInCustody::new(Arc::clone(&keychain)),
        Arc::clone(&admitted_clients),
        Arc::new(registry_of_first_providers(drivers)),
        Arc::new(NoOwnerClientSecrets),
        OAuthHttpPools::new().expect("the pools build"),
        &RELAY_ADDRESS,
        Arc::new(SessionEventAppender::new(
            log.service,
            SESSION_EVENT_VERSION.clone(),
        )),
    );
    Harness {
        service,
        admitted_clients,
        database,
        keychain,
        platform_store,
        sign_in_service_name: os_service_name(data_folder.path(), KeychainService::McpSignIns),
        _data_folder: data_folder,
    }
}

impl Harness {
    /// The payloads of every `mcp.server.signIn.completed` on the sentinel session, in order.
    pub(crate) fn completions(&self) -> Vec<Value> {
        self.database
            .reader()
            .prepare(
                "SELECT payload FROM session_events WHERE session_id = ?1 AND type = ?2
                  ORDER BY sequence",
            )
            .expect("the test reads the log")
            .query_map(
                params![
                    DAEMON_SCOPE_SENTINEL_SESSION_ID.text().as_str(),
                    SessionEventType::McpServerSignInCompleted.as_str()
                ],
                |row| row.get::<_, String>(0),
            )
            .expect("the log reads")
            .map(|payload| {
                serde_json::from_str(&payload.expect("a payload reads")).expect("a payload is JSON")
            })
            .collect()
    }

    /// The authorizer of the server at `base`, a fake authorization server, under the sign-in the
    /// service holds for it, made against the metadata the fake serves at
    /// [`NAMED_METADATA_PATH`], which it serves whether or not it refuses discovery, through the
    /// service's filtered pools as the daemon makes one.
    pub(crate) async fn authorizer(&self, base: &str) -> SignInAuthorizer {
        let address = McpServerAddress::new(base).expect("a server address");
        let metadata = read_named_metadata(
            &self.service.pools.server_client(&address),
            &Url::parse(&format!("{base}{NAMED_METADATA_PATH}")).expect("a URL"),
        )
        .await
        .expect("the fake serves its metadata");
        SignInAuthorizer::new(
            &self.service.custody,
            &self.service.pools,
            &address,
            metadata,
            Arc::clone(&self.service.owner_client_secrets),
            self.service.revocations.token().clone(),
        )
        .await
        .expect("the authorizer is made")
    }
}

/// One form an OAuth endpoint received: its fields, in order.
pub(crate) type TokenForm = Vec<(String, String)>;

/// A fake authorization server on a loopback port: its address and the requests it got.
pub(crate) struct FakeAuthorizationServer {
    /// The server's address, which is also its issuer.
    pub(crate) base: String,
    /// Every request it got.
    pub(crate) requests: Arc<AtomicUsize>,
    /// The token requests it got.
    pub(crate) token_requests: Arc<AtomicUsize>,
    /// The form of each token request, in order.
    pub(crate) token_forms: Arc<Mutex<Vec<TokenForm>>>,
    /// The form of each revocation request, in order.
    pub(crate) revocation_forms: Arc<Mutex<Vec<TokenForm>>>,
    /// The `Authorization` each revocation request carried, in order.
    pub(crate) revocation_authorizations: Arc<Mutex<Vec<Option<String>>>>,
    /// The `DPoP` proof each revocation request carried, in order.
    pub(crate) revocation_proofs: Arc<Mutex<Vec<Option<String>>>>,
    /// The path of every request it got, in order.
    pub(crate) paths: Arc<Mutex<Vec<String>>>,
}

/// The path the fake serves its metadata at besides its well-known one, which a test entry names
/// as its metadata address.
pub(crate) const NAMED_METADATA_PATH: &str = "/metadata";

/// The prefix of every path discovery asks for.
const WELL_KNOWN_PREFIX: &str = "/.well-known/";

/// How the fake authorization server answers; by default it lists `S256` as its PKCE method,
/// answers discovery, registers every client, publishes no pushed-request endpoint, answers every
/// token request with tokens and every revocation with 200.
#[derive(Clone, Copy)]
#[expect(
    clippy::struct_excessive_bools,
    reason = "each switch is one way the fake answers, set on its own"
)]
pub(crate) struct FakeServerAnswers {
    /// Whether its metadata says it sends `iss` with every response.
    pub(crate) is_issuer_in_response: bool,
    /// The PKCE methods its metadata lists; it names the field only when there are some.
    pub(crate) pkce_methods: &'static [&'static str],
    /// The authorization endpoint its metadata names; its own `/authorize` for `None`.
    pub(crate) authorization_endpoint: Option<&'static str>,
    /// Whether it refuses every registration with 403.
    pub(crate) is_registration_refused: bool,
    /// Whether it refuses every token request with `invalid_grant`.
    pub(crate) is_code_refused: bool,
    /// The `error` its pushed-request endpoint refuses every request with; it publishes no such
    /// endpoint for `None`.
    pub(crate) pushed_request_refusal: Option<&'static str>,
    /// The status its revocation endpoint answers.
    pub(crate) revocation_status: StatusCode,
    /// Whether it answers 500 on every well-known path, so discovery finds nothing; its metadata
    /// is still served at [`NAMED_METADATA_PATH`].
    pub(crate) is_discovery_refused: bool,
}

impl Default for FakeServerAnswers {
    fn default() -> Self {
        Self {
            is_issuer_in_response: false,
            pkce_methods: &["S256"],
            authorization_endpoint: None,
            is_registration_refused: false,
            is_code_refused: false,
            pushed_request_refusal: None,
            revocation_status: StatusCode::OK,
            is_discovery_refused: false,
        }
    }
}

/// The token endpoint's answer when the fake refuses a code: the server's own words, which no
/// event may carry.
pub(crate) const REFUSED_CODE_DESCRIPTION: &str = "the fake server refused this code";

/// The secret the fake issues with every client it registers, which the client sends in each
/// token request's form; made up for the test.
pub(crate) const REGISTERED_CLIENT_SECRET: &str = "test-registered-client-secret";

/// Serves a fake authorization server that publishes its metadata, listing the scopes `read` and
/// `write`, with a revocation endpoint and client secrets taken in the token request's form, and
/// answers as `answers` says.
pub(crate) async fn serve_authorization_server(
    answers: FakeServerAnswers,
) -> FakeAuthorizationServer {
    let FakeServerAnswers {
        is_issuer_in_response,
        pkce_methods,
        authorization_endpoint,
        is_registration_refused,
        is_code_refused,
        pushed_request_refusal,
        revocation_status,
        is_discovery_refused,
    } = answers;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local port");
    let base = format!(
        "http://{}",
        listener.local_addr().expect("the port's address")
    );
    let mut metadata = json!({
        "issuer": base,
        "authorization_endpoint": authorization_endpoint
            .map_or_else(|| format!("{base}/authorize"), str::to_owned),
        "token_endpoint": format!("{base}/token"),
        "registration_endpoint": format!("{base}/register"),
        "revocation_endpoint": format!("{base}/revoke"),
        "token_endpoint_auth_methods_supported": ["client_secret_post"],
        "response_types_supported": ["code"],
        "scopes_supported": ["read", "write"],
        "authorization_response_iss_parameter_supported": is_issuer_in_response,
    });
    if !pkce_methods.is_empty() {
        metadata["code_challenge_methods_supported"] = json!(pkce_methods);
    }
    if pushed_request_refusal.is_some() {
        metadata["pushed_authorization_request_endpoint"] = json!(format!("{base}/par"));
    }
    let metadata = metadata.to_string();
    let requests = Arc::new(AtomicUsize::new(0));
    let token_requests = Arc::new(AtomicUsize::new(0));
    let token_forms = Arc::new(Mutex::new(Vec::new()));
    let received_forms = Arc::clone(&token_forms);
    let revocation_forms = Arc::new(Mutex::new(Vec::new()));
    let received_revocations = Arc::clone(&revocation_forms);
    let revocation_authorizations = Arc::new(Mutex::new(Vec::new()));
    let received_authorizations = Arc::clone(&revocation_authorizations);
    let revocation_proofs = Arc::new(Mutex::new(Vec::new()));
    let received_proofs = Arc::clone(&revocation_proofs);
    let paths = Arc::new(Mutex::new(Vec::new()));
    let received_paths = Arc::clone(&paths);
    let counted = Arc::clone(&requests);
    let counted_tokens = Arc::clone(&token_requests);
    let named_metadata = metadata.clone();
    let router = Router::new()
        .route(
            "/.well-known/oauth-authorization-server",
            get(move || async move {
                if is_discovery_refused {
                    answer(500, "{}".to_owned())
                } else {
                    answer(200, metadata)
                }
            }),
        )
        .route(
            NAMED_METADATA_PATH,
            get(move || async move { answer(200, named_metadata) }),
        )
        .route(
            "/register",
            post(move |body: Bytes| async move {
                if is_registration_refused {
                    return answer(403, json!({"error": "access_denied"}).to_string());
                }
                let request: Value = serde_json::from_slice(&body).expect("a JSON registration");
                let client = json!({
                    "client_id": "registered-client",
                    "client_secret": REGISTERED_CLIENT_SECRET,
                    "redirect_uris": request["redirect_uris"],
                });
                answer(201, client.to_string())
            }),
        )
        .route(
            "/token",
            post(move |body: Bytes| async move {
                counted_tokens.fetch_add(1, Ordering::SeqCst);
                received_forms
                    .lock()
                    .expect("never poisoned")
                    .push(form_of(&body));
                if is_code_refused {
                    let refusal = json!({
                        "error": "invalid_grant",
                        "error_description": REFUSED_CODE_DESCRIPTION,
                    });
                    answer(400, refusal.to_string())
                } else {
                    let tokens = json!({
                        "access_token": "test-access-token",
                        "token_type": "Bearer",
                        "expires_in": 3600,
                        "refresh_token": "test-refresh-token",
                    });
                    answer(200, tokens.to_string())
                }
            }),
        )
        .route(
            "/par",
            post(move || async move {
                answer(400, json!({ "error": pushed_request_refusal }).to_string())
            }),
        )
        .route(
            "/revoke",
            post(move |headers: HeaderMap, body: Bytes| async move {
                received_authorizations
                    .lock()
                    .expect("never poisoned")
                    .push(
                        headers
                            .get(AUTHORIZATION)
                            .map(|value| value.to_str().expect("a text header").to_owned()),
                    );
                received_proofs.lock().expect("never poisoned").push(
                    headers
                        .get(DPOP_PROOF_HEADER_NAME)
                        .map(|value| value.to_str().expect("a text header").to_owned()),
                );
                received_revocations
                    .lock()
                    .expect("never poisoned")
                    .push(form_of(&body));
                answer(revocation_status.as_u16(), "{}".to_owned())
            }),
        )
        .fallback(move |uri: Uri| async move {
            if is_discovery_refused && uri.path().starts_with(WELL_KNOWN_PREFIX) {
                answer(500, "{}".to_owned())
            } else {
                answer(404, "{}".to_owned())
            }
        })
        .layer(middleware::from_fn(move |request: Request, next: Next| {
            counted.fetch_add(1, Ordering::SeqCst);
            received_paths
                .lock()
                .expect("never poisoned")
                .push(request.uri().path().to_owned());
            next.run(request)
        }));
    tokio::spawn(async move { axum::serve(listener, router).await });
    FakeAuthorizationServer {
        base,
        requests,
        token_requests,
        token_forms,
        revocation_forms,
        revocation_authorizations,
        revocation_proofs,
        paths,
    }
}

fn form_of(body: &[u8]) -> TokenForm {
    url::form_urlencoded::parse(body)
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect()
}

fn answer(status: u16, body: String) -> Response {
    Response::builder()
        .status(StatusCode::from_u16(status).expect("a status"))
        .header("content-type", "application/json")
        .body(Body::from(body))
        .expect("a response")
}

/// The provider every test binding names.
pub(crate) fn provider() -> ProviderId {
    ProviderId::new("provider-a".to_owned()).expect("a provider id")
}

/// The server name every test binding names.
pub(crate) fn server_name() -> McpServerName {
    McpServerName::new("docs".to_owned()).expect("a server name")
}

/// A user binding of the server at `base`.
pub(crate) fn addressed_target(base: &str) -> SignInTarget {
    SignInTarget {
        binding: McpServerBindingRef::User {
            provider: provider(),
            server_name: server_name(),
        },
        server: SignInServer::Address(Box::new(AddressedServer::new(
            McpServerAddress::new(base).expect("a server address"),
            None,
            None,
            None,
            false,
        ))),
        root_folder: None,
        every_project_rows: Vec::new(),
        project_rows: Vec::new(),
    }
}

/// Launches a sign-in to `target` that opens the browser, and answers the address it opens.
pub(crate) async fn launch_to_browser(harness: &Harness, target: &SignInTarget) -> Url {
    match harness
        .service
        .launch(target, &[], &ProviderAccounts::new())
        .await
    {
        Ok(browser_url) => Url::parse(browser_url.as_str()).expect("a web address parses"),
        Err(refusal) => unreachable!("the launch was refused: {refusal}"),
    }
}
