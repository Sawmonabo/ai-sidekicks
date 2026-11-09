//! A receiver on a loopback port for the web address's tests: it answers each request as the test
//! says and keeps what it received.

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::http::header::LOCATION;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse as _, Response};
use tokio::sync::Notify;

/// One request the double received.
#[derive(Clone, Debug)]
pub(crate) struct Received {
    /// The request's path and query.
    pub(crate) path_and_query: String,
    /// Its headers.
    pub(crate) headers: HeaderMap,
    /// Its body.
    pub(crate) body: Bytes,
}

/// How the double answers one request.
#[derive(Clone, Debug)]
pub(crate) enum Answer {
    /// This status with no body.
    Status(StatusCode),
    /// A `302` to another path on the double.
    Redirect,
    /// No answer, ever.
    Hang,
    /// This status once the test releases it with `notify_one`.
    Released(Arc<Notify>, StatusCode),
}

/// What the double received, in order, and the signal raised as each request is recorded.
#[derive(Debug, Default)]
pub(crate) struct ReceivedRequests {
    /// The requests, in order.
    pub(crate) requests: Mutex<Vec<Received>>,
    /// Raised to every waiter once each request is recorded.
    pub(crate) arrived: Notify,
}

/// A double answering every request with `status`, its port and what it receives.
pub(crate) async fn serve(status: StatusCode) -> (u16, Arc<ReceivedRequests>) {
    serve_answers(vec![Answer::Status(status)]).await
}

/// A double answering its requests with `answers` in turn, the last one for every request past
/// them, its port and what it receives.
pub(crate) async fn serve_answers(answers: Vec<Answer>) -> (u16, Arc<ReceivedRequests>) {
    let received = Arc::new(ReceivedRequests::default());
    let kept = Arc::clone(&received);
    let router = Router::new().fallback(move |uri: Uri, headers: HeaderMap, body: Bytes| {
        let kept = Arc::clone(&kept);
        let answers = answers.clone();
        async move {
            let answer = {
                let mut requests = kept.requests.lock().expect("the double's record");
                requests.push(Received {
                    path_and_query: uri
                        .path_and_query()
                        .map(ToString::to_string)
                        .unwrap_or_default(),
                    headers,
                    body,
                });
                answers
                    .get(requests.len() - 1)
                    .or_else(|| answers.last())
                    .cloned()
                    .expect("the test gives an answer")
            };
            kept.arrived.notify_waiters();
            answer_with(answer).await
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local port");
    let port = listener.local_addr().expect("the port's address").port();
    tokio::spawn(async move { axum::serve(listener, router).await });
    (port, received)
}

/// A loopback port nothing listens on.
pub(crate) async fn closed_port() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a local port");
    listener.local_addr().expect("the port's address").port()
}

async fn answer_with(answer: Answer) -> Response {
    match answer {
        Answer::Status(status) => status.into_response(),
        Answer::Redirect => (StatusCode::FOUND, [(LOCATION, "/elsewhere")]).into_response(),
        Answer::Hang => std::future::pending().await,
        Answer::Released(release, status) => {
            release.notified().await;
            status.into_response()
        }
    }
}
