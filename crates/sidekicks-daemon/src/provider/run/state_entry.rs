//! The run state change a driver reports: the state the run enters with what that state's event
//! carries, and the expected state and failure category the driver decided it from. The run engine
//! builds the whole write from it.

use sidekicks_contracts::orchestration::InterruptReason;
use sidekicks_contracts::provider::driver::capabilities::ExecutionPosture;
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_FAILURE_DETAIL_MAX_LEN;
use sidekicks_contracts::run::control::{ProcessExit, RunFailureCategory, StopTrigger};
use sidekicks_contracts::run::events::RunStateChangeState;
use sidekicks_contracts::run::failure_cause::RunFailureCause;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::wire::True;
use sidekicks_contracts::wire::text::FreeFormText;

/// The state a change enters, with what that state's event carries beyond the transition itself.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum RunStateEntry {
    /// Into `starting`.
    Starting,
    /// Into `running`, stamped with the effective posture where it is final.
    Running {
        /// The effective posture, with the workspace root resolved.
        execution_posture: Option<ExecutionPosture>,
    },
    /// Into `waitingForApproval`.
    WaitingForApproval,
    /// Into `waitingForInput`.
    WaitingForInput,
    /// Into `pausing`.
    Pausing,
    /// Into `paused`.
    Paused,
    /// Into `completed`.
    Completed {
        /// Set only on a terminal the daemon itself closed.
        intended_close: Option<True>,
    },
    /// Into `interrupted`.
    Interrupted {
        /// Set only on a terminal the daemon itself closed.
        intended_close: Option<True>,
        /// Why the daemon itself interrupted the run; `None` for a person's interrupt.
        trigger: Option<InterruptReason>,
    },
    /// Into `stopped`.
    Stopped {
        /// Set only on a terminal the daemon itself closed.
        intended_close: Option<True>,
        /// Why the daemon itself stopped the run.
        trigger: Option<StopTrigger>,
    },
    /// Into `failed`.
    Failed {
        /// Set only on a terminal the daemon itself closed.
        intended_close: Option<True>,
        /// The run's typed failure cause.
        failure_cause: Option<RunFailureCause>,
        /// The provider's own words on why it failed the run.
        provider_failure_detail: Option<FreeFormText<PROVIDER_FAILURE_DETAIL_MAX_LEN>>,
        /// How the provider process ended under the turn, where it ended on its own.
        process_exit: Option<ProcessExit>,
    },
}

impl RunStateEntry {
    /// The state the change enters.
    pub(crate) fn state(&self) -> RunStateChangeState {
        match self {
            Self::Starting => RunStateChangeState::Starting,
            Self::Running { .. } => RunStateChangeState::Running,
            Self::WaitingForApproval => RunStateChangeState::WaitingForApproval,
            Self::WaitingForInput => RunStateChangeState::WaitingForInput,
            Self::Pausing => RunStateChangeState::Pausing,
            Self::Paused => RunStateChangeState::Paused,
            Self::Completed { .. } => RunStateChangeState::Completed,
            Self::Interrupted { .. } => RunStateChangeState::Interrupted,
            Self::Stopped { .. } => RunStateChangeState::Stopped,
            Self::Failed { .. } => RunStateChangeState::Failed,
        }
    }
}

/// One state change a driver reports on a run: the state it enters with what that state's event
/// carries, and the failure category it carries. With `expected_state`, the change is refused
/// unless the run is in that state when it is read.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RunStateReport {
    /// The run.
    pub(crate) run_id: RunId,
    /// The state the run must be in when it is read, where the driver decided from one.
    pub(crate) expected_state: Option<RunState>,
    /// Why the run failed.
    pub(crate) failure_category: Option<RunFailureCategory>,
    /// The state it enters and that state's own members.
    pub(crate) entry: RunStateEntry,
}

impl RunStateReport {
    /// A change of `run_id` into `entry`, from whatever state it is in, with no failure category.
    pub(crate) fn new(run_id: RunId, entry: RunStateEntry) -> Self {
        Self {
            run_id,
            expected_state: None,
            failure_category: None,
            entry,
        }
    }
}
