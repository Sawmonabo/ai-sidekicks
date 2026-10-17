//! The router both hosts serve and the refusals it answers: every refusal is `{code, category,
//! message}` with the code's own fields beside them, its HTTP status the code's own.

use axum::Json;
use axum::Router;
use axum::extract::rejection::JsonRejection;
use axum::http::header::RETRY_AFTER;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::rate_limiter::RateLimitResponse;

use crate::rate_limit::enforcement_pipeline::AdmissionCheck;
use crate::server::log_internal_failure;

/// What a caller reads for a failure inside the relay; the failure itself goes to the log.
pub const INTERNAL_ERROR_MESSAGE: &str = "Unexpected internal error";

/// The address a request came from as the host's edge reports it, before its canonical form: the
/// `CF-Connecting-IP` header on Workers, the address Caddy saw on the Compose relay.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceAddress(pub String);

/// The id the host's edge gave the request, which its log lines carry: Cloudflare's `cf-ray` on
/// Workers, Caddy's `X-Request-Id` on the Compose relay.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestId(pub String);

/// A refusal a caller tells apart by its code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlPlaneRefusal {
    /// A refusal whose body carries no fields of the code's own.
    Plain {
        /// The refusal's code, which sets its category and status.
        code: RefusalCode,
        /// A sentence for a person.
        message: String,
    },
    /// A sign-in route over its limit: the 429 body and its `Retry-After`.
    RateLimited(RateLimitResponse),
    /// The relay's own failure, already logged; the caller reads only the fixed message.
    Internal,
}

#[derive(Serialize)]
struct RefusalBody<'a> {
    code: &'a str,
    category: &'a str,
    message: &'a str,
}

impl ControlPlaneRefusal {
    /// The refusal of a counted route whose request carries no source address the relay can count.
    pub fn source_address_unresolvable() -> Self {
        Self::Plain {
            code: RefusalCode::RelaySourceAddressUnresolvable,
            message: "The request carries no source address the relay can count, so it is refused."
                .to_owned(),
        }
    }

    /// Logs `error` with the request's id and answers the fixed internal refusal.
    pub fn internal(
        request_id: Option<&RequestId>,
        error: &(dyn std::error::Error + 'static),
    ) -> Self {
        log_internal_failure(request_id.map(|id| id.0.as_str()), error);
        Self::Internal
    }
}

impl From<JsonRejection> for ControlPlaneRefusal {
    // A body that does not parse, or carries no JSON content type, breaks the envelope; one that
    // parses into the wrong shape fails the call's contract check.
    fn from(rejection: JsonRejection) -> Self {
        let code = if matches!(rejection, JsonRejection::JsonDataError(_)) {
            RefusalCode::RequestParamsInvalid
        } else {
            RefusalCode::RequestEnvelopeInvalid
        };
        Self::Plain {
            code,
            message: rejection.body_text(),
        }
    }
}

impl IntoResponse for ControlPlaneRefusal {
    fn into_response(self) -> Response {
        match self {
            Self::Plain { code, message } => refusal_response(code, &message),
            Self::RateLimited(body) => {
                let retry_after = HeaderValue::from(body.retry_after.get());
                let mut response =
                    (status_of(RefusalCode::RelayRateLimited), Json(body)).into_response();
                response.headers_mut().insert(RETRY_AFTER, retry_after);
                response
            }
            Self::Internal => {
                refusal_response(RefusalCode::SystemInternalError, INTERNAL_ERROR_MESSAGE)
            }
        }
    }
}

fn refusal_response(code: RefusalCode, message: &str) -> Response {
    let body = RefusalBody {
        code: code.as_str(),
        category: code.category().as_str(),
        message,
    };
    (status_of(code), Json(body)).into_response()
}

// A code with no registered HTTP status is refused on meaning, 422.
fn status_of(code: RefusalCode) -> StatusCode {
    code.http_status()
        .and_then(|status| StatusCode::from_u16(status).ok())
        .unwrap_or(StatusCode::UNPROCESSABLE_ENTITY)
}

/// The control plane's router, its routes reading `admission` from its state to count the
/// sign-in routes; a path no route serves and a method a route does not serve are refused.
pub fn router<A: AdmissionCheck>(admission: A) -> Router {
    with_refusal_fallbacks(Router::new()).with_state(admission)
}

/// Answers a path none of `routes` serves with `request.methodNotFound` (404) and a method a route
/// does not serve with `request.methodNotAllowed` (405, with the `Allow` header axum adds); it
/// goes after every route, since the 405 covers only the routes added before it.
pub fn with_refusal_fallbacks<S: Clone + Send + Sync + 'static>(routes: Router<S>) -> Router<S> {
    routes
        .fallback(method_not_found)
        .method_not_allowed_fallback(method_not_allowed)
}

async fn method_not_found() -> ControlPlaneRefusal {
    ControlPlaneRefusal::Plain {
        code: RefusalCode::RequestMethodNotFound,
        message: "No route of the control plane serves this path.".to_owned(),
    }
}

async fn method_not_allowed() -> ControlPlaneRefusal {
    ControlPlaneRefusal::Plain {
        code: RefusalCode::RequestMethodNotAllowed,
        message: "This route does not serve this HTTP method.".to_owned(),
    }
}
