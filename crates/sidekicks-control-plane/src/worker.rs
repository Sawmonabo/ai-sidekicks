//! The deployed Worker: its fetch entry, and the account object, the Durable Object that keeps the
//! account's data in its SQLite storage and serves the account's routes over it, counting the
//! sign-in routes' requests there. A panic answers 500 and resets the WebAssembly instance, so no
//! path here panics.

use std::cell::OnceCell;

use ::worker::{
    Context, DurableObject, Env, HttpRequest, Request, Response, Result, State, durable_object,
    event,
};
use axum::Router;
use axum::body::Body;
use axum::http::Response as HttpResponse;
use axum::response::IntoResponse;
use tower_service::Service;

use crate::account::settings::AccountSettings;
use crate::account::webauthn::authenticator_list::WorkerAuthenticatorList;
use crate::account::webauthn::verifier::WorkerPasskeyVerifier;
use crate::account::{AccountRoutes, build_account_router};
use crate::account_store::{AccountObjectStore, AccountStoreError, apply_schema};
use crate::rate_limit::enforcement_pipeline::{AccountObjectAdmission, CleanupError, clean_up};
use crate::rate_limit::limiter::read_wall_clock;
use crate::server::host::{self, CLIENT_ADDRESS_HEADER, REQUEST_ID_HEADER, read_setting};
use crate::server::log_internal_failure;
use crate::server::router::{ControlPlaneRefusal, RequestId, SourceAddress, add_refusal_fallbacks};

#[event(fetch)]
async fn fetch(request: HttpRequest, env: Env, _context: Context) -> Result<HttpResponse<Body>> {
    Ok(host::serve(request, env).await)
}

/// The account object: one per account, named `account`, the one writer of the account's data.
#[durable_object]
pub struct AccountObject {
    state: State,
    env: Env,
    // The account router, built over this instance's store on its first request with the schema
    // built; a failed build is logged and tried again on the next request.
    router: OnceCell<Router>,
}

impl DurableObject for AccountObject {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            router: OnceCell::new(),
        }
    }

    async fn fetch(&self, request: Request) -> Result<Response> {
        let mut request = HttpRequest::try_from(request)?.map(Body::new);
        let request_id = host::read_header_text(&request, REQUEST_ID_HEADER).map(RequestId);
        let source_address = host::read_header_text(&request, CLIENT_ADDRESS_HEADER);
        let mut router = match self.open_router() {
            Ok(router) => router,
            Err(error) => {
                let refusal =
                    ControlPlaneRefusal::refuse_internal_failure(request_id.as_ref(), &error);
                return Response::try_from(refusal.into_response());
            }
        };
        if let Some(source_address) = source_address {
            request
                .extensions_mut()
                .insert(SourceAddress(source_address));
        }
        if let Some(request_id) = request_id {
            request.extensions_mut().insert(request_id);
        }
        match router.call(request).await {
            Ok(response) => Response::try_from(response),
            Err(infallible) => match infallible {},
        }
    }

    // Drops the counted requests whose window has passed and re-arms for the next address whose
    // window empties; a failure is logged and returned, so Cloudflare retries the alarm.
    async fn alarm(&self) -> Result<Response> {
        match self.clean_up().await {
            Ok(()) => Response::empty(),
            Err(error) => {
                log_internal_failure(None, &error);
                Err(::worker::Error::RustError(error.to_string()))
            }
        }
    }
}

/// An alarm the account object could not finish; the cause is kept.
#[derive(Debug, thiserror::Error)]
enum AlarmError {
    /// The store could not be opened.
    #[error("the account object's store could not be opened")]
    Store(#[from] AccountStoreError),
    /// The rate limit's cleanup failed.
    #[error("the rate limit's cleanup failed")]
    Cleanup(#[from] CleanupError),
}

impl AccountObject {
    async fn clean_up(&self) -> std::result::Result<(), AlarmError> {
        let store = self.open_store()?;
        clean_up(&self.state.storage(), &store).await?;
        Ok(())
    }

    // The object's store with the account's schema built, which an object holding none gets on
    // its first request or alarm.
    fn open_store(&self) -> std::result::Result<AccountObjectStore, AccountStoreError> {
        let store = AccountObjectStore::new(&self.state.storage());
        apply_schema(&store)?;
        Ok(store)
    }

    fn open_router(&self) -> std::result::Result<Router, AccountStoreError> {
        if let Some(router) = self.router.get() {
            return Ok(router.clone());
        }
        let store = self.open_store()?;
        let settings = AccountSettings::read(|name| read_setting(&self.env, name));
        let routes = AccountRoutes::new(
            store.clone(),
            WorkerPasskeyVerifier,
            WorkerAuthenticatorList,
            settings,
            read_wall_clock,
        );
        let admission = AccountObjectAdmission::new(store, self.state.storage());
        let router = add_refusal_fallbacks(build_account_router(routes, admission));
        Ok(self.router.get_or_init(|| router).clone())
    }
}
