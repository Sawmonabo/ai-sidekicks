// The step record every workflow run method and event shares: one execution of one node, with its
// payload references, cost, spent account, question, resolution and review pause, and the key that
// addresses it. A step is addressed by its run, its node, its attempt and which execution of that
// node, because a retry runs a step again and a loop runs one node many times.
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
import { PROVIDER_ACCOUNT_LABEL_MAX_LEN } from "../../../provider/account/label.js";
import {
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
 * A spent provider account as a wait names it: its id, its provider and the label `accountLabel`
 * gives it, the one every surface names an account by, so no account id reaches the screen.
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

const executionIndexSchema = countSchema;

// Which attempt at a step, counted from 1: each retry is a new attempt.
const attemptSchema = z.number().int().positive();

/** The four members that address one step: the run, the node, the attempt and which execution. */
export interface WorkflowStepKey {
  workflowRunId: WorkflowRunId;
  nodeId: WorkflowNodeId;
  attempt: number;
  executionIndex: number;
}
/** The members of {@link WorkflowStepKeySchema}, spread into each request and event on a step. */
export const workflowStepKeyShape: {
  workflowRunId: z.ZodType<WorkflowRunId, WorkflowRunId>;
  nodeId: z.ZodType<WorkflowNodeId, WorkflowNodeId>;
  attempt: z.ZodNumber;
  executionIndex: z.ZodNumber;
} = {
  workflowRunId: WorkflowRunIdSchema,
  nodeId: WorkflowNodeIdSchema,
  attempt: attemptSchema,
  executionIndex: executionIndexSchema,
};
/** Wire schema for {@link WorkflowStepKey}, the whole input of a form read and a fix session. */
export const WorkflowStepKeySchema: z.ZodType<WorkflowStepKey, WorkflowStepKey> = z
  .object(workflowStepKeyShape)
  .strict();

/** The members a step carries whatever its status. */
interface WorkflowStepFields extends WorkflowStepKey {
  source: (WorkflowStepSource | null)[];
  startedAt: string;
  finishedAt?: string | undefined;
  inputRef: WorkflowPayloadRef;
  outputRef: WorkflowPayloadRef;
  logRef: WorkflowPayloadRef;
  cost?: WorkflowCost | undefined;
  error?: WorkflowStepError | undefined;
  advisories?: string[] | undefined;
  resolvedConfiguration?: AgentResolvedConfiguration | undefined;
  /** Present on an approval step of a run that captured its checkout: its pause's snapshot. */
  reviewPause?: WorkflowStepReviewPause | undefined;
  /** Present on an `Execute workflow` step once it started its child run, which it links to. */
  childWorkflowRunId?: WorkflowRunId | undefined;
}

/** A step that waits on nothing names no cause, spent account, instants or question. */
interface WorkflowStepNoWait {
  waitCause?: undefined;
  waitAccount?: undefined;
  resumeAt?: undefined;
  waitDeadlineAt?: undefined;
  question?: undefined;
}

/**
 * What a waiting step waits on, by its cause: a spent account names the account and, where armed,
 * the instant it resumes itself; a wait on a person may carry the instant its `Timeout` gives up,
 * and a chat reply its question; a chain's question carries neither.
 */
type WorkflowStepWait =
  | (Omit<WorkflowStepNoWait, "waitCause" | "waitAccount" | "resumeAt"> & {
      waitCause: Extract<WorkflowWaitCause, "account">;
      /** The spent account the step waits on. */
      waitAccount: WorkflowSpentAccount;
      resumeAt?: string | undefined;
    })
  | (Omit<WorkflowStepNoWait, "waitCause" | "waitDeadlineAt" | "question"> & {
      waitCause: Extract<WorkflowWaitCause, "reply">;
      waitDeadlineAt?: string | undefined;
      /** The question the chat reply answers. */
      question: WorkflowStepQuestion;
    })
  | (Omit<WorkflowStepNoWait, "waitCause" | "waitDeadlineAt"> & {
      waitCause: Extract<WorkflowWaitCause, "approval" | "form">;
      waitDeadlineAt?: string | undefined;
    })
  | (Omit<WorkflowStepNoWait, "waitCause"> & { waitCause: Extract<WorkflowWaitCause, "chain"> });

/**
 * One execution of one node. `executionIndex` is per-run and increasing, so it orders
 * a branching run faithfully; `source` records, per input slot, the edge that actually
 * fed it and which execution of the source produced it (null for a slot nothing fed).
 * Only a waiting step names what it waits on, and only one no longer waiting how a person answered
 * it.
 */
export type WorkflowStep = WorkflowStepFields &
  (
    | (WorkflowStepWait & {
        status: Extract<WorkflowStepStatus, "waiting">;
        processExit?: undefined;
        resolution?: undefined;
      })
    | (WorkflowStepNoWait & {
        status: Extract<WorkflowStepStatus, "failed">;
        /** Present where the step's process ended on its own: its exit and last lines. */
        processExit?: ProcessExit | undefined;
        /** Present once a person has answered this step. */
        resolution?: WorkflowStepResolution | undefined;
      })
    | (WorkflowStepNoWait & {
        status: Exclude<WorkflowStepStatus, "waiting" | "failed">;
        processExit?: undefined;
        /** Present once a person has answered this step. */
        resolution?: WorkflowStepResolution | undefined;
      })
  );
const workflowStepFields = {
  ...workflowStepKeyShape,
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
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.optional(),
  inputRef: WorkflowPayloadRefSchema,
  outputRef: WorkflowPayloadRefSchema,
  logRef: WorkflowPayloadRefSchema,
  cost: WorkflowCostSchema.optional(),
  error: WorkflowStepErrorSchema.optional(),
  advisories: z.array(z.string().min(1)).optional(),
  resolvedConfiguration: AgentResolvedConfigurationSchema.optional(),
  reviewPause: WorkflowStepReviewPauseSchema.optional(),
  childWorkflowRunId: WorkflowRunIdSchema.optional(),
};
const waitingStepFields = {
  ...workflowStepFields,
  status: WorkflowStepStatusSchema.extract(["waiting"]),
};
const answerableStepFields = {
  ...workflowStepFields,
  resolution: WorkflowStepResolutionSchema.optional(),
};

/**
 * Wire schema for {@link WorkflowStep}. A waiting step carries its cause and no other step does;
 * only an account wait resumes itself, and only a wait on a person carries a deadline.
 */
export const WorkflowStepSchema: z.ZodType<WorkflowStep> = z.discriminatedUnion("status", [
  z.discriminatedUnion("waitCause", [
    z
      .object({
        ...waitingStepFields,
        waitCause: WorkflowWaitCauseSchema.extract(["account"]),
        waitAccount: WorkflowSpentAccountSchema,
        resumeAt: isoDateTimeSchema.optional(),
      })
      .strict(),
    z
      .object({
        ...waitingStepFields,
        waitCause: WorkflowWaitCauseSchema.extract(["reply"]),
        waitDeadlineAt: isoDateTimeSchema.optional(),
        question: WorkflowStepQuestionSchema,
      })
      .strict(),
    z
      .object({
        ...waitingStepFields,
        waitCause: WorkflowWaitCauseSchema.extract(["approval", "form"]),
        waitDeadlineAt: isoDateTimeSchema.optional(),
      })
      .strict(),
    z
      .object({ ...waitingStepFields, waitCause: WorkflowWaitCauseSchema.extract(["chain"]) })
      .strict(),
  ]),
  z
    .object({
      ...answerableStepFields,
      status: WorkflowStepStatusSchema.extract(["failed"]),
      processExit: ProcessExitSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...answerableStepFields,
      status: WorkflowStepStatusSchema.exclude(["waiting", "failed"]),
    })
    .strict(),
]);
