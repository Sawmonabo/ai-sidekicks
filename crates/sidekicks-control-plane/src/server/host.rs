//! The Worker's host: it runs the gates on the Worker's environment, reads the address and the
//! request id Cloudflare sets, serves the app site association file, and forwards each request
//! to an account route unchanged to the account object, which serves the account's routes over its
//! store. A path or method no route serves is refused here, so it never wakes the object.

use std::cell::OnceCell;
use std::pin::pin;
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{HeaderValue, Response};
use axum::response::IntoResponse;
use axum::routing::post;
use futures_util::future::{Either, select};
use tower_service::Service;
use worker::send::{SendFuture, SendWrapper};
use worker::{Delay, Env, HttpRequest};

use crate::account::aasa::{APPLE_APP_IDENTIFIER, build_app_site_association_router};
use crate::account::list_account_route_paths;
use crate::server::gate::{BOOTSTRAP_ENABLED_KEY, ENVIRONMENT_KEY, check_request_gates};
use crate::server::log_internal_failure;
use crate::server::router::{ControlPlaneRefusal, RequestId, SourceAddress, add_refusal_fallbacks};

/// The address the request reached Cloudflare's edge from, which Cloudflare sets and a caller
/// cannot; the Worker sets it again on the request it forwards.
pub(crate) const CLIENT_ADDRESS_HEADER: &str = "CF-Connecting-IP";

/// The header that carries the request id to the account object's log.
pub(crate) const REQUEST_ID_HEADER: &str = "X-Request-Id";

/// Cloudflare's id of the request, the one its own logs carry.
const RAY_HEADER: &str = "cf-ray";

/// The Worker's binding to the account object's namespace.
const ACCOUNT_BINDING: &str = "ACCOUNT";

/// The name of the one account object, which maps to the same object worldwide.
const ACCOUNT_OBJECT_NAME: &str = "account";

/// How long the Worker waits for the account object's answer: longer than the longest wait the
/// object makes, the authenticator list's fetch.
const ACCOUNT_OBJECT_WAIT: Duration = Duration::from_secs(10);

thread_local! {
    // The router, built on the instance's first request and kept for its life.
    static ROUTER: OnceCell<Router> = const { OnceCell::new() };
}

/// The account object did not answer the forwarded request.
#[derive(Debug, thiserror::Error)]
enum ForwardError {
    /// The runtime failed the forward: the binding, the request's conversion or the call.
    #[error("the account object could not be reached")]
    Runtime(#[from] worker::Error),
    /// A header the Worker sets does not fit a header's form.
    #[error("a forwarded header does not fit a header's form")]
    Header(#[from] axum::http::header::InvalidHeaderValue),
    /// The account object did not answer within the Worker's wait.
    #[error("the account object did not answer within {0:?}")]
    TimedOut(Duration),
}

/// Answers one request: a gate's refusal as a logged 503, else the router's answer.
pub(crate) async fn serve(mut request: HttpRequest, env: Env) -> Response<Body> {
    let request_id = read_header_text(&request, RAY_HEADER).map(RequestId);
    let gates = read_variable(&env, BOOTSTRAP_ENABLED_KEY).and_then(|bootstrap_enabled| {
        Ok((bootstrap_enabled, read_variable(&env, ENVIRONMENT_KEY)?))
    });
    let (bootstrap_enabled, environment) = match gates {
        Ok(values) => values,
        Err(error) => {
            return ControlPlaneRefusal::refuse_internal_failure(request_id.as_ref(), &error)
                .into_response();
        }
    };
    if let Err(refusal) = check_request_gates(bootstrap_enabled.as_deref(), environment.as_deref())
    {
        worker::console_warn!("control-plane refused: {refusal}");
        return refusal.into_response();
    }

    if let Some(source_address) = read_header_text(&request, CLIENT_ADDRESS_HEADER) {
        request
            .extensions_mut()
            .insert(SourceAddress(source_address));
    }
    if let Some(request_id) = request_id {
        request.extensions_mut().insert(request_id);
    }
    let mut router = ROUTER.with(|router| router.get_or_init(|| build_router(&env)).clone());
    match router.call(request.map(Body::new)).await {
        Ok(response) => response,
        Err(infallible) => match infallible {},
    }
}

// The app site association file and the account's routes, each forwarded to the account object,
// with the edge's own 404 and 405 for a path or a method none of them serves.
fn build_router(env: &Env) -> Router {
    let apple_app_identifier = read_setting(env, APPLE_APP_IDENTIFIER);
    let env = SendWrapper::new(env.clone());
    let forward = post(move |request: Request| forward_to_account_object(env.clone(), request));
    let account = list_account_route_paths()
        .iter()
        .fold(Router::new(), |router, path| {
            router.route(path, forward.clone())
        });
    add_refusal_fallbacks(account.merge(build_app_site_association_router(apple_app_identifier)))
}

// The runtime's handle is not `Send`; the Worker runs on one thread, so the wrapper is sound.
async fn forward_to_account_object(env: SendWrapper<Env>, request: Request) -> Response<Body> {
    let request_id = request.extensions().get::<RequestId>().cloned();
    match SendFuture::new(forward(env.0, request)).await {
        Ok(response) => response,
        Err(error) => ControlPlaneRefusal::refuse_internal_failure(request_id.as_ref(), &error)
            .into_response(),
    }
}

async fn forward(env: Env, mut request: Request) -> Result<Response<Body>, ForwardError> {
    // The object reads the caller's address and the request id only from what the Worker sets.
    let request_id = request.extensions().get::<RequestId>().cloned();
    let source_address = request.extensions().get::<SourceAddress>().cloned();
    let headers = request.headers_mut();
    headers.remove(REQUEST_ID_HEADER);
    headers.remove(CLIENT_ADDRESS_HEADER);
    if let Some(RequestId(request_id)) = request_id {
        headers.insert(REQUEST_ID_HEADER, HeaderValue::from_str(&request_id)?);
    }
    if let Some(SourceAddress(source_address)) = source_address {
        headers.insert(
            CLIENT_ADDRESS_HEADER,
            HeaderValue::from_str(&source_address)?,
        );
    }
    let stub = env
        .durable_object(ACCOUNT_BINDING)?
        .get_by_name(ACCOUNT_OBJECT_NAME)?;
    let request = worker::Request::try_from(request)?;
    let answer = pin!(stub.fetch_with_request(request));
    let wait = pin!(Delay::from(ACCOUNT_OBJECT_WAIT));
    match select(answer, wait).await {
        Either::Left((answer, _)) => Ok(worker::HttpResponse::try_from(answer?)?.map(Body::new)),
        Either::Right(((), _)) => Err(ForwardError::TimedOut(ACCOUNT_OBJECT_WAIT)),
    }
}

/// A request header as text, `None` when it is absent or not text.
pub(crate) fn read_header_text<B>(request: &axum::http::Request<B>, name: &str) -> Option<String> {
    request
        .headers()
        .get(name)?
        .to_str()
        .ok()
        .map(str::to_owned)
}

// A variable as text, `None` when the Worker has no such binding; a binding that is not text is
// logged and reads as absent, which the gates refuse.
fn read_variable(env: &Env, key: &str) -> Result<Option<String>, worker::Error> {
    let value = js_sys::Reflect::get(env, &key.into())?;
    if !value.is_undefined() && value.as_string().is_none() {
        worker::console_warn!("control-plane variable {key} is bound but is not text");
    }
    Ok(value.as_string())
}

/// A setting as text, `None` when it is absent; a binding the runtime fails to read is logged and
/// reads as absent, which fails the route that needs it.
pub(crate) fn read_setting(env: &Env, key: &str) -> Option<String> {
    read_variable(env, key).unwrap_or_else(|error| {
        log_internal_failure(None, &error);
        None
    })
}
