// One step of a workflow run: the step record every run method and event shares, reading a step's
// input, output or log, the agent and human steps' saved outputs, answering an approval step or a
// chain's question, loading, saving and submitting a waiting form, and opening a fix session on a
// failed step, with the refusals, the step events and the method table. A step is addressed by its
// run, its node and which execution of that node, because a loop runs one node many times. A
// descriptor registers nothing.
import { z } from "zod";

import {
  AgentResolvedConfigurationSchema,
  type AgentResolvedConfiguration,
} from "../../agent/definition.js";
import { ApprovalDecisionSchema, type ApprovalDecision } from "../../approval.js";
import { uuidTextFormSchema } from "../../internal/branded.js";
import { jsonUtf8ByteLength } from "../../jsonrpc/message.js";
import { QuestionIdSchema, type QuestionId } from "../../question.js";
import { ProcessExitSchema, type ProcessExit } from "../../run/control.js";
import { UsdMicrosSchema } from "../../session/cost.js";
import { defineMethodDescriptors, type MethodDescriptor } from "../../method-descriptor.js";
import {
  PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN,
  ProviderAccountIdSchema,
  type ProviderAccountId,
} from "../../provider/account/record.js";
import { ProviderNameSchema, type ProviderName } from "../../provider/name.js";
import { ArtifactIdSchema, type ArtifactId } from "../../artifacts/id.js";
import { FILE_PATH_MAX_LEN, wireFreeFormString } from "../../free-form-string.js";
import { SessionIdSchema, type SessionId } from "../../session/id.js";
import { DeviceIdSchema, type DeviceId } from "../../trust-statement.js";
import {
  WorkflowDefinitionIdSchema,
  WorkflowItemSchema,
  WorkflowNodeIdSchema,
  WorkflowStepErrorSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowItem,
  type WorkflowNodeId,
  type WorkflowStepError,
} from "../definition/document.js";
import { WorkflowParamSpecSchema, type WorkflowParamSpec } from "../kind.js";
import {
  WorkflowRunIdSchema,
  WorkflowStepStatusSchema,
  WorkflowWaitCauseSchema,
  type WorkflowRunId,
  type WorkflowStepStatus,
  type WorkflowWaitCause,
} from "./status.js";
import { countSchema, isoDateTimeSchema } from "../../internal/wire-scalars.js";

// The step record

/**
 * The most bytes a step payload is carried inline, counted on its JSON encoding. A
 * larger payload is stored as an artifact and referenced, and the panel says which.
 */
export const WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP: number = 64 * 1024;

/**
 * A step payload by reference: inline items up to the cap, an artifact above it, which names how
 * many items it holds so a count is drawn without reading it. Step data is kept until the person
 * deletes the run or its session; nothing expires it on its own.
 */
export type WorkflowPayloadRef =
  | { kind: "inline"; items: WorkflowItem[] }
  | { kind: "artifact"; artifactId: ArtifactId; sizeBytes: number; itemCount: number };
/** Wire schema for {@link WorkflowPayloadRef}; an inline payload over the cap is refused. */
export const WorkflowPayloadRefSchema: z.ZodType<WorkflowPayloadRef> = z.discriminatedUnion(
  "kind",
  [
    z
      .object({ kind: z.literal("inline"), items: z.array(WorkflowItemSchema) })
      .strict()
      .refine(
        (payload) => jsonUtf8ByteLength(payload.items) <= WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP,
        {
          path: ["items"],
          message:
            `An inline payload is at most ${WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP} bytes; ` +
            "a larger one is an artifact.",
        },
      ),
    z
      .object({
        kind: z.literal("artifact"),
        artifactId: ArtifactIdSchema,
        sizeBytes: z.number().int().positive(),
        itemCount: countSchema,
      })
      .strict(),
  ],
);

/**
 * What a step or a run cost, in whole micro-dollars, and the account that paid.
 * Present only where a provider was billed; a step that spent nothing carries none.
 */
export interface WorkflowCost {
  usdMicros: number;
  providerAccountId: ProviderAccountId;
}
/** Wire schema for {@link WorkflowCost}. */
export const WorkflowCostSchema: z.ZodType<WorkflowCost> = z
  .object({
    usdMicros: UsdMicrosSchema,
    providerAccountId: ProviderAccountIdSchema,
  })
  .strict();

/**
 * A spent provider account as a wait names it: its id, its provider and the one label every
 * surface names an account by, so no account id reaches the screen.
 */
export interface WorkflowSpentAccount {
  providerAccountId: ProviderAccountId;
  provider: ProviderName;
  label: string;
}
/** Wire schema for {@link WorkflowSpentAccount}. */
export const WorkflowSpentAccountSchema: z.ZodType<WorkflowSpentAccount> = z
  .object({
    providerAccountId: ProviderAccountIdSchema,
    provider: ProviderNameSchema,
    label: wireFreeFormString(PROVIDER_ACCOUNT_DISPLAY_LABEL_MAX_LEN, "WorkflowSpentAccount.label"),
  })
  .strict();

/** One input slot's feed: the node, its output and which execution of it fed the slot. */
export interface WorkflowStepSource {
  nodeId: WorkflowNodeId;
  outputIndex: number;
  executionIndex: number;
}

/**
 * The question a step waiting for a chat reply holds. `questionId` is the record
 * `question.resolve` answers and `waitId` the wait it settles, so the step panel and the session's
 * question card answer one wait and the first answer through either settles both.
 */
export interface WorkflowStepQuestion {
  questionId: QuestionId;
  waitId: string;
  prompt: string;
}
/** Wire schema for {@link WorkflowStepQuestion}. */
export const WorkflowStepQuestionSchema: z.ZodType<WorkflowStepQuestion> = z
  .object({
    questionId: QuestionIdSchema,
    waitId: uuidTextFormSchema,
    prompt: z.string().min(1),
  })
  .strict();

/**
 * How a person answered a step that waited on them. `declined` is the `Decline` on a command
 * step's own approval card, which fails that step.
 */
export const WORKFLOW_STEP_RESOLUTIONS = ["approved", "rejected", "answered", "declined"] as const;
/** One of {@link WORKFLOW_STEP_RESOLUTIONS}. */
export type WorkflowStepResolutionKind = (typeof WORKFLOW_STEP_RESOLUTIONS)[number];

/**
 * The record of how a person answered a step and when, kept on the step so the receipt it earns,
 * `Approved at 2:14 PM`, reads the same after a reload.
 */
export interface WorkflowStepResolution {
  kind: WorkflowStepResolutionKind;
  at: string;
}
/** Wire schema for {@link WorkflowStepResolution}. */
export const WorkflowStepResolutionSchema: z.ZodType<WorkflowStepResolution> = z
  .object({ kind: z.enum(WORKFLOW_STEP_RESOLUTIONS), at: isoDateTimeSchema })
  .strict();

/**
 * The snapshot an approval pause took. Pinned, it names which execution of the run (each
 * re-execution opens the next epoch) and which of its approval pauses, counted from 1, and Review
 * opens on what the run changed from that epoch's start to this pause. Missing, it carries the
 * daemon's words for why the snapshot could not be taken, and `Open in Review` stays in place
 * saying so.
 */
export type WorkflowStepReviewPause =
  | { state: "pinned"; epoch: number; pauseNumber: number }
  | { state: "missing"; reason: string };
/** Wire schema for {@link WorkflowStepReviewPause}. */
export const WorkflowStepReviewPauseSchema: z.ZodType<WorkflowStepReviewPause> =
  z.discriminatedUnion("state", [
    z
      .object({
        state: z.literal("pinned"),
        epoch: countSchema,
        pauseNumber: z.number().int().positive(),
      })
      .strict(),
    z.object({ state: z.literal("missing"), reason: z.string().min(1) }).strict(),
  ]);

/**
 * One execution of one node. `executionIndex` is per-run and increasing, so it orders
 * a branching run faithfully; `source` records, per input slot, the edge that actually
 * fed it and which execution of the source produced it (null for a slot nothing fed).
 * A waiting step names its cause and, where armed, the instant it resumes itself and
 * the instant its `Timeout` gives up.
 */
export interface WorkflowStep {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  attempt: number;
  executionIndex: number;
  source: (WorkflowStepSource | null)[];
  status: WorkflowStepStatus;
  waitCause?: WorkflowWaitCause | undefined;
  /** Present exactly on a step waiting on `account`: the spent account it waits on. */
  waitAccount?: WorkflowSpentAccount | undefined;
  resumeAt?: string | undefined;
  waitDeadlineAt?: string | undefined;
  startedAt: string;
  finishedAt?: string | undefined;
  inputRef: WorkflowPayloadRef;
  outputRef: WorkflowPayloadRef;
  logRef: WorkflowPayloadRef;
  cost?: WorkflowCost | undefined;
  error?: WorkflowStepError | undefined;
  /** Present on a failed step whose process ended on its own: its exit and last lines. */
  processExit?: ProcessExit | undefined;
  advisories?: string[] | undefined;
  resolvedConfiguration?: AgentResolvedConfiguration | undefined;
  /** Present exactly on a step waiting for a chat reply. */
  question?: WorkflowStepQuestion | undefined;
  /** Present once a person has answered this step. */
  resolution?: WorkflowStepResolution | undefined;
  /** Present on an approval step of a run that captured its checkout: its pause's snapshot. */
  reviewPause?: WorkflowStepReviewPause | undefined;
  /** Present on an `Execute workflow` step once it started its child run, which it links to. */
  childWorkflowRunId?: WorkflowRunId | undefined;
}
/**
 * Wire schema for {@link WorkflowStep}. A waiting step carries its cause and no other
 * step does; the two instants appear only on a waiting step.
 */
export const WorkflowStepSchema: z.ZodType<WorkflowStep> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    nodeId: WorkflowNodeIdSchema,
    attempt: z.number().int().positive(),
    executionIndex: countSchema,
    source: z.array(
      z
        .object({
          nodeId: WorkflowNodeIdSchema,
          outputIndex: countSchema,
          executionIndex: countSchema,
        })
        .strict()
        .nullable(),
    ),
    status: WorkflowStepStatusSchema,
    waitCause: WorkflowWaitCauseSchema.optional(),
    waitAccount: WorkflowSpentAccountSchema.optional(),
    resumeAt: isoDateTimeSchema.optional(),
    waitDeadlineAt: isoDateTimeSchema.optional(),
    startedAt: isoDateTimeSchema,
    finishedAt: isoDateTimeSchema.optional(),
    inputRef: WorkflowPayloadRefSchema,
    outputRef: WorkflowPayloadRefSchema,
    logRef: WorkflowPayloadRefSchema,
    cost: WorkflowCostSchema.optional(),
    error: WorkflowStepErrorSchema.optional(),
    processExit: ProcessExitSchema.optional(),
    advisories: z.array(z.string().min(1)).optional(),
    resolvedConfiguration: AgentResolvedConfigurationSchema.optional(),
    question: WorkflowStepQuestionSchema.optional(),
    resolution: WorkflowStepResolutionSchema.optional(),
    reviewPause: WorkflowStepReviewPauseSchema.optional(),
    childWorkflowRunId: WorkflowRunIdSchema.optional(),
  })
  .strict()
  .refine((step) => step.processExit === undefined || step.status === "failed", {
    path: ["processExit"],
    message: "Only a failed step carries how its process exited.",
  })
  .refine((step) => (step.status === "waiting") === (step.waitCause !== undefined), {
    path: ["waitCause"],
    message: "A waiting step names its cause, and no other step carries one.",
  })
  .refine(
    (step) =>
      (step.waitAccount !== undefined) ===
      (step.status === "waiting" && step.waitCause === "account"),
    { path: ["waitAccount"], message: "A step waiting on a spent account names that account." },
  )
  .refine(
    (step) =>
      step.status === "waiting" ||
      (step.resumeAt === undefined && step.waitDeadlineAt === undefined),
    { path: ["resumeAt"], message: "Only a waiting step carries a resume or a deadline instant." },
  )
  .refine(
    (step) =>
      (step.question !== undefined) === (step.status === "waiting" && step.waitCause === "reply"),
    { path: ["question"], message: "A step waiting for a reply carries its question." },
  )
  .refine((step) => step.resolution === undefined || step.status !== "waiting", {
    path: ["resolution"],
    message: "A step a person has answered is no longer waiting.",
  });

const executionIndexSchema = countSchema;

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
    ...workflowStepKeyFields,
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
 *
 * @consumedBy the handler that returns the `workflow.step_not_waiting` error
 */
export const WORKFLOW_STEP_NOT_WAITING_CODE = "workflow.step_not_waiting" as const;

/**
 * A form draft save or a form submit carrying a revision that is no longer current.
 *
 * @consumedBy the handler that returns the `workflow.revision_stale` error
 */
export const WORKFLOW_REVISION_STALE_CODE = "workflow.revision_stale" as const;

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
