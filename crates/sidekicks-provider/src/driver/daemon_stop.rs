//! What the daemon's stop or restart means for the lasting services a driver keeps, and how the
//! services a provider's records still name are ended with no daemon running.

use std::path::Path;

use futures::future::BoxFuture;

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
#[error("ending the provider's recorded services met {} failures", .failures.len())]
pub struct RecordedServicesStopError {
    /// Each failure, in the order the records answered.
    pub failures: Vec<DriverError>,
}

/// Ends, with no daemon running, every lasting service a provider's records under the data folder
/// name, removing each record. Fails with [`RecordedServicesStopError`], holding every failure.
pub type RecordedServicesStop =
    fn(&Path) -> BoxFuture<'static, Result<(), RecordedServicesStopError>>;
