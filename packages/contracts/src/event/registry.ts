// The closed list of session event types, grouped by category. Each type's category is
// `SESSION_EVENT_CATEGORY_BY_TYPE` in `event/session.ts`.

import type { EventCategory } from "./envelope.js";
import { SESSION_EVENT_CATEGORY_BY_TYPE } from "./session.js";

// A type string is an immutable wire identifier, never renamed. Its category is its entry in the
// category map, not its prefix: `relay.pin_refused` is `security_events`, `plan.*` is
// `approval_flow`.
/** Every wire event type string, whether or not a payload variant is registered for it. */
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
  | "run.stopped"
  | "run.failed"
  | "run.rolled_back"
  | "run.provider_initialized"
  | "run.turn_started"
  | "run.worker_shutdown"
  | "run.step_limit_reached"
  | "run.token_limit_reached"
  | "run.recovery_steps_added"
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
  | "artifact.superseded"
  | "git.settled"
  // session_lifecycle
  | "session.created"
  | "session.activated"
  | "session.archived"
  | "session.reactivated"
  | "session.closed"
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
  | "session.spend_limit_reached"
  | "session.restore_finished"
  | "session.advisor_changed"
  | "agent.provider_binding_changed"
  | "agent.provider_binding_change_failed"
  | "workspace.preparing"
  | "workspace.ready"
  | "workspace.stale"
  | "workspace.archived"
  | "worktree.created"
  | "worktree.ready"
  | "worktree.dirty"
  | "worktree.merged"
  | "worktree.retired"
  | "repo.mount_health_changed"
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
  | "usage.rate_limit_update"
  | "usage.api_retry"
  | "usage.context_compacted"
  | "usage.model_rerouted"
  // recovery_events
  | "recovery.attempted"
  | "recovery.succeeded"
  | "recovery.failed"
  // security_events
  | "relay.pin_refused"
  // event_maintenance
  | "event.compacted"
  | "backup.completed"
  | "backup.failed"
  | "backup.restored"
  // orchestration_admission
  | "orchestration.rejected"
  // mcp_governance
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
  | "workflow.step_started"
  | "workflow.step_finished"
  | "workflow.step_failed"
  | "workflow.step_canceled"
  | "workflow.step_skipped"
  // workflow_parallel_coordination
  | "workflow.parallel_join_cancellation"
  // workflow_gate_resolution
  | "workflow.gate_resolved";

// One array per `EventCategory`, derived from `SESSION_EVENT_CATEGORY_BY_TYPE`, so each holds
// exactly its category's types and together they partition the registry.
function eventTypesIn(category: EventCategory): readonly SessionEventType[] {
  return [...SESSION_EVENT_CATEGORY_BY_TYPE]
    .filter(([, typeCategory]) => typeCategory === category)
    .map(([type]) => type);
}

/** The event types of the `run_lifecycle` category. */
export const RUN_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = eventTypesIn("run_lifecycle");
/** The event types of the `assistant_output` category. */
export const ASSISTANT_OUTPUT_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("assistant_output");
/** The event types of the `tool_activity` category. */
export const TOOL_ACTIVITY_EVENT_TYPES: readonly SessionEventType[] = eventTypesIn("tool_activity");
/** The event types of the `interactive_request` category. */
export const INTERACTIVE_REQUEST_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("interactive_request");
/** The event types of the `artifact_publication` category. */
export const ARTIFACT_PUBLICATION_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("artifact_publication");
/**
 * The event types of the `session_lifecycle` category: session (including the side question, the
 * undo record, the pin and mute marks and a chat's conversion), agent, repo, workspace and
 * worktree (including the branch change and the sweep to the repository root), pty and cloud task.
 *
 * @consumedBy a reader of the `session_lifecycle` events
 */
export const SESSION_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("session_lifecycle");
/**
 * The event types of the `approval_flow` category.
 *
 * @consumedBy a reader of the `approval_flow` events
 */
export const APPROVAL_FLOW_EVENT_TYPES: readonly SessionEventType[] = eventTypesIn("approval_flow");
/** The event types of the `usage_telemetry` category. */
export const USAGE_TELEMETRY_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("usage_telemetry");
/**
 * The event types of the `recovery_events` category.
 *
 * @consumedBy a reader of the `recovery_events` events
 */
export const RECOVERY_EVENTS_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("recovery_events");
/**
 * The event types of the `security_events` category.
 *
 * @consumedBy a reader of the `security_events` events
 */
export const SECURITY_EVENTS_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("security_events");
/**
 * The event types of the `event_maintenance` category.
 *
 * @consumedBy a reader of the `event_maintenance` events
 */
export const EVENT_MAINTENANCE_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("event_maintenance");
/**
 * The event types of the `orchestration_admission` category.
 *
 * @consumedBy a reader of the `orchestration_admission` events
 */
export const ORCHESTRATION_ADMISSION_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("orchestration_admission");
/**
 * The event types of the `mcp_governance` category. `mcp.server_oauth_completed` binds to the
 * daemon-scope sentinel session.
 */
export const MCP_GOVERNANCE_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("mcp_governance");
/**
 * The event types of the `workflow_lifecycle` category.
 *
 * @consumedBy a reader of the `workflow_lifecycle` events
 */
export const WORKFLOW_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] =
  eventTypesIn("workflow_lifecycle");
/**
 * The event types of the `workflow_phase_lifecycle` category.
 *
 * @consumedBy a reader of the `workflow_phase_lifecycle` events
 */
export const WORKFLOW_PHASE_LIFECYCLE_EVENT_TYPES: readonly SessionEventType[] = eventTypesIn(
  "workflow_phase_lifecycle",
);
/**
 * The event types of the `workflow_parallel_coordination` category.
 *
 * @consumedBy a reader of the `workflow_parallel_coordination` events
 */
export const WORKFLOW_PARALLEL_COORDINATION_EVENT_TYPES: readonly SessionEventType[] = eventTypesIn(
  "workflow_parallel_coordination",
);
/**
 * The event types of the `workflow_gate_resolution` category.
 *
 * @consumedBy a reader of the `workflow_gate_resolution` events
 */
export const WORKFLOW_GATE_RESOLUTION_EVENT_TYPES: readonly SessionEventType[] = eventTypesIn(
  "workflow_gate_resolution",
);
