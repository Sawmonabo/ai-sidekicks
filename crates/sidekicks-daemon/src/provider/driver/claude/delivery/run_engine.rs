//! The run engine as the Claude Code driver reaches it: each delivery handed to the inbound
//! dispatch at once, a turn opened and numbered, a step counted, a turn's end that moves no run,
//! a settled output speed, and a turn the daemon starts itself.

use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::provider::driver::claude::DESCRIPTOR;
use crate::provider::driver::delivery_dispatch::{DeliveryOrigin, dispatch_delivery};
use crate::session::run::engine::turns::{ProviderTurnEnd, StartedTurn};
use crate::session::run::engine::{RunEngine, RunEngineError};
use crate::session::run::inbound::{InboundDelivery, InboundOutcome, RunInboundDispatch};
use crate::session::run::start_request::DaemonTurnStartRequest;

/// What the Claude Code driver asks of the run engine.
pub(crate) trait ClaudeRunEngine: Send + Sync {
    /// Hands `delivery` to the inbound dispatch now, before the returned future is first polled,
    /// so deliveries keep the order of the calls; answers its outcome, `None` once a refusal is
    /// logged. `raw_wire_type` is the frame it came from, `None` for the driver's own.
    fn deliver<'engine>(
        &'engine self,
        provider_account_id: Option<ProviderAccountId>,
        raw_wire_type: Option<&str>,
        delivery: InboundDelivery<'_>,
    ) -> BoxFuture<'engine, Option<InboundOutcome>>;

    /// Opens and numbers `run_id`'s next turn against `step_bound`; `None` once the run ended.
    fn start_turn(
        &self,
        run_id: RunId,
        step_bound: Option<SafeInt<1>>,
    ) -> BoxFuture<'_, Result<Option<StartedTurn>, RunEngineError>>;

    /// Counts one step of `run_id`'s open turn.
    fn count_step(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunEngineError>>;

    /// Ends a turn whose end moves no run; answers whether the end was written.
    fn record_turn_end(
        &self,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> BoxFuture<'_, Result<bool, RunEngineError>>;

    /// Records the output speed `run_id`'s process settled at.
    fn record_settled_output_speed(
        &self,
        session_id: SessionId,
        run_id: RunId,
        state: ProviderOutputSpeedState,
    ) -> BoxFuture<'_, Result<(), RunEngineError>>;

    /// Starts a turn the daemon or Claude Code starts on a session itself, as its own run.
    fn start_daemon_turn(
        &self,
        request: DaemonTurnStartRequest,
    ) -> BoxFuture<'_, Result<RunId, RunEngineError>>;

    /// Ends `run_id`'s turn, and the helpers beneath it, on the exit of the process that ran it.
    fn end_turn_on_process_exit(
        &self,
        run_id: RunId,
        process_exit: ProcessExit,
    ) -> BoxFuture<'_, Result<(), RunEngineError>>;
}

/// The daemon's run engine and its inbound dispatch.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the Claude driver's composition builds it over the daemon's run engine"
    )
)]
pub(crate) struct RunEngineDelivery {
    engine: Arc<RunEngine>,
    dispatch: Arc<RunInboundDispatch>,
}

impl RunEngineDelivery {
    /// The engine and the dispatch every delivery takes.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's composition builds it over the daemon's run engine"
        )
    )]
    pub(crate) fn new(engine: Arc<RunEngine>, dispatch: Arc<RunInboundDispatch>) -> Self {
        Self { engine, dispatch }
    }
}

impl ClaudeRunEngine for RunEngineDelivery {
    fn deliver<'engine>(
        &'engine self,
        provider_account_id: Option<ProviderAccountId>,
        raw_wire_type: Option<&str>,
        delivery: InboundDelivery<'_>,
    ) -> BoxFuture<'engine, Option<InboundOutcome>> {
        let origin = DeliveryOrigin {
            provider: DESCRIPTOR.provider_id(),
            provider_account_id,
            raw_wire_type,
        };
        dispatch_delivery(&self.dispatch, origin, delivery).boxed()
    }

    fn start_turn(
        &self,
        run_id: RunId,
        step_bound: Option<SafeInt<1>>,
    ) -> BoxFuture<'_, Result<Option<StartedTurn>, RunEngineError>> {
        self.engine.start_turn(run_id, None, step_bound).boxed()
    }

    fn count_step(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunEngineError>> {
        async move { self.engine.count_step(run_id).await }.boxed()
    }

    fn record_turn_end(
        &self,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> BoxFuture<'_, Result<bool, RunEngineError>> {
        async move {
            let written = self.engine.record_turn_end(run_id, turn_end).await?;
            Ok(written.log_resend_failure(run_id))
        }
        .boxed()
    }

    fn record_settled_output_speed(
        &self,
        session_id: SessionId,
        run_id: RunId,
        state: ProviderOutputSpeedState,
    ) -> BoxFuture<'_, Result<(), RunEngineError>> {
        async move {
            self.engine
                .record_settled_output_speed(session_id, run_id, &state)
                .await
        }
        .boxed()
    }

    fn start_daemon_turn(
        &self,
        request: DaemonTurnStartRequest,
    ) -> BoxFuture<'_, Result<RunId, RunEngineError>> {
        self.engine.start_daemon_turn(request).boxed()
    }

    fn end_turn_on_process_exit(
        &self,
        run_id: RunId,
        process_exit: ProcessExit,
    ) -> BoxFuture<'_, Result<(), RunEngineError>> {
        self.engine
            .end_turn_on_process_exit(run_id, process_exit)
            .boxed()
    }
}
