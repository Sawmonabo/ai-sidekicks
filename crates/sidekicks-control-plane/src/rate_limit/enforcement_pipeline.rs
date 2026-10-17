//! The one admission stage every rate-limited route calls: the endpoint group's sliding-window
//! counter decides, and nothing else does. On the Compose relay the counter runs over the relay's
//! SQLite file in its own process; the Worker reaches it in the account object (`worker.rs`).

use std::future::Future;

use crate::rate_limit::limiter::{RateLimitCheckRequest, RateLimitCheckResponse, RateLimiterError};
use crate::server::router::RequestId;

/// Counts one request against its endpoint group's limit and answers with the window's state; a
/// counter that fails answers an error, and the route fails that one request.
pub trait AdmissionCheck: Clone + Send + Sync + 'static {
    /// Counts `request`, which `request_id` names in the logs of every host it reaches.
    fn check_admission(
        &self,
        request: RateLimitCheckRequest,
        request_id: Option<RequestId>,
    ) -> impl Future<Output = Result<RateLimitCheckResponse, AdmissionError>> + Send;
}

/// Why a request could not be counted; the cause is kept.
#[derive(Debug, thiserror::Error)]
pub enum AdmissionError {
    /// The counter failed in the account store.
    #[error("the rate limiter failed")]
    Limiter(#[from] RateLimiterError),
    /// The task that counts on the account file ended before it answered.
    #[cfg(not(target_arch = "wasm32"))]
    #[error("the rate limiter's task ended before it answered")]
    Task(#[from] tokio::task::JoinError),
    /// The Worker could not reach the account object or read its answer.
    #[cfg(target_arch = "wasm32")]
    #[error("the account object could not be reached")]
    AccountObject(#[from] worker::Error),
    /// The account object answered the count with a failure status.
    #[cfg(target_arch = "wasm32")]
    #[error("the account object answered the count with status {status}")]
    AccountObjectStatus {
        /// The status it answered.
        status: u16,
    },
    /// The account object did not answer within the Worker's wait.
    #[cfg(target_arch = "wasm32")]
    #[error("the account object did not answer within {0:?}")]
    AccountObjectTimedOut(std::time::Duration),
}

#[cfg(not(target_arch = "wasm32"))]
pub use file::AccountFileAdmission;
#[cfg(target_arch = "wasm32")]
pub(crate) use object::{AccountObjectAdmission, RATE_LIMIT_CHECK_PATH, REQUEST_ID_HEADER};

#[cfg(not(target_arch = "wasm32"))]
mod file {
    //! The Compose relay's admission: the counter over the relay's SQLite file, and one cleanup
    //! task, started by a counted request when none is running, as the Worker's alarm is set.

    use std::error::Error;
    use std::future::Future;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, PoisonError};
    use std::time::Duration;

    use jiff::Timestamp;
    use rusqlite::Connection;
    use tokio::task::JoinHandle;

    use super::{AdmissionCheck, AdmissionError};
    use crate::rate_limit::limiter::{
        Clock, RateLimitCheckRequest, RateLimitCheckResponse, RateLimiterError, check,
        find_next_cleanup_at, prune,
    };
    use crate::server::router::RequestId;

    /// The Compose relay's admission check over its account file. A counted request starts the
    /// one cleanup task when none is running; the task sleeps until the next address's window
    /// empties, drops every row past its window, and ends once nothing is counted, so no counted
    /// request outlives its window. Dropping the last clone stops it.
    #[derive(Clone)]
    pub struct AccountFileAdmission {
        counter: Arc<AccountFileCounter>,
    }

    struct AccountFileCounter {
        connection: Arc<Mutex<Connection>>,
        clock: Clock,
        // Set and cleared only while the connection is held, so a count and the task's last
        // prune never both miss each other.
        is_cleanup_running: Arc<AtomicBool>,
        cleanup: Mutex<Option<JoinHandle<()>>>,
    }

    impl Drop for AccountFileCounter {
        fn drop(&mut self) {
            if let Some(cleanup) = self
                .cleanup
                .get_mut()
                .unwrap_or_else(PoisonError::into_inner)
            {
                cleanup.abort();
            }
        }
    }

    impl AccountFileAdmission {
        /// Counts on `connection`, the relay's open account file, reading the time from `clock`.
        pub fn new(connection: Arc<Mutex<Connection>>, clock: Clock) -> Self {
            Self {
                counter: Arc::new(AccountFileCounter {
                    connection,
                    clock,
                    is_cleanup_running: Arc::default(),
                    cleanup: Mutex::default(),
                }),
            }
        }
    }

    impl AdmissionCheck for AccountFileAdmission {
        fn check_admission(
            &self,
            request: RateLimitCheckRequest,
            _request_id: Option<RequestId>,
        ) -> impl Future<Output = Result<RateLimitCheckResponse, AdmissionError>> + Send {
            let counter = Arc::clone(&self.counter);
            async move {
                let connection = Arc::clone(&counter.connection);
                let is_cleanup_running = Arc::clone(&counter.is_cleanup_running);
                let clock = counter.clock;
                let (response, cleanup_at) = tokio::task::spawn_blocking(move || {
                    let mut connection = connection.lock().unwrap_or_else(PoisonError::into_inner);
                    let transaction = connection.transaction().map_err(wrap_store_error)?;
                    let response = check(&*transaction, &request, clock()?)?;
                    // Only a counted request leaves a row, and only a missing task needs one.
                    let cleanup_at =
                        if response.allowed && !is_cleanup_running.load(Ordering::SeqCst) {
                            find_next_cleanup_at(&*transaction)?
                        } else {
                            None
                        };
                    transaction.commit().map_err(wrap_store_error)?;
                    if cleanup_at.is_some() {
                        is_cleanup_running.store(true, Ordering::SeqCst);
                    }
                    Ok::<_, RateLimiterError>((response, cleanup_at))
                })
                .await??;
                if let Some(at) = cleanup_at {
                    counter.start_cleanup(at);
                }
                Ok(response)
            }
        }
    }

    impl AccountFileCounter {
        fn start_cleanup(&self, at: Timestamp) {
            let task = tokio::spawn(clean_up(
                Arc::clone(&self.connection),
                Arc::clone(&self.is_cleanup_running),
                self.clock,
                at,
            ));
            // The task that ran before has ended, so its handle is only replaced.
            *self.cleanup.lock().unwrap_or_else(PoisonError::into_inner) = Some(task);
        }
    }

    async fn clean_up(
        connection: Arc<Mutex<Connection>>,
        is_running: Arc<AtomicBool>,
        clock: Clock,
        mut at: Timestamp,
    ) {
        loop {
            let wait = match clock() {
                Ok(now) => Duration::try_from(now.duration_until(at)).unwrap_or(Duration::ZERO),
                Err(error) => return stop_cleanup(connection, is_running, &error).await,
            };
            tokio::time::sleep(wait).await;
            let pruning = Arc::clone(&connection);
            let running = Arc::clone(&is_running);
            let next = tokio::task::spawn_blocking(move || {
                let connection = pruning.lock().unwrap_or_else(PoisonError::into_inner);
                let next = clock()
                    .map_err(RateLimiterError::from)
                    .and_then(|now| prune(&*connection, now));
                if !matches!(next, Ok(Some(_))) {
                    running.store(false, Ordering::SeqCst);
                }
                next
            })
            .await;
            match next {
                Ok(Ok(Some(next))) => at = next,
                Ok(Ok(None)) => return,
                Ok(Err(error)) => return log_cleanup_failure(&error),
                Err(error) => return stop_cleanup(connection, is_running, &error).await,
            }
        }
    }

    // Marks the task ended while the file is held, so the next count starts another.
    async fn stop_cleanup(
        connection: Arc<Mutex<Connection>>,
        is_running: Arc<AtomicBool>,
        error: &(dyn Error + Send + Sync + 'static),
    ) {
        log_cleanup_failure(error);
        let stopped = tokio::task::spawn_blocking(move || {
            let _held = connection.lock().unwrap_or_else(PoisonError::into_inner);
            is_running.store(false, Ordering::SeqCst);
        })
        .await;
        if let Err(error) = stopped {
            log_cleanup_failure(&error);
        }
    }

    // A failed cleanup leaves its rows to the next count, which drops them and starts the task.
    fn log_cleanup_failure(error: &(dyn Error + 'static)) {
        tracing::error!(error, "the rate limit's cleanup stopped");
    }

    fn wrap_store_error(error: rusqlite::Error) -> RateLimiterError {
        RateLimiterError::Store(error.into())
    }
}

#[cfg(target_arch = "wasm32")]
mod object {
    //! The Worker's admission: the counter runs in the account object, reached through its stub
    //! with a JSON request the Worker waits on for a bounded time.

    use std::future::Future;
    use std::pin::pin;
    use std::time::Duration;

    use futures_util::future::{Either, select};
    use worker::send::SendFuture;
    use worker::{Delay, Env, Headers, Method, Request, RequestInit};

    use super::{AdmissionCheck, AdmissionError};
    use crate::rate_limit::limiter::{RateLimitCheckRequest, RateLimitCheckResponse};
    use crate::server::router::RequestId;

    /// The Worker's binding to the account object's namespace.
    const ACCOUNT_BINDING: &str = "ACCOUNT";

    /// The name of the one account object, which `id_from_name` maps to the same object worldwide.
    const ACCOUNT_OBJECT_NAME: &str = "account";

    /// The account object's route that counts one request.
    pub(crate) const RATE_LIMIT_CHECK_PATH: &str = "/rate-limit/check";

    /// The header that carries the Worker's request id to the account object's log.
    pub(crate) const REQUEST_ID_HEADER: &str = "X-Request-Id";

    /// How long the Worker waits for the account object's whole answer, well inside a caller's
    /// own wait.
    const ACCOUNT_OBJECT_WAIT: Duration = Duration::from_secs(5);

    /// The Worker's admission check: one count in the account object per request, its binding
    /// read when a count needs it.
    #[derive(Clone)]
    pub(crate) struct AccountObjectAdmission {
        env: Env,
    }

    impl AccountObjectAdmission {
        /// Counts through the account object `env` binds.
        pub(crate) fn new(env: Env) -> Self {
            Self { env }
        }
    }

    impl AdmissionCheck for AccountObjectAdmission {
        fn check_admission(
            &self,
            request: RateLimitCheckRequest,
            request_id: Option<RequestId>,
        ) -> impl Future<Output = Result<RateLimitCheckResponse, AdmissionError>> + Send {
            let env = self.env.clone();
            SendFuture::new(async move {
                let stub = env
                    .durable_object(ACCOUNT_BINDING)?
                    .id_from_name(ACCOUNT_OBJECT_NAME)?
                    .get_stub()?;
                let headers = Headers::new();
                headers.set("Content-Type", "application/json")?;
                if let Some(request_id) = &request_id {
                    headers.set(REQUEST_ID_HEADER, &request_id.0)?;
                }
                let body = serde_json::to_string(&request).map_err(worker::Error::from)?;
                let mut init = RequestInit::new();
                init.with_method(Method::Post)
                    .with_headers(headers)
                    .with_body(Some(body.into()));
                let count = Request::new_with_init(
                    &format!("https://{ACCOUNT_OBJECT_NAME}{RATE_LIMIT_CHECK_PATH}"),
                    &init,
                )?;
                // The wait covers the answer's body too, so an object that stalls mid-answer
                // fails the request instead of holding it open.
                let answer = pin!(async move {
                    let mut response = stub.fetch_with_request(count).await?;
                    let status = response.status_code();
                    if status != 200 {
                        return Err(AdmissionError::AccountObjectStatus { status });
                    }
                    Ok(response.json::<RateLimitCheckResponse>().await?)
                });
                let wait = pin!(Delay::from(ACCOUNT_OBJECT_WAIT));
                match select(answer, wait).await {
                    Either::Left((answer, _)) => answer,
                    Either::Right(((), _)) => {
                        Err(AdmissionError::AccountObjectTimedOut(ACCOUNT_OBJECT_WAIT))
                    }
                }
            })
        }
    }
}
