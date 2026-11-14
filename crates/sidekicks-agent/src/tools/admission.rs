//! The check in front of the tool servers on the daemon's listener: a request is answered only
//! when the live spawn entry its path names admits its secret, which is checked on every request,
//! so a replaced or dropped spawn is refused at once. rmcp serves each `POST` on its own, keeping
//! no session; the route answers the standing `GET` stream and the closing `DELETE` itself, and
//! hands a client of the older handshake revision the session id that makes it open that stream,
//! the id carrying the client's listing mark, which its `GET` sends back. Each admitted `POST`
//! carries word of when its answer's event stream closes, which rmcp itself does not give a call.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse as _, Response};
use futures::StreamExt as _;
use rmcp::model::ProtocolVersion;
use rmcp::transport::common::http_header::{
    EVENT_STREAM_MIME_TYPE, HEADER_MCP_PROTOCOL_VERSION, HEADER_SESSION_ID,
};
use tokio_util::sync::CancellationToken;

use crate::tools::entries::ToolServerEntries;
use crate::tools::server::ToolServerPath;
use crate::tools::standing_stream::standing_stream;

/// What a request no live spawn admits is answered with, beside a 401 that carries no
/// `WWW-Authenticate`, so a provider reads a failed call and never starts a sign-in.
const NOT_ADMITTED: &str = "No live session admits this request here.";

/// Ends once the event stream an admitted request is answered on is dropped: its caller closed it,
/// or it was written whole.
#[derive(Clone)]
pub(super) struct AnswerStream(CancellationToken);

impl AnswerStream {
    /// Answers once the stream is gone.
    pub(super) async fn closed(&self) {
        self.0.cancelled().await;
    }
}

/// The entries every request is admitted against, and the daemon's stop, which ends every
/// standing stream.
pub(super) struct ToolServerAdmission {
    /// Every live spawn's entry.
    entries: Arc<ToolServerEntries>,
    /// The daemon's stop.
    stop: CancellationToken,
}

impl ToolServerAdmission {
    /// An admission over `entries`, whose standing streams end at `stop`.
    pub(super) fn new(entries: Arc<ToolServerEntries>, stop: CancellationToken) -> Self {
        Self { entries, stop }
    }
}

/// Answers `request` only when the live entry its path names admits its secret; a refusal is 401
/// with no `WWW-Authenticate`, and a path naming no tool server is 404. rmcp checks the `Host` and
/// `Origin` of every admitted request first; past them, a `GET` is answered with a standing stream
/// of the client the path and secret name, told of every change since the listing mark its
/// session id carries, a `DELETE` ends that client's streams alone, and a
/// `POST` is rmcp's to serve, carrying an [`AnswerStream`] that ends once its answer's event
/// stream is dropped.
pub(super) async fn admit(
    State(admission): State<Arc<ToolServerAdmission>>,
    mut request: Request,
    next: Next,
) -> Response {
    let Some(path) = ToolServerPath::parse(request.uri().path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let authorization = request
        .headers()
        .get(AUTHORIZATION)
        .map(HeaderValue::as_bytes);
    let Some(client) = admission.entries.admitted_client(&path, authorization) else {
        return refusal();
    };
    let method = request.method().clone();
    if method == Method::GET || method == Method::DELETE {
        let listing_mark = request.headers().get(HEADER_SESSION_ID).cloned();
        // rmcp serves only `POST` here: it answers 405 once the request's `Host` and `Origin`
        // pass, and refuses a request from a page or a foreign host before that.
        let checked = next.run(request).await;
        if checked.status() != StatusCode::METHOD_NOT_ALLOWED {
            return checked;
        }
        if method == Method::GET {
            let listing_mark = listing_mark.as_ref().map(HeaderValue::as_bytes);
            return standing_stream(client, listing_mark, admission.stop.clone());
        }
        client.close_standing_streams();
        return StatusCode::OK.into_response();
    }
    // A client of a revision with a handshake sends no session id only at that handshake, and a
    // client of a later revision names it on every request; rmcp compares the names the same way.
    let is_handshake = !request.headers().contains_key(HEADER_SESSION_ID)
        && request
            .headers()
            .get(HEADER_MCP_PROTOCOL_VERSION)
            .and_then(|version| version.to_str().ok())
            .is_none_or(|version| version < ProtocolVersion::NO_INITIALIZE.as_str());
    // Taken before the handshake is served, so the client's listing after it misses no change the
    // mark leaves out.
    let listing_mark = is_handshake.then(|| client.listing_mark());
    let answer_stream = CancellationToken::new();
    request
        .extensions_mut()
        .insert(AnswerStream(answer_stream.clone()));
    let mut response = guard_event_stream(next.run(request).await, answer_stream);
    if let Some(listing_mark) = listing_mark
        && response.status().is_success()
    {
        // The id carries no authority and no request is told from it, so the listing mark is the
        // id, which the client's standing `GET` sends back.
        let mcp_session =
            HeaderValue::try_from(listing_mark).expect("a listing mark is header text");
        response
            .headers_mut()
            .insert(HEADER_SESSION_ID, mcp_session);
    }
    response
}

// `response`, its body ending `answer_stream` once dropped where it is an event stream, which
// hyper drops as soon as it reads its connection closed.
fn guard_event_stream(response: Response, answer_stream: CancellationToken) -> Response {
    let is_event_stream = response
        .headers()
        .get(CONTENT_TYPE)
        .is_some_and(|content_type| content_type == EVENT_STREAM_MIME_TYPE);
    if !is_event_stream {
        return response;
    }
    response.map(|body| {
        let closed_with_body = answer_stream.drop_guard();
        Body::from_stream(body.into_data_stream().map(move |frame| {
            let _held = &closed_with_body;
            frame
        }))
    })
}

// The answer to a request no live entry admits.
fn refusal() -> Response {
    (StatusCode::UNAUTHORIZED, NOT_ADMITTED).into_response()
}

#[cfg(test)]
mod tests {
    use axum::http::StatusCode;
    use axum::http::header::{ORIGIN, WWW_AUTHENTICATE};

    use crate::tools::listener::tests::{
        CLAUDE_SESSION, CODEX_SESSION, add_spawn, initialize, mcp_session_of, serve_stub,
        standing_get,
    };

    const REVISION: &str = "2025-11-25";

    // Each way a request presents itself, one request per row: a live spawn's secret passes and
    // is handed a session id, no header, another scheme, a replaced spawn's secret and a dropped
    // spawn's secret are 401 with no `WWW-Authenticate`, and a live secret from a browser `Origin`
    // is rmcp's 403, on a handshake and on a standing stream alike. Killed by dropping
    // `enforce_origin_validation()` or answering a `GET` ahead of rmcp's check (the `Origin` rows
    // pass), by a secret checked against the conversation's first spawn, and by a 401 that names a
    // challenge.
    #[tokio::test]
    async fn each_way_a_request_presents_its_secret_is_admitted_or_refused() {
        let served = serve_stub().await;
        let (_replaced, path, replaced_secret) = add_spawn(&served.entries, CODEX_SESSION);
        let (_live, same_path, secret) = add_spawn(&served.entries, CODEX_SESSION);
        assert_eq!(path, same_path);
        let (dropped, dropped_path, dropped_secret) = add_spawn(&served.entries, CLAUDE_SESSION);
        drop(dropped);

        let admitted = initialize(&served, &path, REVISION)
            .bearer_auth(&secret)
            .send()
            .await
            .expect("an answer");
        assert_eq!(admitted.status(), StatusCode::OK);
        assert!(mcp_session_of(&admitted).is_some());

        let refused = [
            ("no header", initialize(&served, &path, REVISION)),
            (
                "another scheme",
                initialize(&served, &path, REVISION).basic_auth("sidekicks", Some(&secret)),
            ),
            (
                "a replaced spawn's secret",
                initialize(&served, &path, REVISION).bearer_auth(&replaced_secret),
            ),
            (
                "a dropped spawn's secret",
                initialize(&served, &dropped_path, REVISION).bearer_auth(&dropped_secret),
            ),
        ];
        for (row, request) in refused {
            let response = request.send().await.expect("an answer");
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{row}");
            assert!(!response.headers().contains_key(WWW_AUTHENTICATE), "{row}");
        }

        let from_a_page = [
            ("a handshake", initialize(&served, &path, REVISION)),
            ("a standing stream", standing_get(&served, &path, REVISION)),
        ];
        for (row, request) in from_a_page {
            let response = request
                .bearer_auth(&secret)
                .header(ORIGIN, "https://page.example")
                .send()
                .await
                .expect("an answer");
            assert_eq!(response.status(), StatusCode::FORBIDDEN, "{row}");
        }
    }
}
