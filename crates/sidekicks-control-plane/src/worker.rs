//! The deployed Worker: its fetch entry, and the account object, the Durable Object that keeps the
//! account's data in its SQLite storage and counts the sign-in routes' requests there. A panic
//! answers 500 and resets the WebAssembly instance, so no path here panics.

use std::cell::Cell;

use ::worker::{
    Context, DurableObject, Env, HttpRequest, Method, Request, Response, Result, ScheduledTime,
    SqlStorage, State, durable_object, event,
};
use axum::body::Body;
use axum::http::Response as HttpResponse;
use jiff::Timestamp;
use serde_json::Map;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use wasm_bindgen::JsValue;

use crate::account_store::{AccountStoreError, apply_schema};
use crate::rate_limit::enforcement_pipeline::{RATE_LIMIT_CHECK_PATH, REQUEST_ID_HEADER};
use crate::rate_limit::limiter::{
    RateLimitCheckRequest, RateLimiterError, check, find_next_cleanup_at, prune, read_wall_clock,
};
use crate::server::host;
use crate::server::log_internal_failure;
use crate::server::router::{INTERNAL_ERROR_MESSAGE, build_refusal_body, read_refusal_status};

#[event(fetch)]
async fn fetch(request: HttpRequest, env: Env, _context: Context) -> Result<HttpResponse<Body>> {
    Ok(host::serve(request, env).await)
}

/// The account object: one per account, named `account`, the one writer of the account's data.
#[durable_object]
pub struct AccountObject {
    state: State,
    // Whether this instance has seen the schema built, so later calls skip the check.
    is_schema_built: Cell<bool>,
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
        Self {
            state,
            is_schema_built: Cell::new(false),
        }
    }

    async fn fetch(&self, mut request: Request) -> Result<Response> {
        let request_id = request.headers().get(REQUEST_ID_HEADER)?;
        match self.serve(&mut request, request_id.as_deref()).await {
            Ok(response) => Ok(response),
            Err(error) => {
                log_internal_failure(request_id.as_deref(), &error);
                build_refusal(RefusalCode::SystemInternalError, INTERNAL_ERROR_MESSAGE)
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
    async fn serve(
        &self,
        request: &mut Request,
        request_id: Option<&str>,
    ) -> Result<Response, AccountObjectError> {
        let sql = self.open_sql()?;
        if request.method() != Method::Post || request.path() != RATE_LIMIT_CHECK_PATH {
            return Ok(build_refusal(
                RefusalCode::RequestMethodNotFound,
                "No route of the account object serves this request.",
            )?);
        }
        let count: RateLimitCheckRequest = request.json().await?;
        // Nothing is awaited between the count's read and its write.
        let response = check(&sql, &count, read_wall_clock()?)?;
        // The request is counted whatever the alarm does: a failed alarm leaves its rows to the
        // next check's delete, so it is logged and the count still answered.
        if response.allowed
            && let Err(error) = self.arm_cleanup(&sql).await
        {
            log_internal_failure(request_id, &error);
        }
        Ok(Response::from_json(&response)?)
    }

    // Each alarm set is a billed write, so one is set only when none is pending.
    async fn arm_cleanup(&self, sql: &SqlStorage) -> Result<(), AccountObjectError> {
        let storage = self.state.storage();
        if storage.get_alarm().await?.is_none()
            && let Some(at) = find_next_cleanup_at(sql)?
        {
            storage.set_alarm(build_scheduled_time(at)).await?;
        }
        Ok(())
    }

    async fn clean_up(&self) -> Result<(), AccountObjectError> {
        let sql = self.open_sql()?;
        if let Some(at) = prune(&sql, read_wall_clock()?)? {
            self.state
                .storage()
                .set_alarm(build_scheduled_time(at))
                .await?;
        }
        Ok(())
    }

    // The object's storage with the account's schema built, which an object holding none gets on
    // its first request or alarm; once built, this instance does not check again.
    fn open_sql(&self) -> Result<SqlStorage, AccountStoreError> {
        let sql = self.state.storage().sql();
        if !self.is_schema_built.get() {
            apply_schema(&sql)?;
            self.is_schema_built.set(true);
        }
        Ok(sql)
    }
}

// A refusal in the body every other refusal takes, at its code's status.
fn build_refusal(code: RefusalCode, message: &str) -> Result<Response> {
    let body = build_refusal_body(code, message, Map::new());
    Ok(Response::from_json(&body)?.with_status(read_refusal_status(code).as_u16()))
}

// An alarm takes an absolute instant as a `Date`; a bare number would read as an offset from now.
fn build_scheduled_time(at: Timestamp) -> ScheduledTime {
    #[expect(
        clippy::cast_precision_loss,
        reason = "a millisecond instant is far below 2^53, which an f64 holds exactly"
    )]
    let millisecond = at.as_millisecond() as f64;
    ScheduledTime::new(js_sys::Date::new(&JsValue::from_f64(millisecond)))
}
