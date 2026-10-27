//! The checks a run passes between admission and its provider's start, and the hooks that release
//! what they hold once the run ends.

use std::error::Error;
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::repo::mount::WorkspaceId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemSummary;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;

use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::events::session::append_lock::SessionAppendHold;

/// The run a setup gate checks. Its workspace is the session's own live one: the one the send
/// that started it named, else the session's newest.
#[derive(Clone, Debug)]
#[expect(
    dead_code,
    reason = "the workspace and queue setup gates, which read the run's session, item and workspace"
)]
pub(crate) struct RunSetupContext {
    /// The run.
    pub(crate) run_id: RunId,
    /// Its session.
    pub(crate) session_id: SessionId,
    /// The queue item the run was admitted from; absent for a turn the daemon started itself.
    pub(crate) queue_item: Option<QueueItemSummary>,
    /// The workspace the send that started the run bound it to; absent where none was named.
    pub(crate) workspace_id: Option<WorkspaceId>,
    /// The posture the run runs at: the one it was requested at, or a daemon turn's session's.
    pub(crate) execution_posture: ExecutionPosture,
}

/// How a run ended, handed to every terminal hook as the cause of what it releases.
#[derive(Clone, Debug)]
#[expect(
    dead_code,
    reason = "the terminal hooks that release what a run's setup gates took in its session"
)]
pub(crate) struct RunTerminalContext {
    /// The run.
    pub(crate) run_id: RunId,
    /// Its session.
    pub(crate) session_id: SessionId,
    /// The state it ended in, a terminal one or `interrupted` after a failed continue.
    pub(crate) terminal_state: RunState,
    /// The run version that ended.
    pub(crate) run_version: i64,
}

/// Why a gate refused a run or a terminal hook failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunSetupGateError {
    /// A refusal with its code, which the run's failure cause carries with its words.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// Any other failure, which the run's failure cause carries by its words alone.
    #[error(transparent)]
    Failed(Box<dyn Error + Send + Sync>),
}

/// The terminal hooks that failed once a run ended, with the run and the state it ended in.
#[derive(Debug, thiserror::Error)]
#[error(
    "a terminal hook failed after run {} ended {}",
    .run_id,
    <&'static str>::from(*.terminal_state)
)]
pub(crate) struct RunTerminalReleaseError {
    /// The run that ended.
    pub(crate) run_id: RunId,
    /// The state it ended in.
    pub(crate) terminal_state: RunState,
    /// Every hook that failed.
    #[source]
    pub(crate) failures: Box<SettleFailures<RunSetupGateError>>,
}

/// A check a run must pass in `starting` before its provider starts it. A failure from
/// `assert_run_ready` ends the run `failed` with that failure as its cause; `on_run_terminal` runs
/// once for each run version that ends, whatever ended it, and again for an interrupted run whose
/// continue failed after the gates ran, which leaves it at that end.
pub(crate) trait RunSetupGate: Send + Sync {
    /// Checks the run, failing when it may not start.
    fn assert_run_ready<'a>(
        &'a self,
        context: &'a RunSetupContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>>;

    /// Releases what the gate held for the run once it ended, appending under `hold` where the
    /// run's end was written under the caller's hold of its session; holds nothing by default.
    fn on_run_terminal<'a>(
        &'a self,
        _context: &'a RunTerminalContext,
        _hold: Option<&'a SessionAppendHold>,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        Box::pin(std::future::ready(Ok(())))
    }
}

/// The registered gates, in registration order; one entry per gate a feature registers at start.
#[derive(Default)]
pub(crate) struct RunSetupGates {
    /// The gates, in registration order.
    gates: Vec<Arc<dyn RunSetupGate>>,
}

impl RunSetupGates {
    /// Adds `gate` after every gate registered before it.
    pub(crate) fn register(&mut self, gate: Arc<dyn RunSetupGate>) {
        self.gates.push(gate);
    }

    /// Runs every gate in registration order; the first gate's failure stops the rest and is
    /// returned.
    pub(crate) async fn assert_run_ready(
        &self,
        context: &RunSetupContext,
    ) -> Result<(), RunSetupGateError> {
        for gate in &self.gates {
            gate.assert_run_ready(context).await?;
        }
        Ok(())
    }

    /// Runs every terminal hook in reverse registration order. A hook that fails does not stop the
    /// rest; once all have run, their failures return together, beside the run and how it ended.
    /// Each hook appends under `hold` where the caller holds the run's session.
    pub(crate) async fn release_for_terminal(
        &self,
        context: &RunTerminalContext,
        hold: Option<&SessionAppendHold>,
    ) -> Result<(), RunTerminalReleaseError> {
        let mut outcomes = Vec::with_capacity(self.gates.len());
        for gate in self.gates.iter().rev() {
            outcomes.push(gate.on_run_terminal(context, hold).await);
        }
        settle_all(
            outcomes,
            "releasing what a run's setup gates held once it ended",
        )
        .map(drop)
        .map_err(|failures| RunTerminalReleaseError {
            run_id: context.run_id,
            terminal_state: context.terminal_state,
            failures: Box::new(failures),
        })
    }
}
