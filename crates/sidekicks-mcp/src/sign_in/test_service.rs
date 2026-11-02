//! The sign-in service over a test database, event log and keychain, and a fake authorization
//! server on a loopback port, for the sign-in's tests.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use reqwest::Url;
use rmcp::transport::auth::AuthorizationManager;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_platforms::CredentialStore as PlatformCredentialStore;
use sidekicks_provider::driver::contract::ProviderDriver;
use sidekicks_provider::driver::test_registry::registry_of_first_providers;
use sidekicks_std::keyed_lock::KeyedLock;
use sidekicks_store::credential_store::SecretKeychain;
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
use crate::sign_in::service::{
    AddressedServer, ProviderAccounts, SignInServer, SignInService, SignInTarget,
};
use crate::sign_in::test_keychain::test_keychain;

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
    _data_folder: TempDir,
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
    let (data_folder, platform_store, keychain) = test_keychain();
    let service = SignInService::new(
        SignInCustody::new(Arc::clone(&keychain)),
        Arc::clone(&admitted_clients),
        Arc::new(registry_of_first_providers(drivers)),
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

    /// The authorizer of the server at `base` under the sign-in the service holds for it, made
    /// against the metadata the server publishes.
    pub(crate) async fn authorizer(&self, base: &str) -> SignInAuthorizer {
        let manager = AuthorizationManager::new(base)
            .await
            .expect("a manager for a loopback server");
        let metadata = manager
            .resolve_metadata()
            .await
            .expect("the server publishes its metadata")
            .metadata;
        SignInAuthorizer::new(
            &self.service.custody,
            &McpServerAddress::new(base).expect("a server address"),
            manager,
            metadata,
            Arc::new(KeyedLock::default()),
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
}

/// How the fake authorization server answers; by default it registers every client, answers
/// every token request with tokens and every revocation with 200.
#[derive(Clone, Copy)]
pub(crate) struct FakeServerAnswers {
    /// Whether its metadata says it sends `iss` with every response.
    pub(crate) is_issuer_in_response: bool,
    /// Whether it refuses every registration with 403.
    pub(crate) is_registration_refused: bool,
    /// Whether it refuses every token request with `invalid_grant`.
    pub(crate) is_code_refused: bool,
    /// The status its revocation endpoint answers.
    pub(crate) revocation_status: StatusCode,
}

impl Default for FakeServerAnswers {
    fn default() -> Self {
        Self {
            is_issuer_in_response: false,
            is_registration_refused: false,
            is_code_refused: false,
            revocation_status: StatusCode::OK,
        }
    }
}

/// The token endpoint's answer when the fake refuses a code: the server's own words, which no
/// event may carry.
pub(crate) const REFUSED_CODE_DESCRIPTION: &str = "the fake server refused this code";

/// The secret the fake issues with every client it registers, which the client sends in each
/// token request's form; made up for the test.
pub(crate) const REGISTERED_CLIENT_SECRET: &str = "test-registered-client-secret";

/// Serves a fake authorization server that publishes its metadata, with a revocation endpoint and
/// client secrets taken in the token request's form, and answers as `answers` says.
pub(crate) async fn serve_authorization_server(
    answers: FakeServerAnswers,
) -> FakeAuthorizationServer {
    let FakeServerAnswers {
        is_issuer_in_response,
        is_registration_refused,
        is_code_refused,
        revocation_status,
    } = answers;
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
        "revocation_endpoint": format!("{base}/revoke"),
        "token_endpoint_auth_methods_supported": ["client_secret_post"],
        "response_types_supported": ["code"],
        "code_challenge_methods_supported": ["S256"],
        "authorization_response_iss_parameter_supported": is_issuer_in_response,
    })
    .to_string();
    let requests = Arc::new(AtomicUsize::new(0));
    let token_requests = Arc::new(AtomicUsize::new(0));
    let token_forms = Arc::new(Mutex::new(Vec::new()));
    let received_forms = Arc::clone(&token_forms);
    let revocation_forms = Arc::new(Mutex::new(Vec::new()));
    let received_revocations = Arc::clone(&revocation_forms);
    let counted = Arc::clone(&requests);
    let counted_tokens = Arc::clone(&token_requests);
    let router = Router::new()
        .route(
            "/.well-known/oauth-authorization-server",
            get(move || async move { answer(200, metadata) }),
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
            "/revoke",
            post(move |body: Bytes| async move {
                received_revocations
                    .lock()
                    .expect("never poisoned")
                    .push(form_of(&body));
                answer(revocation_status.as_u16(), "{}".to_owned())
            }),
        )
        .fallback(|| async { answer(404, "{}".to_owned()) })
        .layer(middleware::from_fn(move |request: Request, next: Next| {
            counted.fetch_add(1, Ordering::SeqCst);
            next.run(request)
        }));
    tokio::spawn(async move { axum::serve(listener, router).await });
    FakeAuthorizationServer {
        base,
        requests,
        token_requests,
        token_forms,
        revocation_forms,
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
        server: SignInServer::Address(AddressedServer::new(
            McpServerAddress::new(base).expect("a server address"),
            None,
        )),
        root_folder: None,
    }
}

/// Launches a sign-in to `target` that opens the browser, and answers the address it opens.
pub(crate) async fn launch_to_browser(harness: &Harness, target: &SignInTarget) -> Url {
    match harness
        .service
        .launch(target, &[], &ProviderAccounts::new())
        .await
    {
        Ok(browser_url) => browser_url,
        Err(refusal) => unreachable!("the launch was refused: {refusal}"),
    }
}
