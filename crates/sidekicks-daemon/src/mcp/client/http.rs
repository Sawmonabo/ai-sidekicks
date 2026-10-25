//! The client's HTTP side for a tool server at an address: rmcp's streamable HTTP transport over
//! the daemon's own `StreamableHttpClient` on `reqwest`, which asks the connection's authorizer
//! for each request's headers, repairs each JSON reply and each SSE event's data as text a
//! provider sends is and keeps it in the raw copy before rmcp reads it, and holds every SSE event
//! to the transport's size bound.
//!
//! - A server that wants a DPoP proof bound to its own nonce sends the nonce with any response; the
//!   last one is handed to the authorizer with each request, and a 401 asking for it
//!   (`error="use_dpop_nonce"`) is sent again once with the new nonce.
//! - rmcp ends a stream past the bound only on its own bound's error, which it keeps private, and
//!   reconnects on any other; so a stream cut past the bound is marked, and rmcp's resume of it
//!   is refused here rather than fetching the same event again, within a bounded retry.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use futures::{Stream, StreamExt as _, TryStreamExt as _};
use reqwest::header::{
    ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderName, HeaderValue, WWW_AUTHENTICATE,
};
use reqwest::{Method, StatusCode};
use rmcp::model::{ClientJsonRpcMessage, ClientRequest, ErrorData, ServerJsonRpcMessage};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::common::client_side_sse::{BoxedSseResponse, ExponentialBackoff};
use rmcp::transport::common::http_header::{
    EVENT_STREAM_MIME_TYPE, HEADER_LAST_EVENT_ID, HEADER_SESSION_ID, JSON_MIME_TYPE,
};
use rmcp::transport::streamable_http_client::{
    AuthRequiredError, InsufficientScopeError, SseError, StreamableHttpClient,
    StreamableHttpClientTransportConfig, StreamableHttpError, StreamableHttpPostResponse,
};

use crate::mcp::client::connection::{
    McpConnectionError, McpConnectionScope, McpConnectionStart, McpServerConnection,
};
use crate::mcp::client::raw_copy::RawReplyCopy;
use crate::mutex_lock::lock;
use crate::provider::inbound_json::decode_inbound_json;

/// The idle connections kept per server: the standing event stream's and one request's.
const IDLE_CONNECTIONS_PER_HOST: usize = 2;

/// The bound rmcp's own HTTP client holds an SSE event to when the transport passes none, rmcp's
/// `DEFAULT_MAX_SSE_EVENT_SIZE`, which it does not export.
const DEFAULT_MAX_SSE_EVENT_SIZE: usize = 16 * 1024 * 1024;

/// How often rmcp tries to reconnect a stream in a row before it gives the stream up.
const STREAM_RETRY_MAX_TIMES: usize = 3;

/// The first wait before a stream is reconnected, doubled at each try.
const STREAM_RETRY_BASE: Duration = Duration::from_secs(1);

/// The longest wait before a stream is reconnected.
const STREAM_RETRY_MAX_DELAY: Duration = Duration::from_secs(30);

/// The headers the transport sets itself, which a server's entry may not set, as rmcp's own client
/// refuses them.
const RESERVED_HEADERS: [&str; 3] = ["accept", HEADER_SESSION_ID, HEADER_LAST_EVENT_ID];

/// The response header carrying the nonce a server wants its next DPoP proof bound to.
const DPOP_NONCE: &str = "dpop-nonce";

/// A stream cut past the bound: its session and the last event id before the cut, which a resume
/// of it names.
type CutStream = (Option<String>, Option<String>);

/// The headers that authorize one request, or why they could not be made.
pub(crate) type AuthorizationResult =
    Result<Vec<(HeaderName, HeaderValue)>, Box<dyn Error + Send + Sync>>;

/// What signs one request to a tool server: the headers it adds to a request of `method` to
/// `uri`, asked for each request so a proof bound to the request, and to `dpop_nonce`, the last
/// nonce the server sent, can be made. An `Authorization` header it sets is the request's only one.
pub(crate) trait McpRequestAuthorizer: Send + Sync {
    /// The headers authorizing the request. An error when they cannot be made, which fails the
    /// request.
    fn authorize(
        &self,
        method: &Method,
        uri: &str,
        dpop_nonce: Option<&str>,
    ) -> BoxFuture<'_, AuthorizationResult>;
}

/// The authorizer of a server that takes requests without one: it adds no header.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the session's tool-server connections, which the tool-server units open, reach \
                  a server that needs no sign-in with it"
    )
)]
pub(crate) struct NoAuthorization;

impl McpRequestAuthorizer for NoAuthorization {
    fn authorize(
        &self,
        _method: &Method,
        _uri: &str,
        _dpop_nonce: Option<&str>,
    ) -> BoxFuture<'_, AuthorizationResult> {
        Box::pin(async { Ok(Vec::new()) })
    }
}

/// Why an HTTP request to a tool server failed below the transport.
#[derive(Debug, thiserror::Error)]
pub(crate) enum McpHttpError {
    /// The request failed on the network or was refused by status.
    #[error("the request to the tool server failed")]
    Http(#[from] reqwest::Error),
    /// The authorizer made no headers.
    #[error("the request to the tool server could not be authorized")]
    Authorize(#[source] Box<dyn Error + Send + Sync>),
    /// A resume asked for a stream cut past the size bound, which would send the same event.
    #[error("the tool server's event stream was cut for an event past {max_event_size} bytes")]
    StreamCut {
        /// The bound, in bytes.
        max_event_size: usize,
    },
}

/// The daemon's HTTP client for one tool server.
#[derive(Clone)]
pub(super) struct McpHttpClient {
    http: reqwest::Client,
    authorizer: Arc<dyn McpRequestAuthorizer>,
    raw: RawReplyCopy,
    /// The streams cut past the size bound, whose resumes are refused.
    cut_streams: Arc<Mutex<HashSet<CutStream>>>,
    /// The last DPoP nonce the server at the connection's one address sent.
    dpop_nonce: Arc<Mutex<Option<String>>>,
}

impl McpServerConnection {
    /// Opens a connection to the server at `uri`, sending `headers` with every request and the
    /// headers `authorizer` makes for each, its start held to `startup_timeout` or the 30 s
    /// default. Refused when `headers` names `Accept`, `Mcp-Session-Id` or `Last-Event-Id`, which
    /// the transport sets itself; fails when the HTTP client cannot be built or the server does not
    /// complete its start in time.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the session's tool-server connections, which the tool-server units open, \
                      connect to a server at an address through it"
        )
    )]
    pub(crate) async fn connect_http(
        uri: &str,
        headers: HashMap<HeaderName, HeaderValue>,
        authorizer: Arc<dyn McpRequestAuthorizer>,
        startup_timeout: Option<Duration>,
        scope: McpConnectionScope,
    ) -> Result<Self, McpConnectionError> {
        if let Some(name) = headers.keys().find(|name| {
            RESERVED_HEADERS
                .iter()
                .any(|reserved| name.as_str().eq_ignore_ascii_case(reserved))
        }) {
            return Err(McpConnectionError::ReservedHeader {
                name: name.as_str().to_owned(),
            });
        }
        let start = McpConnectionStart::http(startup_timeout);
        // No `timeout` or `read_timeout`: either would cut a quiet event stream; each request's
        // bound is rmcp's.
        let http = reqwest::Client::builder()
            .pool_max_idle_per_host(IDLE_CONNECTIONS_PER_HOST)
            .build()
            .map_err(McpConnectionError::HttpClient)?;
        let raw = RawReplyCopy::default();
        let client = McpHttpClient {
            http,
            authorizer,
            raw: raw.clone(),
            cut_streams: Arc::default(),
            dpop_nonce: Arc::default(),
        };
        let mut config = StreamableHttpClientTransportConfig::with_uri(uri);
        config.custom_headers = headers;
        let mut retry = ExponentialBackoff::default();
        retry.max_times = Some(STREAM_RETRY_MAX_TIMES);
        retry.base_duration = STREAM_RETRY_BASE;
        retry.max_delay = Some(STREAM_RETRY_MAX_DELAY);
        config.retry_config = Arc::new(retry);
        let transport = StreamableHttpClientTransport::with_client(client, config);
        Self::open(transport, raw, scope, start).await
    }
}

impl McpHttpClient {
    /// Sends a request of `method` to `uri` with the transport's and the authorizer's headers,
    /// `finish` adding its own; keeps the DPoP nonce the response carries, and sends the request
    /// once more when the server answers it with a 401 asking for that nonce. Fails as the
    /// authorizer or the network fails.
    async fn send(
        &self,
        method: Method,
        uri: &str,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        finish: impl Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
    ) -> Result<reqwest::Response, StreamableHttpError<McpHttpError>> {
        let mut is_resent = false;
        loop {
            let dpop_nonce = lock(&self.dpop_nonce).clone();
            let authorized = self
                .authorizer
                .authorize(&method, uri, dpop_nonce.as_deref())
                .await
                .map_err(|error| StreamableHttpError::Client(McpHttpError::Authorize(error)))?;
            let mut builder = self.http.request(method.clone(), uri);
            let is_authorized = authorized.iter().any(|(name, _)| *name == AUTHORIZATION);
            if let Some(token) = auth_header.clone().filter(|_| !is_authorized) {
                builder = builder.bearer_auth(token);
            }
            for (name, value) in custom_headers.clone().into_iter().chain(authorized) {
                builder = builder.header(name, value);
            }
            let response = finish(builder).send().await.map_err(http_error)?;
            if let Some(nonce) = response
                .headers()
                .get(DPOP_NONCE)
                .and_then(|nonce| nonce.to_str().ok())
            {
                *lock(&self.dpop_nonce) = Some(nonce.to_owned());
            }
            if is_resent || !asks_for_dpop_nonce(&response) {
                return Ok(response);
            }
            is_resent = true;
        }
    }

    /// The SSE events of `response` on `session_id`'s stream, each held to `max_event_size`, its
    /// data repaired and kept in the raw copy. A stream cut past the bound is marked, by its session
    /// and the last event id before the cut, so its resume is refused.
    fn events(
        &self,
        response: reqwest::Response,
        max_event_size: usize,
        session_id: Option<Arc<str>>,
        mut last_event_id: Option<String>,
    ) -> BoxedSseResponse {
        let raw = self.raw.clone();
        let cut_streams = Arc::clone(&self.cut_streams);
        let session_id = session_id.map(|session_id| session_id.as_ref().to_owned());
        let bytes = BoundedEventBytes {
            inner: response.bytes_stream().boxed(),
            limiter: SseEventSizeLimiter::new(max_event_size),
            is_cut: false,
        };
        sse_stream::SseStream::from_bytes_stream(bytes)
            .map(move |event| match event {
                Ok(mut event) => {
                    if let Some(data) = &mut event.data {
                        let repaired = decode_inbound_json(data.as_bytes()).into_owned();
                        raw.keep_text(&repaired);
                        *data = repaired;
                    }
                    if let Some(id) = &event.id {
                        last_event_id = Some(id.clone());
                    }
                    Ok(rmcp_event(event))
                }
                Err(error) => {
                    if is_cut_past_bound(&error) {
                        cut_streams
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .insert((session_id.clone(), last_event_id.clone()));
                    }
                    Err(SseError::Body(Box::new(error)))
                }
            })
            .boxed()
    }

    /// Whether `session_id`'s stream resumed after `last_event_id` was cut past the bound.
    fn is_cut(&self, session_id: Option<&Arc<str>>, last_event_id: Option<&String>) -> bool {
        let key = (
            session_id.map(|session_id| session_id.as_ref().to_owned()),
            last_event_id.cloned(),
        );
        self.cut_streams
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&key)
    }
}

/// Whether `error` is the bound's cut of an event past its size.
fn is_cut_past_bound(error: &sse_stream::Error) -> bool {
    let sse_stream::Error::Body(source) = error else {
        return false;
    };
    matches!(
        source.downcast_ref::<SseBodyError>(),
        Some(SseBodyError::TooLarge { .. })
    )
}

/// An HTTP error for the transport.
fn http_error(error: reqwest::Error) -> StreamableHttpError<McpHttpError> {
    StreamableHttpError::Client(McpHttpError::Http(error))
}

/// Whether `response` is a 401 asking for a DPoP proof bound to the server's nonce (RFC 9449 §8).
fn asks_for_dpop_nonce(response: &reqwest::Response) -> bool {
    response.status() == StatusCode::UNAUTHORIZED
        && response
            .headers()
            .get_all(WWW_AUTHENTICATE)
            .iter()
            .filter_map(|challenge| challenge.to_str().ok())
            .any(|challenge| challenge.contains("error=\"use_dpop_nonce\""))
}

/// The challenge of a 401 or 403 the server sent with one, as rmcp's own client reads it: a 401
/// starts a sign-in, a 403 asks for a wider scope.
fn auth_challenge(response: &reqwest::Response) -> Option<StreamableHttpError<McpHttpError>> {
    let status = response.status();
    if !matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return None;
    }
    let challenge = response.headers().get(WWW_AUTHENTICATE)?.to_str().ok()?;
    Some(if status == StatusCode::UNAUTHORIZED {
        StreamableHttpError::AuthRequired(AuthRequiredError::new(challenge.to_owned()))
    } else {
        StreamableHttpError::InsufficientScope(InsufficientScopeError::new(
            challenge.to_owned(),
            required_scope(challenge),
        ))
    })
}

/// The `scope` a challenge names, quoted or bare, as rmcp's own client reads it.
fn required_scope(challenge: &str) -> Option<String> {
    let start = challenge.to_ascii_lowercase().find("scope=")? + "scope=".len();
    let value = &challenge[start..];
    if let Some(quoted) = value.strip_prefix('"') {
        return quoted.find('"').map(|end| quoted[..end].to_owned());
    }
    let end = value
        .find(|character: char| character == ',' || character == ';' || character.is_whitespace())
        .unwrap_or(value.len());
    (end > 0).then(|| value[..end].to_owned())
}

impl StreamableHttpClient for McpHttpClient {
    type Error = McpHttpError;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session_id,
            auth_header,
            custom_headers,
            DEFAULT_MAX_SSE_EVENT_SIZE,
        )
        .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        let is_session_attached = session_id.is_some();
        let session_id_sent = session_id.clone();
        let response = self
            .send(Method::POST, &uri, auth_header, custom_headers, |builder| {
                let builder = builder
                    .header(
                        ACCEPT,
                        format!("{EVENT_STREAM_MIME_TYPE}, {JSON_MIME_TYPE}"),
                    )
                    .json(&message);
                match &session_id {
                    Some(session_id) => builder.header(HEADER_SESSION_ID, session_id.as_ref()),
                    None => builder,
                }
            })
            .await?;
        if let Some(challenge) = auth_challenge(&response) {
            return Err(challenge);
        }
        let status = response.status();
        if matches!(status, StatusCode::ACCEPTED | StatusCode::NO_CONTENT) {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        if status == StatusCode::NOT_FOUND && is_session_attached {
            return Err(StreamableHttpError::SessionExpired);
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned());
        let new_session_id = response
            .headers()
            .get(HEADER_SESSION_ID)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let is_reply_awaited = matches!(message, ClientJsonRpcMessage::Request(_));
        if !status.is_success() {
            let body = response.bytes().await.map_err(http_error)?;
            if let Some(rejection) =
                discover_rejection(&message, is_session_attached, status, &body)
            {
                return Ok(StreamableHttpPostResponse::Json(rejection, None));
            }
            let text = decode_inbound_json(&body);
            if let Some(error) = read_message(&text).filter(|reply| {
                matches!(reply, ServerJsonRpcMessage::Error(_))
                    && !matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
            }) {
                self.raw.keep_text(&text);
                return Ok(StreamableHttpPostResponse::Json(error, new_session_id));
            }
            return Err(StreamableHttpError::UnexpectedServerResponse(Cow::Owned(
                format!("HTTP {status}"),
            )));
        }
        match content_type.as_deref() {
            Some(kind) if kind.starts_with(EVENT_STREAM_MIME_TYPE) => {
                Ok(StreamableHttpPostResponse::Sse(
                    self.events(
                        response,
                        max_sse_event_size,
                        new_session_id
                            .as_deref()
                            .map(Arc::from)
                            .or_else(|| session_id_sent.clone()),
                        None,
                    ),
                    new_session_id,
                ))
            }
            Some(kind) if kind.starts_with(JSON_MIME_TYPE) => {
                let body = response.bytes().await.map_err(http_error)?;
                let text = decode_inbound_json(&body);
                self.raw.keep_text(&text);
                match read_message(&text) {
                    Some(reply) => Ok(StreamableHttpPostResponse::Json(reply, new_session_id)),
                    None if !is_reply_awaited => Ok(StreamableHttpPostResponse::Accepted),
                    None => Err(StreamableHttpError::UnexpectedServerResponse(
                        Cow::Borrowed("the tool server's reply is no JSON-RPC message"),
                    )),
                }
            }
            Some(_) | None if status.is_success() && !is_reply_awaited => {
                Ok(StreamableHttpPostResponse::Accepted)
            }
            Some(_) | None => Err(StreamableHttpError::UnexpectedContentType(content_type)),
        }
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        let response = self
            .send(
                Method::DELETE,
                &uri,
                auth_header,
                custom_headers,
                |builder| builder.header(HEADER_SESSION_ID, session_id.as_ref()),
            )
            .await?;
        if response.status() == StatusCode::METHOD_NOT_ALLOWED {
            return Ok(());
        }
        response.error_for_status().map_err(http_error)?;
        Ok(())
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<RmcpSse, SseError>>, StreamableHttpError<Self::Error>>
    {
        self.get_stream_with_max_sse_event_size(
            uri,
            session_id,
            last_event_id,
            auth_header,
            custom_headers,
            DEFAULT_MAX_SSE_EVENT_SIZE,
        )
        .await
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<BoxStream<'static, Result<RmcpSse, SseError>>, StreamableHttpError<Self::Error>>
    {
        if self.is_cut(session_id.as_ref(), last_event_id.as_ref()) {
            return Err(StreamableHttpError::Client(McpHttpError::StreamCut {
                max_event_size: max_sse_event_size,
            }));
        }
        let response = self
            .send(Method::GET, &uri, auth_header, custom_headers, |builder| {
                let mut builder = builder.header(
                    ACCEPT,
                    format!("{EVENT_STREAM_MIME_TYPE}, {JSON_MIME_TYPE}"),
                );
                if let Some(session_id) = &session_id {
                    builder = builder.header(HEADER_SESSION_ID, session_id.as_ref());
                }
                if let Some(last_event_id) = &last_event_id {
                    builder = builder.header(HEADER_LAST_EVENT_ID, last_event_id);
                }
                builder
            })
            .await?;
        if response.status() == StatusCode::METHOD_NOT_ALLOWED {
            return Err(StreamableHttpError::ServerDoesNotSupportSse);
        }
        if let Some(challenge) = auth_challenge(&response) {
            return Err(challenge);
        }
        let response = response.error_for_status().map_err(http_error)?;
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .map(|value| String::from_utf8_lossy(value.as_bytes()).into_owned());
        if !content_type
            .as_deref()
            .is_some_and(|kind| kind.starts_with(EVENT_STREAM_MIME_TYPE))
        {
            return Err(StreamableHttpError::UnexpectedContentType(content_type));
        }
        Ok(self.events(response, max_sse_event_size, session_id, last_event_id))
    }
}

/// A server's JSON-RPC message, read from the repaired text of a body it sent.
fn read_message(text: &str) -> Option<ServerJsonRpcMessage> {
    serde_json::from_str(text).ok()
}

/// The JSON-RPC error a 2025-11-25 server's HTTP refusal of `server/discover` stands for, so the
/// lifecycle falls back to `initialize`; `None` for any other request or refusal.
fn discover_rejection(
    message: &ClientJsonRpcMessage,
    is_session_attached: bool,
    status: StatusCode,
    body: &[u8],
) -> Option<ServerJsonRpcMessage> {
    let ClientJsonRpcMessage::Request(request) = message else {
        return None;
    };
    if is_session_attached
        || !status.is_client_error()
        || matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        || !matches!(request.request, ClientRequest::DiscoverRequest(_))
    {
        return None;
    }
    let error = match read_message(&decode_inbound_json(body)) {
        Some(ServerJsonRpcMessage::Error(error)) => error.error,
        Some(_) | None => {
            ErrorData::invalid_request(format!("server/discover refused with HTTP {status}"), None)
        }
    };
    Some(ServerJsonRpcMessage::error(error, Some(request.id.clone())))
}

/// The SSE event type rmcp's transport reads, which rmcp does not re-export; named through the
/// item of its public event stream.
pub(super) type RmcpSse = <<BoxedSseResponse as Stream>::Item as SseItem>::Event;

/// The event of one SSE stream item.
pub(super) trait SseItem {
    type Event;
}

impl<Event, ItemError> SseItem for Result<Event, ItemError> {
    type Event = Event;
}

/// One parsed SSE event in rmcp's event type.
fn rmcp_event(event: sse_stream::Sse) -> RmcpSse {
    RmcpSse {
        event: event.event,
        data: event.data,
        id: event.id,
        retry: event.retry,
    }
}

/// Why a bounded SSE body ended.
#[derive(Debug, thiserror::Error)]
enum SseBodyError {
    /// The body failed.
    #[error("the tool server's event stream failed")]
    Body(#[source] reqwest::Error),
    /// One event ran past the bound.
    #[error("a tool server event ran past {max_event_size} bytes")]
    TooLarge {
        /// The bound, in bytes.
        max_event_size: usize,
    },
}

/// What one event holds as the SSE parser keeps it, counted as rmcp's own bound counts it: a line
/// ends at a line feed, a carriage return or both, a comment line is not kept, a blank line ends
/// the event, and each kept line adds the newline the parser joins data lines with.
struct SseEventSizeLimiter {
    max_size: usize,
    retained_size: usize,
    line_size: usize,
    is_comment_line: bool,
    was_carriage_return: bool,
}

impl SseEventSizeLimiter {
    fn new(max_size: usize) -> Self {
        Self {
            max_size,
            retained_size: 0,
            line_size: 0,
            is_comment_line: false,
            was_carriage_return: false,
        }
    }

    /// Counts `chunk`; false once the event it ends in runs past the bound.
    fn observe(&mut self, chunk: &[u8]) -> bool {
        for &byte in chunk {
            if self.was_carriage_return {
                self.was_carriage_return = false;
                if byte == b'\n' {
                    continue;
                }
            }
            match byte {
                b'\r' => {
                    self.was_carriage_return = true;
                    self.finish_line();
                }
                b'\n' => self.finish_line(),
                _ => {
                    if self.line_size == 0 {
                        self.is_comment_line = byte == b':';
                    }
                    self.line_size = self.line_size.saturating_add(1);
                }
            }
            if self.retained_size.saturating_add(self.line_size) > self.max_size {
                return false;
            }
        }
        true
    }

    fn finish_line(&mut self) {
        if self.line_size == 0 {
            self.retained_size = 0;
        } else if !self.is_comment_line {
            self.retained_size = self
                .retained_size
                .saturating_add(self.line_size)
                .saturating_add(1);
        }
        self.line_size = 0;
        self.is_comment_line = false;
    }
}

/// A response body that fails once one event runs past its bound, and ends after that.
struct BoundedEventBytes {
    inner: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    limiter: SseEventSizeLimiter,
    is_cut: bool,
}

impl Stream for BoundedEventBytes {
    type Item = Result<Bytes, SseBodyError>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        if this.is_cut {
            return Poll::Ready(None);
        }
        let Poll::Ready(chunk) = this.inner.try_poll_next_unpin(context) else {
            return Poll::Pending;
        };
        let Some(chunk) = chunk else {
            return Poll::Ready(None);
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                this.is_cut = true;
                return Poll::Ready(Some(Err(SseBodyError::Body(error))));
            }
        };
        if !this.limiter.observe(&chunk) {
            this.is_cut = true;
            return Poll::Ready(Some(Err(SseBodyError::TooLarge {
                max_event_size: this.limiter.max_size,
            })));
        }
        Poll::Ready(Some(Ok(chunk)))
    }
}

#[cfg(test)]
mod tests;
