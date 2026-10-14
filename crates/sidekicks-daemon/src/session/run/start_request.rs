//! What the run engine is handed to start a run: a send's run with its admitted item, or a turn
//! the daemon or the provider starts on a session as the session's own run.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::name::ProviderName;
use sidekicks_contracts::repo::mount::WorkspaceId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemSummary;
use sidekicks_contracts::session::id::SessionId;

use crate::database::statement::WriteStatement;

/// What a driver's start or interrupt settles to: done, or why it failed.
type DriverStep = BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>>;

/// What the engine's `start_run` needs: the admitted item, the workspace the send bound, and how
/// the run reaches its provider.
pub(crate) struct RunStartRequest {
    /// The run.
    pub(crate) run_id: RunId,
    /// The item the run was admitted from.
    pub(crate) queue_item: QueueItemSummary,
    /// The workspace the send that started the run bound it to; absent where none was named.
    pub(crate) workspace_id: Option<WorkspaceId>,
    /// How the run starts on its provider; a send's run carries no running statements.
    pub(crate) start_path: RunStartPath,
}

/// What the engine's `start_daemon_turn` needs: the session whose own run the turn is, the
/// account its process was admitted against, the posture it runs at, and the driver's start of
/// the turn.
pub(crate) struct DaemonTurnStartRequest {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The provider the turn runs on.
    pub(crate) provider: ProviderName,
    /// The account the session's process was admitted against, or `None` for none.
    pub(crate) admitted_provider_account_id: Option<ProviderAccountId>,
    /// The session's current level and roots, which the turn runs at like any run.
    pub(crate) execution_posture: ExecutionPosture,
    /// Whether the provider started the turn itself: its run takes over, in its `running` write,
    /// the lead messages waiting for an interrupted run. A turn the daemon starts waits for the
    /// continue of an interrupted run the session holds its turn for.
    pub(crate) is_provider_started: bool,
    /// Whether the turn runs in a process of its own apart from the session's, such as a review a
    /// provider runs in a process of its own: it takes no turn of the session's process, so its
    /// run is no lead run and nothing the session's turn waits for holds it back.
    pub(crate) is_apart: bool,
    /// The driver's start of the turn under the new run's id: it binds the run and writes the
    /// turn's opening, and settles once it is written. A failure ends the run `failed`.
    pub(crate) start_turn: Box<dyn Fn(RunId) -> DriverStep + Send + Sync>,
    /// Ends the turn `start_turn` started under the run's id through the driver's interrupt, when
    /// the run's `running` write fails after it.
    pub(crate) interrupt_turn: Box<dyn Fn(RunId) -> DriverStep + Send + Sync>,
}

/// How one start reaches its driver: its provider, the posture requested, and the statements that
/// go in the run's `running` write, built when it is written.
pub(crate) struct RunStartPath {
    /// The provider the run runs on; its settled output speed is read against this one's standard.
    pub(crate) provider: ProviderName,
    /// The output speed the run starts at, held until its provider reports the speed settled.
    pub(crate) output_speed: Option<ProviderToken>,
    /// The posture the run was requested at; the posture gate checks it, and its resolved form is
    /// what the driver is handed and `run.running` is stamped with.
    pub(crate) execution_posture: ExecutionPosture,
    /// Starts the run on its provider at the resolved posture, once every setup gate has passed.
    pub(crate) start_driver: Box<dyn Fn(ExecutionPosture) -> DriverStep + Send + Sync>,
    /// Ends the provider's turn `start_driver` started through the driver's interrupt, when the
    /// run's `running` write fails after it, so no turn runs on for a run that cannot record it.
    pub(crate) interrupt_driver: Box<dyn Fn() -> DriverStep + Send + Sync>,
    /// Builds the statements that go in the run's `running` write, when it is written.
    pub(crate) running_statements: Option<Box<dyn FnOnce() -> Vec<WriteStatement> + Send>>,
}
