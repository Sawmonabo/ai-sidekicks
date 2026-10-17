//! The closed set of session event types, grouped by category. A type's wire name is an immutable
//! identifier, never renamed, and its category is the group it is listed in here, not its prefix:
//! `relay.pin.refused` is `securityEvents`, `plan.*` is `approvalFlow`.

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
    /// The event types of the `runLifecycle` category.
    RUN_LIFECYCLE_EVENT_TYPES = RunLifecycle [
        RunQueued = "agent.run.queued",
        RunStarting = "agent.run.starting",
        RunRunning = "agent.run.running",
        RunWaitingForApproval = "agent.run.waitingForApproval",
        RunWaitingForInput = "agent.run.waitingForInput",
        RunPausing = "agent.run.pausing",
        RunPaused = "agent.run.paused",
        RunCompleted = "agent.run.completed",
        RunInterrupted = "agent.run.interrupted",
        RunStopped = "agent.run.stopped",
        RunFailed = "agent.run.failed",
        RunRolledBack = "agent.run.rolledBack",
        RunProviderInitialized = "agent.run.providerInitialized",
        RunTurnStarted = "agent.turn.started",
        RunWorkerShutdown = "agent.run.workerShuttingDown",
        RunStepLimitReached = "agent.run.stepLimit.reached",
        RunTokenLimitReached = "agent.run.tokenLimit.reached",
        RunRecoveryStepsAdded = "agent.run.recoverySteps.added",
        RunRecoveryResolved = "agent.run.recovery.resolved",
        RunRefusalChoiceRequested = "agent.run.refusalChoice.requested",
        RunRefusalChoiceResolved = "agent.run.refusalChoice.resolved",
        RunUsageCreditsChoiceRequested = "agent.run.usageCreditsChoice.requested",
        RunUsageCreditsChoiceResolved = "agent.run.usageCreditsChoice.resolved",
    ]
    /// The event types of the `assistantOutput` category.
    ASSISTANT_OUTPUT_EVENT_TYPES = AssistantOutput [
        AssistantMessage = "agent.message.sent",
        AssistantThinkingUpdate = "agent.thinking.updated",
    ]
    /// The event types of the `toolActivity` category.
    TOOL_ACTIVITY_EVENT_TYPES = ToolActivity [
        ToolInvoked = "agent.toolCall.invoked",
        ToolResult = "agent.toolCall.completed",
        ToolError = "agent.toolCall.failed",
        SubagentStarted = "agent.subagent.started",
        SubagentCompleted = "agent.subagent.completed",
        CommandEnded = "agent.command.ended",
    ]
    /// The event types of the `interactiveRequest` category.
    INTERACTIVE_REQUEST_EVENT_TYPES = InteractiveRequest [
        QueueItemCreated = "agent.queueItem.created",
        QueueItemAdmitted = "agent.queueItem.admitted",
        QueueItemSuperseded = "agent.queueItem.superseded",
        QueueItemCanceled = "agent.queueItem.canceled",
        QueueItemNotDelivered = "agent.queueItem.notDelivered",
        InterventionRequested = "agent.intervention.requested",
        InterventionAccepted = "agent.intervention.accepted",
        InterventionApplied = "agent.intervention.applied",
        InterventionRejected = "agent.intervention.rejected",
        InterventionDegraded = "agent.intervention.degraded",
        InterventionExpired = "agent.intervention.expired",
        InterventionFailed = "agent.intervention.failed",
        UserMessage = "user.message.sent",
        QuestionAsked = "question.asked",
    ]
    /// The event types of the `artifactPublication` category.
    ARTIFACT_PUBLICATION_EVENT_TYPES = ArtifactPublication [
        ArtifactPublished = "artifact.published",
        ArtifactSuperseded = "artifact.superseded",
        GitSettled = "git.settled",
    ]
    /// The event types of the `sessionLifecycle` category: session (including the side
    /// question, the undo record, the pin and mute marks and a chat's conversion), agent, repo,
    /// workspace and worktree (including the branch change and the sweep to the repository root),
    /// pty and cloud task.
    SESSION_LIFECYCLE_EVENT_TYPES = SessionLifecycle [
        SessionCreated = "session.created",
        SessionActivated = "session.activated",
        SessionArchived = "session.archived",
        SessionReactivated = "session.reactivated",
        SessionClosed = "session.closed",
        SessionGoalUpdated = "session.goal.updated",
        SessionGoalCleared = "session.goal.cleared",
        SessionProviderStatus = "session.providerStatus.reported",
        SessionNotice = "session.notice.posted",
        SessionRenamed = "session.renamed",
        SessionPinned = "session.pinned",
        SessionUnpinned = "session.unpinned",
        SessionMuted = "session.muted",
        SessionUnmuted = "session.unmuted",
        SessionConverted = "session.converted",
        SessionSideQuestionAnswered = "session.sideQuestion.answered",
        SessionSpendLimitReached = "session.spendLimit.reached",
        SessionRestoreFinished = "session.restore.completed",
        SessionAdvisorChanged = "session.advisor.changed",
        SessionOutputStyleChanged = "session.outputStyle.changed",
        AgentProviderBindingChanged = "agent.providerBinding.changed",
        AgentProviderBindingChangeFailed = "agent.providerBinding.changeFailed",
        WorkspacePreparing = "workspace.preparing",
        WorkspaceReady = "workspace.prepared",
        WorkspaceRootLost = "workspace.rootLost",
        WorkspaceArchived = "workspace.archived",
        WorktreeCreated = "worktree.created",
        WorktreeReady = "worktree.bound",
        WorktreeDirty = "worktree.dirtied",
        WorktreeMerged = "worktree.merged",
        WorktreeRetired = "worktree.retired",
        RepoMountHealthChanged = "repoMount.health.changed",
        SessionBranchChanged = "session.branch.changed",
        SessionSweptToRepoRoot = "session.sweptToCheckout",
        PtyControlChanged = "terminal.control.changed",
        CloudTaskUpdated = "cloud.task.updated",
    ]
    /// The event types of the `approvalFlow` category.
    APPROVAL_FLOW_EVENT_TYPES = ApprovalFlow [
        ApprovalRequested = "approval.requested",
        ApprovalApproved = "approval.approved",
        ApprovalRejected = "approval.rejected",
        ApprovalCanceled = "approval.canceled",
        ApprovalRemembered = "approval.rule.remembered",
        ApprovalRuleRevoked = "approval.rule.revoked",
        ApprovalReviewerDenied = "approval.reviewer.denied",
        ApprovalDenialOverridden = "approval.denial.overridden",
        ModerationReviewFlagged = "approval.reviewer.flagged",
        PlanProposed = "plan.proposed",
        PlanAccepted = "plan.accepted",
        PlanHandedOff = "plan.handedOff",
    ]
    /// The event types of the `usageTelemetry` category.
    USAGE_TELEMETRY_EVENT_TYPES = UsageTelemetry [
        UsageTokenCount = "usage.tokenCount.recorded",
        UsageCostUpdate = "usage.cost.updated",
        UsageContextWindowUpdate = "usage.contextWindow.updated",
        UsageRateLimitUpdate = "usage.rateLimit.updated",
        UsageApiRetry = "usage.apiRequest.retried",
        UsageContextCompacted = "agent.run.context.compacted",
        UsageModelRerouted = "agent.turn.rerouted",
    ]
    /// The event types of the `recoveryEvents` category.
    RECOVERY_EVENTS_EVENT_TYPES = RecoveryEvents [
        RecoveryAttempted = "daemon.recovery.attempted",
        RecoverySucceeded = "daemon.recovery.succeeded",
        RecoveryFailed = "daemon.recovery.failed",
        RecoveryDamagedEventsSkipped = "session.damagedEvents.skipped",
    ]
    /// The event types of the `securityEvents` category.
    SECURITY_EVENTS_EVENT_TYPES = SecurityEvents [
        RelayPinRefused = "relay.pin.refused",
    ]
    /// The event types of the `eventMaintenance` category.
    EVENT_MAINTENANCE_EVENT_TYPES = EventMaintenance [
        EventCompacted = "session.event.compacted",
        BackupCompleted = "daemon.backup.completed",
        BackupFailed = "daemon.backup.failed",
        BackupRestored = "daemon.backup.restored",
    ]
    /// The event types of the `orchestrationAdmission` category.
    ORCHESTRATION_ADMISSION_EVENT_TYPES = OrchestrationAdmission [
        OrchestrationRejected = "agent.run.rejected",
    ]
    /// The event types of the `mcpGovernance` category. `mcp.server.signIn.completed` binds to the
    /// daemon-scope sentinel session.
    MCP_GOVERNANCE_EVENT_TYPES = McpGovernance [
        McpServerOauthCompleted = "mcp.server.signIn.completed",
    ]
    /// The event types of the `workflowLifecycle` category.
    WORKFLOW_LIFECYCLE_EVENT_TYPES = WorkflowLifecycle [
        WorkflowCreated = "workflow.version.created",
        WorkflowStarted = "workflow.run.started",
        WorkflowGated = "workflow.gate.reached",
        WorkflowFailed = "workflow.run.failed",
        WorkflowCompleted = "workflow.run.completed",
        WorkflowResumed = "workflow.run.resumed",
        WorkflowCanceled = "workflow.run.canceled",
        WorkflowRunWaiting = "workflow.run.waiting",
        WorkflowRunDeleted = "workflow.run.deleted",
        WorkflowScheduleArmed = "workflow.schedule.armed",
        WorkflowScheduleFired = "workflow.schedule.fired",
        WorkflowTriggerArmed = "workflow.trigger.armed",
        WorkflowTriggerFired = "workflow.trigger.fired",
        WorkflowResultsPosted = "workflow.results.posted",
    ]
    /// The event types of the `workflowPhaseLifecycle` category.
    WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES = WorkflowPhaseLifecycle [
        WorkflowPhaseAdmitted = "workflow.phase.admitted",
        WorkflowPhaseWaitingOnPool = "workflow.phase.waitingOnPool",
        WorkflowPhaseStarted = "workflow.phase.started",
        WorkflowPhaseProgressed = "workflow.phase.progressed",
        WorkflowPhaseCanceling = "workflow.phase.canceling",
        WorkflowPhaseFailed = "workflow.phase.failed",
        WorkflowPhaseRetried = "workflow.phase.retried",
        WorkflowPhaseSuspended = "workflow.phase.suspended",
        WorkflowPhaseResumed = "workflow.phase.resumed",
        WorkflowPhaseCompleted = "workflow.phase.completed",
        WorkflowStepStarted = "workflow.step.started",
        WorkflowStepFinished = "workflow.step.completed",
        WorkflowStepFailed = "workflow.step.failed",
        WorkflowStepCanceled = "workflow.step.canceled",
        WorkflowStepSkipped = "workflow.step.skipped",
    ]
    /// The event types of the `workflowParallelCoordination` category.
    WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES = WorkflowParallelCoordination [
        WorkflowParallelJoinCancellation = "workflow.parallelJoin.branchesCanceled",
    ]
    /// The event types of the `workflowGateResolution` category.
    WORKFLOW_GATE_RESOLUTION_EVENT_TYPES = WorkflowGateResolution [
        WorkflowGateResolved = "workflow.gate.resolved",
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
