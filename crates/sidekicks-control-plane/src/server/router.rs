//! The router both hosts serve and the refusals it answers: every refusal is `{code, category,
//! message}` with the code's own fields beside them, its HTTP status the code's own.

use std::error::Error;

use axum::Json;
use axum::Router;
use axum::extract::FromRequestParts;
use axum::http::header::{RETRY_AFTER, WWW_AUTHENTICATE};
use axum::http::request::Parts;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value, json};
use sidekicks_contracts::jsonrpc::issue::Issue;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::rate_limiter::RateLimitResponse;

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

/// A refusal's code and its sentence for a person, its fields private so no caller outside this
/// module builds a 500 that skips its log.
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
    /// A caller not signed in or whose `DPoP` proof is refused: a 401 with its `WWW-Authenticate`
    /// challenge.
    Unauthenticated(AuthenticationFault),
    /// The relay's own failure, already logged; the caller reads only the fixed message.
    Internal(LoggedFailure),
}

/// Why a caller was refused with a 401. Each answers `WWW-Authenticate: DPoP algs="ES256"`, with
/// `error="invalid_token"` for a presented token that is refused and `error="invalid_dpop_proof"`
/// for a refused proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthenticationFault {
    /// No `Authorization` header with the `DPoP` scheme.
    NoToken,
    /// The token is not one this control plane signed, breaks a claim, or is revoked.
    TokenInvalid,
    /// The token's `exp` has passed.
    TokenExpired,
    /// The token is bound to another key than the proof's.
    KeyMismatch,
    /// The `DPoP` proof is missing, malformed, replayed or made for another request.
    ProofInvalid,
}

impl AuthenticationFault {
    // The code, the sentence for a person, and the challenge's `error` parameter.
    fn describe(self) -> (RefusalCode, &'static str, Option<&'static str>) {
        match self {
            Self::NoToken => (
                RefusalCode::AuthTokenInvalid,
                "This route needs a DPoP-bound access token.",
                None,
            ),
            Self::TokenInvalid => (
                RefusalCode::AuthTokenInvalid,
                "The access token is not valid.",
                Some("invalid_token"),
            ),
            Self::TokenExpired => (
                RefusalCode::AuthTokenExpired,
                "The access token has expired.",
                Some("invalid_token"),
            ),
            Self::KeyMismatch => (
                RefusalCode::AuthDpopMismatch,
                "The access token is bound to another key than the DPoP proof's.",
                Some("invalid_token"),
            ),
            Self::ProofInvalid => (
                RefusalCode::AuthDpopMismatch,
                "The DPoP proof is missing, malformed, replayed, or made for another request.",
                Some("invalid_dpop_proof"),
            ),
        }
    }
}

impl ControlPlaneRefusal {
    /// The refusal of a passkey ceremony whose challenge is unknown, expired, consumed, or not
    /// this transaction's, ceremony's or caller's.
    pub fn refuse_passkey_challenge() -> Self {
        Self::Plain(PlainRefusal {
            code: RefusalCode::AccountPasskeyChallengeInvalid,
            message: "The passkey challenge is unknown, expired or already used; start again."
                .to_owned(),
        })
    }

    /// The one refusal of every failed passkey verification, the same for each cause so the
    /// reply tells none apart.
    pub fn refuse_passkey_verification() -> Self {
        Self::Plain(PlainRefusal {
            code: RefusalCode::AccountPasskeyVerificationFailed,
            message: "The passkey could not be verified.".to_owned(),
        })
    }

    /// The refusal of a body with no JSON content type, or one that does not parse.
    pub(crate) fn refuse_envelope() -> Self {
        Self::Plain(PlainRefusal {
            code: RefusalCode::RequestEnvelopeInvalid,
            message: "The request's body is not JSON this route reads.".to_owned(),
        })
    }

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
            Self::Unauthenticated(fault) => {
                let (code, message, error) = fault.describe();
                let challenge = match error {
                    Some(error) => format!("DPoP algs=\"ES256\", error=\"{error}\""),
                    None => "DPoP algs=\"ES256\"".to_owned(),
                };
                let mut response = build_refusal_response(code, message, Map::new());
                response.headers_mut().insert(
                    WWW_AUTHENTICATE,
                    HeaderValue::from_str(&challenge).expect("the challenge is ASCII"),
                );
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
    fields.insert("category".to_owned(), json!(code.known_category().as_str()));
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

/// Builds the router the Compose relay serves: the account's routes and the app site association
/// file, a path neither serves and a method a route does not serve refused.
pub fn build_router(account: Router, app_site_association: Router) -> Router {
    add_refusal_fallbacks(account.merge(app_site_association))
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

/// The account a signed-in route's caller proved it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedInUser {
    /// The user's id, the access token's subject.
    pub user_id: String,
}

/// A router state that can tell who signed a request in: the access token in `Authorization:
/// DPoP` and the proof beside it. Refuses a caller that is not signed in with a 401, and a store
/// failure with the logged 500.
pub trait SignedInCheck {
    /// The signed-in caller of the request `parts` holds.
    fn check_signed_in(&self, parts: &Parts) -> Result<SignedInUser, ControlPlaneRefusal>;
}

impl<S: SignedInCheck + Send + Sync> FromRequestParts<S> for SignedInUser {
    type Rejection = ControlPlaneRefusal;

    fn from_request_parts(
        parts: &mut Parts,
        state: &S,
    ) -> impl Future<Output = Result<Self, Self::Rejection>> + Send {
        std::future::ready(state.check_signed_in(parts))
    }
}
