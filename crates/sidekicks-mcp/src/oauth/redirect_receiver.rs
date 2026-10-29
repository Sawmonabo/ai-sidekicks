//! The one-time redirect receiver: a loopback listener bound for one sign-in attempt, which takes
//! the browser's return from the authorization server, checks it, hands the code or the error to
//! its owner and answers the browser as the owner says, then closes.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::{Query, RawQuery, Request, State};
use axum::http::header::{CACHE_CONTROL, HOST, LOCATION, REFERRER_POLICY};
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse as _, Response};
use axum::routing::get;
use futures::future::BoxFuture;
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use reqwest::Url;
use subtle::ConstantTimeEq as _;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tokio::task::JoinSet;
use tokio_util::sync::{CancellationToken, DropGuard};

/// Connections served at once; a browser opens a few, and the rest wait in the listen queue.
const MAX_CONNECTIONS: usize = 4;
/// How long a connection may take to send its request's headers before it is closed.
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// The most a connection buffers, so a callback carrying a developer's localhost cookies fits.
const MAX_BUFFER_BYTES: usize = 64 * 1024;
/// How long the browser's callback request is held while the owner redeems the code.
const BROWSER_HOLD: Duration = Duration::from_secs(30);
/// How long the listener stays up after its final answer, so the browser can fetch its page.
const LINGER: Duration = Duration::from_secs(5);
/// The wait after a failed accept, so a full descriptor table does not spin the loop.
const ACCEPT_RETRY_DELAY: Duration = Duration::from_secs(1);

const SHARED_CALLBACK_PATH: &str = "/callback";
const SIGNED_IN_PATH: &str = "/signed-in";
const SIGN_IN_FAILED_PATH: &str = "/sign-in-failed";

const SIGNED_IN_PAGE: &str = "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\">\
<title>Signed in</title></head>\n<body><p>Signed in. You can close this tab.</p></body>\n</html>\n";
const SIGN_IN_FAILED_PAGE: &str = "<!doctype html>\n<html lang=\"en\">\n<head><meta \
charset=\"utf-8\"><title>Sign-in did not finish</title></head>\n<body><p>Sign-in did not \
finish.</p></body>\n</html>\n";

/// Why a redirect receiver could not be bound.
#[derive(Debug, thiserror::Error)]
pub enum RedirectReceiverError {
    /// The owner's callback address is not plain `http`, which a loopback redirect needs.
    #[error("the callback address {callback_url} is not an http address")]
    NotHttp {
        /// The callback address as the owner issued it.
        callback_url: String,
    },
    /// The owner's callback address is not on this computer's loopback, so it is never bound.
    #[error("the callback address {callback_url} is not on this computer's loopback")]
    NotLoopback {
        /// The callback address as the owner issued it.
        callback_url: String,
    },
    /// The owner's callback path is one the receiver serves itself, or one its router cannot
    /// hold (a segment starting with `:` or `*`).
    #[error("the callback address {callback_url} has a path the receiver cannot serve")]
    UnusablePath {
        /// The callback address as the owner issued it.
        callback_url: String,
    },
    /// The operating system refused the listener.
    #[error("could not listen for the sign-in's callback")]
    Bind(#[source] io::Error),
}

/// Which path the browser returns to, from what the authorization server advertises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallbackPath<'a> {
    /// `/callback`, for a server that advertises `authorization_response_iss_parameter_supported`:
    /// the `iss` it returns tells its responses apart.
    Shared,
    /// `/callback/<id>`, the id derived from the MCP server's canonical address, so a response
    /// arriving at one server's path cannot be taken for another's.
    PerServer(&'a str),
}

impl CallbackPath<'_> {
    /// The path segment appended for a server-specific callback: the first 16 hex digits of a
    /// `blake3` hash over the server's canonical address, the same for every attempt.
    fn segment(self) -> Option<String> {
        match self {
            Self::Shared => None,
            Self::PerServer(server_address) => {
                let hash = blake3::hash(server_address.as_bytes());
                Some(hash.to_hex()[..16].to_owned())
            }
        }
    }
}

/// What the authorization server sent back through the browser.
pub enum AuthorizationResponse {
    /// The authorization code to redeem.
    Code(String),
    /// The server's refusal, with its `error` code and optional `error_description`.
    Error {
        /// The `error` code.
        error: String,
        /// The `error_description`, when the server sent one.
        description: Option<String>,
    },
}

/// One callback whose `Host` and `state` matched, handed to the owner.
pub struct RedirectCallback {
    /// The code or the error.
    pub response: AuthorizationResponse,
    /// The `iss` the server returned, for the owner's issuer check.
    pub issuer: Option<String>,
    /// The whole address the browser came back on, its query as sent, for an owner that hands
    /// the return on to the client that made the request.
    pub return_url: Url,
}

/// The page the receiver serves itself after an MCP sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultPage {
    /// `Signed in. You can close this tab.`
    SignedIn,
    /// `Sign-in did not finish.`
    NotFinished,
}

impl ResultPage {
    fn path(self) -> &'static str {
        match self {
            Self::SignedIn => SIGNED_IN_PATH,
            Self::NotFinished => SIGN_IN_FAILED_PATH,
        }
    }
}

/// The owner's answer to one callback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallbackAnswer {
    /// 400: this callback is refused and the receiver keeps waiting for the real one.
    Reject,
    /// 303 to an absolute address (the hosted sign-in's pages), and the receiver closes.
    Redirect(Url),
    /// 303 to the receiver's own result page, served once, and the receiver closes.
    Page(ResultPage),
}

/// The sign-in that owns a receiver and decides each callback's answer.
pub trait RedirectCallbackOwner: Send + Sync {
    /// Answers one callback, redeeming its code first where it carries one. The browser's request
    /// is held while this runs; past 30 s the future is dropped and the browser gets the
    /// `Sign-in did not finish.` page.
    fn answer(&self, callback: RedirectCallback) -> BoxFuture<'_, CallbackAnswer>;
}

/// A bound loopback listener, not yet serving: its address goes into the authorization request
/// before the request's `state` exists.
pub struct RedirectListener {
    listener: TcpListener,
    redirect_url: Url,
}

impl RedirectListener {
    /// Binds the listener. With no owner-issued `callback_url` it takes a free port on
    /// `127.0.0.1`, or on `[::1]` when IPv4 loopback is unusable; an owner-issued address sets the
    /// host, port and path, `localhost` binding `127.0.0.1`. Fails with `NotHttp` or `NotLoopback`
    /// for an owner address the receiver must not bind, `UnusablePath` for a path it cannot route, and
    /// `Bind` when the system refuses.
    pub async fn bind(
        callback_url: Option<&Url>,
        path: CallbackPath<'_>,
    ) -> Result<Self, RedirectReceiverError> {
        let (listener, mut redirect_url) = match callback_url {
            None => {
                let listener = bind_free_loopback_port()
                    .await
                    .map_err(RedirectReceiverError::Bind)?;
                let address = listener.local_addr().map_err(RedirectReceiverError::Bind)?;
                let redirect_url = Url::parse(&format!("http://{address}{SHARED_CALLBACK_PATH}"))
                    .expect("a loopback socket address and a fixed path form an http address");
                (listener, redirect_url)
            }
            Some(callback_url) => {
                let address = owner_issued_address(callback_url)?;
                if !is_routable_callback_path(callback_url.path()) {
                    return Err(RedirectReceiverError::UnusablePath {
                        callback_url: callback_url.to_string(),
                    });
                }
                let listener = TcpListener::bind(address)
                    .await
                    .map_err(RedirectReceiverError::Bind)?;
                (listener, callback_url.clone())
            }
        };
        if let Some(segment) = path.segment() {
            let base = redirect_url.path().trim_end_matches('/').to_owned();
            redirect_url.set_path(&format!("{base}/{segment}"));
        }
        Ok(Self {
            listener,
            redirect_url,
        })
    }

    /// The address the authorization request names as its `redirect_uri`, port included.
    pub fn redirect_url(&self) -> &Url {
        &self.redirect_url
    }

    /// Starts serving: each callback whose `Host` is this address and whose `state` equals
    /// `expected_state` goes to `owner`. Dropping the receiver before a final answer closes the
    /// listener at once; after one it closes itself once the result page has had its linger.
    pub fn receive(
        self,
        expected_state: String,
        owner: Arc<dyn RedirectCallbackOwner>,
    ) -> RedirectReceiver {
        let (answered, answered_watch) = watch::channel(false);
        let state = Arc::new(ReceiverState {
            authority: authority(&self.redirect_url),
            redirect_url: self.redirect_url.clone(),
            expected_state,
            owner,
            answered,
        });
        let router = Router::new()
            .route(self.redirect_url.path(), get(receive_callback))
            .route(SIGNED_IN_PATH, get(|| async { Html(SIGNED_IN_PAGE) }))
            .route(
                SIGN_IN_FAILED_PATH,
                get(|| async { Html(SIGN_IN_FAILED_PAGE) }),
            )
            .with_state(Arc::clone(&state))
            .layer(middleware::from_fn_with_state(state, check_host))
            .layer(middleware::map_response(mark_private));
        let stop = CancellationToken::new();
        tokio::spawn(serve(self.listener, router, stop.clone(), answered_watch));
        RedirectReceiver {
            _stop: stop.drop_guard(),
        }
    }
}

/// A serving receiver; dropping it before a final answer closes the listener and its connections.
pub struct RedirectReceiver {
    _stop: DropGuard,
}

/// What every request's handling reads.
struct ReceiverState {
    /// The `Host` a request must carry: the redirect address's host and port.
    authority: String,
    /// The redirect address, which a callback's query is read back onto.
    redirect_url: Url,
    expected_state: String,
    owner: Arc<dyn RedirectCallbackOwner>,
    /// Set once the owner gave its final answer (or the hold ran out).
    answered: watch::Sender<bool>,
}

async fn bind_free_loopback_port() -> io::Result<TcpListener> {
    match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await {
        Ok(listener) => Ok(listener),
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => Err(error),
        Err(error) => {
            tracing::debug!(
                error = &error as &(dyn std::error::Error + 'static),
                "IPv4 loopback refused the sign-in's callback listener; trying IPv6 loopback"
            );
            TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).await
        }
    }
}

/// The socket an owner-issued callback address binds: its loopback host, `localhost` as
/// `127.0.0.1`, on its port.
fn owner_issued_address(callback_url: &Url) -> Result<SocketAddr, RedirectReceiverError> {
    if callback_url.scheme() != "http" {
        return Err(RedirectReceiverError::NotHttp {
            callback_url: callback_url.to_string(),
        });
    }
    // `host_str` writes an IPv6 host in brackets and an IPv4 one already normalized.
    let host = callback_url
        .host_str()
        .map(|host| host.trim_start_matches('[').trim_end_matches(']'))
        .and_then(|host| {
            if host.eq_ignore_ascii_case("localhost") {
                Some(IpAddr::V4(Ipv4Addr::LOCALHOST))
            } else {
                host.parse::<IpAddr>().ok().filter(IpAddr::is_loopback)
            }
        });
    let (Some(host), Some(port)) = (host, callback_url.port_or_known_default()) else {
        return Err(RedirectReceiverError::NotLoopback {
            callback_url: callback_url.to_string(),
        });
    };
    Ok(SocketAddr::new(host, port))
}

/// Whether an owner-issued path can sit beside the result pages in the router, which refuses a
/// segment starting with `:` or `*` and a path registered twice.
fn is_routable_callback_path(path: &str) -> bool {
    path != SIGNED_IN_PATH
        && path != SIGN_IN_FAILED_PATH
        && !path
            .split('/')
            .any(|segment| segment.starts_with(':') || segment.starts_with('*'))
}

/// The `Host` header a browser sends for `redirect_url`: the host, and the port unless it is the
/// scheme's default.
fn authority(redirect_url: &Url) -> String {
    let host = redirect_url.host_str().expect("an http address has a host");
    match redirect_url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// Accepts connections, at most `MAX_CONNECTIONS` at once, until the receiver is dropped before a
/// final answer or the linger after one ends; then drops the listener.
async fn serve(
    listener: TcpListener,
    router: Router,
    stop: CancellationToken,
    mut answered: watch::Receiver<bool>,
) {
    let mut builder = http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .keep_alive(false)
        .header_read_timeout(HEADER_READ_TIMEOUT)
        .max_buf_size(MAX_BUFFER_BYTES);
    let capacity = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    let mut connections = JoinSet::new();
    // Once a final answer is in, the drop of the receiver no longer cuts the linger short.
    let ended = async {
        tokio::select! {
            is_answered = async { answered.wait_for(|is_answered| *is_answered).await.is_ok() } => {
                if is_answered {
                    tokio::time::sleep(LINGER).await;
                }
                is_answered
            }
            () = stop.cancelled() => false,
        }
    };
    tokio::pin!(ended);
    let is_answered = loop {
        let accepted = tokio::select! {
            is_answered = &mut ended => break is_answered,
            accepted = accept_within_capacity(&listener, &capacity) => accepted,
        };
        match accepted {
            Ok((stream, permit)) => {
                let connection = builder.serve_connection(
                    TokioIo::new(stream),
                    TowerToHyperService::new(router.clone()),
                );
                connections.spawn(async move {
                    if let Err(error) = connection.await {
                        tracing::debug!(
                            error = &error as &(dyn std::error::Error + 'static),
                            "a sign-in callback connection ended early"
                        );
                    }
                    drop(permit);
                });
            }
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "the sign-in's callback listener could not accept a connection"
                );
                tokio::time::sleep(ACCEPT_RETRY_DELAY).await;
            }
        }
        while let Some(joined) = connections.try_join_next() {
            if let Err(error) = joined {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a sign-in callback connection's task failed"
                );
            }
        }
    };
    drop(listener);
    if is_answered {
        // Let the answers already being written finish; each is bounded by the header timeout
        // and the browser hold.
        while connections.join_next().await.is_some() {}
    }
}

async fn accept_within_capacity(
    listener: &TcpListener,
    capacity: &Arc<Semaphore>,
) -> io::Result<(TcpStream, OwnedSemaphorePermit)> {
    let permit = Arc::clone(capacity)
        .acquire_owned()
        .await
        .expect("the connection semaphore is never closed");
    let (stream, _peer) = listener.accept().await?;
    Ok((stream, permit))
}

/// Refuses with 400 any request whose `Host` is not the redirect address, so a page on another
/// site cannot reach the listener through a rebound name.
async fn check_host(
    State(state): State<Arc<ReceiverState>>,
    request: Request,
    next: Next,
) -> Response {
    let is_bound_host = request.headers().get(HOST).is_some_and(|host| {
        host.as_bytes()
            .eq_ignore_ascii_case(state.authority.as_bytes())
    });
    if !is_bound_host {
        return StatusCode::BAD_REQUEST.into_response();
    }
    next.run(request).await
}

/// Keeps every answer out of caches and keeps the callback's address out of any `Referer`.
async fn mark_private(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    response
}

/// Checks one callback's query, hands a matching one to the owner and answers as the owner says.
async fn receive_callback(
    State(state): State<Arc<ReceiverState>>,
    Query(parameters): Query<Vec<(String, String)>>,
    RawQuery(query): RawQuery,
) -> Response {
    if *state.answered.borrow() {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut return_url = state.redirect_url.clone();
    return_url.set_query(query.as_deref());
    let Some(callback) = read_callback(&parameters, &state.expected_state, return_url) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let answer = match tokio::time::timeout(BROWSER_HOLD, state.owner.answer(callback)).await {
        Ok(answer) => answer,
        Err(elapsed) => {
            tracing::warn!(
                error = &elapsed as &(dyn std::error::Error + 'static),
                "the sign-in did not settle while the browser waited"
            );
            CallbackAnswer::Page(ResultPage::NotFinished)
        }
    };
    let location = match answer {
        CallbackAnswer::Reject => return StatusCode::BAD_REQUEST.into_response(),
        CallbackAnswer::Redirect(address) => HeaderValue::from_str(address.as_str())
            .expect("a serialized URL is ASCII with no control characters"),
        CallbackAnswer::Page(page) => HeaderValue::from_static(page.path()),
    };
    state.answered.send_replace(true);
    (StatusCode::SEE_OTHER, [(LOCATION, location)]).into_response()
}

/// Reads a callback's query, which came back on `return_url`: `state` must equal the expected one, compared in constant time, and
/// exactly one of `code` and `error` must be present; no parameter may repeat.
fn read_callback(
    parameters: &[(String, String)],
    expected_state: &str,
    return_url: Url,
) -> Option<RedirectCallback> {
    let mut code = None;
    let mut error = None;
    let mut description = None;
    let mut issuer = None;
    let mut state = None;
    for (name, value) in parameters {
        let slot = match name.as_str() {
            "code" => &mut code,
            "error" => &mut error,
            "error_description" => &mut description,
            "iss" => &mut issuer,
            "state" => &mut state,
            _ => continue,
        };
        if slot.replace(value.clone()).is_some() {
            return None;
        }
    }
    let state: String = state?;
    if !bool::from(state.as_bytes().ct_eq(expected_state.as_bytes())) {
        return None;
    }
    let response = match (code, error) {
        (Some(code), None) => AuthorizationResponse::Code(code),
        (None, Some(error)) => AuthorizationResponse::Error { error, description },
        (Some(_), Some(_)) | (None, None) => return None,
    };
    Some(RedirectCallback {
        response,
        issuer,
        return_url,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use futures::future::BoxFuture;
    use reqwest::Url;
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    use tokio::net::TcpStream;
    use tokio::time::timeout;

    use super::{
        AuthorizationResponse, CallbackAnswer, CallbackPath, RedirectCallback,
        RedirectCallbackOwner, RedirectListener, RedirectReceiver, ResultPage,
    };

    const STATE: &str = "state-1";

    /// An owner that records each callback's code and gives one scripted answer.
    struct ScriptedOwner {
        answer: CallbackAnswer,
        codes: Mutex<Vec<String>>,
    }

    impl RedirectCallbackOwner for ScriptedOwner {
        fn answer(&self, callback: RedirectCallback) -> BoxFuture<'_, CallbackAnswer> {
            let code = match callback.response {
                AuthorizationResponse::Code(code) => code,
                AuthorizationResponse::Error { error, .. } => error,
            };
            self.codes.lock().expect("the codes lock").push(code);
            let answer = self.answer.clone();
            Box::pin(async move { answer })
        }
    }

    impl ScriptedOwner {
        fn codes(&self) -> Vec<String> {
            self.codes.lock().expect("the codes lock").clone()
        }
    }

    /// A receiver on a free loopback port whose owner answers `answer`, with its redirect address.
    async fn start(answer: CallbackAnswer) -> (RedirectReceiver, Arc<ScriptedOwner>, Url) {
        let owner = Arc::new(ScriptedOwner {
            answer,
            codes: Mutex::new(Vec::new()),
        });
        let listener = RedirectListener::bind(None, CallbackPath::Shared)
            .await
            .expect("a loopback listener");
        let redirect_url = listener.redirect_url().clone();
        let owner_handle: Arc<dyn RedirectCallbackOwner> = Arc::<ScriptedOwner>::clone(&owner);
        let receiver = listener.receive(STATE.to_owned(), owner_handle);
        (receiver, owner, redirect_url)
    }

    fn socket(redirect_url: &Url) -> String {
        format!(
            "{}:{}",
            redirect_url.host_str().expect("a host"),
            redirect_url.port().expect("a port")
        )
    }

    /// Sends one raw HTTP/1.1 request and reads the whole answer, which ends with the connection.
    async fn send(redirect_url: &Url, request: &str) -> String {
        let mut stream = TcpStream::connect(socket(redirect_url))
            .await
            .expect("the listener accepts");
        stream
            .write_all(request.as_bytes())
            .await
            .expect("the request is written");
        let mut answer = Vec::new();
        timeout(Duration::from_secs(5), stream.read_to_end(&mut answer))
            .await
            .expect("the answer ends within 5 s")
            .expect("the answer is read");
        String::from_utf8_lossy(&answer).into_owned()
    }

    fn get(path_and_query: &str, host: &str, extra_headers: &str) -> String {
        format!("GET {path_and_query} HTTP/1.1\r\nHost: {host}\r\n{extra_headers}\r\n")
    }

    fn status(answer: &str) -> &str {
        answer.split(' ').nth(1).expect("a status line")
    }

    fn header<'a>(answer: &'a str, name: &str) -> Option<&'a str> {
        let head = answer.split("\r\n\r\n").next().expect("a head");
        head.lines().find_map(|line| {
            let (line_name, value) = line.split_once(':')?;
            line_name.eq_ignore_ascii_case(name).then(|| value.trim())
        })
    }

    #[tokio::test]
    async fn wrong_requests_are_refused_and_the_right_callback_still_reaches_the_owner() {
        let (_receiver, owner, redirect_url) =
            start(CallbackAnswer::Page(ResultPage::SignedIn)).await;
        let host = socket(&redirect_url);
        let callback = format!("/callback?code=c1&state={STATE}");
        let refused = [
            (get(&callback, "attacker.example", ""), "400"),
            (get("/other", &host, ""), "404"),
            (
                format!("POST {callback} HTTP/1.1\r\nHost: {host}\r\nContent-Length: 0\r\n\r\n"),
                "405",
            ),
            (get("/callback?code=c1&state=state-2", &host, ""), "400"),
        ];
        for (request, expected) in refused {
            let answer = send(&redirect_url, &request).await;
            assert_eq!(status(&answer), expected, "{request}");
            assert_eq!(
                header(&answer, "cache-control"),
                Some("no-store"),
                "{request}"
            );
            assert_eq!(
                header(&answer, "referrer-policy"),
                Some("no-referrer"),
                "{request}"
            );
        }
        assert!(
            owner.codes().is_empty(),
            "no refused request reached the owner"
        );

        let answer = send(&redirect_url, &get(&callback, &host, "")).await;
        assert_eq!(status(&answer), "303");
        assert_eq!(owner.codes(), ["c1"]);
    }

    #[tokio::test]
    async fn a_connection_that_sends_no_headers_is_closed_while_another_completes() {
        let (_receiver, owner, redirect_url) = start(CallbackAnswer::Reject).await;
        let mut idle = TcpStream::connect(socket(&redirect_url))
            .await
            .expect("the listener accepts");

        let host = socket(&redirect_url);
        let answer = send(
            &redirect_url,
            &get(&format!("/callback?code=c1&state={STATE}"), &host, ""),
        )
        .await;
        assert_eq!(status(&answer), "400", "the owner's refusal");
        assert_eq!(owner.codes(), ["c1"]);

        // Closed at the 10 s header timeout, well before hyper's 30 s default.
        let mut ignored = Vec::new();
        let closed = timeout(Duration::from_secs(15), idle.read_to_end(&mut ignored)).await;
        assert!(closed.is_ok(), "the idle connection is closed within 15 s");
    }

    #[tokio::test]
    async fn a_callback_carrying_twenty_kib_of_cookies_reaches_the_owner() {
        let (_receiver, owner, redirect_url) =
            start(CallbackAnswer::Page(ResultPage::SignedIn)).await;
        let host = socket(&redirect_url);
        let cookies = format!("Cookie: session={}\r\n", "c".repeat(20 * 1024));
        let answer = send(
            &redirect_url,
            &get(&format!("/callback?code=c1&state={STATE}"), &host, &cookies),
        )
        .await;
        assert_eq!(status(&answer), "303");
        assert_eq!(owner.codes(), ["c1"]);
    }

    #[tokio::test]
    async fn the_signed_in_page_is_served_after_a_redirect_that_drops_the_code() {
        let (_receiver, _owner, redirect_url) =
            start(CallbackAnswer::Page(ResultPage::SignedIn)).await;
        let host = socket(&redirect_url);
        let answer = send(
            &redirect_url,
            &get(&format!("/callback?code=c1&state={STATE}"), &host, ""),
        )
        .await;
        assert_eq!(status(&answer), "303");
        let location = header(&answer, "location").expect("a location");
        assert!(
            location.starts_with('/') && !location.contains('?'),
            "{location}"
        );

        let page = send(&redirect_url, &get(location, &host, "")).await;
        assert_eq!(status(&page), "200");
        assert!(page.contains("<title>Signed in</title>"), "{page}");
        assert!(
            page.contains("Signed in. You can close this tab."),
            "{page}"
        );
        assert!(!page.contains("<script"), "{page}");
    }
}
