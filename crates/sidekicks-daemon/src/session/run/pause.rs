//! Pause and resume of a live run: each refused unless the caller read the run's current version,
//! the move written under the same version guard, and only then the driver asked to make it true on
//! the provider. A refusal leaves the run exactly as it was. Pause is a toggle: it holds the run at
//! its next tool boundary and queues nothing, and a resume continues a pausing or a paused run.

use std::error::Error;
use std::sync::Arc;

use futures::future::BoxFuture;
use sidekicks_contracts::run::control::{
    AgentRunControlResponse, AgentRunPauseRequest, AgentRunResumeRequest,
};
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::database::connection::read_pool::{DatabaseReadError, DatabaseReadPool};
use crate::interventions::store::run_at_version_statement;
use crate::keyed_lock::KeyedLock;
use crate::provider::driver::contract::{DriverError, ProviderDriver};
use crate::provider::driver::run_control::{PauseRunParams, ResumeRunParams, WaitingMessage};
use crate::session::run::engine::{RunEngine, RunEngineError};
use crate::session::run::read::{RunRead, read_run_through, safe_run_version};
use crate::session::run::refusals::RunRefusal;
use crate::session::run::state_change::{
    RunStateChange, RunStateChangeCompanions, RunStateChangeError, RunStateEntry,
};

// The version guard is the one companion of a pause's or a resume's move.
const VERSION_GUARD_COMPANION_INDEX: usize = 0;

// The states a resume continues: a run still finishing its step, or one already held.
const RESUMABLE_STATES: [RunState; 2] = [RunState::Pausing, RunState::Paused];

/// A failure the waiting-message queue reports, kept whole.
pub(crate) type ContinuedMessagesError = Box<dyn Error + Send + Sync>;

/// The messages waiting for a paused run that its resume delivers: read once the resume is sure to
/// go, taken once the driver continued the run with them, and given back when it did not.
pub(crate) trait ContinuedMessages: Send + Sync {
    /// The messages waiting for `run_id`, in send order.
    fn read(
        &self,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<Vec<WaitingMessage>, ContinuedMessagesError>>;

    /// Marks the messages read for `run_id` as delivered with its resume.
    fn admit(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>>;

    /// Gives the messages read for `run_id` back to wait for its next turn.
    fn release(
        &self,
        session_id: SessionId,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), ContinuedMessagesError>>;
}

/// Why a pause or a resume did not finish; each refusal left the run exactly as it was.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunPauseError {
    /// The run is unknown, its version is not the one the caller read, or its state does not allow
    /// the move.
    #[error(transparent)]
    Refused(#[from] RunRefusal),
    /// The run's move was not written for a reason other than a refusal.
    #[error("the run's move was not written")]
    Change(#[source] RunEngineError),
    /// The driver did not take the pause or the resume; a refused pause returned the run to
    /// `running`, and a refused resume left it `running` with its messages given back.
    #[error("the provider driver did not take the run's pause or resume")]
    Driver(#[source] DriverError),
    /// The driver refused to pause the run, and returning the run to `running` failed too.
    #[error("the driver refused to pause the run ({driver}), and returning it to running failed")]
    NotRestored {
        /// The driver's refusal of the pause.
        driver: DriverError,
        /// The failed return to `running`.
        #[source]
        restore: RunEngineError,
    },
    /// The messages waiting for the run could not be read; nothing was moved.
    #[error("the messages waiting for the run could not be read")]
    WaitingMessagesUnread(#[source] ContinuedMessagesError),
    /// The resume failed, and giving its messages back failed too.
    #[error("the run's resume failed ({resume}), and giving its waiting messages back failed")]
    MessagesNotReleased {
        /// Why the resume failed.
        resume: Box<RunPauseError>,
        /// The failed give-back.
        #[source]
        release: ContinuedMessagesError,
    },
    /// The run resumed with its messages, and marking them delivered failed.
    #[error("the run resumed, and marking its waiting messages delivered failed")]
    MessagesNotAdmitted(#[source] ContinuedMessagesError),
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
            | RunEngineError::Provider(_)
            | RunEngineError::ProviderUnknown { .. }
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

/// Pauses and resumes runs. Calls on one run take turns, so a resume never reaches the driver
/// before the pause it follows.
pub(crate) struct RunPauseControl {
    pool: Arc<DatabaseReadPool>,
    engine: Arc<RunEngine>,
    run_lock: KeyedLock<RunId>,
}

impl RunPauseControl {
    /// Pause and resume reading runs through `pool` and moving them through `engine`.
    #[expect(dead_code, reason = "the run control handlers")]
    pub(crate) fn new(pool: Arc<DatabaseReadPool>, engine: Arc<RunEngine>) -> Self {
        Self {
            pool,
            engine,
            run_lock: KeyedLock::new(),
        }
    }

    /// Moves a running run to `pausing`, then asks the driver to hold it at its next tool boundary;
    /// the driver reports `paused`. Fails with [`RunRefusal::VersionStale`] when the expected
    /// version is not the run's and [`RunRefusal::InvalidTransition`] for a run that is not
    /// running. A pause the driver refuses returns the run to `running` and fails with
    /// [`RunPauseError::Driver`].
    #[expect(dead_code, reason = "the run control handlers")]
    pub(crate) async fn pause(
        &self,
        request: &AgentRunPauseRequest,
        driver: &dyn ProviderDriver,
    ) -> Result<AgentRunControlResponse, RunPauseError> {
        let run_id = request.target_run_id;
        let _run_hold = self.run_lock.acquire(run_id).await;
        let run = self
            .read_at_expected_version(run_id, request.expected_run_version)
            .await?;
        let pausing = self
            .move_at_expected_version(run_id, request.expected_run_version, RunStateEntry::Pausing)
            .await?;
        if let Err(driver_error) = driver
            .pause_run(PauseRunParams {
                session_id: run.session_id,
                run_id,
            })
            .await
        {
            return Err(self.restore_running(run_id, driver_error).await);
        }
        Ok(run_control_response(run_id, &pausing))
    }

    /// Moves a pausing or paused run back to `running` and asks the driver to continue it from
    /// where it stopped, delivering the messages waiting for it in send order. Fails with
    /// [`RunRefusal::VersionStale`] when the expected version is not the run's and
    /// [`RunRefusal::InvalidTransition`] for a run in any other state, nothing read; the driver's
    /// own failure is [`RunPauseError::Driver`], the run left `running`, its messages given back.
    #[expect(dead_code, reason = "the run control handlers")]
    pub(crate) async fn resume(
        &self,
        request: &AgentRunResumeRequest,
        driver: &dyn ProviderDriver,
        continued: &dyn ContinuedMessages,
    ) -> Result<AgentRunControlResponse, RunPauseError> {
        let run_id = request.target_run_id;
        let _run_hold = self.run_lock.acquire(run_id).await;
        let run = self
            .read_at_expected_version(run_id, request.expected_run_version)
            .await?;
        if !RESUMABLE_STATES.contains(&run.state) {
            return Err(RunRefusal::InvalidTransition {
                run_id,
                from_state: run.state,
                to_state: RunStateChangeState::Running,
                source: None,
            }
            .into());
        }
        let messages = continued
            .read(run_id)
            .await
            .map_err(RunPauseError::WaitingMessagesUnread)?;
        let resumed = async {
            let running = self
                .move_at_expected_version(
                    run_id,
                    request.expected_run_version,
                    RunStateEntry::Running {
                        execution_posture: None,
                    },
                )
                .await?;
            driver
                .resume_run(ResumeRunParams {
                    session_id: run.session_id,
                    run_id,
                    messages,
                })
                .await
                .map_err(RunPauseError::Driver)?;
            Ok::<_, RunPauseError>(running)
        }
        .await;
        let running = match resumed {
            Ok(running) => running,
            Err(resume) => {
                return Err(match continued.release(run.session_id, run_id).await {
                    Ok(()) => resume,
                    Err(release) => RunPauseError::MessagesNotReleased {
                        resume: Box::new(resume),
                        release,
                    },
                });
            }
        };
        continued
            .admit(run.session_id, run_id)
            .await
            .map_err(RunPauseError::MessagesNotAdmitted)?;
        Ok(run_control_response(run_id, &running))
    }

    // Any mismatch is refused, an older version or one no honest caller can hold yet.
    async fn read_at_expected_version(
        &self,
        run_id: RunId,
        expected_run_version: SafeInt<0>,
    ) -> Result<RunRead, RunPauseError> {
        let Some(run) = read_run_through::<RunPauseError>(&self.pool, run_id).await? else {
            return Err(RunRefusal::NotFound { run_id }.into());
        };
        if run.version != i64::from(expected_run_version) {
            return Err(RunRefusal::VersionStale {
                run_id,
                expected_run_version: expected_run_version.get(),
                run_version: run.version,
                source: None,
            }
            .into());
        }
        Ok(run)
    }

    // The guard sits in the move's own write, so a run that moved after the read is refused there
    // rather than moved from its new version.
    async fn move_at_expected_version(
        &self,
        run_id: RunId,
        expected_run_version: SafeInt<0>,
        entry: RunStateEntry,
    ) -> Result<RunRead, RunPauseError> {
        let companions = RunStateChangeCompanions {
            statements: vec![run_at_version_statement(
                &run_id,
                i64::from(expected_run_version) + 1,
            )],
            ..RunStateChangeCompanions::default()
        };
        match self
            .engine
            .transition(RunStateChange::new(run_id, entry), companions)
            .await
        {
            Ok(written) => Ok(written.log_resend_failure(run_id)),
            // The guard's refusal is the version the caller read gone stale; the run's version now
            // is what the refusal reports.
            Err(RunEngineError::Change(
                refused @ RunStateChangeError::CompanionRefused {
                    companion_index: VERSION_GUARD_COMPANION_INDEX,
                    ..
                },
            )) => match read_run_through::<RunPauseError>(&self.pool, run_id).await? {
                None => Err(RunRefusal::NotFound { run_id }.into()),
                Some(now) => Err(RunRefusal::VersionStale {
                    run_id,
                    expected_run_version: expected_run_version.get(),
                    run_version: now.version,
                    source: Some(Box::new(refused)),
                }
                .into()),
            },
            Err(other) => Err(other.into()),
        }
    }

    // Returns a run the driver would not pause to `running`; a run that left `pausing` while the
    // driver was asked keeps where it went. Answers the error the pause fails with.
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
            Ok(written) => {
                written.log_resend_failure(run_id);
                RunPauseError::Driver(driver_error)
            }
            Err(RunEngineError::Refused(RunRefusal::InvalidTransition { from_state, .. }))
                if from_state != RunState::Pausing =>
            {
                RunPauseError::Driver(driver_error)
            }
            Err(restore) => RunPauseError::NotRestored {
                driver: driver_error,
                restore,
            },
        }
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
