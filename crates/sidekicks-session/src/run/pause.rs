//! Pause and resume of a live run: each refused unless the caller read the run's current version
//! and the run is in a state the move leaves, and only then is its driver found. A pause writes
//! `pausing` under the version guard, then asks the driver to hold the run at its next tool
//! boundary; a resume asks the driver first and writes `running` under the guard only once the
//! driver took it, so a run whose resume failed still reads as it did. Pause is a toggle: it holds
//! the run at its next tool boundary and queues nothing, and a resume continues a pausing or a
//! paused run.

use std::error::Error;
use std::sync::{Arc, OnceLock};

use futures::FutureExt;
use futures::future::BoxFuture;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::control::{
    AgentRunControlResponse, AgentRunPauseRequest, AgentRunResumeRequest,
};
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_provider::driver::registry::ProviderRegistry;
use sidekicks_provider::driver::run_control::{
    FindTakenMessagesParams, PauseRunParams, ResumeRunParams, TakenMessages,
};
use sidekicks_provider::port::run_pause::{ContinuedMessages, ContinuedMessagesError, RunPauses};
use sidekicks_provider::run::state_entry::RunStateEntry;
use sidekicks_std::keyed_lock::{KeyHold, KeyedLock};
use sidekicks_store::database::connection::read_pool::{
    DatabaseReadError, DatabaseReadPool, ReadLength,
};

use crate::driver_resolution::{LiveRunDriverError, resolve_live_run_driver};
use crate::interventions::store::run_at_version_statement;
use crate::run::engine::{RunEngine, RunEngineError, RunResumeError};
use crate::run::read::{
    RunRead, RunStateReader, read_run_provider, read_run_through, safe_run_version,
};
use crate::run::refusals::{RunRefusal, require_expected_version};
use crate::run::state_change::{RunStateChange, RunStateChangeCompanions, RunStateChangeError};

#[cfg(test)]
mod tests;

// The version guard is the one companion of a pause's or a resume's move.
const VERSION_GUARD_COMPANION_INDEX: usize = 0;

/// Why a pause or a resume did not finish; each refusal left the run exactly as it was.
#[derive(Debug, thiserror::Error)]
pub enum RunPauseError {
    /// The run is unknown, its version is not the one the caller read, or its state does not allow
    /// the move.
    #[error(transparent)]
    Refused(#[from] RunRefusal),
    /// The run's driver was not found: no registered driver answers its provider, or the live run
    /// has no binding.
    #[error(transparent)]
    NoDriver(#[from] LiveRunDriverError),
    /// The run's move was not written for a reason other than a refusal.
    #[error("the run's move was not written")]
    Change(#[source] RunEngineError),
    /// The driver did not take the pause or the resume. A refused pause returned the run to
    /// `running`, and one whose answer never came left it `pausing` for the provider's own report;
    /// a resume moved nothing, its messages given back, or kept when its answer never came.
    #[error("the provider driver did not take the run's pause or resume")]
    Driver(#[source] DriverError),
    /// The driver refused to pause the run, and returning the run to `running` failed too.
    #[error("the driver refused to pause the run ({driver}), and returning it to running failed")]
    NotRestored {
        /// The driver's refusal of the pause.
        driver: DriverError,
        /// The failed return to `running`.
        #[source]
        restore: Box<RunEngineError>,
    },
    /// The messages waiting for the run could not be read; nothing was moved.
    #[error("the messages waiting for the run could not be read")]
    WaitingMessagesUnread(#[source] ContinuedMessagesError),
    /// The resume failed, and giving its messages back, or settling those the provider took,
    /// failed too.
    #[error("the run's resume failed ({resume}), and settling its waiting messages failed")]
    MessagesNotSettled {
        /// Why the resume failed.
        resume: Box<RunPauseError>,
        /// The failed give-back or settle.
        #[source]
        settle: ContinuedMessagesError,
    },
    /// The run resumed with its messages, and marking them delivered failed.
    #[error("the run resumed, and marking its waiting messages delivered failed")]
    MessagesNotAdmitted(#[source] ContinuedMessagesError),
    /// Settling the messages a resume kept, once their outcome was known, failed; they stay kept.
    #[error("settling the messages a resume of the run kept failed")]
    KeptNotSettled(#[source] ContinuedMessagesError),
    /// The provider's record of the messages a resume kept could not be read, so they ended not
    /// delivered for the person to send again, unless ending them failed too.
    #[error("the provider's record of the messages a resume of the run kept could not be read")]
    RecordUnreadable {
        /// The driver's failure to read the record.
        #[source]
        driver: DriverError,
        /// The failed end of the messages, where it failed.
        give_back: Option<ContinuedMessagesError>,
    },
    /// The provider's record of the messages a resume kept was asked for and no answer came, so
    /// they stay kept for the next settle to read it again.
    #[error("the provider did not answer the read of its record of the messages a resume kept")]
    RecordUnanswered(#[source] DriverError),
    /// SQLite refused the run's read, or a stored column does not read as its type.
    #[error("the run's row could not be read")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run the run's read.
    #[error("the read pool did not run the run's read")]
    Pool(#[from] DatabaseReadError),
}

impl From<RunEngineError> for RunPauseError {
    // A refusal of the move is the call's refusal; any other failure keeps the engine's error.
    fn from(error: RunEngineError) -> Self {
        match error {
            RunEngineError::Refused(refusal) => Self::Refused(refusal),
            other @ (RunEngineError::Change(_)
            | RunEngineError::Released(_)
            | RunEngineError::Gate { .. }
            | RunEngineError::NoResolvedPosture { .. }
            | RunEngineError::Driver { .. }
            | RunEngineError::LimitInterrupterGone { .. }
            | RunEngineError::LimitInterrupt { .. }
            | RunEngineError::InterruptRelease { .. }
            | RunEngineError::Provider(_)
            | RunEngineError::DaemonTurn(_)
            | RunEngineError::Agent(_)
            | RunEngineError::Draft(_)
            | RunEngineError::Append(_)
            | RunEngineError::Read(_)
            | RunEngineError::Pool(_)
            | RunEngineError::Several(_)) => Self::Change(other),
        }
    }
}

impl From<RunPauseError> for HandlerError {
    /// A refusal answers by its code, the driver's failure as a driver error answers, and a
    /// provider no driver answers `provider.notFound`; the rest are faults in the daemon. A failed
    /// settle of the messages or return to `running` carries the driver's refusal and still
    /// answers as a fault on purpose: the call was not refused, the daemon failed after it was
    /// accepted.
    fn from(error: RunPauseError) -> Self {
        match error {
            RunPauseError::Refused(refusal) => Self::Refused(refusal.into()),
            RunPauseError::NoDriver(lookup) => lookup.into(),
            RunPauseError::Driver(driver) => driver.into(),
            fault @ (RunPauseError::Change(_)
            | RunPauseError::NotRestored { .. }
            | RunPauseError::WaitingMessagesUnread(_)
            | RunPauseError::MessagesNotSettled { .. }
            | RunPauseError::MessagesNotAdmitted(_)
            | RunPauseError::KeptNotSettled(_)
            | RunPauseError::RecordUnreadable { .. }
            | RunPauseError::RecordUnanswered(_)
            | RunPauseError::Read(_)
            | RunPauseError::Pool(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// The statements [`RunPauseControl`] prepares on a read connection: the run's row and the provider
/// it runs on.
pub const RUN_PAUSE_STATEMENT_CAPACITY: usize = 2;

/// Pauses and resumes runs. Calls on one run take turns, so a resume never reaches the driver
/// before the pause it follows.
pub struct RunPauseControl {
    pool: Arc<DatabaseReadPool>,
    engine: Arc<RunEngine>,
    providers: Arc<ProviderRegistry>,
    run_lock: KeyedLock<RunId>,
}

impl RunPauseControl {
    /// Pause and resume reading runs through `pool`, moving them through `engine` and reaching each
    /// run's provider through its driver in `providers`.
    pub fn new(
        pool: Arc<DatabaseReadPool>,
        engine: Arc<RunEngine>,
        providers: Arc<ProviderRegistry>,
    ) -> Self {
        Self {
            pool,
            engine,
            providers,
            run_lock: KeyedLock::new(),
        }
    }

    /// Moves a running run to `pausing`, then asks its driver to hold it at its next tool boundary;
    /// the driver reports `paused`. Refuses, nothing moved and no driver found, with
    /// [`RunRefusal::NotFound`] for an unknown run, [`RunRefusal::VersionStale`] when the expected
    /// version is not the run's and [`RunRefusal::InvalidTransition`] for a run that is not
    /// running, then with [`RunPauseError::NoDriver`]. A pause the driver refuses returns the run
    /// to `running`, and one whose answer never came leaves it `pausing`, each failing with
    /// [`RunPauseError::Driver`].
    pub async fn pause(
        &self,
        request: &AgentRunPauseRequest,
    ) -> Result<AgentRunControlResponse, RunPauseError> {
        let run_id = request.target_run_id;
        let _run_hold = self.run_lock.acquire(run_id).await;
        let (run, bound) = self.read_run(run_id).await?;
        require_expected_version(run_id, &run, request.expected_run_version)?;
        if run.state != RunState::Running {
            return Err(RunRefusal::InvalidTransition {
                run_id,
                from_state: run.state,
                to_state: RunStateChangeState::Pausing,
                source: None,
            }
            .into());
        }
        let driver = resolve_live_run_driver(&self.providers, run_id, bound)?;
        let pausing = self
            .move_at_expected_version(run_id, request.expected_run_version, RunStateEntry::Pausing)
            .await?;
        match driver
            .pause_run(PauseRunParams {
                session_id: run.session_id,
                run_id,
            })
            .await
        {
            Ok(()) => Ok(run_control_response(run_id, &pausing)),
            // The provider may still hold the run at its boundary and report `paused`.
            Err(unanswered @ DriverError::Unanswered(_)) => Err(RunPauseError::Driver(unanswered)),
            Err(driver_error) => Err(self.restore_running(run_id, driver_error).await),
        }
    }

    /// Asks the driver of a pausing or paused run to continue it from where it stopped, delivering
    /// the messages waiting for it in send order, and moves the run to `running` once the driver
    /// took the resume; the interrupt of every limit the run owes is then handed again, the
    /// messages' mark of delivery failed or not, so none reaches the provider before it runs.
    /// The run is held as being resumed before the one read of it and its provider, so a report
    /// from its provider waits for the resume; the messages are read and marked as the resume's
    /// under the queue's lock on the session, which is let go for the driver's call and taken
    /// again to settle them, so a change to them meanwhile finds them taken. The caller holds no
    /// lock of the queue's. Refuses, nothing read, as a pause does for an unknown run, a stale
    /// version and a run in any other state, then with [`RunPauseError::NoDriver`]. A resume the
    /// driver refuses moves nothing, gives the messages back and fails with
    /// [`RunPauseError::Driver`], as does one whose answer never came, which keeps the messages
    /// for the provider's own word to settle. A move refused once the driver took the resume (a
    /// process exit ended or interrupted the run meanwhile) refuses from where the run went and
    /// never gives the messages back, the provider holding them.
    pub async fn resume(
        &self,
        request: &AgentRunResumeRequest,
        continued: &dyn ContinuedMessages,
    ) -> Result<AgentRunControlResponse, RunPauseError> {
        let run_id = request.target_run_id;
        let expected_run_version = request.expected_run_version;
        let _run_hold = self.run_lock.acquire(run_id).await;
        let session = OnceLock::new();
        let session = &session;
        let resumed = self
            .engine
            .resume_run(
                run_id,
                expected_run_version,
                version_guard(run_id, expected_run_version),
                move |run, bound| async move {
                    let session_id = *session.get_or_init(|| run.session_id);
                    let driver = resolve_live_run_driver(&self.providers, run_id, bound)?;
                    let messages = {
                        let hold = continued.hold_session(session_id).await;
                        continued
                            .read(&hold, run_id, driver.message_handing())
                            .await
                            .map_err(RunPauseError::WaitingMessagesUnread)?
                    };
                    let params = ResumeRunParams {
                        session_id,
                        run_id,
                        messages,
                    };
                    let resumed = driver.resume_run(params).await;
                    let hold = continued.hold_session(session_id).await;
                    match resumed {
                        Ok(()) => Ok(()),
                        Err(unanswered @ DriverError::Unanswered(_)) => {
                            // The provider may have taken the messages; its own word settles
                            // them.
                            continued.keep(&hold, run_id);
                            Err(RunPauseError::Driver(unanswered))
                        }
                        Err(driver_error) => {
                            let failure = RunPauseError::Driver(driver_error);
                            Err(release(continued, &hold, run_id, failure).await)
                        }
                    }
                },
            )
            .await;
        let running = match resumed {
            Ok(running) => running,
            Err(RunResumeError::Unstarted(refused)) => return Err(refused.into()),
            Err(RunResumeError::Driver(failure)) => return Err(failure),
            Err(RunResumeError::Change(change)) => {
                tracing::warn!(
                    run_id = %run_id,
                    error = &change as &(dyn Error + 'static),
                    "the provider took the run's resume, and its move to running was not written"
                );
                let failure = self
                    .refusal_of_move(run_id, expected_run_version, change)
                    .await;
                let session_id = *session
                    .get()
                    .expect("the driver took a resume it was given");
                let hold = continued.hold_session(session_id).await;
                return Err(self
                    .settle_taken_messages(&hold, run_id, continued, failure)
                    .await);
            }
        };
        let admitted = {
            let hold = continued.hold_session(running.session_id).await;
            continued.admit(&hold, run_id).await
        };
        self.engine.hand_owed_limit_interrupts(run_id);
        admitted.map_err(RunPauseError::MessagesNotAdmitted)?;
        Ok(run_control_response(run_id, &running))
    }

    // Settles the messages a resume the driver took read, its move refused or failed, answering
    // `failure`, or the settle's failure beside it: the provider holds them, so none is given
    // back. A run a process exit left interrupted ended the turn they started, so they are
    // delivered with it; any other is kept, a run still live for the provider's report that it
    // runs, an ended one settled at once by the provider's record.
    async fn settle_taken_messages(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        continued: &dyn ContinuedMessages,
        failure: RunPauseError,
    ) -> RunPauseError {
        let state = match read_run_through::<RunPauseError>(&self.pool, run_id).await {
            Ok(run) => run.map(|run| run.state),
            Err(read) => return not_settled(failure, Box::new(read)),
        };
        if state == Some(RunState::Interrupted) {
            return match continued.admit(hold, run_id).await {
                Ok(()) => failure,
                Err(admit) => not_settled(failure, admit),
            };
        }
        continued.keep(hold, run_id);
        if !state.is_some_and(RunState::is_terminal) {
            return failure;
        }
        match self.settle_kept_under(hold, run_id, continued).await {
            Ok(()) => failure,
            Err(settle) => not_settled(failure, Box::new(settle)),
        }
    }

    /// Settles as taken every message a resume of `run_id` kept, once the provider reports the run
    /// running again, which shows it took the resume they went with. Fails as the admission's
    /// write fails.
    pub(crate) async fn settle_kept_as_taken(
        &self,
        session_id: SessionId,
        run_id: RunId,
        continued: &dyn ContinuedMessages,
    ) -> Result<(), RunPauseError> {
        let hold = continued.hold_session(session_id).await;
        let kept = continued.kept(&hold, run_id);
        if kept.is_empty() {
            return Ok(());
        }
        continued
            .settle_kept(&hold, run_id, &kept, &kept)
            .await
            .map_err(RunPauseError::KeptNotSettled)
    }

    /// Settles every message a resume of `run_id` kept once nothing can still take it: after the
    /// run's end, and after its provider process's end, whose own settle ends the run first. Only
    /// a message no live provider process still holds is looked up, by its id, in the provider's
    /// own record: one it holds is delivered with the run, any other given back to go once more
    /// under its own id, so a provider whose process keeps messages past a run's end has them read
    /// at its process's end. A run still live is left to its own end. A record that cannot be read
    /// ends the messages not delivered and fails with [`RunPauseError::RecordUnreadable`]; one
    /// asked for with no answer back keeps them for the next settle and fails with
    /// [`RunPauseError::RecordUnanswered`]; a run unknown or no driver refuses as a resume does.
    pub async fn settle_kept_by_record(
        &self,
        session_id: SessionId,
        run_id: RunId,
        continued: &dyn ContinuedMessages,
    ) -> Result<(), RunPauseError> {
        let hold = continued.hold_session(session_id).await;
        self.settle_kept_under(&hold, run_id, continued).await
    }

    // `settle_kept_by_record` under `hold`, which the caller took.
    async fn settle_kept_under(
        &self,
        hold: &KeyHold<'_, SessionId>,
        run_id: RunId,
        continued: &dyn ContinuedMessages,
    ) -> Result<(), RunPauseError> {
        let message_ids = continued.kept_unheld(hold, run_id);
        if message_ids.is_empty() {
            return Ok(());
        }
        let (run, bound) = self.read_run(run_id).await?;
        if !run.state.is_terminal() {
            return Ok(());
        }
        let driver = resolve_live_run_driver(&self.providers, run_id, bound)?;
        let found = driver
            .find_taken_messages(FindTakenMessagesParams {
                session_id: run.session_id,
                run_id,
                message_ids: message_ids.clone(),
            })
            .await;
        match found {
            Ok(TakenMessages { taken }) => continued
                .settle_kept(hold, run_id, &message_ids, &taken)
                .await
                .map_err(RunPauseError::KeptNotSettled),
            Err(unanswered @ DriverError::Unanswered(_)) => {
                Err(RunPauseError::RecordUnanswered(unanswered))
            }
            Err(driver) => Err(RunPauseError::RecordUnreadable {
                driver,
                give_back: continued.fail_kept(hold, run_id, &message_ids).await.err(),
            }),
        }
    }

    // The run and the provider it runs on, in one read; an unknown run is refused.
    async fn read_run(
        &self,
        run_id: RunId,
    ) -> Result<(RunRead, Option<ProviderId>), RunPauseError> {
        let read = self
            .pool
            .read(
                ReadLength::Short,
                move |reader| -> Result<_, RunPauseError> {
                    let Some(run) = RunStateReader::new(reader).read_run(&run_id)? else {
                        return Ok(None);
                    };
                    let bound = read_run_provider(reader, &run_id)?.map(|bound| bound.provider);
                    Ok(Some((run, bound)))
                },
            )
            .await?;
        read.ok_or_else(|| RunRefusal::NotFound { run_id }.into())
    }

    // The guard sits in the move's own write, so a run that moved after the read is refused there
    // rather than moved from its new version.
    async fn move_at_expected_version(
        &self,
        run_id: RunId,
        expected_run_version: SafeInt<0>,
        entry: RunStateEntry,
    ) -> Result<RunRead, RunPauseError> {
        match self
            .engine
            .transition(
                RunStateChange::new(run_id, entry),
                version_guard(run_id, expected_run_version),
            )
            .await
        {
            Ok(moved) => Ok(moved),
            Err(error) => Err(self
                .refusal_of_move(run_id, expected_run_version, error)
                .await),
        }
    }

    // What a move written under the version guard fails with: the guard's refusal is the version
    // the caller read gone stale, the run's version now being what the refusal reports.
    async fn refusal_of_move(
        &self,
        run_id: RunId,
        expected_run_version: SafeInt<0>,
        error: RunEngineError,
    ) -> RunPauseError {
        let RunEngineError::Change(
            refused @ RunStateChangeError::CompanionRefused {
                companion_index: VERSION_GUARD_COMPANION_INDEX,
                ..
            },
        ) = error
        else {
            return error.into();
        };
        match read_run_through::<RunPauseError>(&self.pool, run_id).await {
            Ok(None) => RunRefusal::NotFound { run_id }.into(),
            Ok(Some(now)) => RunRefusal::VersionStale {
                run_id,
                expected_run_version: expected_run_version.get(),
                run_version: now.version,
                source: Some(Box::new(refused)),
            }
            .into(),
            Err(read) => read,
        }
    }

    // Returns a run the driver would not pause to `running`, whose provider never paused, so the
    // move hands again the limits the run owes; a run that left `pausing` while the driver was
    // asked keeps where it went. Answers the error the pause fails with.
    async fn restore_running(&self, run_id: RunId, driver_error: DriverError) -> RunPauseError {
        let back_to_running = RunStateChange {
            expected_state: Some(RunState::Pausing),
            ..RunStateChange::new(
                run_id,
                RunStateEntry::Running {
                    execution_posture: None,
                },
            )
        };
        match self
            .engine
            .transition(back_to_running, RunStateChangeCompanions::default())
            .await
        {
            Ok(_running) => RunPauseError::Driver(driver_error),
            Err(RunEngineError::Refused(RunRefusal::InvalidTransition { from_state, .. }))
                if from_state != RunState::Pausing =>
            {
                RunPauseError::Driver(driver_error)
            }
            Err(restore) => RunPauseError::NotRestored {
                driver: driver_error,
                restore: Box::new(restore),
            },
        }
    }
}

// The version guard of a move the caller read the run at `expected_run_version` for, as the move's
// one companion.
fn version_guard(run_id: RunId, expected_run_version: SafeInt<0>) -> RunStateChangeCompanions {
    RunStateChangeCompanions {
        statements: vec![run_at_version_statement(
            &run_id,
            i64::from(expected_run_version) + 1,
        )],
        ..RunStateChangeCompanions::default()
    }
}

// Gives the messages a failed resume read back, answering `failure`, or the give-back's failure
// beside it.
async fn release(
    continued: &dyn ContinuedMessages,
    hold: &KeyHold<'_, SessionId>,
    run_id: RunId,
    failure: RunPauseError,
) -> RunPauseError {
    match continued.release(hold, run_id).await {
        Ok(()) => failure,
        Err(release) => not_settled(failure, release),
    }
}

// `failure` with the failed settle of the resume's messages beside it.
fn not_settled(failure: RunPauseError, settle: ContinuedMessagesError) -> RunPauseError {
    RunPauseError::MessagesNotSettled {
        resume: Box::new(failure),
        settle,
    }
}

/// The answer to a run-control call: the run's id with the state and version the call left it at.
pub(crate) fn run_control_response(run_id: RunId, run: &RunRead) -> AgentRunControlResponse {
    AgentRunControlResponse {
        run_id,
        new_state: run.state,
        run_version: safe_run_version(run.version),
    }
}

impl RunPauses for RunPauseControl {
    fn settle_kept_as_taken<'pauses>(
        &'pauses self,
        session_id: SessionId,
        run_id: RunId,
        continued: &'pauses dyn ContinuedMessages,
    ) -> BoxFuture<'pauses, Result<(), Box<dyn Error + Send + Sync>>> {
        async move {
            Ok(RunPauseControl::settle_kept_as_taken(self, session_id, run_id, continued).await?)
        }
        .boxed()
    }
}
