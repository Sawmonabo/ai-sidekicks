// The step events a workflow run appends: a step started, finished, failed, skipped or canceled, a
// phase suspended, and a gate resolved, each naming its step by the step record's key.
import { z } from "zod";
import {
  WorkflowPayloadRefSchema,
  WorkflowCostSchema,
  workflowStepKeyShape,
  type WorkflowPayloadRef,
  type WorkflowCost,
  type WorkflowStepKey,
} from "./record.js";

import { ApprovalDecisionSchema, type ApprovalDecision } from "../../../approval.js";
import {
  ProviderAccountIdSchema,
  type ProviderAccountId,
} from "../../../provider/account/record.js";
import { SessionIdSchema, type SessionId } from "../../../session/id.js";
import { DeviceIdSchema, type DeviceId } from "../../../trust-statement.js";
import {
  WorkflowDefinitionIdSchema,
  WorkflowNodeIdSchema,
  WorkflowStepErrorSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowNodeId,
  type WorkflowStepError,
} from "../../definition/document.js";
import {
  WorkflowRunIdSchema,
  WorkflowWaitCauseSchema,
  type WorkflowRunId,
  type WorkflowWaitCause,
} from "../status.js";
import { countSchema, isoDateTimeSchema } from "../../../internal/wire-scalars.js";

/**
 * The step a step event names, by the same members a step record is keyed by, so an
 * event and the step it belongs to share one identity.
 */
export interface WorkflowStepEventPayload extends WorkflowStepKey {
  sessionId: SessionId;
  attempt: number;
}
const workflowStepEventFields = {
  sessionId: SessionIdSchema,
  ...workflowStepKeyShape,
  attempt: z.number().int().positive(),
};

/** `workflow.step_canceled`: a step running or waiting when its run ended failed or canceled. */
export const WorkflowStepCanceledPayloadSchema: z.ZodType<WorkflowStepEventPayload> = z
  .object(workflowStepEventFields)
  .strict();

/** `workflow.step_started`: the input the step ran on. */
export interface WorkflowStepStartedPayload extends WorkflowStepEventPayload {
  inputRef: WorkflowPayloadRef;
}
/** Wire schema for {@link WorkflowStepStartedPayload}. */
export const WorkflowStepStartedPayloadSchema: z.ZodType<WorkflowStepStartedPayload> = z
  .object({ ...workflowStepEventFields, inputRef: WorkflowPayloadRefSchema })
  .strict();

/** `workflow.step_finished`: the output and log the step produced, and its cost if billed. */
export interface WorkflowStepFinishedPayload extends WorkflowStepEventPayload {
  outputRef: WorkflowPayloadRef;
  logRef: WorkflowPayloadRef;
  cost?: WorkflowCost | undefined;
}
/** Wire schema for {@link WorkflowStepFinishedPayload}. */
export const WorkflowStepFinishedPayloadSchema: z.ZodType<WorkflowStepFinishedPayload> = z
  .object({
    ...workflowStepEventFields,
    outputRef: WorkflowPayloadRefSchema,
    logRef: WorkflowPayloadRefSchema,
    cost: WorkflowCostSchema.optional(),
  })
  .strict();

/** `workflow.step_failed`: the error, its failure code if one names it, and the failed item. */
export interface WorkflowStepFailedPayload extends WorkflowStepEventPayload {
  error: WorkflowStepError;
  failedItemIndex?: number | undefined;
}
/** Wire schema for {@link WorkflowStepFailedPayload}. */
export const WorkflowStepFailedPayloadSchema: z.ZodType<WorkflowStepFailedPayload> = z
  .object({
    ...workflowStepEventFields,
    error: WorkflowStepErrorSchema,
    failedItemIndex: countSchema.optional(),
  })
  .strict();

/**
 * `workflow.phase_suspended`: a step started waiting: its `waitCause`, the durable resume
 * instant where the wait armed one, and, for an `account` wait, the spent account the
 * attention read groups it under. The deadline a `Timeout` arms is written on the step's row
 * as truth and rides no event.
 */
export interface WorkflowPhaseSuspendedPayload extends WorkflowStepEventPayload {
  waitCause: WorkflowWaitCause;
  /** Only on an account wait; absent, only the person resumes it. */
  resumeAt?: string | undefined;
  /** Present exactly on an `account` wait. */
  providerAccountId?: ProviderAccountId | undefined;
}
/** Wire schema for {@link WorkflowPhaseSuspendedPayload}. */
export const WorkflowPhaseSuspendedPayloadSchema: z.ZodType<WorkflowPhaseSuspendedPayload> = z
  .object({
    ...workflowStepEventFields,
    waitCause: WorkflowWaitCauseSchema,
    resumeAt: isoDateTimeSchema.optional(),
    providerAccountId: ProviderAccountIdSchema.optional(),
  })
  .strict()
  .refine(
    (payload) => (payload.waitCause === "account") === (payload.providerAccountId !== undefined),
    {
      path: ["providerAccountId"],
      message: "An account wait names its spent account, and no other wait carries one.",
    },
  )
  .refine((payload) => payload.waitCause === "account" || payload.resumeAt === undefined, {
    path: ["resumeAt"],
    message: "Only an account wait resumes itself.",
  });

/** `workflow.step_skipped`: the step's input carried no items, or its node is disabled. */
export interface WorkflowStepSkippedPayload extends WorkflowStepEventPayload {
  reason: "no-items" | "disabled";
}
/** Wire schema for {@link WorkflowStepSkippedPayload}. */
export const WorkflowStepSkippedPayloadSchema: z.ZodType<WorkflowStepSkippedPayload> = z
  .object({ ...workflowStepEventFields, reason: z.enum(["no-items", "disabled"]) })
  .strict();

/**
 * `workflow.gate_resolved`: the answer, written with the approval record's entry in
 * one step. The run is named with the definition and the version it is pinned to.
 * `nodeId` names the approval step; a chain's question names none. `deviceId` is the
 * device that answered.
 */
export interface WorkflowGateResolvedPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
  nodeId?: WorkflowNodeId | undefined;
  outcome: ApprovalDecision;
  gateResolutionId: string;
  deviceId: DeviceId;
}
/** Wire schema for {@link WorkflowGateResolvedPayload}. */
export const WorkflowGateResolvedPayloadSchema: z.ZodType<WorkflowGateResolvedPayload> = z
  .object({
    sessionId: SessionIdSchema,
    workflowRunId: WorkflowRunIdSchema,
    definitionId: WorkflowDefinitionIdSchema,
    workflowVersionId: WorkflowVersionIdSchema,
    nodeId: WorkflowNodeIdSchema.optional(),
    outcome: ApprovalDecisionSchema,
    gateResolutionId: z.string().min(1),
    deviceId: DeviceIdSchema,
  })
  .strict();
