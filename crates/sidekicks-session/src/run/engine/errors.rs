//! Why the run engine did not do what it was asked, and why a resume of a paused run did not move
//! it to `running`.

use std::error::Error;

use sidekicks_contracts::run::id::RunId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::settle_all::SettleFailures;
use sidekicks_store::database::connection::read_pool::DatabaseReadError;
use sidekicks_store::events::session::appender::{SessionEventAppendError, SessionEventDraftError};
use sidekicks_workspace::run_setup_gates::{RunSetupGateError, RunTerminalReleaseError};

use crate::interventions::interrupt_queue::InterruptQueueError;
use crate::run::agent::RunAgentReadError;
use crate::run::daemon_turn::DaemonTurnQueueError;
use crate::run::limit_interrupter::LimitInterruptFailure;
use crate::run::refusals::RunRefusal;
use crate::run::state_change::RunStateChangeError;
use crate::transcript::turn_attribution::TurnAttributionError;

/// Why the run engine did not do what it was asked; what each step wrote before the failure is
/// kept, and the failure says which step failed. Its large failures are boxed, so it stays within
/// 64 bytes for every `Result` that carries it.
#[derive(Debug, thiserror::Error)]
pub enum RunEngineError {
    /// The run is unknown, has ended, or may not make the move asked of it.
    #[error(transparent)]
    Refused(RunRefusal),
    /// A run state change was not written for a reason other than a refusal of the run.
    #[error("the run state change was not written")]
    Change(#[source] RunStateChangeError),
    /// A terminal hook failed after the run ended; the end is kept.
    #[error(transparent)]
    Released(#[from] RunTerminalReleaseError),
    /// A setup gate refused the run.
    #[error("a setup gate refused run {run_id}")]
    Gate {
        /// The run.
        run_id: RunId,
        /// The gate's failure.
        #[source]
        source: Box<RunSetupGateError>,
    },
    /// A run its provider started has no session posture to run at: no source was handed to
    /// the engine, the source is gone, or the run's session has no open process.
    #[error("run {run_id} has no posture of its session's open process to run at")]
    NoSessionPosture {
        /// The run.
        run_id: RunId,
    },
    /// The run passed its gates with no posture resolved for it.
    #[error("run {run_id} passed its gates with no resolved posture")]
    NoResolvedPosture {
        /// The run.
        run_id: RunId,
    },
    /// The driver's start of the run or of its turn, or its interrupt of that turn, failed.
    #[error("the provider's driver failed for run {run_id}")]
    Driver {
        /// The run.
        run_id: RunId,
        /// The driver's failure.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    /// The interventions service was never handed to the engine or has shut down, so the run the
    /// daemon stopped at a limit was not interrupted.
    #[error("no interventions service interrupts run {run_id}, stopped at a limit")]
    LimitInterrupterGone {
        /// The run.
        run_id: RunId,
    },
    /// The interventions service did not interrupt the run the daemon stopped at a limit; the
    /// limit's reached event stands, so the stop's retry sends the interrupt alone, and the cut of
    /// the run's turn stands only while the failure left the interrupt's row pending.
    #[error("run {run_id}, stopped at a limit, was not interrupted")]
    LimitInterrupt {
        /// The run.
        run_id: RunId,
        /// The service's failure.
        #[source]
        source: LimitInterruptFailure,
    },
    /// No registered driver answers the run's provider (`provider.notFound`).
    #[error(transparent)]
    Provider(DomainError),
    /// The daemon turn's run was not queued.
    #[error(transparent)]
    DaemonTurn(Box<DaemonTurnQueueError>),
    /// The run's agent could not be read from its session's log.
    #[error("the run's agent could not be read")]
    Agent(#[source] Box<RunAgentReadError>),
    /// An event breaks a check of its type.
    #[error("the run's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep an append, or a guard in its write refused it.
    #[error("the run's event was not appended")]
    Append(#[source] Box<SessionEventAppendError>),
    /// SQLite refused a read, or a stored column does not read as its type.
    #[error("the run could not be read")]
    Read(#[source] Box<rusqlite::Error>),
    /// The read pool did not run a read.
    #[error("the read pool did not run the run's read")]
    Pool(#[source] Box<DatabaseReadError>),
    /// Where the run stands could not be read from its log.
    #[error("where the run stands could not be read from its log")]
    Standing(#[source] Box<TurnAttributionError>),
    /// The run's end or a turn's end landed with the settle of a person's interrupt, and letting go
    /// the run queue's hold of that interrupt failed; the end is kept.
    #[error("run {run_id} settled an interrupt, and its queue hold was not let go")]
    InterruptRelease {
        /// The run.
        run_id: RunId,
        /// The queue's failure.
        #[source]
        source: InterruptQueueError,
    },
    /// A step failed and so did the cleanup after it, every failure kept, the step's own first.
    #[error(transparent)]
    Several(Box<SettleFailures<RunEngineError>>),
}

// The budget every `Result` carrying the engine's error keeps.
const _: () = assert!(size_of::<RunEngineError>() <= 64);

/// Why a resume of a paused run did not move it to `running`; only [`RunResumeError::Change`]
/// comes after the driver took the resume.
#[derive(Debug, thiserror::Error)]
pub(crate) enum RunResumeError<DriverFailure> {
    /// The run was refused, or its read failed, before the driver was asked: another continue or
    /// a resume holds it, its version is not the one the caller read, or its state is not one a
    /// resume leaves.
    #[error(transparent)]
    Unstarted(RunEngineError),
    /// The driver's resume failed; nothing was written.
    #[error("the provider's driver did not take the resume")]
    Driver(#[source] DriverFailure),
    /// The driver took the resume, and the move to `running` was refused or failed.
    #[error("the provider took the run's resume, and its move to running was not written")]
    Change(#[source] RunEngineError),
}

impl From<DaemonTurnQueueError> for RunEngineError {
    fn from(error: DaemonTurnQueueError) -> Self {
        Self::DaemonTurn(Box::new(error))
    }
}

impl From<RunAgentReadError> for RunEngineError {
    fn from(error: RunAgentReadError) -> Self {
        Self::Agent(Box::new(error))
    }
}

impl From<SessionEventAppendError> for RunEngineError {
    fn from(error: SessionEventAppendError) -> Self {
        Self::Append(Box::new(error))
    }
}

impl From<rusqlite::Error> for RunEngineError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Read(Box::new(error))
    }
}

impl From<DatabaseReadError> for RunEngineError {
    fn from(error: DatabaseReadError) -> Self {
        Self::Pool(Box::new(error))
    }
}

impl From<TurnAttributionError> for RunEngineError {
    fn from(error: TurnAttributionError) -> Self {
        Self::Standing(Box::new(error))
    }
}

impl From<RunRefusal> for RunEngineError {
    fn from(refusal: RunRefusal) -> Self {
        Self::Refused(refusal)
    }
}

impl From<RunStateChangeError> for RunEngineError {
    fn from(error: RunStateChangeError) -> Self {
        match error {
            RunStateChangeError::Refused(refusal) => Self::Refused(refusal),
            other @ (RunStateChangeError::CompanionRefused { .. }
            | RunStateChangeError::TurnOpen { .. }
            | RunStateChangeError::Draft(_)
            | RunStateChangeError::Append(_)
            | RunStateChangeError::Database(_)
            | RunStateChangeError::Pool(_)) => Self::Change(other),
        }
    }
}
