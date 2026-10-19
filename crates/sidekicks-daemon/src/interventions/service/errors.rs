//! The interventions service's failures: a dispatch's, which its row records, and the service's
//! own, which answers the caller.

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::intervention::{InterventionId, InterventionState};
use sidekicks_contracts::wire::text::TextError;

use crate::database::connection::read_pool::DatabaseReadError;
use crate::error_description::describe_error;
use crate::events::session::appender::{SessionEventAppendError, SessionEventDraftError};
use crate::interventions::interrupt_queue::InterruptQueueError;
use crate::ipc::domain_error::DomainError;
use crate::ipc::registry::HandlerError;
use crate::provider::driver::contract::DriverError;
use crate::provider::driver::error_causes::RequestUnanswered;
use crate::session::run::engine::RunEngineError;
use crate::settle_all::SettleFailures;

/// Why a dispatch threw or could not run; its row moves to `failed` with a refusal's code, else
/// its description.
#[derive(Debug, thiserror::Error)]
pub(crate) enum DispatchError {
    /// A refusal with a code: the run has no row or no driver, or its provider answers no
    /// driver.
    #[error(transparent)]
    Refused(#[from] DomainError),
    /// The driver failed.
    #[error(transparent)]
    Driver(DriverError),
    /// The run engine's route or read failed.
    #[error(transparent)]
    Engine(RunEngineError),
    /// The retry's refusal gave a reason that is no machine-readable cause.
    #[error("the retry's refusal gave a reason that cannot be recorded")]
    RejectionReason(#[source] TextError),
    /// A token or spend limit's run ended and was continued before the dispatch, so the continued
    /// run's own stop cuts it.
    #[error("the run ended and was continued before the dispatch")]
    RunContinued,
}

impl From<rusqlite::Error> for DispatchError {
    /// A read the run engine would have made, kept whole as its failure.
    fn from(error: rusqlite::Error) -> Self {
        Self::Engine(error.into())
    }
}

impl From<DatabaseReadError> for DispatchError {
    /// A read the pool did not run, kept whole as the run engine's failure.
    fn from(error: DatabaseReadError) -> Self {
        Self::Engine(error.into())
    }
}

impl From<RunEngineError> for DispatchError {
    /// A refusal keeps its code; any other engine failure is kept whole.
    fn from(error: RunEngineError) -> Self {
        match error {
            RunEngineError::Refused(refusal) => Self::Refused(refusal.into()),
            RunEngineError::Provider(refusal) => Self::Refused(refusal),
            error @ (RunEngineError::Change { .. }
            | RunEngineError::Released { .. }
            | RunEngineError::Gate { .. }
            | RunEngineError::NoResolvedPosture { .. }
            | RunEngineError::Driver { .. }
            | RunEngineError::LimitInterrupterGone { .. }
            | RunEngineError::LimitInterrupt { .. }
            | RunEngineError::DaemonTurn { .. }
            | RunEngineError::Agent { .. }
            | RunEngineError::Draft { .. }
            | RunEngineError::Append { .. }
            | RunEngineError::Read { .. }
            | RunEngineError::Pool { .. }
            | RunEngineError::Several { .. }) => Self::Engine(error),
        }
    }
}

/// Why the service did not answer an intervention; what each step wrote before the failure is
/// kept.
#[derive(Debug, thiserror::Error)]
pub(crate) enum InterventionError {
    /// A refusal with a code: an unknown run, or a reused key with another request.
    #[error(transparent)]
    Refused(DomainError),
    /// The insert was refused on a spent key, and the row saved under it cannot be read back.
    #[error("the intervention saved under key {key} on run {run_id} cannot be read back")]
    Unsaved {
        /// The run.
        run_id: RunId,
        /// The spent key.
        key: String,
    },
    /// A rejected or failed row holds no reason.
    #[error(
        "intervention {intervention_id} ended {} with no reason",
        <&'static str>::from(*.state)
    )]
    Unreasoned {
        /// The intervention.
        intervention_id: InterventionId,
        /// Its state.
        state: InterventionState,
    },
    /// An intervention's event breaks a check of its type.
    #[error("the intervention's event could not be drafted")]
    Draft(#[from] SessionEventDraftError),
    /// The event log did not keep a step's write.
    #[error("the intervention's step was not recorded")]
    Append(#[from] SessionEventAppendError),
    /// A read or the run's end failed.
    #[error(transparent)]
    Engine(#[from] RunEngineError),
    /// The run queue's part in an interrupt failed.
    #[error("the run queue failed its part in the interrupt")]
    Queue(#[source] InterruptQueueError),
    /// The dispatch threw, and the write recording its failure did not land.
    #[error(
        "intervention {intervention_id} failed in dispatch ({}), and recording it failed too",
        describe_error(dispatch)
    )]
    Unrecorded {
        /// The intervention.
        intervention_id: InterventionId,
        /// What the dispatch threw.
        dispatch: DispatchError,
        /// Why the failure was not recorded.
        #[source]
        record: SessionEventAppendError,
    },
    /// A step failed and so did the release of the queue's hold after it, both kept.
    #[error(transparent)]
    Several(Box<SettleFailures<InterventionError>>),
}

impl From<InterventionError> for HandlerError {
    /// A refusal answers by its code, the run engine's included (an unknown run); the rest are
    /// faults in the daemon, since a dispatch that threw answers its row `failed` rather than
    /// failing the call.
    fn from(error: InterventionError) -> Self {
        match error {
            InterventionError::Refused(refusal)
            | InterventionError::Engine(RunEngineError::Provider(refusal)) => {
                Self::Refused(refusal)
            }
            InterventionError::Engine(RunEngineError::Refused(refusal)) => {
                Self::Refused(refusal.into())
            }
            fault @ (InterventionError::Unsaved { .. }
            | InterventionError::Unreasoned { .. }
            | InterventionError::Draft(_)
            | InterventionError::Append(_)
            | InterventionError::Engine(
                RunEngineError::Change(_)
                | RunEngineError::Released(_)
                | RunEngineError::Gate { .. }
                | RunEngineError::NoResolvedPosture { .. }
                | RunEngineError::Driver { .. }
                | RunEngineError::LimitInterrupterGone { .. }
                | RunEngineError::LimitInterrupt { .. }
                | RunEngineError::DaemonTurn(_)
                | RunEngineError::Agent(_)
                | RunEngineError::Draft(_)
                | RunEngineError::Append(_)
                | RunEngineError::Read(_)
                | RunEngineError::Pool(_)
                | RunEngineError::Several(_),
            )
            | InterventionError::Queue(_)
            | InterventionError::Unrecorded { .. }
            | InterventionError::Several(_)) => Self::Internal(Box::new(fault)),
        }
    }
}

/// What a dispatch failure records: a refusal's code, else its description.
pub(super) fn failure_text_of(error: &DispatchError) -> String {
    match error {
        DispatchError::Refused(refusal)
        | DispatchError::Driver(
            DriverError::Refused(refusal) | DriverError::Unanswered(RequestUnanswered { refusal }),
        ) => refusal.code.as_str().to_owned(),
        DispatchError::Driver(_)
        | DispatchError::Engine(_)
        | DispatchError::RejectionReason(_)
        | DispatchError::RunContinued => describe_error(error),
    }
}
