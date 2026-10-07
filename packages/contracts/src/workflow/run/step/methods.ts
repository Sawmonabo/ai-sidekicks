// The workflow.* methods on one step: reading its input, output or log, storing what one of its
// panel's tabs holds as an artifact, the agent and human steps' saved outputs, answering an
// approval step or a chain's question, loading, saving and submitting a waiting form, and opening a
// fix session on a failed step, with their refusals and the method table. A descriptor registers
// nothing.
import { z } from "zod";
import {
  WorkflowPayloadRefSchema,
  workflowStepKeyShape,
  WorkflowStepKeySchema,
  type WorkflowPayloadRef,
  type WorkflowStepKey,
} from "./record.js";

import { ApprovalDecisionSchema, type ApprovalDecision } from "../../../approval.js";
import { defineMethodDescriptors, type MethodDescriptor } from "../../../method-descriptor.js";
import { ArtifactIdSchema, type ArtifactId } from "../../../artifacts/id.js";
import { FILE_PATH_MAX_LEN, wireFreeFormString } from "../../../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../../../session/id.js";
import { WorkflowNodeIdSchema, type WorkflowNodeId } from "../../definition/document.js";
import { WorkflowParamSpecSchema, type WorkflowParamSpec } from "../../kind.js";
import { WorkflowRunIdSchema, type WorkflowRunId } from "../id.js";
import { WorkflowStepStatusSchema, type WorkflowStepStatus } from "../status.js";
import { countSchema, isoDateTimeSchema } from "../../../internal/wire-scalars.js";

// workflow.stepRead

/**
 * A step panel's tabs, in the order the panel shows them: its three payloads, then its cost and
 * its error.
 */
export const WORKFLOW_STEP_TABS = ["input", "output", "log", "cost", "error"] as const;
const workflowStepTabEnum = z.enum(WORKFLOW_STEP_TABS);

/** Which of a step's three payloads a read returns. */
export type WorkflowStepPayloadKind = Extract<
  (typeof WORKFLOW_STEP_TABS)[number],
  "input" | "output" | "log"
>;
const WorkflowStepPayloadKindSchema = workflowStepTabEnum.extract(["input", "output", "log"]);

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
    ...workflowStepKeyShape,
    which: WorkflowStepPayloadKindSchema,
    limit: z.number().int().positive().optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * The `workflow.stepRead` result: the payload inline or as an artifact reference, with a
 * cursor while more remains.
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
    executionIndex: workflowStepKeyShape.executionIndex,
    which: WorkflowStepPayloadKindSchema,
    payload: WorkflowPayloadRefSchema,
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

// workflow.stepTabArtifactCreate

/**
 * The `workflow.stepTabArtifactCreate` input: the step-panel tab whose content is stored as an
 * artifact of the run's session, for the tab's `Open as artifact`: an inline input, output or log,
 * the step's cost or its error.
 */
export interface WorkflowStepTabArtifactCreateRequest extends WorkflowStepKey {
  which: (typeof WORKFLOW_STEP_TABS)[number];
}
/** Wire schema for {@link WorkflowStepTabArtifactCreateRequest}. */
export const WorkflowStepTabArtifactCreateRequestSchema: z.ZodType<
  WorkflowStepTabArtifactCreateRequest,
  WorkflowStepTabArtifactCreateRequest
> = z.object({ ...workflowStepKeyShape, which: workflowStepTabEnum }).strict();

/** The `workflow.stepTabArtifactCreate` result: the stored artifact's id. */
export interface WorkflowStepTabArtifactCreateResponse {
  artifactId: ArtifactId;
}
/** Wire schema for {@link WorkflowStepTabArtifactCreateResponse}. */
export const WorkflowStepTabArtifactCreateResponseSchema: z.ZodType<WorkflowStepTabArtifactCreateResponse> =
  z.object({ artifactId: ArtifactIdSchema }).strict();

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
        producedAt: isoDateTimeSchema,
      })
      .strict(),
    z
      .object({
        valueKind: z.literal("artifact_ref"),
        artifactId: ArtifactIdSchema,
        summary: z.string(),
        producedAt: isoDateTimeSchema,
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
  status: Extract<WorkflowStepStatus, "succeeded" | "failed">;
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
          executionIndex: workflowStepKeyShape.executionIndex,
          status: WorkflowStepStatusSchema.extract(["succeeded", "failed"]),
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
    decidedAt: isoDateTimeSchema,
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
    formRevision: countSchema,
    draft: z
      .object({
        formState: z.record(z.string(), z.unknown()),
        revision: z.number().int().positive(),
        savedAt: isoDateTimeSchema,
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
    ...workflowStepKeyShape,
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
      savedAt: isoDateTimeSchema,
    })
    .strict();

/**
 * One `path` field's answer: the field, by its dotted place in the form (`parent.child`, or
 * `parent.0.child` inside a repeating collection), and the path picked with the platform's own
 * chooser. It sits beside `fields`, never in it, so the page's file token for the path is found
 * at one fixed member whatever the form holds; a `json` answer can hold any key.
 */
export interface WorkflowHumanFormPathAnswer {
  field: string;
  path: string;
}

/**
 * The `workflow.humanFormSubmit` input. `expectedRevision` is the form's revision when
 * it was read. A submit carrying a stale revision is refused; it never overwrites an
 * answer that was already accepted. Every answer but a `path` field's is in `fields`; a
 * `path` field's is in `paths`, at most once per field. A form has no artifact field.
 */
export interface WorkflowHumanFormSubmitRequest extends WorkflowStepKey {
  fields: Record<string, unknown>;
  paths?: WorkflowHumanFormPathAnswer[] | undefined;
  expectedRevision: number;
}
/** Wire schema for {@link WorkflowHumanFormSubmitRequest}. */
export const WorkflowHumanFormSubmitRequestSchema: z.ZodType<
  WorkflowHumanFormSubmitRequest,
  WorkflowHumanFormSubmitRequest
> = z
  .object({
    ...workflowStepKeyShape,
    fields: z.record(z.string(), z.unknown()),
    paths: z
      .array(
        z
          .object({
            field: z.string().min(1),
            path: wireFreeFormString(FILE_PATH_MAX_LEN, "WorkflowHumanFormPathAnswer.path"),
          })
          .strict(),
      )
      .refine((answers) => new Set(answers.map((answer) => answer.field)).size === answers.length, {
        message: "A path field is answered at most once.",
      })
      .optional(),
    expectedRevision: countSchema,
  })
  .strict();

/** The `workflow.humanFormSubmit` result: when the answer was accepted. */
export interface WorkflowHumanFormSubmitResponse {
  submittedAt: string;
}
/** Wire schema for {@link WorkflowHumanFormSubmitResponse}. */
export const WorkflowHumanFormSubmitResponseSchema: z.ZodType<WorkflowHumanFormSubmitResponse> = z
  .object({ submittedAt: isoDateTimeSchema })
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
 * has run; also a chain's question answered once it is no longer open.
 */
export const WORKFLOW_STEP_NOT_WAITING_CODE = "workflow.step_not_waiting" as const;

/** A form draft save or a form submit carrying a revision that is no longer current. */
export const WORKFLOW_REVISION_STALE_CODE = "workflow.revision_stale" as const;

/** The `workflow.*` methods on one step, keyed by name. */
export interface WorkflowStepMethodDescriptors {
  readonly "workflow.stepRead": MethodDescriptor<
    "workflow.stepRead",
    WorkflowStepReadRequest,
    WorkflowStepReadResponse
  >;
  readonly "workflow.stepTabArtifactCreate": MethodDescriptor<
    "workflow.stepTabArtifactCreate",
    WorkflowStepTabArtifactCreateRequest,
    WorkflowStepTabArtifactCreateResponse
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

/**
 * The `workflow.*` methods on one step.
 */
export const WORKFLOW_STEP_METHOD_DESCRIPTORS: WorkflowStepMethodDescriptors =
  defineMethodDescriptors({
    "workflow.stepRead": {
      method: "workflow.stepRead",
      procedureType: "query",
      mutating: false,
      requestSchema: WorkflowStepReadRequestSchema,
      responseSchema: WorkflowStepReadResponseSchema,
    },
    "workflow.stepTabArtifactCreate": {
      method: "workflow.stepTabArtifactCreate",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowStepTabArtifactCreateRequestSchema,
      responseSchema: WorkflowStepTabArtifactCreateResponseSchema,
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
