//! Why a call on the run queue failed: a refusal the caller reads by its code, or a fault inside the
//! daemon, every cause kept.

use sidekicks_contracts::run::id::RunId;

use crate::admission::memory_gate::MemoryAdmissionError;
use crate::database::connection::read_pool::DatabaseReadError;
use crate::database::writer::WriteError;
use crate::ipc::domain_error::DomainError;
use crate::ipc::handlers::driver::resolution::LiveRunDriverError;
use crate::ipc::registry::HandlerError;
use crate::provider::driver::contract::DriverError;
use crate::queue::delivery::DeliveryError;
use crate::queue::provider_session::ProviderSessionError;
use crate::queue::recorder::QueueRecordError;
use crate::session::run::agent::RunAgentReadError;
use crate::session::run::engine::RunEngineError;
use crate::session::run::refusals::RunRefusal;

/// Why a run queue call, or the work it runs on its own, failed.
#[derive(Debug, thiserror::Error)]
pub(crate) enum QueueError {
    /// A refusal the caller reads by its code.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// SQLite refused a read, or a stored value does not read as its type.
    #[error("the run queue's read failed")]
    Read(#[from] rusqlite::Error),
    /// The read pool did not run a read.
    #[error("the run queue's read did not reach the database")]
    Pool(#[from] DatabaseReadError),
    /// A hand, a withdraw or a settle of the delivery failed.
    #[error(transparent)]
    Delivery(#[from] DeliveryError),
    /// A write no queue event records was refused or not kept.
    #[error("the run queue's write was not kept")]
    Write(#[from] WriteError),
    /// A queue change was not recorded.
    #[error(transparent)]
    Record(#[from] QueueRecordError),
    /// The run engine refused or failed a run's change.
    #[error(transparent)]
    Engine(#[from] RunEngineError),
    /// The session's provider session was not opened, or a run's binding not recorded.
    #[error(transparent)]
    ProviderSession(#[from] ProviderSessionError),
    /// A driver refused or failed a call.
    #[error(transparent)]
    Driver(#[from] DriverError),
    /// The driver of a live run was not found.
    #[error(transparent)]
    RunDriver(#[from] LiveRunDriverError),
    /// The session's lead could not be read.
    #[error(transparent)]
    Agent(#[from] RunAgentReadError),
    /// A run's place at the memory gate refused what was asked of it.
    #[error(transparent)]
    Gate(#[from] MemoryAdmissionError),
    /// The queue stopped before the work asked of it answered.
    #[error("the run queue stopped before the work answered")]
    Stopped,
    /// A newer lead run took over the messages an interrupted run's continue was opening with.
    #[error("a newer lead run took over the messages of run {run_id}")]
    ContinueTakenOver {
        /// The interrupted run.
        run_id: RunId,
    },
}

impl From<RunRefusal> for QueueError {
    fn from(refusal: RunRefusal) -> Self {
        Self::Engine(refusal.into())
    }
}

impl From<QueueError> for HandlerError {
    /// A refusal answers the call by its code, a driver's as the driver's own; anything else is a
    /// fault inside the daemon.
    fn from(error: QueueError) -> Self {
        match error {
            QueueError::Refused(refusal) => Self::Refused(refusal),
            QueueError::Driver(driver) => driver.into(),
            QueueError::RunDriver(run_driver) => run_driver.into(),
            fault @ (QueueError::Read(_)
            | QueueError::Pool(_)
            | QueueError::Delivery(_)
            | QueueError::Write(_)
            | QueueError::Record(_)
            | QueueError::Engine(_)
            | QueueError::ProviderSession(_)
            | QueueError::Agent(_)
            | QueueError::Gate(_)
            | QueueError::Stopped
            | QueueError::ContinueTakenOver { .. }) => Self::Internal(Box::new(fault)),
        }
    }
}
