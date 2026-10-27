//! What the run engine is handed to start a send's run with its admitted item, and to continue an
//! interrupted run on the next message its queue admits. A start and a continue share how the
//! run's turn reaches the driver.

use sidekicks_contracts::agent::definition::binding::ProviderToken;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::repo::mount::WorkspaceId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemSummary;

use sidekicks_provider::run::start_request::DriverStep;
use sidekicks_store::database::statement::WriteStatement;

/// What a run's start and its continue both take: the run, the workspace its send bound, the
/// posture requested, and the driver's start and interrupt of the run's turn.
pub struct RunTurnStart {
    /// The run.
    pub run_id: RunId,
    /// The workspace the send bound the run to; absent where none was named.
    pub workspace_id: Option<WorkspaceId>,
    /// The posture the run's turn was requested at; the posture gate checks it, and its resolved
    /// form is what the driver is handed and `agent.run.running` is stamped with.
    pub execution_posture: ExecutionPosture,
    /// Starts the run's turn on its provider at the resolved posture, once every setup gate has
    /// passed.
    pub start_driver: Box<dyn Fn(ExecutionPosture) -> DriverStep + Send + Sync>,
    /// Ends the turn `start_driver` started through the driver's interrupt, when the run's
    /// `running` write fails after it, so no turn runs on for a run that cannot record it.
    pub interrupt_driver: Box<dyn Fn() -> DriverStep + Send + Sync>,
}

/// What the engine's `start_run` needs beside the run's turn start: the item the queue admitted,
/// the provider the run runs on, the output speed it starts at, and the statements its `running`
/// write carries.
pub struct RunStartRequest {
    /// The run and how its turn reaches the driver.
    pub turn: RunTurnStart,
    /// The item that starts the run; absent on a turn the daemon or its provider starts on a
    /// session.
    pub queue_item: Option<QueueItemSummary>,
    /// The provider the run runs on; its settled output speed is read against this one's standard.
    pub provider: ProviderId,
    /// The output speed the run starts at, held until its provider reports the speed settled.
    pub output_speed: Option<ProviderToken>,
    /// Builds the statements that go in the run's `running` write, when it is written; a send's
    /// run carries none.
    pub running_statements: Option<Box<dyn FnOnce() -> Vec<WriteStatement> + Send>>,
}

/// What the engine's `continue_run` needs: the run's turn start and the item the queue admitted
/// to continue it, which a press of `Continue` with nothing waiting sends as the person's word. A
/// continue keeps the provider its run ran on.
pub struct RunContinueRequest {
    /// The run and how its next turn reaches the driver.
    pub turn: RunTurnStart,
    /// The item that continues the run.
    pub queue_item: QueueItemSummary,
}
