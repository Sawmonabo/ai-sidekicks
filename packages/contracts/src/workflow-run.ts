// Workflow runs: starting, canceling and resuming a run, reading a finished step's saved
// outputs, deciding an approval, submitting a form, verifying the approval record, and
// listing runs. Payload shapes only; nothing here registers a method or a handler.
import { z } from "zod";

import { ArtifactIdSchema, type ArtifactId } from "./provider-driver.js";
import { SessionIdSchema, type SessionId } from "./session.js";
import { WorkflowVersionIdSchema } from "./workflow-definition.js";

/** A workflow run's id. The daemon mints it; a client passes it through and never parses it. */
export type WorkflowRunId = string & { readonly __brand: "WorkflowRunId" };
/** Wire schema for {@link WorkflowRunId}. */
export const WorkflowRunIdSchema: z.ZodType<WorkflowRunId, WorkflowRunId> = z
  .string()
  .min(1)
  .brand<"WorkflowRunId">() as unknown as z.ZodType<WorkflowRunId, WorkflowRunId>;

const WORKFLOW_RUN_STATUSES = [
  "new",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "crashed",
] as const;

/**
 * A run's status, the one a surface shows for it. `waiting` covers a run parked on a
 * person or on a provider account. It is never swept to `crashed` when the daemon
 * starts and never pruned, so a parked run survives a restart.
 */
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

// Several replies answer with only some of these statuses. Each subset is taken from
// this one enum rather than spelled again, so a renamed status cannot leave a subset behind.
const workflowRunStatusEnum = z.enum(WORKFLOW_RUN_STATUSES);

const WORKFLOW_STEP_STATUSES = ["pending", "running", "succeeded", "failed", "skipped"] as const;

/** The status of one step, meaning one execution of one node. */
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

const workflowStepStatusEnum = z.enum(WORKFLOW_STEP_STATUSES);

/**
 * The `workflow.runStart` input: the version to run, taken verbatim from a definition
 * or version read.
 */
export interface WorkflowRunStartRequest {
  workflowVersionId: string;
  sessionId?: SessionId | undefined;
}
/** Wire schema for {@link WorkflowRunStartRequest}. */
export const WorkflowRunStartRequestSchema: z.ZodType<
  WorkflowRunStartRequest,
  WorkflowRunStartRequest
> = z
  .object({
    workflowVersionId: WorkflowVersionIdSchema,
    // Present only on a start made from a chat, naming that chat's session. When it is
    // absent, the run lives in the workflow's own session.
    sessionId: SessionIdSchema.optional(),
  })
  .strict();

/**
 * The `workflow.runStart` result. A start can only leave the run admitted but not yet
 * dispatched (`new`) or already `running`, so `state` allows only those two.
 */
export interface WorkflowRunStartResponse {
  workflowRunId: WorkflowRunId;
  state: Extract<WorkflowRunStatus, "new" | "running">;
}
/** Wire schema for {@link WorkflowRunStartResponse}. */
export const WorkflowRunStartResponseSchema: z.ZodType<WorkflowRunStartResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    state: workflowRunStatusEnum.extract(["new", "running"]),
  })
  .strict();

/**
 * The most bytes a cancellation reason may take, counted on its UTF-8 encoding rather
 * than its length, so the same sentence is not refused sooner in one script than in another.
 */
export const WORKFLOW_CANCEL_REASON_BYTE_CAP: number = 8 * 1024;

const utf8Encoder = new TextEncoder();

/**
 * The `workflow.runCancel` input. `reason` is recorded on the run and carried on its
 * canceled event. It never reaches a step's output or anything an agent reads.
 */
export interface WorkflowRunCancelRequest {
  workflowRunId: WorkflowRunId;
  reason?: string | undefined;
}
/** Wire schema for {@link WorkflowRunCancelRequest}. */
export const WorkflowRunCancelRequestSchema: z.ZodType<
  WorkflowRunCancelRequest,
  WorkflowRunCancelRequest
> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    reason: z
      .string()
      .min(1)
      .refine(
        (reason) => utf8Encoder.encode(reason).byteLength <= WORKFLOW_CANCEL_REASON_BYTE_CAP,
        {
          message: `reason must be at most ${WORKFLOW_CANCEL_REASON_BYTE_CAP} bytes of UTF-8.`,
        },
      )
      .optional(),
  })
  .strict();

/**
 * The `workflow.runCancel` result. `state` has one value because a successful cancel
 * has exactly one outcome; a run that already succeeded or failed is refused instead.
 * `alreadyCanceled` is true when the run was already canceled and this call replayed
 * the first: no second event is written, and `canceledEventId` names the original.
 */
export interface WorkflowRunCancelResponse {
  workflowRunId: WorkflowRunId;
  state: Extract<WorkflowRunStatus, "canceled">;
  canceledEventId: string;
  alreadyCanceled: boolean;
}
/** Wire schema for {@link WorkflowRunCancelResponse}. */
export const WorkflowRunCancelResponseSchema: z.ZodType<WorkflowRunCancelResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    state: workflowRunStatusEnum.extract(["canceled"]),
    canceledEventId: z.string().min(1),
    alreadyCanceled: z.boolean(),
  })
  .strict();

/**
 * The `workflow.runResume` input. An ordinary resume omits `versionRepin` and continues
 * on the run's pinned version. Only an explicit `versionRepin` moves the run, and it
 * names the target version instead of asking for the latest, so the recorded
 * from-and-to pair is the one the person saw.
 */
export interface WorkflowRunResumeRequest {
  workflowRunId: WorkflowRunId;
  versionRepin?: { targetWorkflowVersionId: string } | undefined;
}
/** Wire schema for {@link WorkflowRunResumeRequest}. */
export const WorkflowRunResumeRequestSchema: z.ZodType<
  WorkflowRunResumeRequest,
  WorkflowRunResumeRequest
> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    versionRepin: z
      .object({ targetWorkflowVersionId: WorkflowVersionIdSchema })
      .strict()
      .optional(),
  })
  .strict();

/**
 * The `workflow.runResume` result. `waiting` is a legal outcome, not a refusal: a resume
 * that reaches a provider account still out of quota parks again, and that new park is
 * what the person sees. The two repinned ids are present only on an accepted re-pin.
 */
export interface WorkflowRunResumeResponse {
  workflowRunId: WorkflowRunId;
  state: Extract<WorkflowRunStatus, "running" | "waiting">;
  repinnedFromWorkflowVersionId?: string | undefined;
  repinnedToWorkflowVersionId?: string | undefined;
}
/** Wire schema for {@link WorkflowRunResumeResponse}. */
export const WorkflowRunResumeResponseSchema: z.ZodType<WorkflowRunResumeResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    state: workflowRunStatusEnum.extract(["running", "waiting"]),
    repinnedFromWorkflowVersionId: WorkflowVersionIdSchema.optional(),
    repinnedToWorkflowVersionId: WorkflowVersionIdSchema.optional(),
  })
  .strict();

/** The `workflow.phaseOutputRead` input: the run whose finished step's outputs are read. */
export interface WorkflowPhaseOutputReadRequest {
  workflowRunId: WorkflowRunId;
}
/** Wire schema for {@link WorkflowPhaseOutputReadRequest}. */
export const WorkflowPhaseOutputReadRequestSchema: z.ZodType<
  WorkflowPhaseOutputReadRequest,
  WorkflowPhaseOutputReadRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema }).strict();

/**
 * One saved output of a finished step. An `artifact_ref` output points at a stored
 * artifact by id and never carries its bytes; an `inline` output carries no artifact.
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
 * The `workflow.phaseOutputRead` result. `state` is the step's status, not the run's;
 * both vocabularies have these two values, and only the step's is what this read reports.
 */
export interface WorkflowPhaseOutputReadResponse {
  state: Extract<WorkflowStepStatus, "succeeded" | "failed">;
  outputs: WorkflowStepOutput[];
}
/** Wire schema for {@link WorkflowPhaseOutputReadResponse}. */
export const WorkflowPhaseOutputReadResponseSchema: z.ZodType<WorkflowPhaseOutputReadResponse> = z
  .object({
    state: workflowStepStatusEnum.extract(["succeeded", "failed"]),
    outputs: z.array(WorkflowStepOutputSchema),
  })
  .strict();

/**
 * The `workflow.gateResolve` input: a person's decision on one of a run's approval
 * steps, with optional feedback.
 */
export interface WorkflowGateResolveRequest {
  workflowRunId: WorkflowRunId;
  decision: "approved" | "rejected";
  feedback?: string | undefined;
}
/** Wire schema for {@link WorkflowGateResolveRequest}. */
export const WorkflowGateResolveRequestSchema: z.ZodType<
  WorkflowGateResolveRequest,
  WorkflowGateResolveRequest
> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    decision: z.enum(["approved", "rejected"]),
    feedback: z.string().min(1).optional(),
  })
  .strict();

/**
 * The `workflow.gateResolve` result: the two halves of the decision's place in the run's
 * approval record. `rowHash` chains this entry to the one before it: BLAKE3 over the
 * previous hash and this entry's RFC 8785 canonical JSON. The same pair is written on
 * the matching session event in the same write, so the record can be verified later.
 */
export interface WorkflowGateResolveResponse {
  gateResolutionId: string;
  rowHash: string;
  decidedAt: string;
}
/** Wire schema for {@link WorkflowGateResolveResponse}. */
export const WorkflowGateResolveResponseSchema: z.ZodType<WorkflowGateResolveResponse> = z
  .object({
    gateResolutionId: z.string().min(1),
    rowHash: z.string().min(1),
    decidedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

/**
 * The `workflow.humanFormSubmit` input. `expectedRevision` is the form's revision when
 * it was opened. A submit carrying a stale revision is refused; it never overwrites an
 * answer that was already accepted.
 */
export interface WorkflowHumanFormSubmitRequest {
  workflowRunId: WorkflowRunId;
  fields: Record<string, unknown>;
  expectedRevision: number;
}
/** Wire schema for {@link WorkflowHumanFormSubmitRequest}. */
export const WorkflowHumanFormSubmitRequestSchema: z.ZodType<
  WorkflowHumanFormSubmitRequest,
  WorkflowHumanFormSubmitRequest
> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
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

/** The `workflow.gateChainVerify` input: the run whose approval record is checked. */
export interface WorkflowGateChainVerifyRequest {
  workflowRunId: WorkflowRunId;
}
/** Wire schema for {@link WorkflowGateChainVerifyRequest}. */
export const WorkflowGateChainVerifyRequestSchema: z.ZodType<
  WorkflowGateChainVerifyRequest,
  WorkflowGateChainVerifyRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema }).strict();

/**
 * The `workflow.gateChainVerify` result. It recomputes each entry's hash link in
 * sequence order and checks the matching session event. A failed check reports the
 * first divergence, not a bare fail: `firstDivergentSequence` and `divergence` are both
 * present exactly when `verified` is false.
 */
export interface WorkflowGateChainVerifyResponse {
  workflowRunId: WorkflowRunId;
  verified: boolean;
  rowsChecked: number;
  firstDivergentSequence?: number | undefined;
  divergence?:
    | "row_hash_mismatch"
    | "sequence_gap"
    | "missing_event_anchor"
    | "signature_invalid"
    | undefined;
}
/** Wire schema for {@link WorkflowGateChainVerifyResponse}. */
export const WorkflowGateChainVerifyResponseSchema: z.ZodType<WorkflowGateChainVerifyResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    verified: z.boolean(),
    rowsChecked: z.number().int().nonnegative(),
    firstDivergentSequence: z.number().int().nonnegative().optional(),
    divergence: z
      .enum(["row_hash_mismatch", "sequence_gap", "missing_event_anchor", "signature_invalid"])
      .optional(),
  })
  .strict();

/** The `workflow.runList` input. Without `sessionId` it lists every run this daemon ran. */
export interface WorkflowRunListRequest {
  sessionId?: SessionId | undefined;
}
/** Wire schema for {@link WorkflowRunListRequest}. */
export const WorkflowRunListRequestSchema: z.ZodType<
  WorkflowRunListRequest,
  WorkflowRunListRequest
> = z.object({ sessionId: SessionIdSchema.optional() }).strict();

/**
 * One row of the runs table. It names the definition the run came from, because a list
 * answers with runs nobody named, and an opaque id alone tells a reader nothing.
 */
export interface WorkflowRunSummary {
  definitionName: string;
}
/** Wire schema for {@link WorkflowRunSummary}. */
export const WorkflowRunSummarySchema: z.ZodType<WorkflowRunSummary> = z
  .object({ definitionName: z.string().min(1) })
  .strict();

/** The `workflow.runList` result. */
export interface WorkflowRunListResponse {
  runs: WorkflowRunSummary[];
}
/** Wire schema for {@link WorkflowRunListResponse}. */
export const WorkflowRunListResponseSchema: z.ZodType<WorkflowRunListResponse> = z
  .object({ runs: z.array(WorkflowRunSummarySchema) })
  .strict();
