//! What a restart left in one session, settled in an order no later step undoes: the faster-model
//! retries still pending, before the run ends that would expire an accepted one; a lead a person's
//! continue left running before any turn, moved back to `paused`, its continue lost; the runs still
//! in progress, past their queue and not paused, a pausing run among them, re-armed from the log
//! before a resume of the session's conversation, with the paused runs beside them; the runs still
//! live that no resume took, failed as no provider session came back, or with the provider's own
//! words where it refused the resume, a lead the person paused or was pausing kept paused, each
//! judged stopping or not by the stops read before the first of them settles, so a lead's own end
//! never clears the stop its helper waits on; the open turns of runs that had already ended, before
//! their unresolved interventions, whose expiry would drop the limit a turn ends with; then the
//! asks, the choices and the held plans those ended runs left open. Every read is of the one
//! session and taken after its rebuild; every write is guarded on the rows it read. The recovery
//! pass settles each session it finds so, and `Continue from here` settles a damaged one.

use std::collections::BTreeSet;
use std::error::Error;
use std::sync::Arc;

use rusqlite::Connection;
use sidekicks_approval::service::{ApprovalService, ApprovalServiceError};
use sidekicks_approval::store::ApprovalRequestReader;
use sidekicks_artifact::plans::service::{PlanError, PlansService};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::run_control::{FindTakenMessagesParams, TakenMessages};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_queue::delivery::run_end::stop_message_ends_with_taken;
use sidekicks_session::driver_resolution::{LiveRunDriverError, read_run_driver};
use sidekicks_session::interventions::store::{read_pending_retries, settle_retry_after_restart};
use sidekicks_session::queue_store::QueueItemReader;
use sidekicks_session::run::engine::RunEngine;
use sidekicks_session::run::engine::errors::RunEngineError;
use sidekicks_session::run::pause::read_is_continued_with_no_turn;
use sidekicks_session::run::provider_choice::run_end::{
    read_ended_runs_with_open_choices, settle_open_choices_of_ended_run,
};
use sidekicks_session::run::read::{LiveRun, RunRead, RunStateReader, SessionRun};
use sidekicks_session::run::restart::{read_has_own_stop, read_is_run_stopping};
use sidekicks_session::run::state_change::{RunStateChange, RunWriteCompanions};
use sidekicks_std::settle_all::{SettleFailures, settle_all};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::events::session::append_lock::SessionAppendHold;
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraftError, SessionEventLinkage,
};
use tokio::time::{Instant, timeout_at};
use tokio_util::sync::CancellationToken;

use crate::resumed_runs::waiting_message_ids;

/// The provider failure detail a run the restart left live ends `failed` with.
pub(crate) const RESTART_FAILURE_DETAIL: &str =
    "The service restarted and no provider session was restored";

/// The statements the settle's own reads run: the one-session listings of its live runs, its
/// pending retries, and its ended runs with an open turn, with a pending ask and with an open
/// choice, an ended run's choice settle (its row, the newest request of each dialog and whether it
/// was settled since), the row of a run a resume took that has ended since, whether a running
/// lead's newest move is a continue, and the messages waiting for a lead the person's stop of the
/// service ends with the provider it runs on; the every-session listing of the live runs that stop
/// settles is the start's, counted there.
pub const RESTART_SETTLE_STATEMENT_CAPACITY: usize = 12;

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
    /// The drivers, found by the provider each run is bound to, whose record of a run's
    /// conversation says which of its waiting messages it took before the person's Stop.
    pub providers: Arc<ProviderRegistry>,
}

/// Settles what a restart left in one session.
pub struct RestartSettle {
    deps: RestartSettleDeps,
}

/// The runs a settle found live, by what became of them: left live by a resume, or ended in the
/// state the settle or the resume's finalize ended them in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct RestartTally {
    /// The runs a resume took that are still live and not paused.
    pub(crate) resumed: u64,
    /// The runs ended `failed`.
    pub(crate) failed: u64,
    /// The runs ended `interrupted`: under a pending interrupt, at a step or spend limit, or with
    /// their turn gone at a resume.
    pub(crate) interrupted: u64,
    /// The runs ended `stopped` at a token limit their log still owed.
    pub(crate) stopped: u64,
}

impl RestartTally {
    /// Adds `other`'s counts to these.
    pub(crate) fn add(&mut self, other: Self) {
        self.resumed += other.resumed;
        self.failed += other.failed;
        self.interrupted += other.interrupted;
        self.stopped += other.stopped;
    }

    // Counts a run that ended in `state`; a run still live or completed is counted nowhere.
    fn count_end(&mut self, state: RunState) {
        match state {
            RunState::Failed => self.failed += 1,
            RunState::Interrupted => self.interrupted += 1,
            RunState::Stopped => self.stopped += 1,
            // A run the settle left, as it read it or as it moved since.
            RunState::Queued
            | RunState::Starting
            | RunState::Running
            | RunState::WaitingForApproval
            | RunState::WaitingForInput
            | RunState::Pausing
            | RunState::Paused
            | RunState::Completed => {}
        }
    }
}

/// A session's live runs past their queue at a restart: those in progress, a pausing run among
/// them, each re-armed, the ones among them a pending stop of their own wins over, and those the
/// person paused, which are no work in progress and are re-armed only beside a run in progress,
/// whose resume opens the session.
#[derive(Debug, Default)]
pub(crate) struct RearmedRuns {
    /// The runs in progress, re-armed from the log.
    pub(crate) in_progress: Vec<LiveRun>,
    /// The runs in progress a stop of their own waits on, which no resume continues; a helper
    /// beneath a stopping lead is not among them, since its resume settles it.
    pub(crate) stopping: BTreeSet<RunId>,
    /// The runs `paused`.
    pub(crate) paused_run_ids: Vec<RunId>,
}

/// How a settle ends the live runs no resume took.
#[derive(Clone, Copy, Debug)]
pub(crate) enum LiveRunsEnd<'detail> {
    /// After a restart, a `failed` end carrying these words.
    AfterRestart(&'detail str),
    /// At the person's stop of the service: no run fails with words, and the messages waiting for
    /// each run end in its write, one its provider took admitted into it and a lead message
    /// put back into the draft whole.
    AtStop,
}

/// What a settle of a session's live runs did: its tally, and the runs it ended `failed`.
#[derive(Debug, Default)]
pub(crate) struct LiveSettlement {
    /// The runs counted by what became of them.
    pub(crate) tally: RestartTally,
    /// The runs the settle itself ended `failed`, in the order it read them.
    pub(crate) failed_run_ids: Vec<RunId>,
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
    /// Runs the settle at the person's stop of the service could not end; every other run it
    /// reached was settled.
    #[error("runs live at the stop could not be settled")]
    RunsAtStop(#[from] SettleFailures<RunEngineError>),
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

    /// Settles `session_id`'s pending faster-model retries and moves back to `paused` each lead a
    /// person's continue left running before any turn, whose continue the restart lost, then
    /// re-arms each run still in progress, a pausing run among them, from the log, and beside any
    /// such run the paused ones too, answering the runs in progress, those a pending stop of their
    /// own wins over, and the paused runs. Fails at the first read or write that fails, or with
    /// `Stopped`, `stop` read before each step.
    pub(crate) async fn rearm_live(
        &self,
        session_id: SessionId,
        stop: &CancellationToken,
    ) -> Result<RearmedRuns, RestartSettleError> {
        check_stop(Some(stop))?;
        self.settle_pending_retries(session_id, None).await?;
        check_stop(Some(stop))?;
        let live_runs = self
            .read(move |reader| RunStateReader::new(reader).list_live_runs(Some(&session_id)))
            .await?;
        let running_leads: Vec<RunId> = live_runs
            .iter()
            .filter(|live_run| live_run.is_lead() && live_run.run.state == RunState::Running)
            .map(|live_run| live_run.run_id)
            .collect();
        // Such a lead kept its continue's messages only in memory, so it reads paused again and
        // the person's next continue sends them.
        let held_leads = self
            .read_runs_where(running_leads, read_is_continued_with_no_turn)
            .await?;
        let mut rearmed = RearmedRuns::default();
        let mut paused = Vec::new();
        for mut live_run in live_runs {
            if held_leads.contains(&live_run.run_id) {
                check_stop(Some(stop))?;
                let back_to_paused = RunStateChange {
                    expected_state: Some(RunState::Running),
                    ..RunStateChange::new(live_run.run_id, RunStateEntry::Paused)
                };
                live_run.run = self
                    .deps
                    .run_engine
                    .transition(back_to_paused, RunWriteCompanions::default())
                    .await?;
            }
            match live_run.run.state {
                // A queued run waits for the queue's own delivery; no live run is a terminal one.
                RunState::Queued
                | RunState::Completed
                | RunState::Interrupted
                | RunState::Stopped
                | RunState::Failed => {}
                RunState::Paused => {
                    rearmed.paused_run_ids.push(live_run.run_id);
                    paused.push(live_run);
                }
                RunState::Starting
                | RunState::Running
                | RunState::WaitingForApproval
                | RunState::WaitingForInput
                | RunState::Pausing => {
                    check_stop(Some(stop))?;
                    self.deps.run_engine.rearm_after_restart(&live_run).await?;
                    rearmed.in_progress.push(live_run);
                }
            }
        }
        let in_progress: Vec<RunId> = rearmed.in_progress.iter().map(|run| run.run_id).collect();
        rearmed.stopping = self.read_runs_where(in_progress, read_has_own_stop).await?;
        // A paused run is re-armed beside a run in progress, so a limit it owes is handed again at
        // its continue.
        if !rearmed.in_progress.is_empty() {
            for live_run in &paused {
                check_stop(Some(stop))?;
                self.deps.run_engine.rearm_after_restart(live_run).await?;
            }
        }
        Ok(rearmed)
    }

    /// Settles `session_id`'s pending faster-model retries, then ends each run of it still live
    /// that `resumed` does not name by `end`: after a restart as
    /// [`RunEngine::settle_run_after_restart`] decides, a `failed` end carrying its words, and at
    /// the person's stop of the service as [`RunEngine::settle_run_at_stop`] decides, writing under
    /// `hold` where the caller holds the session's appends and reading `stop`, where the caller has
    /// one, before each step. After a restart, whether a stop wins over each run is read for all of
    /// them before the first settles, since a lead's own end discharges the stop its helper waits
    /// on, so the order the runs settle in decides nothing.
    /// A run `resumed` names is counted resumed while it is live and not paused, a pausing run
    /// among them since its pause is still to land, nowhere while it is paused, and by its end
    /// where the resume's finalize ended it. Fails at the first read or write that fails, or with
    /// `Stopped`.
    pub(crate) async fn settle_live(
        &self,
        session_id: SessionId,
        resumed: &BTreeSet<RunId>,
        end: LiveRunsEnd<'_>,
        hold: Option<&SessionAppendHold>,
        stop: Option<&CancellationToken>,
    ) -> Result<LiveSettlement, RestartSettleError> {
        check_stop(stop)?;
        self.settle_pending_retries(session_id, hold).await?;
        check_stop(stop)?;
        let live_runs = self
            .read(move |reader| RunStateReader::new(reader).list_live_runs(Some(&session_id)))
            .await?;
        // The Stop's table reads no run's own stop, so no stopping set is read for it.
        let stopping = match end {
            LiveRunsEnd::AfterRestart(_) => {
                let unsettled: Vec<RunId> = live_runs
                    .iter()
                    .filter(|live_run| {
                        live_run.run.state != RunState::Queued
                            && !resumed.contains(&live_run.run_id)
                    })
                    .map(|live_run| live_run.run_id)
                    .collect();
                self.read_runs_where(unsettled, read_is_run_stopping)
                    .await?
            }
            LiveRunsEnd::AtStop => BTreeSet::new(),
        };
        let mut settlement = LiveSettlement::default();
        for live_run in &live_runs {
            if resumed.contains(&live_run.run_id) {
                // A paused run the resume named stays paused, so it is counted nowhere.
                if live_run.run.state != RunState::Paused {
                    settlement.tally.resumed += 1;
                }
                continue;
            }
            check_stop(stop)?;
            let settled = self
                .settle_run(live_run, end, stopping.contains(&live_run.run_id), hold)
                .await?;
            if settled.state == RunState::Failed {
                settlement.failed_run_ids.push(live_run.run_id);
            }
            settlement.tally.count_end(settled.state);
        }
        let ended_at_resume: Vec<RunId> = resumed
            .iter()
            .filter(|run_id| !live_runs.iter().any(|live_run| live_run.run_id == **run_id))
            .copied()
            .collect();
        if !ended_at_resume.is_empty() {
            let ended = self
                .read(move |reader| {
                    let runs = RunStateReader::new(reader);
                    ended_at_resume
                        .iter()
                        .map(|run_id| runs.read_run(run_id))
                        .collect::<rusqlite::Result<Vec<_>>>()
                })
                .await?;
            for run in ended.into_iter().flatten() {
                settlement.tally.count_end(run.state);
            }
        }
        Ok(settlement)
    }

    /// Settles every live run at the person's stop of the service, session by session, each in
    /// one write as [`RunEngine::settle_run_at_stop`] decides, its waiting messages ending in it,
    /// until `deadline`; a run cut there, every run after it and every run whose settle failed are
    /// left to the next start. Fails as the listing's read fails, or with every run's failure once
    /// the rest are settled.
    pub async fn settle_at_stop(&self, deadline: Instant) -> Result<(), RestartSettleError> {
        let mut live_runs = self
            .read(|reader| RunStateReader::new(reader).list_live_runs(None))
            .await?;
        live_runs.sort_by_key(|live_run| live_run.run.session_id);
        let mut settled_runs = Vec::new();
        for live_run in &live_runs {
            // A spent bound settles nothing more, so no settle starts inside the timer's last tick;
            // what is left stays live for the next start.
            if Instant::now() >= deadline {
                break;
            }
            let settle = self.settle_run(live_run, LiveRunsEnd::AtStop, false, None);
            let Ok(settled) = timeout_at(deadline, settle).await else {
                break;
            };
            // A refused write, a damaged session's among them, holds back no other session.
            settled_runs.push(settled);
        }
        settle_all(settled_runs, "settling the live runs at the stop")?;
        Ok(())
    }

    /// Settles what `session_id`'s runs that had ended left open: their open turns, then their
    /// interventions with no outcome, their pending asks and the cards of workflow waits no one
    /// holds, their unsettled choices and the plans a lost request held, reading `stop`, where the
    /// caller has one, before each step. Fails at the first step that fails, or with `Stopped`.
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
        // A workflow wait's card whose wait ended while the daemon was down, before its withdraw.
        self.deps
            .approvals
            .cancel_unheld_wait_asks(session_id)
            .await?;
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

    // Ends `live_run` by `end`, after a restart with `is_stopping` saying whether a stop of its own
    // wins over it, under `hold` where the caller holds the run's session.
    async fn settle_run(
        &self,
        live_run: &LiveRun,
        end: LiveRunsEnd<'_>,
        is_stopping: bool,
        hold: Option<&SessionAppendHold>,
    ) -> Result<RunRead, RunEngineError> {
        let engine = &self.deps.run_engine;
        match end {
            LiveRunsEnd::AfterRestart(failure_detail) => {
                engine
                    .settle_run_after_restart(live_run, is_stopping, failure_detail, hold)
                    .await
            }
            LiveRunsEnd::AtStop => {
                let taken = self.read_taken_at_stop(live_run).await?;
                engine
                    .settle_run_at_stop(live_run, stop_message_ends_with_taken, &taken, hold)
                    .await
            }
        }
    }

    // The messages waiting for `live_run` that its provider took, by its own record of the
    // conversation, so the Stop admits them rather than put them back into the draft. None for a
    // helper or a queued run, whose waiting messages no conversation was handed, nor where none
    // waits; none either, as though the provider took nothing, where it cannot be asked: no driver
    // answers the run, or its record cannot be read, as with no process to read it through. Fails
    // as a read fails.
    async fn read_taken_at_stop(
        &self,
        live_run: &LiveRun,
    ) -> Result<Vec<QueueItemId>, RunEngineError> {
        if !live_run.is_lead() || live_run.run.state == RunState::Queued {
            return Ok(Vec::new());
        }
        let (session_id, run_id) = (live_run.run.session_id, live_run.run_id);
        let message_ids = self
            .deps
            .reads
            .read(ReadLength::Short, move |reader| {
                let waiting = QueueItemReader::new(reader).list_waiting_for_run(&run_id)?;
                Ok::<_, RunEngineError>(waiting_message_ids(waiting))
            })
            .await?;
        if message_ids.is_empty() {
            return Ok(Vec::new());
        }
        let driver =
            match read_run_driver::<TakenAskError>(&self.deps.reads, &self.deps.providers, run_id)
                .await
            {
                Ok(driver) => driver,
                Err(TakenAskError::Driver(unasked)) => {
                    tracing::warn!(
                        session_id = %session_id,
                        run_id = %run_id,
                        error = &unasked as &(dyn Error + 'static),
                        "no driver answers a run the Stop ends; its waiting messages end as though \
                         the provider took none"
                    );
                    return Ok(Vec::new());
                }
                Err(TakenAskError::Read(failure)) => return Err(failure.into()),
                Err(TakenAskError::Pool(failure)) => return Err(failure.into()),
            };
        let found = driver
            .find_taken_messages(FindTakenMessagesParams {
                session_id,
                run_id,
                message_ids,
            })
            .await;
        match found {
            Ok(TakenMessages { taken }) => Ok(taken),
            Err(unread) => {
                tracing::warn!(
                    session_id = %session_id,
                    run_id = %run_id,
                    error = &unread as &(dyn Error + 'static),
                    "the provider's record of a run the Stop ends could not be read; its waiting \
                     messages end as though the provider took none"
                );
                Ok(Vec::new())
            }
        }
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
                Err(error) if error.refused_statement_index().is_some() => {}
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

    // Those of `run_ids` that `is_matching` answers true for, read in one go.
    async fn read_runs_where(
        &self,
        run_ids: Vec<RunId>,
        is_matching: fn(&Connection, &RunId) -> rusqlite::Result<bool>,
    ) -> Result<BTreeSet<RunId>, RestartSettleError> {
        self.read(move |reader| {
            let mut matching = BTreeSet::new();
            for run_id in run_ids {
                if is_matching(reader, &run_id)? {
                    matching.insert(run_id);
                }
            }
            Ok(matching)
        })
        .await
    }
}

// Why the driver of a run the Stop ends was not found: its binding's read failed, or no driver
// answers the run, which the Stop meets by asking no provider.
#[derive(Debug, thiserror::Error)]
enum TakenAskError {
    #[error("the run's provider could not be read")]
    Read(#[from] rusqlite::Error),
    #[error("the run's provider could not be read")]
    Pool(#[from] DatabaseReadError),
    #[error("no driver answers the run")]
    Driver(#[from] LiveRunDriverError),
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
