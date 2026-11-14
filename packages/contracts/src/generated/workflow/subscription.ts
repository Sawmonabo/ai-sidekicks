// Generated from the Rust contracts by `pnpm --filter @ai-sidekicks/contracts generate`.
// Change the Rust source and regenerate; never edit this file.

// The one live stream the workflows screens read, `workflow.subscribe`: the hold on starting new runs, run, step and schedule changes, and a definition changed or removed, with its method table.

import type { SchemaCheck } from "../../schema-check.js";
import { validateSubscribeAcknowledgmentResponse } from "../checks/jsonrpc/streaming.js";
import {
  validateWorkflowSubscribeNotification,
  validateWorkflowSubscribeRequest,
} from "../checks/workflow/subscription.js";
import type { WireInstant } from "../internal/wire-scalars.js";
import type { SubscribeAcknowledgmentResponse } from "../jsonrpc/streaming.js";
import type { SessionId } from "../session/id.js";
import type { WorkflowDefinitionId, WorkflowNodeId } from "./definition/document.js";
import type { WorkflowDefinitionSummary } from "./definition/methods.js";
import type { WorkflowRunId } from "./run/id.js";
import type { WorkflowRunSummary } from "./run/list.js";
import type { WorkflowStep } from "./run/step/record.js";

/**
 * What happened to a schedule. `armed` and `disarmed` are its state, which a later frame replaces;
 * `fired` and `skipped` (a fire the overlap policy skipped, never a run) are events never folded.
 */
export type WorkflowScheduleChange = "armed" | "disarmed" | "fired" | "skipped";
/**
 * One `workflow.subscribe` frame: the hold first, then state frames (`newRunHold`, `run`, `step`,
 * `definition`, a schedule `armed` or `disarmed`), each its key's newest value, so a slow reader
 * may miss a state. A removal and a schedule `fired` or `skipped` are events, each sent and never
 * folded into a later one; there is no cursor and no dropped mark.
 */
export type WorkflowSubscribeNotification =
  | {
      kind: "newRunHold";
      /**
       * Whether the hold is on.
       */
      held: boolean;
      /**
       * How many starts wait behind it.
       */
      waitingStartCount: number;
    }
  | {
      kind: "run";
      /**
       * The run.
       */
      run: WorkflowRunSummary;
    }
  | {
      kind: "runsRemoved";
      /**
       * The runs.
       *
       * @minItems 1
       */
      workflowRunIds: [WorkflowRunId, ...WorkflowRunId[]];
    }
  | {
      kind: "step";
      /**
       * The step's run.
       */
      workflowRunId: WorkflowRunId;
      /**
       * The step.
       */
      step: WorkflowStep;
    }
  | {
      kind: "schedule";
      /**
       * The workflow.
       */
      definitionId: WorkflowDefinitionId;
      /**
       * The schedule's trigger node.
       */
      nodeId: WorkflowNodeId;
      /**
       * What happened.
       */
      event: WorkflowScheduleChange;
      /**
       * The occurrence it happened for.
       */
      scheduledAt: WireInstant;
      /**
       * The next fire, while the schedule stays armed.
       */
      nextFireAt?: WireInstant;
    }
  | {
      kind: "definition";
      /**
       * The workflow.
       */
      definition: WorkflowDefinitionSummary;
    }
  | {
      kind: "definitionRemoved";
      /**
       * The workflow.
       */
      definitionId: WorkflowDefinitionId;
    };

/**
 * The `workflow.subscribe` input: one subscription for the whole runs list and the canvas
 * overlay, never one per row. Without `sessionId` it covers every run this daemon ran.
 */
export interface WorkflowSubscribeRequest {
  /**
   * The session whose runs it follows; absent for every run.
   */
  sessionId?: SessionId;
  /**
   * The workflow whose runs and schedule it follows; absent for every workflow.
   */
  definitionId?: WorkflowDefinitionId;
}

export {
  validateWorkflowScheduleChange,
  validateWorkflowSubscribeNotification,
  validateWorkflowSubscribeRequest,
} from "../checks/workflow/subscription.js";

/** The methods of {@link WORKFLOW_SUBSCRIPTION_METHOD_DESCRIPTORS}, each with its checks. */
export interface WorkflowSubscriptionMethodDescriptors {
  readonly "workflow.subscribe": {
    readonly method: "workflow.subscribe";
    readonly procedureType: "subscription";
    readonly mutating: false;
    readonly requestCheck: SchemaCheck<WorkflowSubscribeRequest>;
    readonly responseCheck: SchemaCheck<SubscribeAcknowledgmentResponse>;
    readonly emissionCheck: SchemaCheck<WorkflowSubscribeNotification>;
  };
}
/** The `workflow.subscribe` method's table. */
export const WORKFLOW_SUBSCRIPTION_METHOD_DESCRIPTORS: WorkflowSubscriptionMethodDescriptors =
  /* @__PURE__ */ Object.freeze({
    "workflow.subscribe": /* @__PURE__ */ Object.freeze({
      method: "workflow.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestCheck: validateWorkflowSubscribeRequest,
      responseCheck: validateSubscribeAcknowledgmentResponse,
      emissionCheck: validateWorkflowSubscribeNotification,
    }),
  });
