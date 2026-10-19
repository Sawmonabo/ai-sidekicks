//! The capability refresh: every registered driver's capabilities read again, declared through the
//! capabilities writer and recorded on the registry, once at the daemon's start and again on each
//! trigger (a provider command-path change, the person's `Check again`, a provider process start,
//! a stale model catalog), never on a timer.
//!
//! A trigger that arrives while a refresh runs is never lost: it asks for one more pass, and any
//! number of triggers during one pass ask for that one pass. Each driver's read and declare share
//! one deadline, and a read that misses it is canceled by dropping it, never left running: the
//! declare's lock is released, a write already handed to the database writer still commits whole,
//! and a handshake child the driver started with `kill_on_drop` ends with it.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use futures::future::join_all;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::id::ProviderId;

use crate::error_description::describe_error;
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
    /// The drivers read, and where each reading is recorded for the capability gate.
    providers: Arc<ProviderRegistry>,
    /// Where each reading is declared, so a cold start answers without asking the driver.
    writer: Arc<DriverCapabilitiesWriter>,
    /// Whether a pass runs and whether a trigger asked for one more.
    passes: Mutex<RefreshPasses>,
    /// Set once the daemon stops; no pass starts after it.
    is_shut_down: AtomicBool,
}

/// The refresh's pass state: at most one pass runs, and at most one more waits.
#[derive(Default)]
struct RefreshPasses {
    is_running: bool,
    is_asked_again: bool,
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
    /// A refresher over the registered drivers, declaring through `writer`.
    #[expect(
        dead_code,
        reason = "the daemon's start builds the one refresher every trigger asks"
    )]
    pub(crate) fn new(
        providers: Arc<ProviderRegistry>,
        writer: Arc<DriverCapabilitiesWriter>,
    ) -> Self {
        Self {
            providers,
            writer,
            passes: Mutex::new(RefreshPasses::default()),
            is_shut_down: AtomicBool::new(false),
        }
    }

    /// Reads every driver once, all at once, and returns when each read has landed, failed or
    /// missed its deadline; a failure is reported as a diagnostic, never returned. Asked while a
    /// pass runs, it marks one more pass for the running caller to make and returns at once.
    #[expect(
        dead_code,
        reason = "the daemon's start, `Check again`, a provider's start and a stale model catalog \
                  ask for a refresh through it"
    )]
    pub(crate) async fn refresh_now(&self) {
        {
            let mut passes = self.lock_passes();
            if passes.is_running {
                passes.is_asked_again = true;
                return;
            }
            passes.is_running = true;
        }
        // Clears the running mark however the passes end, a caller that stopped waiting included,
        // so a dropped refresh never blocks the next one.
        let _running = RunningPass(self);
        loop {
            if self.is_shut_down.load(Ordering::Acquire) {
                return;
            }
            join_all(
                self.providers
                    .providers()
                    .map(|provider| self.refresh_driver(provider)),
            )
            .await;
            let mut passes = self.lock_passes();
            if !passes.is_asked_again {
                return;
            }
            passes.is_asked_again = false;
        }
    }

    /// Stops the refresher: no pass starts after it, and a pass running ends after its reads.
    #[expect(dead_code, reason = "the daemon's stop ends the refresh through it")]
    pub(crate) fn shutdown(&self) {
        self.is_shut_down.store(true, Ordering::Release);
    }

    fn lock_passes(&self) -> std::sync::MutexGuard<'_, RefreshPasses> {
        // Two booleans hold no invariant a panicking holder could break.
        self.passes.lock().unwrap_or_else(PoisonError::into_inner)
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

/// Clears the refresher's running mark when the passes end.
struct RunningPass<'refresher>(&'refresher CapabilityRefresher);

impl Drop for RunningPass<'_> {
    fn drop(&mut self) {
        self.0.lock_passes().is_running = false;
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
