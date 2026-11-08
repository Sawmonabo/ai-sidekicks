//! The receiver of the providers' OTLP/HTTP telemetry and its hand-off to each provider's reader:
//! each export is admitted by the live token of one provider process or launch and its headers
//! before its body is read, read within a cap and a bound on bodies read at once, decoded, kept
//! whole as OTLP JSON while raw messages are recorded, and handed to the reader of the provider its
//! path names with the holder its token was minted for. Also the target a provider's exporter is
//! set to.

pub mod bearers;

use std::collections::HashMap;
use std::error::Error;
use std::sync::Arc;

use axum::Router;
use axum::extract::rejection::PathRejection;
use axum::extract::{DefaultBodyLimit, FromRequest as _, Path, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse as _, Response};
use axum::routing::post;
use bytes::Bytes;
use futures::future::BoxFuture;
use opentelemetry_proto::tonic::collector::logs::v1::{
    ExportLogsServiceRequest, ExportLogsServiceResponse,
};
use opentelemetry_proto::tonic::collector::trace::v1::{
    ExportTraceServiceRequest, ExportTraceServiceResponse,
};
use prost::Message as _;
use sidekicks_contracts::provider::id::ProviderId;
use tokio::sync::Semaphore;

use crate::port::raw_provider_messages::RawProviderMessages;
use crate::pricing::receiver::bearers::{TelemetryBearers, TelemetryHolderId};

/// What every provider's telemetry path starts with.
const TELEMETRY_PATH_PREFIX: &str = "/telemetry";

/// What a provider's base path takes for its log exports.
pub const LOGS_PATH_SUFFIX: &str = "/v1/logs";

/// What a provider's base path takes for its trace exports.
pub const TRACES_PATH_SUFFIX: &str = "/v1/traces";

/// The most bytes one export's body may hold; a longer one is answered 413.
const EXPORT_BODY_LIMIT: usize = 4 * 1024 * 1024;

/// How many export bodies are read at once across every provider; a further export waits for a
/// permit before its body is read.
const BODIES_READ_AT_ONCE: usize = 4;

/// The media type OTLP/HTTP's binary encoding is sent and answered in.
const PROTOBUF_CONTENT_TYPE: &str = "application/x-protobuf";

/// The one `Content-Encoding` read as no encoding.
const IDENTITY_ENCODING: &[u8] = b"identity";

/// The path `provider`'s exports go under, `/telemetry/<provider id>`, which an exporter extends
/// with [`LOGS_PATH_SUFFIX`] or [`TRACES_PATH_SUFFIX`].
pub fn telemetry_base_path(provider: &ProviderId) -> String {
    format!("{TELEMETRY_PATH_PREFIX}/{}", provider.as_str())
}

/// Where every provider process exports its telemetry: the receiver on the loopback listener's
/// port, and the registry each process or launch mints the token its exports present from.
pub struct TelemetryTarget {
    port: u16,
    bearers: Arc<TelemetryBearers>,
}

impl TelemetryTarget {
    /// The receiver on `port` of `127.0.0.1`, admitting exports that present a live bearer of
    /// `bearers`.
    pub fn new(port: u16, bearers: Arc<TelemetryBearers>) -> Self {
        Self { port, bearers }
    }

    /// The registry a driver mints each process's or launch's bearer from.
    pub fn bearers(&self) -> &Arc<TelemetryBearers> {
        &self.bearers
    }

    /// The address `provider`'s exporter is set to, `http://127.0.0.1:<port>/telemetry/<id>`,
    /// which it extends with [`LOGS_PATH_SUFFIX`] or [`TRACES_PATH_SUFFIX`].
    pub fn base_endpoint(&self, provider: &ProviderId) -> String {
        format!(
            "http://127.0.0.1:{}{}",
            self.port,
            telemetry_base_path(provider)
        )
    }
}

/// One decoded export, as the receiver hands it to its provider's reader.
#[derive(Debug)]
pub enum TelemetryExport {
    /// A log export, from `…/v1/logs`.
    Logs(ExportLogsServiceRequest),
    /// A trace export, from `…/v1/traces`.
    Traces(ExportTraceServiceRequest),
}

impl TelemetryExport {
    fn to_json(&self) -> serde_json::Result<String> {
        match self {
            Self::Logs(request) => serde_json::to_string(request),
            Self::Traces(request) => serde_json::to_string(request),
        }
    }
}

/// A provider's reader of its telemetry, registered with the receiver under the provider's id.
pub trait TelemetryExportReader: Send + Sync {
    /// Takes `export`, presented under the token minted for `holder`; answers once the reader has
    /// taken it, and the receiver answers the exporter after that.
    fn read_telemetry_export(
        &self,
        holder: TelemetryHolderId,
        export: TelemetryExport,
    ) -> BoxFuture<'_, ()>;
}

/// The two kinds of export a path names.
#[derive(Clone, Copy)]
enum TelemetrySignal {
    Logs,
    Traces,
}

impl TelemetrySignal {
    fn name(self) -> &'static str {
        match self {
            Self::Logs => "logs",
            Self::Traces => "traces",
        }
    }

    fn decode(self, body: Bytes) -> Result<TelemetryExport, prost::DecodeError> {
        match self {
            Self::Logs => ExportLogsServiceRequest::decode(body).map(TelemetryExport::Logs),
            Self::Traces => ExportTraceServiceRequest::decode(body).map(TelemetryExport::Traces),
        }
    }

    fn success_body(self) -> Vec<u8> {
        match self {
            Self::Logs => ExportLogsServiceResponse::default().encode_to_vec(),
            Self::Traces => ExportTraceServiceResponse::default().encode_to_vec(),
        }
    }
}

/// `google.rpc.Status` as OTLP/HTTP answers a failure in, carrying its code and its
/// developer-facing message; the receiver sends no `details`, which the protocol lets it omit.
#[derive(prost::Message)]
struct RpcStatus {
    /// The `google.rpc.Code` the refusal's HTTP status pairs with.
    #[prost(int32, tag = "1")]
    code: i32,
    /// What failed, for the exporter's developer.
    #[prost(string, tag = "2")]
    message: String,
}

/// The receiver of every provider's telemetry exports.
pub struct TelemetryReceiver {
    bearers: Arc<TelemetryBearers>,
    readers: HashMap<ProviderId, Arc<dyn TelemetryExportReader>>,
    raw_messages: Arc<dyn RawProviderMessages>,
    body_read_permits: Semaphore,
}

impl TelemetryReceiver {
    /// A receiver admitting exports that present a live bearer of `bearers` minted for the
    /// provider their path names, for the providers `readers` names.
    pub fn new(
        bearers: Arc<TelemetryBearers>,
        readers: HashMap<ProviderId, Arc<dyn TelemetryExportReader>>,
        raw_messages: Arc<dyn RawProviderMessages>,
    ) -> Self {
        Self {
            bearers,
            readers,
            raw_messages,
            body_read_permits: Semaphore::new(BODIES_READ_AT_ONCE),
        }
    }

    /// The receiver's routes, `POST /telemetry/{provider}/v1/logs` and `…/v1/traces`, each other
    /// method answered 405. It sets no fallback, so a router it is merged into answers every other
    /// path.
    pub fn into_router(self) -> Router {
        let route = |suffix: &str| format!("{TELEMETRY_PATH_PREFIX}/{{provider}}{suffix}");
        Router::new()
            .route(
                &route(LOGS_PATH_SUFFIX),
                post(
                    |State(receiver): State<Arc<Self>>,
                     provider: Result<Path<String>, PathRejection>,
                     request: Request| {
                        receive(receiver, provider, TelemetrySignal::Logs, request)
                    },
                )
                .fallback(refuse_method),
            )
            .route(
                &route(TRACES_PATH_SUFFIX),
                post(
                    |State(receiver): State<Arc<Self>>,
                     provider: Result<Path<String>, PathRejection>,
                     request: Request| {
                        receive(receiver, provider, TelemetrySignal::Traces, request)
                    },
                )
                .fallback(refuse_method),
            )
            .layer(DefaultBodyLimit::max(EXPORT_BODY_LIMIT))
            .with_state(Arc::new(self))
    }
}

// Admits one export by its provider, its token's live holder and its headers before its body is
// read, then reads, decodes, records and hands it over under that holder, holding a body permit
// until its reader has taken it.
async fn receive(
    receiver: Arc<TelemetryReceiver>,
    provider: Result<Path<String>, PathRejection>,
    signal: TelemetrySignal,
    request: Request,
) -> Response {
    let Some((provider, reader)) = provider
        .ok()
        .and_then(|Path(provider)| ProviderId::new(provider))
        .and_then(|provider| {
            let reader = receiver.readers.get(&provider)?;
            Some((provider, reader))
        })
    else {
        return refusal(
            StatusCode::NOT_FOUND,
            "No provider here takes telemetry at this path.",
        );
    };
    let Some(holder) = receiver.bearers.resolve(
        &provider,
        request
            .headers()
            .get(header::AUTHORIZATION)
            .map(HeaderValue::as_bytes),
    ) else {
        return refusal(
            StatusCode::UNAUTHORIZED,
            "The telemetry token is missing, wrong or no longer live.",
        );
    };
    if let Some(refused) = refuse_headers(request.headers()) {
        return refused;
    }
    let permit = receiver
        .body_read_permits
        .acquire()
        .await
        .expect("the receiver never closes its body permits");
    let body = match Bytes::from_request(request, &()).await {
        Ok(body) => body,
        Err(rejection) => return refusal(rejection.status(), &rejection.body_text()),
    };
    let export = match signal.decode(body) {
        Ok(export) => export,
        Err(error) => {
            tracing::warn!(
                provider = provider.as_str(),
                signal = signal.name(),
                error = &error as &(dyn Error + 'static),
                "a provider's telemetry export did not decode"
            );
            return refusal(StatusCode::BAD_REQUEST, "The body is not an OTLP export.");
        }
    };
    if receiver.raw_messages.is_recording() {
        match export.to_json() {
            Ok(json) => receiver.raw_messages.record(provider, json).await,
            Err(error) => tracing::warn!(
                provider = provider.as_str(),
                signal = signal.name(),
                error = &error as &(dyn Error + 'static),
                "a provider's telemetry export could not be written as JSON"
            ),
        }
    }
    reader.read_telemetry_export(holder, export).await;
    drop(permit);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, PROTOBUF_CONTENT_TYPE)],
        signal.success_body(),
    )
        .into_response()
}

// The refusal an admitted export's headers earn, checked in order: a protobuf `Content-Type`,
// then no `Content-Encoding` but `identity`.
fn refuse_headers(headers: &HeaderMap) -> Option<Response> {
    let is_protobuf = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let essence = value.split_once(';').map_or(value, |(essence, _)| essence);
            essence.trim().eq_ignore_ascii_case(PROTOBUF_CONTENT_TYPE)
        });
    if !is_protobuf {
        return Some(refusal(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Telemetry is taken only as application/x-protobuf.",
        ));
    }
    let is_unencoded = headers
        .get_all(header::CONTENT_ENCODING)
        .iter()
        .all(|value| value.as_bytes().eq_ignore_ascii_case(IDENTITY_ENCODING));
    if !is_unencoded {
        return Some(refusal(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Telemetry is taken only without a content encoding.",
        ));
    }
    None
}

async fn refuse_method() -> Response {
    refusal(
        StatusCode::METHOD_NOT_ALLOWED,
        "Telemetry is taken only by POST.",
    )
}

// Every refusal the receiver answers itself: `status` with a protobuf `Status` body carrying the
// code the status pairs with.
fn refusal(status: StatusCode, message: &str) -> Response {
    let body = RpcStatus {
        code: rpc_code(status),
        message: message.to_owned(),
    }
    .encode_to_vec();
    (
        status,
        [(header::CONTENT_TYPE, PROTOBUF_CONTENT_TYPE)],
        body,
    )
        .into_response()
}

// The `google.rpc.Code` a refusal's HTTP status pairs with: a bad request or media type is an
// invalid argument, and a status the receiver never names itself, which only a body read's
// rejection can bring, is unknown.
fn rpc_code(status: StatusCode) -> i32 {
    const UNKNOWN: i32 = 2;
    const INVALID_ARGUMENT: i32 = 3;
    const NOT_FOUND: i32 = 5;
    const RESOURCE_EXHAUSTED: i32 = 8;
    const UNIMPLEMENTED: i32 = 12;
    const UNAUTHENTICATED: i32 = 16;
    match status {
        StatusCode::BAD_REQUEST | StatusCode::UNSUPPORTED_MEDIA_TYPE => INVALID_ARGUMENT,
        StatusCode::UNAUTHORIZED => UNAUTHENTICATED,
        StatusCode::NOT_FOUND => NOT_FOUND,
        StatusCode::METHOD_NOT_ALLOWED => UNIMPLEMENTED,
        StatusCode::PAYLOAD_TOO_LARGE => RESOURCE_EXHAUSTED,
        _ => UNKNOWN,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use axum::body::Body;
    use axum::extract::{Path, Request};
    use axum::http::{Method, StatusCode, header};
    use bytes::Bytes;
    use futures::StreamExt as _;
    use futures::future::BoxFuture;
    use opentelemetry_proto::tonic::collector::logs::v1::ExportLogsServiceRequest;
    use opentelemetry_proto::tonic::logs::v1::{LogRecord, ResourceLogs, ScopeLogs};
    use prost::Message as _;
    use rstest::rstest;
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_std::mutex_lock::lock;

    use super::{
        EXPORT_BODY_LIMIT, RpcStatus, TelemetryExport, TelemetryExportReader, TelemetryReceiver,
        TelemetrySignal, receive,
    };
    use crate::port::raw_provider_messages::RawProviderMessages;
    use crate::pricing::receiver::bearers::{TelemetryBearer, TelemetryBearers, TelemetryHolderId};

    // A reader that keeps each export it takes, with the holder it was presented under.
    #[derive(Default)]
    struct KeptExports(Mutex<Vec<(TelemetryHolderId, TelemetryExport)>>);

    impl TelemetryExportReader for KeptExports {
        fn read_telemetry_export(
            &self,
            holder: TelemetryHolderId,
            export: TelemetryExport,
        ) -> BoxFuture<'_, ()> {
            lock(&self.0).push((holder, export));
            Box::pin(std::future::ready(()))
        }
    }

    // A raw-messages port whose switch a test sets, keeping each message it records.
    #[derive(Default)]
    struct KeptRawMessages {
        is_recording: AtomicBool,
        messages: Mutex<Vec<(ProviderId, String)>>,
    }

    impl RawProviderMessages for KeptRawMessages {
        fn is_recording(&self) -> bool {
            self.is_recording.load(Ordering::SeqCst)
        }

        fn record(&self, provider: ProviderId, message: String) -> BoxFuture<'_, ()> {
            lock(&self.messages).push((provider, message));
            Box::pin(std::future::ready(()))
        }
    }

    // A receiver for `codex` alone, with the fakes it hands to, its registry, and one live codex
    // bearer with its token.
    struct Fixture {
        receiver: TelemetryReceiver,
        exports: Arc<KeptExports>,
        raw_messages: Arc<KeptRawMessages>,
        bearers: Arc<TelemetryBearers>,
        bearer: TelemetryBearer,
        token: String,
    }

    fn codex() -> ProviderId {
        ProviderId::new("codex".to_owned()).expect("a provider id")
    }

    // The token a bearer's exporters present, read back from its headers setting.
    fn token_of(bearer: &TelemetryBearer) -> String {
        bearer
            .exporter_headers()
            .strip_prefix("authorization=Bearer ")
            .expect("the setting presents a bearer")
            .to_owned()
    }

    fn fixture() -> Fixture {
        let bearers = Arc::new(TelemetryBearers::default());
        let bearer = bearers
            .mint(codex(), TelemetryHolderId::new(1))
            .expect("a token mints");
        let exports = Arc::new(KeptExports::default());
        let raw_messages = Arc::new(KeptRawMessages::default());
        let readers = HashMap::from([(
            codex(),
            Arc::clone(&exports) as Arc<dyn TelemetryExportReader>,
        )]);
        Fixture {
            token: token_of(&bearer),
            receiver: TelemetryReceiver::new(
                Arc::clone(&bearers),
                readers,
                Arc::clone(&raw_messages) as Arc<dyn RawProviderMessages>,
            ),
            exports,
            raw_messages,
            bearers,
            bearer,
        }
    }

    // The fixture's receiver served on a loopback port, with its base address.
    struct Served {
        base: String,
        exports: Arc<KeptExports>,
        raw_messages: Arc<KeptRawMessages>,
        bearers: Arc<TelemetryBearers>,
        // Held so the token stays live while the receiver is served.
        _bearer: TelemetryBearer,
        token: String,
        client: reqwest::Client,
    }

    impl Served {
        // A `POST` to `path` presenting the right token and the protobuf `Content-Type`.
        fn export(&self, path: &str) -> reqwest::RequestBuilder {
            self.client
                .post(format!("{}{path}", self.base))
                .bearer_auth(&self.token)
                .header(header::CONTENT_TYPE, "application/x-protobuf")
        }
    }

    async fn serve() -> Served {
        let Fixture {
            receiver,
            exports,
            raw_messages,
            bearers,
            bearer,
            token,
        } = fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback port");
        let address = listener.local_addr().expect("the port's address");
        tokio::spawn(async move { axum::serve(listener, receiver.into_router()).await });
        Served {
            base: format!("http://{address}"),
            exports,
            raw_messages,
            bearers,
            _bearer: bearer,
            token,
            client: reqwest::Client::builder()
                .no_proxy()
                .build()
                .expect("a client builds"),
        }
    }

    // A log export holding one record, encoded as an exporter sends it.
    fn logs_body() -> Vec<u8> {
        ExportLogsServiceRequest {
            resource_logs: vec![ResourceLogs {
                scope_logs: vec![ScopeLogs {
                    log_records: vec![LogRecord {
                        time_unix_nano: 1,
                        ..LogRecord::default()
                    }],
                    ..ScopeLogs::default()
                }],
                ..ResourceLogs::default()
            }],
        }
        .encode_to_vec()
    }

    // A refusal's `Status` body: its code and whether it carries a developer message.
    fn status_of(body: &[u8]) -> (i32, bool) {
        let status = RpcStatus::decode(body).expect("the body is a Status");
        (status.code, !status.message.is_empty())
    }

    // A token no live bearer of the path's provider holds: never minted, one whose guard dropped,
    // or one minted for another provider.
    enum UnheldToken {
        NeverMinted,
        GuardDropped,
        OtherProvider,
    }

    // A token no live codex bearer holds is refused before the body is read, with
    // `UNAUTHENTICATED`: the body here sends one chunk and never ends, so a read before the check
    // never answers, and its stream records being polled. The handler is called directly so the
    // check rests on whether the body was polled, not on whether a client reads an answer sent
    // before its body ended. Killed by checking the token after the body read, by a registry that
    // keeps a dropped bearer, by a bearer admitted on another provider's path, and by a `Status`
    // sent with no code.
    #[rstest]
    #[case::never_minted(UnheldToken::NeverMinted)]
    #[case::guard_dropped(UnheldToken::GuardDropped)]
    #[case::other_provider(UnheldToken::OtherProvider)]
    #[tokio::test]
    async fn a_token_no_live_bearer_holds_is_refused_before_the_body_is_read(
        #[case] unheld: UnheldToken,
    ) {
        let Fixture {
            receiver,
            exports,
            bearers,
            ..
        } = fixture();
        let mint = |provider: &str| {
            bearers
                .mint(
                    ProviderId::new(provider.to_owned()).expect("a provider id"),
                    TelemetryHolderId::new(2),
                )
                .expect("a token mints")
        };
        // The other provider's bearer stays live through the request.
        let mut _live_elsewhere = None;
        let token = match unheld {
            UnheldToken::NeverMinted => "not-the-token".to_owned(),
            UnheldToken::GuardDropped => token_of(&mint("codex")),
            UnheldToken::OtherProvider => {
                let bearer = mint("claude");
                let token = token_of(&bearer);
                _live_elsewhere = Some(bearer);
                token
            }
        };
        let is_polled = Arc::new(AtomicBool::new(false));
        let polled = Arc::clone(&is_polled);
        let body = futures::stream::once(async move {
            polled.store(true, Ordering::SeqCst);
            Ok::<_, std::io::Error>(Bytes::from_static(b"\x0a"))
        })
        .chain(futures::stream::pending());
        let request = Request::builder()
            .method(Method::POST)
            .uri("/telemetry/codex/v1/logs")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/x-protobuf")
            .body(Body::from_stream(body))
            .expect("a request");
        let response = tokio::time::timeout(
            Duration::from_secs(5),
            receive(
                Arc::new(receiver),
                Ok(Path("codex".to_owned())),
                TelemetrySignal::Logs,
                request,
            ),
        )
        .await
        .expect("the refusal comes before the body ends");
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!is_polled.load(Ordering::SeqCst), "the body was read");
        assert!(lock(&exports.0).is_empty());
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("the refusal's body");
        assert_eq!(status_of(&body), (16, true));
    }

    // The paths and methods the receiver does not take, each `Status` with its status's code; a
    // path off both routes gets the mounting router's own 404. Killed by answering a wrong method
    // 404, by admitting a provider no reader answers to, and by a code other than the status's.
    #[rstest]
    #[case::wrong_method(
        Method::GET,
        "/telemetry/codex/v1/logs",
        StatusCode::METHOD_NOT_ALLOWED,
        Some(12)
    )]
    #[case::unknown_signal(Method::POST, "/telemetry/codex/v1/x", StatusCode::NOT_FOUND, None)]
    #[case::provider_without_reader(
        Method::POST,
        "/telemetry/nobody/v1/logs",
        StatusCode::NOT_FOUND,
        Some(5)
    )]
    #[tokio::test]
    async fn an_export_off_the_receivers_routes_is_refused(
        #[case] method: Method,
        #[case] path: &str,
        #[case] status: StatusCode,
        #[case] code: Option<i32>,
    ) {
        let served = serve().await;
        let response = served
            .client
            .request(method, format!("{}{path}", served.base))
            .bearer_auth(&served.token)
            .header(header::CONTENT_TYPE, "application/x-protobuf")
            .body(logs_body())
            .send()
            .await
            .expect("an answer");
        assert_eq!(response.status(), status);
        if let Some(code) = code {
            let body = response.bytes().await.expect("the refusal's body");
            assert_eq!(status_of(&body), (code, true));
        }
        assert!(lock(&served.exports.0).is_empty());
    }

    // A body past the cap is 413 with `RESOURCE_EXHAUSTED`, any encoding but `identity` is 415
    // with `INVALID_ARGUMENT`, and `identity` is read as no encoding and answered with OTLP's
    // empty success, reaching the reader under the holder of the token it presented while a
    // second bearer is live. Killed by an uncapped read, by refusing `identity`, by the reader
    // handed another bearer's holder, and by a code other than the status's.
    #[tokio::test]
    async fn the_body_is_capped_and_only_identity_encoding_is_read() {
        let served = serve().await;
        let too_long = served
            .export("/telemetry/codex/v1/logs")
            .body(vec![0_u8; EXPORT_BODY_LIMIT + 1])
            .send()
            .await
            .expect("an answer");
        assert_eq!(too_long.status(), StatusCode::PAYLOAD_TOO_LARGE);
        let too_long = too_long.bytes().await.expect("the refusal's body");
        assert_eq!(status_of(&too_long), (8, true));
        let gzip = served
            .export("/telemetry/codex/v1/logs")
            .header(header::CONTENT_ENCODING, "gzip")
            .body(logs_body())
            .send()
            .await
            .expect("an answer");
        assert_eq!(gzip.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let gzip = gzip.bytes().await.expect("the refusal's body");
        assert_eq!(status_of(&gzip), (3, true));
        assert!(lock(&served.exports.0).is_empty());
        let second = served
            .bearers
            .mint(codex(), TelemetryHolderId::new(2))
            .expect("a token mints");
        let identity = served
            .client
            .post(format!("{}/telemetry/codex/v1/logs", served.base))
            .bearer_auth(token_of(&second))
            .header(header::CONTENT_TYPE, "application/x-protobuf")
            .header(header::CONTENT_ENCODING, "identity")
            .body(logs_body())
            .send()
            .await
            .expect("an answer");
        assert_eq!(identity.status(), StatusCode::OK);
        assert_eq!(
            identity.headers().get(header::CONTENT_TYPE),
            Some(&header::HeaderValue::from_static("application/x-protobuf"))
        );
        assert!(identity.bytes().await.expect("the body").is_empty());
        let exports = lock(&served.exports.0);
        assert_eq!(exports.len(), 1);
        assert_eq!(exports[0].0, second.holder());
        assert!(matches!(exports[0].1, TelemetryExport::Logs(_)));
    }

    // While raw messages are off the export reaches its reader and nothing is recorded; once on,
    // the whole export is recorded once as OTLP JSON under its provider. Killed by recording the
    // export while the switch is off. Reading the switch after the JSON is built is equivalent
    // here and held by review.
    #[tokio::test]
    async fn the_whole_export_is_recorded_only_while_raw_messages_are_on() {
        let served = serve().await;
        let off = served
            .export("/telemetry/codex/v1/logs")
            .body(logs_body())
            .send()
            .await
            .expect("an answer");
        assert_eq!(off.status(), StatusCode::OK);
        assert_eq!(lock(&served.exports.0).len(), 1);
        assert!(lock(&served.raw_messages.messages).is_empty());

        served
            .raw_messages
            .is_recording
            .store(true, Ordering::SeqCst);
        let on = served
            .export("/telemetry/codex/v1/logs")
            .body(logs_body())
            .send()
            .await
            .expect("an answer");
        assert_eq!(on.status(), StatusCode::OK);
        let messages = lock(&served.raw_messages.messages);
        assert_eq!(messages.len(), 1);
        let (provider, message) = &messages[0];
        assert_eq!(provider, &codex());
        let json: serde_json::Value = serde_json::from_str(message).expect("the message is JSON");
        assert!(json.get("resourceLogs").is_some(), "{message}");
    }
}
