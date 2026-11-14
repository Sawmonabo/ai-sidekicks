// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The events a workflow appends before any run exists: a version written, and a trigger or schedule armed or fired, each naming the workflow rather than a run.

import type { WireInstant } from "../../internal/wire-scalars.js";
import type { SessionId } from "../../session/id.js";
import type { WorkflowDefinitionId, WorkflowNodeId, WorkflowVersionId } from "./document.js";

/**
 * `workflow.version.created`: a workflow was authored or a new version of it written; no run
 * exists yet, so it names the workflow and the version alone.
 */
export interface WorkflowVersionCreatedPayload {
  /**
   * The session the event is written to.
   */
  sessionId: SessionId;
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version written.
   */
  workflowVersionId: WorkflowVersionId;
}
/**
 * `workflow.schedule.armed` and `workflow.trigger.armed`: a schedule, or a file watch, webhook or
 * session-event filter, was armed on the workflow's trigger node.
 */
export interface WorkflowTriggerArmedPayload {
  /**
   * The session the event is written to.
   */
  sessionId: SessionId;
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The trigger node armed.
   */
  nodeId: WorkflowNodeId;
}
/**
 * `workflow.schedule.fired` and `workflow.trigger.fired`: an armed trigger fired, starting a run.
 * The workflow, the node and `scheduledInstant` together name the occurrence, so neither a restart
 * nor a second arming fires it twice.
 */
export interface WorkflowTriggerFiredPayload {
  /**
   * The session the event is written to.
   */
  sessionId: SessionId;
  /**
   * The workflow.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The trigger node that fired.
   */
  nodeId: WorkflowNodeId;
  /**
   * The occurrence's instant.
   */
  scheduledInstant: WireInstant;
}

export {
  validateWorkflowTriggerArmedPayload,
  validateWorkflowTriggerFiredPayload,
  validateWorkflowVersionCreatedPayload,
} from "../../checks/workflow/definition/events.js";
