//! What the daemon's stop or restart means for the lasting services a driver keeps, how a driver's
//! step is held to the stop's deadline, and how the services a provider's records still name are
//! ended with no daemon running.

use std::path::Path;

use futures::future::BoxFuture;
use tokio::time::error::Elapsed;
use tokio::time::{Instant, timeout_at};

use crate::driver::contract::error::DriverError;

/// Why the daemon stops: a restart, after which the daemon starts again and a service that
/// outlives it keeps running, or a stop, which ends that service too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DaemonStopIntent {
    /// The daemon starts again: a service that outlives it keeps running.
    Restart,
    /// The daemon stops: every service it started ends.
    Stop,
}

/// Every failure met while ending the lasting services a provider's records name with no daemon
/// running; every other record was still settled when it is answered.
#[derive(Debug, thiserror::Error)]
#[error("ending the provider's recorded services failed (failures: {})", .failures.len())]
pub struct RecordedServicesStopError {
    /// Each failure, in the order the records answered.
    pub failures: Vec<DriverError>,
}

/// Ends, with no daemon running, every lasting service a provider's records under the data folder
/// name, removing each record. Fails with [`RecordedServicesStopError`], holding every failure.
pub type RecordedServicesStop =
    fn(&Path) -> BoxFuture<'static, Result<(), RecordedServicesStopError>>;

/// Runs `future` to its end, or until `deadline` where the daemon's stop gives one. Fails with
/// `Elapsed` once the deadline cut it.
pub(crate) async fn run_until<F: Future>(
    deadline: Option<Instant>,
    future: F,
) -> Result<F::Output, Elapsed> {
    match deadline {
        Some(deadline) => timeout_at(deadline, future).await,
        None => Ok(future.await),
    }
}

/// The deadline of a daemon stop begun now: the daemon's whole stop bound from this instant.
#[cfg(any(test, feature = "test-support"))]
pub(crate) fn daemon_stop_deadline() -> Instant {
    Instant::now()
        + std::time::Duration::from_millis(
            sidekicks_contracts::daemon::lifecycle::DAEMON_STOP_DRAIN_BOUND_MS,
        )
}
