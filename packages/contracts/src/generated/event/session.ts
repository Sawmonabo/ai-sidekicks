// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The strict session event: an envelope's `type` and `payload`, the payload parsed by the schema its type registers. The envelope is read tolerant and the event strict.

import type {
  AgentProviderBindingChangeFailedPayload,
  AgentProviderBindingChangedPayload,
} from "../agent/provider-binding.js";
import type {
  ApprovalCanceledPayload,
  ApprovalDenialOverriddenPayload,
  ApprovalRequestedPayload,
  ApprovalResolvedPayload,
  ApprovalReviewerDeniedPayload,
  ApprovalRuleRememberedPayload,
  ApprovalRuleRevokedPayload,
} from "../approval.js";
import type { ArtifactPublicationPayload } from "../artifacts/publication.js";
import type { CloudTaskUpdatedPayload } from "../cloud.js";
import type { AgentCommandEndedPayload } from "../command.js";
import type {
  DaemonBackupCompletedPayload,
  DaemonBackupFailedPayload,
  DaemonBackupRestoredPayload,
} from "../daemon/backup.js";
import type {
  DaemonRecoveryAttemptedPayload,
  DaemonRecoveryFailedPayload,
  DaemonRecoverySucceededPayload,
} from "../daemon/recovery.js";
import type { GitSettledPayload } from "../git/local.js";
import type { McpServerSignInCompletedPayload } from "../mcp/governance.js";
import type { AgentRunRejectedPayload } from "../orchestration.js";
import type {
  PlanAcceptedPayload,
  PlanHandOffFailedPayload,
  PlanHandedOffPayload,
  PlanHoldEndedPayload,
  PlanKeptPayload,
  PlanProposedPayload,
} from "../plan.js";
import type {
  QuestionAskedPayload,
  QuestionCanceledPayload,
  QuestionOpenedPayload,
} from "../question.js";
import type { RelayPinRefusedPayload } from "../relay.js";
import type { RepoMountHealthChangedPayload, WorkspaceLifecyclePayload } from "../repo/mount.js";
import type {
  AgentRunRecoveryResolvedPayload,
  AgentRunRecoveryStepsAddedPayload,
  AgentRunRolledBackEvent,
} from "../run/control.js";
import type {
  AgentChildrenStoppedPayload,
  AgentInterventionAcceptedPayload,
  AgentInterventionAppliedPayload,
  AgentInterventionDegradedPayload,
  AgentInterventionExpiredPayload,
  AgentInterventionFailedPayload,
  AgentInterventionRejectedPayload,
  AgentInterventionRequestedPayload,
  AgentRunCompletedPayload,
  AgentRunFailedPayload,
  AgentRunInterruptedPayload,
  AgentRunParentCorrectedPayload,
  AgentRunPausedPayload,
  AgentRunPausingPayload,
  AgentRunProviderInitializedPayload,
  AgentRunRunningPayload,
  AgentRunStartingPayload,
  AgentRunStoppedPayload,
  AgentRunWaitingForApprovalPayload,
  AgentRunWaitingForInputPayload,
  AgentRunWorkerShuttingDownPayload,
  AgentTurnCompletedPayload,
  AgentTurnFailedPayload,
  AgentTurnInterruptedPayload,
  AgentTurnStartedPayload,
  AgentTurnSteeredPayload,
} from "../run/events.js";
import type {
  AgentRunRefusalChoiceRequestedPayload,
  AgentRunRefusalChoiceResolvedPayload,
  AgentRunUsageCreditsChoiceRequestedPayload,
  AgentRunUsageCreditsChoiceResolvedPayload,
} from "../run/provider-choice.js";
import type {
  AgentQueueItemAdmittedPayload,
  AgentQueueItemCanceledPayload,
  AgentQueueItemCreatedPayload,
  AgentQueueItemNotDeliveredPayload,
  AgentQueueItemSupersededPayload,
  UserMessageSentPayload,
} from "../run/queue.js";
import type { AgentRunQueuedPayload } from "../run/queued.js";
import type { SubagentLifecyclePayload } from "../run/subagent.js";
import type {
  AgentRunStepLimitReachedPayload,
  AgentRunTokenLimitReachedPayload,
  ApprovalReviewerFlaggedPayload,
  SessionNoticePostedPayload,
  SessionSideQuestionAnsweredPayload,
  SessionSpendLimitReachedPayload,
} from "../session/controls/events.js";
import type { SessionConvertedPayload } from "../session/convert.js";
import type {
  SessionAdvisorChangedPayload,
  SessionCreatedPayload,
  SessionLifecycleChangePayload,
  SessionMarkChangePayload,
  SessionOutputStyleChangedPayload,
  SessionProviderStatusReportedPayload,
  SessionReactivatedPayload,
  SessionRenamedPayload,
} from "../session/events.js";
import type { SessionGoalClearedPayload, SessionGoalUpdatedPayload } from "../session/goal.js";
import type { SessionDamagedEventsSkippedPayload } from "../session/recovery.js";
import type { SessionRestoreCompletedPayload } from "../session/restore.js";
import type { TerminalControlChangedPayload } from "../terminal.js";
import type {
  WorkflowTriggerArmedPayload,
  WorkflowTriggerFiredPayload,
  WorkflowVersionCreatedPayload,
} from "../workflow/definition/events.js";
import type {
  WorkflowGateReachedPayload,
  WorkflowResultsPostedPayload,
  WorkflowRunCanceledPayload,
  WorkflowRunCompletedPayload,
  WorkflowRunDeletedPayload,
  WorkflowRunFailedPayload,
  WorkflowRunResumedPayload,
  WorkflowRunStartedPayload,
  WorkflowRunWaitingPayload,
} from "../workflow/run/events.js";
import type {
  WorkflowGateResolvedPayload,
  WorkflowParallelJoinBranchesCanceledPayload,
  WorkflowPhaseAdmittedPayload,
  WorkflowPhaseCancelingPayload,
  WorkflowPhaseCompletedPayload,
  WorkflowPhaseFailedPayload,
  WorkflowPhaseProgressedPayload,
  WorkflowPhaseResumedPayload,
  WorkflowPhaseRetriedPayload,
  WorkflowPhaseStartedPayload,
  WorkflowPhaseSuspendedPayload,
  WorkflowPhaseWaitingOnPoolPayload,
  WorkflowStepCanceledPayload,
  WorkflowStepCompletedPayload,
  WorkflowStepFailedPayload,
  WorkflowStepSkippedPayload,
  WorkflowStepStartedPayload,
} from "../workflow/run/step/events.js";
import type {
  SessionBranchChangedPayload,
  SessionSweptToCheckoutPayload,
  WorktreeCreatedPayload,
  WorktreeRetiredPayload,
} from "../worktree/events.js";
import type { WorktreeLifecyclePayload } from "../worktree/lifecycle.js";
import type {
  AgentOutputPayload,
  SessionEventCompactedPayload,
  ToolActivityPayload,
  ToolCallBackgroundedPayload,
  ToolCallFailedPayload,
} from "./declared-variants.js";
import type {
  AgentRunContextCompactedPayload,
  AgentTurnReroutedPayload,
  UsageApiRequestRetriedPayload,
  UsageContextWindowUpdatedPayload,
  UsageCostUpdatedPayload,
  UsageRateLimitUpdatedPayload,
  UsageTokenCountRecordedPayload,
} from "./usage.js";

/** The event types `SessionEvent` registers, each with its payload variant. */
export const SESSION_EVENT_TYPES = [
  "session.created",
  "workspace.preparing",
  "workspace.prepared",
  "workspace.rootLost",
  "workspace.archived",
  "worktree.created",
  "worktree.bound",
  "worktree.dirtied",
  "worktree.cleaned",
  "worktree.merged",
  "worktree.reopened",
  "worktree.retired",
  "session.event.compacted",
  "agent.message.sent",
  "agent.thinking.updated",
  "agent.toolCall.invoked",
  "agent.toolCall.backgrounded",
  "agent.toolCall.completed",
  "agent.toolCall.failed",
  "agent.subagent.started",
  "agent.subagent.completed",
  "agent.subagent.stopped",
  "agent.run.providerInitialized",
  "agent.turn.started",
  "agent.turn.steered",
  "agent.turn.completed",
  "agent.turn.interrupted",
  "agent.children.stopped",
  "agent.turn.failed",
  "agent.run.workerShuttingDown",
  "session.providerStatus.reported",
  "approval.rejected",
  "approval.canceled",
  "approval.rule.remembered",
  "approval.rule.revoked",
  "approval.reviewer.flagged",
  "plan.proposed",
  "plan.accepted",
  "plan.handedOff",
  "plan.kept",
  "plan.hold.ended",
  "plan.handOff.failed",
  "question.asked",
  "question.opened",
  "question.canceled",
  "user.message.sent",
  "agent.queueItem.created",
  "agent.queueItem.admitted",
  "agent.queueItem.superseded",
  "agent.queueItem.canceled",
  "agent.queueItem.notDelivered",
  "mcp.server.signIn.completed",
  "cloud.task.updated",
  "session.restore.completed",
  "session.goal.cleared",
  "session.notice.posted",
  "session.sideQuestion.answered",
  "session.spendLimit.reached",
  "git.settled",
  "relay.pin.refused",
  "agent.command.ended",
  "usage.tokenCount.recorded",
  "usage.cost.updated",
  "usage.contextWindow.updated",
  "usage.rateLimit.updated",
  "usage.apiRequest.retried",
  "agent.run.context.compacted",
  "agent.turn.rerouted",
  "session.activated",
  "session.archived",
  "session.reactivated",
  "session.closed",
  "session.pinned",
  "session.unpinned",
  "session.muted",
  "session.unmuted",
  "session.converted",
  "session.branch.changed",
  "session.sweptToCheckout",
  "agent.providerBinding.changed",
  "agent.providerBinding.changeFailed",
  "approval.requested",
  "approval.approved",
  "approval.reviewer.denied",
  "approval.denial.overridden",
  "agent.run.queued",
  "agent.run.parentCorrected",
  "agent.run.stepLimit.reached",
  "agent.run.tokenLimit.reached",
  "agent.run.recovery.resolved",
  "agent.run.recoverySteps.added",
  "session.advisor.changed",
  "session.outputStyle.changed",
  "repoMount.health.changed",
  "agent.run.rejected",
  "artifact.published",
  "agent.run.refusalChoice.requested",
  "agent.run.refusalChoice.resolved",
  "agent.run.usageCreditsChoice.requested",
  "agent.run.usageCreditsChoice.resolved",
  "session.goal.updated",
  "session.renamed",
  "terminal.control.changed",
  "workflow.run.started",
  "workflow.run.resumed",
  "workflow.run.canceled",
  "workflow.run.deleted",
  "workflow.results.posted",
  "workflow.phase.suspended",
  "workflow.phase.failed",
  "workflow.phase.waitingOnPool",
  "workflow.step.started",
  "workflow.step.completed",
  "workflow.step.failed",
  "workflow.step.canceled",
  "workflow.step.skipped",
  "workflow.gate.resolved",
  "workflow.version.created",
  "workflow.gate.reached",
  "workflow.run.failed",
  "workflow.run.completed",
  "workflow.run.waiting",
  "workflow.schedule.armed",
  "workflow.schedule.fired",
  "workflow.trigger.armed",
  "workflow.trigger.fired",
  "workflow.phase.admitted",
  "workflow.phase.started",
  "workflow.phase.progressed",
  "workflow.phase.canceling",
  "workflow.phase.retried",
  "workflow.phase.resumed",
  "workflow.phase.completed",
  "workflow.parallelJoin.branchesCanceled",
  "daemon.backup.completed",
  "daemon.backup.failed",
  "daemon.backup.restored",
  "daemon.recovery.attempted",
  "daemon.recovery.succeeded",
  "daemon.recovery.failed",
  "session.damagedEvents.skipped",
  "agent.run.starting",
  "agent.run.running",
  "agent.run.waitingForApproval",
  "agent.run.waitingForInput",
  "agent.run.pausing",
  "agent.run.paused",
  "agent.run.completed",
  "agent.run.interrupted",
  "agent.run.stopped",
  "agent.run.failed",
  "agent.run.rolledBack",
  "agent.intervention.requested",
  "agent.intervention.accepted",
  "agent.intervention.applied",
  "agent.intervention.rejected",
  "agent.intervention.degraded",
  "agent.intervention.expired",
  "agent.intervention.failed",
] as const;

/**
 * Every session event with a registered payload variant: its `type` and its payload,
 * discriminated on `type`. Its category is its type's own, checked when it is read from
 * an envelope.
 */
export type SessionEvent =
  | {
      type: "session.created";
      payload: SessionCreatedPayload;
    }
  | {
      type: "workspace.preparing";
      payload: WorkspaceLifecyclePayload;
    }
  | {
      type: "workspace.prepared";
      payload: WorkspaceLifecyclePayload;
    }
  | {
      type: "workspace.rootLost";
      payload: WorkspaceLifecyclePayload;
    }
  | {
      type: "workspace.archived";
      payload: WorkspaceLifecyclePayload;
    }
  | {
      type: "worktree.created";
      payload: WorktreeCreatedPayload;
    }
  | {
      type: "worktree.bound";
      payload: WorktreeLifecyclePayload;
    }
  | {
      type: "worktree.dirtied";
      payload: WorktreeLifecyclePayload;
    }
  | {
      type: "worktree.cleaned";
      payload: WorktreeLifecyclePayload;
    }
  | {
      type: "worktree.merged";
      payload: WorktreeLifecyclePayload;
    }
  | {
      type: "worktree.reopened";
      payload: WorktreeLifecyclePayload;
    }
  | {
      type: "worktree.retired";
      payload: WorktreeRetiredPayload;
    }
  | {
      type: "session.event.compacted";
      payload: SessionEventCompactedPayload;
    }
  | {
      type: "agent.message.sent";
      payload: AgentOutputPayload;
    }
  | {
      type: "agent.thinking.updated";
      payload: AgentOutputPayload;
    }
  | {
      type: "agent.toolCall.invoked";
      payload: ToolActivityPayload;
    }
  | {
      type: "agent.toolCall.backgrounded";
      payload: ToolCallBackgroundedPayload;
    }
  | {
      type: "agent.toolCall.completed";
      payload: ToolActivityPayload;
    }
  | {
      type: "agent.toolCall.failed";
      payload: ToolCallFailedPayload;
    }
  | {
      type: "agent.subagent.started";
      payload: SubagentLifecyclePayload;
    }
  | {
      type: "agent.subagent.completed";
      payload: SubagentLifecyclePayload;
    }
  | {
      type: "agent.subagent.stopped";
      payload: SubagentLifecyclePayload;
    }
  | {
      type: "agent.run.providerInitialized";
      payload: AgentRunProviderInitializedPayload;
    }
  | {
      type: "agent.turn.started";
      payload: AgentTurnStartedPayload;
    }
  | {
      type: "agent.turn.steered";
      payload: AgentTurnSteeredPayload;
    }
  | {
      type: "agent.turn.completed";
      payload: AgentTurnCompletedPayload;
    }
  | {
      type: "agent.turn.interrupted";
      payload: AgentTurnInterruptedPayload;
    }
  | {
      type: "agent.children.stopped";
      payload: AgentChildrenStoppedPayload;
    }
  | {
      type: "agent.turn.failed";
      payload: AgentTurnFailedPayload;
    }
  | {
      type: "agent.run.workerShuttingDown";
      payload: AgentRunWorkerShuttingDownPayload;
    }
  | {
      type: "session.providerStatus.reported";
      payload: SessionProviderStatusReportedPayload;
    }
  | {
      type: "approval.rejected";
      payload: ApprovalResolvedPayload;
    }
  | {
      type: "approval.canceled";
      payload: ApprovalCanceledPayload;
    }
  | {
      type: "approval.rule.remembered";
      payload: ApprovalRuleRememberedPayload;
    }
  | {
      type: "approval.rule.revoked";
      payload: ApprovalRuleRevokedPayload;
    }
  | {
      type: "approval.reviewer.flagged";
      payload: ApprovalReviewerFlaggedPayload;
    }
  | {
      type: "plan.proposed";
      payload: PlanProposedPayload;
    }
  | {
      type: "plan.accepted";
      payload: PlanAcceptedPayload;
    }
  | {
      type: "plan.handedOff";
      payload: PlanHandedOffPayload;
    }
  | {
      type: "plan.kept";
      payload: PlanKeptPayload;
    }
  | {
      type: "plan.hold.ended";
      payload: PlanHoldEndedPayload;
    }
  | {
      type: "plan.handOff.failed";
      payload: PlanHandOffFailedPayload;
    }
  | {
      type: "question.asked";
      payload: QuestionAskedPayload;
    }
  | {
      type: "question.opened";
      payload: QuestionOpenedPayload;
    }
  | {
      type: "question.canceled";
      payload: QuestionCanceledPayload;
    }
  | {
      type: "user.message.sent";
      payload: UserMessageSentPayload;
    }
  | {
      type: "agent.queueItem.created";
      payload: AgentQueueItemCreatedPayload;
    }
  | {
      type: "agent.queueItem.admitted";
      payload: AgentQueueItemAdmittedPayload;
    }
  | {
      type: "agent.queueItem.superseded";
      payload: AgentQueueItemSupersededPayload;
    }
  | {
      type: "agent.queueItem.canceled";
      payload: AgentQueueItemCanceledPayload;
    }
  | {
      type: "agent.queueItem.notDelivered";
      payload: AgentQueueItemNotDeliveredPayload;
    }
  | {
      type: "mcp.server.signIn.completed";
      payload: McpServerSignInCompletedPayload;
    }
  | {
      type: "cloud.task.updated";
      payload: CloudTaskUpdatedPayload;
    }
  | {
      type: "session.restore.completed";
      payload: SessionRestoreCompletedPayload;
    }
  | {
      type: "session.goal.cleared";
      payload: SessionGoalClearedPayload;
    }
  | {
      type: "session.notice.posted";
      payload: SessionNoticePostedPayload;
    }
  | {
      type: "session.sideQuestion.answered";
      payload: SessionSideQuestionAnsweredPayload;
    }
  | {
      type: "session.spendLimit.reached";
      payload: SessionSpendLimitReachedPayload;
    }
  | {
      type: "git.settled";
      payload: GitSettledPayload;
    }
  | {
      type: "relay.pin.refused";
      payload: RelayPinRefusedPayload;
    }
  | {
      type: "agent.command.ended";
      payload: AgentCommandEndedPayload;
    }
  | {
      type: "usage.tokenCount.recorded";
      payload: UsageTokenCountRecordedPayload;
    }
  | {
      type: "usage.cost.updated";
      payload: UsageCostUpdatedPayload;
    }
  | {
      type: "usage.contextWindow.updated";
      payload: UsageContextWindowUpdatedPayload;
    }
  | {
      type: "usage.rateLimit.updated";
      payload: UsageRateLimitUpdatedPayload;
    }
  | {
      type: "usage.apiRequest.retried";
      payload: UsageApiRequestRetriedPayload;
    }
  | {
      type: "agent.run.context.compacted";
      payload: AgentRunContextCompactedPayload;
    }
  | {
      type: "agent.turn.rerouted";
      payload: AgentTurnReroutedPayload;
    }
  | {
      type: "session.activated";
      payload: SessionLifecycleChangePayload;
    }
  | {
      type: "session.archived";
      payload: SessionLifecycleChangePayload;
    }
  | {
      type: "session.reactivated";
      payload: SessionReactivatedPayload;
    }
  | {
      type: "session.closed";
      payload: SessionLifecycleChangePayload;
    }
  | {
      type: "session.pinned";
      payload: SessionMarkChangePayload;
    }
  | {
      type: "session.unpinned";
      payload: SessionMarkChangePayload;
    }
  | {
      type: "session.muted";
      payload: SessionMarkChangePayload;
    }
  | {
      type: "session.unmuted";
      payload: SessionMarkChangePayload;
    }
  | {
      type: "session.converted";
      payload: SessionConvertedPayload;
    }
  | {
      type: "session.branch.changed";
      payload: SessionBranchChangedPayload;
    }
  | {
      type: "session.sweptToCheckout";
      payload: SessionSweptToCheckoutPayload;
    }
  | {
      type: "agent.providerBinding.changed";
      payload: AgentProviderBindingChangedPayload;
    }
  | {
      type: "agent.providerBinding.changeFailed";
      payload: AgentProviderBindingChangeFailedPayload;
    }
  | {
      type: "approval.requested";
      payload: ApprovalRequestedPayload;
    }
  | {
      type: "approval.approved";
      payload: ApprovalResolvedPayload;
    }
  | {
      type: "approval.reviewer.denied";
      payload: ApprovalReviewerDeniedPayload;
    }
  | {
      type: "approval.denial.overridden";
      payload: ApprovalDenialOverriddenPayload;
    }
  | {
      type: "agent.run.queued";
      payload: AgentRunQueuedPayload;
    }
  | {
      type: "agent.run.parentCorrected";
      payload: AgentRunParentCorrectedPayload;
    }
  | {
      type: "agent.run.stepLimit.reached";
      payload: AgentRunStepLimitReachedPayload;
    }
  | {
      type: "agent.run.tokenLimit.reached";
      payload: AgentRunTokenLimitReachedPayload;
    }
  | {
      type: "agent.run.recovery.resolved";
      payload: AgentRunRecoveryResolvedPayload;
    }
  | {
      type: "agent.run.recoverySteps.added";
      payload: AgentRunRecoveryStepsAddedPayload;
    }
  | {
      type: "session.advisor.changed";
      payload: SessionAdvisorChangedPayload;
    }
  | {
      type: "session.outputStyle.changed";
      payload: SessionOutputStyleChangedPayload;
    }
  | {
      type: "repoMount.health.changed";
      payload: RepoMountHealthChangedPayload;
    }
  | {
      type: "agent.run.rejected";
      payload: AgentRunRejectedPayload;
    }
  | {
      type: "artifact.published";
      payload: ArtifactPublicationPayload;
    }
  | {
      type: "agent.run.refusalChoice.requested";
      payload: AgentRunRefusalChoiceRequestedPayload;
    }
  | {
      type: "agent.run.refusalChoice.resolved";
      payload: AgentRunRefusalChoiceResolvedPayload;
    }
  | {
      type: "agent.run.usageCreditsChoice.requested";
      payload: AgentRunUsageCreditsChoiceRequestedPayload;
    }
  | {
      type: "agent.run.usageCreditsChoice.resolved";
      payload: AgentRunUsageCreditsChoiceResolvedPayload;
    }
  | {
      type: "session.goal.updated";
      payload: SessionGoalUpdatedPayload;
    }
  | {
      type: "session.renamed";
      payload: SessionRenamedPayload;
    }
  | {
      type: "terminal.control.changed";
      payload: TerminalControlChangedPayload;
    }
  | {
      type: "workflow.run.started";
      payload: WorkflowRunStartedPayload;
    }
  | {
      type: "workflow.run.resumed";
      payload: WorkflowRunResumedPayload;
    }
  | {
      type: "workflow.run.canceled";
      payload: WorkflowRunCanceledPayload;
    }
  | {
      type: "workflow.run.deleted";
      payload: WorkflowRunDeletedPayload;
    }
  | {
      type: "workflow.results.posted";
      payload: WorkflowResultsPostedPayload;
    }
  | {
      type: "workflow.phase.suspended";
      payload: WorkflowPhaseSuspendedPayload;
    }
  | {
      type: "workflow.phase.failed";
      payload: WorkflowPhaseFailedPayload;
    }
  | {
      type: "workflow.phase.waitingOnPool";
      payload: WorkflowPhaseWaitingOnPoolPayload;
    }
  | {
      type: "workflow.step.started";
      payload: WorkflowStepStartedPayload;
    }
  | {
      type: "workflow.step.completed";
      payload: WorkflowStepCompletedPayload;
    }
  | {
      type: "workflow.step.failed";
      payload: WorkflowStepFailedPayload;
    }
  | {
      type: "workflow.step.canceled";
      payload: WorkflowStepCanceledPayload;
    }
  | {
      type: "workflow.step.skipped";
      payload: WorkflowStepSkippedPayload;
    }
  | {
      type: "workflow.gate.resolved";
      payload: WorkflowGateResolvedPayload;
    }
  | {
      type: "workflow.version.created";
      payload: WorkflowVersionCreatedPayload;
    }
  | {
      type: "workflow.gate.reached";
      payload: WorkflowGateReachedPayload;
    }
  | {
      type: "workflow.run.failed";
      payload: WorkflowRunFailedPayload;
    }
  | {
      type: "workflow.run.completed";
      payload: WorkflowRunCompletedPayload;
    }
  | {
      type: "workflow.run.waiting";
      payload: WorkflowRunWaitingPayload;
    }
  | {
      type: "workflow.schedule.armed";
      payload: WorkflowTriggerArmedPayload;
    }
  | {
      type: "workflow.schedule.fired";
      payload: WorkflowTriggerFiredPayload;
    }
  | {
      type: "workflow.trigger.armed";
      payload: WorkflowTriggerArmedPayload;
    }
  | {
      type: "workflow.trigger.fired";
      payload: WorkflowTriggerFiredPayload;
    }
  | {
      type: "workflow.phase.admitted";
      payload: WorkflowPhaseAdmittedPayload;
    }
  | {
      type: "workflow.phase.started";
      payload: WorkflowPhaseStartedPayload;
    }
  | {
      type: "workflow.phase.progressed";
      payload: WorkflowPhaseProgressedPayload;
    }
  | {
      type: "workflow.phase.canceling";
      payload: WorkflowPhaseCancelingPayload;
    }
  | {
      type: "workflow.phase.retried";
      payload: WorkflowPhaseRetriedPayload;
    }
  | {
      type: "workflow.phase.resumed";
      payload: WorkflowPhaseResumedPayload;
    }
  | {
      type: "workflow.phase.completed";
      payload: WorkflowPhaseCompletedPayload;
    }
  | {
      type: "workflow.parallelJoin.branchesCanceled";
      payload: WorkflowParallelJoinBranchesCanceledPayload;
    }
  | {
      type: "daemon.backup.completed";
      payload: DaemonBackupCompletedPayload;
    }
  | {
      type: "daemon.backup.failed";
      payload: DaemonBackupFailedPayload;
    }
  | {
      type: "daemon.backup.restored";
      payload: DaemonBackupRestoredPayload;
    }
  | {
      type: "daemon.recovery.attempted";
      payload: DaemonRecoveryAttemptedPayload;
    }
  | {
      type: "daemon.recovery.succeeded";
      payload: DaemonRecoverySucceededPayload;
    }
  | {
      type: "daemon.recovery.failed";
      payload: DaemonRecoveryFailedPayload;
    }
  | {
      type: "session.damagedEvents.skipped";
      payload: SessionDamagedEventsSkippedPayload;
    }
  | {
      type: "agent.run.starting";
      payload: AgentRunStartingPayload;
    }
  | {
      type: "agent.run.running";
      payload: AgentRunRunningPayload;
    }
  | {
      type: "agent.run.waitingForApproval";
      payload: AgentRunWaitingForApprovalPayload;
    }
  | {
      type: "agent.run.waitingForInput";
      payload: AgentRunWaitingForInputPayload;
    }
  | {
      type: "agent.run.pausing";
      payload: AgentRunPausingPayload;
    }
  | {
      type: "agent.run.paused";
      payload: AgentRunPausedPayload;
    }
  | {
      type: "agent.run.completed";
      payload: AgentRunCompletedPayload;
    }
  | {
      type: "agent.run.interrupted";
      payload: AgentRunInterruptedPayload;
    }
  | {
      type: "agent.run.stopped";
      payload: AgentRunStoppedPayload;
    }
  | {
      type: "agent.run.failed";
      payload: AgentRunFailedPayload;
    }
  | {
      type: "agent.run.rolledBack";
      payload: AgentRunRolledBackEvent;
    }
  | {
      type: "agent.intervention.requested";
      payload: AgentInterventionRequestedPayload;
    }
  | {
      type: "agent.intervention.accepted";
      payload: AgentInterventionAcceptedPayload;
    }
  | {
      type: "agent.intervention.applied";
      payload: AgentInterventionAppliedPayload;
    }
  | {
      type: "agent.intervention.rejected";
      payload: AgentInterventionRejectedPayload;
    }
  | {
      type: "agent.intervention.degraded";
      payload: AgentInterventionDegradedPayload;
    }
  | {
      type: "agent.intervention.expired";
      payload: AgentInterventionExpiredPayload;
    }
  | {
      type: "agent.intervention.failed";
      payload: AgentInterventionFailedPayload;
    };

export { validateSessionEvent } from "../checks/event/session.js";
