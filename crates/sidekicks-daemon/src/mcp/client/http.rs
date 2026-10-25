//! The client's HTTP side for a tool server at an address: rmcp's streamable HTTP transport over
//! the daemon's own `StreamableHttpClient` on `reqwest`, which asks the connection's authorizer
//! for each request's headers, keeps each JSON reply and each SSE event in the raw copy before
//! rmcp reads it, and holds every SSE event to the transport's size bound.

use std::borrow::Cow;
use std::collections::HashMap;
use std::error::Error;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use bytes::Bytes;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use futures::{Stream, StreamExt as _, TryStreamExt as _};
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderName, HeaderValue, WWW_AUTHENTICATE};
use reqwest::{Method, StatusCode};
use rmcp::model::{ClientJsonRpcMessage, ClientRequest, ErrorData, ServerJsonRpcMessage};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::common::client_side_sse::BoxedSseResponse;
use rmcp::transport::common::http_header::{
    EVENT_STREAM_MIME_TYPE, HEADER_LAST_EVENT_ID, HEADER_SESSION_ID, JSON_MIME_TYPE,
};
use rmcp::transport::streamable_http_client::{
    AuthRequiredError, SseError, StreamableHttpClient, StreamableHttpClientTransportConfig,
    StreamableHttpError, StreamableHttpPostResponse,
};

use crate::mcp::client::connection::{McpConnectionError, McpConnectionScope, McpServerConnection};
use crate::mcp::client::raw_copy::RawReplyCopy;
use crate::provider::inbound_json::decode_inbound_json;

/// The idle connections kept per server: the standing event stream's and one request's.
const IDLE_CONNECTIONS_PER_HOST: usize = 2;

/// The bound rmcp's own HTTP client holds an SSE event to when the transport passes none.
const DEFAULT_MAX_SSE_EVENT_SIZE: usize = 16 * 1024 * 1024;

/// The headers that authorize one request, or why they could not be made.
type AuthorizationResult = Result<Vec<(HeaderName, HeaderValue)>, Box<dyn Error + Send + Sync>>;

/// What signs one request to a tool server: the headers it adds to a request of `method` to
/// `uri`, asked for each request so a proof bound to the request can be made.
pub(crate) trait McpRequestAuthorizer: Send + Sync {
    /// The headers authorizing the request. An error when they cannot be made, which fails the
    /// request.
    fn authorize(&self, method: &Method, uri: &str) -> BoxFuture<'_, AuthorizationResult>;
}

/// The authorizer of a server that takes requests without one: it adds no header.
#[expect(
    dead_code,
    reason = "the session's tool-server connections, which the tool-server units open, reach a \
              server that needs no sign-in with it"
)]
pub(crate) struct NoAuthorization;

impl McpRequestAuthorizer for NoAuthorization {
    fn authorize(&self, _method: &Method, _uri: &str) -> BoxFuture<'_, AuthorizationResult> {
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
}

/// The daemon's HTTP client for one tool server.
#[derive(Clone)]
pub(super) struct McpHttpClient {
    http: reqwest::Client,
    authorizer: Arc<dyn McpRequestAuthorizer>,
    raw: RawReplyCopy,
}

impl McpServerConnection {
    /// Opens a connection to the server at `uri`, sending `headers` with every request and the
    /// headers `authorizer` makes for each. Fails when the HTTP client cannot be built or the
    /// server does not complete its start.
    #[expect(
        dead_code,
        reason = "the session's tool-server connections, which the tool-server units open, \
                  connect to a server at an address through it"
    )]
    pub(crate) async fn connect_http(
        uri: &str,
        headers: HashMap<HeaderName, HeaderValue>,
        authorizer: Arc<dyn McpRequestAuthorizer>,
        scope: McpConnectionScope,
    ) -> Result<Self, McpConnectionError> {
        let http = reqwest::Client::builder()
            .pool_max_idle_per_host(IDLE_CONNECTIONS_PER_HOST)
            .build()
            .map_err(|error| McpConnectionError::Start(std::io::Error::other(error)))?;
        let raw = RawReplyCopy::default();
        let client = McpHttpClient {
            http,
            authorizer,
            raw: raw.clone(),
        };
        let mut config = StreamableHttpClientTransportConfig::with_uri(uri);
        config.custom_headers = headers;
        let transport = StreamableHttpClientTransport::with_client(client, config);
        Self::open(transport, raw, scope, None).await
    }
}

impl McpHttpClient {
    /// A request of `method` to `uri` with the transport's and the authorizer's headers.
    async fn request(
        &self,
        method: Method,
        uri: &str,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<reqwest::RequestBuilder, StreamableHttpError<McpHttpError>> {
        let authorized = self
            .authorizer
            .authorize(&method, uri)
            .await
            .map_err(|error| StreamableHttpError::Client(McpHttpError::Authorize(error)))?;
        let mut builder = self.http.request(method, uri);
        if let Some(token) = auth_header {
            builder = builder.bearer_auth(token);
        }
        for (name, value) in custom_headers.into_iter().chain(authorized) {
            builder = builder.header(name, value);
        }
        Ok(builder)
    }

    /// The SSE events of `response`, each held to `max_event_size` and kept in the raw copy.
    fn events(&self, response: reqwest::Response, max_event_size: usize) -> BoxedSseResponse {
        let raw = self.raw.clone();
        let bytes = BoundedEventBytes {
            inner: response.bytes_stream().boxed(),
            max_event_size,
            event_size: 0,
            line_size: 0,
        };
        sse_stream::SseStream::from_bytes_stream(bytes)
            .map(move |event| match event {
                Ok(event) => {
                    if let Some(data) = &event.data {
                        raw.keep_line(data.as_bytes());
                    }
                    Ok(rmcp_event(event))
                }
                Err(error) => Err(SseError::Body(Box::new(error))),
            })
            .boxed()
    }
}

/// An HTTP error for the transport.
fn http_error(error: reqwest::Error) -> StreamableHttpError<McpHttpError> {
    StreamableHttpError::Client(McpHttpError::Http(error))
}

/// The challenge of a 401 the server sent with one, which starts a sign-in.
fn auth_required(response: &reqwest::Response) -> Option<StreamableHttpError<McpHttpError>> {
    if response.status() != StatusCode::UNAUTHORIZED {
        return None;
    }
    let challenge = response.headers().get(WWW_AUTHENTICATE)?.to_str().ok()?;
    Some(StreamableHttpError::AuthRequired(AuthRequiredError::new(
        challenge.to_owned(),
    )))
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
        let mut builder = self
            .request(Method::POST, &uri, auth_header, custom_headers)
            .await?
            .header(
                ACCEPT,
                format!("{EVENT_STREAM_MIME_TYPE}, {JSON_MIME_TYPE}"),
            );
        let is_session_attached = session_id.is_some();
        if let Some(session_id) = session_id {
            builder = builder.header(HEADER_SESSION_ID, session_id.as_ref());
        }
        let response = builder.json(&message).send().await.map_err(http_error)?;
        if let Some(challenge) = auth_required(&response) {
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
            if let Some(error) = read_message(&body).filter(|reply| {
                matches!(reply, ServerJsonRpcMessage::Error(_))
                    && !matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
            }) {
                self.raw.keep_line(&body);
                return Ok(StreamableHttpPostResponse::Json(error, new_session_id));
            }
            return Err(StreamableHttpError::UnexpectedServerResponse(Cow::Owned(
                format!("HTTP {status}"),
            )));
        }
        match content_type.as_deref() {
            Some(kind) if kind.starts_with(EVENT_STREAM_MIME_TYPE) => {
                Ok(StreamableHttpPostResponse::Sse(
                    self.events(response, max_sse_event_size),
                    new_session_id,
                ))
            }
            Some(kind) if kind.starts_with(JSON_MIME_TYPE) => {
                let body = response.bytes().await.map_err(http_error)?;
                self.raw.keep_line(&body);
                match read_message(&body) {
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
            .request(Method::DELETE, &uri, auth_header, custom_headers)
            .await?
            .header(HEADER_SESSION_ID, session_id.as_ref())
            .send()
            .await
            .map_err(http_error)?;
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
        let mut builder = self
            .request(Method::GET, &uri, auth_header, custom_headers)
            .await?
            .header(
                ACCEPT,
                format!("{EVENT_STREAM_MIME_TYPE}, {JSON_MIME_TYPE}"),
            );
        if let Some(session_id) = session_id {
            builder = builder.header(HEADER_SESSION_ID, session_id.as_ref());
        }
        if let Some(last_event_id) = last_event_id {
            builder = builder.header(HEADER_LAST_EVENT_ID, last_event_id);
        }
        let response = builder.send().await.map_err(http_error)?;
        if response.status() == StatusCode::METHOD_NOT_ALLOWED {
            return Err(StreamableHttpError::ServerDoesNotSupportSse);
        }
        if let Some(challenge) = auth_required(&response) {
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
        Ok(self.events(response, max_sse_event_size))
    }
}

/// A server's JSON-RPC message, read from a body it sent.
fn read_message(body: &[u8]) -> Option<ServerJsonRpcMessage> {
    serde_json::from_str(&decode_inbound_json(body)).ok()
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
    let error = match read_message(body) {
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

/// Why an SSE stream was cut.
#[derive(Debug, thiserror::Error)]
enum SseBoundError {
    /// The body failed.
    #[error("the tool server's event stream failed")]
    Body(#[source] reqwest::Error),
    /// One event ran past the bound.
    #[error("a tool server event ran past {max_event_size} bytes")]
    EventTooLarge {
        /// The bound, in bytes.
        max_event_size: usize,
    },
}

/// A response body that fails once one event, the bytes up to a blank line, runs past its bound.
struct BoundedEventBytes {
    inner: BoxStream<'static, Result<Bytes, reqwest::Error>>,
    max_event_size: usize,
    event_size: usize,
    line_size: usize,
}

impl Stream for BoundedEventBytes {
    type Item = Result<Bytes, SseBoundError>;

    fn poll_next(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let Poll::Ready(chunk) = this.inner.try_poll_next_unpin(context) else {
            return Poll::Pending;
        };
        let Some(chunk) = chunk else {
            return Poll::Ready(None);
        };
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => return Poll::Ready(Some(Err(SseBoundError::Body(error)))),
        };
        for byte in &chunk {
            this.event_size += 1;
            match byte {
                b'\n' if this.line_size == 0 => this.event_size = 0,
                b'\n' => this.line_size = 0,
                b'\r' => {}
                _ => this.line_size += 1,
            }
            if this.event_size > this.max_event_size {
                return Poll::Ready(Some(Err(SseBoundError::EventTooLarge {
                    max_event_size: this.max_event_size,
                })));
            }
        }
        Poll::Ready(Some(Ok(chunk)))
    }
}
