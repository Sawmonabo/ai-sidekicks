// The one live stream the workflows screens read, `workflow.subscribe`: the hold on starting new
// runs, run, step and schedule changes, and a definition changed or removed, with its method table.
import { z } from "zod";

import { SubscribeAckResponseSchema, type SubscribeAckResponse } from "../jsonrpc/streaming.js";
import {
  defineMethodDescriptors,
  type SubscriptionMethodDescriptor,
} from "../method-descriptor.js";
import { SessionIdSchema, type SessionId } from "../session/id.js";
import {
  WorkflowDefinitionIdSchema,
  WorkflowNodeIdSchema,
  type WorkflowDefinitionId,
  type WorkflowNodeId,
} from "./definition/document.js";
import {
  WorkflowDefinitionSummarySchema,
  type WorkflowDefinitionSummary,
} from "./definition/methods.js";
import { WorkflowRunIdSchema, type WorkflowRunId } from "./run/id.js";
import {
  WorkflowRunSummarySchema,
  type WorkflowRunSummary,
  type WorkflowRunsPauseState,
} from "./run/records.js";
import { WorkflowStepSchema, type WorkflowStep } from "./run/step/record.js";
import { countSchema, isoDateTimeSchema } from "../internal/wire-scalars.js";

/**
 * The `workflow.subscribe` input: one subscription for the whole runs list and the
 * canvas overlay, never one per row. Without `sessionId` it covers every run this
 * daemon ran.
 */
export interface WorkflowSubscribeRequest {
  sessionId?: SessionId | undefined;
  definitionId?: WorkflowDefinitionId | undefined;
}
/** Wire schema for {@link WorkflowSubscribeRequest}. */
export const WorkflowSubscribeRequestSchema: z.ZodType<
  WorkflowSubscribeRequest,
  WorkflowSubscribeRequest
> = z
  .object({
    sessionId: SessionIdSchema.optional(),
    definitionId: WorkflowDefinitionIdSchema.optional(),
  })
  .strict();

/**
 * One emission of `workflow.subscribe`. The current hold comes first, then run, step
 * and schedule changes as they happen. A definition's change and a removed definition
 * or run ride it too, so no view keeps a row that is gone. A skipped schedule fire is
 * reported here and never becomes a run.
 */
export type WorkflowSubscribeNotification =
  | ({ kind: "runsPause" } & WorkflowRunsPauseState)
  | { kind: "run"; run: WorkflowRunSummary }
  | { kind: "runsRemoved"; workflowRunIds: [WorkflowRunId, ...WorkflowRunId[]] }
  | { kind: "step"; workflowRunId: WorkflowRunId; step: WorkflowStep }
  | {
      kind: "schedule";
      definitionId: WorkflowDefinitionId;
      nodeId: WorkflowNodeId;
      event: "armed" | "disarmed" | "fired" | "skipped";
      scheduledAt: string;
      nextFireAt?: string | undefined;
    }
  | { kind: "definition"; definition: WorkflowDefinitionSummary }
  | { kind: "definitionRemoved"; definitionId: WorkflowDefinitionId };
/** Wire schema for {@link WorkflowSubscribeNotification}. */
export const WorkflowSubscribeNotificationSchema: z.ZodType<WorkflowSubscribeNotification> =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("runsPause"),
        paused: z.boolean(),
        waitingStartCount: countSchema,
      })
      .strict(),
    z.object({ kind: z.literal("run"), run: WorkflowRunSummarySchema }).strict(),
    z
      .object({
        kind: z.literal("runsRemoved"),
        workflowRunIds: z.tuple([WorkflowRunIdSchema], WorkflowRunIdSchema),
      })
      .strict(),
    z
      .object({
        kind: z.literal("step"),
        workflowRunId: WorkflowRunIdSchema,
        step: WorkflowStepSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("schedule"),
        definitionId: WorkflowDefinitionIdSchema,
        nodeId: WorkflowNodeIdSchema,
        event: z.enum(["armed", "disarmed", "fired", "skipped"]),
        scheduledAt: isoDateTimeSchema,
        nextFireAt: isoDateTimeSchema.optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal("definition"), definition: WorkflowDefinitionSummarySchema })
      .strict(),
    z
      .object({ kind: z.literal("definitionRemoved"), definitionId: WorkflowDefinitionIdSchema })
      .strict(),
  ]);

/** The `workflow.subscribe` method, keyed by name. */
export interface WorkflowSubscriptionMethodDescriptors {
  readonly "workflow.subscribe": SubscriptionMethodDescriptor<
    "workflow.subscribe",
    WorkflowSubscribeRequest,
    SubscribeAckResponse,
    WorkflowSubscribeNotification
  >;
}

/** The `workflow.subscribe` method's table. */
export const WORKFLOW_SUBSCRIPTION_METHOD_DESCRIPTORS: WorkflowSubscriptionMethodDescriptors =
  defineMethodDescriptors({
    "workflow.subscribe": {
      method: "workflow.subscribe",
      procedureType: "subscription",
      mutating: false,
      requestSchema: WorkflowSubscribeRequestSchema,
      responseSchema: SubscribeAckResponseSchema,
      emissionSchema: WorkflowSubscribeNotificationSchema,
    },
  });
