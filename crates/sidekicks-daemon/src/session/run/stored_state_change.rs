//! Reads a run state change back from the session event that stored it, for the readers that
//! follow the log as it commits.

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use sidekicks_contracts::event::session::SessionEventReadError;
use sidekicks_contracts::run::events::{
    AgentRunCompletedPayload, AgentRunFailedPayload, AgentRunInterruptedPayload,
    AgentRunPausedPayload, AgentRunPausingPayload, AgentRunRunningPayload, AgentRunStartingPayload,
    AgentRunStoppedPayload, AgentRunWaitingForApprovalPayload, AgentRunWaitingForInputPayload,
    RunStateChangeState,
};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::transcript::run_facts::RunStateEventType;

/// One stored run state change, whichever state it entered, with its payload as stored.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run state reply, which reads each stored change for the run state stream \
                  it sends"
    )
)]
pub(crate) enum StoredRunStateChange {
    /// `agent.run.starting`.
    Starting(AgentRunStartingPayload),
    /// `agent.run.running`.
    Running(AgentRunRunningPayload),
    /// `agent.run.waitingForApproval`.
    WaitingForApproval(AgentRunWaitingForApprovalPayload),
    /// `agent.run.waitingForInput`.
    WaitingForInput(AgentRunWaitingForInputPayload),
    /// `agent.run.pausing`.
    Pausing(AgentRunPausingPayload),
    /// `agent.run.paused`.
    Paused(AgentRunPausedPayload),
    /// `agent.run.completed`.
    Completed(AgentRunCompletedPayload),
    /// `agent.run.interrupted`.
    Interrupted(AgentRunInterruptedPayload),
    /// `agent.run.stopped`.
    Stopped(AgentRunStoppedPayload),
    /// `agent.run.failed`.
    Failed(AgentRunFailedPayload),
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the queue's run lifecycle, and the daemon's start handing committed changes to \
                  the run binding cursors"
    )
)]
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

/// The run state change an event of `event_type` stored with `payload`, or `None` for an event of
/// any other type; it reads a stored envelope and a committed one alike, checking the payload's
/// shape and its type's rules. Fails when the payload does not read as its type's: the log is the
/// daemon's own, so that is a broken write.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the run state reply, and the daemon's start handing committed changes to the \
                  run binding cursors"
    )
)]
pub(crate) fn read_stored_run_state_change(
    event_type: &str,
    payload: &Map<String, Value>,
) -> Result<Option<StoredRunStateChange>, SessionEventReadError> {
    // Only a state change's type is read further, so no other event's payload is parsed.
    let Some(state_event_type) = RunStateEventType::from_wire_name(event_type) else {
        return Ok(None);
    };
    Ok(Some(match state_event_type {
        RunStateEventType::Queued => return Ok(None),
        RunStateEventType::Starting => StoredRunStateChange::Starting(read_payload(payload)?),
        RunStateEventType::Running => StoredRunStateChange::Running(read_payload(payload)?),
        RunStateEventType::WaitingForApproval => {
            StoredRunStateChange::WaitingForApproval(read_payload(payload)?)
        }
        RunStateEventType::WaitingForInput => {
            StoredRunStateChange::WaitingForInput(read_payload(payload)?)
        }
        RunStateEventType::Pausing => StoredRunStateChange::Pausing(read_payload(payload)?),
        RunStateEventType::Paused => StoredRunStateChange::Paused(read_payload(payload)?),
        RunStateEventType::Completed => StoredRunStateChange::Completed(read_payload(payload)?),
        RunStateEventType::Interrupted => StoredRunStateChange::Interrupted(read_payload(payload)?),
        RunStateEventType::Stopped => StoredRunStateChange::Stopped(read_payload(payload)?),
        RunStateEventType::Failed => StoredRunStateChange::Failed(read_payload(payload)?),
    }))
}

// `payload` read as its type's payload and held to that type's checks.
fn read_payload<Payload>(payload: &Map<String, Value>) -> Result<Payload, SessionEventReadError>
where
    Payload: DeserializeOwned + garde::Validate<Context = ()>,
{
    let read = Payload::deserialize(payload)?;
    read.validate()?;
    Ok(read)
}
