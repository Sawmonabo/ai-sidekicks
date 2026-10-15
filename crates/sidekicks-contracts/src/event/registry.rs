//! The closed set of session event types, grouped by category. A type's wire name is an immutable
//! identifier, never renamed, and its category is the group it is listed in here, not its prefix:
//! `relay.pin_refused` is `security_events`, `plan.*` is `approval_flow`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::event::envelope::EventCategory;
use crate::typescript::{Definition, TypeScriptModule};

/// Declares [`SessionEventType`] from one table grouped by category, with its wire names, each
/// type's category and one list per category, so the three cannot disagree.
macro_rules! session_event_types {
    ($(
        $(#[doc = $list_doc:literal])+
        $list:ident = $category:ident [$($variant:ident = $name:literal,)+]
    )+) => {
        /// Every session event type on the wire, each with the payload variant `SessionEvent`
        /// registers for it. An envelope stores its type as text, so a type a newer producer wrote
        /// and this set lacks is still kept.
        #[derive(
            Clone,
            Copy,
            Debug,
            PartialEq,
            Eq,
            PartialOrd,
            Ord,
            Hash,
            Serialize,
            Deserialize,
            JsonSchema,
        )]
        pub enum SessionEventType {$($(
            #[doc = concat!("`", $name, "`.")]
            #[serde(rename = $name)]
            $variant,
        )+)+}

        impl SessionEventType {
            /// Every type, grouped by category in the registry's order.
            pub const ALL: &'static [Self] = &[$($(Self::$variant,)+)+];

            /// The type's wire name.
            pub const fn as_str(self) -> &'static str {
                match self {
                    $($(Self::$variant => $name,)+)+
                }
            }

            /// The category every event of this type belongs to.
            pub const fn category(self) -> EventCategory {
                match self {
                    $($(Self::$variant)|+ => EventCategory::$category,)+
                }
            }

            /// The type a wire name names, or `None` for a name this build does not register.
            pub fn from_wire_name(name: &str) -> Option<Self> {
                match name {
                    $($($name => Some(Self::$variant),)+)+
                    _ => None,
                }
            }
        }

        $(
            $(#[doc = $list_doc])+
            pub const $list: &[SessionEventType] = &[$(SessionEventType::$variant,)+];
        )+
    };
}

session_event_types! {
    /// The event types of the `run_lifecycle` category.
    RUN_LIFECYCLE_EVENT_TYPES = RunLifecycle [
        RunQueued = "run.queued",
        RunStarting = "run.starting",
        RunRunning = "run.running",
        RunWaitingForApproval = "run.waiting_for_approval",
        RunWaitingForInput = "run.waiting_for_input",
        RunPausing = "run.pausing",
        RunPaused = "run.paused",
        RunCompleted = "run.completed",
        RunInterrupted = "run.interrupted",
        RunStopped = "run.stopped",
        RunFailed = "run.failed",
        RunRolledBack = "run.rolled_back",
        RunProviderInitialized = "run.provider_initialized",
        RunTurnStarted = "run.turn_started",
        RunWorkerShutdown = "run.worker_shutdown",
        RunStepLimitReached = "run.step_limit_reached",
        RunTokenLimitReached = "run.token_limit_reached",
        RunRecoveryStepsAdded = "run.recovery_steps_added",
        RunRecoveryResolved = "run.recovery_resolved",
        RunRefusalChoiceRequested = "run.refusal_choice_requested",
        RunRefusalChoiceResolved = "run.refusal_choice_resolved",
        RunUsageCreditsChoiceRequested = "run.usage_credits_choice_requested",
        RunUsageCreditsChoiceResolved = "run.usage_credits_choice_resolved",
    ]
    /// The event types of the `assistant_output` category.
    ASSISTANT_OUTPUT_EVENT_TYPES = AssistantOutput [
        AssistantMessage = "assistant.message",
        AssistantThinkingUpdate = "assistant.thinking_update",
    ]
    /// The event types of the `tool_activity` category.
    TOOL_ACTIVITY_EVENT_TYPES = ToolActivity [
        ToolInvoked = "tool.invoked",
        ToolResult = "tool.result",
        ToolError = "tool.error",
        SubagentStarted = "subagent.started",
        SubagentCompleted = "subagent.completed",
        CommandEnded = "command.ended",
    ]
    /// The event types of the `interactive_request` category.
    INTERACTIVE_REQUEST_EVENT_TYPES = InteractiveRequest [
        QueueItemCreated = "queue_item.created",
        QueueItemAdmitted = "queue_item.admitted",
        QueueItemSuperseded = "queue_item.superseded",
        QueueItemCanceled = "queue_item.canceled",
        QueueItemNotDelivered = "queue_item.not_delivered",
        InterventionRequested = "intervention.requested",
        InterventionAccepted = "intervention.accepted",
        InterventionApplied = "intervention.applied",
        InterventionRejected = "intervention.rejected",
        InterventionDegraded = "intervention.degraded",
        InterventionExpired = "intervention.expired",
        InterventionFailed = "intervention.failed",
        UserMessage = "user.message",
        QuestionAsked = "question.asked",
    ]
    /// The event types of the `artifact_publication` category.
    ARTIFACT_PUBLICATION_EVENT_TYPES = ArtifactPublication [
        ArtifactPublished = "artifact.published",
        ArtifactSuperseded = "artifact.superseded",
        GitSettled = "git.settled",
    ]
    /// The event types of the `session_lifecycle` category: session (including the side
    /// question, the undo record, the pin and mute marks and a chat's conversion), agent, repo,
    /// workspace and worktree (including the branch change and the sweep to the repository root),
    /// pty and cloud task.
    SESSION_LIFECYCLE_EVENT_TYPES = SessionLifecycle [
        SessionCreated = "session.created",
        SessionActivated = "session.activated",
        SessionArchived = "session.archived",
        SessionReactivated = "session.reactivated",
        SessionClosed = "session.closed",
        SessionGoalUpdated = "session.goal_updated",
        SessionGoalCleared = "session.goal_cleared",
        SessionProviderStatus = "session.provider_status",
        SessionNotice = "session.notice",
        SessionRenamed = "session.renamed",
        SessionPinned = "session.pinned",
        SessionUnpinned = "session.unpinned",
        SessionMuted = "session.muted",
        SessionUnmuted = "session.unmuted",
        SessionConverted = "session.converted",
        SessionSideQuestionAnswered = "session.side_question_answered",
        SessionSpendLimitReached = "session.spend_limit_reached",
        SessionRestoreFinished = "session.restore_finished",
        SessionAdvisorChanged = "session.advisor_changed",
        SessionOutputStyleChanged = "session.output_style_changed",
        AgentProviderBindingChanged = "agent.provider_binding_changed",
        AgentProviderBindingChangeFailed = "agent.provider_binding_change_failed",
        WorkspacePreparing = "workspace.preparing",
        WorkspaceReady = "workspace.ready",
        WorkspaceStale = "workspace.stale",
        WorkspaceArchived = "workspace.archived",
        WorktreeCreated = "worktree.created",
        WorktreeReady = "worktree.ready",
        WorktreeDirty = "worktree.dirty",
        WorktreeMerged = "worktree.merged",
        WorktreeRetired = "worktree.retired",
        RepoMountHealthChanged = "repo.mount_health_changed",
        SessionBranchChanged = "session.branch_changed",
        SessionSweptToRepoRoot = "session.swept_to_repo_root",
        PtyControlChanged = "pty.control_changed",
        CloudTaskUpdated = "cloud.task_updated",
    ]
    /// The event types of the `approval_flow` category.
    APPROVAL_FLOW_EVENT_TYPES = ApprovalFlow [
        ApprovalRequested = "approval.requested",
        ApprovalApproved = "approval.approved",
        ApprovalRejected = "approval.rejected",
        ApprovalCanceled = "approval.canceled",
        ApprovalRemembered = "approval.remembered",
        ApprovalRuleRevoked = "approval.rule_revoked",
        ApprovalReviewerDenied = "approval.reviewer_denied",
        ApprovalDenialOverridden = "approval.denial_overridden",
        ModerationReviewFlagged = "moderation.review_flagged",
        PlanProposed = "plan.proposed",
        PlanAccepted = "plan.accepted",
        PlanHandedOff = "plan.handed_off",
    ]
    /// The event types of the `usage_telemetry` category.
    USAGE_TELEMETRY_EVENT_TYPES = UsageTelemetry [
        UsageTokenCount = "usage.token_count",
        UsageCostUpdate = "usage.cost_update",
        UsageContextWindowUpdate = "usage.context_window_update",
        UsageRateLimitUpdate = "usage.rate_limit_update",
        UsageApiRetry = "usage.api_retry",
        UsageContextCompacted = "usage.context_compacted",
        UsageModelRerouted = "usage.model_rerouted",
    ]
    /// The event types of the `recovery_events` category.
    RECOVERY_EVENTS_EVENT_TYPES = RecoveryEvents [
        RecoveryAttempted = "recovery.attempted",
        RecoverySucceeded = "recovery.succeeded",
        RecoveryFailed = "recovery.failed",
        RecoveryDamagedEventsSkipped = "recovery.damaged_events_skipped",
    ]
    /// The event types of the `security_events` category.
    SECURITY_EVENTS_EVENT_TYPES = SecurityEvents [
        RelayPinRefused = "relay.pin_refused",
    ]
    /// The event types of the `event_maintenance` category.
    EVENT_MAINTENANCE_EVENT_TYPES = EventMaintenance [
        EventCompacted = "event.compacted",
        BackupCompleted = "backup.completed",
        BackupFailed = "backup.failed",
        BackupRestored = "backup.restored",
    ]
    /// The event types of the `orchestration_admission` category.
    ORCHESTRATION_ADMISSION_EVENT_TYPES = OrchestrationAdmission [
        OrchestrationRejected = "orchestration.rejected",
    ]
    /// The event types of the `mcp_governance` category. `mcp.server_oauth_completed` binds to the
    /// daemon-scope sentinel session.
    MCP_GOVERNANCE_EVENT_TYPES = McpGovernance [
        McpServerOauthCompleted = "mcp.server_oauth_completed",
    ]
    /// The event types of the `workflow_lifecycle` category.
    WORKFLOW_LIFECYCLE_EVENT_TYPES = WorkflowLifecycle [
        WorkflowCreated = "workflow.created",
        WorkflowStarted = "workflow.started",
        WorkflowGated = "workflow.gated",
        WorkflowFailed = "workflow.failed",
        WorkflowCompleted = "workflow.completed",
        WorkflowResumed = "workflow.resumed",
        WorkflowCanceled = "workflow.canceled",
        WorkflowRunWaiting = "workflow.run_waiting",
        WorkflowRunDeleted = "workflow.run_deleted",
        WorkflowScheduleArmed = "workflow.schedule_armed",
        WorkflowScheduleFired = "workflow.schedule_fired",
        WorkflowTriggerArmed = "workflow.trigger_armed",
        WorkflowTriggerFired = "workflow.trigger_fired",
        WorkflowResultsPosted = "workflow.results_posted",
    ]
    /// The event types of the `workflow_phase_lifecycle` category.
    WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES = WorkflowPhaseLifecycle [
        WorkflowPhaseAdmitted = "workflow.phase_admitted",
        WorkflowPhaseWaitingOnPool = "workflow.phase_waiting_on_pool",
        WorkflowPhaseStarted = "workflow.phase_started",
        WorkflowPhaseProgressed = "workflow.phase_progressed",
        WorkflowPhaseCanceling = "workflow.phase_canceling",
        WorkflowPhaseFailed = "workflow.phase_failed",
        WorkflowPhaseRetried = "workflow.phase_retried",
        WorkflowPhaseSuspended = "workflow.phase_suspended",
        WorkflowPhaseResumed = "workflow.phase_resumed",
        WorkflowPhaseCompleted = "workflow.phase_completed",
        WorkflowStepStarted = "workflow.step_started",
        WorkflowStepFinished = "workflow.step_finished",
        WorkflowStepFailed = "workflow.step_failed",
        WorkflowStepCanceled = "workflow.step_canceled",
        WorkflowStepSkipped = "workflow.step_skipped",
    ]
    /// The event types of the `workflow_parallel_coordination` category.
    WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES = WorkflowParallelCoordination [
        WorkflowParallelJoinCancellation = "workflow.parallel_join_cancellation",
    ]
    /// The event types of the `workflow_gate_resolution` category.
    WORKFLOW_GATE_RESOLUTION_EVENT_TYPES = WorkflowGateResolution [
        WorkflowGateResolved = "workflow.gate_resolved",
    ]
}

/// The TypeScript module of the session event types.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "event/registry",
    doc: "The closed set of session event types. A type's category is its entry in \
          `SESSION_EVENT_CATEGORY_RECORD`, not its prefix.",
    definitions: &[Definition::read::<SessionEventType>()],
    constants: &[],
    method_tables: &[],
};
