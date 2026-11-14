// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The events a workflow run appends about the run as a whole: it started, was gated, waited, failed, completed, was canceled, resumed or deleted, and its results were posted into a session.

import type { ProviderId } from "../../provider/id.js";
import type { SessionId } from "../../session/id.js";
import type {
  WorkflowDefinitionId,
  WorkflowNodeId,
  WorkflowVersionId,
} from "../definition/document.js";
import type { WorkflowStepError } from "../definition/item.js";
import type { WorkflowCancelReason } from "./control.js";
import type { WorkflowRunId } from "./id.js";
import type { WorkflowReadiedStep } from "./step/events.js";
import type { WorkflowPayloadRef } from "./step/record.js";
import type {
  WorkflowRunChainPlace,
  WorkflowRunMode,
  WorkflowRunTrigger,
  WorkflowStartedBy,
} from "./trigger.js";

/**
 * Whether a failed run is parked, waiting for a person to resume it, or ended.
 */
export type WorkflowRunFailedOutcome = "parked" | "ended";

/**
 * `workflow.run.started`: how the run was started and by whom, the trigger node that started
 * it, its place in its chain and the input its trigger step starts on, so the run row
 * rebuilds from events.
 */
export interface WorkflowRunStartedPayload {
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The definition it came from.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version it pins.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * How it was started.
   */
  mode: WorkflowRunMode;
  /**
   * Who or what started it.
   */
  startedBy: WorkflowStartedBy;
  /**
   * The trigger node that started it.
   */
  trigger: WorkflowRunTrigger;
  /**
   * Its place in its chain.
   */
  chain: WorkflowRunChainPlace;
  /**
   * The provider the run's command steps use; absent when the workflow names none.
   */
  provider?: ProviderId;
  /**
   * The input its trigger step starts on.
   */
  inputRef: WorkflowPayloadRef;
}
/**
 * `workflow.run.canceled`, written with the status in one step, so rebuilding the run from the
 * log cannot bring a canceled run back. `reason` is the person's, when one was given; a
 * chain's `Stop them all` cancels with none. `error` is the run's error the cancel stored,
 * carrying the reason as its message.
 */
export interface WorkflowRunCanceledPayload {
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The definition it came from.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version it pins.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * The person's reason.
   */
  reason?: WorkflowCancelReason;
  /**
   * The run's error, where the cancel stored one.
   */
  error?: WorkflowStepError;
}
/**
 * `workflow.run.deleted`, written with the delete of the run's rows in one step, so rebuilding
 * the runs from the log leaves out a run the person deleted, whose earlier events the log
 * keeps.
 */
export interface WorkflowRunDeletedPayload {
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The definition it came from.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version it pins.
   */
  workflowVersionId: WorkflowVersionId;
}
/**
 * `workflow.gate.reached`: the run reached a gate that must be answered before it goes on.
 */
export interface WorkflowGateReachedPayload {
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The definition it came from.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version it pins.
   */
  workflowVersionId: WorkflowVersionId;
}
/**
 * The step whose failure ended a run, by its node, its attempt and which execution of the
 * node; the run is the event's own.
 */
export interface WorkflowRunEndingStep {
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
}
/**
 * `workflow.run.failed`: the run failed on a step and either parked or ended. A parked run
 * leaves the cause to that step's own event; an ended run names the step its ending sits on
 * and the run's error, which a run cap makes the cap's own.
 */
export interface WorkflowRunFailedPayload {
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The definition it came from.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version it pins.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * Whether the run parked or ended.
   */
  outcome: WorkflowRunFailedOutcome;
  /**
   * The step the run's ending sits on; present exactly when the run ended.
   */
  endingStep?: WorkflowRunEndingStep;
  /**
   * The run's error; present exactly when the run ended.
   */
  error?: WorkflowStepError;
}
/**
 * `workflow.run.completed`: the run reached its last steps and succeeded.
 */
export interface WorkflowRunCompletedPayload {
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The definition it came from.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version it pins.
   */
  workflowVersionId: WorkflowVersionId;
}
/**
 * `workflow.run.waiting`: the run started waiting, on a person, on its chain's question or on
 * a spent provider account; the waiting step's own `workflow.phase.suspended` says which.
 */
export interface WorkflowRunWaitingPayload {
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The definition it came from.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version it pins.
   */
  workflowVersionId: WorkflowVersionId;
}
/**
 * One step a resumed run picks up, by its node, its attempt and which execution of the node;
 * the run is the event's own.
 */
export interface WorkflowResumedStep {
  /**
   * The node.
   */
  nodeId: WorkflowNodeId;
  /**
   * Which attempt at the step, counted from 1: each retry is a new attempt.
   */
  attempt: number;
  /**
   * Which execution of the node, increasing through the run.
   */
  executionIndex: number;
}
/**
 * Where a resumed run picks up, so a reader rebuilds it without replaying the run's whole history:
 * the steps going on and the approval steps still waiting for an answer.
 */
export interface WorkflowResumptionPoint {
  /**
   * The steps going on.
   */
  activeSteps: WorkflowResumedStep[];
  /**
   * The approval steps still waiting for an answer.
   */
  pendingGates: WorkflowNodeId[];
}
/**
 * `workflow.run.resumed`: a person or an armed schedule resumed a waiting or failed run, with
 * where it picks up and, only on an accepted re-pin, the version it left and the one it
 * joined, both or neither.
 */
export interface WorkflowRunResumedPayload {
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The definition it came from.
   */
  definitionId: WorkflowDefinitionId;
  /**
   * The version it pins.
   */
  workflowVersionId: WorkflowVersionId;
  /**
   * Where it picks up.
   */
  resumptionPoint: WorkflowResumptionPoint;
  /**
   * The version the run left, on an accepted re-pin.
   */
  repinnedFromWorkflowVersionId?: WorkflowVersionId;
  /**
   * The version the run joined, on an accepted re-pin.
   */
  repinnedToWorkflowVersionId?: WorkflowVersionId;
  /**
   * The steps this event's write readied, each with what its `pending` row stores; empty
   * where it readied none.
   */
  readied: WorkflowReadiedStep[];
}
/**
 * `workflow.results.posted`: a finished run's results landed as the results row in `sessionId`,
 * the session that asked. It follows the run's final status.
 */
export interface WorkflowResultsPostedPayload {
  /**
   * The session that asked.
   */
  sessionId: SessionId;
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
  /**
   * The run's summary line as the post found it; absent where the run wrote none.
   */
  summary?: string;
}

export {
  validateWorkflowGateReachedPayload,
  validateWorkflowResultsPostedPayload,
  validateWorkflowResumedStep,
  validateWorkflowResumptionPoint,
  validateWorkflowRunCanceledPayload,
  validateWorkflowRunCompletedPayload,
  validateWorkflowRunDeletedPayload,
  validateWorkflowRunEndingStep,
  validateWorkflowRunFailedOutcome,
  validateWorkflowRunFailedPayload,
  validateWorkflowRunResumedPayload,
  validateWorkflowRunStartedPayload,
  validateWorkflowRunWaitingPayload,
} from "../../checks/workflow/run/events.js";
