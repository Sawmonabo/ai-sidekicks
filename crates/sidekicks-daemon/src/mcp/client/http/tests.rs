//! The HTTP side against axum fakes on a loopback port: an event past the size bound, and a
//! server that asks for a DPoP proof bound to its nonce.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::post;
use futures::future::BoxFuture;
use reqwest::Method;
use reqwest::header::{AUTHORIZATION, HeaderName, HeaderValue};
use serde_json::{Value, json};

use crate::mcp::client::connection::McpServerConnection;
use crate::mcp::client::http::{
    AuthorizationResult, DEFAULT_MAX_SSE_EVENT_SIZE, McpRequestAuthorizer, NoAuthorization,
};
use crate::mcp::client::test_server::{test_client, test_scope};

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
    while stream_requests.load(Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // rmcp's first two reconnects wait 1 s and 2 s.
    tokio::time::sleep(Duration::from_millis(3_500)).await;

    assert_eq!(stream_requests.load(Ordering::SeqCst), 1);
    connection.close().await;
}

/// An authorizer that signs with a DPoP token and a proof naming the nonce it was handed, each
/// nonce kept in order.
#[derive(Default)]
struct DpopAuthorizer {
    nonces: Mutex<Vec<Option<String>>>,
}

impl McpRequestAuthorizer for DpopAuthorizer {
    fn authorize(
        &self,
        _method: &Method,
        _uri: &str,
        dpop_nonce: Option<&str>,
    ) -> BoxFuture<'_, AuthorizationResult> {
        self.nonces
            .lock()
            .expect("never poisoned")
            .push(dpop_nonce.map(str::to_owned));
        let proof = format!("proof-{}", dpop_nonce.unwrap_or("none"));
        Box::pin(async move {
            Ok(vec![
                (AUTHORIZATION, HeaderValue::from_static("DPoP token")),
                (
                    HeaderName::from_static("dpop"),
                    HeaderValue::from_str(&proof).expect("a header value"),
                ),
            ])
        })
    }
}

/// A 2025-11-25 server at an address that takes a request only with the proof bound to its
/// nonce `n1` and one `Authorization` header, and asks for the nonce with a 401 otherwise.
async fn serve_nonce_bound() -> String {
    let router = Router::new().route(
        "/mcp",
        post(|headers: HeaderMap, body: String| async move {
            if headers.get_all(header::AUTHORIZATION).iter().count() != 1 {
                return StatusCode::BAD_REQUEST.into_response();
            }
            if headers.get("dpop").is_none_or(|proof| proof != "proof-n1") {
                return Response::builder()
                    .status(StatusCode::UNAUTHORIZED)
                    .header(
                        header::WWW_AUTHENTICATE,
                        "DPoP error=\"use_dpop_nonce\", error_description=\"a nonce is needed\"",
                    )
                    .header("dpop-nonce", "n1")
                    .body(Body::empty())
                    .expect("a refusal");
            }
            answer_post(&body)
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

// Mutations: in `McpHttpClient::send`, return the 401 asking for the nonce instead of sending
// again, or hand the authorizer no nonce.
#[tokio::test]
async fn a_server_asking_for_a_dpop_nonce_gets_the_request_again_bound_to_it() {
    let (client, _card) = test_client();
    let uri = serve_nonce_bound().await;
    let authorizer = Arc::new(DpopAuthorizer::default());

    let connection = McpServerConnection::connect_http(
        &uri,
        HashMap::new(),
        Arc::clone(&authorizer) as Arc<dyn McpRequestAuthorizer>,
        None,
        test_scope(&client),
    )
    .await
    .expect("the connection opens once the request is bound to the nonce");

    let nonces = authorizer.nonces.lock().expect("never poisoned").clone();
    assert_eq!(nonces[..2], [None, Some("n1".to_owned())]);
    assert!(
        nonces[2..]
            .iter()
            .all(|nonce| nonce.as_deref() == Some("n1"))
    );
    connection.close().await;
}
