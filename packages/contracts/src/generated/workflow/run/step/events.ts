// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The step events a workflow run appends: a step started, finished, failed, skipped or canceled, a phase admitted, started, progressed, canceling, retried, suspended, resumed, completed, failed or held for memory, a join's siblings canceled, and a gate resolved, each naming its step by the step record's key.

import type { ApprovalDecision } from "../../../approval.js";
import type { WireInstant } from "../../../internal/wire-scalars.js";
import type { ProviderAccountId } from "../../../provider/account/record.js";
import type { PermissionLevel } from "../../../session/controls/methods.js";
import type { SessionId } from "../../../session/id.js";
import type { DeviceId } from "../../../trust-statement.js";
import type {
  WorkflowContentHash,
  WorkflowDefinitionId,
  WorkflowNodeId,
  WorkflowVersionId,
} from "../../definition/document.js";
import type { WorkflowStepError } from "../../definition/item.js";
import type { WorkflowGateResolutionId } from "../gate-resolution.js";
import type { WorkflowRunId } from "../id.js";
import type {
  WorkflowCost,
  WorkflowPayloadRef,
  WorkflowStepKey,
  WorkflowStepSource,
} from "./record.js";

/** Every reason a step is skipped. */
export const WORKFLOW_STEP_SKIP_REASONS = ["noItems", "disabled", "reused"] as const;

/**
 * `workflow.phase.suspended`: a step started waiting: its `waitCause` and, for an
 * `account` wait, the spent account the attention read groups it under and the
 * durable resume instant where the wait armed one; absent, only the person resumes
 * it. A wait on anything else names neither. A wait on a person's approval, form or
 * reply carries the deadline its node's `Timeout` arms, the `waitId` its answer
 * names and the `logRef` the step wrote before it waited; a wait on an account or a
 * chain's question carries none of them.
 */
export type WorkflowPhaseSuspendedPayload =
  | {
      waitCause: "account";
      /**
       * The session the run lives in.
       */
      sessionId: SessionId;
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
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
      /**
       * The spent account.
       */
      providerAccountId: ProviderAccountId;
      /**
       * When the wait resumes itself; absent, only the person resumes it.
       */
      resumeAt?: WireInstant;
      /**
       * Never present: only a wait on a person gives up.
       */
      waitDeadlineAt?: never;
      /**
       * Never present: only a wait on a person carries a wait id.
       */
      waitId?: never;
      /**
       * Never present: only a wait on a person writes a log before it waits.
       */
      logRef?: never;
    }
  | {
      waitCause: "approval";
      /**
       * The session the run lives in.
       */
      sessionId: SessionId;
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
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
      /**
       * Never present: only an account wait names an account.
       */
      providerAccountId?: never;
      /**
       * Never present: only an account wait resumes itself.
       */
      resumeAt?: never;
      /**
       * When the wait gives up, where the node's `Timeout` armed one.
       */
      waitDeadlineAt?: WireInstant;
      /**
       * The wait the person's answer must name to settle it.
       */
      waitId: string;
      /**
       * The log the step wrote before it waited.
       */
      logRef: WorkflowPayloadRef;
    }
  | {
      waitCause: "form";
      /**
       * The session the run lives in.
       */
      sessionId: SessionId;
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
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
      /**
       * Never present: only an account wait names an account.
       */
      providerAccountId?: never;
      /**
       * Never present: only an account wait resumes itself.
       */
      resumeAt?: never;
      /**
       * When the wait gives up, where the node's `Timeout` armed one.
       */
      waitDeadlineAt?: WireInstant;
      /**
       * The wait the person's answer must name to settle it.
       */
      waitId: string;
      /**
       * The log the step wrote before it waited.
       */
      logRef: WorkflowPayloadRef;
    }
  | {
      waitCause: "reply";
      /**
       * The session the run lives in.
       */
      sessionId: SessionId;
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
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
      /**
       * Never present: only an account wait names an account.
       */
      providerAccountId?: never;
      /**
       * Never present: only an account wait resumes itself.
       */
      resumeAt?: never;
      /**
       * When the wait gives up, where the node's `Timeout` armed one.
       */
      waitDeadlineAt?: WireInstant;
      /**
       * The wait the person's answer must name to settle it.
       */
      waitId: string;
      /**
       * The log the step wrote before it waited.
       */
      logRef: WorkflowPayloadRef;
    }
  | {
      waitCause: "chain";
      /**
       * The session the run lives in.
       */
      sessionId: SessionId;
      /**
       * The run.
       */
      workflowRunId: WorkflowRunId;
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
      /**
       * Never present: only an account wait names an account.
       */
      providerAccountId?: never;
      /**
       * Never present: only an account wait resumes itself.
       */
      resumeAt?: never;
      /**
       * Never present: only a wait on a person gives up.
       */
      waitDeadlineAt?: never;
      /**
       * Never present: only a wait on a person carries a wait id.
       */
      waitId?: never;
      /**
       * Never present: only a wait on a person writes a log before it waits.
       */
      logRef?: never;
    };
/**
 * Why a phase was canceled rather than failing on its own work: a sibling branch's failure ended
 * the run, or a person canceled the run.
 */
export type WorkflowPhaseCancellationReason = "siblingFailure" | "runCanceled";
/**
 * Why a step was skipped: its input carried no items, its node is disabled, or a partial run
 * reused an earlier step's data in its place.
 */
export type WorkflowStepSkipReason = "noItems" | "disabled" | "reused";

/**
 * A step the event's write readied, by its node, its attempt and which execution of the node,
 * with what its `pending` row stores, so a rebuild writes the same row; the run is the
 * event's own.
 */
export interface WorkflowReadiedStep {
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
  /**
   * The feed of each main input slot in slot order, `null` for a slot nothing fed.
   */
  sources: (WorkflowStepSource | null)[];
  /**
   * The input.
   */
  inputRef: WorkflowPayloadRef;
}
/**
 * `workflow.step.canceled`: a step that was running or waiting when its run ended failed or
 * canceled, or a branch a first-to-arrive merge canceled once another branch arrived.
 */
export interface WorkflowStepCanceledPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The steps this event's write readied, each with what its `pending` row stores; empty
   * where it readied none.
   */
  readied: WorkflowReadiedStep[];
}
/**
 * `workflow.step.started`: the input the step ran on, for an agent step whose account could
 * not run the run's permission level the level it ran at instead, and for a step that gave
 * its node's pinned items the hash of that pin.
 */
export interface WorkflowStepStartedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The input.
   */
  inputRef: WorkflowPayloadRef;
  /**
   * Present on an agent step whose account could not run the run's level: the level it ran
   * at instead.
   */
  permissionLevel?: PermissionLevel;
  /**
   * Present on a step that gave its node's pinned items in place of running: the content
   * hash of that pin, which tells a later run whether the pin changed.
   */
  pinHash?: WorkflowContentHash;
}
/**
 * `workflow.step.completed`: the output and log the step produced, and its cost if billed.
 */
export interface WorkflowStepCompletedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The output.
   */
  outputRef: WorkflowPayloadRef;
  /**
   * The log.
   */
  logRef: WorkflowPayloadRef;
  /**
   * What it cost; absent where no provider was billed.
   */
  cost?: WorkflowCost;
  /**
   * How many items each main output holds, in output order, the error output last where
   * the node has one: the boundaries of the output lists `outputRef` stores joined.
   */
  outputItemCounts: number[];
  /**
   * The steps this event's write readied, each with what its `pending` row stores; empty
   * where it readied none.
   */
  readied: WorkflowReadiedStep[];
}
/**
 * The output a failed step passed on where its node's `onError` passed its input on: one member
 * holding the ref and its counts, so neither is written without the other.
 */
export interface WorkflowPassedOnOutput {
  /**
   * The output.
   */
  outputRef: WorkflowPayloadRef;
  /**
   * How many items each main output holds, in output order: the boundaries of the output
   * lists `outputRef` stores joined.
   */
  outputItemCounts: number[];
}
/**
 * `workflow.step.failed`: the error, its failure code if one names it, the failed item, the
 * words a person typed with the Decline that failed it, the step's log, and the output it
 * passed on where its node's `onError` passed its input on.
 */
export interface WorkflowStepFailedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The error.
   */
  error: WorkflowStepError;
  /**
   * The item that failed, by its index.
   */
  failedItemIndex?: number;
  /**
   * Present where the person's Decline on the command step's own approval card failed it
   * and they typed words on its `why not` line: those words.
   */
  declineReason?: string;
  /**
   * The log.
   */
  logRef: WorkflowPayloadRef;
  /**
   * Present only where the node's `onError` passed its input on: that output and its
   * counts.
   */
  passedOn?: WorkflowPassedOnOutput;
  /**
   * The steps this event's write readied, each with what its `pending` row stores; empty
   * where it readied none.
   */
  readied: WorkflowReadiedStep[];
}
/**
 * `workflow.phase.failed`: a phase failed, on its own work or because a sibling branch's
 * failure ended the run or a person canceled the run, and so canceled it.
 */
export interface WorkflowPhaseFailedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * `siblingFailure` where a sibling branch's failure canceled the phase, `runCanceled`
   * where a person's cancel of the run did; `null` where the phase failed on its own work.
   */
  cancellationReason: WorkflowPhaseCancellationReason | null;
}
/**
 * `workflow.phase.waitingOnPool`: the memory gate holds the step before it starts, written
 * on entry to the hold and every 30 seconds while it lasts; memory is the only pool, so the
 * payload names none.
 */
export interface WorkflowPhaseWaitingOnPoolPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The envelope sequence the hold began at, which ties each repeat back to one hold.
   */
  waitingSinceSeq: number;
}
/**
 * `workflow.phase.admitted`: the memory gate admitted the step, which may start.
 */
export interface WorkflowPhaseAdmittedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
}
/**
 * `workflow.phase.started`: an admitted phase began.
 */
export interface WorkflowPhaseStartedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
}
/**
 * `workflow.phase.progressed`: a phase reported progress, at its phase type's own cadence.
 */
export interface WorkflowPhaseProgressedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
}
/**
 * `workflow.phase.canceling`: a phase was asked to stop and is winding down.
 */
export interface WorkflowPhaseCancelingPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
}
/**
 * `workflow.phase.retried`: a failed phase was retried; the step named is the new attempt.
 */
export interface WorkflowPhaseRetriedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * The steps this event's write readied, each with what its `pending` row stores; empty
   * where it readied none.
   */
  readied: WorkflowReadiedStep[];
}
/**
 * `workflow.phase.resumed`: a waiting step resumed.
 */
export interface WorkflowPhaseResumedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
}
/**
 * `workflow.phase.completed`: a phase finished, and its gate may be answered.
 */
export interface WorkflowPhaseCompletedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
}
/**
 * `workflow.parallelJoin.branchesCanceled`: one wave of running sibling branches was canceled
 * at the join, because the run ended failed or canceled or a first-to-arrive merge took its
 * first input; each sibling's own `workflow.step.canceled` follows.
 */
export interface WorkflowParallelJoinBranchesCanceledPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
}
/**
 * The step whose data a reused skip carries, and the version that step's run executed, which
 * computed that data.
 */
export interface WorkflowReusedStep {
  /**
   * The step that computed the data, in an earlier run.
   */
  step: WorkflowStepKey;
  /**
   * The version that step's run executed.
   */
  workflowVersionId: WorkflowVersionId;
}
/**
 * `workflow.step.skipped`: why the step was skipped, what fed it, the input it skipped and
 * the output it passed on; a reused skip also names the step whose data it carries and, where
 * that step recorded one, the hash of its pin.
 */
export interface WorkflowStepSkippedPayload {
  /**
   * The run.
   */
  workflowRunId: WorkflowRunId;
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
  /**
   * The session the run lives in.
   */
  sessionId: SessionId;
  /**
   * Why.
   */
  reason: WorkflowStepSkipReason;
  /**
   * The feed of each main input slot in slot order, `null` for a slot nothing fed.
   */
  sources: (WorkflowStepSource | null)[];
  /**
   * The input.
   */
  inputRef: WorkflowPayloadRef;
  /**
   * The output it passed on.
   */
  outputRef: WorkflowPayloadRef;
  /**
   * How many items each main output carries on, in output order: the boundaries of the
   * output lists `outputRef` stores joined.
   */
  outputItemCounts: number[];
  /**
   * The steps this event's write readied, each with what its `pending` row stores; empty
   * where it readied none.
   */
  readied: WorkflowReadiedStep[];
  /**
   * Present exactly on a reused skip: the step of the same node, in another run, whose data
   * it carries.
   */
  reusedFrom?: WorkflowReusedStep;
  /**
   * Present only on a reused skip whose source step recorded one: the hash of the pin that
   * step ran on.
   */
  pinHash?: WorkflowContentHash;
}
/**
 * `workflow.gate.resolved`: the answer, written with the approval record's entry in one step.
 * `nodeId` names the approval step; a chain's question names none. `deviceId` is the device
 * that answered.
 */
export interface WorkflowGateResolvedPayload {
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
   * The approval step answered; absent for a chain's question.
   */
  nodeId?: WorkflowNodeId;
  /**
   * The answer.
   */
  outcome: ApprovalDecision;
  /**
   * The answer's row in the gate resolutions.
   */
  gateResolutionId: WorkflowGateResolutionId;
  /**
   * The device that answered.
   */
  deviceId: DeviceId;
}

export {
  validateWorkflowGateResolvedPayload,
  validateWorkflowParallelJoinBranchesCanceledPayload,
  validateWorkflowPassedOnOutput,
  validateWorkflowPhaseAdmittedPayload,
  validateWorkflowPhaseCancelingPayload,
  validateWorkflowPhaseCancellationReason,
  validateWorkflowPhaseCompletedPayload,
  validateWorkflowPhaseFailedPayload,
  validateWorkflowPhaseProgressedPayload,
  validateWorkflowPhaseResumedPayload,
  validateWorkflowPhaseRetriedPayload,
  validateWorkflowPhaseStartedPayload,
  validateWorkflowPhaseSuspendedPayload,
  validateWorkflowPhaseWaitingOnPoolPayload,
  validateWorkflowReadiedStep,
  validateWorkflowReusedStep,
  validateWorkflowStepCanceledPayload,
  validateWorkflowStepCompletedPayload,
  validateWorkflowStepFailedPayload,
  validateWorkflowStepSkipReason,
  validateWorkflowStepSkippedPayload,
  validateWorkflowStepStartedPayload,
} from "../../../checks/workflow/run/step/events.js";
