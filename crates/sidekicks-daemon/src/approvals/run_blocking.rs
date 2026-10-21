//! A run waits for approval while it holds an open ask and runs again once it holds none, and its
//! end cancels the asks it left open.
//!
//! - The hold is level-triggered: each reconcile takes the run's lock, reads the run's open asks
//!   and moves the run to match, so reconciles that run out of order still end in the state the
//!   newest asks call for. Every write that changes a run's open asks spawns one after it commits.
//! - A run not in a state that may move is left as it is. One that reports `running` again, from
//!   a wait for input, a pause or a continue, is reconciled then, since a follower of every session
//!   hears each `agent.run.running`.
//! - A reconcile runs on a tracked task, never on the caller's: a move waits for a starting run's
//!   start, and a provider that hands an ask while it starts would otherwise wait on itself.
//! - A failed move is logged and leaves every recorded ask standing; the card stays the one gate.

use std::collections::HashSet;
use std::error::Error;
use std::sync::{Arc, Weak};

use futures::future::BoxFuture;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use tokio::task::{JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use crate::approvals::permission_asks::PermissionAsks;
use crate::approvals::service::ApprovalService;
use crate::approvals::store::ApprovalRequestReader;
use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool, ReadLength};
use crate::events::session::followers::{FollowerAttachment, SessionEventFollowers};
use crate::events::session::pending::PendingSessions;
use crate::keyed_lock::KeyedLock;
use crate::session::run::engine::{RunEngine, RunEngineError};
use crate::session::run::refusals::RunRefusal;
use crate::session::run::setup_gates::{
    RunSetupContext, RunSetupGate, RunSetupGateError, RunTerminalContext,
};
use crate::session::run::state_change::{RunStateChange, RunStateEntry};

/// Why a run's hold was not reconciled; the run keeps the state it had.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunHoldError {
    /// SQLite refused the read of the run's open asks.
    #[error("a read of the run's open approval requests failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the read.
    #[error(transparent)]
    Pool(#[from] DatabaseReadError),
    /// The run engine failed the move for a reason other than the run's state.
    #[error("the run's approval hold was not moved")]
    Move(#[source] RunEngineError),
}

/// Moves each run to match its open asks: held in `waitingForApproval` while it has one, released
/// to `running` once it has none. Shared by `Arc`.
pub(crate) struct ApprovalRunHolds {
    /// The engine that moves runs; weak, since the engine holds the run-end gate that holds this.
    engine: Weak<RunEngine>,
    /// Where a run's open asks are read.
    reads: Arc<DatabaseReadPool>,
    /// One reconcile of a run at a time.
    run_locks: KeyedLock<RunId>,
    /// The reconciles under way.
    reconciles: TaskTracker,
    /// Sessions a run of reported `running` in, whose runs with open asks the task reconciles.
    running_sessions: PendingSessions,
}

impl ApprovalRunHolds {
    /// Holds moving runs through `engine`, reading open asks through `reads`; nothing is followed
    /// until [`ApprovalRunHolds::start`].
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start builds the run holds beside the run engine"
        )
    )]
    pub(crate) fn new(engine: Weak<RunEngine>, reads: Arc<DatabaseReadPool>) -> Self {
        Self {
            engine,
            reads,
            run_locks: KeyedLock::new(),
            reconciles: TaskTracker::new(),
            running_sessions: PendingSessions::default(),
        }
    }

    /// Reconciles the run's hold on a tracked task; a failure is logged, since no caller waits.
    pub(crate) fn spawn_reconcile(self: &Arc<Self>, run_id: RunId) {
        let holds = Arc::clone(self);
        self.reconciles.spawn(async move {
            if let Err(error) = holds.reconcile(run_id).await {
                tracing::warn!(
                    %run_id,
                    error = &error as &(dyn Error + 'static),
                    "approval_run_hold_failed"
                );
            }
        });
    }

    /// Moves the run to match its open asks as they read now: into `waitingForApproval` with one
    /// open, back to `running` from `waitingForApproval` with none. A run whose state does not
    /// allow the move, or whose engine is gone with the daemon's stop, is left as it is. Fails as
    /// the read fails and as the engine fails the move otherwise.
    pub(crate) async fn reconcile(&self, run_id: RunId) -> Result<(), RunHoldError> {
        let _run_hold = self.run_locks.acquire(run_id).await;
        let Some(engine) = self.engine.upgrade() else {
            return Ok(());
        };
        let open_asks = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, RunHoldError>(
                    ApprovalRequestReader::new(connection).list_pending_for_run(&run_id)?,
                )
            })
            .await?;
        let change = if open_asks.is_empty() {
            RunStateChange {
                expected_state: Some(RunState::WaitingForApproval),
                ..RunStateChange::new(
                    run_id,
                    RunStateEntry::Running {
                        execution_posture: None,
                    },
                )
            }
        } else {
            RunStateChange::new(run_id, RunStateEntry::WaitingForApproval)
        };
        match engine.apply_provider_state_change(change, None).await {
            Ok(written) => {
                written.log_resend_failure(run_id);
                Ok(())
            }
            Err(RunEngineError::Refused(RunRefusal::InvalidTransition { .. })) => Ok(()),
            Err(failure) => Err(RunHoldError::Move(failure)),
        }
    }

    /// Follows `followers` to reconcile, whenever a run of a session reports `running`, each run
    /// of that session holding an open ask, until the returned handle's stop.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's start follows the runs it holds")
    )]
    pub(crate) fn start(
        self: &Arc<Self>,
        followers: &Arc<SessionEventFollowers>,
    ) -> RunHoldFollowing {
        let holds = Arc::clone(self);
        // Runs on the writer's pump, so it only names the session for the task.
        let attachment = followers.follow_all(move |event| {
            if event.envelope.event_type() == SessionEventType::AgentRunRunning {
                holds.running_sessions.add(event.envelope.session_id());
            }
            Ok(())
        });
        let stop = CancellationToken::new();
        let task = tokio::spawn(reconcile_running_sessions_until_stopped(
            Arc::clone(self),
            stop.clone(),
        ));
        RunHoldFollowing {
            attachment,
            stop,
            task,
            reconciles: self.reconciles.clone(),
        }
    }

    // Reconciles each run of the session that holds an open ask.
    async fn reconcile_session(
        self: &Arc<Self>,
        session_id: SessionId,
    ) -> Result<(), RunHoldError> {
        let open_asks = self
            .reads
            .read(ReadLength::Short, move |connection| {
                Ok::<_, RunHoldError>(
                    ApprovalRequestReader::new(connection).list_pending_for_session(&session_id)?,
                )
            })
            .await?;
        let runs: HashSet<RunId> = open_asks.iter().map(|request| request.run_id).collect();
        for run_id in runs {
            self.spawn_reconcile(run_id);
        }
        Ok(())
    }
}

/// The follower of runs reporting `running` and its task, from [`ApprovalRunHolds::start`] until
/// [`RunHoldFollowing::stop`].
pub(crate) struct RunHoldFollowing {
    /// Hears every committed `agent.run.running`; dropping it detaches.
    attachment: FollowerAttachment,
    /// Ends the task after the session under way.
    stop: CancellationToken,
    /// The task that reconciles the sessions' runs.
    task: JoinHandle<()>,
    /// Every reconcile spawned, waited for at the stop.
    reconciles: TaskTracker,
}

impl RunHoldFollowing {
    /// Stops hearing runs and settles once every reconcile under way is done. Fails only when the
    /// task itself ended abnormally.
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "the daemon's stop ends the run holds")
    )]
    pub(crate) async fn stop(self) -> Result<(), JoinError> {
        let Self {
            attachment,
            stop,
            task,
            reconciles,
        } = self;
        drop(attachment);
        stop.cancel();
        let ended = task.await;
        reconciles.close();
        reconciles.wait().await;
        ended
    }
}

// No caller waits on a reconcile, so a failed read is logged; the run's next `running` or its next
// ask reconciles it again.
async fn reconcile_running_sessions_until_stopped(
    holds: Arc<ApprovalRunHolds>,
    stop: CancellationToken,
) {
    loop {
        let running = tokio::select! {
            biased;
            () = stop.cancelled() => return,
            running = holds.running_sessions.take() => running,
        };
        for session_id in running {
            if let Err(error) = holds.reconcile_session(session_id).await {
                tracing::warn!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "approval_run_holds_read_failed"
                );
            }
        }
    }
}

/// The run setup gate whose terminal hook cancels the asks a run left open: it passes every run,
/// and once a run ends it lets go of the run's provider asks, cancels its pending cards and
/// settles every wait on them, whatever the cancels returned.
pub(crate) struct ApprovalRunEnd {
    /// The service whose asks the run's end cancels.
    service: Arc<ApprovalService>,
    /// The provider asks the run's end lets go of.
    permission_asks: Arc<PermissionAsks>,
}

impl ApprovalRunEnd {
    /// The gate letting go of a run's provider asks in `permission_asks` and canceling its cards
    /// through `service`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start registers the run-end gate with the run engine"
        )
    )]
    pub(crate) fn new(service: Arc<ApprovalService>, permission_asks: Arc<PermissionAsks>) -> Self {
        Self {
            service,
            permission_asks,
        }
    }
}

impl RunSetupGate for ApprovalRunEnd {
    fn assert_run_ready<'a>(
        &'a self,
        _context: &'a RunSetupContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        Box::pin(std::future::ready(Ok(())))
    }

    fn on_run_terminal<'a>(
        &'a self,
        context: &'a RunTerminalContext,
    ) -> BoxFuture<'a, Result<(), RunSetupGateError>> {
        Box::pin(async move {
            self.permission_asks.forget_run(context.run_id);
            self.service
                .cancel_pending_for_run(context.run_id, None)
                .await
                .map_err(|failures| RunSetupGateError::Failed(Box::new(failures)))
        })
    }
}

#[cfg(test)]
mod tests;
