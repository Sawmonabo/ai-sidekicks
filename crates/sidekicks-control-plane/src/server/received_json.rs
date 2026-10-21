//! The body every control plane procedure reads: JSON held to its contract the way every server
//! here holds a received message, its schema's shape, then serde, then its garde rules.

use axum::body::Bytes;
use axum::extract::{FromRequest, Request};
use axum::http::StatusCode;
use axum::http::header::CONTENT_TYPE;
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use sidekicks_contracts::jsonrpc::issue::received_issues;
use sidekicks_contracts::wire::attachment::{ReceivedError, parse_received};

use crate::server::router::{ControlPlaneRefusal, RequestId};

/// A procedure's body read as `T`. A body over the size limit is refused 413; one with no JSON
/// content type, or that does not parse, `request.envelopeInvalid` 400; one that breaks `T`'s
/// contract `request.paramsInvalid` 422 with its issues; a contract whose check cannot be built
/// fails with the logged 500.
#[derive(Clone, Debug)]
pub struct ReceivedJson<T>(pub T);

impl<T, S> FromRequest<S> for ReceivedJson<T>
where
    T: DeserializeOwned + JsonSchema + garde::Validate<Context = ()> + 'static,
    S: Send + Sync,
{
    type Rejection = ControlPlaneRefusal;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let request_id = request.extensions().get::<RequestId>().cloned();
        if !has_json_content_type(&request) {
            return Err(ControlPlaneRefusal::refuse_envelope());
        }
        let body = Bytes::from_request(request, state)
            .await
            .map_err(|rejection| {
                if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                    ControlPlaneRefusal::BodyTooLarge
                } else {
                    ControlPlaneRefusal::refuse_envelope()
                }
            })?;
        match parse_received::<T>(&body, Vec::new()) {
            Ok(value) => Ok(Self(value)),
            Err(ReceivedError::Json(_)) => Err(ControlPlaneRefusal::refuse_envelope()),
            Err(refused) => match received_issues(refused) {
                Ok(issues) => Err(ControlPlaneRefusal::ParamsInvalid { issues }),
                Err(error) => Err(ControlPlaneRefusal::refuse_internal_failure(
                    request_id.as_ref(),
                    &error,
                )),
            },
        }
    }
}

// `application/json`, or an `application/…+json` type, with any parameters.
fn has_json_content_type(request: &Request) -> bool {
    let Some(content_type) = request
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence == "application/json"
        || essence
            .strip_prefix("application/")
            .is_some_and(|subtype| subtype.ends_with("+json"))
}
