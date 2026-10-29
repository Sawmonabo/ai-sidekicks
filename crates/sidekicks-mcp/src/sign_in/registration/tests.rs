use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use rmcp::transport::auth::{AuthorizationManager, OAuthHttpClient};
use rstest::rstest;
use serde_json::{Value, json};
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use sidekicks_store::database::connection::read_pool::DatabaseReadPool;
use sidekicks_store::database::writer::test_file::TestDatabase;
use sidekicks_store::database::writer::{DatabaseWriter, DatabaseWriterOptions};
use url::Url;

use super::{
    ClientRequest, RelayAddress, SignInClient, choose_client, classify_pushed_authorization_refusal,
};
use crate::oauth::pushed_authorization::PushedAuthorizationRefusal;
use crate::schema::schema_parts;
use crate::sign_in::admitted_client::{
    AdmittedClientStore, MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY,
};
use crate::sign_in::oauth_http_client::OAuthHttpPools;

const LOOPBACK_REDIRECT: &str = "http://127.0.0.1:7341/callback";
const RELAY: &str = "https://relay.example.com/";
const CREATED: (u16, &str) = (
    201,
    r#"{"client_id":"registered-client","redirect_uris":["http://127.0.0.1:7341/callback"]}"#,
);
const INVALID_REDIRECT_URI: (u16, &str) = (400, r#"{"error":"invalid_redirect_uri"}"#);
const INVALID_CLIENT_METADATA: (u16, &str) = (400, r#"{"error":"invalid_client_metadata"}"#);

/// What the server's registration endpoint is.
#[derive(Clone, Copy)]
enum RegistrationEndpoint {
    /// It answers each registration with the next of these statuses and bodies.
    Answering(&'static [(u16, &'static str)]),
    /// It names a port nothing listens on.
    Unreachable,
    /// The metadata names none.
    Absent,
}

/// What the store knows of the server's admitted client before the sign-in.
#[derive(Clone, Copy)]
enum Admitted {
    Nothing,
    Provider,
    OwnClientUnfinished,
}

/// One row of the registration table: the server, this computer and the sign-in asked for.
struct Row {
    /// `None` when the server publishes no metadata.
    registration: Option<RegistrationEndpoint>,
    takes_public_clients: bool,
    has_relay: bool,
    owner_client_id: Option<&'static str>,
    redirect_address: &'static str,
    admitted: Admitted,
    pushed_refusal: Option<PushedAuthorizationRefusal>,
}

impl Row {
    fn with(registration: Option<RegistrationEndpoint>) -> Self {
        Self {
            registration,
            takes_public_clients: true,
            has_relay: true,
            owner_client_id: None,
            redirect_address: LOOPBACK_REDIRECT,
            admitted: Admitted::Nothing,
            pushed_refusal: None,
        }
    }
}

// A server that publishes metadata whose registration endpoint answers `answers` in turn, which
// also takes the relay's document for a public client, on a computer with a relay.
fn answering(answers: &'static [(u16, &'static str)]) -> Row {
    Row::with(Some(RegistrationEndpoint::Answering(answers)))
}

fn without_endpoint() -> Row {
    Row::with(Some(RegistrationEndpoint::Absent))
}

/// The arm a row ends in, as the test compares it: the own client by its `client_id`, the
/// provider's flow by the admitted provider.
#[derive(Debug, PartialEq, Eq)]
enum Arm {
    OwnClient(String),
    Failed,
    Unsupported,
    ProviderFlow(Option<String>),
}

fn own(client_id: &str) -> Arm {
    Arm::OwnClient(client_id.to_owned())
}

fn provider_flow() -> Arm {
    Arm::ProviderFlow(None)
}

fn arm_of(client: SignInClient) -> Arm {
    match client {
        SignInClient::OwnClient(config) => Arm::OwnClient(config.client_id),
        SignInClient::Failed { .. } => Arm::Failed,
        SignInClient::Unsupported => Arm::Unsupported,
        SignInClient::ProviderFlow { admitted_provider } => {
            Arm::ProviderFlow(admitted_provider.map(|provider| provider.as_str().to_owned()))
        }
    }
}

/// What the fake authorization server serves and what it was sent.
struct FakeServer {
    metadata: Option<Value>,
    answers: VecDeque<(u16, &'static str)>,
    /// The `application_type` of each registration request, in order.
    application_types: Vec<String>,
}

// A fake authorization server on a loopback port serving `registration`'s metadata, returning
// its base address and its record.
async fn serve(row: &Row) -> (String, Arc<Mutex<FakeServer>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local port");
    let base = format!(
        "http://{}",
        listener.local_addr().expect("the port's address")
    );
    let (registration_endpoint, answers) = match row.registration {
        Some(RegistrationEndpoint::Answering(answers)) => (
            Some(format!("{base}/register")),
            answers.iter().copied().collect(),
        ),
        Some(RegistrationEndpoint::Unreachable) => {
            let closed = std::net::TcpListener::bind("127.0.0.1:0").expect("a local port");
            let port = closed.local_addr().expect("the port's address").port();
            drop(closed);
            (
                Some(format!("http://127.0.0.1:{port}/register")),
                VecDeque::new(),
            )
        }
        Some(RegistrationEndpoint::Absent) | None => (None, VecDeque::new()),
    };
    let metadata = row.registration.map(|_| {
        let mut metadata = json!({
            "issuer": base,
            "authorization_endpoint": format!("{base}/authorize"),
            "token_endpoint": format!("{base}/token"),
            "response_types_supported": ["code"],
            "code_challenge_methods_supported": ["S256"],
            "client_id_metadata_document_supported": true,
            "token_endpoint_auth_methods_supported":
                if row.takes_public_clients { json!(["none"]) } else { json!(["private_key_jwt"]) },
        });
        if let Some(endpoint) = registration_endpoint {
            metadata["registration_endpoint"] = json!(endpoint);
        }
        metadata
    });
    let server = Arc::new(Mutex::new(FakeServer {
        metadata,
        answers,
        application_types: Vec::new(),
    }));
    let (read, registered) = (Arc::clone(&server), Arc::clone(&server));
    let router = Router::new()
        .route(
            "/.well-known/oauth-authorization-server",
            get(move || async move {
                match lock(&read).metadata.clone() {
                    Some(metadata) => answer(200, &metadata.to_string()),
                    None => answer(404, "{}"),
                }
            }),
        )
        .route(
            "/register",
            post(move |body: Bytes| async move {
                let request: Value = serde_json::from_slice(&body).expect("a JSON registration");
                let mut server = lock(&registered);
                server.application_types.push(
                    request["application_type"]
                        .as_str()
                        .unwrap_or("absent")
                        .to_owned(),
                );
                let (status, body) = server.answers.pop_front().unwrap_or((500, "{}"));
                answer(status, body)
            }),
        )
        .fallback(|| async { answer(404, "{}") });
    tokio::spawn(async move { axum::serve(listener, router).await });
    (base, server)
}

fn answer(status: u16, body: &str) -> Response {
    Response::builder()
        .status(StatusCode::from_u16(status).expect("a status"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_owned()))
        .expect("a response")
}

// Each case's comment names the mistake it catches. The servers that register also advertise the
// relay's document for a public client, on a computer with a relay, so a document offered before
// registration names the document's address where the registered client is expected.
#[rstest]
// A registration sent for an owner-issued client.
#[case::an_owner_issued_client(
    Row { owner_client_id: Some("owner-client"), ..answering(&[CREATED]) },
    own("owner-client"), &[])]
// The document offered before dynamic registration.
#[case::registration_answered_201(answering(&[CREATED]), own("registered-client"), &["native"])]
// No retry, or a retry that adjusts nothing.
#[case::invalid_redirect_uri_then_201(answering(&[INVALID_REDIRECT_URI, CREATED]),
    own("registered-client"), &["native", "web"])]
// A second retry after the adjusted one (the server then answers 500 and the row fails).
#[case::invalid_client_metadata_twice(
    answering(&[INVALID_CLIENT_METADATA, INVALID_CLIENT_METADATA]),
    provider_flow(), &["native", "web"])]
// A retry for an error that earns none.
#[case::another_400(answering(&[(400, r#"{"error":"invalid_software_statement"}"#)]),
    provider_flow(), &["native"])]
#[case::a_403(answering(&[(403, "{}")]), provider_flow(), &["native"])]
// A provider's flow on a server error.
#[case::a_503(answering(&[(503, "{}")]), Arm::Failed, &["native"])]
// A provider's flow when no answer came.
#[case::a_network_error(Row::with(Some(RegistrationEndpoint::Unreachable)), Arm::Failed,
    &[])]
// The document's address built wrong, or not offered where it is the way in.
#[case::no_endpoint_with_a_relay_taking_the_document(without_endpoint(),
    own("https://relay.example.com/oauth/mcp/client.json"), &[])]
// The per-server callback's id left out of its document's address.
#[case::no_endpoint_with_a_per_server_callback(
    Row { redirect_address: "http://127.0.0.1:7341/callback/0f3a9c2b", ..without_endpoint() },
    own("https://relay.example.com/oauth/mcp/0f3a9c2b/client.json"), &[])]
// The document offered to a server that takes no public client.
#[case::no_endpoint_with_a_relay_and_no_public_clients(
    Row { takes_public_clients: false, ..without_endpoint() },
    provider_flow(), &[])]
// The document offered with no relay to serve it, or the sign-in refused outright.
#[case::no_endpoint_and_no_relay(Row { has_relay: false, ..without_endpoint() },
    provider_flow(), &[])]
// rmcp's made-up endpoints taken as a sign-in route.
#[case::no_metadata(Row::with(None), Arm::Unsupported, &[])]
#[case::pushed_authorization_refused_invalid_client(
    Row { pushed_refusal: Some(PushedAuthorizationRefusal::InvalidClient),
          ..answering(&[CREATED]) },
    provider_flow(), &["native"])]
// The admitted row read after registration, or not at all.
#[case::an_admitted_provider(Row { admitted: Admitted::Provider, ..answering(&[CREATED]) },
    Arm::ProviderFlow(Some("provider-a".to_owned())), &[])]
#[case::an_own_client_attempt_that_did_not_finish(
    Row { admitted: Admitted::OwnClientUnfinished, ..answering(&[CREATED]) },
    provider_flow(), &[])]
// The daemon's own client used for a callback it never binds.
#[case::a_non_loopback_owner_redirect(
    Row { owner_client_id: Some("owner-client"),
          redirect_address: "https://callback.example.com/oauth",
          ..answering(&[CREATED]) },
    provider_flow(), &[])]
#[tokio::test]
async fn each_registration_row_ends_in_its_arm(
    #[case] row: Row,
    #[case] expected_arm: Arm,
    #[case] expected_application_types: &[&str],
) {
    let (base, server) = serve(&row).await;
    let server_address = McpServerAddress::new(&base).expect("a server address");

    let database = TestDatabase::new(schema_parts());
    let writer = DatabaseWriter::open(database.opener(), DatabaseWriterOptions::default())
        .await
        .expect("the writer opens its database");
    let admitted_clients = AdmittedClientStore::new(
        Arc::new(DatabaseReadPool::new(
            database.path(),
            MCP_ADMITTED_CLIENT_STATEMENT_CAPACITY,
        )),
        Arc::new(writer),
    );
    match row.admitted {
        Admitted::Nothing => {}
        Admitted::Provider => admitted_clients
            .record_admitted_provider(
                &server_address,
                &ProviderId::new("provider-a".to_owned()).expect("a provider id"),
            )
            .await
            .expect("the admitted client is recorded"),
        Admitted::OwnClientUnfinished => admitted_clients
            .mark_own_client_unfinished(&server_address)
            .await
            .expect("the mark is recorded"),
    }
    let relay = PortRegistration::new("relay address");
    if row.has_relay {
        relay
            .register(RelayAddress::new(Url::parse(RELAY).expect("a URL")))
            .expect("the relay registers");
    }

    let http_client = Arc::new(
        OAuthHttpPools::new()
            .expect("the pools build")
            .server_client(&server_address),
    );
    let mut manager = AuthorizationManager::new_with_oauth_http_client(
        base.as_str(),
        Arc::clone(&http_client) as Arc<dyn OAuthHttpClient>,
    )
    .await
    .expect("a manager");
    let resolution = manager.resolve_metadata().await.expect("discovery answers");
    let redirect_address = Url::parse(row.redirect_address).expect("a URL");
    let request = ClientRequest {
        server_address: &server_address,
        redirect_address: &redirect_address,
        owner_client_id: row.owner_client_id,
        scopes: &[],
    };
    let mut client = choose_client(
        &request,
        &admitted_clients,
        &relay,
        &mut manager,
        &http_client,
        resolution,
    )
    .await;
    if let (SignInClient::OwnClient(_), Some(refusal)) = (&client, row.pushed_refusal) {
        client = classify_pushed_authorization_refusal(refusal);
    }

    assert_eq!(arm_of(client), expected_arm);
    assert_eq!(lock(&server).application_types, expected_application_types);
}
