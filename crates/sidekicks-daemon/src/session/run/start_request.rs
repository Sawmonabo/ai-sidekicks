//! What the run engine is handed to start a run: a send's run with its admitted item, or a turn
//! the daemon or the provider starts on a session as the session's own run; and to continue an
//! interrupted run on the next message its queue admits. A start and a continue share how the
//! run's turn reaches the driver.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::repo::mount::WorkspaceId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemSummary;
use sidekicks_contracts::session::id::SessionId;

use crate::database::statement::WriteStatement;

/// What a driver's start or interrupt settles to: done, or why it failed.
pub(crate) type DriverStep = BoxFuture<'static, Result<(), Box<dyn Error + Send + Sync>>>;

/// What a run's start and its continue both take: the run, the workspace its send bound, the
/// posture requested, and the driver's start and interrupt of the run's turn.
pub(crate) struct RunTurnStart {
    /// The run.
    pub(crate) run_id: RunId,
    /// The workspace the send bound the run to; absent where none was named.
    pub(crate) workspace_id: Option<WorkspaceId>,
    /// The posture the run's turn was requested at; the posture gate checks it, and its resolved
    /// form is what the driver is handed and `agent.run.running` is stamped with.
    pub(crate) execution_posture: ExecutionPosture,
    /// Starts the run's turn on its provider at the resolved posture, once every setup gate has
    /// passed.
    pub(crate) start_driver: Box<dyn Fn(ExecutionPosture) -> DriverStep + Send + Sync>,
    /// Ends the turn `start_driver` started through the driver's interrupt, when the run's
    /// `running` write fails after it, so no turn runs on for a run that cannot record it.
    pub(crate) interrupt_driver: Box<dyn Fn() -> DriverStep + Send + Sync>,
}

/// What the engine's `start_run` needs beside the run's turn start: the item the queue admitted,
/// the provider the run runs on, the output speed it starts at, and the statements its `running`
/// write carries.
pub(crate) struct RunStartRequest {
    /// The run and how its turn reaches the driver.
    pub(crate) turn: RunTurnStart,
    /// The item that starts the run; absent on a turn the daemon or its provider starts on a
    /// session.
    pub(crate) queue_item: Option<QueueItemSummary>,
    /// The provider the run runs on; its settled output speed is read against this one's standard.
    pub(crate) provider: ProviderId,
    /// The output speed the run starts at, held until its provider reports the speed settled.
    pub(crate) output_speed: Option<ProviderToken>,
    /// Builds the statements that go in the run's `running` write, when it is written; a send's
    /// run carries none.
    pub(crate) running_statements: Option<Box<dyn FnOnce() -> Vec<WriteStatement> + Send>>,
}

/// What the engine's `continue_run` needs: the run's turn start and the item the queue admitted
/// to continue it, which a press of `Continue` with nothing waiting sends as the person's word. A
/// continue keeps the provider its run ran on.
pub(crate) struct RunContinueRequest {
    /// The run and how its next turn reaches the driver.
    pub(crate) turn: RunTurnStart,
    /// The item that continues the run.
    pub(crate) queue_item: QueueItemSummary,
}

/// What the engine's `start_daemon_turn` needs: the session whose own run the turn is, the
/// account its process was admitted against, the posture it runs at, and the driver's start of
/// the turn.
pub(crate) struct DaemonTurnStartRequest {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The provider the turn runs on.
    pub(crate) provider: ProviderId,
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
