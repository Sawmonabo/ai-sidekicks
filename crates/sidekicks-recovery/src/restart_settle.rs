//! What a restart left in one session, settled in an order no later step undoes: the faster-model
//! retries still pending, before the run ends that would expire an accepted one; the runs still
//! live, failed as no provider session came back; the open turns of runs that had already ended,
//! before their unresolved interventions, whose expiry would drop the limit a turn ends with; then
//! the asks, the choices and the held plans those ended runs left open. Every read is of the one
//! session and taken after its rebuild; every write is guarded on the rows it read. The recovery
//! pass settles each session it finds so, and `Continue from here` settles a damaged one.

use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_approval::service::{ApprovalService, ApprovalServiceError};
use sidekicks_approval::store::ApprovalRequestReader;
use sidekicks_artifact::plans::service::{PlanError, PlansService};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_session::interventions::store::{read_pending_retries, settle_retry_after_restart};
use sidekicks_session::run::engine::{RunEngine, RunEngineError};
use sidekicks_session::run::provider_choice::run_end::{
    read_ended_runs_with_open_choices, settle_open_choices_of_ended_run,
};
use sidekicks_session::run::read::{RunStateReader, SessionRun};
use sidekicks_session::run::state_change::refused_statement_index;
use sidekicks_std::settle_all::SettleFailures;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraftError, SessionEventLinkage,
};
use tokio_util::sync::CancellationToken;

/// The provider failure detail a run the restart left live ends `failed` with.
pub(crate) const RESTART_FAILURE_DETAIL: &str =
    "The service restarted and no provider session was restored";

/// The statements the settle's own reads run: the one-session listings of its live runs, its
/// pending retries, and its ended runs with an open turn, with a pending ask and with an open
/// choice, and an ended run's choice settle (its row, the newest request of each dialog and whether
/// it was settled since).
pub const RESTART_SETTLE_STATEMENT_CAPACITY: usize = 8;

/// What the restart settle reads and writes through.
pub struct RestartSettleDeps {
    /// The reads of what the restart left.
    pub reads: Arc<DatabaseReadPool>,
    /// The appends of the retries' and the choices' settlements.
    pub appender: Arc<SessionEventAppender>,
    /// The runs' ends and their open turns and interventions.
    pub run_engine: Arc<RunEngine>,
    /// The cancels of the asks an ended run left pending.
    pub approvals: Arc<ApprovalService>,
    /// The reopening of the plans a restart's lost requests held.
    pub plans: Arc<PlansService>,
}

/// Settles what a restart left in one session.
pub struct RestartSettle {
    deps: RestartSettleDeps,
}

/// The runs a settle ended, by the state it ended them in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RestartTally {
    /// The runs ended `failed`.
    pub(crate) failed: u64,
    /// The runs ended `interrupted`: under a pending interrupt, or at a step or spend limit.
    pub(crate) interrupted: u64,
    /// The runs ended `stopped` at a token limit their log still owed.
    pub(crate) stopped: u64,
}

/// Why a restart settle stopped short; what it wrote before is kept, and a later settle takes up
/// what it left.
#[derive(Debug, thiserror::Error)]
pub enum RestartSettleError {
    /// A read of what the restart left failed.
    #[error("what the restart left could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool failed the read.
    #[error("what the restart left could not be read")]
    Pool(#[from] DatabaseReadError),
    /// A pending retry's settlement broke a check of its event.
    #[error("a pending retry's settlement could not be drafted")]
    RetryDraft(#[from] SessionEventDraftError),
    /// A pending retry's settlement was not written.
    #[error("a pending retry's settlement was not written")]
    Retry(#[from] SessionEventAppendError),
    /// The service's stop came before a step; what the steps before it wrote is kept, and the next
    /// start settles the rest.
    #[error("the service's stop came before the session was settled")]
    Stopped,
    /// A run, its turns, its interventions or its choices could not be settled.
    #[error("a run the restart left could not be settled")]
    Run(#[from] RunEngineError),
    /// An ended run's pending asks could not be canceled.
    #[error("an ended run's pending asks could not be canceled")]
    Approvals(#[from] SettleFailures<ApprovalServiceError>),
    /// A held plan could not be reopened.
    #[error("a plan a lost request held could not be reopened")]
    Plans(#[from] PlanError),
}

impl RestartSettle {
    /// A settle over `deps`.
    pub fn new(deps: RestartSettleDeps) -> Self {
        Self { deps }
    }

    /// Settles `session_id`'s pending faster-model retries, then ends each run of it still live as
    /// [`RunEngine::settle_run_after_restart`] decides, writing under `hold` where the caller holds
    /// the session's appends and reading `stop`, where the caller has one, before each step;
    /// answers the tally of the runs it ended and their ids. Fails at the first read or write that
    /// fails, or with `Stopped`.
    pub(crate) async fn settle_live(
        &self,
        session_id: SessionId,
        hold: Option<&SessionAppendHold>,
        stop: Option<&CancellationToken>,
    ) -> Result<(RestartTally, Vec<RunId>), RestartSettleError> {
        check_stop(stop)?;
        self.settle_pending_retries(session_id, hold).await?;
        check_stop(stop)?;
        let live_runs = self
            .read(move |reader| RunStateReader::new(reader).list_live_runs(Some(&session_id)))
            .await?;
        let mut tally = RestartTally::default();
        let mut ended_run_ids = Vec::new();
        for live_run in &live_runs {
            check_stop(stop)?;
            let settled = self
                .deps
                .run_engine
                .settle_run_after_restart(live_run, RESTART_FAILURE_DETAIL, hold)
                .await?;
            match settled.state {
                RunState::Failed => tally.failed += 1,
                RunState::Interrupted => tally.interrupted += 1,
                RunState::Stopped => tally.stopped += 1,
                // A run the settle left, as it read it or as it moved since.
                RunState::Queued
                | RunState::Starting
                | RunState::Running
                | RunState::WaitingForApproval
                | RunState::WaitingForInput
                | RunState::Pausing
                | RunState::Paused
                | RunState::Completed => continue,
            }
            ended_run_ids.push(live_run.run_id);
        }
        Ok((tally, ended_run_ids))
    }

    /// Settles what `session_id`'s runs that had ended left open: their open turns, then their
    /// interventions with no outcome, their pending asks, their unsettled choices and the plans a
    /// lost request held, reading `stop`, where the caller has one, before each step. Fails at the
    /// first step that fails, or with `Stopped`.
    pub(crate) async fn settle_ended(
        &self,
        session_id: SessionId,
        stop: Option<&CancellationToken>,
    ) -> Result<(), RestartSettleError> {
        let engine = &self.deps.run_engine;
        check_stop(stop)?;
        let with_open_turns = self
            .read(move |reader| {
                RunStateReader::new(reader).list_ended_runs_with_open_turns(Some(&session_id))
            })
            .await?;
        engine
            .end_open_turns_of_ended_runs(&run_ids(&with_open_turns))
            .await?;
        check_stop(stop)?;
        engine.settle_unresolved_of_ended_runs(session_id).await?;
        check_stop(stop)?;
        let with_pending_asks = self
            .read(move |reader| {
                ApprovalRequestReader::new(reader).list_ended_runs_with_pending(Some(&session_id))
            })
            .await?;
        for run in with_pending_asks {
            self.deps
                .approvals
                .cancel_pending_for_run(run.run_id, None)
                .await?;
        }
        check_stop(stop)?;
        let with_open_choices = self
            .read(move |reader| read_ended_runs_with_open_choices(reader, Some(&session_id)))
            .await?;
        for run in with_open_choices {
            settle_open_choices_of_ended_run(&self.deps.reads, &self.deps.appender, run.run_id)
                .await?;
        }
        check_stop(stop)?;
        self.deps
            .plans
            .end_holds_lost_at_restart(session_id)
            .await?;
        Ok(())
    }

    // Each pending retry's settlement in one write of its own; a retry that moved since its read
    // refuses the write and is left as it now is.
    async fn settle_pending_retries(
        &self,
        session_id: SessionId,
        hold: Option<&SessionAppendHold>,
    ) -> Result<(), RestartSettleError> {
        let retries = self
            .read(move |reader| read_pending_retries(reader, Some(&session_id)))
            .await?;
        for retry in &retries {
            let settlement = settle_retry_after_restart(retry)?;
            let linkage = SessionEventLinkage {
                transactional_prelude: vec![settlement.statement],
                ..SessionEventLinkage::default()
            };
            let appended = match hold {
                Some(hold) => {
                    self.deps
                        .appender
                        .append_held(hold, settlement.event, linkage)
                        .await
                }
                None => self.deps.appender.append(settlement.event, linkage).await,
            };
            match appended {
                Ok(_receipt) => {}
                Err(error) if refused_statement_index(&error).is_some() => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    async fn read<Output: Send + 'static>(
        &self,
        read: impl FnOnce(&Connection) -> rusqlite::Result<Output> + Send + 'static,
    ) -> Result<Output, RestartSettleError> {
        self.deps
            .reads
            .read(ReadLength::Short, move |reader| {
                Ok::<_, RestartSettleError>(read(reader)?)
            })
            .await
    }
}

// The stop's word before a step, where the caller has a stop: a step past it would write what the
// next start settles again.
fn check_stop(stop: Option<&CancellationToken>) -> Result<(), RestartSettleError> {
    match stop {
        Some(stop) if stop.is_cancelled() => Err(RestartSettleError::Stopped),
        _ => Ok(()),
    }
}

fn run_ids(runs: &[SessionRun]) -> Vec<RunId> {
    runs.iter().map(|run| run.run_id).collect()
}
