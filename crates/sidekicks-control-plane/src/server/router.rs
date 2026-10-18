//! The router both hosts serve and the refusals it answers: every refusal is `{code, category,
//! message}` with the code's own fields beside them, its HTTP status the code's own.

use std::error::Error;

use axum::Json;
use axum::Router;
use axum::extract::rejection::JsonRejection;
use axum::http::header::RETRY_AFTER;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::issue::{
    Issue, UNREADABLE_VALUE_ISSUE_MESSAGE, reader_issue_path,
};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::rate_limiter::RateLimitResponse;

use crate::rate_limit::enforcement_pipeline::AdmissionCheck;
use crate::server::log_internal_failure;

/// What a caller reads for a failure inside the relay; the failure itself goes to the log.
pub(crate) const INTERNAL_ERROR_MESSAGE: &str = "Unexpected internal error";

/// The address a request came from as the host's edge reports it, before its canonical form: the
/// `CF-Connecting-IP` header on Workers, the address Caddy saw on the Compose relay.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceAddress(pub String);

/// The id the host's edge gave the request, which its log lines carry: Cloudflare's `cf-ray` on
/// Workers, Caddy's `X-Request-Id` on the Compose relay.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestId(pub String);

/// Proof that an internal failure was logged; only
/// [`ControlPlaneRefusal::refuse_internal_failure`] makes one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoggedFailure(());

/// A refusal's code and its sentence for a person, kept private so no caller builds a 500 that
/// skips its log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlainRefusal {
    code: RefusalCode,
    message: String,
}

/// A refusal a caller tells apart by its code.
#[derive(Clone, Debug, PartialEq)]
pub enum ControlPlaneRefusal {
    /// A refusal whose body carries no fields of the code's own, built only by this module's
    /// constructors, none of which answers the internal code.
    Plain(PlainRefusal),
    /// A body that parses into the wrong shape: `request.paramsInvalid` with its issues.
    ParamsInvalid {
        /// Where the body breaks its shape, in the body's own names.
        issues: Vec<Issue>,
    },
    /// A body over the route's size limit: `request.envelopeInvalid` with `reason: tooLarge`, 413.
    BodyTooLarge,
    /// A sign-in route over its limit: the 429 body and its `Retry-After`.
    RateLimited(RateLimitResponse),
    /// The relay's own failure, already logged; the caller reads only the fixed message.
    Internal(LoggedFailure),
}

impl ControlPlaneRefusal {
    /// The refusal of a counted route whose request carries no source address the relay can count.
    pub fn refuse_unresolvable_source_address() -> Self {
        Self::Plain(PlainRefusal {
            code: RefusalCode::RelaySourceAddressUnresolvable,
            message: "The request carries no source address the relay can count, so it is refused."
                .to_owned(),
        })
    }

    /// Logs `error` with the request's id and answers the fixed internal refusal.
    pub fn refuse_internal_failure(
        request_id: Option<&RequestId>,
        error: &(dyn Error + 'static),
    ) -> Self {
        log_internal_failure(request_id.map(|id| id.0.as_str()), error);
        Self::Internal(LoggedFailure(()))
    }
}

impl From<JsonRejection> for ControlPlaneRefusal {
    // A body over the size limit is too large; one that parses into the wrong shape fails the
    // call's contract check; any other, unparsable or with no JSON content type, breaks the
    // envelope.
    fn from(rejection: JsonRejection) -> Self {
        if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
            return Self::BodyTooLarge;
        }
        if !matches!(rejection, JsonRejection::JsonDataError(_)) {
            return Self::Plain(PlainRefusal {
                code: RefusalCode::RequestEnvelopeInvalid,
                message: "The request's body is not JSON this route reads.".to_owned(),
            });
        }
        let mut source: Option<&(dyn Error + 'static)> = Some(&rejection);
        let mut path = Vec::new();
        while let Some(error) = source {
            if let Some(read) =
                error.downcast_ref::<serde_path_to_error::Error<serde_json::Error>>()
            {
                path = reader_issue_path(read.path());
                break;
            }
            source = error.source();
        }
        Self::ParamsInvalid {
            issues: vec![Issue {
                path,
                message: UNREADABLE_VALUE_ISSUE_MESSAGE.to_owned(),
                params: None,
            }],
        }
    }
}

impl IntoResponse for ControlPlaneRefusal {
    fn into_response(self) -> Response {
        match self {
            Self::Plain(PlainRefusal { code, message }) => {
                build_refusal_response(code, &message, Map::new())
            }
            Self::ParamsInvalid { issues } => {
                let mut fields = Map::new();
                fields.insert("issues".to_owned(), json!(issues));
                build_refusal_response(
                    RefusalCode::RequestParamsInvalid,
                    "The request's body does not have this route's shape.",
                    fields,
                )
            }
            Self::BodyTooLarge => {
                let mut fields = Map::new();
                fields.insert("reason".to_owned(), json!("tooLarge"));
                let body = build_refusal_body(
                    RefusalCode::RequestEnvelopeInvalid,
                    "The request's body is over this route's size limit.",
                    fields,
                );
                (StatusCode::PAYLOAD_TOO_LARGE, Json(body)).into_response()
            }
            Self::RateLimited(body) => {
                let retry_after = HeaderValue::from(body.retry_after.get());
                let mut response = (
                    read_refusal_status(RefusalCode::RelayRateLimited),
                    Json(body),
                )
                    .into_response();
                response.headers_mut().insert(RETRY_AFTER, retry_after);
                response
            }
            Self::Internal(LoggedFailure(())) => build_refusal_response(
                RefusalCode::SystemInternalError,
                INTERNAL_ERROR_MESSAGE,
                Map::new(),
            ),
        }
    }
}

/// The refusal body of `code`: `{code, category, message}` with `fields`, the code's own, beside.
pub(crate) fn build_refusal_body(
    code: RefusalCode,
    message: &str,
    mut fields: Map<String, Value>,
) -> Value {
    fields.insert("code".to_owned(), json!(code.as_str()));
    fields.insert("category".to_owned(), json!(code.category().as_str()));
    fields.insert("message".to_owned(), json!(message));
    Value::Object(fields)
}

fn build_refusal_response(
    code: RefusalCode,
    message: &str,
    fields: Map<String, Value>,
) -> Response {
    let body = build_refusal_body(code, message, fields);
    (read_refusal_status(code), Json(body)).into_response()
}

/// The HTTP status a refusal of `code` answers; a code with no registered status is refused on
/// meaning, 422.
pub(crate) fn read_refusal_status(code: RefusalCode) -> StatusCode {
    code.http_status()
        .and_then(|status| StatusCode::from_u16(status).ok())
        .unwrap_or(StatusCode::UNPROCESSABLE_ENTITY)
}

/// Builds the control plane's router, its routes reading `admission` from its state to count the
/// sign-in routes; a path no route serves and a method a route does not serve are refused.
pub fn build_router<A: AdmissionCheck>(admission: A) -> Router {
    add_refusal_fallbacks(Router::new()).with_state(admission)
}

/// Answers a path none of `routes` serves with `request.methodNotFound` (404) and a method a route
/// does not serve with `request.methodNotAllowed` (405, with the `Allow` header axum adds); it
/// goes after every route, since the 405 covers only the routes added before it.
pub fn add_refusal_fallbacks<S: Clone + Send + Sync + 'static>(routes: Router<S>) -> Router<S> {
    routes
        .fallback(refuse_method_not_found)
        .method_not_allowed_fallback(refuse_method_not_allowed)
}

async fn refuse_method_not_found() -> ControlPlaneRefusal {
    ControlPlaneRefusal::Plain(PlainRefusal {
        code: RefusalCode::RequestMethodNotFound,
        message: "No route of the control plane serves this path.".to_owned(),
    })
}

async fn refuse_method_not_allowed() -> ControlPlaneRefusal {
    ControlPlaneRefusal::Plain(PlainRefusal {
        code: RefusalCode::RequestMethodNotAllowed,
        message: "This route does not serve this HTTP method.".to_owned(),
    })
}
