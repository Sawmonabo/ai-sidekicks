//! A session's activity: `waiting` while any of its runs in `runs` waits on the person, else
//! `running` while any of them works, else how its last run ended, which each run's end event
//! writes to `sessions.last_run_outcome`. A run reads as it does until its state changes.

use serde_json::{Map, Value};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::directory::SessionActivity;

use crate::database::sql_list::sql_list_of;

// The run states a session reads as waiting on the person, and those it reads as working.
const WAITING_RUN_STATES: [RunState; 2] = [RunState::WaitingForApproval, RunState::WaitingForInput];
const WORKING_RUN_STATES: [RunState; 3] =
    [RunState::Starting, RunState::Running, RunState::Pausing];

/// How a run event that ends a run's working time leaves its session, read from the event's
/// payload; `None` for every other event type. A paused run can go on, but its session reads idle
/// until it does.
pub(crate) fn run_outcome_of(
    event_type: SessionEventType,
    payload: &Map<String, Value>,
) -> Option<SessionActivity> {
    match event_type {
        SessionEventType::RunCompleted => Some(SessionActivity::Done),
        // A terminal the daemon's own close produced is never read as a crash.
        SessionEventType::RunFailed => Some(
            if payload.get("intendedClose") == Some(&Value::Bool(true)) {
                SessionActivity::Idle
            } else {
                SessionActivity::Failed
            },
        ),
        SessionEventType::RunInterrupted
        | SessionEventType::RunStopped
        | SessionEventType::RunPaused => Some(SessionActivity::Idle),
        SessionEventType::RunQueued
        | SessionEventType::RunStarting
        | SessionEventType::RunRunning
        | SessionEventType::RunWaitingForApproval
        | SessionEventType::RunWaitingForInput
        | SessionEventType::RunPausing
        | SessionEventType::RunRolledBack
        | SessionEventType::RunProviderInitialized
        | SessionEventType::RunTurnStarted
        | SessionEventType::RunWorkerShutdown
        | SessionEventType::RunStepLimitReached
        | SessionEventType::RunTokenLimitReached
        | SessionEventType::RunRecoveryStepsAdded
        | SessionEventType::RunRecoveryResolved
        | SessionEventType::RunRefusalChoiceRequested
        | SessionEventType::RunRefusalChoiceResolved
        | SessionEventType::RunUsageCreditsChoiceRequested
        | SessionEventType::RunUsageCreditsChoiceResolved
        | SessionEventType::AssistantMessage
        | SessionEventType::AssistantThinkingUpdate
        | SessionEventType::ToolInvoked
        | SessionEventType::ToolResult
        | SessionEventType::ToolError
        | SessionEventType::SubagentStarted
        | SessionEventType::SubagentCompleted
        | SessionEventType::CommandEnded
        | SessionEventType::QueueItemCreated
        | SessionEventType::QueueItemAdmitted
        | SessionEventType::QueueItemSuperseded
        | SessionEventType::QueueItemCanceled
        | SessionEventType::QueueItemNotDelivered
        | SessionEventType::InterventionRequested
        | SessionEventType::InterventionAccepted
        | SessionEventType::InterventionApplied
        | SessionEventType::InterventionRejected
        | SessionEventType::InterventionDegraded
        | SessionEventType::InterventionExpired
        | SessionEventType::InterventionFailed
        | SessionEventType::UserMessage
        | SessionEventType::QuestionAsked
        | SessionEventType::ArtifactPublished
        | SessionEventType::ArtifactSuperseded
        | SessionEventType::GitSettled
        | SessionEventType::SessionCreated
        | SessionEventType::SessionActivated
        | SessionEventType::SessionArchived
        | SessionEventType::SessionReactivated
        | SessionEventType::SessionClosed
        | SessionEventType::SessionGoalUpdated
        | SessionEventType::SessionGoalCleared
        | SessionEventType::SessionProviderStatus
        | SessionEventType::SessionNotice
        | SessionEventType::SessionRenamed
        | SessionEventType::SessionPinned
        | SessionEventType::SessionUnpinned
        | SessionEventType::SessionMuted
        | SessionEventType::SessionUnmuted
        | SessionEventType::SessionConverted
        | SessionEventType::SessionSideQuestionAnswered
        | SessionEventType::SessionSpendLimitReached
        | SessionEventType::SessionRestoreFinished
        | SessionEventType::SessionAdvisorChanged
        | SessionEventType::SessionOutputStyleChanged
        | SessionEventType::AgentProviderBindingChanged
        | SessionEventType::AgentProviderBindingChangeFailed
        | SessionEventType::WorkspacePreparing
        | SessionEventType::WorkspaceReady
        | SessionEventType::WorkspaceStale
        | SessionEventType::WorkspaceArchived
        | SessionEventType::WorktreeCreated
        | SessionEventType::WorktreeReady
        | SessionEventType::WorktreeDirty
        | SessionEventType::WorktreeMerged
        | SessionEventType::WorktreeRetired
        | SessionEventType::RepoMountHealthChanged
        | SessionEventType::SessionBranchChanged
        | SessionEventType::SessionSweptToRepoRoot
        | SessionEventType::PtyControlChanged
        | SessionEventType::CloudTaskUpdated
        | SessionEventType::ApprovalRequested
        | SessionEventType::ApprovalApproved
        | SessionEventType::ApprovalRejected
        | SessionEventType::ApprovalCanceled
        | SessionEventType::ApprovalRemembered
        | SessionEventType::ApprovalRuleRevoked
        | SessionEventType::ApprovalReviewerDenied
        | SessionEventType::ApprovalDenialOverridden
        | SessionEventType::ModerationReviewFlagged
        | SessionEventType::PlanProposed
        | SessionEventType::PlanAccepted
        | SessionEventType::PlanHandedOff
        | SessionEventType::UsageTokenCount
        | SessionEventType::UsageCostUpdate
        | SessionEventType::UsageContextWindowUpdate
        | SessionEventType::UsageRateLimitUpdate
        | SessionEventType::UsageApiRetry
        | SessionEventType::UsageContextCompacted
        | SessionEventType::UsageModelRerouted
        | SessionEventType::RecoveryAttempted
        | SessionEventType::RecoverySucceeded
        | SessionEventType::RecoveryFailed
        | SessionEventType::RecoveryDamagedEventsSkipped
        | SessionEventType::RelayPinRefused
        | SessionEventType::EventCompacted
        | SessionEventType::BackupCompleted
        | SessionEventType::BackupFailed
        | SessionEventType::BackupRestored
        | SessionEventType::OrchestrationRejected
        | SessionEventType::McpServerOauthCompleted
        | SessionEventType::WorkflowCreated
        | SessionEventType::WorkflowStarted
        | SessionEventType::WorkflowGated
        | SessionEventType::WorkflowFailed
        | SessionEventType::WorkflowCompleted
        | SessionEventType::WorkflowResumed
        | SessionEventType::WorkflowCanceled
        | SessionEventType::WorkflowRunWaiting
        | SessionEventType::WorkflowRunDeleted
        | SessionEventType::WorkflowScheduleArmed
        | SessionEventType::WorkflowScheduleFired
        | SessionEventType::WorkflowTriggerArmed
        | SessionEventType::WorkflowTriggerFired
        | SessionEventType::WorkflowResultsPosted
        | SessionEventType::WorkflowPhaseAdmitted
        | SessionEventType::WorkflowPhaseWaitingOnPool
        | SessionEventType::WorkflowPhaseStarted
        | SessionEventType::WorkflowPhaseProgressed
        | SessionEventType::WorkflowPhaseCanceling
        | SessionEventType::WorkflowPhaseFailed
        | SessionEventType::WorkflowPhaseRetried
        | SessionEventType::WorkflowPhaseSuspended
        | SessionEventType::WorkflowPhaseResumed
        | SessionEventType::WorkflowPhaseCompleted
        | SessionEventType::WorkflowStepStarted
        | SessionEventType::WorkflowStepFinished
        | SessionEventType::WorkflowStepFailed
        | SessionEventType::WorkflowStepCanceled
        | SessionEventType::WorkflowStepSkipped
        | SessionEventType::WorkflowParallelJoinCancellation
        | SessionEventType::WorkflowGateResolved => None,
    }
}

/// The SQL of a session's activity, from the session id's SQL and its `last_run_outcome`'s. Each
/// read is an indexed lookup of the session's runs.
pub(crate) fn session_activity_sql(session_id_sql: &str, last_run_outcome_sql: &str) -> String {
    let is_any_run_in = |states: &[RunState]| {
        format!(
            "EXISTS (SELECT 1 FROM runs WHERE runs.session_id = {session_id_sql}
                AND runs.state IN ({}))",
            sql_list_of(states.iter().map(<&'static str>::from))
        )
    };
    format!(
        "CASE WHEN {} THEN 'waiting'
               WHEN {} THEN 'running'
               ELSE {last_run_outcome_sql} END",
        is_any_run_in(&WAITING_RUN_STATES),
        is_any_run_in(&WORKING_RUN_STATES),
    )
}
