//! The strict session event: an envelope's `type` and `payload`, the payload parsed by the schema
//! its type registers. Every type in [`SessionEventType`] is registered, but only some have a
//! payload variant. The envelope stays the tolerant layer that stores and passes on any type; the
//! strict event is read from it with [`SessionEvent::from_envelope`].

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent::provider_binding::{
    AgentProviderBindingChangeFailedPayload, AgentProviderBindingChangedPayload,
};
use crate::approval::events::{
    ApprovalCanceledPayload, ApprovalDenialOverriddenPayload, ApprovalRememberedPayload,
    ApprovalRequestedPayload, ApprovalResolvedPayload, ApprovalRuleRevokedPayload,
    approval_reviewer_denied_payload,
};
use crate::artifacts::publication::ArtifactPublicationPayload;
use crate::cloud::CloudTaskUpdatedPayload;
use crate::command::CommandEndedPayload;
use crate::daemon::backup::{BackupCompletedPayload, BackupFailedPayload, BackupRestoredPayload};
use crate::daemon::recovery::{
    RecoveryAttemptedPayload, RecoveryFailedPayload, RecoverySucceededPayload,
};
use crate::event::declared_variants::{
    AssistantOutputPayload, EventCompactedPayload, ToolActivityPayload, UsageModelReroutedPayload,
};
use crate::event::envelope::{EventCategory, EventEnvelope};
use crate::event::registry::SessionEventType;
use crate::gitflow::local::GitSettledPayload;
use crate::mcp::governance::McpServerOauthCompletedPayload;
use crate::orchestration::OrchestrationRejectedPayload;
use crate::plan::{PlanAcceptedPayload, PlanHandedOffPayload, PlanProposedPayload};
use crate::pty::control::PtyControlChangedPayload;
use crate::question::QuestionAskedPayload;
use crate::relay::RelayPinRefusedPayload;
use crate::repo::mount::{RepoMountHealthChangedPayload, RepoWorkspaceLifecyclePayload};
use crate::run::control::{RunRecoveryResolvedPayload, RunRecoveryStepsAddedPayload};
use crate::run::events::{
    InterventionAcceptedPayload, InterventionAppliedPayload, InterventionDegradedPayload,
    InterventionExpiredPayload, InterventionFailedPayload, InterventionRejectedPayload,
    InterventionRequestedPayload, RunCompletedPayload, RunFailedPayload, RunInterruptedPayload,
    RunPausedPayload, RunPausingPayload, RunProviderInitializedPayload, RunRunningPayload,
    RunStartingPayload, RunStoppedPayload, RunTurnStartedPayload, RunWaitingForApprovalPayload,
    RunWaitingForInputPayload, RunWorkerShutdownPayload,
};
use crate::run::provider_choice::{
    RunRefusalChoiceRequestedPayload, RunRefusalChoiceResolvedPayload,
    RunUsageCreditsChoiceRequestedPayload, RunUsageCreditsChoiceResolvedPayload,
};
use crate::run::queue::{
    QueueItemAdmittedPayload, QueueItemCanceledPayload, QueueItemCreatedPayload,
    QueueItemNotDeliveredPayload, QueueItemSupersededPayload, UserMessagePayload,
};
use crate::run::queued::RunQueuedPayload;
use crate::run::subagent::SubagentLifecyclePayload;
use crate::session::controls::events::{
    ModerationReviewFlaggedPayload, RunStepLimitReachedPayload, RunTokenLimitReachedPayload,
    SessionNoticePayload, SessionSideQuestionAnsweredPayload, SessionSpendLimitReachedPayload,
};
use crate::session::convert::SessionConvertedPayload;
use crate::session::events::{
    SessionAdvisorChangedPayload, SessionCreatedPayload, SessionLifecycleChangePayload,
    SessionMarkChangePayload, SessionOutputStyleChangedPayload, SessionProviderStatusPayload,
    SessionRenamedPayload,
};
use crate::session::goal::{SessionGoalClearedPayload, SessionGoalUpdatedPayload};
use crate::session::recovery::RecoveryDamagedEventsSkippedPayload;
use crate::session::restore::SessionRestoreFinishedPayload;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::workflow::run::events::{
    WorkflowCanceledPayload, WorkflowResultsPostedPayload, WorkflowResumedPayload,
    WorkflowRunDeletedPayload, WorkflowStartedPayload,
};
use crate::workflow::run::step::events::{
    WorkflowGateResolvedPayload, WorkflowPhaseFailedPayload, WorkflowPhaseSuspendedPayload,
    WorkflowPhaseWaitingOnPoolPayload, WorkflowStepCanceledPayload, WorkflowStepFailedPayload,
    WorkflowStepFinishedPayload, WorkflowStepSkippedPayload, WorkflowStepStartedPayload,
};
use crate::worktree::events::{
    SessionBranchChangedPayload, SessionSweptToRepoRootPayload, WorktreeCreatedPayload,
    WorktreeRetiredPayload,
};
use crate::worktree::lifecycle::WorktreeLifecyclePayload;

approval_reviewer_denied_payload! {
    described
    /// The `approval.reviewer_denied` payload as the session event carries it: the reviewer's
    /// block, with the stored denial body's length and cut mark, which the append path owns.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    pub struct ApprovalReviewerDeniedEventPayload
}

/// Declares [`SessionEvent`] from one registration table: each row is an arm named as its
/// [`SessionEventType`] variant, its payload (with `#[garde(dive)]` where the payload has checks)
/// and its wire name. The same table lists [`SESSION_EVENT_TYPES`].
macro_rules! session_events {
    ($(
        $(#[doc = $doc:literal])+
        $variant:ident($(#[$check:meta])? $payload:ty) = $name:literal,
    )+) => {
        /// Every session event with a registered payload variant: its `type` and its payload,
        /// discriminated on `type`. Its category is its type's own, checked when it is read from
        /// an envelope.
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(tag = "type", content = "payload", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        pub enum SessionEvent {$(
            $(#[doc = $doc])+
            #[serde(rename = $name)]
            $variant($(#[$check])? $payload),
        )+}

        impl SessionEvent {
            /// The event's type.
            pub const fn event_type(&self) -> SessionEventType {
                match self {
                    $(Self::$variant(_) => SessionEventType::$variant,)+
                }
            }

            /// Reads `payload` as the payload variant `event_type` registers, borrowing it, or
            /// `None` when the type registers no payload variant.
            fn read_payload(
                event_type: SessionEventType,
                payload: &Map<String, Value>,
            ) -> Option<Result<Self, serde_json::Error>> {
                $(
                    if event_type == SessionEventType::$variant {
                        let read = <$payload as Deserialize>::deserialize(payload);
                        return Some(read.map(Self::$variant));
                    }
                )+
                None
            }
        }

        ts_constants! {
            /// The event types with a payload variant registered in `SessionEvent`.
            pub const SESSION_EVENT_TYPES: &[SessionEventType] =
                &[$(SessionEventType::$variant,)+];
        }
    };
}

session_events! {
    /// Emitted when a session is admitted.
    SessionCreated(Box<SessionCreatedPayload>) = "session.created",
    /// Emitted when a workspace's preparation begins, the first time or again.
    WorkspacePreparing(RepoWorkspaceLifecyclePayload) = "workspace.preparing",
    /// Emitted when preparation completes and the execution root is bound.
    WorkspaceReady(RepoWorkspaceLifecyclePayload) = "workspace.ready",
    /// Emitted when a workspace becomes unavailable: a failed preparation, or a path that went
    /// away after binding. Write runs are blocked until repair.
    WorkspaceStale(RepoWorkspaceLifecyclePayload) = "workspace.stale",
    /// Emitted once per dependent workspace archived by the detach cascade.
    WorkspaceArchived(RepoWorkspaceLifecyclePayload) = "workspace.archived",
    /// Emitted with the worktree's record; carries the kept copy a put-back came from, if any.
    WorktreeCreated(WorktreeCreatedPayload) = "worktree.created",
    /// Emitted when the checkout is bound as an execution root.
    WorktreeReady(WorktreeLifecyclePayload) = "worktree.ready",
    /// Emitted when uncommitted work was observed in the checkout.
    WorktreeDirty(WorktreeLifecyclePayload) = "worktree.dirty",
    /// Emitted when the worktree's branch has merged back.
    WorktreeMerged(WorktreeLifecyclePayload) = "worktree.merged",
    /// Emitted when a worktree retires, recorded before any disk change; cleanup is asynchronous
    /// and idempotent. Carries the kept copy when a discard kept one.
    WorktreeRetired(WorktreeRetiredPayload) = "worktree.retired",
    /// Emitted once per session deletion that deleted rows.
    EventCompacted(#[garde(dive)] EventCompactedPayload) = "event.compacted",
    /// Emitted when the assistant produces a message; its body is kept apart from the payload.
    AssistantMessage(#[garde(dive)] AssistantOutputPayload) = "assistant.message",
    /// Emitted when the assistant reports a reasoning update; its body is kept apart.
    AssistantThinkingUpdate(#[garde(dive)] AssistantOutputPayload) = "assistant.thinking_update",
    /// Emitted when a tool call starts; its arguments are kept apart from the payload.
    ToolInvoked(#[garde(dive)] ToolActivityPayload) = "tool.invoked",
    /// Emitted when a tool call returns; its result is kept apart from the payload.
    ToolResult(#[garde(dive)] ToolActivityPayload) = "tool.result",
    /// Emitted when a tool call fails; its error body is kept apart from the payload.
    ToolError(#[garde(dive)] ToolActivityPayload) = "tool.error",
    /// Emitted when a provider's own subagent starts under a run.
    SubagentStarted(#[garde(dive)] SubagentLifecyclePayload) = "subagent.started",
    /// Emitted when a provider's own subagent finishes, paired to its start.
    SubagentCompleted(#[garde(dive)] SubagentLifecyclePayload) = "subagent.completed",
    /// Emitted when the provider process reports its start for a run; it moves no state.
    RunProviderInitialized(RunProviderInitializedPayload) = "run.provider_initialized",
    /// Emitted when a turn opens within a run; it moves no state.
    RunTurnStarted(RunTurnStartedPayload) = "run.turn_started",
    /// Emitted when the provider says its worker is shutting down mid-run; never the run's end.
    RunWorkerShutdown(RunWorkerShutdownPayload) = "run.worker_shutdown",
    /// Emitted when the provider reports a coarse status for its session.
    SessionProviderStatus(#[garde(dive)] SessionProviderStatusPayload) = "session.provider_status",
    /// Emitted when an approval request is refused, and by whom.
    ApprovalRejected(ApprovalResolvedPayload) = "approval.rejected",
    /// Emitted when an ask ends with its run and can no longer be answered.
    ApprovalCanceled(ApprovalCanceledPayload) = "approval.canceled",
    /// Emitted when an approval rule is remembered; the payload is the whole rule.
    ApprovalRemembered(ApprovalRememberedPayload) = "approval.remembered",
    /// Emitted when a remembered approval rule is revoked.
    ApprovalRuleRevoked(ApprovalRuleRevokedPayload) = "approval.rule_revoked",
    /// Emitted when Codex's own reviewer flags an item with a warning or a required review.
    ModerationReviewFlagged(ModerationReviewFlaggedPayload) = "moderation.review_flagged",
    /// Emitted when an agent proposes a plan; the payload is the record the screen renders.
    PlanProposed(PlanProposedPayload) = "plan.proposed",
    /// Emitted when a proposed plan is accepted and is being built in its own session.
    PlanAccepted(PlanAcceptedPayload) = "plan.accepted",
    /// Emitted when a plan seeds a fresh session.
    PlanHandedOff(PlanHandedOffPayload) = "plan.handed_off",
    /// Emitted when an agent, tool server or workflow step asks the person a question.
    QuestionAsked(#[garde(dive)] QuestionAskedPayload) = "question.asked",
    /// Emitted when the daemon accepts a message the person sent, or a voice call hears one.
    UserMessage(UserMessagePayload) = "user.message",
    /// Emitted when a message the person sent is queued.
    QueueItemCreated(QueueItemCreatedPayload) = "queue_item.created",
    /// Emitted when the agent takes a queued message.
    QueueItemAdmitted(QueueItemAdmittedPayload) = "queue_item.admitted",
    /// Emitted when an edit replaces a waiting message, naming the message that replaced it.
    QueueItemSuperseded(QueueItemSupersededPayload) = "queue_item.superseded",
    /// Emitted when a waiting message is removed before the agent takes it.
    QueueItemCanceled(QueueItemCanceledPayload) = "queue_item.canceled",
    /// Emitted when a taken message could not be delivered, with the reason.
    QueueItemNotDelivered(QueueItemNotDeliveredPayload) = "queue_item.not_delivered",
    /// Emitted when an MCP server sign-in ends, in success or failure.
    McpServerOauthCompleted(McpServerOauthCompletedPayload) = "mcp.server_oauth_completed",
    /// Emitted when a cloud task is sent, changes state or is brought back.
    CloudTaskUpdated(CloudTaskUpdatedPayload) = "cloud.task_updated",
    /// Emitted when an undo finishes, with what applied and what did not.
    SessionRestoreFinished(#[garde(dive)] SessionRestoreFinishedPayload) =
        "session.restore_finished",
    /// Emitted when a session's goal is removed.
    SessionGoalCleared(SessionGoalClearedPayload) = "session.goal_cleared",
    /// Emitted for a plain-sentence notice about the session, such as a warning from the
    /// provider.
    SessionNotice(#[garde(dive)] SessionNoticePayload) = "session.notice",
    /// Emitted when a side question is answered; the aside never enters the conversation.
    SessionSideQuestionAnswered(SessionSideQuestionAnsweredPayload) =
        "session.side_question_answered",
    /// Emitted when the session's spend passes its spend limit and its running turns stop.
    SessionSpendLimitReached(SessionSpendLimitReachedPayload) = "session.spend_limit_reached",
    /// Emitted when a git act leaves or changes the session's branch.
    GitSettled(GitSettledPayload) = "git.settled",
    /// Emitted when the relay presents a key that does not match the pinned one.
    RelayPinRefused(RelayPinRefusedPayload) = "relay.pin_refused",
    /// Emitted when a command ends; it takes the epoch stamp.
    CommandEnded(#[garde(dive)] CommandEndedPayload) = "command.ended",
    /// Emitted when the provider moves a turn onto another model; it takes the epoch stamp.
    UsageModelRerouted(#[garde(dive)] UsageModelReroutedPayload) = "usage.model_rerouted",
    /// Emitted when a new session's storage is ready and it moves from provisioning to active.
    SessionActivated(SessionLifecycleChangePayload) = "session.activated",
    /// Emitted when a session is archived.
    SessionArchived(SessionLifecycleChangePayload) = "session.archived",
    /// Emitted when an archived session is reactivated.
    SessionReactivated(SessionLifecycleChangePayload) = "session.reactivated",
    /// Emitted when a session is closed.
    SessionClosed(SessionLifecycleChangePayload) = "session.closed",
    /// Emitted when a session is pinned.
    SessionPinned(#[garde(dive)] SessionMarkChangePayload) = "session.pinned",
    /// Emitted when a session is unpinned.
    SessionUnpinned(#[garde(dive)] SessionMarkChangePayload) = "session.unpinned",
    /// Emitted when a session is muted.
    SessionMuted(#[garde(dive)] SessionMarkChangePayload) = "session.muted",
    /// Emitted when a session is unmuted.
    SessionUnmuted(#[garde(dive)] SessionMarkChangePayload) = "session.unmuted",
    /// Emitted when a chat is converted, with the outcome of the copy.
    SessionConverted(SessionConvertedPayload) = "session.converted",
    /// Emitted when the branch a session's folder is on changes outside the app.
    SessionBranchChanged(SessionBranchChangedPayload) = "session.branch_changed",
    /// Emitted when a worktree removal moves a session back to the repository root.
    SessionSweptToRepoRoot(SessionSweptToRepoRootPayload) = "session.swept_to_repo_root",
    /// Emitted when an agent's provider binding is switched.
    AgentProviderBindingChanged(#[garde(dive)] AgentProviderBindingChangedPayload) =
        "agent.provider_binding_changed",
    /// Emitted when an accepted binding switch could not be applied.
    AgentProviderBindingChangeFailed(#[garde(dive)] AgentProviderBindingChangeFailedPayload) =
        "agent.provider_binding_change_failed",
    /// Emitted when an approval is requested, including a provider's permission ask.
    ApprovalRequested(ApprovalRequestedPayload) = "approval.requested",
    /// Emitted when an approval request is granted, and by whom.
    ApprovalApproved(ApprovalResolvedPayload) = "approval.approved",
    /// Emitted when the provider's own reviewer blocks an action; its denial is the row's body,
    /// kept apart from the payload.
    ApprovalReviewerDenied(ApprovalReviewerDeniedEventPayload) = "approval.reviewer_denied",
    /// Emitted when the person allows a blocked action once.
    ApprovalDenialOverridden(ApprovalDenialOverriddenPayload) = "approval.denial_overridden",
    /// Emitted when a run is queued.
    RunQueued(#[garde(dive)] RunQueuedPayload) = "run.queued",
    /// Emitted when a turn reaches the step bound and ends there.
    RunStepLimitReached(RunStepLimitReachedPayload) = "run.step_limit_reached",
    /// Emitted when a run passes its token limit and ends.
    RunTokenLimitReached(RunTokenLimitReachedPayload) = "run.token_limit_reached",
    /// Emitted when the person's choice settles a run's recovery question.
    RunRecoveryResolved(RunRecoveryResolvedPayload) = "run.recovery_resolved",
    /// Emitted when a restart found steps in the provider's own record that only read, added
    /// them to the transcript and let the run go on.
    RunRecoveryStepsAdded(RunRecoveryStepsAddedPayload) = "run.recovery_steps_added",
    /// Emitted when `/advisor` changes a Claude Code session's own advisor model, or turns it off.
    SessionAdvisorChanged(#[garde(dive)] SessionAdvisorChangedPayload) =
        "session.advisor_changed",
    /// Emitted when `/output-style` changes a Claude Code session's own output style.
    SessionOutputStyleChanged(#[garde(dive)] SessionOutputStyleChangedPayload) =
        "session.output_style_changed",
    /// Emitted on every session on a mount when the daemon's re-probe changes the mount's health.
    RepoMountHealthChanged(#[garde(dive)] RepoMountHealthChangedPayload) =
        "repo.mount_health_changed",
    /// Emitted when admission refuses an orchestration run create; no run or queue item is left.
    OrchestrationRejected(OrchestrationRejectedPayload) = "orchestration.rejected",
    /// Emitted when an artifact is published from a run; its payload keeps members it does not
    /// know.
    ArtifactPublished(ArtifactPublicationPayload) = "artifact.published",
    /// Emitted when a newer version replaces an artifact; its payload keeps unknown members.
    ArtifactSuperseded(ArtifactPublicationPayload) = "artifact.superseded",
    /// Emitted when Claude Code refuses a turn, names a fallback model and asks to retry or edit.
    RunRefusalChoiceRequested(RunRefusalChoiceRequestedPayload) =
        "run.refusal_choice_requested",
    /// Emitted when the first answer settles a refused turn's retry-or-edit choice.
    RunRefusalChoiceResolved(RunRefusalChoiceResolvedPayload) = "run.refusal_choice_resolved",
    /// Emitted when a Fable turn needs usage credits and Claude Code asks to switch or go on.
    RunUsageCreditsChoiceRequested(RunUsageCreditsChoiceRequestedPayload) =
        "run.usage_credits_choice_requested",
    /// Emitted when a Fable turn's switch-or-credits choice settles.
    RunUsageCreditsChoiceResolved(RunUsageCreditsChoiceResolvedPayload) =
        "run.usage_credits_choice_resolved",
    /// Emitted when a session's goal is set or changes status.
    SessionGoalUpdated(#[garde(dive)] SessionGoalUpdatedPayload) = "session.goal_updated",
    /// Emitted when a session is renamed.
    SessionRenamed(SessionRenamedPayload) = "session.renamed",
    /// Emitted when the holder of a shell changes.
    PtyControlChanged(#[garde(dive)] PtyControlChangedPayload) = "pty.control_changed",
    /// Emitted when a workflow run starts.
    WorkflowStarted(WorkflowStartedPayload) = "workflow.started",
    /// Emitted when a workflow run resumes.
    WorkflowResumed(#[garde(dive)] WorkflowResumedPayload) = "workflow.resumed",
    /// Emitted when a workflow run is canceled.
    WorkflowCanceled(#[garde(dive)] WorkflowCanceledPayload) = "workflow.canceled",
    /// Emitted when the person deletes a workflow run.
    WorkflowRunDeleted(WorkflowRunDeletedPayload) = "workflow.run_deleted",
    /// Emitted when a finished run's results land as a row in the asking session.
    WorkflowResultsPosted(WorkflowResultsPostedPayload) = "workflow.results_posted",
    /// Emitted when a workflow step starts waiting, with what it waits on.
    WorkflowPhaseSuspended(#[garde(dive)] WorkflowPhaseSuspendedPayload) =
        "workflow.phase_suspended",
    /// Emitted when a workflow step's phase fails, saying whether a sibling branch's failure
    /// canceled it.
    WorkflowPhaseFailed(WorkflowPhaseFailedPayload) = "workflow.phase_failed",
    /// Emitted when the memory gate holds a step before it starts, and every 30 seconds while it
    /// holds it.
    WorkflowPhaseWaitingOnPool(WorkflowPhaseWaitingOnPoolPayload) =
        "workflow.phase_waiting_on_pool",
    /// Emitted when a workflow step starts, with the input it ran on.
    WorkflowStepStarted(#[garde(dive)] WorkflowStepStartedPayload) = "workflow.step_started",
    /// Emitted when a workflow step finishes, with its output and log.
    WorkflowStepFinished(#[garde(dive)] WorkflowStepFinishedPayload) = "workflow.step_finished",
    /// Emitted when a workflow step fails, with its error.
    WorkflowStepFailed(#[garde(dive)] WorkflowStepFailedPayload) = "workflow.step_failed",
    /// Emitted when a running or waiting step ends because its run ended failed or canceled, or
    /// when a first-to-arrive merge cancels a branch once another branch arrived.
    WorkflowStepCanceled(WorkflowStepCanceledPayload) = "workflow.step_canceled",
    /// Emitted when a workflow step is skipped.
    WorkflowStepSkipped(WorkflowStepSkippedPayload) = "workflow.step_skipped",
    /// Emitted when a workflow gate is answered.
    WorkflowGateResolved(WorkflowGateResolvedPayload) = "workflow.gate_resolved",
    /// Emitted when a backup run writes a backup.
    BackupCompleted(BackupCompletedPayload) = "backup.completed",
    /// Emitted when a backup run does not finish.
    BackupFailed(BackupFailedPayload) = "backup.failed",
    /// Emitted when the service starts again from a backup.
    BackupRestored(BackupRestoredPayload) = "backup.restored",
    /// Emitted when the service's recovery pass starts, on its own session.
    RecoveryAttempted(#[garde(dive)] RecoveryAttemptedPayload) = "recovery.attempted",
    /// Emitted when the service's recovery pass completes, on its own session.
    RecoverySucceeded(#[garde(dive)] RecoverySucceededPayload) = "recovery.succeeded",
    /// Emitted when the service's recovery pass leaves the node blocked or a session degraded, on
    /// its own session.
    RecoveryFailed(RecoveryFailedPayload) = "recovery.failed",
    /// Emitted on a session with damaged history when it continues from its last good point,
    /// naming the damaged range every read and rebuild skips from then on.
    RecoveryDamagedEventsSkipped(#[garde(dive)] RecoveryDamagedEventsSkippedPayload) =
        "recovery.damaged_events_skipped",
    /// Emitted when the daemon starts preparing a run's provider, workspace or execution state.
    RunStarting(#[garde(dive)] RunStartingPayload) = "run.starting",
    /// Emitted when a run is executing, stamped with the posture it runs under.
    RunRunning(#[garde(dive)] RunRunningPayload) = "run.running",
    /// Emitted when a run blocks on an approval request.
    RunWaitingForApproval(#[garde(dive)] RunWaitingForApprovalPayload) =
        "run.waiting_for_approval",
    /// Emitted when a run blocks on the person's input or answers.
    RunWaitingForInput(#[garde(dive)] RunWaitingForInputPayload) = "run.waiting_for_input",
    /// Emitted when a pause is asked for while the step in flight finishes.
    RunPausing(#[garde(dive)] RunPausingPayload) = "run.pausing",
    /// Emitted when a run is paused.
    RunPaused(#[garde(dive)] RunPausedPayload) = "run.paused",
    /// Emitted when a run finishes, as a turn or as its whole task.
    RunCompleted(#[garde(dive)] RunCompletedPayload) = "run.completed",
    /// Emitted when a run ends on an interrupt, with the daemon's trigger when it interrupted.
    RunInterrupted(#[garde(dive)] RunInterruptedPayload) = "run.interrupted",
    /// Emitted when a child run ends on a stop that reached several agents.
    RunStopped(#[garde(dive)] RunStoppedPayload) = "run.stopped",
    /// Emitted when a run ends on an unrecovered error, with its category and cause.
    RunFailed(#[garde(dive)] RunFailedPayload) = "run.failed",
    /// Emitted when an intervention on a run is requested.
    InterventionRequested(InterventionRequestedPayload) = "intervention.requested",
    /// Emitted when an intervention is accepted for application.
    InterventionAccepted(InterventionAcceptedPayload) = "intervention.accepted",
    /// Emitted when an intervention is applied to its run.
    InterventionApplied(InterventionAppliedPayload) = "intervention.applied",
    /// Emitted when an intervention is rejected.
    InterventionRejected(InterventionRejectedPayload) = "intervention.rejected",
    /// Emitted when an intervention is applied with a degraded effect.
    InterventionDegraded(InterventionDegradedPayload) = "intervention.degraded",
    /// Emitted when an intervention expires without being applied.
    InterventionExpired(InterventionExpiredPayload) = "intervention.expired",
    /// Emitted when an intervention's dispatch throws, so it ends without a driver verdict.
    InterventionFailed(InterventionFailedPayload) = "intervention.failed",
}

/// Why a stored envelope does not read as a [`SessionEvent`]. The envelope itself stays valid
/// and is kept; only the strict read fails.
#[derive(Debug, thiserror::Error)]
pub enum SessionEventReadError {
    /// The type is not one this build registers: a newer producer's version stub.
    #[error("the event type {0} is not one this build registers")]
    UnknownType(String),
    /// The envelope's category is not its type's own.
    #[error("an event of type {} belongs to {expected:?}, not {found:?}", .event_type.as_str())]
    CategoryMismatch {
        /// The event's type.
        event_type: SessionEventType,
        /// The type's own category.
        expected: EventCategory,
        /// The category the envelope carries.
        found: EventCategory,
    },
    /// The type is registered but declares no payload variant, so no strict event reads from it.
    #[error("the event type {} registers no payload variant", .0.as_str())]
    NoPayloadVariant(SessionEventType),
    /// The payload does not have its type's shape.
    #[error("the payload does not read as its type's: {0}")]
    Payload(#[from] serde_json::Error),
    /// The payload has its type's shape but breaks one of its checks.
    #[error("the payload breaks a check of its type: {0}")]
    Check(#[from] garde::Report),
}

impl SessionEvent {
    /// Reads the strict event from a stored envelope's `type` and `payload`, after checking that
    /// the envelope's category is its type's own. Fails with [`SessionEventReadError`] on an
    /// unregistered type, a mismatched category, a type with no payload variant, or a payload its
    /// type's schema refuses.
    pub fn from_envelope(envelope: &EventEnvelope) -> Result<Self, SessionEventReadError> {
        let type_name = envelope.event_type.as_str();
        let event_type = SessionEventType::from_wire_name(type_name)
            .ok_or_else(|| SessionEventReadError::UnknownType(type_name.to_owned()))?;
        let expected = event_type.category();
        if envelope.category != expected {
            return Err(SessionEventReadError::CategoryMismatch {
                event_type,
                expected,
                found: envelope.category,
            });
        }
        let event = Self::read_payload(event_type, &envelope.payload)
            .ok_or(SessionEventReadError::NoPayloadVariant(event_type))??;
        garde::Validate::validate(&event)?;
        Ok(event)
    }
}

/// The TypeScript module of the strict session event.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "event/session",
    doc: "The strict session event: an envelope's `type` and `payload`, the payload parsed by the \
          schema its type registers. The envelope is read tolerant and the event strict.",
    definitions: &[
        Definition::read::<ApprovalReviewerDeniedEventPayload>(),
        Definition::read::<SessionEvent>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{SessionEvent, SessionEventReadError};
    use crate::event::envelope::EventEnvelope;

    /// A stored envelope's text with the given type, category and payload.
    fn envelope_text(event_type: &str, category: &str, payload: &Value) -> String {
        json!({
            "id": "0199e0a4-3c1d-7b2e-9f40-5a6b7c8d9e0f",
            "sessionId": "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "sequence": 42,
            "occurredAt": "2026-10-13T15:00:00.000Z",
            "category": category,
            "type": event_type,
            "actor": null,
            "payload": payload,
            "correlationId": "operation-7",
            "version": "1.0",
        })
        .to_string()
    }

    /// The canonical bytes of `text` read as JSON.
    fn canonical_text(text: &str) -> Vec<u8> {
        let value: Value = serde_json::from_str(text).expect("the text is JSON");
        serde_json_canonicalizer::to_vec(&value).expect("the value canonicalizes")
    }

    #[test]
    fn a_version_stub_keeps_its_bytes_and_reads_as_the_native_event_once_its_type_is_known() {
        // A newer producer's type this build does not register, its payload nested.
        let stub_text = envelope_text(
            "session.handed_over",
            "session_lifecycle",
            &json!({
                "handedTo": { "deviceId": "device-2", "reasons": ["away", null, 3] },
                "attempt": 2,
                "note": null,
            }),
        );
        let stub: EventEnvelope = serde_json::from_str(&stub_text).expect("the stub reads");
        assert_eq!(
            serde_json_canonicalizer::to_vec(&stub).expect("the stub canonicalizes"),
            canonical_text(&stub_text),
        );
        assert!(matches!(
            SessionEvent::from_envelope(&stub),
            Err(SessionEventReadError::UnknownType(name)) if name == "session.handed_over"
        ));

        // The same path for a registered type reads to the event its native form reads to.
        let payload = json!({
            "sessionId": "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "at": "2026-10-13T15:00:00.000Z",
        });
        let known_text = envelope_text("session.pinned", "session_lifecycle", &payload);
        let known: EventEnvelope = serde_json::from_str(&known_text).expect("the envelope reads");
        let kept_bytes =
            serde_json_canonicalizer::to_vec(&known).expect("the envelope canonicalizes");
        assert_eq!(kept_bytes, canonical_text(&known_text));
        // The kept bytes, read back, give the event the native form reads to.
        let reread: EventEnvelope =
            serde_json::from_slice(&kept_bytes).expect("the kept bytes read back");
        let native: SessionEvent =
            serde_json::from_value(json!({ "type": "session.pinned", "payload": payload }))
                .expect("the native event reads");
        assert_eq!(
            SessionEvent::from_envelope(&reread).expect("the known type reads"),
            native
        );
    }
}
