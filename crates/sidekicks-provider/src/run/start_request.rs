//! A turn the daemon or its provider starts on a session as the session's own run, as a driver
//! asks the run engine to start it, and the driver's step a start or an interrupt settles to.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

/// What a driver's start or interrupt settles to: done, or why it failed.
pub type DriverStep = BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>>;

/// What the engine's `start_daemon_turn` needs: the session whose own run the turn is, the
/// account its process was admitted against, the posture it runs at, and the driver's start of
/// the turn.
pub struct DaemonTurnStartRequest {
    /// The session.
    pub session_id: SessionId,
    /// The provider the turn runs on.
    pub provider: ProviderId,
    /// The account the session's process was admitted against, or `None` for none.
    pub admitted_provider_account_id: Option<ProviderAccountId>,
    /// The session's current level and roots, which the turn runs at like any run.
    pub execution_posture: ExecutionPosture,
    /// Whether the provider started the turn itself: its run takes over, in its `running` write,
    /// the lead messages waiting for an interrupted run. A turn the daemon starts waits for the
    /// continue of an interrupted run the session holds its turn for.
    pub is_provider_started: bool,
    /// Whether the turn runs in a process of its own apart from the session's, such as a review a
    /// provider runs in a process of its own: it takes no turn of the session's process, so its
    /// run is no lead run and nothing the session's turn waits for holds it back.
    pub is_apart: bool,
    /// The driver's start of the turn under the new run's id: it binds the run and writes the
    /// turn's opening, and settles once it is written. A failure ends the run `failed`.
    pub start_turn: Box<dyn Fn(RunId) -> DriverStep + Send + Sync>,
    /// Ends the turn `start_turn` started under the run's id through the driver's interrupt, when
    /// the run's `running` write fails after it.
    pub interrupt_turn: Box<dyn Fn(RunId) -> DriverStep + Send + Sync>,
}
