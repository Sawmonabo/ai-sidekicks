//! The deployed Worker: its fetch entry, and the account object, the Durable Object that keeps the
//! account's data in its SQLite storage and counts the sign-in routes' requests there. A panic
//! answers 500 and resets the WebAssembly instance, so no path here panics.

use ::worker::{
    Context, DurableObject, Env, HttpRequest, Method, Request, Response, Result, ScheduledTime,
    SqlStorage, State, durable_object, event,
};
use axum::body::Body;
use axum::http::Response as HttpResponse;
use jiff::Timestamp;
use wasm_bindgen::JsValue;

use crate::account_store::{AccountStoreError, apply_schema};
use crate::rate_limit::enforcement_pipeline::{RATE_LIMIT_CHECK_PATH, REQUEST_ID_HEADER};
use crate::rate_limit::limiter::{
    RateLimitCheckRequest, RateLimiterError, check, next_cleanup_at, prune, wall_clock,
};
use crate::server::host;
use crate::server::log_internal_failure;
use crate::server::router::INTERNAL_ERROR_MESSAGE;

#[event(fetch)]
async fn fetch(request: HttpRequest, env: Env, _context: Context) -> Result<HttpResponse<Body>> {
    Ok(host::serve(request, env).await)
}

/// The account object: one per account, named `account`, the one writer of the account's data.
#[durable_object]
pub struct AccountObject {
    state: State,
}

/// A request or an alarm the account object could not finish; the cause is kept.
#[derive(Debug, thiserror::Error)]
enum AccountObjectError {
    /// The runtime failed a call: a body read, a storage call or a response.
    #[error("the account object's runtime failed a call")]
    Runtime(#[from] ::worker::Error),
    /// The account store refused a statement.
    #[error("the account object's store failed")]
    Store(#[from] AccountStoreError),
    /// The rate limiter failed.
    #[error("the account object's rate limiter failed")]
    Limiter(#[from] RateLimiterError),
    /// The clock read outside what a timestamp holds.
    #[error("the account object's clock is out of range")]
    Clock(#[from] jiff::Error),
}

impl DurableObject for AccountObject {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, mut request: Request) -> Result<Response> {
        let request_id = request.headers().get(REQUEST_ID_HEADER)?;
        match self.serve(&mut request).await {
            Ok(response) => Ok(response),
            Err(error) => {
                log_internal_failure(request_id.as_deref(), &error);
                Response::error(INTERNAL_ERROR_MESSAGE, 500)
            }
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

impl AccountObject {
    async fn serve(&self, request: &mut Request) -> Result<Response, AccountObjectError> {
        let sql = self.sql()?;
        if request.method() != Method::Post || request.path() != RATE_LIMIT_CHECK_PATH {
            return Ok(Response::error(
                "No route of the account object serves this request.",
                404,
            )?);
        }
        let count: RateLimitCheckRequest = request.json().await?;
        // Nothing is awaited between the count's read and its write.
        let response = check(&sql, &count, wall_clock()?)?;
        // Each alarm set is a billed write, so one is set only when none is pending.
        let storage = self.state.storage();
        if response.allowed
            && storage.get_alarm().await?.is_none()
            && let Some(at) = next_cleanup_at(&sql)?
        {
            storage.set_alarm(scheduled_time(at)).await?;
        }
        Ok(Response::from_json(&response)?)
    }

    async fn clean_up(&self) -> Result<(), AccountObjectError> {
        let sql = self.sql()?;
        if let Some(at) = prune(&sql, wall_clock()?)? {
            self.state.storage().set_alarm(scheduled_time(at)).await?;
        }
        Ok(())
    }

    // The object's storage with the account's schema built, which an object holding none gets on
    // its first request or alarm.
    fn sql(&self) -> Result<SqlStorage, AccountStoreError> {
        let sql = self.state.storage().sql();
        apply_schema(&sql)?;
        Ok(sql)
    }
}

// An alarm takes an absolute instant as a `Date`; a bare number would read as an offset from now.
fn scheduled_time(at: Timestamp) -> ScheduledTime {
    #[expect(
        clippy::cast_precision_loss,
        reason = "a millisecond instant is far below 2^53, which an f64 holds exactly"
    )]
    let millisecond = at.as_millisecond() as f64;
    ScheduledTime::new(js_sys::Date::new(&JsValue::from_f64(millisecond)))
}
