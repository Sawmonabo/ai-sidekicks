//! The closed set of session event types, grouped by category. A type's category is the group it
//! is listed in here, not its prefix: `relay.pin.refused` is `securityEvents`, `plan.*` is
//! `approvalFlow`.

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
        $($(
            const _: () = assert!(
                crate::wire::name::is_wire_name($name),
                concat!("not a wire name: ", $name),
            );
        )+)+

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
        AgentRunQueued = "agent.run.queued",
        AgentRunStarting = "agent.run.starting",
        AgentRunRunning = "agent.run.running",
        AgentRunWaitingForApproval = "agent.run.waitingForApproval",
        AgentRunWaitingForInput = "agent.run.waitingForInput",
        AgentRunPausing = "agent.run.pausing",
        AgentRunPaused = "agent.run.paused",
        AgentRunCompleted = "agent.run.completed",
        AgentRunInterrupted = "agent.run.interrupted",
        AgentRunStopped = "agent.run.stopped",
        AgentRunFailed = "agent.run.failed",
        AgentRunRolledBack = "agent.run.rolledBack",
        AgentRunProviderInitialized = "agent.run.providerInitialized",
        AgentTurnStarted = "agent.turn.started",
        AgentTurnCompleted = "agent.turn.completed",
        AgentTurnInterrupted = "agent.turn.interrupted",
        AgentTurnFailed = "agent.turn.failed",
        AgentRunWorkerShuttingDown = "agent.run.workerShuttingDown",
        AgentRunStepLimitReached = "agent.run.stepLimit.reached",
        AgentRunTokenLimitReached = "agent.run.tokenLimit.reached",
        AgentRunRecoveryStepsAdded = "agent.run.recoverySteps.added",
        AgentRunRecoveryResolved = "agent.run.recovery.resolved",
        AgentRunRefusalChoiceRequested = "agent.run.refusalChoice.requested",
        AgentRunRefusalChoiceResolved = "agent.run.refusalChoice.resolved",
        AgentRunUsageCreditsChoiceRequested = "agent.run.usageCreditsChoice.requested",
        AgentRunUsageCreditsChoiceResolved = "agent.run.usageCreditsChoice.resolved",
    ]
    /// The event types of the `agentOutput` category.
    AGENT_OUTPUT_EVENT_TYPES = AgentOutput [
        AgentMessageSent = "agent.message.sent",
        AgentThinkingUpdated = "agent.thinking.updated",
    ]
    /// The event types of the `toolActivity` category.
    TOOL_ACTIVITY_EVENT_TYPES = ToolActivity [
        AgentToolCallInvoked = "agent.toolCall.invoked",
        AgentToolCallCompleted = "agent.toolCall.completed",
        AgentToolCallFailed = "agent.toolCall.failed",
        AgentSubagentStarted = "agent.subagent.started",
        AgentSubagentCompleted = "agent.subagent.completed",
        AgentCommandEnded = "agent.command.ended",
    ]
    /// The event types of the `interactiveRequest` category.
    INTERACTIVE_REQUEST_EVENT_TYPES = InteractiveRequest [
        AgentQueueItemCreated = "agent.queueItem.created",
        AgentQueueItemAdmitted = "agent.queueItem.admitted",
        AgentQueueItemSuperseded = "agent.queueItem.superseded",
        AgentQueueItemCanceled = "agent.queueItem.canceled",
        AgentQueueItemNotDelivered = "agent.queueItem.notDelivered",
        AgentInterventionRequested = "agent.intervention.requested",
        AgentInterventionAccepted = "agent.intervention.accepted",
        AgentInterventionApplied = "agent.intervention.applied",
        AgentInterventionRejected = "agent.intervention.rejected",
        AgentInterventionDegraded = "agent.intervention.degraded",
        AgentInterventionExpired = "agent.intervention.expired",
        AgentInterventionFailed = "agent.intervention.failed",
        UserMessageSent = "user.message.sent",
        QuestionAsked = "question.asked",
        QuestionCanceled = "question.canceled",
    ]
    /// The event types of the `artifactPublication` category.
    ARTIFACT_PUBLICATION_EVENT_TYPES = ArtifactPublication [
        ArtifactPublished = "artifact.published",
        GitSettled = "git.settled",
    ]
    /// The event types of the `sessionLifecycle` category: session (including the side
    /// question, the undo record, the pin and mute marks and a chat's conversion), agent, repo,
    /// workspace and worktree (including the branch change and the sweep to the repository root),
    /// terminal and cloud task.
    SESSION_LIFECYCLE_EVENT_TYPES = SessionLifecycle [
        SessionCreated = "session.created",
        SessionActivated = "session.activated",
        SessionArchived = "session.archived",
        SessionReactivated = "session.reactivated",
        SessionClosed = "session.closed",
        SessionGoalUpdated = "session.goal.updated",
        SessionGoalCleared = "session.goal.cleared",
        SessionProviderStatusReported = "session.providerStatus.reported",
        SessionNoticePosted = "session.notice.posted",
        SessionRenamed = "session.renamed",
        SessionPinned = "session.pinned",
        SessionUnpinned = "session.unpinned",
        SessionMuted = "session.muted",
        SessionUnmuted = "session.unmuted",
        SessionConverted = "session.converted",
        SessionSideQuestionAnswered = "session.sideQuestion.answered",
        SessionSpendLimitReached = "session.spendLimit.reached",
        SessionRestoreCompleted = "session.restore.completed",
        SessionAdvisorChanged = "session.advisor.changed",
        SessionOutputStyleChanged = "session.outputStyle.changed",
        AgentProviderBindingChanged = "agent.providerBinding.changed",
        AgentProviderBindingChangeFailed = "agent.providerBinding.changeFailed",
        WorkspacePreparing = "workspace.preparing",
        WorkspacePrepared = "workspace.prepared",
        WorkspaceRootLost = "workspace.rootLost",
        WorkspaceArchived = "workspace.archived",
        WorktreeCreated = "worktree.created",
        WorktreeBound = "worktree.bound",
        WorktreeDirtied = "worktree.dirtied",
        WorktreeMerged = "worktree.merged",
        WorktreeRetired = "worktree.retired",
        RepoMountHealthChanged = "repoMount.health.changed",
        SessionBranchChanged = "session.branch.changed",
        SessionSweptToCheckout = "session.sweptToCheckout",
        TerminalControlChanged = "terminal.control.changed",
        CloudTaskUpdated = "cloud.task.updated",
    ]
    /// The event types of the `approvalFlow` category.
    APPROVAL_FLOW_EVENT_TYPES = ApprovalFlow [
        ApprovalRequested = "approval.requested",
        ApprovalApproved = "approval.approved",
        ApprovalRejected = "approval.rejected",
        ApprovalCanceled = "approval.canceled",
        ApprovalRuleRemembered = "approval.rule.remembered",
        ApprovalRuleRevoked = "approval.rule.revoked",
        ApprovalReviewerDenied = "approval.reviewer.denied",
        ApprovalDenialOverridden = "approval.denial.overridden",
        ApprovalReviewerFlagged = "approval.reviewer.flagged",
        PlanProposed = "plan.proposed",
        PlanAccepted = "plan.accepted",
        PlanHandedOff = "plan.handedOff",
        PlanKept = "plan.kept",
        PlanHoldEnded = "plan.hold.ended",
    ]
    /// The event types of the `usageTelemetry` category.
    USAGE_TELEMETRY_EVENT_TYPES = UsageTelemetry [
        UsageTokenCountRecorded = "usage.tokenCount.recorded",
        UsageCostUpdated = "usage.cost.updated",
        UsageContextWindowUpdated = "usage.contextWindow.updated",
        UsageRateLimitUpdated = "usage.rateLimit.updated",
        UsageApiRequestRetried = "usage.apiRequest.retried",
        AgentRunContextCompacted = "agent.run.context.compacted",
        AgentTurnRerouted = "agent.turn.rerouted",
    ]
    /// The event types of the `recoveryEvents` category.
    RECOVERY_EVENTS_EVENT_TYPES = RecoveryEvents [
        DaemonRecoveryAttempted = "daemon.recovery.attempted",
        DaemonRecoverySucceeded = "daemon.recovery.succeeded",
        DaemonRecoveryFailed = "daemon.recovery.failed",
        SessionDamagedEventsSkipped = "session.damagedEvents.skipped",
    ]
    /// The event types of the `securityEvents` category.
    SECURITY_EVENTS_EVENT_TYPES = SecurityEvents [
        RelayPinRefused = "relay.pin.refused",
    ]
    /// The event types of the `eventMaintenance` category.
    EVENT_MAINTENANCE_EVENT_TYPES = EventMaintenance [
        SessionEventCompacted = "session.event.compacted",
        DaemonBackupCompleted = "daemon.backup.completed",
        DaemonBackupFailed = "daemon.backup.failed",
        DaemonBackupRestored = "daemon.backup.restored",
    ]
    /// The event types of the `orchestrationAdmission` category.
    ORCHESTRATION_ADMISSION_EVENT_TYPES = OrchestrationAdmission [
        AgentRunRejected = "agent.run.rejected",
    ]
    /// The event types of the `mcpGovernance` category. `mcp.server.signIn.completed` binds to the
    /// daemon-scope sentinel session.
    MCP_GOVERNANCE_EVENT_TYPES = McpGovernance [
        McpServerSignInCompleted = "mcp.server.signIn.completed",
    ]
    /// The event types of the `workflowLifecycle` category.
    WORKFLOW_LIFECYCLE_EVENT_TYPES = WorkflowLifecycle [
        WorkflowVersionCreated = "workflow.version.created",
        WorkflowRunStarted = "workflow.run.started",
        WorkflowGateReached = "workflow.gate.reached",
        WorkflowRunFailed = "workflow.run.failed",
        WorkflowRunCompleted = "workflow.run.completed",
        WorkflowRunResumed = "workflow.run.resumed",
        WorkflowRunCanceled = "workflow.run.canceled",
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
        WorkflowStepCompleted = "workflow.step.completed",
        WorkflowStepFailed = "workflow.step.failed",
        WorkflowStepCanceled = "workflow.step.canceled",
        WorkflowStepSkipped = "workflow.step.skipped",
    ]
    /// The event types of the `workflowParallelCoordination` category.
    WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES = WorkflowParallelCoordination [
        WorkflowParallelJoinBranchesCanceled = "workflow.parallelJoin.branchesCanceled",
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
