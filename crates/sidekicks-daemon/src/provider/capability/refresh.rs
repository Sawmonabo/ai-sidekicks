//! The capability refresh: every registered driver's capabilities read again, declared through the
//! capabilities writer and recorded on the registry, once at the daemon's start and again on each
//! trigger (a provider command-path change, the person's `Check again`, a provider process start,
//! a stale model catalog), never on a timer.
//!
//! The passes run on one task the refresher starts, ended by its handle's stop or drop, never
//! inside a caller's future, so a caller that stops waiting (a canceled request, a closed
//! connection) loses no pass. A trigger that arrives while a pass runs asks for one more, any
//! number of triggers during one pass ask for that one pass, and each caller returns once a pass
//! that started after its ask has finished. Each driver's read and declare share one deadline,
//! and a read that misses it is canceled by dropping it, never left running: the declare's lock is
//! released, a write already handed to the database writer still commits whole, and a handshake
//! child the driver started with `kill_on_drop` ends with it.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::join_all;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::id::ProviderId;
use tokio::sync::{Notify, watch};
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::{CancellationToken, DropGuard};

use crate::error_description::describe_error;
use crate::mutex_lock::lock;
use crate::provider::driver::capabilities::writer::{
    DriverCapabilitiesWriter, DriverCapabilitiesWriterError,
};
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::provider::driver::registry::ProviderRegistry;

/// How long one driver's read and declare may take before the refresh cancels it, so a read that
/// never settles cannot hold the refresh and every trigger after it.
pub(crate) const CAPABILITY_REFRESH_READ_TIMEOUT: Duration = Duration::from_mins(2);

/// Reads every registered driver's capabilities again when asked; see the module doc.
pub(crate) struct CapabilityRefresher {
    /// What callers ask of the pass task.
    asks: Arc<RefreshAsks>,
    /// The number of passes the task has finished, which a caller waits on.
    finished: watch::Receiver<u64>,
}

/// The refresher's pass task, from [`CapabilityRefresher::start`] until
/// [`CapabilityRefreshing::stop`]; dropping it ends the task too, unawaited.
pub(crate) struct CapabilityRefreshing {
    /// Ends the task, dropping a pass under way, when stopped or dropped.
    stop: DropGuard,
    /// The task that runs the passes.
    task: JoinHandle<()>,
}

/// What the refresher's callers and its pass task share.
struct RefreshAsks {
    /// Which passes started and which one the newest ask needs: two counts, which hold no
    /// invariant a panicking holder could break.
    state: Mutex<RefreshAskState>,
    /// Wakes the task for a pass asked for.
    is_asked: Notify,
}

/// The passes counted from 1: at most one runs, and at most one more is asked for.
#[derive(Default)]
struct RefreshAskState {
    /// The passes started.
    started: u64,
    /// The pass the newest ask needs, the first to start after it.
    requested: u64,
}

/// The drivers a pass reads and where it declares and records each reading.
struct DriverReads {
    /// The drivers read, and where each reading is recorded for the capability gate.
    providers: Arc<ProviderRegistry>,
    /// Where each reading is declared, so a cold start answers without asking the driver.
    writer: Arc<DriverCapabilitiesWriter>,
}

/// Why one driver's read did not land.
#[derive(Debug, thiserror::Error)]
enum CapabilityRefreshFailure {
    /// The driver could not read its capabilities.
    #[error("the driver's capability read failed")]
    Read(#[source] DriverError),
    /// The reading could not be declared.
    #[error("declaring the driver's capabilities failed")]
    Declare(#[source] DriverCapabilitiesWriterError),
}

impl CapabilityRefresher {
    /// A refresher over the registered drivers, declaring through `writer`, and its pass task,
    /// spawned on the current tokio runtime, so it must run inside one; no pass runs until one is
    /// asked for.
    pub(crate) fn start(
        providers: Arc<ProviderRegistry>,
        writer: Arc<DriverCapabilitiesWriter>,
    ) -> (Self, CapabilityRefreshing) {
        let asks = Arc::new(RefreshAsks {
            state: Mutex::new(RefreshAskState::default()),
            is_asked: Notify::new(),
        });
        let (finished_sender, finished) = watch::channel(0);
        let stop = CancellationToken::new();
        let task = tokio::spawn(run_passes(
            Arc::clone(&asks),
            DriverReads { providers, writer },
            finished_sender,
            stop.clone(),
        ));
        (
            Self { asks, finished },
            CapabilityRefreshing {
                stop: stop.drop_guard(),
                task,
            },
        )
    }

    /// Asks for a pass that reads every driver once, all at once, and returns once a pass started
    /// after the ask has finished: each read landed, failed or missed its deadline, a failure
    /// reported as a diagnostic, never returned. Asked while a pass runs, it waits for the one
    /// pass after it. Returns `false` when the task, ended by its handle's stop or drop, ended
    /// before that pass finished.
    pub(crate) async fn refresh_now(&self) -> bool {
        let needed = {
            let mut state = lock(&self.asks.state);
            state.requested = state.started + 1;
            state.requested
        };
        self.asks.is_asked.notify_one();
        let mut finished = self.finished.clone();
        // Fails only when the task ended, its count's sender with it, before the pass finished.
        finished.wait_for(|count| *count >= needed).await.is_ok()
    }
}

impl CapabilityRefreshing {
    /// Ends the pass task, dropping a pass under way, which cancels its reads, and settles once
    /// the task has ended; every caller still waiting then returns `false`. Fails only when the
    /// task itself ended abnormally.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's stop ends the refresh through it")
    )]
    pub(crate) async fn stop(self) -> Result<(), JoinError> {
        let Self { stop, task } = self;
        drop(stop);
        task.await
    }
}

// The refresher's task: one pass for each ask the last pass started before, until `stop`, which
// drops the pass or wait under way.
async fn run_passes(
    asks: Arc<RefreshAsks>,
    reads: DriverReads,
    finished: watch::Sender<u64>,
    stop: CancellationToken,
) {
    loop {
        let pass = {
            let mut state = lock(&asks.state);
            (state.requested > state.started).then(|| {
                state.started += 1;
                state.started
            })
        };
        let step = async {
            match pass {
                Some(pass) => {
                    reads.read_every_driver().await;
                    finished.send_replace(pass);
                }
                // An ask made before this wait stored its wake, so none is missed.
                None => asks.is_asked.notified().await,
            }
        };
        if stop.run_until_cancelled(step).await.is_none() {
            return;
        }
    }
}

impl DriverReads {
    // Reads every driver once, all at once.
    async fn read_every_driver(&self) {
        join_all(
            self.providers
                .drivers()
                .map(|(provider, _)| self.refresh_driver(provider)),
        )
        .await;
    }

    // Reads, declares and records one driver's capabilities, reporting a failure or a miss of the
    // deadline. Every successful reading is recorded, so the gate holds the newest reading even
    // when the stored snapshot it matched was never recorded in this run of the daemon.
    async fn refresh_driver(&self, provider: &ProviderId) {
        let read = async {
            let driver = self
                .providers
                .lookup(provider)
                .expect("a provider the registry lists has a driver");
            let reading = driver
                .get_capabilities()
                .await
                .map_err(CapabilityRefreshFailure::Read)?;
            self.writer
                .declare(provider, &reading)
                .await
                .map_err(CapabilityRefreshFailure::Declare)?;
            Ok(reading)
        };
        match tokio::time::timeout(CAPABILITY_REFRESH_READ_TIMEOUT, read).await {
            Ok(Ok(reading)) => self
                .providers
                .record_capabilities(provider, reading.capabilities)
                .expect("a provider the registry lists has an entry"),
            Ok(Err(failure)) => report_refresh_failure(provider, Some(&failure)),
            Err(_elapsed) => report_refresh_failure(provider, None),
        }
    }
}

// Reports one driver's failed read, or one that missed its deadline when `failure` is `None`.
fn report_refresh_failure(provider: &ProviderId, failure: Option<&CapabilityRefreshFailure>) {
    let is_probe = matches!(
        failure,
        Some(CapabilityRefreshFailure::Read(
            DriverError::CapabilityProbe(_)
        ))
    );
    let code = match failure {
        Some(CapabilityRefreshFailure::Read(DriverError::Refused(refusal))) => {
            Value::from(refusal.code.as_str())
        }
        Some(_) | None => Value::Null,
    };
    let (disposition_reason, message) = match failure {
        Some(failure) => (
            "capability read failed; reported, and read again on the next trigger",
            describe_error(failure),
        ),
        None => (
            "capability read missed the refresh deadline; canceled, and read again on the next \
             trigger",
            format!(
                "the read did not land within {} s",
                CAPABILITY_REFRESH_READ_TIMEOUT.as_secs()
            ),
        ),
    };
    let details = Map::from_iter([
        (
            "leg".to_owned(),
            Value::from(if is_probe {
                "capabilityProbe"
            } else {
                "capabilityRefresh"
            }),
        ),
        ("timedOut".to_owned(), Value::from(failure.is_none())),
        ("code".to_owned(), code),
        ("message".to_owned(), Value::from(message)),
    ]);
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: provider.clone(),
        provider_account_id: None,
        kind: DriverDiagnosticKind::CapabilityRefreshFailed,
        raw_wire_type: None,
        disposition_reason: disposition_reason.to_owned(),
        details,
    });
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use futures::FutureExt as _;
    use tokio::sync::Semaphore;

    use super::CapabilityRefresher;
    use crate::database::writer::test_file::TestDatabase;
    use crate::provider::driver::capabilities::writer::test_capabilities_writer;
    use crate::provider::driver::contract::{DriverError, MockProviderDriver, ProviderDriver};
    use crate::provider::driver::registry::ProviderRegistry;
    use crate::provider::driver::test_registry::test_driver_services;
    use crate::provider::driver::{DriverServices, PROVIDERS, ProviderRegistration};

    // A permit for each capability read the driver starts.
    static READS_STARTED: Semaphore = Semaphore::const_new(0);
    // A permit for each capability read the test lets finish.
    static READS_RELEASED: Semaphore = Semaphore::const_new(0);

    // How long a step the refresher owes may take before the test fails rather than hangs.
    const STEP_BOUND: Duration = Duration::from_secs(10);

    // A driver whose every capability read waits for the test's release, then fails.
    fn gated_driver(_services: &DriverServices) -> Arc<dyn ProviderDriver> {
        let mut driver = MockProviderDriver::new();
        driver.expect_get_capabilities().returning(|| {
            async {
                READS_STARTED.add_permits(1);
                READS_RELEASED
                    .acquire()
                    .await
                    .expect("the test never closes its release")
                    .forget();
                Err(DriverError::Internal("the test's read fails".into()))
            }
            .boxed()
        });
        Arc::new(driver)
    }

    async fn read_started() {
        tokio::time::timeout(STEP_BOUND, READS_STARTED.acquire())
            .await
            .expect("a capability read starts")
            .expect("the test never closes its count")
            .forget();
    }

    // Fails when a pass runs inside the caller that asked for it, so dropping that caller ends
    // the pass and the trigger marked meanwhile; when a trigger during a pass is not marked; when
    // the caller of that trigger returns before the pass after it has finished; or when the stop
    // waits for a pass under way, or leaves the task or a waiting caller behind. One test, since
    // the driver's gates are statics a second test would share.
    #[tokio::test]
    async fn a_dropped_caller_loses_no_trigger_a_queued_caller_waits_and_the_stop_ends_the_pass() {
        let services = test_driver_services();
        let table = [ProviderRegistration {
            descriptor: PROVIDERS[0],
            build: gated_driver,
        }];
        let database = TestDatabase::new();
        let (refresher, refreshing) = CapabilityRefresher::start(
            Arc::new(ProviderRegistry::register_from(&table, &services)),
            Arc::new(test_capabilities_writer(&database).await),
        );
        let refresher = Arc::new(refresher);

        let first_caller = tokio::spawn({
            let refresher = Arc::clone(&refresher);
            async move { refresher.refresh_now().await }
        });
        read_started().await;
        first_caller.abort();
        assert!(
            first_caller
                .await
                .expect_err("the first caller is dropped mid-pass")
                .is_cancelled()
        );
        let second_caller = refresher.refresh_now();
        tokio::pin!(second_caller);
        assert!(futures::poll!(&mut second_caller).is_pending());

        READS_RELEASED.add_permits(1);
        read_started().await;
        assert!(
            futures::poll!(&mut second_caller).is_pending(),
            "the second caller waits for the pass after its trigger"
        );
        READS_RELEASED.add_permits(1);

        let has_passed = tokio::time::timeout(STEP_BOUND, second_caller)
            .await
            .expect("the second caller returns after its pass");
        assert!(has_passed);

        // A stop during a pass whose read is never released.
        let stopped_caller = tokio::spawn({
            let refresher = Arc::clone(&refresher);
            async move { refresher.refresh_now().await }
        });
        read_started().await;
        tokio::time::timeout(STEP_BOUND, refreshing.stop())
            .await
            .expect("the stop drops the pass under way")
            .expect("the task ends");
        let has_stopped_caller_passed = tokio::time::timeout(STEP_BOUND, stopped_caller)
            .await
            .expect("the waiting caller returns at the stop")
            .expect("the caller's task ends");
        assert!(!has_stopped_caller_passed);
        assert!(
            !refresher.refresh_now().await,
            "no pass runs after the stop"
        );
    }
}
