//! The strict session event: an envelope's `type` and `payload`, the payload parsed by the schema
//! its type registers. Every type in [`SessionEventType`] has a payload variant. The envelope stays
//! the tolerant layer that stores and passes on any type; the strict event is read from it with
//! [`SessionEvent::from_envelope`].

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent::provider_binding::{
    AgentProviderBindingChangeFailedPayload, AgentProviderBindingChangedPayload,
};
use crate::approval::events::{
    ApprovalCanceledPayload, ApprovalDenialOverriddenPayload, ApprovalRequestedPayload,
    ApprovalResolvedPayload, ApprovalReviewerDeniedPayload, ApprovalRuleRememberedPayload,
    ApprovalRuleRevokedPayload,
};
use crate::artifacts::publication::ArtifactPublicationPayload;
use crate::cloud::CloudTaskUpdatedPayload;
use crate::command::AgentCommandEndedPayload;
use crate::daemon::backup::{
    DaemonBackupCompletedPayload, DaemonBackupFailedPayload, DaemonBackupRestoredPayload,
};
use crate::daemon::recovery::{
    DaemonRecoveryAttemptedPayload, DaemonRecoveryFailedPayload, DaemonRecoverySucceededPayload,
};
use crate::event::declared_variants::{
    AgentOutputPayload, SessionEventCompactedPayload, ToolActivityPayload,
};
use crate::event::envelope::{EventCategory, EventEnvelope};
use crate::event::registry::SessionEventType;
use crate::event::usage::{
    AgentRunContextCompactedPayload, AgentTurnReroutedPayload, UsageApiRequestRetriedPayload,
    UsageContextWindowUpdatedPayload, UsageCostUpdatedPayload, UsageRateLimitUpdatedPayload,
    UsageTokenCountRecordedPayload,
};
use crate::git::local::GitSettledPayload;
use crate::mcp::governance::McpServerSignInCompletedPayload;
use crate::orchestration::AgentRunRejectedPayload;
use crate::plan::{
    PlanAcceptedPayload, PlanHandedOffPayload, PlanHoldEndedPayload, PlanKeptPayload,
    PlanProposedPayload,
};
use crate::question::{QuestionAskedPayload, QuestionCanceledPayload};
use crate::relay::RelayPinRefusedPayload;
use crate::repo::mount::{RepoMountHealthChangedPayload, WorkspaceLifecyclePayload};
use crate::run::control::{
    AgentRunRecoveryResolvedPayload, AgentRunRecoveryStepsAddedPayload, AgentRunRolledBackEvent,
};
use crate::run::events::{
    AgentInterventionAcceptedPayload, AgentInterventionAppliedPayload,
    AgentInterventionDegradedPayload, AgentInterventionExpiredPayload,
    AgentInterventionFailedPayload, AgentInterventionRejectedPayload,
    AgentInterventionRequestedPayload, AgentRunCompletedPayload, AgentRunFailedPayload,
    AgentRunInterruptedPayload, AgentRunPausedPayload, AgentRunPausingPayload,
    AgentRunProviderInitializedPayload, AgentRunRunningPayload, AgentRunStartingPayload,
    AgentRunStoppedPayload, AgentRunWaitingForApprovalPayload, AgentRunWaitingForInputPayload,
    AgentRunWorkerShuttingDownPayload, AgentTurnCompletedPayload, AgentTurnFailedPayload,
    AgentTurnInterruptedPayload, AgentTurnStartedPayload,
};
use crate::run::id::RunId;
use crate::run::provider_choice::{
    AgentRunRefusalChoiceRequestedPayload, AgentRunRefusalChoiceResolvedPayload,
    AgentRunUsageCreditsChoiceRequestedPayload, AgentRunUsageCreditsChoiceResolvedPayload,
};
use crate::run::queue::{
    AgentQueueItemAdmittedPayload, AgentQueueItemCanceledPayload, AgentQueueItemCreatedPayload,
    AgentQueueItemNotDeliveredPayload, AgentQueueItemSupersededPayload, UserMessageSentPayload,
};
use crate::run::queued::AgentRunQueuedPayload;
use crate::run::subagent::SubagentLifecyclePayload;
use crate::session::controls::events::{
    AgentRunStepLimitReachedPayload, AgentRunTokenLimitReachedPayload,
    ApprovalReviewerFlaggedPayload, SessionNotice, SessionNoticePostedPayload,
    SessionSideQuestionAnsweredPayload, SessionSpendLimitReachedPayload,
};
use crate::session::convert::SessionConvertedPayload;
use crate::session::events::{
    SessionAdvisorChangedPayload, SessionCreatedPayload, SessionLifecycleChangePayload,
    SessionMarkChangePayload, SessionOutputStyleChangedPayload,
    SessionProviderStatusReportedPayload, SessionRenamedPayload,
};
use crate::session::goal::{SessionGoalClearedPayload, SessionGoalUpdatedPayload};
use crate::session::recovery::SessionDamagedEventsSkippedPayload;
use crate::session::restore::SessionRestoreCompletedPayload;
use crate::terminal::control::TerminalControlChangedPayload;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::workflow::definition::events::{
    WorkflowTriggerArmedPayload, WorkflowTriggerFiredPayload, WorkflowVersionCreatedPayload,
};
use crate::workflow::run::events::{
    WorkflowGateReachedPayload, WorkflowResultsPostedPayload, WorkflowRunCanceledPayload,
    WorkflowRunCompletedPayload, WorkflowRunDeletedPayload, WorkflowRunFailedPayload,
    WorkflowRunResumedPayload, WorkflowRunStartedPayload, WorkflowRunWaitingPayload,
};
use crate::workflow::run::step::events::{
    WorkflowGateResolvedPayload, WorkflowParallelJoinBranchesCanceledPayload,
    WorkflowPhaseAdmittedPayload, WorkflowPhaseCancelingPayload, WorkflowPhaseCompletedPayload,
    WorkflowPhaseFailedPayload, WorkflowPhaseProgressedPayload, WorkflowPhaseResumedPayload,
    WorkflowPhaseRetriedPayload, WorkflowPhaseStartedPayload, WorkflowPhaseSuspendedPayload,
    WorkflowPhaseWaitingOnPoolPayload, WorkflowStepCanceledPayload, WorkflowStepCompletedPayload,
    WorkflowStepFailedPayload, WorkflowStepSkippedPayload, WorkflowStepStartedPayload,
};
use crate::worktree::events::{
    SessionBranchChangedPayload, SessionSweptToCheckoutPayload, WorktreeCreatedPayload,
    WorktreeRetiredPayload,
};
use crate::worktree::lifecycle::WorktreeLifecyclePayload;

/// The run an event belongs to: its payload's `runId`, with its `runVersion` and `turnNumber`
/// where it carries them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EventRun {
    /// The run.
    pub run_id: RunId,
    /// The run's progression counter the event was written at.
    pub run_version: Option<SafeInt<0>>,
    /// The turn's number within its run, on a turn's start and its end.
    pub turn_number: Option<SafeInt<1>>,
}

/// One arm of [`SessionEvent::run`]: the pattern that binds the payload where its run is read,
/// then the run read from it, as the arm's rule in the registration table says: `versioned` for a
/// `runId` and a `runVersion`, `turn` for those and a `turnNumber`, `required` for a `runId`
/// alone, `optional` for an optional `runId`, `read(function)` for a payload union whose arms
/// differ, and no rule for no run.
macro_rules! event_run {
    (@binding $payload:ident) => {
        _
    };
    (@binding $payload:ident $rule:ident $(($read:ident))?) => {
        $payload
    };
    ($payload:ident) => {
        None
    };
    ($payload:ident versioned) => {
        Some(EventRun {
            run_id: $payload.run_id,
            run_version: Some($payload.run_version),
            turn_number: None,
        })
    };
    ($payload:ident turn) => {
        Some(EventRun {
            run_id: $payload.run_id,
            run_version: Some($payload.run_version),
            turn_number: Some($payload.turn_number),
        })
    };
    ($payload:ident required) => {
        Some(EventRun {
            run_id: $payload.run_id,
            run_version: None,
            turn_number: None,
        })
    };
    ($payload:ident optional) => {
        $payload.run_id.map(|run_id| EventRun {
            run_id,
            run_version: None,
            turn_number: None,
        })
    };
    ($payload:ident read($read:ident)) => {
        $read($payload)
    };
}

/// Declares [`SessionEvent`] from one registration table: each row is an arm named as its
/// [`SessionEventType`] variant, its payload (with `#[garde(dive)]` where the payload has checks),
/// its wire name and, after `=>`, the rule its run is read by (see `event_run!`). The same table
/// lists [`SESSION_EVENT_TYPES`].
macro_rules! session_events {
    ($(
        $(#[doc = $doc:literal])+
        $variant:ident($(#[$check:meta])? $payload:ty) = $name:literal
            $(=> $rule:ident $(($read:ident))?)?,
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

            /// The run the event belongs to, where its payload names one.
            pub fn run(&self) -> Option<EventRun> {
                match self {
                    $(Self::$variant(event_run!(@binding payload $($rule $(($read))?)?)) => {
                        event_run!(payload $($rule $(($read))?)?)
                    })+
                }
            }

            /// Reads `payload` as the payload variant `event_type` registers, borrowing it.
            fn read_payload(
                event_type: SessionEventType,
                payload: &Map<String, Value>,
            ) -> Result<Self, serde_json::Error> {
                match event_type {
                    $(SessionEventType::$variant => {
                        <$payload as Deserialize>::deserialize(payload).map(Self::$variant)
                    })+
                }
            }
        }

        ts_constants! {
            /// The event types `SessionEvent` registers, each with its payload variant.
            pub const SESSION_EVENT_TYPES: &[SessionEventType] =
                &[$(SessionEventType::$variant,)+];
        }
    };
}

session_events! {
    /// Emitted when a session is admitted.
    SessionCreated(#[garde(dive)] Box<SessionCreatedPayload>) = "session.created",
    /// Emitted when a workspace's preparation begins, the first time or again.
    WorkspacePreparing(WorkspaceLifecyclePayload) = "workspace.preparing",
    /// Emitted when preparation completes and the execution root is bound.
    WorkspacePrepared(WorkspaceLifecyclePayload) = "workspace.prepared",
    /// Emitted when a workspace becomes unavailable: a failed preparation, or a path that went
    /// away after binding. Write runs are blocked until repair.
    WorkspaceRootLost(WorkspaceLifecyclePayload) = "workspace.rootLost",
    /// Emitted once per dependent workspace archived by the detach cascade.
    WorkspaceArchived(WorkspaceLifecyclePayload) = "workspace.archived",
    /// Emitted with the worktree's record; carries the kept copy a put-back came from, if any.
    WorktreeCreated(WorktreeCreatedPayload) = "worktree.created",
    /// Emitted when the checkout is bound as an execution root.
    WorktreeBound(WorktreeLifecyclePayload) = "worktree.bound",
    /// Emitted when uncommitted work was observed in the checkout.
    WorktreeDirtied(WorktreeLifecyclePayload) = "worktree.dirtied",
    /// Emitted when the worktree's branch has merged back.
    WorktreeMerged(WorktreeLifecyclePayload) = "worktree.merged",
    /// Emitted when a worktree retires, recorded before any disk change; cleanup is asynchronous
    /// and idempotent. Carries the kept copy when a discard kept one.
    WorktreeRetired(WorktreeRetiredPayload) = "worktree.retired",
    /// Emitted once per session deletion that deleted rows.
    SessionEventCompacted(#[garde(dive)] SessionEventCompactedPayload) = "session.event.compacted",
    /// Emitted when the agent produces a message; its body is kept apart from the payload.
    AgentMessageSent(#[garde(dive)] AgentOutputPayload) = "agent.message.sent"
        => read(agent_output_run),
    /// Emitted when the agent reports a reasoning update; its body is kept apart.
    AgentThinkingUpdated(#[garde(dive)] AgentOutputPayload) = "agent.thinking.updated"
        => read(agent_output_run),
    /// Emitted when a tool call starts; its arguments are kept apart from the payload.
    AgentToolCallInvoked(#[garde(dive)] ToolActivityPayload) = "agent.toolCall.invoked" => required,
    /// Emitted when a tool call returns; its result is kept apart from the payload.
    AgentToolCallCompleted(#[garde(dive)] ToolActivityPayload) = "agent.toolCall.completed"
        => required,
    /// Emitted when a tool call fails; its error body is kept apart from the payload.
    AgentToolCallFailed(#[garde(dive)] ToolActivityPayload) = "agent.toolCall.failed" => required,
    /// Emitted when a provider's own subagent starts under a run.
    AgentSubagentStarted(#[garde(dive)] SubagentLifecyclePayload) = "agent.subagent.started"
        => required,
    /// Emitted when a provider's own subagent finishes, paired to its start.
    AgentSubagentCompleted(#[garde(dive)] SubagentLifecyclePayload) = "agent.subagent.completed"
        => required,
    /// Emitted when the provider process reports its start for a run; it moves no state.
    AgentRunProviderInitialized(AgentRunProviderInitializedPayload)
        = "agent.run.providerInitialized" => versioned,
    /// Emitted when a turn opens within a run; it moves no state.
    AgentTurnStarted(AgentTurnStartedPayload) = "agent.turn.started" => turn,
    /// Emitted when a turn ends normally; it moves no state.
    AgentTurnCompleted(AgentTurnCompletedPayload) = "agent.turn.completed" => turn,
    /// Emitted when a turn is cut, its partial output kept; it moves no state.
    AgentTurnInterrupted(AgentTurnInterruptedPayload) = "agent.turn.interrupted" => turn,
    /// Emitted when a turn fails; it moves no state.
    AgentTurnFailed(AgentTurnFailedPayload) = "agent.turn.failed" => turn,
    /// Emitted when the provider says its worker is shutting down mid-run; never the run's end.
    AgentRunWorkerShuttingDown(AgentRunWorkerShuttingDownPayload) = "agent.run.workerShuttingDown"
        => versioned,
    /// Emitted when the provider reports a coarse status for its session.
    SessionProviderStatusReported(#[garde(dive)] SessionProviderStatusReportedPayload)
        = "session.providerStatus.reported" => optional,
    /// Emitted when an approval request is refused, and by whom.
    ApprovalRejected(ApprovalResolvedPayload) = "approval.rejected" => required,
    /// Emitted when an ask ends with its run and can no longer be answered.
    ApprovalCanceled(ApprovalCanceledPayload) = "approval.canceled" => required,
    /// Emitted when an approval rule is remembered; the payload is the whole rule.
    ApprovalRuleRemembered(ApprovalRuleRememberedPayload) = "approval.rule.remembered" => required,
    /// Emitted when a remembered approval rule is revoked.
    ApprovalRuleRevoked(ApprovalRuleRevokedPayload) = "approval.rule.revoked" => optional,
    /// Emitted when a provider's own reviewer flags an item with a warning or a required review.
    ApprovalReviewerFlagged(ApprovalReviewerFlaggedPayload) = "approval.reviewer.flagged"
        => required,
    /// Emitted when an agent proposes a plan; the payload is the record the screen renders.
    PlanProposed(PlanProposedPayload) = "plan.proposed" => required,
    /// Emitted when a proposed plan is accepted and is being built in its own session.
    PlanAccepted(PlanAcceptedPayload) = "plan.accepted",
    /// Emitted when a plan seeds a fresh session.
    PlanHandedOff(PlanHandedOffPayload) = "plan.handedOff",
    /// Emitted when the person keeps planning and the plan stays a record.
    PlanKept(PlanKeptPayload) = "plan.kept",
    /// Emitted when the provider request a plan held ends with no verdict.
    PlanHoldEnded(PlanHoldEndedPayload) = "plan.hold.ended",
    /// Emitted when an agent, tool server or workflow step asks the person a question.
    QuestionAsked(#[garde(dive)] QuestionAskedPayload) = "question.asked"
        => read(question_asked_run),
    /// Emitted when an open question ends unanswered.
    QuestionCanceled(QuestionCanceledPayload) = "question.canceled",
    /// Emitted when the daemon accepts a message the person sent, or a voice call hears one.
    UserMessageSent(UserMessageSentPayload) = "user.message.sent" => optional,
    /// Emitted when a message the person sent is queued.
    AgentQueueItemCreated(AgentQueueItemCreatedPayload) = "agent.queueItem.created",
    /// Emitted when the agent takes a queued message.
    AgentQueueItemAdmitted(AgentQueueItemAdmittedPayload) = "agent.queueItem.admitted" => required,
    /// Emitted when an edit replaces a waiting message, naming the message that replaced it.
    AgentQueueItemSuperseded(AgentQueueItemSupersededPayload) = "agent.queueItem.superseded",
    /// Emitted when a waiting message is removed before the agent takes it.
    AgentQueueItemCanceled(AgentQueueItemCanceledPayload) = "agent.queueItem.canceled",
    /// Emitted when a taken message could not be delivered, with the reason.
    AgentQueueItemNotDelivered(AgentQueueItemNotDeliveredPayload) = "agent.queueItem.notDelivered",
    /// Emitted when an MCP server sign-in ends, in success or failure.
    McpServerSignInCompleted(McpServerSignInCompletedPayload) = "mcp.server.signIn.completed",
    /// Emitted when a cloud task is sent, changes state or is brought back.
    CloudTaskUpdated(CloudTaskUpdatedPayload) = "cloud.task.updated",
    /// Emitted when an undo finishes, with what applied and what did not.
    SessionRestoreCompleted(#[garde(dive)] SessionRestoreCompletedPayload) =
        "session.restore.completed",
    /// Emitted when a session's goal is removed.
    SessionGoalCleared(SessionGoalClearedPayload) = "session.goal.cleared",
    /// Emitted for a plain-sentence notice about the session, such as a warning from the
    /// provider.
    SessionNoticePosted(#[garde(dive)] SessionNoticePostedPayload) = "session.notice.posted"
        => read(session_notice_run),
    /// Emitted when a side question is answered; the aside never enters the conversation.
    SessionSideQuestionAnswered(SessionSideQuestionAnsweredPayload) =
        "session.sideQuestion.answered",
    /// Emitted when the session's spend passes its spend limit and its running turns stop.
    SessionSpendLimitReached(SessionSpendLimitReachedPayload) = "session.spendLimit.reached",
    /// Emitted when a git act leaves or changes the session's branch.
    GitSettled(GitSettledPayload) = "git.settled" => read(git_settled_run),
    /// Emitted when the relay presents a key that does not match the pinned one.
    RelayPinRefused(RelayPinRefusedPayload) = "relay.pin.refused",
    /// Emitted when a command ends; it takes the epoch stamp.
    AgentCommandEnded(#[garde(dive)] AgentCommandEndedPayload) = "agent.command.ended" => required,
    /// Emitted when a turn's own token figures are recorded; it takes the epoch stamp.
    UsageTokenCountRecorded(#[garde(dive)] UsageTokenCountRecordedPayload)
        = "usage.tokenCount.recorded" => optional,
    /// Emitted when a request is priced; it takes the epoch stamp.
    UsageCostUpdated(#[garde(dive)] UsageCostUpdatedPayload) = "usage.cost.updated" => optional,
    /// Emitted when the context window's reading changes; it takes the epoch stamp.
    UsageContextWindowUpdated(#[garde(dive)] UsageContextWindowUpdatedPayload) =
        "usage.contextWindow.updated" => optional,
    /// Emitted when a provider reports one of an account's quotas.
    UsageRateLimitUpdated(#[garde(dive)] UsageRateLimitUpdatedPayload) = "usage.rateLimit.updated",
    /// Emitted when the provider retries a request mid-run; it takes the epoch stamp.
    UsageApiRequestRetried(#[garde(dive)] UsageApiRequestRetriedPayload)
        = "usage.apiRequest.retried" => optional,
    /// Emitted when the provider compacts a run's context; it takes the epoch stamp.
    AgentRunContextCompacted(#[garde(dive)] AgentRunContextCompactedPayload)
        = "agent.run.context.compacted" => required,
    /// Emitted when the provider moves a turn onto another model; it takes the epoch stamp.
    AgentTurnRerouted(#[garde(dive)] AgentTurnReroutedPayload) = "agent.turn.rerouted" => required,
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
    SessionBranchChanged(SessionBranchChangedPayload) = "session.branch.changed",
    /// Emitted when a worktree removal moves a session back to the repository root.
    SessionSweptToCheckout(SessionSweptToCheckoutPayload) = "session.sweptToCheckout",
    /// Emitted when an agent's provider binding is switched.
    AgentProviderBindingChanged(#[garde(dive)] AgentProviderBindingChangedPayload) =
        "agent.providerBinding.changed",
    /// Emitted when an accepted binding switch could not be applied.
    AgentProviderBindingChangeFailed(#[garde(dive)] AgentProviderBindingChangeFailedPayload) =
        "agent.providerBinding.changeFailed",
    /// Emitted when an approval is requested, including a provider's permission ask.
    ApprovalRequested(ApprovalRequestedPayload) = "approval.requested" => required,
    /// Emitted when an approval request is granted, and by whom.
    ApprovalApproved(ApprovalResolvedPayload) = "approval.approved" => required,
    /// Emitted when the provider's own reviewer blocks an action.
    ApprovalReviewerDenied(ApprovalReviewerDeniedPayload) = "approval.reviewer.denied"
        => required,
    /// Emitted when the person allows a blocked action once.
    ApprovalDenialOverridden(ApprovalDenialOverriddenPayload) = "approval.denial.overridden",
    /// Emitted when a run is queued.
    AgentRunQueued(#[garde(dive)] AgentRunQueuedPayload) = "agent.run.queued"
        => read(run_queued_run),
    /// Emitted when a turn reaches the step bound and ends there.
    AgentRunStepLimitReached(AgentRunStepLimitReachedPayload) = "agent.run.stepLimit.reached"
        => required,
    /// Emitted when a run passes its token limit and ends.
    AgentRunTokenLimitReached(AgentRunTokenLimitReachedPayload) = "agent.run.tokenLimit.reached"
        => required,
    /// Emitted when the person's choice settles a run's recovery question.
    AgentRunRecoveryResolved(AgentRunRecoveryResolvedPayload) = "agent.run.recovery.resolved"
        => required,
    /// Emitted when a restart found steps in the provider's own record that only read, added
    /// them to the transcript and let the run go on.
    AgentRunRecoveryStepsAdded(AgentRunRecoveryStepsAddedPayload) = "agent.run.recoverySteps.added"
        => required,
    /// Emitted when the provider's own advisor command changes the session's advisor, or turns it
    /// off.
    SessionAdvisorChanged(#[garde(dive)] SessionAdvisorChangedPayload) =
        "session.advisor.changed",
    /// Emitted when the provider's own output-style command changes the session's output style.
    SessionOutputStyleChanged(#[garde(dive)] SessionOutputStyleChangedPayload) =
        "session.outputStyle.changed",
    /// Emitted on every session on a mount when the daemon's re-probe changes the mount's health.
    RepoMountHealthChanged(#[garde(dive)] RepoMountHealthChangedPayload) =
        "repoMount.health.changed",
    /// Emitted when admission refuses an `agent.run.create`; no run or queue item is left.
    AgentRunRejected(AgentRunRejectedPayload) = "agent.run.rejected",
    /// Emitted in the write of every artifact's manifest; its payload keeps members it does not
    /// know.
    ArtifactPublished(ArtifactPublicationPayload) = "artifact.published" => optional,
    /// Emitted when the provider refuses a turn, names a fallback model and asks to retry or edit.
    AgentRunRefusalChoiceRequested(AgentRunRefusalChoiceRequestedPayload) =
        "agent.run.refusalChoice.requested" => required,
    /// Emitted when the first answer settles a refused turn's retry-or-edit choice.
    AgentRunRefusalChoiceResolved(AgentRunRefusalChoiceResolvedPayload)
        = "agent.run.refusalChoice.resolved" => required,
    /// Emitted when a turn's model needs usage credits and the provider asks to switch or go on.
    AgentRunUsageCreditsChoiceRequested(AgentRunUsageCreditsChoiceRequestedPayload) =
        "agent.run.usageCreditsChoice.requested" => required,
    /// Emitted when a turn's switch-or-credits choice settles.
    AgentRunUsageCreditsChoiceResolved(AgentRunUsageCreditsChoiceResolvedPayload) =
        "agent.run.usageCreditsChoice.resolved" => required,
    /// Emitted when a session's goal is set or changes status.
    SessionGoalUpdated(#[garde(dive)] SessionGoalUpdatedPayload) = "session.goal.updated",
    /// Emitted when a session is renamed.
    SessionRenamed(SessionRenamedPayload) = "session.renamed",
    /// Emitted when the holder of a shell changes.
    TerminalControlChanged(#[garde(dive)] TerminalControlChangedPayload)
        = "terminal.control.changed",
    /// Emitted when a workflow run starts.
    WorkflowRunStarted(WorkflowRunStartedPayload) = "workflow.run.started",
    /// Emitted when a workflow run resumes.
    WorkflowRunResumed(#[garde(dive)] WorkflowRunResumedPayload) = "workflow.run.resumed",
    /// Emitted when a workflow run is canceled.
    WorkflowRunCanceled(#[garde(dive)] WorkflowRunCanceledPayload) = "workflow.run.canceled",
    /// Emitted when the person deletes a workflow run.
    WorkflowRunDeleted(WorkflowRunDeletedPayload) = "workflow.run.deleted",
    /// Emitted when a finished run's results land as a row in the asking session.
    WorkflowResultsPosted(WorkflowResultsPostedPayload) = "workflow.results.posted",
    /// Emitted when a workflow step starts waiting, with what it waits on.
    WorkflowPhaseSuspended(#[garde(dive)] WorkflowPhaseSuspendedPayload) =
        "workflow.phase.suspended",
    /// Emitted when a workflow step's phase fails, saying whether a sibling branch's failure
    /// canceled it.
    WorkflowPhaseFailed(WorkflowPhaseFailedPayload) = "workflow.phase.failed",
    /// Emitted when the memory gate holds a step before it starts, and every 30 seconds while it
    /// holds it.
    WorkflowPhaseWaitingOnPool(WorkflowPhaseWaitingOnPoolPayload) =
        "workflow.phase.waitingOnPool",
    /// Emitted when a workflow step starts, with the input it ran on.
    WorkflowStepStarted(#[garde(dive)] WorkflowStepStartedPayload) = "workflow.step.started",
    /// Emitted when a workflow step finishes, with its output and log.
    WorkflowStepCompleted(#[garde(dive)] WorkflowStepCompletedPayload) = "workflow.step.completed",
    /// Emitted when a workflow step fails, with its error.
    WorkflowStepFailed(#[garde(dive)] WorkflowStepFailedPayload) = "workflow.step.failed",
    /// Emitted when a running or waiting step ends because its run ended failed or canceled, or
    /// when a first-to-arrive merge cancels a branch once another branch arrived.
    WorkflowStepCanceled(WorkflowStepCanceledPayload) = "workflow.step.canceled",
    /// Emitted when a workflow step is skipped.
    WorkflowStepSkipped(WorkflowStepSkippedPayload) = "workflow.step.skipped",
    /// Emitted when a workflow gate is answered.
    WorkflowGateResolved(WorkflowGateResolvedPayload) = "workflow.gate.resolved",
    /// Emitted when a workflow is authored or a new version of it is written.
    WorkflowVersionCreated(WorkflowVersionCreatedPayload) = "workflow.version.created",
    /// Emitted when a workflow run reaches a gate that must be answered before it goes on.
    WorkflowGateReached(WorkflowGateReachedPayload) = "workflow.gate.reached",
    /// Emitted when a workflow run ends on a failure.
    WorkflowRunFailed(WorkflowRunFailedPayload) = "workflow.run.failed",
    /// Emitted when a workflow run reaches its last steps and succeeds.
    WorkflowRunCompleted(WorkflowRunCompletedPayload) = "workflow.run.completed",
    /// Emitted when a workflow run starts waiting, on a person, its chain's question or a spent
    /// provider account.
    WorkflowRunWaiting(WorkflowRunWaitingPayload) = "workflow.run.waiting",
    /// Emitted when a workflow's schedule is armed.
    WorkflowScheduleArmed(WorkflowTriggerArmedPayload) = "workflow.schedule.armed",
    /// Emitted when an armed schedule fires, starting a run.
    WorkflowScheduleFired(#[garde(dive)] WorkflowTriggerFiredPayload) = "workflow.schedule.fired",
    /// Emitted when a workflow's file watch, webhook or session-event filter is armed.
    WorkflowTriggerArmed(WorkflowTriggerArmedPayload) = "workflow.trigger.armed",
    /// Emitted when an armed trigger other than a schedule fires, starting a run.
    WorkflowTriggerFired(#[garde(dive)] WorkflowTriggerFiredPayload) = "workflow.trigger.fired",
    /// Emitted when the memory gate admits a workflow step, which may start.
    WorkflowPhaseAdmitted(WorkflowPhaseAdmittedPayload) = "workflow.phase.admitted",
    /// Emitted when an admitted workflow phase begins.
    WorkflowPhaseStarted(WorkflowPhaseStartedPayload) = "workflow.phase.started",
    /// Emitted when a workflow phase reports progress.
    WorkflowPhaseProgressed(WorkflowPhaseProgressedPayload) = "workflow.phase.progressed",
    /// Emitted when a workflow phase is asked to stop and is winding down.
    WorkflowPhaseCanceling(WorkflowPhaseCancelingPayload) = "workflow.phase.canceling",
    /// Emitted when a failed workflow phase is retried as a new attempt.
    WorkflowPhaseRetried(WorkflowPhaseRetriedPayload) = "workflow.phase.retried",
    /// Emitted when a waiting workflow step resumes.
    WorkflowPhaseResumed(WorkflowPhaseResumedPayload) = "workflow.phase.resumed",
    /// Emitted when a workflow phase finishes.
    WorkflowPhaseCompleted(WorkflowPhaseCompletedPayload) = "workflow.phase.completed",
    /// Emitted once per wave of running sibling branches a join cancels.
    WorkflowParallelJoinBranchesCanceled(WorkflowParallelJoinBranchesCanceledPayload) =
        "workflow.parallelJoin.branchesCanceled",
    /// Emitted when a backup run writes a backup.
    DaemonBackupCompleted(DaemonBackupCompletedPayload) = "daemon.backup.completed",
    /// Emitted when a backup run does not finish.
    DaemonBackupFailed(DaemonBackupFailedPayload) = "daemon.backup.failed",
    /// Emitted when the service starts again from a backup.
    DaemonBackupRestored(#[garde(dive)] DaemonBackupRestoredPayload) = "daemon.backup.restored",
    /// Emitted when the service's recovery pass starts, on its own session.
    DaemonRecoveryAttempted(#[garde(dive)] DaemonRecoveryAttemptedPayload)
        = "daemon.recovery.attempted",
    /// Emitted when the service's recovery pass completes, on its own session.
    DaemonRecoverySucceeded(#[garde(dive)] DaemonRecoverySucceededPayload)
        = "daemon.recovery.succeeded",
    /// Emitted when the service's recovery pass leaves the machine blocked or a session degraded,
    /// on its own session.
    DaemonRecoveryFailed(DaemonRecoveryFailedPayload) = "daemon.recovery.failed",
    /// Emitted on a session with damaged history when it continues from its last good point,
    /// naming the damaged range every read and rebuild skips from then on.
    SessionDamagedEventsSkipped(#[garde(dive)] SessionDamagedEventsSkippedPayload) =
        "session.damagedEvents.skipped",
    /// Emitted when the daemon starts preparing a run's provider, workspace or execution state.
    AgentRunStarting(#[garde(dive)] AgentRunStartingPayload) = "agent.run.starting" => versioned,
    /// Emitted when a run is executing, stamped with the posture it runs under.
    AgentRunRunning(#[garde(dive)] AgentRunRunningPayload) = "agent.run.running" => versioned,
    /// Emitted when a run blocks on an approval request.
    AgentRunWaitingForApproval(#[garde(dive)] AgentRunWaitingForApprovalPayload) =
        "agent.run.waitingForApproval" => versioned,
    /// Emitted when a run blocks on the person's input or answers.
    AgentRunWaitingForInput(#[garde(dive)] AgentRunWaitingForInputPayload)
        = "agent.run.waitingForInput" => versioned,
    /// Emitted when a pause is asked for while the step in flight finishes.
    AgentRunPausing(#[garde(dive)] AgentRunPausingPayload) = "agent.run.pausing" => versioned,
    /// Emitted when a run is paused.
    AgentRunPaused(#[garde(dive)] AgentRunPausedPayload) = "agent.run.paused" => versioned,
    /// Emitted when a run finishes, as a turn or as its whole task.
    AgentRunCompleted(#[garde(dive)] AgentRunCompletedPayload) = "agent.run.completed" => versioned,
    /// Emitted when a run ends on an interrupt, with the daemon's trigger when it interrupted.
    AgentRunInterrupted(#[garde(dive)] AgentRunInterruptedPayload) = "agent.run.interrupted"
        => versioned,
    /// Emitted when a child run ends on a stop that reached several agents.
    AgentRunStopped(#[garde(dive)] AgentRunStoppedPayload) = "agent.run.stopped" => versioned,
    /// Emitted when a run ends on an unrecovered error, with its category and cause.
    AgentRunFailed(#[garde(dive)] AgentRunFailedPayload) = "agent.run.failed" => versioned,
    /// Emitted when an undo cuts the conversation back to an earlier turn; it moves no state and
    /// advances the run version.
    AgentRunRolledBack(AgentRunRolledBackEvent) = "agent.run.rolledBack" => versioned,
    /// Emitted when an intervention on a run is requested.
    AgentInterventionRequested(AgentInterventionRequestedPayload) = "agent.intervention.requested",
    /// Emitted when an intervention is accepted for application.
    AgentInterventionAccepted(AgentInterventionAcceptedPayload) = "agent.intervention.accepted",
    /// Emitted when an intervention is applied to its run.
    AgentInterventionApplied(AgentInterventionAppliedPayload) = "agent.intervention.applied",
    /// Emitted when an intervention is rejected.
    AgentInterventionRejected(AgentInterventionRejectedPayload) = "agent.intervention.rejected",
    /// Emitted when an intervention is applied with a degraded effect.
    AgentInterventionDegraded(AgentInterventionDegradedPayload) = "agent.intervention.degraded",
    /// Emitted when an intervention expires without being applied.
    AgentInterventionExpired(AgentInterventionExpiredPayload) = "agent.intervention.expired",
    /// Emitted when an intervention's dispatch throws, so it ends without a driver verdict.
    AgentInterventionFailed(AgentInterventionFailedPayload) = "agent.intervention.failed",
}

/// The run of an agent row: a run's row names it, a voice call's answer names none.
fn agent_output_run(payload: &AgentOutputPayload) -> Option<EventRun> {
    match payload {
        AgentOutputPayload::Run(output) => Some(EventRun {
            run_id: output.run_id,
            run_version: None,
            turn_number: None,
        }),
        AgentOutputPayload::Voice(_) => None,
    }
}

/// The run that holds a question; a workflow wait's question names none.
fn question_asked_run(payload: &QuestionAskedPayload) -> Option<EventRun> {
    match payload {
        QuestionAskedPayload::Run(question) => Some(EventRun {
            run_id: question.run_id,
            run_version: None,
            turn_number: None,
        }),
        QuestionAskedPayload::Wait(_) => None,
    }
}

/// The run behind a commit or an opened pull request, where it names one.
fn git_settled_run(payload: &GitSettledPayload) -> Option<EventRun> {
    match payload {
        GitSettledPayload::Committed { run_id, .. }
        | GitSettledPayload::PullRequestOpened { run_id, .. } => run_id.map(|run_id| EventRun {
            run_id,
            run_version: None,
            turn_number: None,
        }),
        GitSettledPayload::Pushed { .. }
        | GitSettledPayload::Pulled { .. }
        | GitSettledPayload::ReviewPosted { .. } => None,
    }
}

/// The run queued, at the version it was queued at.
#[expect(
    clippy::unnecessary_wraps,
    reason = "every run rule that reads its payload answers an Option"
)]
fn run_queued_run(payload: &AgentRunQueuedPayload) -> Option<EventRun> {
    let (run_id, run_version) = match payload {
        AgentRunQueuedPayload::SessionAgent(queued) => (queued.run_id, queued.run_version),
        AgentRunQueuedPayload::ResolvedAgent(queued) => (queued.run_id, queued.run_version),
    };
    Some(EventRun {
        run_id,
        run_version: Some(run_version),
        turn_number: None,
    })
}

/// The run a notice is about: only the run that asked for fast output it lacks.
fn session_notice_run(payload: &SessionNoticePostedPayload) -> Option<EventRun> {
    let SessionNoticePostedPayload::Notice(SessionNotice::FastOutputUnavailable { run_id, .. }) =
        payload
    else {
        return None;
    };
    Some(EventRun {
        run_id: *run_id,
        run_version: None,
        turn_number: None,
    })
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
    /// unregistered type, a mismatched category, or a payload its type's schema refuses.
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
        let event = Self::read_payload(event_type, &envelope.payload)?;
        garde::Validate::validate(&event)?;
        Ok(event)
    }
}

/// The TypeScript module of the strict session event.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "event/session",
    doc: "The strict session event: an envelope's `type` and `payload`, the payload parsed by the \
          schema its type registers. The envelope is read tolerant and the event strict.",
    definitions: &[Definition::read::<SessionEvent>().checked()],
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
            "session.handedOver",
            "sessionLifecycle",
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
            Err(SessionEventReadError::UnknownType(name)) if name == "session.handedOver"
        ));

        // The same path for a registered type reads to the event its native form reads to.
        let payload = json!({
            "sessionId": "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "at": "2026-10-13T15:00:00.000Z",
        });
        let known_text = envelope_text("session.pinned", "sessionLifecycle", &payload);
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
