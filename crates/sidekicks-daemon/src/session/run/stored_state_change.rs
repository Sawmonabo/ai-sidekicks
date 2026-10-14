//! Reads a run state change back from the session event that stored it, for the readers that
//! follow the log as it commits.

use serde_json::Value;
use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::session::{SessionEvent, SessionEventReadError};
use sidekicks_contracts::run::events::{
    RunCompletedPayload, RunFailedPayload, RunInterruptedPayload, RunPausedPayload,
    RunPausingPayload, RunRunningPayload, RunStartingPayload, RunStateChangeState,
    RunStoppedPayload, RunWaitingForApprovalPayload, RunWaitingForInputPayload,
};
use sidekicks_contracts::run::id::RunId;

/// One stored run state change, whichever state it entered, with its payload as stored.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum StoredRunStateChange {
    /// `run.starting`.
    Starting(RunStartingPayload),
    /// `run.running`.
    Running(RunRunningPayload),
    /// `run.waiting_for_approval`.
    WaitingForApproval(RunWaitingForApprovalPayload),
    /// `run.waiting_for_input`.
    WaitingForInput(RunWaitingForInputPayload),
    /// `run.pausing`.
    Pausing(RunPausingPayload),
    /// `run.paused`.
    Paused(RunPausedPayload),
    /// `run.completed`.
    Completed(RunCompletedPayload),
    /// `run.interrupted`.
    Interrupted(RunInterruptedPayload),
    /// `run.stopped`.
    Stopped(RunStoppedPayload),
    /// `run.failed`.
    Failed(RunFailedPayload),
}

impl StoredRunStateChange {
    /// The run that changed state.
    pub(crate) fn run_id(&self) -> &RunId {
        match self {
            Self::Starting(payload) => &payload.run_id,
            Self::Running(payload) => &payload.run_id,
            Self::WaitingForApproval(payload) => &payload.run_id,
            Self::WaitingForInput(payload) => &payload.run_id,
            Self::Pausing(payload) => &payload.run_id,
            Self::Paused(payload) => &payload.run_id,
            Self::Completed(payload) => &payload.run_id,
            Self::Interrupted(payload) => &payload.run_id,
            Self::Stopped(payload) => &payload.run_id,
            Self::Failed(payload) => &payload.run_id,
        }
    }

    /// The state the run entered.
    pub(crate) fn new_state(&self) -> RunStateChangeState {
        match self {
            Self::Starting(_) => RunStateChangeState::Starting,
            Self::Running(_) => RunStateChangeState::Running,
            Self::WaitingForApproval(_) => RunStateChangeState::WaitingForApproval,
            Self::WaitingForInput(_) => RunStateChangeState::WaitingForInput,
            Self::Pausing(_) => RunStateChangeState::Pausing,
            Self::Paused(_) => RunStateChangeState::Paused,
            Self::Completed(_) => RunStateChangeState::Completed,
            Self::Interrupted(_) => RunStateChangeState::Interrupted,
            Self::Stopped(_) => RunStateChangeState::Stopped,
            Self::Failed(_) => RunStateChangeState::Failed,
        }
    }
}

/// The run state change `event` stored, or `None` for an event of any other type. Fails when the
/// payload does not read as its type's: the log is the daemon's own, so that is a broken write.
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "only the ten run state changes are read here, out of every session event"
)]
pub(crate) fn read_stored_run_state_change(
    event: &EventEnvelope,
) -> Result<Option<StoredRunStateChange>, SessionEventReadError> {
    // Only a state change's type is read further, so no other event's payload is parsed.
    let Some(state_word) = event.event_type.as_str().strip_prefix("run.") else {
        return Ok(None);
    };
    if serde_json::from_value::<RunStateChangeState>(Value::String(state_word.to_owned())).is_err()
    {
        return Ok(None);
    }
    Ok(match SessionEvent::from_envelope(event)? {
        SessionEvent::RunStarting(payload) => Some(StoredRunStateChange::Starting(payload)),
        SessionEvent::RunRunning(payload) => Some(StoredRunStateChange::Running(payload)),
        SessionEvent::RunWaitingForApproval(payload) => {
            Some(StoredRunStateChange::WaitingForApproval(payload))
        }
        SessionEvent::RunWaitingForInput(payload) => {
            Some(StoredRunStateChange::WaitingForInput(payload))
        }
        SessionEvent::RunPausing(payload) => Some(StoredRunStateChange::Pausing(payload)),
        SessionEvent::RunPaused(payload) => Some(StoredRunStateChange::Paused(payload)),
        SessionEvent::RunCompleted(payload) => Some(StoredRunStateChange::Completed(payload)),
        SessionEvent::RunInterrupted(payload) => Some(StoredRunStateChange::Interrupted(payload)),
        SessionEvent::RunStopped(payload) => Some(StoredRunStateChange::Stopped(payload)),
        SessionEvent::RunFailed(payload) => Some(StoredRunStateChange::Failed(payload)),
        // A state change's type reads as its own variant, so no other arm is reached.
        _ => None,
    })
}
