//! A run engine that hands every call to the recording one, holding a delivery or a daemon turn's
//! start until released.

use std::collections::VecDeque;
use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use tokio::sync::oneshot;

use crate::mutex_lock::lock;
use crate::provider::port::inbound_dispatch::InboundDispatch;
use crate::provider::port::run_host::test_host::{RecordingRunEngine, hold_next};
use crate::provider::port::run_host::{RunHost, RunHostError};
use crate::provider::run::delivery::{InboundDelivery, InboundOutcome};
use crate::provider::run::start_request::DaemonTurnStartRequest;
use crate::provider::run::turn_end::{ProviderTurnEnd, StartedTurn};
use crate::provider::runtime_binding::store::RuntimeBinding;

/// A run engine that hands every call to `inner`, holding the outcome of the next delivery, or the
/// start of the next daemon turn, until the sender its hold returned fires or drops, so the
/// session's task waits on it.
pub(crate) struct HeldDeliveryEngine {
    inner: Arc<RecordingRunEngine>,
    delivery_holds: Mutex<VecDeque<oneshot::Receiver<()>>>,
    daemon_turn_start_holds: Mutex<VecDeque<oneshot::Receiver<()>>>,
}

impl HeldDeliveryEngine {
    /// The engine over `inner`, holding nothing yet.
    pub(crate) fn new(inner: Arc<RecordingRunEngine>) -> Self {
        Self {
            inner,
            delivery_holds: Mutex::default(),
            daemon_turn_start_holds: Mutex::default(),
        }
    }

    /// Holds the next delivery's outcome until the returned sender fires or drops.
    pub(crate) fn hold_next_delivery(&self) -> oneshot::Sender<()> {
        hold_next(&self.delivery_holds)
    }

    /// Holds the next daemon turn's start, before `inner` opens its run, until the returned sender
    /// fires or drops.
    pub(crate) fn hold_next_daemon_turn_start(&self) -> oneshot::Sender<()> {
        hold_next(&self.daemon_turn_start_holds)
    }
}

impl InboundDispatch for HeldDeliveryEngine {
    fn dispatch<'dispatch>(
        &'dispatch self,
        delivery: InboundDelivery<'_>,
    ) -> BoxFuture<'dispatch, Result<InboundOutcome, Box<dyn Error + Send + Sync>>> {
        // Handed to `inner` now, so it is recorded in the order of the calls; only its outcome
        // waits for the hold.
        let dispatched = self.inner.dispatch(delivery);
        let hold = lock(&self.delivery_holds).pop_front();
        async move {
            if let Some(hold) = hold {
                hold.await.unwrap_or(());
            }
            dispatched.await
        }
        .boxed()
    }
}

impl RunHost for HeldDeliveryEngine {
    fn start_turn(
        &self,
        run_id: RunId,
        step_bound: Option<SafeInt<1>>,
    ) -> BoxFuture<'_, Result<Option<StartedTurn>, RunHostError>> {
        self.inner.start_turn(run_id, step_bound)
    }

    fn count_step(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunHostError>> {
        self.inner.count_step(run_id)
    }

    fn record_turn_end(
        &self,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> BoxFuture<'_, Result<bool, RunHostError>> {
        self.inner.record_turn_end(run_id, turn_end)
    }

    fn record_settled_output_speed(
        &self,
        session_id: SessionId,
        run_id: RunId,
        state: ProviderOutputSpeedState,
    ) -> BoxFuture<'_, Result<(), RunHostError>> {
        self.inner
            .record_settled_output_speed(session_id, run_id, state)
    }

    fn start_daemon_turn(
        &self,
        request: DaemonTurnStartRequest,
    ) -> BoxFuture<'_, Result<RunId, RunHostError>> {
        let hold = lock(&self.daemon_turn_start_holds).pop_front();
        async move {
            if let Some(hold) = hold {
                hold.await.unwrap_or(());
            }
            self.inner.start_daemon_turn(request).await
        }
        .boxed()
    }

    fn end_turn_on_process_exit(
        &self,
        run_id: RunId,
        process_exit: ProcessExit,
    ) -> BoxFuture<'_, Result<(), RunHostError>> {
        self.inner.end_turn_on_process_exit(run_id, process_exit)
    }

    fn end_turn_on_close(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunHostError>> {
        self.inner.end_turn_on_close(run_id)
    }

    fn read_session_leg(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<RuntimeBinding>, RunHostError>> {
        self.inner.read_session_leg(session_id)
    }
}
