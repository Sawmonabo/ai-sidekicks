//! The price list's stand-in server and a held list opened against it, which the list's tests and
//! the held requests' tests share.

use std::collections::{HashSet, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::get;
use reqwest::Url;
use sidekicks_platforms::WallClock;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::scheduler::Scheduler;
use sidekicks_std::scheduler::test_wall_clock::TestWallClock;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::bounded_poll::poll_until;
use crate::pricing::store::{HeldPriceList, PriceListConfig};

const SEED_COPY: &[u8] =
    br#"{"m1": {"input_cost_per_token": 3e-06}, "seed-only": {"input_cost_per_token": 2e-06}}"#;

// The built-in copy the tests' list starts from: `m1` and `seed-only`.
fn test_seed() -> Vec<u8> {
    SEED_COPY.to_vec()
}

// One answer the list's server gives, in the order the test scripts them.
struct ScriptedAnswer {
    status: StatusCode,
    etag: Option<&'static str>,
    body: &'static [u8],
}

/// The list's stand-in server: it answers from its script and records each request's
/// `If-None-Match`, whose count is the requests made.
#[derive(Default)]
pub(crate) struct ListServer {
    answers: Mutex<VecDeque<ScriptedAnswer>>,
    if_none_match: Mutex<Vec<Option<String>>>,
}

impl ListServer {
    /// Queues the answer to the next request not yet scripted.
    pub(crate) fn script(
        &self,
        status: StatusCode,
        etag: Option<&'static str>,
        body: &'static [u8],
    ) {
        lock(&self.answers).push_back(ScriptedAnswer { status, etag, body });
    }

    /// Each request's `If-None-Match`, in order.
    pub(crate) fn if_none_match(&self) -> Vec<Option<String>> {
        lock(&self.if_none_match).clone()
    }
}

async fn answer(State(server): State<Arc<ListServer>>, headers: HeaderMap) -> Response {
    let if_none_match = headers.get(header::IF_NONE_MATCH).map(|value| {
        value
            .to_str()
            .expect("the tag sent is visible ASCII")
            .to_owned()
    });
    lock(&server.if_none_match).push(if_none_match);
    let answer = lock(&server.answers)
        .pop_front()
        .expect("the test scripted an answer for each request");
    let mut response = (answer.status, answer.body).into_response();
    if let Some(etag) = answer.etag {
        response
            .headers_mut()
            .insert(header::ETAG, HeaderValue::from_static(etag));
    }
    response
}

/// Serves `server` on a loopback port and answers the list's address on it.
pub(crate) async fn serve(server: &Arc<ListServer>) -> Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("a loopback port binds");
    let address = listener.local_addr().expect("the bound address reads");
    let router = Router::new()
        .route("/list.json", get(answer))
        .with_state(Arc::clone(server));
    tokio::spawn(async move { axum::serve(listener, router).await });
    Url::parse(&format!("http://{address}/list.json")).expect("the address parses")
}

/// Opens the list in `folder` against `url`, with `m1` and `seed-only` in use, its scheduler and
/// the list on one test clock.
pub(crate) async fn open_held(
    folder: &Path,
    url: Url,
    clock: &Arc<TestWallClock>,
) -> Arc<HeldPriceList> {
    let wall_clock: Arc<dyn WallClock> = Arc::<TestWallClock>::clone(clock);
    let scheduler = Arc::new(Scheduler::start(
        Arc::clone(&wall_clock),
        None,
        watch::channel(0).1,
    ));
    let in_use = HashSet::from(["m1".to_owned(), "seed-only".to_owned()]);
    let config = PriceListConfig {
        folder: folder.to_path_buf(),
        url,
        seed: test_seed,
    };
    HeldPriceList::open(config, scheduler, wall_clock, in_use).await
}

/// A list opened in `folder` that took `copy` under `etag` from a stand-in server of its own, its
/// fetch task running until `stop`; answers the list and its server, which a test scripts further.
/// `copy` must decode with rows for `m1` and `seed-only`, the models in use, or the list keeps its
/// seed and the wait for the copy fails.
pub(crate) async fn started_list(
    folder: &Path,
    etag: &'static str,
    copy: &'static [u8],
    stop: &CancellationToken,
) -> (Arc<HeldPriceList>, Arc<ListServer>) {
    let server = Arc::new(ListServer::default());
    let clock = Arc::new(TestWallClock::default());
    let price_list = open_held(folder, serve(&server).await, &clock).await;
    let table_watch = price_list.subscribe();
    server.script(StatusCode::OK, Some(etag), copy);
    drop(price_list.start(stop.clone()));
    poll_until(
        || table_watch.has_changed().is_ok_and(|is_changed| is_changed),
        |is_changed| *is_changed,
    )
    .await;
    (price_list, server)
}
