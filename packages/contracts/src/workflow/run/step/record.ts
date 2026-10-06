// The step record every workflow run method and event shares: one execution of one node, with its
// payload references, cost, spent account, question, resolution and review pause, and the key that
// addresses it. A step is addressed by its run, its node and which execution of that node, because
// a loop runs one node many times.
import { z } from "zod";

import {
  AgentResolvedConfigurationSchema,
  type AgentResolvedConfiguration,
} from "../../../agent/definition.js";
import { uuidTextFormSchema } from "../../../internal/branded.js";
import { jsonUtf8ByteLength } from "../../../jsonrpc/message.js";
import { QuestionIdSchema, type QuestionId } from "../../../question.js";
import { ProcessExitSchema, type ProcessExit } from "../../../run/control.js";
import { UsdMicrosSchema } from "../../../session/cost.js";
import {
  PROVIDER_ACCOUNT_LABEL_MAX_LEN,
  ProviderAccountIdSchema,
  type ProviderAccountId,
} from "../../../provider/account/record.js";
import { ProviderNameSchema, type ProviderName } from "../../../provider/name.js";
import { ArtifactIdSchema, type ArtifactId } from "../../../artifacts/id.js";
import { wireFreeFormString } from "../../../free-form-string.js";
import {
  WorkflowItemSchema,
  WorkflowNodeIdSchema,
  WorkflowStepErrorSchema,
  type WorkflowItem,
  type WorkflowNodeId,
  type WorkflowStepError,
} from "../../definition/document.js";
import {
  WorkflowStepStatusSchema,
  WorkflowWaitCauseSchema,
  type WorkflowStepStatus,
  type WorkflowWaitCause,
} from "../status.js";
import { WorkflowRunIdSchema, type WorkflowRunId } from "../id.js";
import { WorkflowRunEpochSchema, WorkflowRunPauseNumberSchema } from "../snapshot.js";
import { countSchema, isoDateTimeSchema } from "../../../internal/wire-scalars.js";

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
 * surface names an account by, so no account id reaches the screen. The label is a token or
 * API-key account's typed name beside its credential's kind, else its provider-reported identity.
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
    label: wireFreeFormString(PROVIDER_ACCOUNT_LABEL_MAX_LEN, "WorkflowSpentAccount.label"),
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
export const WORKFLOW_STEP_RESOLUTION_KINDS = [
  "approved",
  "rejected",
  "answered",
  "declined",
] as const;
/** One of {@link WORKFLOW_STEP_RESOLUTION_KINDS}. */
export type WorkflowStepResolutionKind = (typeof WORKFLOW_STEP_RESOLUTION_KINDS)[number];

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
  .object({ kind: z.enum(WORKFLOW_STEP_RESOLUTION_KINDS), at: isoDateTimeSchema })
  .strict();

/**
 * The snapshot an approval pause took, which Review opens on: pinned to an execution of the run
 * and one of its pauses, or missing with the daemon's words for why it could not be taken.
 */
export type WorkflowStepReviewPause =
  | {
      state: "pinned";
      /** Which execution of the run; each re-execution opens the next epoch. */
      epoch: number;
      /** Which of that execution's approval pauses, counted from 1. */
      pauseNumber: number;
    }
  | {
      state: "missing";
      /** Why the snapshot could not be taken; `Open in Review` stays in place saying so. */
      reason: string;
    };
/** Wire schema for {@link WorkflowStepReviewPause}. */
export const WorkflowStepReviewPauseSchema: z.ZodType<WorkflowStepReviewPause> =
  z.discriminatedUnion("state", [
    z
      .object({
        state: z.literal("pinned"),
        epoch: WorkflowRunEpochSchema,
        pauseNumber: WorkflowRunPauseNumberSchema,
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
 * Wire schema for {@link WorkflowStep}. A waiting step carries its cause and no other step does;
 * only an account wait resumes itself, and only a wait on a person carries a deadline.
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
      step.resumeAt === undefined || (step.status === "waiting" && step.waitCause === "account"),
    { path: ["resumeAt"], message: "Only a step waiting on a spent account resumes itself." },
  )
  .refine(
    (step) =>
      step.waitDeadlineAt === undefined ||
      (step.status === "waiting" &&
        (step.waitCause === "approval" || step.waitCause === "form" || step.waitCause === "reply")),
    {
      path: ["waitDeadlineAt"],
      message: "Only a step waiting on a person's approval, form or reply carries a deadline.",
    },
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
/** The members of {@link WorkflowStepKeySchema}, spread into each request and event on a step. */
export const workflowStepKeyShape: {
  workflowRunId: z.ZodType<WorkflowRunId, WorkflowRunId>;
  nodeId: z.ZodType<WorkflowNodeId, WorkflowNodeId>;
  executionIndex: z.ZodNumber;
} = {
  workflowRunId: WorkflowRunIdSchema,
  nodeId: WorkflowNodeIdSchema,
  executionIndex: executionIndexSchema,
};
/** Wire schema for {@link WorkflowStepKey}, the whole input of a step read. */
export const WorkflowStepKeySchema: z.ZodType<WorkflowStepKey, WorkflowStepKey> = z
  .object(workflowStepKeyShape)
  .strict();
