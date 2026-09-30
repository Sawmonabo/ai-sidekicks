// The closed roster of session event types, grouped by category. The category record itself is
// in `event.ts`.

import type { SessionEvent } from "./event-variant-types.js";

// Every wire `type` string. Each type belongs to exactly one category and
// `SESSION_EVENT_CATEGORY_BY_TYPE` (in `event.ts`) covers every type: its `satisfies
// Record<SessionEventType, EventCategory>` check makes a missing, unknown or duplicate key a
// compile error. Type strings are immutable wire identifiers (MINOR bumps only add), so a
// registered literal is never renamed. Blocks follow `EventCategory` order, which is not
// load-bearing.
//
// A type's category is its registry entry, not its prefix: `session.clock_unsynced` and
// `session.clock_corrected` are `runtime_node_lifecycle` (they keep the `session.` prefix because
// a rename would break the wire), `daemon.*` and `relay.pin_refused` are `security_events`,
// `moderation.review_flagged` and `plan.*` are `approval_flow`, and `orchestration.rejected` is
// `orchestration_admission`.
/**
 * Every wire event type string the taxonomy registers, whether or not a payload variant exists
 * for it yet.
 */
export type SessionEventType =
  // run_lifecycle
  | "run.queued"
  | "run.starting"
  | "run.running"
  | "run.waiting_for_approval"
  | "run.waiting_for_input"
  | "run.pausing"
  | "run.paused"
  | "run.completed"
  | "run.interrupted"
  | "run.failed"
  | "run.rolled_back"
  | "run.provider_initialized"
  | "run.turn_started"
  | "run.worker_shutdown"
  | "run.step_limit_reached"
  | "run.recovery_resolved"
  | "run.refusal_choice_requested"
  | "run.refusal_choice_resolved"
  | "run.usage_credits_choice_requested"
  | "run.usage_credits_choice_resolved"
  // assistant_output
  | "assistant.message"
  | "assistant.thinking_update"
  // tool_activity
  | "tool.invoked"
  | "tool.result"
  | "tool.error"
  | "tool.replayed"
  | "tool.skipped_during_recovery"
  | "subagent.started"
  | "subagent.completed"
  | "command.ended"
  // interactive_request
  | "queue_item.created"
  | "queue_item.admitted"
  | "queue_item.superseded"
  | "queue_item.canceled"
  | "queue_item.not_delivered"
  | "intervention.requested"
  | "intervention.accepted"
  | "intervention.applied"
  | "intervention.rejected"
  | "intervention.degraded"
  | "intervention.expired"
  | "user.message"
  | "question.asked"
  // artifact_publication
  | "artifact.published"
  | "artifact.visibility_updated"
  | "artifact.superseded"
  | "diff.created"
  | "git.settled"
  // session_lifecycle
  | "session.created"
  | "session.activated"
  | "session.archived"
  | "session.reactivated"
  | "session.closed"
  | "session.purge_requested"
  | "session.purged"
  | "session.goal_updated"
  | "session.goal_cleared"
  | "session.provider_status"
  | "session.notice"
  | "session.renamed"
  | "session.pinned"
  | "session.unpinned"
  | "session.muted"
  | "session.unmuted"
  | "session.converted"
  | "session.side_question_answered"
  | "session.restore_finished"
  | "agent.provider_binding_changed"
  | "agent.provider_binding_change_failed"
  | "repo.attached"
  | "repo.detached"
  | "workspace.preparing"
  | "workspace.ready"
  | "workspace.stale"
  | "workspace.archived"
  | "worktree.created"
  | "worktree.ready"
  | "worktree.dirty"
  | "worktree.merged"
  | "worktree.retired"
  | "session.branch_changed"
  | "session.swept_to_repo_root"
  | "pty.control_changed"
  | "cloud.task_updated"
  // approval_flow
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.canceled"
  | "approval.remembered"
  | "approval.rule_revoked"
  | "approval.reviewer_denied"
  | "approval.denial_overridden"
  | "moderation.review_flagged"
  | "plan.proposed"
  | "plan.accepted"
  | "plan.handed_off"
  // usage_telemetry
  | "usage.token_count"
  | "usage.cost_update"
  | "usage.context_window_update"
  | "usage.budget_warning"
  | "usage.rate_limit_update"
  | "usage.api_retry"
  | "usage.context_compacted"
  | "usage.model_rerouted"
  // runtime_node_lifecycle
  | "session.clock_unsynced"
  | "session.clock_corrected"
  // recovery_events
  | "recovery.attempted"
  | "recovery.succeeded"
  | "recovery.failed"
  // security_events
  | "security.default.override"
  | "security.update.available"
  | "daemon.master_key_source"
  | "daemon.pii_split_ambiguous"
  | "relay.pin_refused"
  // event_maintenance
  | "event.compacted"
  | "backup.completed"
  | "backup.failed"
  | "backup.restored"
  // policy_events
  | "policy_bundle.loaded"
  | "policy_bundle.rejected"
  // orchestration_admission
  | "orchestration.rejected"
  // mcp_governance
  | "mcp.server_status_changed"
  | "mcp.server_config_changed"
  | "mcp.server_trust_changed"
  | "mcp.tool_override_changed"
  | "mcp.server_oauth_completed"
  // workflow_lifecycle
  | "workflow.created"
  | "workflow.started"
  | "workflow.gated"
  | "workflow.failed"
  | "workflow.completed"
  | "workflow.resumed"
  | "workflow.canceled"
  | "workflow.run_waiting"
  | "workflow.schedule_armed"
  | "workflow.schedule_fired"
  | "workflow.trigger_armed"
  | "workflow.trigger_fired"
  | "workflow.results_posted"
  // workflow_phase_lifecycle
  | "workflow.phase_admitted"
  | "workflow.phase_waiting_on_pool"
  | "workflow.phase_started"
  | "workflow.phase_progressed"
  | "workflow.phase_canceling"
  | "workflow.phase_failed"
  | "workflow.phase_retried"
  | "workflow.phase_suspended"
  | "workflow.phase_resumed"
  | "workflow.phase_completed"
  | "workflow.human_phase_claimed"
  | "workflow.human_phase_escalated"
  | "workflow.step_started"
  | "workflow.step_finished"
  | "workflow.step_failed"
  | "workflow.step_canceled"
  | "workflow.step_skipped"
  // workflow_parallel_coordination
  | "workflow.parallel_join_cancellation"
  // workflow_gate_resolution
  | "workflow.gate_resolved";

/**
 * The event types with a payload variant registered in `SessionEventSchema`: a subset of the
 * census (`SESSION_EVENT_CATEGORY_BY_TYPE`). The `SessionEvent["type"]` annotation refuses a
 * literal that has no variant, but not a missing one: the list is hand-written, so registering a
 * union arm means adding its type here in the same change. Order follows the union arms.
 */
export const SESSION_EVENT_TYPES: readonly SessionEvent["type"][] = [
  "session.created",
  "repo.attached",
  "repo.detached",
  "workspace.preparing",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
  "event.compacted",
  "assistant.message",
  "assistant.thinking_update",
  "tool.invoked",
  "tool.result",
  "tool.error",
  "approval.rejected",
  "approval.canceled",
  "approval.remembered",
  "approval.rule_revoked",
  "moderation.review_flagged",
  "plan.proposed",
  "plan.accepted",
  "plan.handed_off",
  "question.asked",
  "mcp.server_status_changed",
  "mcp.server_config_changed",
  "mcp.server_trust_changed",
  "mcp.tool_override_changed",
  "mcp.server_oauth_completed",
  "cloud.task_updated",
  "session.restore_finished",
  "session.goal_cleared",
  "session.notice",
  "session.side_question_answered",
  "git.settled",
  "relay.pin_refused",
  "command.ended",
  "usage.model_rerouted",
  "session.archived",
  "session.reactivated",
  "session.closed",
  "session.pinned",
  "session.unpinned",
  "session.muted",
  "session.unmuted",
  "session.converted",
  "session.branch_changed",
  "session.swept_to_repo_root",
  "agent.provider_binding_changed",
  "agent.provider_binding_change_failed",
  "approval.requested",
  "approval.approved",
  "approval.reviewer_denied",
  "approval.denial_overridden",
  "run.queued",
  "run.step_limit_reached",
  "run.recovery_resolved",
  "run.refusal_choice_requested",
  "run.refusal_choice_resolved",
  "run.usage_credits_choice_requested",
  "run.usage_credits_choice_resolved",
  "session.goal_updated",
  "session.renamed",
  "pty.control_changed",
  "workflow.started",
  "workflow.resumed",
  "workflow.canceled",
  "workflow.results_posted",
  "workflow.step_started",
  "workflow.step_finished",
  "workflow.step_failed",
  "workflow.step_canceled",
  "workflow.step_skipped",
  "workflow.gate_resolved",
  "backup.completed",
  "backup.failed",
  "backup.restored",
] as const;

// One exported const per `EventCategory`, named `<CATEGORY_IN_SCREAMING_SNAKE>_EVENT_TYPES`, so
// the `*_events` categories read `..._EVENTS_EVENT_TYPES`. Each array holds exactly the registry
// types of its category, and together the arrays partition the census. No type check enforces
// either, so a type added to the census is added to its category's array in the same change. The
// explicit `readonly SessionEventType[]` annotations keep the exports `isolatedDeclarations`-clean.

/** The event types of the `run_lifecycle` category. */
export const RUN_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "run.queued",
  "run.starting",
  "run.running",
  "run.waiting_for_approval",
  "run.waiting_for_input",
  "run.pausing",
  "run.paused",
  "run.completed",
  "run.interrupted",
  "run.failed",
  "run.rolled_back",
  "run.provider_initialized",
  "run.turn_started",
  "run.worker_shutdown",
  "run.step_limit_reached",
  "run.recovery_resolved",
  "run.refusal_choice_requested",
  "run.refusal_choice_resolved",
  "run.usage_credits_choice_requested",
  "run.usage_credits_choice_resolved",
] as const;

/** The event types of the `assistant_output` category. */
export const ASSISTANT_OUTPUT_EVENT_TYPES: readonly SessionEventType[] = [
  "assistant.message",
  "assistant.thinking_update",
] as const;

/** The event types of the `tool_activity` category. */
export const TOOL_ACTIVITY_EVENT_TYPES: readonly SessionEventType[] = [
  "tool.invoked",
  "tool.result",
  "tool.error",
  "tool.replayed",
  "tool.skipped_during_recovery",
  "subagent.started",
  "subagent.completed",
  "command.ended",
] as const;

/** The event types of the `interactive_request` category. */
export const INTERACTIVE_REQUEST_EVENT_TYPES: readonly SessionEventType[] = [
  "queue_item.created",
  "queue_item.admitted",
  "queue_item.superseded",
  "queue_item.canceled",
  "queue_item.not_delivered",
  "intervention.requested",
  "intervention.accepted",
  "intervention.applied",
  "intervention.rejected",
  "intervention.degraded",
  "intervention.expired",
  "user.message",
  "question.asked",
] as const;

/** The event types of the `artifact_publication` category. */
export const ARTIFACT_PUBLICATION_EVENT_TYPES: readonly SessionEventType[] = [
  "artifact.published",
  "artifact.visibility_updated",
  "artifact.superseded",
  "diff.created",
  "git.settled",
] as const;

/**
 * The event types of the `session_lifecycle` category: session (including the side question, the
 * undo record, the pin and mute marks and a chat's conversion), agent, repo, workspace and
 * worktree (including the branch change and the sweep to the repository root), pty and cloud task.
 */
export const SESSION_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "session.created",
  "session.activated",
  "session.archived",
  "session.reactivated",
  "session.closed",
  "session.purge_requested",
  "session.purged",
  "session.goal_updated",
  "session.goal_cleared",
  "session.provider_status",
  "session.notice",
  "session.renamed",
  "session.pinned",
  "session.unpinned",
  "session.muted",
  "session.unmuted",
  "session.converted",
  "session.side_question_answered",
  "session.restore_finished",
  "agent.provider_binding_changed",
  "agent.provider_binding_change_failed",
  "repo.attached",
  "repo.detached",
  "workspace.preparing",
  "workspace.ready",
  "workspace.stale",
  "workspace.archived",
  "worktree.created",
  "worktree.ready",
  "worktree.dirty",
  "worktree.merged",
  "worktree.retired",
  "session.branch_changed",
  "session.swept_to_repo_root",
  "pty.control_changed",
  "cloud.task_updated",
] as const;

/** The event types of the `approval_flow` category. */
export const APPROVAL_FLOW_EVENT_TYPES: readonly SessionEventType[] = [
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.canceled",
  "approval.remembered",
  "approval.rule_revoked",
  "approval.reviewer_denied",
  "approval.denial_overridden",
  "moderation.review_flagged",
  "plan.proposed",
  "plan.accepted",
  "plan.handed_off",
] as const;

/** The event types of the `usage_telemetry` category. */
export const USAGE_TELEMETRY_EVENT_TYPES: readonly SessionEventType[] = [
  "usage.token_count",
  "usage.cost_update",
  "usage.context_window_update",
  "usage.budget_warning",
  "usage.rate_limit_update",
  "usage.api_retry",
  "usage.context_compacted",
  "usage.model_rerouted",
] as const;

/**
 * The event types of the `runtime_node_lifecycle` category: the two `session.clock_*` events,
 * whose category is the registry's, not their namespace prefix's.
 */
export const RUNTIME_NODE_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "session.clock_unsynced",
  "session.clock_corrected",
] as const;

/** The event types of the `recovery_events` category. */
export const RECOVERY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "recovery.attempted",
  "recovery.succeeded",
  "recovery.failed",
] as const;

/** The event types of the `security_events` category. */
export const SECURITY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "security.default.override",
  "security.update.available",
  "daemon.master_key_source",
  "daemon.pii_split_ambiguous",
  "relay.pin_refused",
] as const;

/** The event types of the `event_maintenance` category. */
export const EVENT_MAINTENANCE_EVENT_TYPES: readonly SessionEventType[] = [
  "event.compacted",
  "backup.completed",
  "backup.failed",
  "backup.restored",
] as const;

/** The event types of the `policy_events` category. */
export const POLICY_EVENTS_EVENT_TYPES: readonly SessionEventType[] = [
  "policy_bundle.loaded",
  "policy_bundle.rejected",
] as const;

/** The event types of the `orchestration_admission` category. */
export const ORCHESTRATION_ADMISSION_EVENT_TYPES: readonly SessionEventType[] = [
  "orchestration.rejected",
] as const;

/**
 * The event types of the `mcp_governance` category. Four of the five bind to the daemon-scope
 * sentinel session; `mcp.server_status_changed` binds per event.
 */
export const MCP_GOVERNANCE_EVENT_TYPES: readonly SessionEventType[] = [
  "mcp.server_status_changed",
  "mcp.server_config_changed",
  "mcp.server_trust_changed",
  "mcp.tool_override_changed",
  "mcp.server_oauth_completed",
] as const;

/** The event types of the `workflow_lifecycle` category. */
export const WORKFLOW_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.created",
  "workflow.started",
  "workflow.gated",
  "workflow.failed",
  "workflow.completed",
  "workflow.resumed",
  "workflow.canceled",
  "workflow.run_waiting",
  "workflow.schedule_armed",
  "workflow.schedule_fired",
  "workflow.trigger_armed",
  "workflow.trigger_fired",
  "workflow.results_posted",
] as const;

/** The event types of the `workflow_phase_lifecycle` category. */
export const WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.phase_admitted",
  "workflow.phase_waiting_on_pool",
  "workflow.phase_started",
  "workflow.phase_progressed",
  "workflow.phase_canceling",
  "workflow.phase_failed",
  "workflow.phase_retried",
  "workflow.phase_suspended",
  "workflow.phase_resumed",
  "workflow.phase_completed",
  "workflow.human_phase_claimed",
  "workflow.human_phase_escalated",
  "workflow.step_started",
  "workflow.step_finished",
  "workflow.step_failed",
  "workflow.step_canceled",
  "workflow.step_skipped",
] as const;

/** The event types of the `workflow_parallel_coordination` category. */
export const WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.parallel_join_cancellation",
] as const;

/** The event types of the `workflow_gate_resolution` category. */
export const WORKFLOW_GATE_RESOLUTION_EVENT_TYPES: readonly SessionEventType[] = [
  "workflow.gate_resolved",
] as const;
