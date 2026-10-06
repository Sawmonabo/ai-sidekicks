// The acts on a workflow run: starting one, canceling and resuming it, retrying from a
// step, running one node from the builder and posting a finished run's results into a
// session, with their refusals, the run events they write and their method table. A
// descriptor registers nothing.
import { z } from "zod";

import { defineMethodDescriptors, type MethodDescriptor } from "../../method-descriptor.js";
import { ProjectIdSchema, type ProjectId } from "../../project.js";
import { SessionIdSchema, type SessionId } from "../../session/session.js";
import {
  WorkflowDefinitionIdSchema,
  WorkflowItemSchema,
  WorkflowNodeIdSchema,
  WorkflowVersionIdSchema,
  type WorkflowDefinitionId,
  type WorkflowItem,
  type WorkflowNodeId,
} from "../definition/definition.js";
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
} from "./run.js";

// Several replies answer with only some statuses. Each subset is taken from the one
// status list rather than spelled again, so a renamed status cannot leave a subset behind.
const workflowRunStatusEnum = z.enum(WORKFLOW_RUN_STATUSES);

// workflow.runStart

/** The start modes a caller may ask for; `retry` and `sub-workflow` come from their own methods. */
type RequestableRunMode = Exclude<WorkflowRunMode, "retry" | "sub-workflow">;

/**
 * The `workflow.runStart` input: the version to run, taken verbatim from a definition
 * or version read, the session it is started in, the repository it works in, the items it starts
 * on where the workflow declares inputs, and how the start was made. A run started in a project
 * session works in that session's repository; one started in a chat works in the chat's own
 * folder, or in the named project's folder when one is named; one started in no session works in
 * the named project's folder, or with none named in its own. The schema cannot tell a chat from a
 * project session, so the daemon refuses a project named on a project session's run with
 * {@link WORKFLOW_PROJECT_ON_PROJECT_SESSION_CODE}.
 */
export interface WorkflowRunStartRequest {
  workflowVersionId: string;
  sessionId?: SessionId | undefined;
  projectId?: ProjectId | undefined;
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
    // Present on a start made in a session, naming it. When it is absent, the run lives in the
    // workflow's own session.
    sessionId: SessionIdSchema.optional(),
    // The project whose folder the run works in: the Run now panel's `Repository`, or the one a
    // chat's start names. Absent on a start in no session for `None`: the run gets no checkout and
    // works in its own empty folder, and a version holding a Git, Read a repo diff or Run tests
    // step is refused.
    projectId: ProjectIdSchema.optional(),
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
 * The `workflow.runCancel` result. Cancel is offered on a new, running or waiting run, and on a
 * failed run parked on its failed step waiting to be resumed; every branch still going is
 * canceled with it. `state` has one value because a successful cancel has
 * one outcome. `alreadyCanceled` is true when the run was already canceled and this call returned
 * the first cancel's saved result: no second event is written, and `canceledEventId` names the
 * original.
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

// workflow.runRerun

/**
 * The `workflow.runRerun` input: start a new run of the named run's own pinned version, with the
 * input and mode that run was started with, in the session it lives in. The daemon reads all
 * three from the source run, so the caller names only the run.
 */
export interface WorkflowRunRerunRequest {
  workflowRunId: WorkflowRunId;
}
/** Wire schema for {@link WorkflowRunRerunRequest}. */
export const WorkflowRunRerunRequestSchema: z.ZodType<
  WorkflowRunRerunRequest,
  WorkflowRunRerunRequest
> = z.object({ workflowRunId: WorkflowRunIdSchema }).strict();

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

/**
 * A start the policy check denied, or whose principal could not be resolved.
 *
 * @consumedBy the handler that returns the `workflow.start_denied` error
 */
export const WORKFLOW_START_DENIED_CODE = "workflow.start_denied" as const;

/**
 * A start in a project session that names a project: the run works in that session's repository,
 * so it names no other. Nothing runs.
 *
 * @consumedBy the start handler that refuses a project on a project session's run
 */
export const WORKFLOW_PROJECT_ON_PROJECT_SESSION_CODE =
  "workflow.project_on_project_session" as const;

/**
 * A cancel on a run that has ended: there is nothing left to cancel. A failed run waiting on Resume
 * has not ended and is canceled; a run already `canceled` is not refused, the cancel returns the
 * first's outcome.
 *
 * @consumedBy the handler that returns the `workflow.run_not_cancelable` error
 */
export const WORKFLOW_RUN_NOT_CANCELABLE_CODE = "workflow.run_not_cancelable" as const;

/**
 * A resume on a run that is not waiting: there is no wait to lift.
 *
 * @consumedBy the handler that returns the `workflow.resume_not_parked` error
 */
export const WORKFLOW_RESUME_NOT_PARKED_CODE = "workflow.resume_not_parked" as const;

/**
 * A version re-pin on a run that is not waiting; a going run is never re-pinned.
 *
 * @consumedBy the handler that returns the `workflow.repair_not_parked` error
 */
export const WORKFLOW_REPAIR_NOT_PARKED_CODE = "workflow.repair_not_parked" as const;

/**
 * A version re-pin while one of the run's steps is still in flight.
 *
 * @consumedBy the handler that returns the `workflow.repair_attempt_in_flight` error
 */
export const WORKFLOW_REPAIR_ATTEMPT_IN_FLIGHT_CODE = "workflow.repair_attempt_in_flight" as const;

/**
 * A version re-pin whose target cannot account for the steps the run already finished:
 * it drops a node whose output the run holds, or leaves a finished node unreachable.
 *
 * @consumedBy the handler that returns the `workflow.repair_version_unaccountable` error
 */
export const WORKFLOW_REPAIR_VERSION_UNACCOUNTABLE_CODE =
  "workflow.repair_version_unaccountable" as const;

/**
 * A run or step move its state does not allow: retrying from a step that did not fail,
 * posting the results of an unfinished run, or opening a fix session on a step that did
 * not fail.
 *
 * @consumedBy the handler that returns the `workflow.invalid_transition` error
 */
export const WORKFLOW_INVALID_TRANSITION_CODE = "workflow.invalid_transition" as const;

/**
 * A retry the daemon cannot make now; the reason says why.
 *
 * @consumedBy the handler that returns the `workflow.retry_unavailable` error
 */
export const WORKFLOW_RETRY_UNAVAILABLE_CODE = "workflow.retry_unavailable" as const;
/** Why a retry cannot be made: the source run is still going. */
export const WORKFLOW_RETRY_UNAVAILABLE_REASONS = ["source_running"] as const;
/** One of {@link WORKFLOW_RETRY_UNAVAILABLE_REASONS}. */
export type WorkflowRetryUnavailableReason = (typeof WORKFLOW_RETRY_UNAVAILABLE_REASONS)[number];
/** The retry refusal's details. */
export interface WorkflowRetryUnavailableDetails {
  reason: WorkflowRetryUnavailableReason;
}
/**
 * Wire schema for {@link WorkflowRetryUnavailableDetails}.
 *
 * @consumedBy the handler that returns the `workflow.retry_unavailable` error
 */
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
  readonly "workflow.runRerun": MethodDescriptor<
    "workflow.runRerun",
    WorkflowRunRerunRequest,
    WorkflowRunStartResponse
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

/**
 * The `workflow.*` methods that act on a run.
 */
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
    "workflow.runRerun": {
      method: "workflow.runRerun",
      procedureType: "mutation",
      mutating: true,
      requestSchema: WorkflowRunRerunRequestSchema,
      responseSchema: WorkflowRunStartResponseSchema,
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
