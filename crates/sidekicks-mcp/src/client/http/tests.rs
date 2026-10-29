//! The HTTP side: a server entry's reserved header, a `DPoP` challenge's parameters, and against
//! axum fakes on a loopback port an event past the size bound before and after an event id, a
//! server that refuses a request with a 401, asking for a proof bound to its nonce or for a token
//! renewed, and one that asks for a wider scope.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::post;
use bytes::Bytes;
use futures::future::BoxFuture;
use reqwest::Method;
use reqwest::header::{AUTHORIZATION, HeaderName, HeaderValue};
use rmcp::service::ClientInitializeError;
use rmcp::transport::streamable_http_client::{AuthRequiredError, InsufficientScopeError};
use rstest::rstest;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio::time::timeout;

use crate::client::connection::{McpConnectionError, McpServerConnection};
use crate::client::http::{
    AuthorizationResult, DEFAULT_MAX_SSE_EVENT_SIZE, McpRequestAuthorizer, NoAuthorization,
    RefusalAnswer, is_dpop_nonce_challenge,
};
use crate::client::requests::RequestWait;
use crate::client::test_server::{test_client, test_scope};

/// A 2025-11-25 server at an address whose event stream sends one small event with an id,
/// then one past the bound; the stream requests it received are counted.
async fn serve_oversized_event(stream_requests: Arc<AtomicUsize>) -> String {
    let oversized = format!(
        "id: e1\ndata: {{}}\n\ndata: {}\n\n",
        "x".repeat(DEFAULT_MAX_SSE_EVENT_SIZE + 1)
    );
    let router = Router::new().route(
        "/mcp",
        post(|body: String| async move { answer_post(&body) }).get(
            move |headers: HeaderMap| async move {
                stream_requests.fetch_add(1, Ordering::SeqCst);
                let resumed = headers.contains_key("last-event-id");
                let body = if resumed {
                    "id: e2\ndata: {}\n\n".to_owned()
                } else {
                    oversized
                };
                Response::builder()
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(Body::from(body))
                    .expect("a stream response")
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local port");
    let address = listener.local_addr().expect("the port's address");
    tokio::spawn(async move { axum::serve(listener, router).await });
    format!("http://{address}/mcp")
}

fn answer_post(body: &str) -> Response {
    let message: Value = serde_json::from_str(body).expect("the client posts JSON");
    let Some(id) = message.get("id").cloned() else {
        return StatusCode::ACCEPTED.into_response();
    };
    let reply = |status: StatusCode, member: Value| {
        let mut reply = json!({ "jsonrpc": "2.0", "id": id });
        reply
            .as_object_mut()
            .expect("an object")
            .extend(member.as_object().expect("an object").clone());
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .header("mcp-session-id", "session-1")
            .body(Body::from(reply.to_string()))
            .expect("a reply")
    };
    match message["method"].as_str() {
        Some("initialize") => reply(
            StatusCode::OK,
            json!({ "result": {
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "tracker", "version": "1.0.0" },
            } }),
        ),
        Some("server/discover") => reply(
            StatusCode::BAD_REQUEST,
            json!({ "error": { "code": -32601, "message": "Method not found" } }),
        ),
        _ => reply(
            StatusCode::OK,
            json!({ "error": { "code": -32601, "message": "Method not found" } }),
        ),
    }
}

// Mutation: in `McpHttpClient::events`, leave out the mark of a stream cut past the bound;
// rmcp then resumes the stream after `e1` and the server is asked for it again.
#[tokio::test]
async fn an_event_past_the_bound_ends_the_stream_without_a_resume() {
    let (client, _card) = test_client();
    let stream_requests = Arc::new(AtomicUsize::new(0));
    let uri = serve_oversized_event(Arc::clone(&stream_requests)).await;
    let authorizer: Arc<dyn McpRequestAuthorizer> = Arc::new(NoAuthorization);

    let connection = McpServerConnection::connect_http(
        &uri,
        HashMap::new(),
        authorizer,
        None,
        test_scope(&client),
    )
    .await
    .expect("the connection opens");
    timeout(Duration::from_secs(10), async {
        while stream_requests.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the stream is opened");
    // rmcp's first two reconnects wait 1 s and 2 s.
    tokio::time::sleep(Duration::from_millis(3_500)).await;

    assert_eq!(stream_requests.load(Ordering::SeqCst), 1);
    connection.close().await;
}

/// A 2025-11-25 server at an address whose `tasks/get` reply streams one event past the bound
/// before any id, and whose standalone stream sends nothing: the first closes once `release` is
/// notified, every later one stays open. The stream requests it received are counted.
async fn serve_id_less_cut(stream_requests: Arc<AtomicUsize>, release: Arc<Notify>) -> String {
    let router = Router::new().route(
        "/mcp",
        post(|body: String| async move {
            let message: Value = serde_json::from_str(&body).expect("the client posts JSON");
            if message["method"] != "tasks/get" {
                return answer_post(&body);
            }
            let oversized = format!("data: {}\n\n", "x".repeat(DEFAULT_MAX_SSE_EVENT_SIZE + 1));
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .header("mcp-session-id", "session-1")
                .body(Body::from(oversized))
                .expect("a stream response")
        })
        .get(move || async move {
            let body = if stream_requests.fetch_add(1, Ordering::SeqCst) == 0 {
                let closed = async move {
                    release.notified().await;
                    Ok::<_, Infallible>(Bytes::from_static(b": closing\n\n"))
                };
                Body::from_stream(futures::stream::once(closed))
            } else {
                Body::from_stream(futures::stream::pending::<Result<Bytes, Infallible>>())
            };
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(body)
                .expect("a stream response")
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local port");
    let address = listener.local_addr().expect("the port's address");
    tokio::spawn(async move { axum::serve(listener, router).await });
    format!("http://{address}/mcp")
}

// Mutation: in `McpHttpClient::events`, mark a stream cut before any event id; the standalone
// stream's resume, which names no id either, is then refused and the stream given up.
#[tokio::test]
async fn a_cut_before_any_event_id_leaves_the_standalone_stream_resuming() {
    let (client, _card) = test_client();
    let stream_requests = Arc::new(AtomicUsize::new(0));
    let release = Arc::new(Notify::new());
    let uri = serve_id_less_cut(Arc::clone(&stream_requests), Arc::clone(&release)).await;

    let connection = McpServerConnection::connect_http(
        &uri,
        HashMap::new(),
        Arc::new(NoAuthorization),
        None,
        test_scope(&client),
    )
    .await
    .expect("the connection opens");
    let cut = timeout(
        Duration::from_millis(500),
        connection.requests.send_raw(
            "tasks/get",
            Some(json!({ "taskId": "task-1" })),
            RequestWait::Ordinary,
        ),
    )
    .await;
    assert!(
        !matches!(cut, Ok(Ok(_))),
        "a reply cut past the bound is never read"
    );
    release.notify_one();

    timeout(Duration::from_secs(10), async {
        while stream_requests.load(Ordering::SeqCst) < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the standalone stream closed with no id is opened again");
    connection.close().await;
}

/// An authorizer that signs with a `DPoP` token, `token-1` until a refusal it answers renews it to
/// `token-2`, and a proof naming the nonce it was handed; it keeps the `error` of each refusal put
/// to it and answers yes only to `invalid_token`.
struct RenewingAuthorizer {
    token: Mutex<&'static str>,
    refusals: Mutex<Vec<Option<String>>>,
}

impl Default for RenewingAuthorizer {
    fn default() -> Self {
        Self {
            token: Mutex::new("token-1"),
            refusals: Mutex::default(),
        }
    }
}

impl McpRequestAuthorizer for RenewingAuthorizer {
    fn authorize(
        &self,
        _method: &Method,
        _uri: &str,
        dpop_nonce: Option<&str>,
    ) -> BoxFuture<'_, AuthorizationResult> {
        let token = *self.token.lock().expect("never poisoned");
        let proof = format!("proof-{}", dpop_nonce.unwrap_or("none"));
        Box::pin(async move {
            Ok(vec![
                (
                    AUTHORIZATION,
                    HeaderValue::from_str(&format!("DPoP {token}")).expect("a header value"),
                ),
                (
                    HeaderName::from_static("dpop"),
                    HeaderValue::from_str(&proof).expect("a header value"),
                ),
            ])
        })
    }

    fn answer_refusal<'call>(
        &'call self,
        _sent_authorization: Option<&'call HeaderValue>,
        challenge_error: Option<&'call str>,
    ) -> BoxFuture<'call, RefusalAnswer> {
        self.refusals
            .lock()
            .expect("never poisoned")
            .push(challenge_error.map(str::to_owned));
        let is_renewed = challenge_error == Some("invalid_token");
        if is_renewed {
            *self.token.lock().expect("never poisoned") = "token-2";
        }
        Box::pin(async move { Ok(is_renewed) })
    }
}

/// How the fake server refuses a request with a 401.
#[derive(Clone, Copy)]
enum Unauthorized {
    /// Any request whose proof is not bound to its nonce `n1`, asking for it.
    UntilNonceBound,
    /// Any request not carrying `token-2`, as `invalid_token`.
    UntilRenewed,
    /// Every request, as `invalid_token`.
    Always,
}

/// A 2025-11-25 server at an address that refuses requests as `unauthorized` says, and takes one
/// only with a single `Authorization` header; the body of each request it receives is kept.
async fn serve_unauthorized(unauthorized: Unauthorized, posts: Arc<Mutex<Vec<String>>>) -> String {
    let router = Router::new().route(
        "/mcp",
        post(move |headers: HeaderMap, body: String| async move {
            posts.lock().expect("never poisoned").push(body.clone());
            if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
                return StatusCode::BAD_REQUEST.into_response();
            }
            let challenge = match unauthorized {
                Unauthorized::UntilNonceBound
                    if headers.get("dpop").is_none_or(|proof| proof != "proof-n1") =>
                {
                    "DPoP error=\"use_dpop_nonce\", error_description=\"a nonce is needed\""
                }
                Unauthorized::UntilRenewed
                    if headers
                        .get(header::AUTHORIZATION)
                        .is_none_or(|token| token != "DPoP token-2") =>
                {
                    "DPoP error=\"invalid_token\""
                }
                Unauthorized::Always => "DPoP error=\"invalid_token\"",
                Unauthorized::UntilNonceBound | Unauthorized::UntilRenewed => {
                    return answer_post(&body);
                }
            };
            Response::builder()
                .status(StatusCode::UNAUTHORIZED)
                .header(header::WWW_AUTHENTICATE, challenge)
                .header("dpop-nonce", "n1")
                .body(Body::empty())
                .expect("a refusal")
        })
        .get(|| async { StatusCode::METHOD_NOT_ALLOWED }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local port");
    let address = listener.local_addr().expect("the port's address");
    tokio::spawn(async move { axum::serve(listener, router).await });
    format!("http://{address}/mcp")
}

// Mutations: in `McpHttpClient::send`, put a nonce challenge to the authorizer, return the 401
// asking for the nonce instead of sending again, hand the authorizer no nonce, or send again
// after a resend.
#[rstest]
#[case::a_nonce_challenge(Unauthorized::UntilNonceBound, &[], true)]
#[case::an_invalid_token(Unauthorized::UntilRenewed, &[Some("invalid_token")], true)]
#[case::a_refusal_after_the_resend(Unauthorized::Always, &[Some("invalid_token")], false)]
#[tokio::test]
async fn a_refused_request_is_sent_once_more_at_most(
    #[case] unauthorized: Unauthorized,
    #[case] refusals: &[Option<&str>],
    #[case] is_opened: bool,
) {
    let (client, _card) = test_client();
    let posts = Arc::new(Mutex::new(Vec::new()));
    let uri = serve_unauthorized(unauthorized, Arc::clone(&posts)).await;
    let authorizer = Arc::new(RenewingAuthorizer::default());

    let opened = McpServerConnection::connect_http(
        &uri,
        HashMap::new(),
        Arc::clone(&authorizer) as Arc<dyn McpRequestAuthorizer>,
        None,
        test_scope(&client),
    )
    .await;

    let refusals_put = authorizer.refusals.lock().expect("never poisoned").clone();
    assert_eq!(
        refusals_put,
        refusals
            .iter()
            .map(|error| error.map(str::to_owned))
            .collect::<Vec<_>>()
    );
    let posts = posts.lock().expect("never poisoned").clone();
    assert_eq!(posts[0], posts[1], "the first request is sent once more");
    if is_opened {
        assert_ne!(posts.get(2), Some(&posts[0]), "and only once");
        opened.expect("the connection opens").close().await;
        return;
    }
    assert_eq!(
        posts.len(),
        2,
        "a request refused after its resend is not sent again"
    );
    let Err(McpConnectionError::Initialize(error)) = opened else {
        panic!("the start fails");
    };
    let ClientInitializeError::TransportError { error, .. } = *error else {
        panic!("the transport fails the start, not {error}");
    };
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(&*error.error);
    while let Some(current) = cause {
        if current.downcast_ref::<AuthRequiredError>().is_some() {
            return;
        }
        cause = current.source();
    }
    panic!("the chain carries the sign-in the server asks for");
}

/// A server at an address that refuses every request with a 403 asking for the `tracker:write`
/// scope.
async fn serve_insufficient_scope() -> String {
    let router = Router::new().route(
        "/mcp",
        post(|| async {
            Response::builder()
                .status(StatusCode::FORBIDDEN)
                .header(
                    header::WWW_AUTHENTICATE,
                    "Bearer error=\"insufficient_scope\", scope=\"tracker:write\"",
                )
                .body(Body::empty())
                .expect("a refusal")
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local port");
    let address = listener.local_addr().expect("the port's address");
    tokio::spawn(async move { axum::serve(listener, router).await });
    format!("http://{address}/mcp")
}

// Mutations: in `auth_challenge`, leave out the 403 arm, or read no scope in `required_scope`.
#[tokio::test]
async fn a_server_refusing_with_a_403_asks_for_the_scope_its_challenge_names() {
    let (client, _card) = test_client();
    let uri = serve_insufficient_scope().await;

    let opened = McpServerConnection::connect_http(
        &uri,
        HashMap::new(),
        Arc::new(NoAuthorization),
        None,
        test_scope(&client),
    )
    .await;

    let Err(McpConnectionError::Initialize(error)) = opened else {
        panic!("the start fails");
    };
    let ClientInitializeError::TransportError { error, .. } = *error else {
        panic!("the transport fails the start, not {error}");
    };
    let mut cause: Option<&(dyn std::error::Error + 'static)> = Some(&*error.error);
    let insufficient = loop {
        let current = cause.expect("the chain carries the insufficient scope");
        if let Some(insufficient) = current.downcast_ref::<InsufficientScopeError>() {
            break insufficient;
        }
        cause = current.source();
    };
    assert_eq!(
        insufficient.required_scope.as_deref(),
        Some("tracker:write")
    );
}

// Mutation: in `read_auth_param`, match the parameter's name with case, read only a quoted value,
// take any scheme, or keep the first scheme for every challenge after it.
#[rstest]
#[case::a_bare_token("DPoP error=use_dpop_nonce", true)]
#[case::a_name_in_capitals("DPoP ERROR=\"use_dpop_nonce\"", true)]
#[case::a_quoted_value_beside_a_description(
    "dpop error_description=\"say error=x\", error = \"use_dpop_nonce\"",
    true
)]
#[case::another_scheme("Bearer error=\"use_dpop_nonce\"", false)]
#[case::another_error("DPoP error=\"invalid_dpop_proof\"", false)]
#[case::a_dpop_challenge_after_a_bearer_one(
    "Bearer realm=\"x\", DPoP error=\"use_dpop_nonce\"",
    true
)]
#[case::the_error_of_a_bearer_challenge_after_a_dpop_one(
    "DPoP algs=\"ES256\", Bearer error=\"use_dpop_nonce\"",
    false
)]
fn a_dpop_challenge_asks_for_the_nonce_by_its_error_parameter(
    #[case] challenge: &str,
    #[case] expected: bool,
) {
    assert_eq!(is_dpop_nonce_challenge(challenge), expected);
}

// Mutation: in `connect_http`, leave out the reserved-header check, or compare names with case.
#[rstest]
#[case::accept("Accept")]
#[case::session_id("Mcp-Session-Id")]
#[case::last_event_id("LAST-EVENT-ID")]
#[tokio::test]
async fn a_server_entry_setting_a_header_the_transport_sets_is_refused(#[case] name: &str) {
    let (client, _card) = test_client();
    let headers = HashMap::from([(
        HeaderName::from_bytes(name.as_bytes()).expect("a header name"),
        HeaderValue::from_static("x"),
    )]);

    let opened = McpServerConnection::connect_http(
        "http://127.0.0.1:9/mcp",
        headers,
        Arc::new(NoAuthorization),
        None,
        test_scope(&client),
    )
    .await;

    assert!(matches!(
        opened,
        Err(McpConnectionError::ReservedHeader { name: refused })
            if refused.eq_ignore_ascii_case(name)
    ));
}
