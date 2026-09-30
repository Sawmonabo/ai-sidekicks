// One step of a workflow run: reading its input, output or log, the agent and human
// steps' saved outputs, answering an approval step or a chain's question, loading,
// saving and submitting a waiting form, and opening a fix session on a failed step,
// with the refusals, the step events and the method table. A step is addressed by its
// run, its node and which execution of that node, because a loop runs one node many
// times. A descriptor registers nothing.
import { z } from "zod";

import { ApprovalDecisionSchema, type ApprovalDecision } from "./approval.js";
import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { ArtifactIdSchema, type ArtifactId } from "./provider-driver.js";
import { SessionIdSchema, type SessionId } from "./session.js";
import { DeviceIdSchema, type DeviceId } from "./trust-statement.js";
import {
  WorkflowDefinitionIdSchema,
  WorkflowNodeIdSchema,
  WorkflowStepErrorSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowNodeId,
  type WorkflowStepError,
} from "./workflow-definition.js";
import { WorkflowParamSpecSchema, type WorkflowParamSpec } from "./workflow-kind.js";
import {
  WorkflowCostSchema,
  WorkflowPayloadRefSchema,
  WorkflowRunIdSchema,
  type WorkflowCost,
  type WorkflowPayloadRef,
  type WorkflowRunId,
} from "./workflow-run.js";

const executionIndexSchema = z.number().int().nonnegative();

/** The three members that address one step: the run, the node and which execution of it. */
export interface WorkflowStepKey {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  executionIndex: number;
}
const workflowStepKeyFields = {
  workflowRunId: WorkflowRunIdSchema,
  nodeId: WorkflowNodeIdSchema,
  executionIndex: executionIndexSchema,
};
/** Wire schema for {@link WorkflowStepKey}, the whole input of a step read. */
export const WorkflowStepKeySchema: z.ZodType<WorkflowStepKey, WorkflowStepKey> = z
  .object(workflowStepKeyFields)
  .strict();

// workflow.stepRead

/** Which of a step's three payloads a read returns. */
export type WorkflowStepPayloadKind = "input" | "output" | "log";
const WorkflowStepPayloadKindSchema = z.enum(["input", "output", "log"]);

/**
 * The `workflow.stepRead` input: one step's input, output or log, paged. Every secret
 * value was redacted before the payload was written, so a read never returns one.
 */
export interface WorkflowStepReadRequest extends WorkflowStepKey {
  which: WorkflowStepPayloadKind;
  limit?: number | undefined;
  cursor?: string | undefined;
}
/** Wire schema for {@link WorkflowStepReadRequest}. */
export const WorkflowStepReadRequestSchema: z.ZodType<
  WorkflowStepReadRequest,
  WorkflowStepReadRequest
> = z
  .object({
    ...workflowStepKeyFields,
    which: WorkflowStepPayloadKindSchema,
    limit: z.number().int().positive().optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * The `workflow.stepRead` result: the payload inline, as an artifact reference, or
 * expired, with a cursor while more remains.
 */
export interface WorkflowStepReadResponse {
  nodeId: WorkflowNodeId;
  executionIndex: number;
  which: WorkflowStepPayloadKind;
  payload: WorkflowPayloadRef;
  nextCursor?: string | undefined;
}
/** Wire schema for {@link WorkflowStepReadResponse}. */
export const WorkflowStepReadResponseSchema: z.ZodType<WorkflowStepReadResponse> = z
  .object({
    nodeId: WorkflowNodeIdSchema,
    executionIndex: executionIndexSchema,
    which: WorkflowStepPayloadKindSchema,
    payload: WorkflowPayloadRefSchema,
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

// workflow.stepOutputList

/** The `workflow.stepOutputList` input: the run whose agent and human steps' outputs are listed. */
export interface WorkflowStepOutputListRequest {
  workflowRunId: WorkflowRunId;
}
/** Wire schema for {@link WorkflowStepOutputListRequest}. */
export const WorkflowStepOutputListRequestSchema: z.ZodType<
  WorkflowStepOutputListRequest,
  WorkflowStepOutputListRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema }).strict();

/**
 * One saved output of a finished step: its summary and, for an artifact, the artifact's
 * id. An `artifact_ref` output points at a stored artifact and never carries its bytes;
 * an `inline` output carries no artifact.
 */
export type WorkflowStepOutput =
  | { valueKind: "inline"; summary: string; producedAt: string }
  | { valueKind: "artifact_ref"; artifactId: ArtifactId; summary: string; producedAt: string };
/** Wire schema for {@link WorkflowStepOutput}. */
export const WorkflowStepOutputSchema: z.ZodType<WorkflowStepOutput> = z.discriminatedUnion(
  "valueKind",
  [
    z
      .object({
        valueKind: z.literal("inline"),
        summary: z.string(),
        producedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
    z
      .object({
        valueKind: z.literal("artifact_ref"),
        artifactId: ArtifactIdSchema,
        summary: z.string(),
        producedAt: z.iso.datetime({ offset: true }),
      })
      .strict(),
  ],
);

/**
 * One finished agent or human step and its saved outputs. `status` is the step's, not
 * the run's; a retry adds steps and never rewrites one.
 */
export interface WorkflowStepOutputs {
  nodeId: WorkflowNodeId;
  executionIndex: number;
  status: "succeeded" | "failed";
  outputs: WorkflowStepOutput[];
}

/**
 * The `workflow.stepOutputList` result: summaries and artifact references only. One
 * step's full input, output or log comes from `workflow.stepRead`.
 */
export interface WorkflowStepOutputListResponse {
  steps: WorkflowStepOutputs[];
}
/** Wire schema for {@link WorkflowStepOutputListResponse}. */
export const WorkflowStepOutputListResponseSchema: z.ZodType<WorkflowStepOutputListResponse> = z
  .object({
    steps: z.array(
      z
        .object({
          nodeId: WorkflowNodeIdSchema,
          executionIndex: executionIndexSchema,
          status: z.enum(["succeeded", "failed"]),
          outputs: z.array(WorkflowStepOutputSchema),
        })
        .strict(),
    ),
  })
  .strict();

// workflow.gateResolve

/**
 * The `workflow.gateResolve` input: the person's answer to an approval step, named by
 * `nodeId`, or to the question a chain raises on its first run, which names no node:
 * `approved` keeps the chain going and `rejected` stops every run of it. The answer
 * goes through the approvals pipeline and its policy check.
 */
export interface WorkflowGateResolveRequest {
  workflowRunId: WorkflowRunId;
  nodeId?: WorkflowNodeId | undefined;
  decision: ApprovalDecision;
  feedback?: string | undefined;
}
/** Wire schema for {@link WorkflowGateResolveRequest}. */
export const WorkflowGateResolveRequestSchema: z.ZodType<
  WorkflowGateResolveRequest,
  WorkflowGateResolveRequest
> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    nodeId: WorkflowNodeIdSchema.optional(),
    decision: ApprovalDecisionSchema,
    feedback: z.string().min(1).optional(),
  })
  .strict();

/** The `workflow.gateResolve` result: the answer's entry in the run's approval record. */
export interface WorkflowGateResolveResponse {
  gateResolutionId: string;
  decidedAt: string;
}
/** Wire schema for {@link WorkflowGateResolveResponse}. */
export const WorkflowGateResolveResponseSchema: z.ZodType<WorkflowGateResolveResponse> = z
  .object({
    gateResolutionId: z.string().min(1),
    decidedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

// workflow.humanFormRead, workflow.humanFormDraftSave, workflow.humanFormSubmit

/**
 * What the person has typed into a waiting form so far, held by the daemon so a reload
 * keeps it. `revision` counts draft saves and guards only them.
 */
export interface WorkflowHumanFormDraft {
  formState: Record<string, unknown>;
  revision: number;
  savedAt: string;
}

/**
 * The `workflow.humanFormRead` result: the node's prompt, its fields (the same parameter
 * specs the inspector's form draws), the draft saved so far, and `formRevision`, the
 * token a submit carries back: 0 while the step has no accepted answer. The input is
 * {@link WorkflowStepKey}.
 */
export interface WorkflowHumanFormReadResponse {
  prompt: string;
  fields: WorkflowParamSpec[];
  formRevision: number;
  draft?: WorkflowHumanFormDraft | undefined;
}
/** Wire schema for {@link WorkflowHumanFormReadResponse}. */
export const WorkflowHumanFormReadResponseSchema: z.ZodType<WorkflowHumanFormReadResponse> = z
  .object({
    prompt: z.string().min(1),
    fields: z.array(WorkflowParamSpecSchema),
    formRevision: z.number().int().nonnegative(),
    draft: z
      .object({
        formState: z.record(z.string(), z.unknown()),
        revision: z.number().int().positive(),
        savedAt: z.iso.datetime({ offset: true }),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The `workflow.humanFormDraftSave` input: the form as it is typed. With
 * `expectedRevision`, a save over a newer draft is refused rather than overwriting it.
 */
export interface WorkflowHumanFormDraftSaveRequest extends WorkflowStepKey {
  formState: Record<string, unknown>;
  expectedRevision?: number | undefined;
}
/** Wire schema for {@link WorkflowHumanFormDraftSaveRequest}. */
export const WorkflowHumanFormDraftSaveRequestSchema: z.ZodType<
  WorkflowHumanFormDraftSaveRequest,
  WorkflowHumanFormDraftSaveRequest
> = z
  .object({
    ...workflowStepKeyFields,
    formState: z.record(z.string(), z.unknown()),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();

/** The `workflow.humanFormDraftSave` result: the draft's new revision and when it was saved. */
export interface WorkflowHumanFormDraftSaveResponse {
  revision: number;
  savedAt: string;
}
/** Wire schema for {@link WorkflowHumanFormDraftSaveResponse}. */
export const WorkflowHumanFormDraftSaveResponseSchema: z.ZodType<WorkflowHumanFormDraftSaveResponse> =
  z
    .object({
      revision: z.number().int().positive(),
      savedAt: z.iso.datetime({ offset: true }),
    })
    .strict();

/**
 * The `workflow.humanFormSubmit` input. `expectedRevision` is the form's revision when
 * it was read. A submit carrying a stale revision is refused; it never overwrites an
 * answer that was already accepted. A location is a path, picked with the platform's
 * own chooser; a form has no artifact field.
 */
export interface WorkflowHumanFormSubmitRequest extends WorkflowStepKey {
  fields: Record<string, unknown>;
  expectedRevision: number;
}
/** Wire schema for {@link WorkflowHumanFormSubmitRequest}. */
export const WorkflowHumanFormSubmitRequestSchema: z.ZodType<
  WorkflowHumanFormSubmitRequest,
  WorkflowHumanFormSubmitRequest
> = z
  .object({
    ...workflowStepKeyFields,
    fields: z.record(z.string(), z.unknown()),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

/** The `workflow.humanFormSubmit` result: when the answer was accepted. */
export interface WorkflowHumanFormSubmitResponse {
  submittedAt: string;
}
/** Wire schema for {@link WorkflowHumanFormSubmitResponse}. */
export const WorkflowHumanFormSubmitResponseSchema: z.ZodType<WorkflowHumanFormSubmitResponse> = z
  .object({ submittedAt: z.iso.datetime({ offset: true }) })
  .strict();

// workflow.fixSessionCreate

/**
 * The `workflow.fixSessionCreate` result: the fix session. The input is the failed
 * step's {@link WorkflowStepKey}. It opens a new session on the step's own project and
 * checkout, seeded with the step; the step's own record receives nothing, and the run
 * links the new session. A step that did not fail is refused as an invalid transition.
 */
export interface WorkflowFixSessionCreateResponse {
  sessionId: SessionId;
}
/** Wire schema for {@link WorkflowFixSessionCreateResponse}. */
export const WorkflowFixSessionCreateResponseSchema: z.ZodType<WorkflowFixSessionCreateResponse> = z
  .object({ sessionId: SessionIdSchema })
  .strict();

// Refusals

/**
 * An approval answered, a form read or a form submitted on a step that is no longer
 * waiting, an answer after the step's `Timeout` passed included, even before its timer
 * has run.
 */
export type WorkflowStepNotWaitingCode = "workflow.step_not_waiting";
/** The code of an answer or a form read on a step that is no longer waiting. */
export const WORKFLOW_STEP_NOT_WAITING_CODE: WorkflowStepNotWaitingCode =
  "workflow.step_not_waiting";

/** A form draft save or a form submit carrying a revision that is no longer current. */
export type WorkflowRevisionStaleCode = "workflow.revision_stale";
/** The code of a stale form revision. */
export const WORKFLOW_REVISION_STALE_CODE: WorkflowRevisionStaleCode = "workflow.revision_stale";

// Step events

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
  ...workflowStepKeyFields,
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

/** `workflow.step_failed`: the error, with its failure code if one names it, and the failed item. */
export interface WorkflowStepFailedPayload extends WorkflowStepEventPayload {
  error: WorkflowStepError;
  failedItemIndex?: number | undefined;
}
/** Wire schema for {@link WorkflowStepFailedPayload}. */
export const WorkflowStepFailedPayloadSchema: z.ZodType<WorkflowStepFailedPayload> = z
  .object({
    ...workflowStepEventFields,
    error: WorkflowStepErrorSchema,
    failedItemIndex: z.number().int().nonnegative().optional(),
  })
  .strict();

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

// The workflow step method table

/** The `workflow.*` methods on one step, keyed by name. */
export interface WorkflowStepMethodDescriptors {
  readonly "workflow.stepRead": MethodDescriptor<
    "workflow.stepRead",
    WorkflowStepReadRequest,
    WorkflowStepReadResponse
  >;
  readonly "workflow.stepOutputList": MethodDescriptor<
    "workflow.stepOutputList",
    WorkflowStepOutputListRequest,
    WorkflowStepOutputListResponse
  >;
  readonly "workflow.gateResolve": MethodDescriptor<
    "workflow.gateResolve",
    WorkflowGateResolveRequest,
    WorkflowGateResolveResponse
  >;
  readonly "workflow.humanFormRead": MethodDescriptor<
    "workflow.humanFormRead",
    WorkflowStepKey,
    WorkflowHumanFormReadResponse
  >;
  readonly "workflow.humanFormDraftSave": MethodDescriptor<
    "workflow.humanFormDraftSave",
    WorkflowHumanFormDraftSaveRequest,
    WorkflowHumanFormDraftSaveResponse
  >;
  readonly "workflow.humanFormSubmit": MethodDescriptor<
    "workflow.humanFormSubmit",
    WorkflowHumanFormSubmitRequest,
    WorkflowHumanFormSubmitResponse
  >;
  readonly "workflow.fixSessionCreate": MethodDescriptor<
    "workflow.fixSessionCreate",
    WorkflowStepKey,
    WorkflowFixSessionCreateResponse
  >;
}

/** The `workflow.*` methods on one step. */
export const WORKFLOW_STEP_METHOD_DESCRIPTORS: WorkflowStepMethodDescriptors =
  defineMethodDescriptors({
    "workflow.stepRead": {
      method: "workflow.stepRead",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowStepReadRequestSchema,
      responseSchema: WorkflowStepReadResponseSchema,
    },
    "workflow.stepOutputList": {
      method: "workflow.stepOutputList",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowStepOutputListRequestSchema,
      responseSchema: WorkflowStepOutputListResponseSchema,
    },
    "workflow.gateResolve": {
      method: "workflow.gateResolve",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowGateResolveRequestSchema,
      responseSchema: WorkflowGateResolveResponseSchema,
    },
    "workflow.humanFormRead": {
      method: "workflow.humanFormRead",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowStepKeySchema,
      responseSchema: WorkflowHumanFormReadResponseSchema,
    },
    "workflow.humanFormDraftSave": {
      method: "workflow.humanFormDraftSave",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowHumanFormDraftSaveRequestSchema,
      responseSchema: WorkflowHumanFormDraftSaveResponseSchema,
    },
    "workflow.humanFormSubmit": {
      method: "workflow.humanFormSubmit",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowHumanFormSubmitRequestSchema,
      responseSchema: WorkflowHumanFormSubmitResponseSchema,
    },
    "workflow.fixSessionCreate": {
      method: "workflow.fixSessionCreate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowStepKeySchema,
      responseSchema: WorkflowFixSessionCreateResponseSchema,
    },
  });
