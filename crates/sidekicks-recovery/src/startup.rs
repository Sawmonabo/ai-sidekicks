//! The recovery pass every start runs: it rebuilds each session's projections the log has moved
//! past, settles what the restart left in every session, and records the pass on the service's
//! own session. No write is taken until the pass has listed the sessions it rebuilds and those
//! whose runs it ends; from then each listed session alone refuses the calls that name it until it
//! is rebuilt and settled, so every other session takes its writes while the pass goes on. A
//! session whose rebuild fails is healed: the store's files are copied aside untouched, once a pass
//! and once for the same damage across starts, and the rebuild runs again; one that still fails
//! opens at its last good point, or reads damaged when none of it can be read, and is never
//! written. The pass never fails: a pass that fails leaves the service blocked, or a session
//! damaged, and says why in the service log. The service's stop ends it before the next page it
//! would fold; what it had yet to rebuild stays listed for the next start's pass, and a step that
//! fails once the stop came is never read as a failed store.

mod heal;

use std::collections::BTreeSet;
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use rusqlite::Connection;
use sidekicks_approval::store::ApprovalRequestReader;
use sidekicks_artifact::plans::store::read_held_plans;
use sidekicks_contracts::daemon::recovery::{
    DaemonRecoveryAttemptedPayload, DaemonRecoveryFailedPayload, DaemonRecoverySucceededPayload,
    RecoveryFailureKind, RecoveryId, RecoveryPhase, RecoveryTrigger,
};
use sidekicks_contracts::event::envelope::DAEMON_SCOPE_SENTINEL_SESSION_ID;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::SessionEvent;
use sidekicks_contracts::machine::id::MachineId;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::mint_uuid_v7;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_provider::driver::contract::bound_failure_detail;
use sidekicks_session::interventions::store::read_pending_retries;
use sidekicks_session::interventions::unresolved::read_ended_runs_with_unresolved;
use sidekicks_session::run::provider_choice::read_ended_runs_with_open_choices;
use sidekicks_session::run::read::RunStateReader;
use sidekicks_std::elapsed::elapsed_ms_since;
use sidekicks_std::error_description::describe_error;
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};
use sidekicks_store::database::damage::DatabaseDamageWatch;
use sidekicks_store::database::writer::{DatabaseWriter, sqlite_error_code};
use sidekicks_store::events::session::appender::{
    SessionEventAppendError, SessionEventAppender, SessionEventDraft, SessionEventDraftError,
    SessionEventLinkage,
};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::damaged_history::{DamagedHistory, DamagedHistoryError};
use crate::database_file::aside_copy::AsideCopyError;
use crate::database_file::copy::DatabaseFileCopier;
use crate::projection_rebuild::{
    ProjectionRebuildError, ProjectionRebuildRequest, ProjectionRebuildService,
};
use crate::restart_settle::{RestartSettle, RestartSettleError, RestartTally};
use crate::status::RecoveryStatusTracker;

/// The statements the pass's own reads run: the failed passes since the last that succeeded, and
/// the seven every-session listings of what the restart left (the live runs, the pending retries,
/// the ended runs with an open turn, with an unresolved intervention, with a pending ask and with
/// an open choice, and the held plans).
pub const STARTUP_RECOVERY_STATEMENT_CAPACITY: usize = 8;

// The failed passes since the last one that succeeded, read from the service's own session.
static COUNT_FAILURES_SINCE_SUCCESS_SQL: LazyLock<String> = LazyLock::new(|| {
    format!(
        "SELECT COUNT(*) FROM session_events
  WHERE session_id = @sentinel
    AND type = '{failed}'
    AND sequence > COALESCE(
      (SELECT MAX(sequence) FROM session_events
        WHERE session_id = @sentinel AND type = '{succeeded}'),
      -1)",
        failed = SessionEventType::DaemonRecoveryFailed.as_str(),
        succeeded = SessionEventType::DaemonRecoverySucceeded.as_str(),
    )
});

// What a failed pass records when the failure carried no text.
static UNDESCRIBED_PASS_FAILURE: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The recovery pass failed without a message".to_owned())
            .expect("the words are free-form text")
    });

// What a pass that left a session damaged records.
static UNREBUILT_SESSIONS_DETAIL: LazyLock<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>> =
    LazyLock::new(|| {
        FreeFormText::new("The projections of one or more sessions could not be rebuilt".to_owned())
            .expect("the words are free-form text")
    });

/// What the pass reads, writes and reports through.
pub(crate) struct StartupRecoveryDeps {
    /// This machine, which every recovery event names.
    pub(crate) machine_id: MachineId,
    /// The listing's reads and the count of earlier failed passes.
    pub(crate) reads: Arc<DatabaseReadPool>,
    /// The writer a copy aside holds while it reads the store's files.
    pub(crate) writer: Arc<DatabaseWriter>,
    /// The appends of the recovery events on the service's own session.
    pub(crate) appender: Arc<SessionEventAppender>,
    /// The sessions to rebuild and their rebuilds.
    pub(crate) projection_rebuild: Arc<ProjectionRebuildService>,
    /// The last good point of a session no rebuild can take whole.
    pub(crate) damaged_history: Arc<DamagedHistory>,
    /// What the restart left in each session, settled.
    pub(crate) restart_settle: Arc<RestartSettle>,
    /// The recovery state the pass moves.
    pub(crate) status: Arc<RecoveryStatusTracker>,
    /// Told of the failure that ends the pass, so a damaged file is repaired.
    pub(crate) damage: Arc<DatabaseDamageWatch>,
    /// The database file, whose files a heal copies aside.
    pub(crate) database_path: PathBuf,
    /// The data folder the copies aside go in.
    pub(crate) data_folder: PathBuf,
    /// The copy each file is copied aside with.
    pub(crate) copier: Arc<DatabaseFileCopier>,
}

/// Runs the recovery pass a start makes before the daemon takes writes.
pub(crate) struct StartupRecovery {
    deps: StartupRecoveryDeps,
}

// What one pass did; the binding and resume steps are another unit's, so their counts stay zero.
#[derive(Default)]
struct PassTally {
    events_applied: u64,
    restart: RestartTally,
}

// Why a pass stopped short of its end.
#[derive(Debug, thiserror::Error)]
enum PassFailure {
    #[error("the earlier failed passes could not be counted")]
    Count(#[from] rusqlite::Error),
    #[error("the earlier failed passes could not be counted")]
    Pool(#[from] DatabaseReadError),
    #[error("a recovery event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    #[error("a recovery event was not appended")]
    Record(#[from] SessionEventAppendError),
    #[error("a session's projections were not rebuilt")]
    Rebuild(#[from] ProjectionRebuildError),
    #[error("a session's last good point was not found")]
    DamagedHistory(#[from] DamagedHistoryError),
    #[error("what the restart left in a session was not settled")]
    Settle(#[from] RestartSettleError),
    #[error("the copies aside of the store's files could not be read")]
    AsideRead(#[source] std::io::Error),
    #[error("the store's files were not copied aside")]
    Aside(#[from] AsideCopyError),
    #[error("the service's stop came before the store's files were copied aside")]
    Stopped,
}

// The sessions the pass works on, as its listing found them.
struct PassListing {
    // The sessions whose projections the log has moved past.
    stale: Vec<SessionId>,
    // Every other session the restart left something in.
    current: BTreeSet<SessionId>,
    // Of those, the ones with a run still live past its queue, which refuse calls until settled.
    current_listed: BTreeSet<SessionId>,
}

impl StartupRecovery {
    /// The pass over `deps`.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
    pub(crate) fn new(deps: StartupRecoveryDeps) -> Self {
        Self { deps }
    }

    /// Runs the pass and returns once it has ended, either way; the recovery state then says how
    /// it ended. `stop` ends it before its next step.
    #[cfg_attr(not(test), expect(dead_code, reason = "the daemon's start"))]
    pub(crate) async fn run(&self, stop: &CancellationToken) {
        let started = Instant::now();
        let mut pass = PassRecord {
            machine_id: self.deps.machine_id.clone(),
            recovery_id: RecoveryId::try_from(mint_uuid_v7()).expect("a minted UUID is an id"),
            phase: RecoveryPhase::ProjectionRebuild,
            attempt_number: SafeInt::new(1).expect("one is an attempt number"),
            started,
        };
        let mut tally = PassTally::default();
        let ended = self.run_pass(&mut pass, &mut tally, stop).await;
        if let Err(failure) = ended {
            self.end_failed_pass(&pass, failure, stop).await;
        }
        self.deps.status.mark_pass_ended();
    }

    async fn run_pass(
        &self,
        pass: &mut PassRecord,
        tally: &mut PassTally,
        stop: &CancellationToken,
    ) -> Result<(), PassFailure> {
        let prior_failure_count = self
            .deps
            .reads
            .read(ReadLength::Short, |reader| {
                Ok::<_, PassFailure>(count_failures_since_success(reader)?)
            })
            .await?;
        pass.attempt_number =
            SafeInt::new(prior_failure_count + 1).expect("a count past zero is an attempt number");
        self.record(SessionEvent::DaemonRecoveryAttempted(
            DaemonRecoveryAttemptedPayload {
                machine_id: pass.machine_id.clone(),
                recovery_id: pass.recovery_id,
                phase: pass.phase,
                attempt_number: pass.attempt_number,
                recovery_trigger: RecoveryTrigger::Startup,
                prior_failure_count: SafeInt::new(prior_failure_count)
                    .expect("a count is a safe integer"),
                started_at: WireInstant::now(),
            },
        ))
        .await?;

        let listing = self.list_sessions().await?;
        for session_id in listing.stale.iter().chain(&listing.current_listed) {
            self.deps.status.mark_session_rebuilding(session_id);
        }
        self.deps.status.mark_pass_listed();

        pass.phase = RecoveryPhase::RunResumption;
        for &session_id in &listing.current {
            self.settle_session(session_id, tally, stop).await?;
        }
        let mut heal = heal::HealState::default();
        let mut is_any_damaged = false;
        for &session_id in &listing.stale {
            pass.phase = RecoveryPhase::ProjectionRebuild;
            if self
                .rebuild_session(session_id, &mut heal, tally, stop)
                .await?
            {
                // A damaged session takes no write, so what the restart left in it stays.
                is_any_damaged = true;
                continue;
            }
            pass.phase = RecoveryPhase::RunResumption;
            self.settle_session(session_id, tally, stop).await?;
        }

        if is_any_damaged {
            // The outcome was decided when a session's rebuild failed, not in the step after it.
            pass.phase = RecoveryPhase::ProjectionRebuild;
            let runs_left_in_flight = self.read_runs_left_in_flight().await?;
            return self
                .record_failure(
                    pass,
                    RecoveryFailureKind::ProjectionRebuildFailed,
                    UNREBUILT_SESSIONS_DETAIL.clone(),
                    runs_left_in_flight,
                )
                .await;
        }
        let tally_count = |count: u64| SafeInt::new(count).expect("a count is a safe integer");
        self.record(SessionEvent::DaemonRecoverySucceeded(
            DaemonRecoverySucceededPayload {
                machine_id: pass.machine_id.clone(),
                recovery_id: pass.recovery_id,
                phase: pass.phase,
                attempt_number: pass.attempt_number,
                events_applied: tally_count(tally.events_applied),
                bindings_restored: SafeInt::ZERO,
                runs_resumed: SafeInt::ZERO,
                runs_failed_deterministically: tally_count(tally.restart.failed),
                runs_halted_for_reconciliation: SafeInt::ZERO,
                runs_interrupted: tally_count(tally.restart.interrupted),
                runs_stopped: tally_count(tally.restart.stopped),
                duration_ms: pass.duration_ms(),
                completed_at: WireInstant::now(),
            },
        ))
        .await
    }

    // Every session a rebuild or a settle must take, read with no session filter: the stale ones,
    // and every other one any leftover read names. A stale session's leftovers are read again
    // after its rebuild.
    async fn list_sessions(&self) -> Result<PassListing, PassFailure> {
        let stale = self
            .deps
            .projection_rebuild
            .list_sessions_to_rebuild()
            .await?;
        let (mut current, mut current_listed) = self
            .deps
            .reads
            .read(ReadLength::Short, |reader| {
                Ok::<_, PassFailure>(read_sessions_with_leftovers(reader)?)
            })
            .await?;
        for session_id in stale.iter().chain([&*DAEMON_SCOPE_SENTINEL_SESSION_ID]) {
            current.remove(session_id);
            current_listed.remove(session_id);
        }
        Ok(PassListing {
            stale,
            current,
            current_listed,
        })
    }

    // Rebuilds one stale session, healing it when its log cannot be folded, and answers whether
    // its history is left damaged; any other failure ends the pass.
    async fn rebuild_session(
        &self,
        session_id: SessionId,
        heal: &mut heal::HealState,
        tally: &mut PassTally,
        stop: &CancellationToken,
    ) -> Result<bool, PassFailure> {
        if stop.is_cancelled() {
            return Err(PassFailure::Stopped);
        }
        let rebuilt = self
            .deps
            .projection_rebuild
            .rebuild(
                ProjectionRebuildRequest {
                    session_id,
                    is_forced: false,
                    before_sequence: None,
                    stop: Some(stop.clone()),
                },
                None,
            )
            .await;
        match rebuilt {
            Ok(rebuilt) => {
                tally.events_applied += events_count(rebuilt.events_applied);
                Ok(false)
            }
            Err(ProjectionRebuildError::ProjectionFailure(failures)) => {
                tracing::warn!(
                    session_id = %session_id,
                    error = &failures as &(dyn Error + 'static),
                    "a session's projections could not be rebuilt; the pass heals it"
                );
                self.heal(failures.original(), heal, tally, stop).await
            }
            Err(error) => Err(error.into()),
        }
    }

    // Settles what the restart left in one session; a listed one takes calls again after.
    async fn settle_session(
        &self,
        session_id: SessionId,
        tally: &mut PassTally,
        stop: &CancellationToken,
    ) -> Result<(), PassFailure> {
        if stop.is_cancelled() {
            return Err(PassFailure::Stopped);
        }
        let status = &self.deps.status;
        status.mark_session_settling(&session_id);
        let settled = self
            .deps
            .restart_settle
            .settle_live(session_id, None, Some(stop))
            .await?;
        tally.restart.failed += settled.failed;
        tally.restart.interrupted += settled.interrupted;
        tally.restart.stopped += settled.stopped;
        self.deps
            .restart_settle
            .settle_ended(session_id, Some(stop))
            .await?;
        status.mark_session_healthy(&session_id);
        Ok(())
    }

    // A pass the stop ended says nothing of the store; any other failure is the store's.
    async fn end_failed_pass(
        &self,
        pass: &PassRecord,
        failure: PassFailure,
        stop: &CancellationToken,
    ) {
        let is_stopped = stop.is_cancelled();
        if is_stopped {
            tracing::info!(
                error = &failure as &(dyn Error + 'static),
                "the service's stop ended the recovery pass; its next start rebuilds what it had \
                 yet to"
            );
            return;
        }
        self.deps.status.mark_store_failed();
        self.deps.damage.report(&failure);
        tracing::error!(
            error = &failure as &(dyn Error + 'static),
            "the recovery pass failed; the service takes no write"
        );
        let failure_kind = if sqlite_error_code(&failure).is_some() {
            RecoveryFailureKind::PersistenceUnavailable
        } else {
            RecoveryFailureKind::Other
        };
        let detail =
            bound_failure_detail(&describe_error(&failure), UNDESCRIBED_PASS_FAILURE.clone());
        let recorded = match self.read_runs_left_in_flight().await {
            Ok(runs_left_in_flight) => {
                self.record_failure(pass, failure_kind, detail, runs_left_in_flight)
                    .await
            }
            Err(read_failure) => Err(read_failure),
        };
        if let Err(record_failure) = recorded {
            tracing::error!(
                error = &record_failure as &(dyn Error + 'static),
                "the failed recovery pass could not be recorded"
            );
        }
    }

    // The runs still live once the pass ends short: those of damaged sessions, and those it did
    // not reach.
    async fn read_runs_left_in_flight(&self) -> Result<Vec<RunId>, PassFailure> {
        let live_runs = self
            .deps
            .reads
            .read(ReadLength::Short, |reader| {
                Ok::<_, PassFailure>(RunStateReader::new(reader).list_live_runs(None)?)
            })
            .await?;
        Ok(live_runs
            .into_iter()
            .filter(|live_run| live_run.run.state != RunState::Queued)
            .map(|live_run| live_run.run_id)
            .collect())
    }

    async fn record_failure(
        &self,
        pass: &PassRecord,
        failure_kind: RecoveryFailureKind,
        detail: FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>,
        runs_left_in_flight: Vec<RunId>,
    ) -> Result<(), PassFailure> {
        self.record(SessionEvent::DaemonRecoveryFailed(
            DaemonRecoveryFailedPayload {
                machine_id: pass.machine_id.clone(),
                recovery_id: pass.recovery_id,
                phase: pass.phase,
                attempt_number: pass.attempt_number,
                failure_kind,
                detail,
                runs_left_in_flight,
                duration_ms: pass.duration_ms(),
            },
        ))
        .await
    }

    async fn record(&self, event: SessionEvent) -> Result<(), PassFailure> {
        let draft = SessionEventDraft::of_session(*DAEMON_SCOPE_SENTINEL_SESSION_ID, &event)?;
        self.deps
            .appender
            .append(draft, SessionEventLinkage::default())
            .await?;
        Ok(())
    }
}

// What every recovery event of one pass names.
struct PassRecord {
    machine_id: MachineId,
    recovery_id: RecoveryId,
    phase: RecoveryPhase,
    attempt_number: SafeInt<1>,
    started: Instant,
}

impl PassRecord {
    fn duration_ms(&self) -> SafeInt<0> {
        elapsed_ms_since(self.started)
    }
}

fn count_failures_since_success(reader: &Connection) -> rusqlite::Result<u64> {
    let count: i64 = reader
        .prepare_cached(&COUNT_FAILURES_SINCE_SUCCESS_SQL)?
        .query_row(
            rusqlite::named_params! {
                "@sentinel": DAEMON_SCOPE_SENTINEL_SESSION_ID.text().as_str(),
            },
            |row| row.get(0),
        )?;
    Ok(count.cast_unsigned())
}

// Every session any leftover read names, and of those the ones with a run live past its queue.
fn read_sessions_with_leftovers(
    reader: &Connection,
) -> rusqlite::Result<(BTreeSet<SessionId>, BTreeSet<SessionId>)> {
    let runs = RunStateReader::new(reader);
    let live_runs = runs.list_live_runs(None)?;
    let listed: BTreeSet<SessionId> = live_runs
        .iter()
        .filter(|live_run| live_run.run.state != RunState::Queued)
        .map(|live_run| live_run.run.session_id)
        .collect();
    let mut sessions: BTreeSet<SessionId> = live_runs
        .iter()
        .map(|live_run| live_run.run.session_id)
        .collect();
    sessions.extend(
        read_pending_retries(reader, None)?
            .into_iter()
            .map(|retry| retry.session_id),
    );
    let ended_runs = [
        runs.list_ended_runs_with_open_turns(None)?,
        read_ended_runs_with_unresolved(reader, None)?,
        ApprovalRequestReader::new(reader).list_ended_runs_with_pending(None)?,
        read_ended_runs_with_open_choices(reader, None)?,
    ];
    sessions.extend(ended_runs.iter().flatten().map(|run| run.session_id));
    sessions.extend(
        read_held_plans(reader, None)?
            .into_iter()
            .map(|plan| plan.session_id),
    );
    Ok((sessions, listed))
}

// A rebuild's count of the events it read, as the tally adds it.
fn events_count(events_applied: usize) -> u64 {
    u64::try_from(events_applied).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests;
