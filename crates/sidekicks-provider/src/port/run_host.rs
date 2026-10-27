//! The run engine as a driver reaches it: a turn opened and numbered, a step counted, a turn's end
//! that moves no run, a settled output speed, a turn the daemon or its provider starts on a session
//! itself, the turns a process left as it exited or its session closed, and a session's stored
//! leg.

#[cfg(test)]
pub(crate) mod test_host;

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::run::control::ProcessExit;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::run::start_request::DaemonTurnStartRequest;
use crate::run::turn_end::{ProviderTurnEnd, StartedTurn};
use crate::runtime_binding::store::RuntimeBinding;

/// A failure the run engine reports to a driver, kept whole.
pub(crate) type RunHostError = Box<dyn Error + Send + Sync>;

/// What a driver asks of the run engine; the daemon's start registers the engine as it.
pub(crate) trait RunHost: Send + Sync {
    /// Opens and numbers `run_id`'s next turn, its steps counted against `step_bound`; `None`
    /// once the run ended. Fails as the turn's start is not written.
    fn start_turn(
        &self,
        run_id: RunId,
        step_bound: Option<SafeInt<1>>,
    ) -> BoxFuture<'_, Result<Option<StartedTurn>, RunHostError>>;

    /// Counts one step of `run_id`'s open turn, stopping the run at its step limit. Fails as the
    /// limit's stop fails.
    fn count_step(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunHostError>>;

    /// Ends a turn whose end moves no run; answers whether the end was written. A limit's
    /// interrupt the end hands again and fails is logged, never failed.
    fn record_turn_end(
        &self,
        run_id: RunId,
        turn_end: ProviderTurnEnd,
    ) -> BoxFuture<'_, Result<bool, RunHostError>>;

    /// Records the output speed `run_id`'s process settled at. Fails as its write fails.
    fn record_settled_output_speed(
        &self,
        session_id: SessionId,
        run_id: RunId,
        state: ProviderOutputSpeedState,
    ) -> BoxFuture<'_, Result<(), RunHostError>>;

    /// Starts a turn the daemon or its provider starts on a session itself, as the session's own
    /// run, and answers the run. Fails as the run's start or the driver's start of its turn fails.
    fn start_daemon_turn(
        &self,
        request: DaemonTurnStartRequest,
    ) -> BoxFuture<'_, Result<RunId, RunHostError>>;

    /// Ends `run_id`'s turn, and the helpers beneath it, on the exit of the process that ran it.
    fn end_turn_on_process_exit(
        &self,
        run_id: RunId,
        process_exit: ProcessExit,
    ) -> BoxFuture<'_, Result<(), RunHostError>>;

    /// Ends `run_id`'s turn, and the helpers beneath it, as the daemon closed its session.
    fn end_turn_on_close(&self, run_id: RunId) -> BoxFuture<'_, Result<(), RunHostError>>;

    /// `session_id`'s stored leg, its newest binding with a conversation to resume, at rest as
    /// live; `None` for a session that never ran. Fails as its read fails.
    fn read_session_leg(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<RuntimeBinding>, RunHostError>>;
}
