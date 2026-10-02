// The acts on a workflow run: starting one, canceling and resuming it, retrying from a
// step, running one node from the builder and posting a finished run's results into a
// session, with their refusals, the run events they write and their method table. A
// descriptor registers nothing.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "./method-descriptor.js";
import { SessionIdSchema, type SessionId } from "./session.js";
import {
  WorkflowDefinitionIdSchema,
  WorkflowItemSchema,
  WorkflowNodeIdSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowItem,
  type WorkflowNodeId,
} from "./workflow-definition.js";
import {
  WORKFLOW_RUN_MODES,
  WORKFLOW_RUN_STATUSES,
  WorkflowCancelReasonSchema,
  WorkflowRunIdSchema,
  WorkflowRunModeSchema,
  WorkflowStartedBySchema,
  type WorkflowRunId,
  type WorkflowRunMode,
  type WorkflowRunStatus,
  type WorkflowStartedBy,
} from "./workflow-run.js";

// Several replies answer with only some statuses. Each subset is taken from the one
// status list rather than spelled again, so a renamed status cannot leave a subset behind.
const workflowRunStatusEnum = z.enum(WORKFLOW_RUN_STATUSES);

// workflow.runStart

/** The start modes a caller may ask for; `retry` and `sub-workflow` come from their own methods. */
type RequestableRunMode = Exclude<WorkflowRunMode, "retry" | "sub-workflow">;

/**
 * The `workflow.runStart` input: the version to run, taken verbatim from a definition
 * or version read, the items it starts on where the workflow declares inputs, and how
 * the start was made.
 */
export interface WorkflowRunStartRequest {
  workflowVersionId: string;
  sessionId?: SessionId | undefined;
  input?: WorkflowItem[] | undefined;
  mode?: RequestableRunMode | undefined;
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
    input: z.array(WorkflowItemSchema).optional(),
    mode: z.enum(WORKFLOW_RUN_MODES).exclude(["retry", "sub-workflow"]).optional(),
  })
  .strict();

/**
 * The `workflow.runStart` result. A start can only leave the run admitted but not yet
 * dispatched (`new`) or already `running`, so `state` allows only those two. `sessionId`
 * is the session the run lives in.
 */
export interface WorkflowRunStartResponse {
  workflowRunId: WorkflowRunId;
  sessionId: SessionId;
  state: Extract<WorkflowRunStatus, "new" | "running">;
}
/** Wire schema for {@link WorkflowRunStartResponse}. */
export const WorkflowRunStartResponseSchema: z.ZodType<WorkflowRunStartResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    sessionId: SessionIdSchema,
    state: workflowRunStatusEnum.extract(["new", "running"]),
  })
  .strict();

// workflow.runCancel

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
    reason: WorkflowCancelReasonSchema.optional(),
  })
  .strict();

/**
 * The `workflow.runCancel` result. Cancel is offered on a new, running or waiting run,
 * and every branch still going is canceled with it. `state` has one value because a
 * successful cancel has one outcome. `alreadyCanceled` is true when the run was
 * already canceled and this call replayed the first: no second event is written, and
 * `canceledEventId` names the original.
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

// workflow.runResume

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
 * that reaches a provider account still out of quota waits again, and that new wait is
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
  .strict()
  .refine(
    (reply) =>
      (reply.repinnedFromWorkflowVersionId === undefined) ===
      (reply.repinnedToWorkflowVersionId === undefined),
    { path: ["repinnedToWorkflowVersionId"], message: "A re-pin names both versions." },
  );

// workflow.runRetry

/**
 * The `workflow.runRetry` input: re-run from a named step, which runs again with its
 * descendants while the source run's data stays pinned upstream.
 */
export interface WorkflowRunRetryRequest {
  workflowRunId: WorkflowRunId;
  fromNodeId: WorkflowNodeId;
}
/** Wire schema for {@link WorkflowRunRetryRequest}. */
export const WorkflowRunRetryRequestSchema: z.ZodType<
  WorkflowRunRetryRequest,
  WorkflowRunRetryRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema, fromNodeId: WorkflowNodeIdSchema }).strict();

/** The `workflow.runRetry` result: a new run in `retry` mode; the source run stays readable. */
export interface WorkflowRunRetryResponse {
  workflowRunId: WorkflowRunId;
  sourceWorkflowRunId: WorkflowRunId;
  state: Extract<WorkflowRunStatus, "new" | "running">;
}
/** Wire schema for {@link WorkflowRunRetryResponse}; the new run is never its own source. */
export const WorkflowRunRetryResponseSchema: z.ZodType<WorkflowRunRetryResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    sourceWorkflowRunId: WorkflowRunIdSchema,
    state: workflowRunStatusEnum.extract(["new", "running"]),
  })
  .strict()
  .refine((reply) => reply.workflowRunId !== reply.sourceWorkflowRunId, {
    path: ["workflowRunId"],
    message: "A retry is a new run.",
  });

// workflow.nodeExecute

/**
 * The `workflow.nodeExecute` input: `Run this node` (`node`) or `Run from here`
 * (`fromHere`, the node and its ancestors) on a saved version, never unsaved bytes.
 * `dirtyNodeIds` is the builder's hint; the daemon decides what it runs and reuses.
 */
export interface WorkflowNodeExecuteRequest {
  workflowVersionId: string;
  sessionId?: SessionId | undefined;
  nodeId: WorkflowNodeId;
  scope: "node" | "fromHere";
  dirtyNodeIds?: WorkflowNodeId[] | undefined;
}
/** Wire schema for {@link WorkflowNodeExecuteRequest}. */
export const WorkflowNodeExecuteRequestSchema: z.ZodType<
  WorkflowNodeExecuteRequest,
  WorkflowNodeExecuteRequest
> = z
  .object({
    workflowVersionId: WorkflowVersionIdSchema,
    sessionId: SessionIdSchema.optional(),
    nodeId: WorkflowNodeIdSchema,
    scope: z.enum(["node", "fromHere"]),
    dirtyNodeIds: z.array(WorkflowNodeIdSchema).optional(),
  })
  .strict();

/** The `workflow.nodeExecute` result: the nodes the daemon ran, in order, and those it reused. */
export interface WorkflowNodeExecuteResponse {
  workflowRunId: WorkflowRunId;
  executedNodeIds: WorkflowNodeId[];
  reusedNodeIds: WorkflowNodeId[];
}
/** Wire schema for {@link WorkflowNodeExecuteResponse}. */
export const WorkflowNodeExecuteResponseSchema: z.ZodType<WorkflowNodeExecuteResponse> = z
  .object({
    workflowRunId: WorkflowRunIdSchema,
    executedNodeIds: z.array(WorkflowNodeIdSchema),
    reusedNodeIds: z.array(WorkflowNodeIdSchema),
  })
  .strict();

// workflow.resultsPost

/**
 * The `workflow.resultsPost` input: pull a finished run's results into the session the
 * `/workflow results` verb was typed in, which the daemon checks is the caller's own.
 * The agent tool takes no session; the daemon derives it from the invoking turn.
 */
export interface WorkflowResultsPostRequest {
  workflowRunId: WorkflowRunId;
  sessionId: SessionId;
}
/** Wire schema for {@link WorkflowResultsPostRequest}. */
export const WorkflowResultsPostRequestSchema: z.ZodType<
  WorkflowResultsPostRequest,
  WorkflowResultsPostRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema, sessionId: SessionIdSchema }).strict();

/** The `workflow.resultsPost` result. */
export interface WorkflowResultsPostResponse {
  workflowRunId: WorkflowRunId;
  posted: true;
}
/** Wire schema for {@link WorkflowResultsPostResponse}. */
export const WorkflowResultsPostResponseSchema: z.ZodType<WorkflowResultsPostResponse> = z
  .object({ workflowRunId: WorkflowRunIdSchema, posted: z.literal(true) })
  .strict();

// Refusals

/** A start the policy check denied, or whose principal could not be resolved. */
export type WorkflowStartDeniedCode = "workflow.start_denied";
/** The code of a denied or unresolvable start. */
export const WORKFLOW_START_DENIED_CODE: WorkflowStartDeniedCode = "workflow.start_denied";

/** A cancel or a resume the policy check did not admit for its caller. */
export type WorkflowControlDeniedCode = "workflow.control_denied";
/** The code of a cancel or resume refused by authorization. */
export const WORKFLOW_CONTROL_DENIED_CODE: WorkflowControlDeniedCode = "workflow.control_denied";

/**
 * A cancel on a run that has ended: there is nothing left to cancel. A failed run waiting on
 * Resume has not ended and is canceled; a run already `canceled` is not refused, the cancel replays.
 */
export type WorkflowRunNotCancelableCode = "workflow.run_not_cancelable";
/** The code of a cancel on a run that already ended. */
export const WORKFLOW_RUN_NOT_CANCELABLE_CODE: WorkflowRunNotCancelableCode =
  "workflow.run_not_cancelable";

/** A resume on a run that is not waiting: there is no wait to lift. */
export type WorkflowResumeNotParkedCode = "workflow.resume_not_parked";
/** The code of a resume on a run that is not waiting. */
export const WORKFLOW_RESUME_NOT_PARKED_CODE: WorkflowResumeNotParkedCode =
  "workflow.resume_not_parked";

/** A version re-pin on a run that is not waiting; a going run is never re-pinned. */
export type WorkflowRepairNotParkedCode = "workflow.repair_not_parked";
/** The code of a re-pin on a run that is not waiting. */
export const WORKFLOW_REPAIR_NOT_PARKED_CODE: WorkflowRepairNotParkedCode =
  "workflow.repair_not_parked";

/** A version re-pin while one of the run's steps is still in flight. */
export type WorkflowRepairAttemptInFlightCode = "workflow.repair_attempt_in_flight";
/** The code of a re-pin while a step is in flight. */
export const WORKFLOW_REPAIR_ATTEMPT_IN_FLIGHT_CODE: WorkflowRepairAttemptInFlightCode =
  "workflow.repair_attempt_in_flight";

/**
 * A version re-pin whose target cannot account for the steps the run already finished:
 * it drops a node whose output the run holds, or leaves a finished node unreachable.
 */
export type WorkflowRepairVersionUnaccountableCode = "workflow.repair_version_unaccountable";
/** The code of a re-pin whose target cannot account for the finished steps. */
export const WORKFLOW_REPAIR_VERSION_UNACCOUNTABLE_CODE: WorkflowRepairVersionUnaccountableCode =
  "workflow.repair_version_unaccountable";

/**
 * A run or step move its state does not allow: retrying from a step that did not fail,
 * posting the results of an unfinished run, or opening a fix session on a step that did
 * not fail.
 */
export type WorkflowInvalidTransitionCode = "workflow.invalid_transition";
/** The code of a run or step move its state does not allow. */
export const WORKFLOW_INVALID_TRANSITION_CODE: WorkflowInvalidTransitionCode =
  "workflow.invalid_transition";

/** A retry the daemon cannot make now; the reason says why. */
export type WorkflowRetryUnavailableCode = "workflow.retry_unavailable";
/** The code of a retry the daemon cannot make now. */
export const WORKFLOW_RETRY_UNAVAILABLE_CODE: WorkflowRetryUnavailableCode =
  "workflow.retry_unavailable";
/**
 * Why a retry cannot be made: the source run's step data is past its time bound, or
 * the source run is still going.
 */
export const WORKFLOW_RETRY_UNAVAILABLE_REASONS = ["step_data_expired", "source_running"] as const;
/** One of {@link WORKFLOW_RETRY_UNAVAILABLE_REASONS}. */
export type WorkflowRetryUnavailableReason = (typeof WORKFLOW_RETRY_UNAVAILABLE_REASONS)[number];
/** The retry refusal's details. */
export interface WorkflowRetryUnavailableDetails {
  reason: WorkflowRetryUnavailableReason;
}
/** Wire schema for {@link WorkflowRetryUnavailableDetails}. */
export const WorkflowRetryUnavailableDetailsSchema: z.ZodType<WorkflowRetryUnavailableDetails> = z
  .object({ reason: z.enum(WORKFLOW_RETRY_UNAVAILABLE_REASONS) })
  .strict();

// Run events

/** The run a run event names: its session, its id, and the definition and version it pins. */
export interface WorkflowRunEventPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
  definitionId: WorkflowDefinitionId;
  workflowVersionId: string;
}
const workflowRunEventFields = {
  sessionId: SessionIdSchema,
  workflowRunId: WorkflowRunIdSchema,
  definitionId: WorkflowDefinitionIdSchema,
  workflowVersionId: WorkflowVersionIdSchema,
};

/** `workflow.started`: how the run was started and by whom, so the run row rebuilds from events. */
export interface WorkflowStartedPayload extends WorkflowRunEventPayload {
  mode: WorkflowRunMode;
  startedBy: WorkflowStartedBy;
}
/** Wire schema for {@link WorkflowStartedPayload}. */
export const WorkflowStartedPayloadSchema: z.ZodType<WorkflowStartedPayload> = z
  .object({
    ...workflowRunEventFields,
    mode: WorkflowRunModeSchema,
    startedBy: WorkflowStartedBySchema,
  })
  .strict();

/**
 * `workflow.canceled`, written with the status in one step, so rebuilding the run from
 * the log cannot bring a canceled run back. `reason` is the person's, when one was
 * given; a chain's `Stop them all` cancels with none.
 */
export interface WorkflowCanceledPayload extends WorkflowRunEventPayload {
  reason?: string | undefined;
}
/** Wire schema for {@link WorkflowCanceledPayload}. */
export const WorkflowCanceledPayloadSchema: z.ZodType<WorkflowCanceledPayload> = z
  .object({
    ...workflowRunEventFields,
    reason: WorkflowCancelReasonSchema.optional(),
  })
  .strict();

/** `workflow.resumed`, with the version pair only on an accepted re-pin. */
export interface WorkflowResumedPayload extends WorkflowRunEventPayload {
  repinnedFromWorkflowVersionId?: string | undefined;
  repinnedToWorkflowVersionId?: string | undefined;
}
/** Wire schema for {@link WorkflowResumedPayload}; a re-pin names both versions. */
export const WorkflowResumedPayloadSchema: z.ZodType<WorkflowResumedPayload> = z
  .object({
    ...workflowRunEventFields,
    repinnedFromWorkflowVersionId: WorkflowVersionIdSchema.optional(),
    repinnedToWorkflowVersionId: WorkflowVersionIdSchema.optional(),
  })
  .strict()
  .refine(
    (payload) =>
      (payload.repinnedFromWorkflowVersionId === undefined) ===
      (payload.repinnedToWorkflowVersionId === undefined),
    { path: ["repinnedToWorkflowVersionId"], message: "A re-pin names both versions." },
  );

/**
 * `workflow.results_posted`: a finished run's results landed as the results row in
 * `sessionId`, the session that asked. It follows the run's final status.
 */
export interface WorkflowResultsPostedPayload {
  sessionId: SessionId;
  workflowRunId: WorkflowRunId;
}
/** Wire schema for {@link WorkflowResultsPostedPayload}. */
export const WorkflowResultsPostedPayloadSchema: z.ZodType<WorkflowResultsPostedPayload> = z
  .object({ sessionId: SessionIdSchema, workflowRunId: WorkflowRunIdSchema })
  .strict();

// The workflow run control method table

/** The `workflow.*` methods that act on a run, keyed by name. */
export interface WorkflowRunControlMethodDescriptors {
  readonly "workflow.runStart": MethodDescriptor<
    "workflow.runStart",
    WorkflowRunStartRequest,
    WorkflowRunStartResponse
  >;
  readonly "workflow.runCancel": MethodDescriptor<
    "workflow.runCancel",
    WorkflowRunCancelRequest,
    WorkflowRunCancelResponse
  >;
  readonly "workflow.runResume": MethodDescriptor<
    "workflow.runResume",
    WorkflowRunResumeRequest,
    WorkflowRunResumeResponse
  >;
  readonly "workflow.runRetry": MethodDescriptor<
    "workflow.runRetry",
    WorkflowRunRetryRequest,
    WorkflowRunRetryResponse
  >;
  readonly "workflow.nodeExecute": MethodDescriptor<
    "workflow.nodeExecute",
    WorkflowNodeExecuteRequest,
    WorkflowNodeExecuteResponse
  >;
  readonly "workflow.resultsPost": MethodDescriptor<
    "workflow.resultsPost",
    WorkflowResultsPostRequest,
    WorkflowResultsPostResponse
  >;
}

/** The `workflow.*` methods that act on a run. */
export const WORKFLOW_RUN_CONTROL_METHOD_DESCRIPTORS: WorkflowRunControlMethodDescriptors =
  defineMethodDescriptors({
    "workflow.runStart": {
      method: "workflow.runStart",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunStartRequestSchema,
      responseSchema: WorkflowRunStartResponseSchema,
    },
    "workflow.runCancel": {
      method: "workflow.runCancel",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunCancelRequestSchema,
      responseSchema: WorkflowRunCancelResponseSchema,
    },
    "workflow.runResume": {
      method: "workflow.runResume",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunResumeRequestSchema,
      responseSchema: WorkflowRunResumeResponseSchema,
    },
    "workflow.runRetry": {
      method: "workflow.runRetry",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunRetryRequestSchema,
      responseSchema: WorkflowRunRetryResponseSchema,
    },
    "workflow.nodeExecute": {
      method: "workflow.nodeExecute",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowNodeExecuteRequestSchema,
      responseSchema: WorkflowNodeExecuteResponseSchema,
    },
    "workflow.resultsPost": {
      method: "workflow.resultsPost",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowResultsPostRequestSchema,
      responseSchema: WorkflowResultsPostResponseSchema,
    },
  });
