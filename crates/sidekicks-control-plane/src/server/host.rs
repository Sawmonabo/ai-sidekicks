//! The Worker's host: it runs the gates on the Worker's environment, reads the address and the
//! request id Cloudflare sets, and serves the router with the account object's admission check.

use axum::body::Body;
use axum::http::Response;
use axum::response::IntoResponse;
use tower_service::Service;
use worker::{Env, HttpRequest};

use crate::rate_limit::enforcement_pipeline::AccountObjectAdmission;
use crate::server::gate::{BOOTSTRAP_ENABLED_KEY, ENVIRONMENT_KEY, check_request_gates};
use crate::server::router::{ControlPlaneRefusal, RequestId, SourceAddress, router};

/// The address the request reached Cloudflare's edge from, which Cloudflare sets and a caller
/// cannot.
const CLIENT_ADDRESS_HEADER: &str = "CF-Connecting-IP";

/// Cloudflare's id of the request, the one its own logs carry.
const RAY_HEADER: &str = "cf-ray";

/// Answers one request: a gate's refusal as a logged 503, else the router's answer.
pub(crate) async fn serve(mut request: HttpRequest, env: Env) -> Response<Body> {
    let request_id = header_text(&request, RAY_HEADER).map(RequestId);
    let gates = read_variable(&env, BOOTSTRAP_ENABLED_KEY).and_then(|bootstrap_enabled| {
        Ok((bootstrap_enabled, read_variable(&env, ENVIRONMENT_KEY)?))
    });
    let (bootstrap_enabled, environment) = match gates {
        Ok(values) => values,
        Err(error) => {
            return ControlPlaneRefusal::internal(request_id.as_ref(), &error).into_response();
        }
    };
    if let Err(refusal) = check_request_gates(bootstrap_enabled.as_deref(), environment.as_deref())
    {
        worker::console_warn!("control-plane refused: {refusal}");
        return refusal.into_response();
    }

    let admission = match AccountObjectAdmission::from_env(&env) {
        Ok(admission) => admission,
        Err(error) => {
            return ControlPlaneRefusal::internal(request_id.as_ref(), &error).into_response();
        }
    };
    if let Some(source_address) = header_text(&request, CLIENT_ADDRESS_HEADER) {
        request
            .extensions_mut()
            .insert(SourceAddress(source_address));
    }
    if let Some(request_id) = request_id {
        request.extensions_mut().insert(request_id);
    }
    match router(admission).call(request).await {
        Ok(response) => response,
        Err(infallible) => match infallible {},
    }
}

fn header_text(request: &HttpRequest, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)?
        .to_str()
        .ok()
        .map(str::to_owned)
}

// A variable as text, `None` when the Worker has no such binding; a binding that is not text
// reads as absent too, which the gates refuse.
fn read_variable(env: &Env, key: &str) -> Result<Option<String>, worker::Error> {
    let value = js_sys::Reflect::get(env, &key.into())?;
    Ok(value.as_string())
}
