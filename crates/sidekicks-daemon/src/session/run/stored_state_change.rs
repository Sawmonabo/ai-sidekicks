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
    /// `agent.run.starting`.
    Starting(RunStartingPayload),
    /// `agent.run.running`.
    Running(RunRunningPayload),
    /// `agent.run.waitingForApproval`.
    WaitingForApproval(RunWaitingForApprovalPayload),
    /// `agent.run.waitingForInput`.
    WaitingForInput(RunWaitingForInputPayload),
    /// `agent.run.pausing`.
    Pausing(RunPausingPayload),
    /// `agent.run.paused`.
    Paused(RunPausedPayload),
    /// `agent.run.completed`.
    Completed(RunCompletedPayload),
    /// `agent.run.interrupted`.
    Interrupted(RunInterruptedPayload),
    /// `agent.run.stopped`.
    Stopped(RunStoppedPayload),
    /// `agent.run.failed`.
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
        SessionEvent::SessionCreated(_)
        | SessionEvent::WorkspacePreparing(_)
        | SessionEvent::WorkspaceReady(_)
        | SessionEvent::WorkspaceRootLost(_)
        | SessionEvent::WorkspaceArchived(_)
        | SessionEvent::WorktreeCreated(_)
        | SessionEvent::WorktreeReady(_)
        | SessionEvent::WorktreeDirty(_)
        | SessionEvent::WorktreeMerged(_)
        | SessionEvent::WorktreeRetired(_)
        | SessionEvent::EventCompacted(_)
        | SessionEvent::AssistantMessage(_)
        | SessionEvent::AssistantThinkingUpdate(_)
        | SessionEvent::ToolInvoked(_)
        | SessionEvent::ToolResult(_)
        | SessionEvent::ToolError(_)
        | SessionEvent::SubagentStarted(_)
        | SessionEvent::SubagentCompleted(_)
        | SessionEvent::RunProviderInitialized(_)
        | SessionEvent::RunTurnStarted(_)
        | SessionEvent::RunWorkerShutdown(_)
        | SessionEvent::RunRolledBack(_)
        | SessionEvent::SessionProviderStatus(_)
        | SessionEvent::ApprovalRejected(_)
        | SessionEvent::ApprovalCanceled(_)
        | SessionEvent::ApprovalRemembered(_)
        | SessionEvent::ApprovalRuleRevoked(_)
        | SessionEvent::ModerationReviewFlagged(_)
        | SessionEvent::PlanProposed(_)
        | SessionEvent::PlanAccepted(_)
        | SessionEvent::PlanHandedOff(_)
        | SessionEvent::QuestionAsked(_)
        | SessionEvent::UserMessage(_)
        | SessionEvent::QueueItemCreated(_)
        | SessionEvent::QueueItemAdmitted(_)
        | SessionEvent::QueueItemSuperseded(_)
        | SessionEvent::QueueItemCanceled(_)
        | SessionEvent::QueueItemNotDelivered(_)
        | SessionEvent::McpServerOauthCompleted(_)
        | SessionEvent::CloudTaskUpdated(_)
        | SessionEvent::SessionRestoreFinished(_)
        | SessionEvent::SessionGoalCleared(_)
        | SessionEvent::SessionNotice(_)
        | SessionEvent::SessionSideQuestionAnswered(_)
        | SessionEvent::SessionSpendLimitReached(_)
        | SessionEvent::GitSettled(_)
        | SessionEvent::RelayPinRefused(_)
        | SessionEvent::CommandEnded(_)
        | SessionEvent::UsageTokenCount(_)
        | SessionEvent::UsageCostUpdate(_)
        | SessionEvent::UsageContextWindowUpdate(_)
        | SessionEvent::UsageRateLimitUpdate(_)
        | SessionEvent::UsageApiRetry(_)
        | SessionEvent::UsageContextCompacted(_)
        | SessionEvent::UsageModelRerouted(_)
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
        | SessionEvent::SessionSweptToRepoRoot(_)
        | SessionEvent::AgentProviderBindingChanged(_)
        | SessionEvent::AgentProviderBindingChangeFailed(_)
        | SessionEvent::ApprovalRequested(_)
        | SessionEvent::ApprovalApproved(_)
        | SessionEvent::ApprovalReviewerDenied(_)
        | SessionEvent::ApprovalDenialOverridden(_)
        | SessionEvent::RunQueued(_)
        | SessionEvent::RunStepLimitReached(_)
        | SessionEvent::RunTokenLimitReached(_)
        | SessionEvent::RunRecoveryResolved(_)
        | SessionEvent::RunRecoveryStepsAdded(_)
        | SessionEvent::SessionAdvisorChanged(_)
        | SessionEvent::SessionOutputStyleChanged(_)
        | SessionEvent::RepoMountHealthChanged(_)
        | SessionEvent::OrchestrationRejected(_)
        | SessionEvent::ArtifactPublished(_)
        | SessionEvent::ArtifactSuperseded(_)
        | SessionEvent::RunRefusalChoiceRequested(_)
        | SessionEvent::RunRefusalChoiceResolved(_)
        | SessionEvent::RunUsageCreditsChoiceRequested(_)
        | SessionEvent::RunUsageCreditsChoiceResolved(_)
        | SessionEvent::SessionGoalUpdated(_)
        | SessionEvent::SessionRenamed(_)
        | SessionEvent::PtyControlChanged(_)
        | SessionEvent::WorkflowStarted(_)
        | SessionEvent::WorkflowResumed(_)
        | SessionEvent::WorkflowCanceled(_)
        | SessionEvent::WorkflowRunDeleted(_)
        | SessionEvent::WorkflowResultsPosted(_)
        | SessionEvent::WorkflowPhaseSuspended(_)
        | SessionEvent::WorkflowPhaseFailed(_)
        | SessionEvent::WorkflowPhaseWaitingOnPool(_)
        | SessionEvent::WorkflowStepStarted(_)
        | SessionEvent::WorkflowStepFinished(_)
        | SessionEvent::WorkflowStepFailed(_)
        | SessionEvent::WorkflowStepCanceled(_)
        | SessionEvent::WorkflowStepSkipped(_)
        | SessionEvent::WorkflowGateResolved(_)
        | SessionEvent::WorkflowCreated(_)
        | SessionEvent::WorkflowGated(_)
        | SessionEvent::WorkflowFailed(_)
        | SessionEvent::WorkflowCompleted(_)
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
        | SessionEvent::WorkflowParallelJoinCancellation(_)
        | SessionEvent::BackupCompleted(_)
        | SessionEvent::BackupFailed(_)
        | SessionEvent::BackupRestored(_)
        | SessionEvent::RecoveryAttempted(_)
        | SessionEvent::RecoverySucceeded(_)
        | SessionEvent::RecoveryFailed(_)
        | SessionEvent::RecoveryDamagedEventsSkipped(_)
        | SessionEvent::InterventionRequested(_)
        | SessionEvent::InterventionAccepted(_)
        | SessionEvent::InterventionApplied(_)
        | SessionEvent::InterventionRejected(_)
        | SessionEvent::InterventionDegraded(_)
        | SessionEvent::InterventionExpired(_)
        | SessionEvent::InterventionFailed(_) => None,
    })
}
