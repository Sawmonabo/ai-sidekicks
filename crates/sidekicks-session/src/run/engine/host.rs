//! The run engine as the drivers' run host: each call a driver makes through its port, its
//! failure handed over whole, and the stored leg a driver reads read through the engine's pool.

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_provider::port::run_host::{RunHost, RunHostError};
use sidekicks_provider::run::start_request::DaemonTurnStartRequest;
use sidekicks_provider::run::turn_end::{ProviderTurnEnd, StartedTurn};
use sidekicks_provider::runtime_binding::store::RuntimeBinding;

use crate::run::engine::RunEngine;
use crate::run::stored_leg::read_session_leg;

impl RunHost for RunEngine {
    fn start_turn(
        &self,
        run_id: RunId,
        step_bound: Option<SafeInt<1>>,
    ) -> BoxFuture<'_, Result<Option<StartedTurn>, RunHostError>> {
        async move { Ok(RunEngine::start_turn(self, run_id, None, step_bound).await?) }.boxed()
    }

    fn count_step(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunHostError>> {
        let engine = self.shared();
        async move { Ok(engine.count_step(run_id).await?) }.boxed()
    }

    fn record_turn_end(
        &self,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> BoxFuture<'_, Result<bool, RunHostError>> {
        let engine = self.shared();
        async move {
            let written = engine.record_turn_end(run_id, turn_end).await?;
            Ok(written.log_resend_failure(run_id))
        }
        .boxed()
    }

    fn record_settled_output_speed(
        &self,
        session_id: SessionId,
        run_id: RunId,
        state: ProviderOutputSpeedState,
    ) -> BoxFuture<'_, Result<(), RunHostError>> {
        async move {
            Ok(RunEngine::record_settled_output_speed(self, session_id, run_id, &state).await?)
        }
        .boxed()
    }

    fn start_daemon_turn(
        &self,
        request: DaemonTurnStartRequest,
    ) -> BoxFuture<'_, Result<RunId, RunHostError>> {
        async move { Ok(RunEngine::start_daemon_turn(self, request).await?) }.boxed()
    }

    fn end_turn_on_process_exit(
        &self,
        run_id: RunId,
        process_exit: ProcessExit,
    ) -> BoxFuture<'_, Result<(), RunHostError>> {
        async move { Ok(RunEngine::end_turn_on_process_exit(self, run_id, process_exit).await?) }
            .boxed()
    }

    fn end_turn_on_close(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunHostError>> {
        async move { Ok(RunEngine::end_turn_on_close(self, run_id).await?) }.boxed()
    }

    fn read_session_leg(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<RuntimeBinding>, RunHostError>> {
        async move { Ok(read_session_leg(&self.pool, session_id).await?) }.boxed()
    }
}
