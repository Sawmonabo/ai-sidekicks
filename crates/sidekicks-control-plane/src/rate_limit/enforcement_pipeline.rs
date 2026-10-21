//! The one admission stage every rate-limited route calls: the endpoint group's sliding-window
//! counter decides, and nothing else does. On the Compose relay the counter runs over the relay's
//! SQLite file in its own process; on the Workers relay over the account object's store, inside
//! the object that serves the account's routes.

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
}

#[cfg(not(target_arch = "wasm32"))]
pub use file::AccountFileAdmission;
#[cfg(target_arch = "wasm32")]
pub(crate) use object::{AccountObjectAdmission, CleanupError, clean_up};

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
    use crate::account_store::AccountStore;
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
                // The task starts inside the blocking step, whose thread runs inside the runtime,
                // so a caller that goes away mid-step never leaves the flag set with no task.
                let response = tokio::task::spawn_blocking(move || {
                    let connection = Arc::clone(&counter.connection);
                    let connection = connection.lock().unwrap_or_else(PoisonError::into_inner);
                    let now = (counter.clock)()?;
                    let (response, cleanup_at) = connection.write_step(|store| {
                        let response = check(store, &request, now)?;
                        // Only a counted request leaves a row, and only a missing task needs one.
                        let cleanup_at = if response.allowed
                            && !counter.is_cleanup_running.load(Ordering::SeqCst)
                        {
                            find_next_cleanup_at(store)?
                        } else {
                            None
                        };
                        Ok::<_, RateLimiterError>((response, cleanup_at))
                    })?;
                    if let Some(at) = cleanup_at {
                        counter.start_cleanup(at);
                    }
                    Ok::<_, RateLimiterError>(response)
                })
                .await??;
                Ok(response)
            }
        }
    }

    impl AccountFileCounter {
        // Called while the file is held: marks the task running and starts it.
        fn start_cleanup(&self, at: Timestamp) {
            self.is_cleanup_running.store(true, Ordering::SeqCst);
            let task = tokio::spawn(clean_up(
                Arc::clone(&self.connection),
                Arc::clone(&self.is_cleanup_running),
                self.clock,
                at,
            ));
            // The task before has cleared the flag and is ending, so its handle is only replaced.
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
                    .and_then(|now| connection.write_step(|store| prune(store, now)));
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
}

#[cfg(target_arch = "wasm32")]
mod object {
    //! The Workers relay's admission: the counter runs in the account object over the object's
    //! own store, one step per count, and a counted request arms the object's cleanup alarm when
    //! none is set.

    use std::future::Future;
    use std::sync::Arc;

    use jiff::Timestamp;
    use wasm_bindgen::JsValue;
    use worker::send::{SendFuture, SendWrapper};
    use worker::{ScheduledTime, Storage};

    use super::{AdmissionCheck, AdmissionError};
    use crate::account_store::{AccountObjectStore, AccountStore};
    use crate::rate_limit::limiter::{
        RateLimitCheckRequest, RateLimitCheckResponse, RateLimiterError, check,
        find_next_cleanup_at, prune, read_wall_clock,
    };
    use crate::server::log_internal_failure;
    use crate::server::router::RequestId;

    /// The account object's admission check: its store, and its storage, whose alarm drops the
    /// counted requests past their window.
    #[derive(Clone)]
    pub(crate) struct AccountObjectAdmission {
        store: AccountObjectStore,
        storage: Arc<SendWrapper<Storage>>,
    }

    /// Why the cleanup alarm could not be armed or run.
    #[derive(Debug, thiserror::Error)]
    pub(crate) enum CleanupError {
        /// The object's storage failed the alarm's read or write.
        #[error("the account object's alarm failed")]
        Alarm(#[from] worker::Error),
        /// The rate limiter failed.
        #[error("the rate limiter's cleanup failed")]
        Limiter(#[from] RateLimiterError),
    }

    impl AccountObjectAdmission {
        /// Counts over `store`, arming the alarm of `storage`, both the account object's.
        pub(crate) fn new(store: AccountObjectStore, storage: Storage) -> Self {
            Self {
                store,
                storage: Arc::new(SendWrapper::new(storage)),
            }
        }
    }

    impl AdmissionCheck for AccountObjectAdmission {
        fn check_admission(
            &self,
            request: RateLimitCheckRequest,
            request_id: Option<RequestId>,
        ) -> impl Future<Output = Result<RateLimitCheckResponse, AdmissionError>> + Send {
            let admission = self.clone();
            SendFuture::new(async move {
                let now = read_wall_clock().map_err(RateLimiterError::from)?;
                let response = admission
                    .store
                    .write_step(|store| check(store, &request, now))?;
                // The request is counted whatever the alarm does: a failed alarm leaves its rows
                // to the next count's delete, so it is logged and the count still answered.
                if response.allowed
                    && let Err(error) = arm_cleanup(&admission.storage, &admission.store).await
                {
                    log_internal_failure(request_id.as_ref().map(|id| id.0.as_str()), &error);
                }
                Ok(response)
            })
        }
    }

    // Each alarm set is a billed write, so one is set only when none is pending.
    async fn arm_cleanup(
        storage: &Storage,
        store: &AccountObjectStore,
    ) -> Result<(), CleanupError> {
        if storage.get_alarm().await?.is_none()
            && let Some(at) = find_next_cleanup_at(store)?
        {
            storage.set_alarm(build_scheduled_time(at)).await?;
        }
        Ok(())
    }

    /// The alarm's work: drops the counted requests whose window has passed and re-arms for the
    /// next address whose window empties.
    pub(crate) async fn clean_up(
        storage: &Storage,
        store: &AccountObjectStore,
    ) -> Result<(), CleanupError> {
        let now = read_wall_clock().map_err(RateLimiterError::from)?;
        if let Some(at) = store.write_step(|step| prune(step, now))? {
            storage.set_alarm(build_scheduled_time(at)).await?;
        }
        Ok(())
    }

    // An alarm takes an absolute instant as a `Date`; a bare number would read as an offset from
    // now.
    fn build_scheduled_time(at: Timestamp) -> ScheduledTime {
        #[expect(
            clippy::cast_precision_loss,
            reason = "a millisecond instant is far below 2^53, which an f64 holds exactly"
        )]
        let millisecond = at.as_millisecond() as f64;
        ScheduledTime::new(js_sys::Date::new(&JsValue::from_f64(millisecond)))
    }
}
