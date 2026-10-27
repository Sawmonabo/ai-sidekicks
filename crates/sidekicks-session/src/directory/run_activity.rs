//! A session's activity: `waiting` while any of its runs in `runs` or a plan's card waits on the
//! person, else `running` while any of its runs works, else how its last run ended, which each
//! run's end event writes to `sessions.last_run_outcome`. A run reads as it does until its state
//! changes.

use serde_json::{Map, Value};
use sidekicks_contracts::event::registry::SessionEventType;
use sidekicks_contracts::run::state::RunState;
use sidekicks_contracts::session::directory::SessionActivity;

use sidekicks_store::database::sql_list::sql_list_of;

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
        SessionEventType::AgentRunCompleted => Some(SessionActivity::Done),
        // A terminal the daemon's own close produced is never read as a crash.
        SessionEventType::AgentRunFailed => Some(
            if payload.get("intendedClose") == Some(&Value::Bool(true)) {
                SessionActivity::Idle
            } else {
                SessionActivity::Failed
            },
        ),
        SessionEventType::AgentRunInterrupted
        | SessionEventType::AgentRunStopped
        | SessionEventType::AgentRunPaused => Some(SessionActivity::Idle),
        SessionEventType::AgentRunQueued
        | SessionEventType::AgentRunStarting
        | SessionEventType::AgentRunRunning
        | SessionEventType::AgentRunWaitingForApproval
        | SessionEventType::AgentRunWaitingForInput
        | SessionEventType::AgentRunPausing
        | SessionEventType::AgentRunRolledBack
        | SessionEventType::AgentRunProviderInitialized
        | SessionEventType::AgentTurnStarted
        | SessionEventType::AgentTurnCompleted
        | SessionEventType::AgentTurnInterrupted
        | SessionEventType::AgentTurnFailed
        | SessionEventType::AgentRunWorkerShuttingDown
        | SessionEventType::AgentRunStepLimitReached
        | SessionEventType::AgentRunTokenLimitReached
        | SessionEventType::AgentRunRecoveryStepsAdded
        | SessionEventType::AgentRunRecoveryResolved
        | SessionEventType::AgentRunRefusalChoiceRequested
        | SessionEventType::AgentRunRefusalChoiceResolved
        | SessionEventType::AgentRunUsageCreditsChoiceRequested
        | SessionEventType::AgentRunUsageCreditsChoiceResolved
        | SessionEventType::AgentMessageSent
        | SessionEventType::AgentThinkingUpdated
        | SessionEventType::AgentToolCallInvoked
        | SessionEventType::AgentToolCallCompleted
        | SessionEventType::AgentToolCallFailed
        | SessionEventType::AgentSubagentStarted
        | SessionEventType::AgentSubagentCompleted
        | SessionEventType::AgentCommandEnded
        | SessionEventType::AgentQueueItemCreated
        | SessionEventType::AgentQueueItemAdmitted
        | SessionEventType::AgentQueueItemSuperseded
        | SessionEventType::AgentQueueItemCanceled
        | SessionEventType::AgentQueueItemNotDelivered
        | SessionEventType::AgentInterventionRequested
        | SessionEventType::AgentInterventionAccepted
        | SessionEventType::AgentInterventionApplied
        | SessionEventType::AgentInterventionRejected
        | SessionEventType::AgentInterventionDegraded
        | SessionEventType::AgentInterventionExpired
        | SessionEventType::AgentInterventionFailed
        | SessionEventType::UserMessageSent
        | SessionEventType::QuestionAsked
        | SessionEventType::QuestionOpened
        | SessionEventType::QuestionCanceled
        | SessionEventType::ArtifactPublished
        | SessionEventType::GitSettled
        | SessionEventType::SessionCreated
        | SessionEventType::SessionActivated
        | SessionEventType::SessionArchived
        | SessionEventType::SessionReactivated
        | SessionEventType::SessionClosed
        | SessionEventType::SessionGoalUpdated
        | SessionEventType::SessionGoalCleared
        | SessionEventType::SessionProviderStatusReported
        | SessionEventType::SessionNoticePosted
        | SessionEventType::SessionRenamed
        | SessionEventType::SessionPinned
        | SessionEventType::SessionUnpinned
        | SessionEventType::SessionMuted
        | SessionEventType::SessionUnmuted
        | SessionEventType::SessionConverted
        | SessionEventType::SessionSideQuestionAnswered
        | SessionEventType::SessionSpendLimitReached
        | SessionEventType::SessionRestoreCompleted
        | SessionEventType::SessionAdvisorChanged
        | SessionEventType::SessionOutputStyleChanged
        | SessionEventType::AgentProviderBindingChanged
        | SessionEventType::AgentProviderBindingChangeFailed
        | SessionEventType::WorkspacePreparing
        | SessionEventType::WorkspacePrepared
        | SessionEventType::WorkspaceRootLost
        | SessionEventType::WorkspaceArchived
        | SessionEventType::WorktreeCreated
        | SessionEventType::WorktreeBound
        | SessionEventType::WorktreeDirtied
        | SessionEventType::WorktreeMerged
        | SessionEventType::WorktreeRetired
        | SessionEventType::RepoMountHealthChanged
        | SessionEventType::SessionBranchChanged
        | SessionEventType::SessionSweptToCheckout
        | SessionEventType::TerminalControlChanged
        | SessionEventType::CloudTaskUpdated
        | SessionEventType::ApprovalRequested
        | SessionEventType::ApprovalApproved
        | SessionEventType::ApprovalRejected
        | SessionEventType::ApprovalCanceled
        | SessionEventType::ApprovalRuleRemembered
        | SessionEventType::ApprovalRuleRevoked
        | SessionEventType::ApprovalReviewerDenied
        | SessionEventType::ApprovalDenialOverridden
        | SessionEventType::ApprovalReviewerFlagged
        | SessionEventType::PlanProposed
        | SessionEventType::PlanAccepted
        | SessionEventType::PlanHandedOff
        | SessionEventType::PlanKept
        | SessionEventType::PlanHoldEnded
        | SessionEventType::UsageTokenCountRecorded
        | SessionEventType::UsageCostUpdated
        | SessionEventType::UsageContextWindowUpdated
        | SessionEventType::UsageRateLimitUpdated
        | SessionEventType::UsageApiRequestRetried
        | SessionEventType::AgentRunContextCompacted
        | SessionEventType::AgentTurnRerouted
        | SessionEventType::DaemonRecoveryAttempted
        | SessionEventType::DaemonRecoverySucceeded
        | SessionEventType::DaemonRecoveryFailed
        | SessionEventType::SessionDamagedEventsSkipped
        | SessionEventType::RelayPinRefused
        | SessionEventType::SessionEventCompacted
        | SessionEventType::DaemonBackupCompleted
        | SessionEventType::DaemonBackupFailed
        | SessionEventType::DaemonBackupRestored
        | SessionEventType::AgentRunRejected
        | SessionEventType::McpServerSignInCompleted
        | SessionEventType::WorkflowVersionCreated
        | SessionEventType::WorkflowRunStarted
        | SessionEventType::WorkflowGateReached
        | SessionEventType::WorkflowRunFailed
        | SessionEventType::WorkflowRunCompleted
        | SessionEventType::WorkflowRunResumed
        | SessionEventType::WorkflowRunCanceled
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
        | SessionEventType::WorkflowStepCompleted
        | SessionEventType::WorkflowStepFailed
        | SessionEventType::WorkflowStepCanceled
        | SessionEventType::WorkflowStepSkipped
        | SessionEventType::WorkflowParallelJoinBranchesCanceled
        | SessionEventType::WorkflowGateResolved => None,
    }
}

/// The SQL of a session's activity, from the session id's SQL, its `last_run_outcome`'s and the
/// condition under which a plan's card waits on the person: such a session reads waiting too,
/// since no run waits on the plan. Each run read is an indexed lookup of the session's runs.
pub fn session_activity_sql(
    session_id_sql: &str,
    last_run_outcome_sql: &str,
    waiting_plan_sql: &str,
) -> String {
    let is_any_run_in = |states: &[RunState]| {
        format!(
            "EXISTS (SELECT 1 FROM runs WHERE runs.session_id = {session_id_sql}
                AND runs.state IN ({}))",
            sql_list_of(states.iter().map(<&'static str>::from))
        )
    };
    let waiting = <&'static str>::from(SessionActivity::Waiting);
    let running = <&'static str>::from(SessionActivity::Running);
    format!(
        "CASE WHEN {} OR {waiting_plan_sql} THEN '{waiting}'
               WHEN {} THEN '{running}'
               ELSE {last_run_outcome_sql} END",
        is_any_run_in(&WAITING_RUN_STATES),
        is_any_run_in(&WORKING_RUN_STATES),
    )
}
