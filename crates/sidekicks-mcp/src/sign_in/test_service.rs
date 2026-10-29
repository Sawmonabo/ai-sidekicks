//! The sign-in service over a test database, event log and keychain, and a fake authorization
//! server on a loopback port, for the sign-in's tests.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use reqwest::Url;
use rusqlite::params;
use serde_json::{Value, json};
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName};
use sidekicks_contracts::provider::id::ProviderId;
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
use crate::sign_in::credential_store::SignInCustody;
use crate::sign_in::oauth_http_client::OAuthHttpPools;
use crate::sign_in::registration::RELAY_ADDRESS;
use crate::sign_in::service::{
    AddressedServer, SignInLaunch, SignInServer, SignInService, SignInTarget,
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
    _data_folder: TempDir,
}

/// A fresh [`Harness`].
pub(crate) async fn harness() -> Harness {
    let database = TestDatabase::new(schema_parts());
    let log = open_log(&database, None).await;
    let admitted_clients = Arc::new(AdmittedClientStore::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY,
        )),
        log.writer,
    ));
    let (data_folder, _platform_store, keychain) = test_keychain();
    let service = SignInService::new(
        SignInCustody::new(keychain),
        Arc::clone(&admitted_clients),
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
}

/// A fake authorization server on a loopback port: its address and the requests it got.
pub(crate) struct FakeAuthorizationServer {
    /// The server's address, which is also its issuer.
    pub(crate) base: String,
    /// Every request it got.
    pub(crate) requests: Arc<AtomicUsize>,
    /// The token requests it got.
    pub(crate) token_requests: Arc<AtomicUsize>,
}

/// The token endpoint's answer when the fake refuses a code: the server's own words, which no
/// event may carry.
pub(crate) const REFUSED_CODE_DESCRIPTION: &str = "the fake server refused this code";

/// Serves a fake authorization server that publishes its metadata, saying it sends `iss` with
/// every response when `is_issuer_in_response`, registers every client and answers each token
/// request with tokens, or with an `invalid_grant` refusal when `is_code_refused`.
pub(crate) async fn serve_authorization_server(
    is_issuer_in_response: bool,
    is_code_refused: bool,
) -> FakeAuthorizationServer {
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
        "authorization_response_iss_parameter_supported": is_issuer_in_response,
    })
    .to_string();
    let requests = Arc::new(AtomicUsize::new(0));
    let token_requests = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&requests);
    let counted_tokens = Arc::clone(&token_requests);
    let router = Router::new()
        .route(
            "/.well-known/oauth-authorization-server",
            get(move || async move { answer(200, metadata) }),
        )
        .route(
            "/register",
            post(|body: Bytes| async move {
                let request: Value = serde_json::from_slice(&body).expect("a JSON registration");
                let client = json!({
                    "client_id": "registered-client",
                    "redirect_uris": request["redirect_uris"],
                });
                answer(201, client.to_string())
            }),
        )
        .route(
            "/token",
            post(move || async move {
                counted_tokens.fetch_add(1, Ordering::SeqCst);
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
    }
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
    }
}

/// Launches a sign-in to `target` that opens the browser, and answers the address it opens.
pub(crate) async fn launch_to_browser(harness: &Harness, target: &SignInTarget) -> Url {
    match harness.service.launch(target, &[]).await {
        Ok(SignInLaunch::Browser(browser_url)) => browser_url,
        Ok(SignInLaunch::ProviderFlow { .. }) => {
            unreachable!("a server that registers every client opens the browser")
        }
        Err(refusal) => unreachable!("the launch was refused: {refusal}"),
    }
}
