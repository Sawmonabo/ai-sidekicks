//! Reads a run state change back from the session event that stored it, for the readers that
//! follow the log as it commits.

use sidekicks_contracts::event::envelope::EventEnvelope;
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::event::session::{SessionEvent, SessionEventReadError};
use sidekicks_contracts::run::events::{
    AgentRunCompletedPayload, AgentRunFailedPayload, AgentRunInterruptedPayload,
    AgentRunPausedPayload, AgentRunPausingPayload, AgentRunRunningPayload, AgentRunStartingPayload,
    AgentRunStoppedPayload, AgentRunWaitingForApprovalPayload, AgentRunWaitingForInputPayload,
    RunStateChangeState,
};
use sidekicks_contracts::run::id::RunId;

/// One stored run state change, whichever state it entered, with its payload as stored.
#[expect(
    dead_code,
    reason = "the run state subscription replays and follows each stored state change"
)]
#[derive(Clone, Debug, PartialEq)]
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

#[expect(
    dead_code,
    reason = "the run state subscription replays and follows each stored state change"
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

/// The run state change `event` stored, or `None` for an event of any other type. Fails when the
/// payload does not read as its type's: the log is the daemon's own, so that is a broken write.
#[expect(
    dead_code,
    reason = "the run state subscription replays and follows each stored state change"
)]
pub(crate) fn read_stored_run_state_change(
    event: &EventEnvelope,
) -> Result<Option<StoredRunStateChange>, SessionEventReadError> {
    // Only a state change's type is read further, so no other event's payload is parsed.
    let is_state_change = matches!(
        SessionEventType::from_wire_name(event.event_type.as_str()),
        Some(
            SessionEventType::AgentRunStarting
                | SessionEventType::AgentRunRunning
                | SessionEventType::AgentRunWaitingForApproval
                | SessionEventType::AgentRunWaitingForInput
                | SessionEventType::AgentRunPausing
                | SessionEventType::AgentRunPaused
                | SessionEventType::AgentRunCompleted
                | SessionEventType::AgentRunInterrupted
                | SessionEventType::AgentRunStopped
                | SessionEventType::AgentRunFailed
        )
    );
    if !is_state_change {
        return Ok(None);
    }
    Ok(match SessionEvent::from_envelope(event)? {
        SessionEvent::AgentRunStarting(payload) => Some(StoredRunStateChange::Starting(payload)),
        SessionEvent::AgentRunRunning(payload) => Some(StoredRunStateChange::Running(payload)),
        SessionEvent::AgentRunWaitingForApproval(payload) => {
            Some(StoredRunStateChange::WaitingForApproval(payload))
        }
        SessionEvent::AgentRunWaitingForInput(payload) => {
            Some(StoredRunStateChange::WaitingForInput(payload))
        }
        SessionEvent::AgentRunPausing(payload) => Some(StoredRunStateChange::Pausing(payload)),
        SessionEvent::AgentRunPaused(payload) => Some(StoredRunStateChange::Paused(payload)),
        SessionEvent::AgentRunCompleted(payload) => Some(StoredRunStateChange::Completed(payload)),
        SessionEvent::AgentRunInterrupted(payload) => {
            Some(StoredRunStateChange::Interrupted(payload))
        }
        SessionEvent::AgentRunStopped(payload) => Some(StoredRunStateChange::Stopped(payload)),
        SessionEvent::AgentRunFailed(payload) => Some(StoredRunStateChange::Failed(payload)),
        // A state change's type reads as its own variant, so no other arm is reached.
        SessionEvent::SessionCreated(_)
        | SessionEvent::WorkspacePreparing(_)
        | SessionEvent::WorkspacePrepared(_)
        | SessionEvent::WorkspaceRootLost(_)
        | SessionEvent::WorkspaceArchived(_)
        | SessionEvent::WorktreeCreated(_)
        | SessionEvent::WorktreeBound(_)
        | SessionEvent::WorktreeDirtied(_)
        | SessionEvent::WorktreeMerged(_)
        | SessionEvent::WorktreeRetired(_)
        | SessionEvent::SessionEventCompacted(_)
        | SessionEvent::AgentMessageSent(_)
        | SessionEvent::AgentThinkingUpdated(_)
        | SessionEvent::AgentToolCallInvoked(_)
        | SessionEvent::AgentToolCallCompleted(_)
        | SessionEvent::AgentToolCallFailed(_)
        | SessionEvent::AgentSubagentStarted(_)
        | SessionEvent::AgentSubagentCompleted(_)
        | SessionEvent::AgentRunProviderInitialized(_)
        | SessionEvent::AgentTurnStarted(_)
        | SessionEvent::AgentRunWorkerShuttingDown(_)
        | SessionEvent::AgentRunRolledBack(_)
        | SessionEvent::SessionProviderStatusReported(_)
        | SessionEvent::ApprovalRejected(_)
        | SessionEvent::ApprovalCanceled(_)
        | SessionEvent::ApprovalRuleRemembered(_)
        | SessionEvent::ApprovalRuleRevoked(_)
        | SessionEvent::ApprovalReviewerFlagged(_)
        | SessionEvent::PlanProposed(_)
        | SessionEvent::PlanAccepted(_)
        | SessionEvent::PlanHandedOff(_)
        | SessionEvent::QuestionAsked(_)
        | SessionEvent::UserMessageSent(_)
        | SessionEvent::AgentQueueItemCreated(_)
        | SessionEvent::AgentQueueItemAdmitted(_)
        | SessionEvent::AgentQueueItemSuperseded(_)
        | SessionEvent::AgentQueueItemCanceled(_)
        | SessionEvent::AgentQueueItemNotDelivered(_)
        | SessionEvent::McpServerSignInCompleted(_)
        | SessionEvent::CloudTaskUpdated(_)
        | SessionEvent::SessionRestoreCompleted(_)
        | SessionEvent::SessionGoalCleared(_)
        | SessionEvent::SessionNoticePosted(_)
        | SessionEvent::SessionSideQuestionAnswered(_)
        | SessionEvent::SessionSpendLimitReached(_)
        | SessionEvent::GitSettled(_)
        | SessionEvent::RelayPinRefused(_)
        | SessionEvent::AgentCommandEnded(_)
        | SessionEvent::UsageTokenCountRecorded(_)
        | SessionEvent::UsageCostUpdated(_)
        | SessionEvent::UsageContextWindowUpdated(_)
        | SessionEvent::UsageRateLimitUpdated(_)
        | SessionEvent::UsageApiRequestRetried(_)
        | SessionEvent::AgentRunContextCompacted(_)
        | SessionEvent::AgentTurnRerouted(_)
        | SessionEvent::SessionActivated(_)
        | SessionEvent::SessionArchived(_)
        | SessionEvent::SessionReactivated(_)
        | SessionEvent::SessionClosed(_)
        | SessionEvent::SessionPinned(_)
        | SessionEvent::SessionUnpinned(_)
        | SessionEvent::SessionMuted(_)
        | SessionEvent::SessionUnmuted(_)
        | SessionEvent::SessionConverted(_)
        | SessionEvent::SessionBranchChanged(_)
        | SessionEvent::SessionSweptToCheckout(_)
        | SessionEvent::AgentProviderBindingChanged(_)
        | SessionEvent::AgentProviderBindingChangeFailed(_)
        | SessionEvent::ApprovalRequested(_)
        | SessionEvent::ApprovalApproved(_)
        | SessionEvent::ApprovalReviewerDenied(_)
        | SessionEvent::ApprovalDenialOverridden(_)
        | SessionEvent::AgentRunQueued(_)
        | SessionEvent::AgentRunStepLimitReached(_)
        | SessionEvent::AgentRunTokenLimitReached(_)
        | SessionEvent::AgentRunRecoveryResolved(_)
        | SessionEvent::AgentRunRecoveryStepsAdded(_)
        | SessionEvent::SessionAdvisorChanged(_)
        | SessionEvent::SessionOutputStyleChanged(_)
        | SessionEvent::RepoMountHealthChanged(_)
        | SessionEvent::AgentRunRejected(_)
        | SessionEvent::ArtifactPublished(_)
        | SessionEvent::ArtifactSuperseded(_)
        | SessionEvent::AgentRunRefusalChoiceRequested(_)
        | SessionEvent::AgentRunRefusalChoiceResolved(_)
        | SessionEvent::AgentRunUsageCreditsChoiceRequested(_)
        | SessionEvent::AgentRunUsageCreditsChoiceResolved(_)
        | SessionEvent::SessionGoalUpdated(_)
        | SessionEvent::SessionRenamed(_)
        | SessionEvent::TerminalControlChanged(_)
        | SessionEvent::WorkflowRunStarted(_)
        | SessionEvent::WorkflowRunResumed(_)
        | SessionEvent::WorkflowRunCanceled(_)
        | SessionEvent::WorkflowRunDeleted(_)
        | SessionEvent::WorkflowResultsPosted(_)
        | SessionEvent::WorkflowPhaseSuspended(_)
        | SessionEvent::WorkflowPhaseFailed(_)
        | SessionEvent::WorkflowPhaseWaitingOnPool(_)
        | SessionEvent::WorkflowStepStarted(_)
        | SessionEvent::WorkflowStepCompleted(_)
        | SessionEvent::WorkflowStepFailed(_)
        | SessionEvent::WorkflowStepCanceled(_)
        | SessionEvent::WorkflowStepSkipped(_)
        | SessionEvent::WorkflowGateResolved(_)
        | SessionEvent::WorkflowVersionCreated(_)
        | SessionEvent::WorkflowGateReached(_)
        | SessionEvent::WorkflowRunFailed(_)
        | SessionEvent::WorkflowRunCompleted(_)
        | SessionEvent::WorkflowRunWaiting(_)
        | SessionEvent::WorkflowScheduleArmed(_)
        | SessionEvent::WorkflowScheduleFired(_)
        | SessionEvent::WorkflowTriggerArmed(_)
        | SessionEvent::WorkflowTriggerFired(_)
        | SessionEvent::WorkflowPhaseAdmitted(_)
        | SessionEvent::WorkflowPhaseStarted(_)
        | SessionEvent::WorkflowPhaseProgressed(_)
        | SessionEvent::WorkflowPhaseCanceling(_)
        | SessionEvent::WorkflowPhaseRetried(_)
        | SessionEvent::WorkflowPhaseResumed(_)
        | SessionEvent::WorkflowPhaseCompleted(_)
        | SessionEvent::WorkflowParallelJoinBranchesCanceled(_)
        | SessionEvent::DaemonBackupCompleted(_)
        | SessionEvent::DaemonBackupFailed(_)
        | SessionEvent::DaemonBackupRestored(_)
        | SessionEvent::DaemonRecoveryAttempted(_)
        | SessionEvent::DaemonRecoverySucceeded(_)
        | SessionEvent::DaemonRecoveryFailed(_)
        | SessionEvent::SessionDamagedEventsSkipped(_)
        | SessionEvent::AgentInterventionRequested(_)
        | SessionEvent::AgentInterventionAccepted(_)
        | SessionEvent::AgentInterventionApplied(_)
        | SessionEvent::AgentInterventionRejected(_)
        | SessionEvent::AgentInterventionDegraded(_)
        | SessionEvent::AgentInterventionExpired(_)
        | SessionEvent::AgentInterventionFailed(_) => None,
    })
}
