// Workflow runs: the run id, the statuses and the step record every run method and event shares,
// and the codes a failed step carries. A node's id, an item and a step's error are the workflow
// document's, in `workflow-definition.ts`. The run methods build on this file, and it imports none
// of them: `workflow-run-control.ts` acts on a run, `workflow-run-records.ts` reads, lists and
// keeps run records, and `workflow-run-step.ts` covers one step's data, approval and form.
import { z } from "zod";

import {
  AgentIdSchema,
  AgentResolvedConfigurationSchema,
  type AgentId,
  type AgentResolvedConfiguration,
} from "./agent-definition.js";
import { brandedUuidIdSchema, uuidTextFormSchema } from "./internal/branded.js";
import { jsonUtf8ByteLength } from "./jsonrpc.js";
import {
  ProviderAccountIdSchema,
  ProviderNameSchema,
  type ProviderAccountId,
  type ProviderName,
} from "./provider-account.js";
import { ArtifactIdSchema, type ArtifactId } from "./provider-driver.js";
import { QuestionIdSchema, type QuestionId } from "./question.js";
import { ProcessExitSchema, type ProcessExit } from "./run-control.js";
import { UsdMicrosSchema } from "./session-cost.js";
import { EventCursorSchema, SessionIdSchema, type EventCursor, type SessionId } from "./session.js";
import { DeviceIdSchema, type DeviceId } from "./trust-statement.js";
import {
  WorkflowItemSchema,
  WorkflowNodeIdSchema,
  WorkflowStepErrorSchema,
  type WorkflowItem,
  type WorkflowNodeId,
  type WorkflowStepError,
} from "./workflow-definition.js";
import { countSchema, isoDateTimeSchema } from "./internal/wire-scalars.js";

// Ids

/** A workflow run's id: a UUID the daemon mints; a client never builds one. */
export type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };
/** Wire schema for {@link WorkflowRunId}. */
export const WorkflowRunIdSchema: z.ZodType<WorkflowRunId, WorkflowRunId> =
  brandedUuidIdSchema<WorkflowRunId>("WorkflowRunId");

// Closed vocabularies

/**
 * A run's status; no screen shows any other. `waiting` covers a run held by a
 * person, a chain's question or a spent provider account; it is never swept to
 * `crashed` when the daemon starts and never pruned, so a waiting run survives a restart.
 */
export const WORKFLOW_RUN_STATUSES = [
  "new",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "crashed",
] as const;
/** One of {@link WORKFLOW_RUN_STATUSES}. */
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];
/** Wire schema for {@link WorkflowRunStatus}. */
export const WorkflowRunStatusSchema: z.ZodType<WorkflowRunStatus, WorkflowRunStatus> =
  z.enum(WORKFLOW_RUN_STATUSES);

/**
 * The status of one step, meaning one execution of one node. `waiting` is a step held
 * for a person, a chain's question or a spent account; `waiting-memory` is a step the
 * memory gate has not started yet, which needs nobody. `canceled` is a step that was
 * running or waiting when its run ended failed or canceled.
 */
export const WORKFLOW_STEP_STATUSES = [
  "pending",
  "running",
  "waiting",
  "waiting-memory",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
] as const;
/** One of {@link WORKFLOW_STEP_STATUSES}. */
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];
/** Wire schema for {@link WorkflowStepStatus}. */
export const WorkflowStepStatusSchema: z.ZodType<WorkflowStepStatus, WorkflowStepStatus> =
  z.enum(WORKFLOW_STEP_STATUSES);

/**
 * What a waiting step waits on: a person's approval, form or chat reply, its chain's
 * question, or a spent provider account. Only the account wait needs nobody.
 */
export const WORKFLOW_WAIT_CAUSES = ["approval", "form", "reply", "account", "chain"] as const;
/** One of {@link WORKFLOW_WAIT_CAUSES}. */
export type WorkflowWaitCause = (typeof WORKFLOW_WAIT_CAUSES)[number];
/** Wire schema for {@link WorkflowWaitCause}. */
export const WorkflowWaitCauseSchema: z.ZodType<WorkflowWaitCause, WorkflowWaitCause> =
  z.enum(WORKFLOW_WAIT_CAUSES);

/** How a run was started, which is a different question from who started it. */
export const WORKFLOW_RUN_MODES = [
  "manual",
  "trigger",
  "webhook",
  "chat",
  "agent",
  "retry",
  "sub-workflow",
] as const;
/** One of {@link WORKFLOW_RUN_MODES}. */
export type WorkflowRunMode = (typeof WORKFLOW_RUN_MODES)[number];
/** Wire schema for {@link WorkflowRunMode}. */
export const WorkflowRunModeSchema: z.ZodType<WorkflowRunMode, WorkflowRunMode> =
  z.enum(WORKFLOW_RUN_MODES);

/**
 * The kind of trigger node that started a run, which the runs table's trigger column and filter
 * read. A retry keeps its source run's kind; a mode cannot carry this, because `trigger` covers a
 * schedule, a file event, a session event and another workflow failing alike.
 */
export const WORKFLOW_TRIGGER_KINDS = [
  "trigger.manual",
  "trigger.schedule",
  "trigger.file-watch",
  "trigger.webhook",
  "trigger.session-event",
  "trigger.chat",
  "trigger.sub-workflow",
  "trigger.error",
] as const;
/** One of {@link WORKFLOW_TRIGGER_KINDS}. */
export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_KINDS)[number];
/** Wire schema for {@link WorkflowTriggerKind}. */
export const WorkflowTriggerKindSchema: z.ZodType<WorkflowTriggerKind, WorkflowTriggerKind> =
  z.enum(WORKFLOW_TRIGGER_KINDS);

/**
 * Who or what started a run, as its row and its header name it. A person's start records the
 * device of the connection that made it, never a person; a chat start carries the message it
 * came from, so the run links back to that message.
 */
export type WorkflowStartedBy =
  | { kind: "user"; deviceId: DeviceId }
  | { kind: "schedule" }
  | { kind: "chat"; sessionId: SessionId; messageAnchorCursor?: EventCursor | undefined }
  | { kind: "agent"; agentId: AgentId }
  | { kind: "webhook" }
  | { kind: "fileEvent" }
  | { kind: "parentWorkflow"; parentWorkflowRunId: WorkflowRunId };
/** Wire schema for {@link WorkflowStartedBy}. */
export const WorkflowStartedBySchema: z.ZodType<WorkflowStartedBy> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), deviceId: DeviceIdSchema }).strict(),
  z.object({ kind: z.literal("schedule") }).strict(),
  z
    .object({
      kind: z.literal("chat"),
      sessionId: SessionIdSchema,
      messageAnchorCursor: EventCursorSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("agent"), agentId: AgentIdSchema }).strict(),
  z.object({ kind: z.literal("webhook") }).strict(),
  z.object({ kind: z.literal("fileEvent") }).strict(),
  z
    .object({ kind: z.literal("parentWorkflow"), parentWorkflowRunId: WorkflowRunIdSchema })
    .strict(),
]);

// Step data

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

/** One input slot's feed: the node, its output and which execution of it fed the slot. */
export interface WorkflowStepSource {
  nodeId: WorkflowNodeId;
  outputIndex: number;
  executionIndex: number;
}

/**
 * The question a step waiting for a chat reply holds. `questionId` is the record
 * `question.resolve` answers and `waitId` the wait it settles, so the step panel and the session's
 * question card are two doors onto one wait and the first answer through either settles both.
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

// Cancel reasons

/**
 * The most bytes a cancellation reason may take, counted as UTF-8 bytes of its JSON encoding
 * (quotes and escapes included) rather than its length, so the same sentence is not refused sooner
 * in one script than in another.
 */
export const WORKFLOW_CANCEL_REASON_BYTE_CAP: number = 8 * 1024;

/**
 * A cancellation's reason as the person typed it, within the byte cap. It is recorded
 * on the run and its canceled event and never reaches a step's output or anything an
 * agent reads.
 */
export const WorkflowCancelReasonSchema: z.ZodType<string, string> = z
  .string()
  .min(1)
  .refine((reason) => jsonUtf8ByteLength(reason) <= WORKFLOW_CANCEL_REASON_BYTE_CAP, {
    message: `reason must be at most ${WORKFLOW_CANCEL_REASON_BYTE_CAP} bytes as JSON.`,
  });

// Refusals every run method shares

/**
 * A workflow definition or run that does not exist.
 */
export const WORKFLOW_NOT_FOUND_CODE = "workflow.not_found" as const;

// Step failures: each rides the failed step's error and its failed event

/**
 * A step cut by a time limit: its own `Timeout`, or the run's cap.
 */
export const WORKFLOW_STEP_TIMED_OUT_CODE = "workflow.step_timed_out" as const;
/** Which limit cut the step. */
export const WORKFLOW_STEP_TIMED_OUT_CAUSES = ["step_timeout", "run_cap"] as const;
/** One of {@link WORKFLOW_STEP_TIMED_OUT_CAUSES}. */
export type WorkflowStepTimedOutCause = (typeof WORKFLOW_STEP_TIMED_OUT_CAUSES)[number];
/** The time-limit failure's details: which limit, and the limit itself in milliseconds. */
export interface WorkflowStepTimedOutDetails {
  cause: WorkflowStepTimedOutCause;
  limitMs: number;
}
/**
 * Wire schema for {@link WorkflowStepTimedOutDetails}.
 *
 * @consumedBy the handler that returns the `workflow.step_timed_out` error
 */
export const WorkflowStepTimedOutDetailsSchema: z.ZodType<WorkflowStepTimedOutDetails> = z
  .object({
    cause: z.enum(WORKFLOW_STEP_TIMED_OUT_CAUSES),
    limitMs: z.number().int().positive(),
  })
  .strict();

/**
 * A quick step's or an expression's thread that ended without an answer.
 */
export const WORKFLOW_STEP_THREAD_FAILED_CODE = "workflow.step_thread_failed" as const;
/**
 * Why the thread ended: its host ran out of heap, it was not running 5 s after its start, or it
 * exited without an answer.
 */
export const WORKFLOW_STEP_THREAD_FAILED_REASONS = [
  "out_of_memory",
  "start_timeout",
  "exited",
] as const;
/** One of {@link WORKFLOW_STEP_THREAD_FAILED_REASONS}. */
export type WorkflowStepThreadFailedReason = (typeof WORKFLOW_STEP_THREAD_FAILED_REASONS)[number];
/** The thread failure's details: why the thread ended. */
export interface WorkflowStepThreadFailedDetails {
  reason: WorkflowStepThreadFailedReason;
}
/**
 * Wire schema for {@link WorkflowStepThreadFailedDetails}.
 *
 * @consumedBy the handler that returns the `workflow.step_thread_failed` error
 */
export const WorkflowStepThreadFailedDetailsSchema: z.ZodType<WorkflowStepThreadFailedDetails> = z
  .object({ reason: z.enum(WORKFLOW_STEP_THREAD_FAILED_REASONS) })
  .strict();

/**
 * A full-tier Code step or a sandboxed shell step whose provider sandbox did not start.
 * The step never runs unprotected instead.
 */
export const WORKFLOW_SANDBOX_UNAVAILABLE_CODE = "workflow.sandbox_unavailable" as const;
/** The sandbox failure's details: whose sandbox, and its wrapper's own error. */
export interface WorkflowSandboxUnavailableDetails {
  provider: ProviderName;
  detail: string;
}
/**
 * Wire schema for {@link WorkflowSandboxUnavailableDetails}.
 *
 * @consumedBy the handler that returns the `workflow.sandbox_unavailable` error
 */
export const WorkflowSandboxUnavailableDetailsSchema: z.ZodType<WorkflowSandboxUnavailableDetails> =
  z.object({ provider: ProviderNameSchema, detail: z.string().min(1) }).strict();

/**
 * A full-tier Code step whose package install did not finish.
 *
 * @consumedBy the handler that returns the `workflow.code_install_failed` error
 */
export const WORKFLOW_CODE_INSTALL_FAILED_CODE = "workflow.code_install_failed" as const;
/**
 * Why the install failed: too little disk to hold it, or any other install error,
 * a stale lock included.
 */
export const WORKFLOW_CODE_INSTALL_FAILED_REASONS = ["disk_space", "tool_error"] as const;
/** One of {@link WORKFLOW_CODE_INSTALL_FAILED_REASONS}. */
export type WorkflowCodeInstallFailedReason = (typeof WORKFLOW_CODE_INSTALL_FAILED_REASONS)[number];
/** The install failure's details: the reason and the installer's own error. */
export interface WorkflowCodeInstallFailedDetails {
  reason: WorkflowCodeInstallFailedReason;
  detail: string;
}
/**
 * Wire schema for {@link WorkflowCodeInstallFailedDetails}.
 *
 * @consumedBy the handler that returns the `workflow.code_install_failed` error
 */
export const WorkflowCodeInstallFailedDetailsSchema: z.ZodType<WorkflowCodeInstallFailedDetails> = z
  .object({ reason: z.enum(WORKFLOW_CODE_INSTALL_FAILED_REASONS), detail: z.string().min(1) })
  .strict();

/**
 * A Code step over its memory budget; a deadline cut is `workflow.step_timed_out` instead.
 *
 * @consumedBy the handler that returns the `workflow.code_over_budget` error
 */
export const WORKFLOW_CODE_OVER_BUDGET_CODE = "workflow.code_over_budget" as const;
